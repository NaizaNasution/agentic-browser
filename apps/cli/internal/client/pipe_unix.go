//go:build !windows

package client

import (
	"context"
	"net"
)

func dialPipe(ctx context.Context, path string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "unix", path)
}
