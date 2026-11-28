package main

// Snapshots, actions, waits, dialogs, and downloads (docs/SPEC.md §9.3, §10, §11).

import (
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/NaizaNasution/agentic-browser/apps/cli/internal/format"
	"github.com/NaizaNasution/agentic-browser/apps/cli/internal/protocol"
)

// ---------- agb snapshot ----------

func cmdSnapshot(g globals, args []string, stdout, stderr io.Writer) int {
	const use = "agb snapshot [--mode interactive|full] [--scope <ref>] [--max-tokens N] [--diff]"
	a, err := parseArgs(args, map[string]bool{"--mode": true, "--scope": true, "--max-tokens": true, "--diff": false})
	if err != nil {
		return usageErr(stderr, err.Error(), use)
	}
	if len(a.pos) > 0 {
		return usageErr(stderr, "unexpected argument "+a.pos[0], use)
	}
	p := protocol.SnapshotParams{Mode: a.flags["--mode"], Scope: a.flags["--scope"], Diff: a.has("--diff")}
	if p.Mode != "" && p.Mode != "interactive" && p.Mode != "full" {
		return usageErr(stderr, "bad --mode "+p.Mode, "use interactive or full")
	}
	if v, ok := a.flags["--max-tokens"]; ok {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 200 || n > 100000 {
			return usageErr(stderr, "bad --max-tokens "+v, "use a number from 200 to 100000")
		}
		p.MaxTokens = n
	}
	raw, code := call(g, protocol.MethodPageSnapshot, p, stdout, stderr)
	if code != exitOK {
		return code
	}
	if g.json {
		printJSON(stdout, raw, nil)
		return exitOK
	}
	var r protocol.SnapshotResult
	if code := decode(raw, &r, g, stdout, stderr); code != exitOK {
		return code
	}
	header(g, stdout, r.At)
	printSnapshotBody(stdout, &r)
	return exitOK
}

// printSnapshotBody prints a snapshot (or its changes) between untrusted-content delimiters (§10.2).
func printSnapshotBody(w io.Writer, r *protocol.SnapshotResult) {
	if r.Note != "" {
		fmt.Fprintf(w, "note: %s\n", r.Note)
	}
	if r.Changes != nil && r.Text == "" {
		if len(r.Changes) == 0 {
			fmt.Fprintln(w, "no changes since the last snapshot")
			return
		}
		fmt.Fprintln(w, "changes since the last snapshot:")
		fmt.Fprintln(w, untrustedStart)
		for _, c := range r.Changes {
			fmt.Fprintln(w, c)
		}
		fmt.Fprintf(w, "%s · %d %s ---\n", untrustedEnd, len(r.Changes), plural(int64(len(r.Changes)), "change", "changes"))
		return
	}
	fmt.Fprintln(w, untrustedStart)
	if r.Text != "" {
		fmt.Fprintln(w, r.Text)
	} else {
		fmt.Fprintln(w, "(nothing to act on or read)")
	}
	footer := []string{fmt.Sprintf("%d %s", r.Refs, plural(r.Refs, "ref", "refs")), fmt.Sprintf("~%d tokens", r.Tokens), viewportText(r.Scroll)}
	if r.Collapsed > 0 {
		footer = append(footer, fmt.Sprintf("%d %s collapsed to fit; use --scope or --max-tokens", r.Collapsed, plural(r.Collapsed, "section", "sections")))
	}
	if r.HiddenOmitted > 0 {
		footer = append(footer, fmt.Sprintf("hidden text omitted: %d", r.HiddenOmitted))
	}
	fmt.Fprintf(w, "%s · %s ---\n", untrustedEnd, strings.Join(footer, " · "))
}

