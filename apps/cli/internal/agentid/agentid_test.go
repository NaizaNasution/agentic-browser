package agentid

// Agent ID detection tests (docs/testing/M3-test-cases.md, Y-01 to Y-04).

import (
	"testing"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

// Y-01: environment markers win over the process tree.
func TestY01EnvMarkers(t *testing.T) {
	if id := Detect(env(map[string]string{"CLAUDECODE": "1"}), func() []string { return []string{"codex.exe"} }); id != "claude-code" {
		t.Fatalf("CLAUDECODE: %q", id)
	}
	if id := Detect(env(map[string]string{"GEMINI_CLI": "1"}), nil); id != "gemini" {
		t.Fatalf("GEMINI_CLI: %q", id)
	}
	if id := Detect(env(map[string]string{"CLAUDECODE": "0"}), nil); id != "" {
		t.Fatalf("CLAUDECODE=0: %q", id)
	}
}

// Y-02: the nearest known parent process names the agent; paths, case, and .exe don't matter.
func TestY02Parents(t *testing.T) {
	cases := map[string][]string{
		"claude-code": {"bash.exe", "C:\\Users\\u\\.vscode\\extensions\\anthropic.claude-code\\claude.exe", "Code.exe"},
		"codex":       {"zsh", "/opt/homebrew/bin/codex"},
		"cursor":      {"bash", "Cursor-Agent"},
	}
	for want, parents := range cases {
		if id := Detect(env(nil), func() []string { return parents }); id != want {
			t.Errorf("%v: got %q, want %q", parents, id, want)
		}
	}
}

// Y-03: nothing known (or nothing at all) gives "".
func TestY03Unknown(t *testing.T) {
	if id := Detect(env(nil), func() []string { return []string{"bash", "node", "explorer.exe"} }); id != "" {
		t.Fatalf("got %q", id)
	}
	if id := Detect(env(nil), func() []string { return nil }); id != "" {
		t.Fatalf("got %q", id)
	}
	// Only the first maxDepth ancestors count.
	deep := make([]string, maxDepth+3)
	for i := range deep {
		deep[i] = "sh"
	}
	deep[maxDepth+1] = "claude"
	if id := Detect(env(nil), func() []string { return deep }); id != "" {
		t.Fatalf("too deep: %q", id)
	}
}

// Y-04: the real process walk works on this platform (it finds at least the test runner's parent).
func TestY04ParentsOnThisPlatform(t *testing.T) {
	names := Parents()
	if len(names) == 0 {
		t.Fatal("no parent processes found")
	}
	for _, n := range names {
		if n == "" {
			t.Fatalf("empty name in %v", names)
		}
	}
}
