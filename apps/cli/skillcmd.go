package main

// agb skill: print the guide, and install or remove the skill in agents' skill folders (SPEC §13).

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/NaizaNasution/agentic-browser/apps/cli/internal/client"
	"github.com/NaizaNasution/agentic-browser/apps/cli/internal/format"
	"github.com/NaizaNasution/agentic-browser/apps/cli/internal/protocol"
	"github.com/NaizaNasution/agentic-browser/apps/cli/internal/skill"
)

const skillUse = "agb skill | agb skill install [--agent claude-code|codex|cursor|gemini|all] [--project] [--path <dir>] | agb skill uninstall [same flags]"

func cmdSkill(g globals, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		return printGuide(g, stdout, stderr)
	}
	switch args[0] {
	case "install", "uninstall":
		return skillInstall(g, args[0], args[1:], stdout, stderr)
	}
	return usageErr(stderr, "unknown subcommand skill "+args[0], skillUse)
}

// printGuide prints the running app's guide, or the copy built into agb when the app isn't reachable.
func printGuide(g globals, stdout, stderr io.Writer) int {
	ctx, cancel := context.WithTimeout(context.Background(), min(g.timeout, 3*time.Second))
	defer cancel()

	var r protocol.GuideResult
	source := "app"
	var note string
	c, err := dial(ctx, g)
	if err == nil {
		defer c.Close()
		err = c.Call(ctx, protocol.MethodGatewayGuide, protocol.GuideParams{}, &r)
	}
	if err != nil {
		source = "agb"
		r = protocol.GuideResult{AppVersion: version, Protocol: protocol.ProtocolVersion, Text: skill.Guide(version, protocol.ProtocolVersion)}
		name, message, _ := classify(err)
		var rpcErr *client.RPCError
		switch {
		case name == "E_NO_GATEWAY":
			note = fmt.Sprintf("Agentic Browser is not running, so this is the guide built into agb %s. "+
				"Ask the user to start the browser before you run other commands (they exit with code 3 until then).", version)
		case errors.As(err, &rpcErr) && name == "E_METHOD_NOT_FOUND":
			note = fmt.Sprintf("the running browser is older than agb %s and has no guide; this is agb's copy. Run `agb doctor`.", version)
		case name == "E_VERSION":
			note = "agb and the running browser don't speak the same protocol (" + message + "); commands will exit with code 10. Ask the user to update Agentic Browser."
		default:
			note = fmt.Sprintf("couldn't get the guide from the browser (%s: %s); this is the copy built into agb %s.", name, message, version)
		}
	} else if r.AppVersion != version {
		note = fmt.Sprintf("agb is %s but the browser is %s; the guide below is the browser's. Run `agb doctor` if commands misbehave.", version, r.AppVersion)
	}

	if g.json {
		out := map[string]any{"ok": true, "source": source, "appVersion": r.AppVersion, "protocol": r.Protocol, "text": r.Text}
		if note != "" {
			out["note"] = note
		}
		format.JSON(stdout, out)
		return exitOK
	}
	if note != "" {
		fmt.Fprintf(stdout, "note: %s\n\n", note)
	}
	text := r.Text
	if !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	fmt.Fprint(stdout, text)
	return exitOK
}

func skillEnv() skill.Env {
	home, _ := os.UserHomeDir()
	return skill.Env{Home: home, LookPath: exec.LookPath}
}