// viewportText is "viewport 1 of 3": which screenful is showing, of how many.
func viewportText(s protocol.ScrollInfo) string {
	vh := s.ViewportHeight
	if vh <= 0 {
		return ""
	}
	total := (s.MaxY + vh + vh - 1) / vh
	current := (s.Y+vh/2)/vh + 1
	if s.Y >= s.MaxY && s.MaxY > 0 {
		current = total
	}
	return fmt.Sprintf("viewport %d of %d", min(current, max(total, 1)), max(total, 1))
}

// ---------- actions ----------

// actionSpec describes one action command.
type actionSpec struct {
	method string
	use    string
	flags  map[string]bool
	// params builds the request from the parsed arguments, or returns a usage error.
	params func(a cmdArgs) (any, error)
}

var actionSpecs = map[string]actionSpec{
	"click": {
		method: protocol.MethodPageClick,
		use:    "agb click <ref> [--button left|right|middle] [--count 2] [--modifiers ctrl,shift] [--follow] [--snapshot]",
		flags:  map[string]bool{"--button": true, "--count": true, "--modifiers": true, "--follow": false},
		params: func(a cmdArgs) (any, error) {
			if len(a.pos) != 1 {
				return nil, fmt.Errorf("agb click takes one ref")
			}
			p := protocol.ClickParams{Ref: a.pos[0], Button: a.flags["--button"], Follow: a.has("--follow")}
			if p.Button != "" && p.Button != "left" && p.Button != "right" && p.Button != "middle" {
				return nil, fmt.Errorf("bad --button %s", p.Button)
			}
			if v, ok := a.flags["--count"]; ok {
				n, err := strconv.ParseInt(v, 10, 64)
				if err != nil || n < 1 || n > 3 {
					return nil, fmt.Errorf("bad --count %s (use 1, 2, or 3)", v)
				}
				p.Count = n
			}
			if v := a.flags["--modifiers"]; v != "" {
				for _, m := range strings.Split(v, ",") {
					name, ok := modifierNames[strings.ToLower(strings.TrimSpace(m))]
					if !ok {
						return nil, fmt.Errorf("unknown modifier %q (use ctrl, shift, alt, meta)", m)
					}
					p.Modifiers = append(p.Modifiers, name)
				}
			}
			return p, nil
		},
	},
	"hover": {
		method: protocol.MethodPageHover,
		use:    "agb hover <ref> [--snapshot]",
		params: func(a cmdArgs) (any, error) {
			if len(a.pos) != 1 {
				return nil, fmt.Errorf("agb hover takes one ref")
			}
			return protocol.RefParams{Ref: a.pos[0]}, nil
		},
	},
	"fill": {
		method: protocol.MethodPageFill,
		use:    `agb fill <ref> "<text>" [--submit] [--no-clear] [--direct] [--snapshot]`,
		flags:  map[string]bool{"--submit": false, "--clear": false, "--no-clear": false, "--direct": false},
		params: func(a cmdArgs) (any, error) {
			if len(a.pos) != 2 {
				return nil, fmt.Errorf(`agb fill takes a ref and the text (quote text with spaces)`)
			}
			p := protocol.FillParams{Ref: a.pos[0], Text: a.pos[1], Submit: a.has("--submit"), Direct: a.has("--direct")}
			if a.has("--no-clear") || a.flags["--clear"] == "false" {
				p.Clear = false
				return fillNoClear{p}, nil
			}
			return p, nil
		},
	},
	"type": {
		method: protocol.MethodPageType,
		use:    `agb type "<text>" [--ref <ref>] [--snapshot]`,
		flags:  map[string]bool{"--ref": true},
		params: func(a cmdArgs) (any, error) {
			if len(a.pos) != 1 {
				return nil, fmt.Errorf("agb type takes the text (quote text with spaces)")
			}
			return protocol.TypeParams{Text: a.pos[0], Ref: a.flags["--ref"]}, nil
		},
	},
	"press": {
		method: protocol.MethodPagePress,
		use:    "agb press <key-combo> [--ref <ref>] [--snapshot]   e.g. Enter, Escape, Tab, Control+A, Shift+Tab",
		flags:  map[string]bool{"--ref": true},
		params: func(a cmdArgs) (any, error) {
			if len(a.pos) != 1 {
				return nil, fmt.Errorf("agb press takes one key combination")
			}
			return protocol.PressParams{Keys: a.pos[0], Ref: a.flags["--ref"]}, nil
		},
	},
	"select": {
		method: protocol.MethodPageSelect,
		use:    "agb select <ref> <option>... [--snapshot]",
		params: func(a cmdArgs) (any, error) {
			if len(a.pos) < 2 {
				return nil, fmt.Errorf("agb select takes a ref and one or more option labels or values")
			}
			return protocol.SelectParams{Ref: a.pos[0], Values: a.pos[1:]}, nil
		},
	},
	"check": {
		method: protocol.MethodPageCheck,
		use:    "agb check <ref> [--snapshot]",
		params: func(a cmdArgs) (any, error) {
			if len(a.pos) != 1 {
				return nil, fmt.Errorf("agb check takes one ref")
			}
			return protocol.RefParams{Ref: a.pos[0]}, nil
		},
	},
	"uncheck": {
		method: protocol.MethodPageUncheck,
		use:    "agb uncheck <ref> [--snapshot]",
		params: func(a cmdArgs) (any, error) {
			if len(a.pos) != 1 {
				return nil, fmt.Errorf("agb uncheck takes one ref")
			}
			return protocol.RefParams{Ref: a.pos[0]}, nil
		},
	},
	"scroll": {
		method: protocol.MethodPageScroll,
		use:    "agb scroll [<ref>] [--by x,y] [--page down|up] [--to top|bottom|<ref>] [--snapshot]",
		flags:  map[string]bool{"--by": true, "--page": true, "--to": true},
		params: func(a cmdArgs) (any, error) {
			if len(a.pos) > 1 {
				return nil, fmt.Errorf("agb scroll takes at most one ref (the container to scroll)")
			}
			p := protocol.ScrollParams{Page: a.flags["--page"], To: a.flags["--to"]}
			if len(a.pos) == 1 {
				p.Ref = a.pos[0]
			}
			if p.Page != "" && p.Page != "up" && p.Page != "down" {
				return nil, fmt.Errorf("bad --page %s (use up or down)", p.Page)
			}
			if v := a.flags["--by"]; v != "" {
				xs, ys, ok := strings.Cut(v, ",")
				x, errX := strconv.ParseInt(strings.TrimSpace(xs), 10, 64)
				y, errY := strconv.ParseInt(strings.TrimSpace(ys), 10, 64)
				if !ok || errX != nil || errY != nil {
					return nil, fmt.Errorf("bad --by %s (use x,y in pixels, e.g. 0,600)", v)
				}
				p.Dx, p.Dy = x, y
			}
			return p, nil
		},
	},
	"upload": {
		method: protocol.MethodPageUpload,
		use:    "agb upload <ref> <file>... [--snapshot]   (files in the current directory or the Space's downloads)",
		params: func(a cmdArgs) (any, error) {
			if len(a.pos) < 2 {
				return nil, fmt.Errorf("agb upload takes a ref and one or more files")
			}
			files := make([]string, 0, len(a.pos)-1)
			for _, f := range a.pos[1:] {
				abs, err := filepath.Abs(f)
				if err != nil {
					return nil, err
				}
				files = append(files, abs)
			}
			return protocol.UploadParams{Ref: a.pos[0], Files: files}, nil
		},
	},
}

