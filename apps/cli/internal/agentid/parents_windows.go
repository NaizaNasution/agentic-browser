package agentid

import (
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// parents walks the process tree with a Toolhelp snapshot (a few milliseconds).
func parents(depth int) []string {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(snap)

	type proc struct {
		ppid uint32
		exe  string
	}
	procs := map[uint32]proc{}
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		procs[e.ProcessID] = proc{ppid: e.ParentProcessID, exe: windows.UTF16ToString(e.ExeFile[:])}
	}

	var out []string
	seen := map[uint32]bool{}
	pid := uint32(os.Getpid())
	for range depth {
		p, ok := procs[pid]
		if !ok || seen[p.ppid] || p.ppid == 0 {
			break
		}
		seen[pid] = true
		parent, ok := procs[p.ppid]
		if !ok {
			break
		}
		out = append(out, parent.exe)
		pid = p.ppid
	}
	return out
}
