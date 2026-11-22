//go:build windows

package client

import (
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
)

func listenTestPipe(t *testing.T) (string, net.Listener) {
	t.Helper()
	path := fmt.Sprintf(`\\.\pipe\agb-test-%d`, time.Now().UnixNano())
	ln, err := winio.ListenPipe(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	return path, ln
}

func missingPipePath(t *testing.T) string {
	return fmt.Sprintf(`\\.\pipe\agb-missing-%d`, time.Now().UnixNano())
}