// fillNoClear sends "clear": false explicitly (the generated struct omits false).
type fillNoClear struct{ protocol.FillParams }

func (f fillNoClear) MarshalJSON() ([]byte, error) {
	b, err := json.Marshal(f.FillParams)
	if err != nil {
		return nil, err
	}
	return append(b[:len(b)-1], []byte(`,"clear":false}`)...), nil
}

var modifierNames = map[string]string{
	"ctrl": "Control", "control": "Control", "shift": "Shift", "alt": "Alt", "option": "Alt", "meta": "Meta", "cmd": "Meta", "command": "Meta", "win": "Meta",
}

func cmdAction(name string) func(g globals, args []string, stdout, stderr io.Writer) int {
	return func(g globals, args []string, stdout, stderr io.Writer) int {
		spec := actionSpecs[name]
		flags := map[string]bool{"--snapshot": false}
		for k, v := range spec.flags {
			flags[k] = v
		}
		a, err := parseArgs(args, flags)
		if err != nil {
			return usageErr(stderr, err.Error(), spec.use)
		}
		params, err := spec.params(a)
		if err != nil {
			return usageErr(stderr, err.Error(), spec.use)
		}
		if a.has("--snapshot") {
			params = withSnapshot(params)
		}
		raw, code := call(g, spec.method, params, stdout, stderr)
		if code != exitOK {
			return code
		}
		// What was typed or pressed isn't in the result; name it in the "ok:" line.
		detail := ""
		switch name {
		case "press":
			detail = a.pos[0]
		case "type":
			detail = strconv.Quote(truncateRunes(a.pos[0], 60))
		}
		return printAction(g, raw, stdout, stderr, detail)
	}
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

// withSnapshot adds "snapshot": true to any params struct.
func withSnapshot(p any) any {
	b, _ := json.Marshal(p)
	m := map[string]any{}
	_ = json.Unmarshal(b, &m)
	m["snapshot"] = true
	return m
}

var actionVerbs = map[string]string{
	"click": "clicked", "hover": "moved the pointer over", "fill": "filled", "type": "typed", "press": "pressed",
	"select": "selected", "check": "checked", "uncheck": "unchecked", "scroll": "scrolled", "upload": "uploaded",
	"accept": "accepted the dialog", "dismiss": "dismissed the dialog",
}

func describeTarget(t *protocol.ActionTarget) string {
	if t == nil {
		return ""
	}
	s := t.Role
	if t.Name != "" {
		s += " " + strconv.Quote(t.Name)
	}
	return s + " " + t.Ref
}

// printAction prints an action result (§11.4). `detail` names what was typed or pressed.
func printAction(g globals, raw json.RawMessage, stdout, stderr io.Writer, detail string) int {
	if g.json {
		printJSON(stdout, raw, nil)
		return exitOK
	}
	var r protocol.ActionResult
	if code := decode(raw, &r, g, stdout, stderr); code != exitOK {
		return code
	}
	header(g, stdout, r.At)

	verb := actionVerbs[r.Action]
	if verb == "" {
		verb = r.Action
	}
	line := "ok: " + verb
	if detail != "" {
		line += " " + detail
	}
	target := describeTarget(r.Target)
	switch {
	case r.Action == "accept" || r.Action == "dismiss" || target == "":
	case r.Action == "select" && r.Value != "":
		line += fmt.Sprintf(" %s in %s", strconv.Quote(r.Value), target)
	case r.Action == "upload":
		line += fmt.Sprintf(" %s to %s", r.Value, target)
	case r.Action == "type" || r.Action == "press":
		line += " into " + target
	default:
		line += " " + target
	}
	if r.Action == "scroll" && r.Scroll != nil {
		line += fmt.Sprintf(" to %d of %d px (%s)", r.Scroll.Y, r.Scroll.MaxY, viewportText(*r.Scroll))
	}
	if r.Navigated {
		line += " → navigated to " + r.At.URL
		if r.Snapshot == nil {
			line += " (refs were reset; use agb snapshot)"
		}
	}
	fmt.Fprintln(stdout, line)
	if r.Note != "" {
		fmt.Fprintf(stdout, "note: %s\n", r.Note)
	}
	if r.Dialog != nil {
		fmt.Fprintf(stdout, "dialog: a %s dialog is waiting: %s\nhint: answer it with `agb dialog accept` or `agb dialog dismiss`\n", r.Dialog.Type, strconv.Quote(r.Dialog.Message))
	}
	for _, t := range r.Opened {
		fmt.Fprintf(stdout, "opened tab %s (use `agb tab select %s`, or --follow next time)\n", t, t)
	}
	for _, d := range r.Downloads {
		if d.State == "completed" {
			fmt.Fprintf(stdout, "downloaded: %s %s (%s) → %s\n", d.ID, d.Filename, humanBytes(d.Bytes), d.Path)
		} else {
			fmt.Fprintf(stdout, "download %s: %s %s (%s so far) → %s\n", d.State, d.ID, d.Filename, humanBytes(d.Bytes), d.Path)
		}
	}
	if r.FileChooser {
		fmt.Fprintln(stdout, "note: the page opened a file chooser; use `agb upload <ref> <file>`")
	}
	if len(r.Changes) > 0 {
		fmt.Fprintln(stdout, "changes:")
		for _, c := range r.Changes {
			fmt.Fprintln(stdout, "  "+c)
		}
	}
	if r.Snapshot != nil {
		printSnapshotBody(stdout, r.Snapshot)
	}
	return exitOK
}

// ---------- agb wait ----------

func cmdWait(g globals, args []string, stdout, stderr io.Writer) int {
	const use = `agb wait [--text "..."] [--ref <ref>] [--gone] [--url <glob>] [--load] [--networkidle] [--ms N]`
	a, err := parseArgs(args, map[string]bool{"--text": true, "--ref": true, "--gone": false, "--url": true, "--load": false, "--networkidle": false, "--ms": true})
	if err != nil {
		return usageErr(stderr, err.Error(), use)
	}
	if len(a.pos) > 0 {
		return usageErr(stderr, "unexpected argument "+a.pos[0], use)
	}
	p := protocol.WaitParams{Text: a.flags["--text"], Ref: a.flags["--ref"], Gone: a.has("--gone"), URL: a.flags["--url"], Load: a.has("--load"), Networkidle: a.has("--networkidle")}
	if v, ok := a.flags["--ms"]; ok {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 || n > 300000 {
			return usageErr(stderr, "bad --ms "+v, "use milliseconds from 0 to 300000")
		}
		p.Ms = n
		if n == 0 {
			// 0 is a valid wait; the generated struct would omit it.
			return runWait(g, map[string]any{"ms": 0}, stdout, stderr)
		}
	}
	return runWait(g, p, stdout, stderr)
}

func runWait(g globals, p any, stdout, stderr io.Writer) int {
	raw, code := call(g, protocol.MethodWaitFor, p, stdout, stderr)
	if code != exitOK {
		return code
	}
	if g.json {
		printJSON(stdout, raw, nil)
		return exitOK
	}
	var r protocol.WaitResult
	if code := decode(raw, &r, g, stdout, stderr); code != exitOK {
		return code
	}
	header(g, stdout, r.At)
	fmt.Fprintf(stdout, "ok: %s (after %d ms)\n", r.Matched, r.WaitedMs)
	return exitOK
}

// ---------- agb dialog ----------

func cmdDialog(g globals, args []string, stdout, stderr io.Writer) int {
	const use = `agb dialog [list] | agb dialog accept [--text "..."] | agb dialog dismiss`
	sub := "list"
	if len(args) > 0 {
		sub, args = args[0], args[1:]
	}
	switch sub {
	case "list":
		if len(args) > 0 {
			return usageErr(stderr, "unexpected argument "+args[0], use)
		}
		raw, code := call(g, protocol.MethodDialogList, protocol.DialogListParams{}, stdout, stderr)
		if code != exitOK {
			return code
		}
		if g.json {
			printJSON(stdout, raw, nil)
			return exitOK
		}
		var r protocol.DialogListResult
		if code := decode(raw, &r, g, stdout, stderr); code != exitOK {
			return code
		}
		header(g, stdout, r.At)
		if r.Dialog == nil {
			fmt.Fprintln(stdout, "no dialog is open")
			return exitOK
		}
		fmt.Fprintf(stdout, "%s dialog: %s\n", r.Dialog.Type, strconv.Quote(r.Dialog.Message))
		if r.Dialog.Type == "prompt" {
			fmt.Fprintf(stdout, "default answer: %s\n", strconv.Quote(r.Dialog.DefaultPrompt))
		}
		return exitOK
	case "accept", "dismiss":
		flags := map[string]bool{"--snapshot": false}
		if sub == "accept" {
			flags["--text"] = true
		}
		a, err := parseArgs(args, flags)
		if err != nil {
			return usageErr(stderr, err.Error(), use)
		}
		if len(a.pos) > 0 {
			return usageErr(stderr, "unexpected argument "+a.pos[0], use)
		}
		var params any = protocol.DialogParams{Text: a.flags["--text"]}
		if a.has("--snapshot") {
			params = withSnapshot(params)
		}
		method := protocol.MethodDialogAccept
		if sub == "dismiss" {
			method = protocol.MethodDialogDismiss
		}
		raw, code := call(g, method, params, stdout, stderr)
		if code != exitOK {
			return code
		}
		return printAction(g, raw, stdout, stderr, "")
	}
	return usageErr(stderr, "unknown subcommand dialog "+sub, use)
}

// ---------- agb download ----------

func cmdDownload(g globals, args []string, stdout, stderr io.Writer) int {
	const use = "agb download [list] | agb download wait [<id>]"
	sub := "list"
	if len(args) > 0 {
		sub, args = args[0], args[1:]
	}
	switch sub {
	case "list":
		if len(args) > 0 {
			return usageErr(stderr, "unexpected argument "+args[0], use)
		}
		raw, code := call(g, protocol.MethodDownloadList, protocol.DownloadListParams{}, stdout, stderr)
		if code != exitOK {
			return code
		}
		if g.json {
			printJSON(stdout, raw, nil)
			return exitOK
		}
		var r protocol.DownloadListResult
		if code := decode(raw, &r, g, stdout, stderr); code != exitOK {
			return code
		}
		if !g.quiet {
			fmt.Fprintln(stdout, format.Header(format.Field{Key: "space", Value: r.Space}))
		}
		if len(r.Downloads) == 0 {
			fmt.Fprintln(stdout, "no downloads in this Space")
		}
		for _, d := range r.Downloads {
			fmt.Fprintln(stdout, downloadLine(d))
		}
		return exitOK
	case "wait":
		if len(args) > 1 {
			return usageErr(stderr, "unexpected argument "+args[1], use)
		}
		p := protocol.DownloadWaitParams{}
		if len(args) == 1 {
			p.ID = args[0]
		}
		raw, code := call(g, protocol.MethodDownloadWait, p, stdout, stderr)
		if code != exitOK {
			return code
		}
		if g.json {
			printJSON(stdout, raw, nil)
			return exitOK
		}
		var r protocol.DownloadWaitResult
		if code := decode(raw, &r, g, stdout, stderr); code != exitOK {
			return code
		}
		fmt.Fprintln(stdout, downloadLine(r.Download))
		if r.Download.State != "completed" {
			format.Error(stderr, "E_DOWNLOAD", "the download "+r.Download.State, "try again, or check the link")
			return exitError
		}
		return exitOK
	}
	return usageErr(stderr, "unknown subcommand download "+sub, use)
}

func downloadLine(d protocol.DownloadInfo) string {
	return fmt.Sprintf("%s  %s  %s  %s  %s", d.ID, d.State, humanBytes(d.Bytes), d.Filename, d.Path)
}
