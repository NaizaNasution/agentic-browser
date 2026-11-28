package main

// agb doctor: checks PATH, the browser, the discovery file, versions, and skill folders (SPEC §9.3).
// references/troubleshooting.md in the skill explains each check.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/NaizaNasution/agentic-browser/apps/cli/internal/discovery"
	"github.com/NaizaNasution/agentic-browser/apps/cli/internal/format"
	"github.com/NaizaNasution/agentic-browser/apps/cli/internal/protocol"
	"github.com/NaizaNasution/agentic-browser/apps/cli/internal/skill"
)

type check struct {
	Name   string `json:"name"`
	Level  string `json:"level"` // ok, warn, fail
	Detail string `json:"detail"`
	Hint   string `json:"hint,omitempty"`
}

// lookPath and executable are variables so tests can fake them.
var (
	lookPath   = exec.LookPath
	executable = os.Executable
)

func cmdDoctor(g globals, args []string, stdout, stderr io.Writer) int {
	if len(args) > 0 {
		return usageErr(stderr, "unexpected argument "+args[0], "agb doctor")
	}
	var checks []check
	add := func(name, level, detail, hint string) {
		checks = append(checks, check{Name: name, Level: level, Detail: detail, Hint: hint})
	}

	// 1. agb on PATH
	self, _ := executable()
	if found, err := lookPath("agb"); err != nil {
		add("agb on PATH", "fail", "not found on PATH (this agb is "+self+")",
			"add "+filepath.Dir(self)+" to PATH so agents can run agb (see references/install.md in the skill)")
	} else if !samePath(found, self) {
		add("agb on PATH", "warn", "PATH finds "+found+", but this agb is "+self,
			"agents will run the one on PATH; remove the old copy or fix PATH")
	} else {
		add("agb on PATH", "ok", found, "")
	}

	// 2. browser, 3. discovery file, 4. versions
	appVersion, appProtocol := "", ""
	file := discovery.Path()
	if _, err := discovery.Read(); errors.Is(err, discovery.ErrNotRunning) {
		add("browser", "fail", "not running (no "+file+")", "start Agentic Browser")
	} else if err != nil {
		add("browser", "fail", err.Error(), "restart Agentic Browser to rewrite it")
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), min(g.timeout, 3*time.Second))
		c, err := dial(ctx, g)
		if err != nil {
			name, message, hint := classify(err)
			if name == "E_NO_GATEWAY" {
				hint = "gateway.json is left over or the browser stopped answering; restart Agentic Browser"
			}
			add("browser", "fail", name+": "+message, hint)
		} else {
			var st protocol.StatusResult
			if err := c.Call(ctx, protocol.MethodGatewayStatus, protocol.StatusParams{}, &st); err != nil {
				_, message, hint := classify(err)
				add("browser", "fail", message, hint)
			} else {
				appVersion, appProtocol = st.AppVersion, st.Protocol
				add("browser", "ok", fmt.Sprintf("running: app %s, pid %d, via %s", st.AppVersion, st.PID, c.Transport), "")
			}
			c.Close()
		}
		cancel()
		add(discoveryCheck(file))
	}
	checks = append(checks, versionsCheck(appVersion, appProtocol))

	// 5. agent ID, agents, and skill folders
	if id := detectedAgent(); g.agent != "" {
		add("agent ID", "ok", g.agent+" (from --agent or AGB_AGENT)", "")
	} else if id != "" {
		add("agent ID", "ok", id+" (detected)", "")
	} else {
		add("agent ID", "ok", "unknown (set AGB_AGENT to label this agent)", "")
	}

	targets, err := skill.LoadTargets()
	if err != nil {
		add("skill", "fail", err.Error(), "this agb build is broken; reinstall it")
	} else {
		checks = append(checks, skillChecks(targets, skillEnv())...)
	}

	failed := slices.ContainsFunc(checks, func(c check) bool { return c.Level == "fail" })
	if g.json {
		format.JSON(stdout, map[string]any{"ok": !failed, "checks": checks})
	} else {
		for _, c := range checks {
			fmt.Fprintf(stdout, "%-4s %s: %s\n", c.Level, c.Name, c.Detail)
			if c.Hint != "" {
				fmt.Fprintf(stdout, "     hint: %s\n", c.Hint)
			}
		}
	}
	if failed {
		return exitError
	}
	return exitOK
}

