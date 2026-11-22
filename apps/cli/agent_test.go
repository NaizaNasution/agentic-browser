package main

// Agent commands against a stub gateway. Case IDs are from docs/testing/M1-test-cases.md.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// agentStub answers agent methods with canned results or errors, and records every request.
type agentStub struct {
	mu       sync.Mutex
	requests []map[string]any
	results  map[string]any            // method -> result
	errors   map[string]map[string]any // method -> error object
}

func (s *agentStub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req map[string]any
	_ = json.NewDecoder(r.Body).Decode(&req)
	method, _ := req["method"].(string)
	s.mu.Lock()
	if method != "gateway.hello" {
		s.requests = append(s.requests, req)
	}
	res, hasRes := s.results[method]
	rpcErr, hasErr := s.errors[method]
	s.mu.Unlock()
	out := map[string]any{"jsonrpc": "2.0", "id": req["id"]}
	switch {
	case method == "gateway.hello":
		out["result"] = map[string]any{"appVersion": "7.7.7", "protocol": "1.0", "serverTime": "now"}
	case hasErr:
		out["error"] = rpcErr
	case hasRes:
		out["result"] = res
	default:
		out["error"] = map[string]any{"code": -32601, "message": "Unknown method " + method, "data": map[string]any{"name": "E_METHOD_NOT_FOUND"}}
	}
	_ = json.NewEncoder(w).Encode(out)
}

func (s *agentStub) last(t *testing.T) map[string]any {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.requests) == 0 {
		t.Fatal("no request was sent")
	}
	return s.requests[len(s.requests)-1]
}

func (s *agentStub) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.requests)
}

func withAgentStub(t *testing.T) *agentStub {
	t.Helper()
	s := &agentStub{results: map[string]any{}, errors: map[string]map[string]any{}}
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	home := t.TempDir()
	t.Setenv("AGB_HOME", home)
	t.Setenv("AGB_SPACE", "")
	t.Setenv("AGB_TAB", "")
	t.Setenv("AGB_AGENT", "")
	writeDiscovery(t, home, map[string]any{"version": "7.7.7", "protocol": "1.0", "http": srv.URL, "token": stubToken, "pid": 7, "startedAt": "now"})
	return s
}

func rpcError(name string, code int, message, hint string) map[string]any {
	return map[string]any{"code": code, "message": message, "data": map[string]any{"name": name, "hint": hint}}
}

var newSpaceAt = map[string]any{"space": "sp_3a1", "tab": "t_1", "url": "https://example.com/", "title": "Example Domain", "spaceCreated": true, "spaceMode": "isolated"}

func TestA01ParseArgs(t *testing.T) {
	spec := map[string]bool{"--wait": true, "--strict": false, "-o": true}
	a, err := parseArgs([]string{"https://x", "--wait", "none", "--strict", "-o=f.png", "--", "--literal"}, spec)
	if err != nil {
		t.Fatal(err)
	}
	if a.flags["--wait"] != "none" || !a.has("--strict") || a.flags["-o"] != "f.png" || strings.Join(a.pos, ",") != "https://x,--literal" {
		t.Fatalf("parsed %+v", a)
	}
	for _, bad := range [][]string{{"--nope"}, {"--wait"}, {"--strict=maybe"}} {
		if _, err := parseArgs(bad, spec); err == nil {
			t.Fatalf("%v: expected an error", bad)
		}
	}
	if a, _ := parseArgs([]string{"--strict=false"}, spec); a.has("--strict") {
		t.Fatal("--strict=false should be off")
	}
}