func skillInstall(g globals, sub string, args []string, stdout, stderr io.Writer) int {
	a, err := parseArgs(args, map[string]bool{"--project": false, "--path": true})
	if err != nil {
		return usageErr(stderr, err.Error(), skillUse)
	}
	if len(a.pos) > 0 {
		return usageErr(stderr, "unexpected argument "+a.pos[0], skillUse)
	}
	targets, err := skill.LoadTargets()
	if err != nil {
		return reportErr(err, g, stdout, stderr)
	}
	sel := skill.Selection{Path: a.flags["--path"]}
	// --agent is also the global "who is calling" flag; here it picks the agents to install for.
	// AGB_AGENT does not: it only labels the caller.
	for _, id := range strings.Split(g.agentFlag, ",") {
		if id = strings.TrimSpace(id); id != "" {
			sel.Agents = append(sel.Agents, id)
		}
	}
	if sub == "uninstall" && len(sel.Agents) == 0 {
		sel.Agents = []string{"all"} // remove it everywhere agb put it
	}
	if a.has("--project") {
		if sel.Path != "" {
			return usageErr(stderr, "use --project or --path, not both", skillUse)
		}
		if sel.Project, err = os.Getwd(); err != nil {
			return reportErr(err, g, stdout, stderr)
		}
	}
	env := skillEnv()
	dests, err := targets.Plan(sel, env)
	if err != nil {
		return usageErr(stderr, err.Error(), skillUse)
	}

	meta := skill.Bundled()
	var results []folderResult
	failed := false
	for _, d := range dests {
		var r skill.Result
		var err error
		if sub == "install" {
			r, err = skill.Install(d.Dir, version)
		} else {
			r, err = skill.Uninstall(d.Dir)
		}
		if err != nil {
			failed = true
			if !g.json {
				format.Error(stderr, "E_INTERNAL", fmt.Sprintf("%s %s: %v", sub, d.Dir, err), "check the folder's permissions, then try again")
			}
			continue
		}
		results = append(results, folderResult{Result: r, Folder: d.Folder, Agents: d.Agents, Summary: summarize(sub, r)})
	}

	var found, missing []string
	for _, ag := range targets.Agents {
		if ok, _ := ag.Found(env); ok {
			found = append(found, ag.Name)
		} else {
			missing = append(missing, ag.Name)
		}
	}

	if g.json {
		format.JSON(stdout, map[string]any{"ok": !failed, "skill": meta.Name, "version": meta.Version, "folders": results, "agentsFound": found})
	} else {
		if !g.quiet {
			fmt.Fprintln(stdout, format.Header(format.Field{Key: "skill", Value: meta.Name}, format.Field{Key: "version", Value: meta.Version}))
		}
		if len(dests) == 0 {
			fmt.Fprintln(stdout, "no agents found, so nothing to do")
			fmt.Fprintln(stdout, "hint: name one with --agent claude-code (or codex, cursor, gemini, all)")
		}
		for _, r := range results {
			who := strings.Join(r.Agents, ", ")
			if who == "" {
				who = "other Agent Skills tools"
			}
			if r.Folder == "custom" {
				who = "custom folder"
			}
			fmt.Fprintf(stdout, "%s: %s (%s)\n", r.Summary, r.Dir, who)
			for _, f := range r.Files {
				switch f.Action {
				case skill.KeptEdits:
					fmt.Fprintf(stdout, "  kept your edits to %s; the new version is in %s.new\n", f.Path, f.Path)
				case skill.Kept:
					fmt.Fprintf(stdout, "  kept %s (you changed it, or agb didn't write it)\n", f.Path)
				}
			}
		}
		if sub == "install" && sel.Path == "" && sel.Project == "" && len(g.agentFlag) == 0 {
			line := "agents found: " + orNone(found)
			if len(missing) > 0 {
				line += " (not found: " + strings.Join(missing, ", ") + ")"
			}
			fmt.Fprintln(stdout, line)
		}
		if sub == "install" && anyChanged(results) {
			fmt.Fprintln(stdout, "hint: start a new agent session so it picks up the skill")
		}
	}
	if failed {
		return exitError
	}
	return exitOK
}

func summarize(sub string, r skill.Result) string {
	if sub == "uninstall" {
		if len(r.Files) == 0 {
			return "not installed"
		}
		if len(r.Edited()) > 0 {
			return "removed (except your changes)"
		}
		return "removed"
	}
	created, updated := 0, 0
	for _, f := range r.Files {
		switch f.Action {
		case skill.Created:
			created++
		case skill.Updated, skill.Removed:
			updated++
		}
	}
	switch {
	case created == len(r.Files):
		return "installed"
	case created+updated > 0:
		return "updated"
	case len(r.Edited()) > 0:
		return "up to date (except your edits)"
	}
	return "up to date"
}

// folderResult is one skill folder in the output of agb skill install / uninstall.
type folderResult struct {
	skill.Result
	Folder  string   `json:"folder"`
	Agents  []string `json:"agents"`
	Summary string   `json:"summary"`
}

func anyChanged(rs []folderResult) bool {
	for _, r := range rs {
		if r.Changed() {
			return true
		}
	}
	return false
}

func orNone(s []string) string {
	if len(s) == 0 {
		return "none"
	}
	return strings.Join(s, ", ")
}
