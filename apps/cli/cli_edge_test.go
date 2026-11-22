package main

// CLI edge cases from docs/testing/M0-test-cases.md (J-06, J-11, J-12, K-05, K-06, K-07).

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const stubToken = "stub-token"

// stubGateway is a minimal HTTP-only gateway. hangHello / hangStatus make it never answer.
type stubGateway struct {
	hangHello, hangStatus bool
	mu                    sync.Mutex
	statusCtx             map[string]any
}

func (s *stubGateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req map[string]any
	_ = json.NewDecoder(r.Body).Decode(&req)
	reply := func(result any) {
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req["id"], "result": result})
	}
	switch req["method"] {
	case "gateway.hello":
		if s.hangHello {
			<-r.Context().Done()
			return
		}
		reply(map[string]any{"appVersion": "7.7.7", "protocol": "1.0", "serverTime": "now"})
	case "gateway.status":
		if s.hangStatus {
			<-r.Context().Done()
			return
		}
		s.mu.Lock()
		s.statusCtx, _ = req["ctx"].(map[string]any)
		s.mu.Unlock()
		reply(map[string]any{
			"appVersion": "7.7.7", "electronVersion": "45", "chromeVersion": "156", "protocol": "1.0",
			"pid": 7, "uptimeMs": 61000, "windows": 1, "tabs": 4, "transports": []string{"http"},
		})
	}
}

// withGateway starts the stub and points AGB_HOME at a discovery file for it.
func withGateway(t *testing.T, s *stubGateway) {
	t.Helper()
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	home := t.TempDir()
	t.Setenv("AGB_HOME", home)
	writeDiscovery(t, home, map[string]any{"version": "7.7.7", "protocol": "1.0", "http": srv.URL, "token": stubToken, "pid": 7, "startedAt": "now"})
}

func writeDiscovery(t *testing.T, home string, d any) {
	t.Helper()
	var b []byte
	if s, ok := d.(string); ok {
		b = []byte(s)
	} else {
		b, _ = json.Marshal(d)
	}
	if err := os.WriteFile(filepath.Join(home, "gateway.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func runCLI(args ...string) (code int, stdout, stderr string) {
	var out, errOut bytes.Buffer
	code = run(args, &out, &errOut)
	return code, out.String(), errOut.String()
}

func TestJ06VersionJSON(t *testing.T) {
	t.Run("not running", func(t *testing.T) {
		t.Setenv("AGB_HOME", t.TempDir())
		code, out, _ := runCLI("--json", "version")
		if code != exitNoGateway {
			t.Fatalf("exit %d", code)
		}
		var v map[string]any
		if err := json.Unmarshal([]byte(out), &v); err != nil {
			t.Fatalf("not JSON: %q", out)
		}
		if v["app"] != nil || v["cli"].(map[string]any)["version"] != version {
			t.Fatalf("unexpected: %v", v)
		}
	})
	t.Run("running", func(t *testing.T) {
		withGateway(t, &stubGateway{})
		code, out, _ := runCLI("--json", "version")
		if code != exitOK {
			t.Fatalf("exit %d", code)
		}
		var v struct {
			App       map[string]any `json:"app"`
			Transport string         `json:"transport"`
		}
		if err := json.Unmarshal([]byte(out), &v); err != nil || v.App["appVersion"] != "7.7.7" || v.Transport != "http" {
			t.Fatalf("unexpected: %q (%v)", out, err)
		}
	})
}

func TestJ11MissingFlagValue(t *testing.T) {
	for _, flag := range []string{"--timeout", "--agent"} {
		code, _, errOut := runCLI("status", flag)
		if code != exitUsage || !strings.Contains(errOut, "E_USAGE: "+flag+" needs a value") {
			t.Fatalf("%s: exit %d, stderr %q", flag, code, errOut)
		}
	}
}

func TestJ12FlagForms(t *testing.T) {
	s := &stubGateway{}
	withGateway(t, s)

	if code, out, errOut := runCLI("--timeout=5s", "status"); code != exitOK || !strings.Contains(out, "tabs: 4") {
		t.Fatalf("--timeout=5s: exit %d out %q err %q", code, out, errOut)
	}
	if code, out, _ := runCLI("status", "--json"); code != exitOK || !strings.HasPrefix(strings.TrimSpace(out), "{") {
		t.Fatalf("flag after command: exit %d out %q", code, out)
	}
	if code, out, _ := runCLI("-q", "status"); code != exitOK || strings.Contains(out, "[agb]") {
		t.Fatalf("--quiet should drop the header: %q", out)
	}
	if code, _, _ := runCLI("--agent", "claude-code", "status"); code != exitOK {
		t.Fatalf("--agent: exit %d", code)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.statusCtx["agent"] != "claude-code" {
		t.Fatalf("ctx.agent not sent: %v", s.statusCtx)
	}
}

func TestK05CorruptDiscovery(t *testing.T) {
	home := t.TempDir()
	t.Setenv("AGB_HOME", home)
	writeDiscovery(t, home, "{not json")
	code, _, errOut := runCLI("status")
	if code != exitNoGateway || !strings.Contains(errOut, "E_NO_GATEWAY: parse") || !strings.Contains(errOut, "hint: restart Agentic Browser") {
		t.Fatalf("exit %d, stderr %q", code, errOut)
	}
}

func TestK06IncompleteDiscovery(t *testing.T) {
	home := t.TempDir()
	t.Setenv("AGB_HOME", home)
	writeDiscovery(t, home, map[string]any{"version": "1", "protocol": "1.0", "http": "http://127.0.0.1:1"})
	code, _, errOut := runCLI("status")
	if code != exitNoGateway || !strings.Contains(errOut, "is incomplete") {
		t.Fatalf("exit %d, stderr %q", code, errOut)
	}
}

func TestK07UnresponsiveGateway(t *testing.T) {
	t.Run("hello never answered", func(t *testing.T) {
		withGateway(t, &stubGateway{hangHello: true})
		code, _, errOut := runCLI("--timeout", "1s", "status")
		if code != exitNoGateway || !strings.Contains(errOut, "context deadline exceeded") {
			t.Fatalf("exit %d, stderr %q", code, errOut)
		}
	})
	t.Run("status never answered", func(t *testing.T) {
		withGateway(t, &stubGateway{hangStatus: true})
		code, _, errOut := runCLI("--timeout", "1s", "status")
		if code != exitTimeout || !strings.Contains(errOut, "E_TIMEOUT") {
			t.Fatalf("exit %d, stderr %q", code, errOut)
		}
	})
}

func TestK09TokenNeverPrinted(t *testing.T) {
	withGateway(t, &stubGateway{})
	for _, args := range [][]string{{"version"}, {"status"}, {"--json", "status"}, {"--json", "version"}} {
		_, out, errOut := runCLI(args...)
		if strings.Contains(out+errOut, stubToken) {
			t.Fatalf("%v printed the token", args)
		}
	}
}