func TestA02GotoHeaderAndContext(t *testing.T) {
	s := withAgentStub(t)
	s.results["nav.goto"] = map[string]any{"at": newSpaceAt, "status": 200, "durationMs": 321}
	t.Setenv("AGB_AGENT", "claude-code")
	t.Setenv("AGB_SPACE", "sp_env")
	code, out, errOut := runCLI("--timeout", "10m", "goto", "https://example.com", "--wait", "networkidle")
	if code != exitOK {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	want := "[agb] space=sp_3a1 (new, isolated) tab=t_1 url=https://example.com/ title=\"Example Domain\"\nok: HTTP 200 in 321 ms\n"
	if out != want {
		t.Fatalf("output:\n%s\nwant:\n%s", out, want)
	}
	req := s.last(t)
	params := req["params"].(map[string]any)
	ctx := req["ctx"].(map[string]any)
	cwd, _ := os.Getwd()
	if params["url"] != "https://example.com" || params["wait"] != "networkidle" {
		t.Fatalf("params %v", params)
	}
	if ctx["agent"] != "claude-code" || ctx["space"] != "sp_env" || ctx["cwd"] != cwd || ctx["timeoutMs"] != float64(300000) {
		t.Fatalf("ctx %v (timeoutMs is clamped to 5 minutes)", ctx)
	}
	if _, ok := ctx["tab"]; ok {
		t.Fatalf("empty tab should be omitted: %v", ctx)
	}
}

func TestA03GotoFlagsOverrideEnv(t *testing.T) {
	s := withAgentStub(t)
	s.results["nav.goto"] = map[string]any{"at": newSpaceAt, "durationMs": 1}
	t.Setenv("AGB_SPACE", "sp_env")
	if code, _, errOut := runCLI("goto", "x.example", "--space", "sp_flag", "--tab", "t_9"); code != exitOK {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	ctx := s.last(t)["ctx"].(map[string]any)
	if ctx["space"] != "sp_flag" || ctx["tab"] != "t_9" {
		t.Fatalf("ctx %v", ctx)
	}
}

func TestA04ErrorsAndExitCodes(t *testing.T) {
	cases := []struct {
		name string
		code int
		exit int
	}{
		{"E_NAV_FAILED", -32013, exitNavFailed},
		{"E_DENIED", -32015, exitDenied},
		{"E_TIMEOUT", -32012, exitTimeout},
		{"E_INVALID_PARAMS", -32602, exitUsage},
		{"E_NO_SPACE", -32010, exitError},
		{"E_LIMIT", -32014, exitError},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := withAgentStub(t)
			s.errors["nav.goto"] = rpcError(c.name, c.code, "it went wrong", "do this next")
			code, out, errOut := runCLI("goto", "https://x.example")
			if code != c.exit || out != "" || errOut != "[agb] error "+c.name+": it went wrong\nhint: do this next\n" {
				t.Fatalf("exit %d out %q err %q", code, out, errOut)
			}
			code, out, errOut = runCLI("--json", "goto", "https://x.example")
			var v struct {
				OK    bool              `json:"ok"`
				Error map[string]string `json:"error"`
			}
			if code != c.exit || errOut != "" || json.Unmarshal([]byte(out), &v) != nil || v.OK || v.Error["code"] != c.name || v.Error["hint"] != "do this next" {
				t.Fatalf("--json: exit %d out %q err %q", code, out, errOut)
			}
		})
	}
}

func TestA05StrictTreatsHTTPErrorsAsFailures(t *testing.T) {
	s := withAgentStub(t)
	s.results["nav.goto"] = map[string]any{"at": map[string]any{"space": "sp_1", "tab": "t_1", "url": "https://x/missing", "title": "Not found"}, "status": 404, "durationMs": 5}
	code, out, _ := runCLI("goto", "https://x/missing")
	if code != exitOK || !strings.Contains(out, "warning: the server answered HTTP 404") {
		t.Fatalf("without --strict: exit %d out %q", code, out)
	}
	code, _, errOut := runCLI("goto", "https://x/missing", "--strict")
	if code != exitNavFailed || !strings.Contains(errOut, "E_NAV_FAILED: the server answered HTTP 404") {
		t.Fatalf("--strict: exit %d err %q", code, errOut)
	}
}

func TestA06TextIsWrappedAsUntrusted(t *testing.T) {
	s := withAgentStub(t)
	s.results["page.text"] = map[string]any{"at": map[string]any{"space": "sp_1", "tab": "t_2", "url": "https://x/", "title": "X"}, "text": "# Hello\n\nWorld", "chars": 5000, "truncated": true, "hiddenOmitted": 3}
	code, out, _ := runCLI("text", "--max-chars", "200")
	want := "[agb] space=sp_1 tab=t_2 url=https://x/ title=X\n" + untrustedStart + "\n# Hello\n\nWorld\n" +
		"--- end page content · 5000 chars · truncated at 14; use --max-chars for more · hidden text omitted: 3 ---\n"
	if code != exitOK || out != want {
		t.Fatalf("exit %d output:\n%s\nwant:\n%s", code, out, want)
	}
	if mc := s.last(t)["params"].(map[string]any)["maxChars"]; mc != float64(200) {
		t.Fatalf("maxChars %v", mc)
	}
	if code, _, _ := runCLI("text", "--max-chars", "5"); code != exitUsage {
		t.Fatalf("--max-chars 5: exit %d", code)
	}
}

func TestA07CaptureOutputPath(t *testing.T) {
	s := withAgentStub(t)
	tmp := filepath.Join(t.TempDir(), "capture.png")
	if err := os.WriteFile(tmp, []byte("png-bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	s.results["page.capture"] = map[string]any{"at": map[string]any{"space": "sp_1", "tab": "t_1"}, "path": tmp, "format": "png", "width": 1280, "height": 800, "bytes": 9, "truncated": false}

	work := t.TempDir()
	old, _ := os.Getwd()
	if err := os.Chdir(work); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(old) })
	work, _ = os.Getwd() // resolves symlinks such as macOS's /var -> /private/var

	code, out, errOut := runCLI("capture", "-o", "shots/page.png")
	dest := filepath.Join(work, "shots", "page.png")
	if code != exitOK || !strings.Contains(out, "saved: "+dest+" (png, 1280x800, 9 bytes)") {
		t.Fatalf("exit %d out %q err %q", code, out, errOut)
	}
	if b, err := os.ReadFile(dest); err != nil || string(b) != "png-bytes" {
		t.Fatalf("dest: %q %v", b, err)
	}
	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		t.Fatal("the temp capture should have been moved")
	}

	before := s.count()
	for _, bad := range []string{"../outside.png", filepath.Join(t.TempDir(), "abs.png"), "."} {
		code, _, errOut := runCLI("capture", "-o", bad)
		if code != exitDenied || !strings.Contains(errOut, "E_DENIED") {
			t.Fatalf("-o %s: exit %d err %q", bad, code, errOut)
		}
	}
	if s.count() != before {
		t.Fatal("no screenshot should be taken when -o is refused")
	}
}

