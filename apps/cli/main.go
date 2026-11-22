// agb is the command-line tool AI agents use to drive Agentic Browser (docs/SPEC.md §9).
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/NaizaNasution/agentic-browser/apps/cli/internal/client"
	"github.com/NaizaNasution/agentic-browser/apps/cli/internal/discovery"
	"github.com/NaizaNasution/agentic-browser/apps/cli/internal/format"
	"github.com/NaizaNasution/agentic-browser/apps/cli/internal/protocol"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "0.0.0-dev"

// Exit codes (SPEC §9.4).
const (
	exitOK        = 0
	exitError     = 1
	exitUsage     = 2
	exitNoGateway = 3
	exitDenied    = 4
	exitTimeout   = 7
	exitVersion   = 10
)

type globals struct {
	json    bool
	quiet   bool
	timeout time.Duration
	agent   string
}

type command struct {
	name    string
	summary string
	run     func(g globals, args []string, stdout, stderr io.Writer) int
}

var commands []command

func init() {
	commands = []command{
		{"version", "Show CLI, app, and protocol versions", cmdVersion},
		{"status", "Show whether the browser's gateway is reachable, and its state", cmdStatus},
		{"help", "Show this help", func(globals, []string, io.Writer, io.Writer) int { usage(os.Stdout); return exitOK }},
	}
}

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }

func run(argv []string, stdout, stderr io.Writer) int {
	g := globals{timeout: 30 * time.Second, agent: os.Getenv("AGB_AGENT")}
	if os.Getenv("AGB_JSON") == "1" {
		g.json = true
	}
	if t := os.Getenv("AGB_TIMEOUT"); t != "" {
		if d, err := time.ParseDuration(t); err == nil {
			g.timeout = d
		}
	}

	var rest []string
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		name, val, hasVal := strings.Cut(a, "=")
		needVal := func() (string, bool) {
			if hasVal {
				return val, true
			}
			if i+1 < len(argv) {
				i++
				return argv[i], true
			}
			format.Error(stderr, "E_USAGE", name+" needs a value", "")
			return "", false
		}
		switch name {
		case "--json":
			g.json = true
		case "--quiet", "-q":
			g.quiet = true
		case "--help", "-h":
			usage(stdout)
			return exitOK
		case "--timeout":
			v, ok := needVal()
			if !ok {
				return exitUsage
			}
			d, err := time.ParseDuration(v)
			if err != nil {
				format.Error(stderr, "E_USAGE", "bad --timeout "+v, "use a duration like 30s or 2m")
				return exitUsage
			}
			g.timeout = d
		case "--agent":
			v, ok := needVal()
			if !ok {
				return exitUsage
			}
			g.agent = v
		default:
			rest = append(rest, a)
		}
	}

	if len(rest) == 0 {
		usage(stdout)
		return exitUsage
	}
	for _, c := range commands {
		if c.name == rest[0] {
			return c.run(g, rest[1:], stdout, stderr)
		}
	}
	format.Error(stderr, "E_USAGE", "unknown command "+rest[0], "run `agb help` to list commands")
	return exitUsage
}

func usage(w io.Writer) {
	fmt.Fprintf(w, "agb %s: control Agentic Browser from an AI agent\n\nUsage: agb [--json] [--timeout 30s] [--agent <id>] <command> [args]\n\nCommands:\n", version)
	for _, c := range commands {
		fmt.Fprintf(w, "  %-9s %s\n", c.name, c.summary)
	}
}

// connect finds and dials the Gateway. On failure it prints an error and returns the exit code to use.
func connect(ctx context.Context, g globals, stderr io.Writer) (*client.Client, int) {
	d, err := discovery.Read()
	if err != nil {
		if errors.Is(err, discovery.ErrNotRunning) {
			if !g.json {
				format.Error(stderr, "E_NO_GATEWAY", err.Error(), "start Agentic Browser, then try again")
			}
			return nil, exitNoGateway
		}
		format.Error(stderr, "E_NO_GATEWAY", err.Error(), "restart Agentic Browser to rewrite it")
		return nil, exitNoGateway
	}
	c, err := client.Connect(ctx, d, version)
	if err != nil {
		return nil, reportErr(err, g, stderr)
	}
	if g.agent != "" {
		c.Ctx = &protocol.AgentContext{Agent: g.agent}
	}
	return c, exitOK
}

