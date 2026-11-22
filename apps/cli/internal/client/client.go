// Package client talks JSON-RPC 2.0 to the Agent Gateway over a named pipe / Unix socket,
// falling back to loopback HTTP (docs/SPEC.md §8.1–8.2).
package client

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/NaizaNasution/agentic-browser/apps/cli/internal/protocol"
)

// RPCError is an error returned by the Gateway.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		Name string `json:"name"`
		Hint string `json:"hint,omitempty"`
	} `json:"data"`
}

func (e *RPCError) Error() string { return fmt.Sprintf("%s: %s", e.Name(), e.Message) }

// Name is the stable error name, e.g. E_UNAUTHORIZED.
func (e *RPCError) Name() string {
	if e.Data.Name != "" {
		return e.Data.Name
	}
	if n, ok := protocol.ErrorNames[e.Code]; ok {
		return n
	}
	return "E_UNKNOWN"
}

// UnreachableError means neither transport could reach the Gateway.
type UnreachableError struct{ Reasons []string }

func (e *UnreachableError) Error() string {
	return "cannot reach the Agentic Browser gateway (" + strings.Join(e.Reasons, "; ") + ")"
}

type request struct {
	JSONRPC string                 `json:"jsonrpc"`
	ID      int64                  `json:"id"`
	Method  string                 `json:"method"`
	Params  any                    `json:"params,omitempty"`
	Ctx     *protocol.AgentContext `json:"ctx,omitempty"`
}

type response struct {
	ID     any             `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *RPCError       `json:"error"`
}

// Client is a connected Gateway client.
type Client struct {
	Transport string // "pipe" or "http"
	Hello     protocol.HelloResult
	Ctx       *protocol.AgentContext

	conn   net.Conn
	reader *bufio.Reader
	http   *http.Client
	base   string
	token  string
	seq    atomic.Int64
}

// Connect dials the Gateway described by d (pipe first, then HTTP) and performs gateway.hello.
func Connect(ctx context.Context, d *protocol.Discovery, clientVersion string) (*Client, error) {
	var reasons []string
	hello := protocol.HelloParams{Token: d.Token, Client: "agb-cli", ClientVersion: clientVersion, Protocol: protocol.ProtocolVersion}

	if d.Pipe != "" {
		conn, err := dialPipe(ctx, d.Pipe)
		if err == nil {
			c := &Client{Transport: "pipe", conn: conn, reader: bufio.NewReader(conn), token: d.Token}
			if err = c.Call(ctx, protocol.MethodGatewayHello, hello, &c.Hello); err == nil {
				return c, nil
			}
			conn.Close()
			var rpcErr *RPCError
			if errors.As(err, &rpcErr) {
				return nil, err // the gateway answered; falling back would not help
			}
		}
		reasons = append(reasons, "pipe: "+err.Error())
	}

	if d.HTTP != "" {
		c := &Client{Transport: "http", http: &http.Client{}, base: strings.TrimRight(d.HTTP, "/"), token: d.Token}
		err := c.Call(ctx, protocol.MethodGatewayHello, hello, &c.Hello)
		if err == nil {
			return c, nil
		}
		var rpcErr *RPCError
		if errors.As(err, &rpcErr) {
			return nil, err
		}
		reasons = append(reasons, "http: "+err.Error())
	}
	return nil, &UnreachableError{Reasons: reasons}
}

// Call sends one request and decodes the result into out (which may be nil).
func (c *Client) Call(ctx context.Context, method string, params any, out any) error {
	req := request{JSONRPC: "2.0", ID: c.seq.Add(1), Method: method, Params: params, Ctx: c.Ctx}
	body, err := json.Marshal(req)
	if err != nil {
		return err
	}
	var raw []byte
	if c.conn != nil {
		raw, err = c.roundTripPipe(ctx, body)
	} else {
		raw, err = c.roundTripHTTP(ctx, body)
	}
	if err != nil {
		return err
	}
	var res response
	if err := json.Unmarshal(raw, &res); err != nil {
		return fmt.Errorf("bad response from gateway: %w", err)
	}
	if res.Error != nil {
		return res.Error
	}
	if out != nil && len(res.Result) > 0 {
		return json.Unmarshal(res.Result, out)
	}
	return nil
}

func (c *Client) roundTripPipe(ctx context.Context, body []byte) ([]byte, error) {
	if dl, ok := ctx.Deadline(); ok {
		_ = c.conn.SetDeadline(dl)
	} else {
		_ = c.conn.SetDeadline(time.Time{})
	}
	if _, err := c.conn.Write(append(body, '\n')); err != nil {
		return nil, err
	}
	line, err := c.reader.ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	return line, nil
}

func (c *Client) roundTripHTTP(ctx context.Context, body []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/rpc", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusUnauthorized {
		return nil, fmt.Errorf("gateway HTTP %d", resp.StatusCode)
	}
	return raw, nil
}

// Close releases the connection.
func (c *Client) Close() error {
	if c.conn != nil {
		return c.conn.Close()
	}
	return nil
}
