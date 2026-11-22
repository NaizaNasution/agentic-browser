// Package discovery finds the running Agent Gateway through its gateway.json file (docs/SPEC.md §8.1).
// Locations must match apps/browser/src/shared/paths.ts.
package discovery

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"

	"github.com/NaizaNasution/agentic-browser/apps/cli/internal/protocol"
)

// ErrNotRunning means no discovery file exists, so the browser is (probably) not running.
var ErrNotRunning = errors.New("Agentic Browser is not running (no gateway.json)")

// Home returns the directory holding gateway.json. AGB_HOME overrides it.
func Home() string {
	if h := os.Getenv("AGB_HOME"); h != "" {
		return h
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			base = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(base, "AgenticBrowser")
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "AgenticBrowser")
	default:
		base := os.Getenv("XDG_STATE_HOME")
		if base == "" {
			base = filepath.Join(home, ".local", "state")
		}
		return filepath.Join(base, "agentic-browser")
	}
}

// Path returns the full path of gateway.json.
func Path() string { return filepath.Join(Home(), "gateway.json") }

// Read loads and validates gateway.json.
func Read() (*protocol.Discovery, error) {
	file := Path()
	b, err := os.ReadFile(file)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotRunning
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", file, err)
	}
	var d protocol.Discovery
	if err := json.Unmarshal(b, &d); err != nil {
		return nil, fmt.Errorf("parse %s: %w", file, err)
	}
	if d.Token == "" || (d.Pipe == "" && d.HTTP == "") {
		return nil, fmt.Errorf("%s is incomplete", file)
	}
	return &d, nil
}
