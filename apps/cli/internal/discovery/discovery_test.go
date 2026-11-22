package discovery

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The default locations must match apps/browser/src/shared/paths.ts (SPEC §8.1).

func TestHomeUsesAGBHomeOverride(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("AGB_HOME", dir)
	if got := Home(); got != dir {
		t.Fatalf("Home() = %q, want %q", got, dir)
	}
	if got, want := Path(), filepath.Join(dir, "gateway.json"); got != want {
		t.Fatalf("Path() = %q, want %q", got, want)
	}
}

func TestHomeDefaultForThisOS(t *testing.T) {
	t.Setenv("AGB_HOME", "")
	base := t.TempDir()

	switch runtime.GOOS {
	case "windows":
		t.Setenv("LOCALAPPDATA", base)
		if got, want := Home(), filepath.Join(base, "AgenticBrowser"); got != want {
			t.Fatalf("with LOCALAPPDATA: Home() = %q, want %q", got, want)
		}
		// Without LOCALAPPDATA, fall back to %USERPROFILE%\AppData\Local.
		t.Setenv("LOCALAPPDATA", "")
		t.Setenv("USERPROFILE", base)
		if got, want := Home(), filepath.Join(base, "AppData", "Local", "AgenticBrowser"); got != want {
			t.Fatalf("without LOCALAPPDATA: Home() = %q, want %q", got, want)
		}
	case "darwin":
		t.Setenv("HOME", base)
		if got, want := Home(), filepath.Join(base, "Library", "Application Support", "AgenticBrowser"); got != want {
			t.Fatalf("Home() = %q, want %q", got, want)
		}
	default:
		t.Setenv("XDG_STATE_HOME", base)
		if got, want := Home(), filepath.Join(base, "agentic-browser"); got != want {
			t.Fatalf("with XDG_STATE_HOME: Home() = %q, want %q", got, want)
		}
		t.Setenv("XDG_STATE_HOME", "")
		t.Setenv("HOME", base)
		if got, want := Home(), filepath.Join(base, ".local", "state", "agentic-browser"); got != want {
			t.Fatalf("without XDG_STATE_HOME: Home() = %q, want %q", got, want)
		}
	}
}

// writeHome points AGB_HOME at a temp dir and writes gateway.json with the given content.
func writeHome(t *testing.T, content string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("AGB_HOME", dir)
	if content != "" {
		if err := os.WriteFile(filepath.Join(dir, "gateway.json"), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestReadMissingFileMeansNotRunning(t *testing.T) {
	writeHome(t, "")
	if _, err := Read(); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("err = %v, want ErrNotRunning", err)
	}
}

func TestReadValidFile(t *testing.T) {
	writeHome(t, `{"version":"0.1.0","protocol":"1.0","pipe":"\\\\.\\pipe\\agb-x","http":"http://127.0.0.1:5000","token":"tok","pid":42,"startedAt":"2026-11-22T10:00:00Z"}`)
	d, err := Read()
	if err != nil {
		t.Fatal(err)
	}
	if d.Pipe != `\\.\pipe\agb-x` || d.HTTP != "http://127.0.0.1:5000" || d.Token != "tok" || d.PID != 42 || d.Protocol != "1.0" {
		t.Fatalf("unexpected discovery: %+v", d)
	}
}

func TestReadAcceptsEitherTransport(t *testing.T) {
	for name, content := range map[string]string{
		"pipe only": `{"token":"t","pipe":"p"}`,
		"http only": `{"token":"t","http":"http://127.0.0.1:1"}`,
	} {
		t.Run(name, func(t *testing.T) {
			writeHome(t, content)
			if _, err := Read(); err != nil {
				t.Fatalf("err = %v", err)
			}
		})
	}
}

func TestReadRejectsBadFiles(t *testing.T) {
	cases := map[string]struct{ content, want string }{
		"corrupt JSON":  {`{not json`, "parse "},
		"no token":      {`{"pipe":"p","http":"h"}`, "is incomplete"},
		"no transports": {`{"token":"t"}`, "is incomplete"},
		"empty object":  {`{}`, "is incomplete"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			writeHome(t, c.content)
			_, err := Read()
			if err == nil || errors.Is(err, ErrNotRunning) || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want it to contain %q", err, c.want)
			}
			if !strings.Contains(err.Error(), "gateway.json") {
				t.Fatalf("error should name the file: %v", err)
			}
		})
	}
}
