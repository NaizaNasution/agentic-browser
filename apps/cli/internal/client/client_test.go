package client

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/NaizaNasution/agentic-browser/apps/cli/internal/protocol"
)

const testToken = "tok-123"

// fakeGateway answers gateway.hello / gateway.status like the real one (apps/browser/src/gateway/rpc.ts).
func fakeGateway(req map[string]any, authed *bool) map[string]any {
	id := req["id"]
	errResp := func(code int, name string) map[string]any {
		return map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": name, "data": map[string]any{"name": name}}}
	}
	switch req["method"] {
	case "gateway.hello":
		p, _ := req["params"].(map[string]any)
		if p["token"] != testToken {
			return errResp(protocol.EUnauthorized, "E_UNAUTHORIZED")
		}
		if p["protocol"] != protocol.ProtocolVersion {
			return errResp(protocol.EVersion, "E_VERSION")
		}
		*authed = true
		return map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{"appVersion": "9.9.9", "protocol": "1.0", "serverTime": "now"}}
	case "gateway.status":
		if !*authed {
			return errResp(protocol.EUnauthorized, "E_UNAUTHORIZED")
		}
		return map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{
			"appVersion": "9.9.9", "protocol": "1.0", "pid": 42, "uptimeMs": 1000, "windows": 1, "tabs": 2, "transports": []string{"pipe", "http"},
		}}
	}
	return errResp(protocol.EMethodNotFound, "E_METHOD_NOT_FOUND")
}

func newHTTPGateway(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authed := r.Header.Get("Authorization") == "Bearer "+testToken
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		_ = json.NewEncoder(w).Encode(fakeGateway(req, &authed))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// serveLines runs the newline-delimited protocol on an accepted connection.
func serveLines(conn net.Conn) {
	defer conn.Close()
	authed := false
	r := bufio.NewReader(conn)
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			return
		}
		var req map[string]any
		_ = json.Unmarshal(line, &req)
		out, _ := json.Marshal(fakeGateway(req, &authed))
		_, _ = conn.Write(append(out, '\n'))
	}
}

func ctx(t *testing.T) context.Context {
	c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return c
}

func TestHTTPHelloAndStatus(t *testing.T) {
	srv := newHTTPGateway(t)
	c, err := Connect(ctx(t), &protocol.Discovery{HTTP: srv.URL, Token: testToken}, "test")
	if err != nil {
		t.Fatal(err)
	}
	if c.Transport != "http" || c.Hello.AppVersion != "9.9.9" {
		t.Fatalf("unexpected hello: %+v via %s", c.Hello, c.Transport)
	}
	var st protocol.StatusResult
	if err := c.Call(ctx(t), protocol.MethodGatewayStatus, protocol.StatusParams{}, &st); err != nil {
		t.Fatal(err)
	}
	if st.Tabs != 2 || st.PID != 42 {
		t.Fatalf("unexpected status: %+v", st)
	}
}

func TestWrongTokenIsAnRPCError(t *testing.T) {
	srv := newHTTPGateway(t)
	_, err := Connect(ctx(t), &protocol.Discovery{HTTP: srv.URL, Token: "nope"}, "test")
	var rpcErr *RPCError
	if !errors.As(err, &rpcErr) || rpcErr.Name() != "E_UNAUTHORIZED" {
		t.Fatalf("want E_UNAUTHORIZED, got %v", err)
	}
}

func TestFallsBackToHTTPWhenPipeIsMissing(t *testing.T) {
	srv := newHTTPGateway(t)
	d := &protocol.Discovery{Pipe: missingPipePath(t), HTTP: srv.URL, Token: testToken}
	c, err := Connect(ctx(t), d, "test")
	if err != nil {
		t.Fatal(err)
	}
	if c.Transport != "http" {
		t.Fatalf("want http fallback, got %s", c.Transport)
	}
}

func TestUnreachable(t *testing.T) {
	d := &protocol.Discovery{Pipe: missingPipePath(t), HTTP: "http://127.0.0.1:1", Token: testToken}
	_, err := Connect(ctx(t), d, "test")
	var u *UnreachableError
	if !errors.As(err, &u) || len(u.Reasons) != 2 {
		t.Fatalf("want UnreachableError with 2 reasons, got %v", err)
	}
}

func TestPipeHelloAndStatus(t *testing.T) {
	path, ln := listenTestPipe(t)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go serveLines(conn)
		}
	}()
	c, err := Connect(ctx(t), &protocol.Discovery{Pipe: path, Token: testToken}, "test")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if c.Transport != "pipe" {
		t.Fatalf("want pipe, got %s", c.Transport)
	}
	var st protocol.StatusResult
	if err := c.Call(ctx(t), protocol.MethodGatewayStatus, nil, &st); err != nil {
		t.Fatal(err)
	}
	if st.Windows != 1 {
		t.Fatalf("unexpected status: %+v", st)
	}
}