func reportErr(err error, g globals, stderr io.Writer) int {
	var rpcErr *client.RPCError
	var unreachable *client.UnreachableError
	switch {
	case errors.As(err, &rpcErr):
		if !g.json {
			format.Error(stderr, rpcErr.Name(), rpcErr.Message, rpcErr.Data.Hint)
		}
		switch rpcErr.Name() {
		case "E_VERSION":
			return exitVersion
		case "E_DENIED":
			return exitDenied
		case "E_TIMEOUT":
			return exitTimeout
		}
		return exitError
	case errors.As(err, &unreachable):
		if !g.json {
			format.Error(stderr, "E_NO_GATEWAY", unreachable.Error(), "the browser may have crashed; start Agentic Browser again")
		}
		return exitNoGateway
	case errors.Is(err, context.DeadlineExceeded):
		if !g.json {
			format.Error(stderr, "E_TIMEOUT", "the gateway did not answer in time", "check that Agentic Browser is responsive, or raise --timeout")
		}
		return exitTimeout
	default:
		if !g.json {
			format.Error(stderr, "E_INTERNAL", err.Error(), "")
		}
		return exitError
	}
}

func cmdVersion(g globals, _ []string, stdout, stderr io.Writer) int {
	cli := map[string]string{"version": version, "protocol": protocol.ProtocolVersion, "platform": runtime.GOOS + "/" + runtime.GOARCH}

	ctx, cancel := context.WithTimeout(context.Background(), min(g.timeout, 3*time.Second))
	defer cancel()
	c, code := connect(ctx, g, io.Discard) // version must work even when the app is down
	if code != exitOK {
		if g.json {
			format.JSON(stdout, map[string]any{"cli": cli, "app": nil})
		} else {
			fmt.Fprintf(stdout, "agb %s (protocol %s, %s)\n", version, protocol.ProtocolVersion, cli["platform"])
			fmt.Fprintln(stdout, "app: not running")
			fmt.Fprintln(stdout, "hint: start Agentic Browser, then run `agb version` again")
		}
		return code
	}
	defer c.Close()

	var st protocol.StatusResult
	if err := c.Call(ctx, protocol.MethodGatewayStatus, protocol.StatusParams{}, &st); err != nil {
		return reportErr(err, g, stderr)
	}
	if g.json {
		format.JSON(stdout, map[string]any{"cli": cli, "app": st, "transport": c.Transport})
		return exitOK
	}
	fmt.Fprintf(stdout, "agb %s (protocol %s, %s)\n", version, protocol.ProtocolVersion, cli["platform"])
	fmt.Fprintf(stdout, "app Agentic Browser %s (protocol %s, Electron %s, Chrome %s) via %s\n",
		st.AppVersion, st.Protocol, st.ElectronVersion, st.ChromeVersion, c.Transport)
	return exitOK
}

func cmdStatus(g globals, _ []string, stdout, stderr io.Writer) int {
	ctx, cancel := context.WithTimeout(context.Background(), g.timeout)
	defer cancel()
	c, code := connect(ctx, g, stderr)
	if code != exitOK {
		if g.json {
			format.JSON(stdout, map[string]any{"ok": false, "running": false})
		}
		return code
	}
	defer c.Close()

	var st protocol.StatusResult
	if err := c.Call(ctx, protocol.MethodGatewayStatus, protocol.StatusParams{}, &st); err != nil {
		return reportErr(err, g, stderr)
	}
	if g.json {
		format.JSON(stdout, map[string]any{"ok": true, "running": true, "transport": c.Transport, "status": st})
		return exitOK
	}
	if !g.quiet {
		fmt.Fprintln(stdout, format.Header(
			format.Field{Key: "gateway", Value: c.Transport},
			format.Field{Key: "pid", Value: fmt.Sprint(st.PID)},
			format.Field{Key: "app", Value: st.AppVersion},
			format.Field{Key: "protocol", Value: st.Protocol},
		))
	}
	fmt.Fprintf(stdout, "running: yes (up %s)\n", time.Duration(st.UptimeMs*int64(time.Millisecond)).Round(time.Second))
	fmt.Fprintf(stdout, "windows: %d  tabs: %d\n", st.Windows, st.Tabs)
	fmt.Fprintf(stdout, "transports: %s\n", strings.Join(st.Transports, ", "))
	return exitOK
}