func samePath(a, b string) bool {
	ra, errA := filepath.EvalSymlinks(a)
	rb, errB := filepath.EvalSymlinks(b)
	if errA == nil {
		a = ra
	}
	if errB == nil {
		b = rb
	}
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

// discoveryCheck: gateway.json holds the token, so only the user may read it.
func discoveryCheck(file string) (name, level, detail, hint string) {
	st, err := os.Stat(file)
	if err != nil {
		return "discovery file", "warn", err.Error(), ""
	}
	if runtime.GOOS == "windows" {
		// The app writes it under %LOCALAPPDATA%, which only the user (and administrators) can read.
		if local := os.Getenv("LOCALAPPDATA"); local != "" && !strings.HasPrefix(strings.ToLower(file), strings.ToLower(local)) {
			return "discovery file", "warn", file + " is outside %LOCALAPPDATA% (AGB_HOME is set)", "make sure only your account can read that folder"
		}
		return "discovery file", "ok", file + " (in your private app data folder)", ""
	}
	if mode := st.Mode().Perm(); mode&0o077 != 0 {
		return "discovery file", "fail", fmt.Sprintf("%s can be read by other users (mode %04o)", file, mode), "chmod 600 " + file + ", then restart Agentic Browser"
	}
	return "discovery file", "ok", file + " (only you can read it)", ""
}

func versionsCheck(appVersion, appProtocol string) check {
	meta := skill.Bundled()
	detail := fmt.Sprintf("agb %s, protocol %s, skill %s", version, protocol.ProtocolVersion, meta.Version)
	if appVersion == "" {
		return check{Name: "versions", Level: "ok", Detail: detail + " (browser not checked)"}
	}
	detail += fmt.Sprintf(", app %s (protocol %s)", appVersion, appProtocol)
	switch {
	case majorOf(appProtocol) != majorOf(protocol.ProtocolVersion):
		return check{Name: "versions", Level: "fail", Detail: detail, Hint: "agb and the browser can't talk to each other; update both together"}
	case appVersion != version:
		return check{Name: "versions", Level: "warn", Detail: detail, Hint: "use the agb that came with the browser, so the guide matches the commands"}
	case meta.MinAppVersion != "" && !strings.Contains(appVersion, "-dev") && versionLess(appVersion, meta.MinAppVersion):
		return check{Name: "versions", Level: "warn", Detail: detail, Hint: "the skill needs app " + meta.MinAppVersion + " or later; update Agentic Browser"}
	}
	return check{Name: "versions", Level: "ok", Detail: detail}
}

func majorOf(v string) string { m, _, _ := strings.Cut(v, "."); return m }

// versionLess compares dotted numeric versions (1.2.10 > 1.2.9). Pre-release suffixes are ignored.
func versionLess(a, b string) bool {
	pa, pb := strings.Split(strings.SplitN(a, "-", 2)[0], "."), strings.Split(strings.SplitN(b, "-", 2)[0], ".")
	for i := range max(len(pa), len(pb)) {
		var x, y int
		if i < len(pa) {
			fmt.Sscan(pa[i], &x)
		}
		if i < len(pb) {
			fmt.Sscan(pb[i], &y)
		}
		if x != y {
			return x < y
		}
	}
	return false
}

func skillChecks(t *skill.Targets, env skill.Env) []check {
	var out []check
	var found, missing []string
	readers := map[string][]string{} // folder ID -> names of found agents that read it
	for _, a := range t.Agents {
		if ok, why := a.Found(env); ok {
			found = append(found, a.Name+" ("+why+")")
			for _, f := range a.Folders {
				readers[f] = append(readers[f], a.Name)
			}
		} else {
			missing = append(missing, a.Name)
		}
	}
	detail := "found " + orNone(found)
	if len(missing) > 0 {
		detail += "; not found: " + strings.Join(missing, ", ")
	}
	out = append(out, check{Name: "agents", Level: "ok", Detail: detail})

	bundled := skill.Bundled().Version
	cwd, _ := os.Getwd()
	for _, f := range t.Folders {
		dirs := []string{filepath.Join(skill.ExpandHome(f.User, env.Home), skill.Name)}
		if cwd != "" {
			// Project installs are checked only if present.
			if p := filepath.Join(cwd, filepath.FromSlash(f.Project), skill.Name); dirExists(p) {
				dirs = append(dirs, p)
			}
		}
		for i, dir := range dirs {
			who := strings.Join(readers[f.ID], ", ")
			needed := len(readers[f.ID]) > 0 || f.Always
			out = append(out, folderCheck(dir, who, needed && i == 0, bundled))
		}
	}
	return out
}

func folderCheck(dir, who string, needed bool, bundled string) check {
	name := "skill: " + dir
	st := skill.Inspect(dir)
	reads := ""
	if who != "" {
		reads = " (read by " + who + ")"
	}
	switch {
	case !st.Installed && needed:
		return check{Name: name, Level: "warn", Detail: "not installed" + reads, Hint: "run `agb skill install`"}
	case !st.Installed:
		return check{Name: name, Level: "ok", Detail: "not installed (no agent found that reads it)"}
	case !st.Ours:
		return check{Name: name, Level: "warn", Detail: "a SKILL.md agb didn't write is there" + reads, Hint: "agb leaves it alone; remove it, then run `agb skill install`, to use agb's"}
	case len(st.Pending) > 0:
		return check{Name: name, Level: "warn", Detail: "you edited " + strings.Join(st.Edited, ", ") + "; a newer version is waiting in " + strings.Join(st.Pending, ", "),
			Hint: "compare the files and keep what you want; delete the .new file when done"}
	case len(st.Edited) > 0:
		return check{Name: name, Level: "warn", Detail: "version " + st.Version + ", with your edits to " + strings.Join(st.Edited, ", ") + reads,
			Hint: "agb skill install won't overwrite your edits"}
	case len(st.Missing) > 0:
		return check{Name: name, Level: "warn", Detail: "missing " + strings.Join(st.Missing, ", ") + reads, Hint: "run `agb skill install`"}
	case !st.Current:
		return check{Name: name, Level: "warn", Detail: fmt.Sprintf("version %s, but this agb ships %s%s", st.Version, bundled, reads), Hint: "run `agb skill install` to update it"}
	}
	return check{Name: name, Level: "ok", Detail: "version " + st.Version + reads}
}

func dirExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}
