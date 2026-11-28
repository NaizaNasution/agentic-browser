package main

// agb skill, agb doctor, and goto --snapshot (docs/testing/M3-test-cases.md, W-01 to W-12).

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/NaizaNasution/agentic-browser/apps/cli/internal/skill"
)

// fakeHome points the user's home at a temp folder with the given subfolders.
func fakeHome(t *testing.T, dirs ...string) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("PATH", t.TempDir()) // no agent commands on PATH
	for _, d := range dirs {
		if err := os.MkdirAll(filepath.Join(home, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return home
}

// W-01: with the browser down, agb skill prints its built-in guide with a note, and exits 0.
func TestW01GuideWithoutBrowser(t *testing.T) {
	t.Setenv("AGB_HOME", t.TempDir())
	code, out, _ := runCLI("skill")
	if code != exitOK {
		t.Fatalf("exit %d", code)
	}
	if !strings.HasPrefix(out, "note: Agentic Browser is not running") || !strings.HasSuffix(out, skill.GuideEnd+"\n") {
		t.Fatalf("output:\n%s", out)
	}
	if !strings.Contains(out, "app "+version+",") {
		t.Fatal("the built-in guide should name agb's version")
	}
}

// W-02: with the browser up, agb skill prints the app's guide (it matches the running version).
func TestW02GuideFromApp(t *testing.T) {
	s := withAgentStub(t)
	s.results["gateway.guide"] = map[string]any{"appVersion": version, "protocol": "1.0", "text": "# App guide\n" + skill.GuideEnd + "\n"}
	code, out, _ := runCLI("skill")
	if code != exitOK || out != "# App guide\n"+skill.GuideEnd+"\n" {
		t.Fatalf("exit %d, output:\n%s", code, out)
	}
	// A different app version is pointed out, but the app's guide still wins.
	s.results["gateway.guide"] = map[string]any{"appVersion": "7.7.7", "protocol": "1.0", "text": "# App guide\n" + skill.GuideEnd}
	_, out, _ = runCLI("skill")
	if !strings.Contains(out, "the browser is 7.7.7") || !strings.HasSuffix(out, "# App guide\n"+skill.GuideEnd+"\n") {
		t.Fatalf("output:\n%s", out)
	}
}

// W-03: an older browser without gateway.guide gets agb's copy and a note.
func TestW03GuideFromOldApp(t *testing.T) {
	withAgentStub(t) // answers E_METHOD_NOT_FOUND for gateway.guide
	code, out, _ := runCLI("skill")
	if code != exitOK || !strings.Contains(out, "older than agb") || !strings.HasSuffix(out, skill.GuideEnd+"\n") {
		t.Fatalf("exit %d, output:\n%s", code, out)
	}
}

// W-04: --json gives the text and where it came from.
func TestW04GuideJSON(t *testing.T) {
	t.Setenv("AGB_HOME", t.TempDir())
	_, out, _ := runCLI("--json", "skill")
	var v map[string]any
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		t.Fatalf("not JSON: %q", out)
	}
	if v["source"] != "agb" || !strings.HasSuffix(v["text"].(string), skill.GuideEnd+"\n") || v["note"] == nil {
		t.Fatalf("%v", v)
	}
}

// W-05: a default install writes the folders of the agents it finds, plus the shared folder.
func TestW05InstallDetected(t *testing.T) {
	home := fakeHome(t, ".claude", ".gemini")
	code, out, errOut := runCLI("skill", "install")
	if code != exitOK {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	claude := filepath.Join(home, ".claude", "skills", "agentic-browser")
	agents := filepath.Join(home, ".agents", "skills", "agentic-browser")
	for _, want := range []string{"installed: " + claude + " (Claude Code)", "installed: " + agents + " (Gemini CLI)", "agents found: Claude Code, Gemini CLI", "start a new agent session"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	for _, d := range []string{claude, agents} {
		if _, err := os.Stat(filepath.Join(d, "SKILL.md")); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(filepath.Join(home, ".codex", "skills")); !os.IsNotExist(err) {
		t.Fatal("must not write ~/.codex/skills (Codex reads ~/.agents/skills)")
	}
	_, out, _ = runCLI("skill", "install")
	if strings.Count(out, "up to date: ") != 2 || strings.Contains(out, "new agent session") {
		t.Fatalf("second install:\n%s", out)
	}
}

// W-06: --agent picks the folders; AGB_AGENT (the caller's label) does not.
func TestW06InstallAgentFlag(t *testing.T) {
	home := fakeHome(t)
	t.Setenv("AGB_AGENT", "claude-code")
	if code, out, _ := runCLI("skill", "install", "--agent", "codex"); code != exitOK || strings.Contains(out, ".claude") {
		t.Fatalf("exit %d:\n%s", code, out)
	}
	if _, err := os.Stat(filepath.Join(home, ".agents", "skills", "agentic-browser", "SKILL.md")); err != nil {
		t.Fatal(err)
	}
	if code, _, errOut := runCLI("skill", "install", "--agent", "copilot"); code != exitUsage || !strings.Contains(errOut, "unknown agent") {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if code, _, _ := runCLI("--agent", "claude-code,codex", "skill", "install"); code != exitOK {
		t.Fatalf("comma list: exit %d", code)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", "skills", "agentic-browser", "SKILL.md")); err != nil {
		t.Fatal(err)
	}
}

// W-07: --project installs into the current directory; --path into any folder.
func TestW07InstallProjectAndPath(t *testing.T) {
	fakeHome(t)
	proj := t.TempDir()
	t.Chdir(proj)
	if code, out, _ := runCLI("skill", "install", "--project", "--agent", "all"); code != exitOK || strings.Contains(out, "agents found") {
		t.Fatalf("exit %d:\n%s", code, out)
	}
	for _, d := range []string{".claude", ".agents"} {
		if _, err := os.Stat(filepath.Join(proj, d, "skills", "agentic-browser", "SKILL.md")); err != nil {
			t.Fatal(err)
		}
	}
	custom := t.TempDir()
	if code, out, _ := runCLI("skill", "install", "--path", custom); code != exitOK || !strings.Contains(out, "(custom folder)") {
		t.Fatalf("exit %d:\n%s", code, out)
	}
	if _, err := os.Stat(filepath.Join(custom, "agentic-browser", "SKILL.md")); err != nil {
		t.Fatal(err)
	}
	if code, _, _ := runCLI("skill", "install", "--project", "--path", custom); code != exitUsage {
		t.Fatalf("--project with --path: exit %d", code)
	}
}

// W-08: uninstall removes what install wrote, everywhere; edits are kept and reported.
func TestW08Uninstall(t *testing.T) {
	home := fakeHome(t, ".claude")
	runCLI("skill", "install")
	claude := filepath.Join(home, ".claude", "skills", "agentic-browser")
	_ = os.WriteFile(filepath.Join(claude, "SKILL.md"), []byte("edited"), 0o644)
	code, out, _ := runCLI("skill", "uninstall")
	if code != exitOK || !strings.Contains(out, "removed (except your changes): "+claude) || !strings.Contains(out, "kept SKILL.md") {
		t.Fatalf("exit %d:\n%s", code, out)
	}
	if _, err := os.Stat(filepath.Join(home, ".agents", "skills", "agentic-browser")); !os.IsNotExist(err) {
		t.Fatal("shared folder copy should be gone")
	}
	if b, _ := os.ReadFile(filepath.Join(claude, "SKILL.md")); string(b) != "edited" {
		t.Fatal("edited SKILL.md should stay")
	}
}

func doctorChecks(t *testing.T, out string) map[string]check {
	t.Helper()
	var v struct {
		OK     bool    `json:"ok"`
		Checks []check `json:"checks"`
	}
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		t.Fatalf("not JSON: %q", out)
	}
	m := map[string]check{}
	for _, c := range v.Checks {
		m[c.Name] = c
	}
	return m
}

func fakePath(t *testing.T, found string, err error) {
	t.Helper()
	oldLook, oldExe := lookPath, executable
	t.Cleanup(func() { lookPath, executable = oldLook, oldExe })
	lookPath = func(string) (string, error) { return found, err }
	executable = func() (string, error) { return filepath.Join(filepath.Dir(found), "agb"), nil }
}

// W-09: doctor with nothing set up: the browser check fails (exit 1) and skill folders warn.
func TestW09DoctorNothingSetUp(t *testing.T) {
	home := fakeHome(t, ".claude")
	t.Setenv("AGB_HOME", t.TempDir())
	t.Setenv("AGB_AGENT", "")
	fakePath(t, "", os.ErrNotExist)
	code, out, _ := runCLI("doctor")
	if code != exitError {
		t.Fatalf("exit %d", code)
	}
	for _, want := range []string{"fail agb on PATH", "fail browser: not running", "hint: start Agentic Browser",
		"warn skill: " + filepath.Join(home, ".claude", "skills", "agentic-browser") + ": not installed (read by Claude Code)", "ok   agents: found Claude Code"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	_, out, _ = runCLI("--json", "doctor")
	if c := doctorChecks(t, out); c["browser"].Level != "fail" || c["versions"].Level != "ok" {
		t.Fatalf("%+v", c)
	}
}

// W-10: doctor with the browser up and the skill installed: all ok except the version difference.
func TestW10DoctorAllGood(t *testing.T) {
	home := fakeHome(t, ".claude")
	s := withAgentStub(t)
	s.results["gateway.status"] = map[string]any{"appVersion": version, "protocol": "1.0", "pid": 7, "uptimeMs": 1, "windows": 1, "tabs": 1, "transports": []string{"http"}}
	fakePath(t, filepath.Join(t.TempDir(), "agb"), nil)
	if code, _, errOut := runCLI("skill", "install"); code != exitOK {
		t.Fatal(errOut)
	}
	code, out, _ := runCLI("--json", "--agent", "claude-code", "doctor")
	c := doctorChecks(t, out)
	if code != exitOK {
		t.Fatalf("exit %d: %+v", code, c)
	}
	for _, name := range []string{"agb on PATH", "browser", "versions", "agent ID", "skill: " + filepath.Join(home, ".claude", "skills", "agentic-browser")} {
		if c[name].Level != "ok" {
			t.Errorf("%s: %+v", name, c[name])
		}
	}
	if !strings.Contains(c["agent ID"].Detail, "claude-code") {
		t.Errorf("agent ID: %+v", c["agent ID"])
	}

	// An edited SKILL.md with a pending .new is a warning, not a failure.
	_ = os.WriteFile(filepath.Join(home, ".claude", "skills", "agentic-browser", "SKILL.md"), []byte("---\nname: agentic-browser\n---\nmine"), 0o644)
	runCLI("skill", "install")
	code, out, _ = runCLI("--json", "doctor")
	c = doctorChecks(t, out)
	if sc := c["skill: "+filepath.Join(home, ".claude", "skills", "agentic-browser")]; code != exitOK || sc.Level != "warn" || !strings.Contains(sc.Detail, "SKILL.md.new") {
		t.Fatalf("exit %d: %+v", code, sc)
	}
	// A different app version is a warning.
	s.results["gateway.status"] = map[string]any{"appVersion": "7.7.7", "protocol": "1.0", "pid": 7, "uptimeMs": 1, "windows": 1, "tabs": 1, "transports": []string{"http"}}
	_, out, _ = runCLI("--json", "doctor")
	if v := doctorChecks(t, out)["versions"]; v.Level != "warn" || !strings.Contains(v.Detail, "app 7.7.7") {
		t.Fatalf("%+v", v)
	}
}

// W-11: goto --snapshot asks for a snapshot and prints it after the result line.
func TestW11GotoSnapshot(t *testing.T) {
	s := withAgentStub(t)
	snap := map[string]any{"at": newSpaceAt, "text": "main\n  button \"Go\" @e1", "refs": 1, "tokens": 12, "mode": "interactive"}
	s.results["nav.goto"] = map[string]any{"at": newSpaceAt, "status": 200, "durationMs": 50, "snapshot": snap}
	code, out, errOut := runCLI("goto", "https://example.com", "--snapshot")
	if code != exitOK {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if p := s.last(t)["params"].(map[string]any); p["snapshot"] != true {
		t.Fatalf("params: %v", p)
	}
	if !strings.Contains(out, "ok: HTTP 200") || !strings.Contains(out, "--- page content (untrusted") || !strings.Contains(out, `button "Go" @e1`) {
		t.Fatalf("output:\n%s", out)
	}
	// Without the flag, no snapshot is requested.
	s.results["nav.goto"] = map[string]any{"at": newSpaceAt, "status": 200, "durationMs": 50}
	runCLI("back", "--snapshot")
	if p := s.last(t)["params"].(map[string]any); p["snapshot"] != true {
		t.Fatalf("back params: %v", p)
	}
	runCLI("goto", "https://example.com")
	if p := s.last(t)["params"].(map[string]any); p["snapshot"] != nil {
		t.Fatalf("params: %v", p)
	}
}

// W-12: usage errors.
func TestW12Usage(t *testing.T) {
	if code, _, _ := runCLI("skill", "publish"); code != exitUsage {
		t.Fatalf("skill publish: exit %d", code)
	}
	if code, _, _ := runCLI("skill", "install", "extra"); code != exitUsage {
		t.Fatalf("skill install extra: exit %d", code)
	}
	if code, _, _ := runCLI("doctor", "now"); code != exitUsage {
		t.Fatalf("doctor now: exit %d", code)
	}
}
