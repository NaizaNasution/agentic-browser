//go:build !windows

package client

import (
	"net"
	"path/filepath"
	"testing"
)

func listenTestPipe(t *testing.T) (string, net.Listener) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agb.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	return path, ln
}

func missingPipePath(t *testing.T) string {
	return filepath.Join(t.TempDir(), "missing.sock")
}