func TestA08CaptureFormatFromExtension(t *testing.T) {
	s := withAgentStub(t)
	s.results["page.capture"] = map[string]any{"at": map[string]any{"space": "sp_1"}, "path": filepath.Join(t.TempDir(), "missing.jpg"), "format": "jpeg", "width": 1, "height": 1, "bytes": 1, "truncated": false}
	_, _, _ = runCLI("capture", "--full-page", "--quality", "70", "-o", filepath.Join(".", "x-"+t.Name()+".jpg"))
	p := s.last(t)["params"].(map[string]any)
	if p["format"] != "jpeg" || p["fullPage"] != true || p["quality"] != float64(70) {
		t.Fatalf("params %v", p)
	}
	if code, _, _ := runCLI("capture", "--format", "gif"); code != exitUsage {
		t.Fatalf("--format gif: exit %d", code)
	}
}

func TestA09TabAndSpaceListing(t *testing.T) {
	s := withAgentStub(t)
	s.results["tab.list"] = map[string]any{"space": "sp_1", "tabs": []any{
		map[string]any{"id": "t_1", "url": "", "title": "", "active": false, "loading": false},
		map[string]any{"id": "t_2", "url": "https://x/", "title": "X", "active": true, "loading": true},
	}}
	code, out, _ := runCLI("tab", "list")
	want := "[agb] space=sp_1\nt_1  about:blank  \"\"\nt_2  https://x/  \"X\"  (loading)  (active)\n"
	if code != exitOK || out != want {
		t.Fatalf("exit %d out %q", code, out)
	}
	s.results["space.list"] = map[string]any{"spaces": []any{}}
	if code, out, _ := runCLI("space", "list"); code != exitOK || !strings.Contains(out, "no Spaces for this agent") {
		t.Fatalf("exit %d out %q", code, out)
	}
	s.results["space.list"] = map[string]any{"spaces": []any{map[string]any{
		"id": "sp_1", "agent": "a", "mode": "isolated", "visible": false, "tabs": 1, "viewport": "1280x800", "createdAt": "x", "lastUsedAt": "y", "sticky": true, "name": "research",
	}}}
	if code, out, _ := runCLI("space", "list"); code != exitOK || out != "sp_1  isolated  1 tab  hidden  viewport 1280x800  (default here)  \"research\"\n" {
		t.Fatalf("exit %d out %q", code, out)
	}
}

func TestA10JSONFlattensLocation(t *testing.T) {
	s := withAgentStub(t)
	s.results["nav.back"] = map[string]any{"at": map[string]any{"space": "sp_1", "tab": "t_1", "url": "https://x/", "title": "X"}, "moved": false, "durationMs": 2}
	code, out, _ := runCLI("--json", "back")
	var v map[string]any
	if code != exitOK || json.Unmarshal([]byte(out), &v) != nil {
		t.Fatalf("exit %d out %q", code, out)
	}
	if v["ok"] != true || v["space"] != "sp_1" || v["tab"] != "t_1" || v["moved"] != false || v["at"] != nil {
		t.Fatalf("json %v", v)
	}
	if code, out, _ := runCLI("back"); code != exitOK || !strings.Contains(out, "no previous page in this tab's history") {
		t.Fatalf("exit %d out %q", code, out)
	}
}

func TestA11UsageErrors(t *testing.T) {
	withAgentStub(t)
	for _, args := range [][]string{
		{"goto"},
		{"goto", "a", "b"},
		{"goto", "https://x", "--wait", "forever"},
		{"goto", "https://x", "--bogus"},
		{"tab"},
		{"tab", "select"},
		{"tab", "frob"},
		{"space"},
		{"space", "new", "extra"},
		{"back", "extra"},
		{"capture", "--quality", "500"},
	} {
		code, _, errOut := runCLI(args...)
		if code != exitUsage || !strings.Contains(errOut, "E_USAGE") || !strings.Contains(errOut, "hint:") {
			t.Fatalf("%v: exit %d err %q", args, code, errOut)
		}
	}
}

func TestA12AgentCommandsWhenNotRunning(t *testing.T) {
	t.Setenv("AGB_HOME", t.TempDir())
	code, out, errOut := runCLI("goto", "https://x")
	if code != exitNoGateway || out != "" || !strings.Contains(errOut, "E_NO_GATEWAY") || !strings.Contains(errOut, "hint: start Agentic Browser") {
		t.Fatalf("exit %d out %q err %q", code, out, errOut)
	}
	code, out, _ = runCLI("--json", "text")
	if code != exitNoGateway || !strings.Contains(out, `"code": "E_NO_GATEWAY"`) {
		t.Fatalf("--json: exit %d out %q", code, out)
	}
}
