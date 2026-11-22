package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestNoArgsPrintsUsage(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run(nil, &out, &errOut); code != exitUsage {
		t.Fatalf("exit %d, want %d", code, exitUsage)
	}
	if !strings.Contains(out.String(), "Commands:") {
		t.Fatalf("usage missing: %q", out.String())
	}
}

func TestUnknownCommand(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run([]string{"frobnicate"}, &out, &errOut); code != exitUsage {
		t.Fatalf("exit %d, want %d", code, exitUsage)
	}
	if !strings.Contains(errOut.String(), "E_USAGE") || !strings.Contains(errOut.String(), "hint:") {
		t.Fatalf("error format wrong: %q", errOut.String())
	}
}

func TestVersionWhenAppNotRunning(t *testing.T) {
	t.Setenv("AGB_HOME", t.TempDir())
	var out, errOut bytes.Buffer
	code := run([]string{"version"}, &out, &errOut)
	if code != exitNoGateway {
		t.Fatalf("exit %d, want %d", code, exitNoGateway)
	}
	if !strings.Contains(out.String(), "agb "+version) || !strings.Contains(out.String(), "app: not running") {
		t.Fatalf("unexpected output: %q", out.String())
	}
}

func TestStatusWhenAppNotRunning(t *testing.T) {
	t.Setenv("AGB_HOME", t.TempDir())
	var out, errOut bytes.Buffer
	if code := run([]string{"status"}, &out, &errOut); code != exitNoGateway {
		t.Fatalf("exit %d, want %d", code, exitNoGateway)
	}
	if !strings.Contains(errOut.String(), "E_NO_GATEWAY") {
		t.Fatalf("unexpected stderr: %q", errOut.String())
	}
}

func TestBadTimeoutFlag(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run([]string{"--timeout", "soon", "status"}, &out, &errOut); code != exitUsage {
		t.Fatalf("exit %d, want %d", code, exitUsage)
	}
}
