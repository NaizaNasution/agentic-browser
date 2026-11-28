// Package agentid works out which agent tool is running agb (docs/SPEC.md §8.4), when neither
// --agent nor AGB_AGENT names it. The ID is a label for the UI and policy, not a security boundary.
package agentid

import (
	"path/filepath"
	"strings"
)

// envMarkers are environment variables agent tools set for the commands they run.
var envMarkers = []struct{ name, value, id string }{
	{"CLAUDECODE", "1", "claude-code"}, // Claude Code
	{"GEMINI_CLI", "1", "gemini"},      // Gemini CLI
}

// processNames maps executable names (without .exe, lower case) to agent IDs.
var processNames = map[string]string{
	"claude":       "claude-code",
	"codex":        "codex",
	"cursor":       "cursor",
	"cursor-agent": "cursor",
	"gemini":       "gemini",
}

// maxDepth is how many parent processes to look at.
const maxDepth = 12

// Detect returns the agent ID, or "" if it can't tell. getenv reads the environment;
// parents returns the executable names of the parent processes, nearest first.
func Detect(getenv func(string) string, parents func() []string) string {
	for _, m := range envMarkers {
		if getenv(m.name) == m.value {
			return m.id
		}
	}
	if parents == nil {
		return ""
	}
	names := parents()
	for i, n := range names {
		if i >= maxDepth {
			break
		}
		if id, ok := processNames[normalize(n)]; ok {
			return id
		}
	}
	return ""
}

func normalize(exe string) string {
	base := strings.ToLower(filepath.Base(strings.ReplaceAll(exe, "\\", "/")))
	return strings.TrimSuffix(base, ".exe")
}

// Parents returns the executable names of this process's ancestors, nearest first.
// It returns nil if the platform doesn't allow looking them up.
func Parents() []string { return parents(maxDepth) }
