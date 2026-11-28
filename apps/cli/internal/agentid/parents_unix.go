//go:build !windows

package agentid

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// parents reads /proc on Linux, and asks ps elsewhere (macOS).
func parents(depth int) []string {
	if _, err := os.Stat("/proc/self/stat"); err == nil {
		return procParents(depth)
	}
	out, err := exec.Command("ps", "-A", "-o", "pid=,ppid=,comm=").Output()
	if err != nil {
		return nil
	}
	type proc struct {
		ppid int
		exe  string
	}
	procs := map[int]proc{}
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		pid, err1 := strconv.Atoi(f[0])
		ppid, err2 := strconv.Atoi(f[1])
		if err1 != nil || err2 != nil {
			continue
		}
		procs[pid] = proc{ppid: ppid, exe: strings.Join(f[2:], " ")}
	}
	var names []string
	pid := os.Getpid()
	for range depth {
		p, ok := procs[pid]
		if !ok || p.ppid <= 1 {
			break
		}
		parent, ok := procs[p.ppid]
		if !ok {
			break
		}
		names = append(names, parent.exe)
		pid = p.ppid
	}
	return names
}

func procParents(depth int) []string {
	var names []string
	pid := os.Getpid()
	for range depth {
		ppid, ok := procParent(pid)
		if !ok || ppid <= 1 {
			break
		}
		comm, err := os.ReadFile("/proc/" + strconv.Itoa(ppid) + "/comm")
		if err != nil {
			break
		}
		names = append(names, strings.TrimSpace(string(comm)))
		pid = ppid
	}
	return names
}

// procParent reads the parent PID from /proc/<pid>/stat ("pid (comm) state ppid …").
func procParent(pid int) (int, bool) {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0, false
	}
	s := string(b)
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return 0, false
	}
	f := strings.Fields(s[i+1:])
	if len(f) < 2 {
		return 0, false
	}
	ppid, err := strconv.Atoi(f[1])
	return ppid, err == nil
}
