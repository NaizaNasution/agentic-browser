package main

// Snapshot, action, wait, dialog, and download commands against a stub gateway.
// Case IDs are from docs/testing/M2-test-cases.md.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var at1 = map[string]any{"space": "sp_1", "tab": "t_1", "url": "https://x/", "title": "X"}

func lastParams(t *testing.T, s *agentStub) map[string]any {
	t.Helper()
	p, _ := s.last(t)["params"].(map[string]any)
	return p
}

func TestC01SnapshotOutput(t *testing.T) {
	s := withAgentStub(t)
	s.results["page.snapshot"] = map[string]any{
		"at": at1, "text": "main @e1\n  button \"OK\" @e2", "refs": 2, "tokens": 9, "hiddenOmitted": 2, "collapsed": 1,
		"scroll": map[string]any{"y": 800, "maxY": 1600, "viewportHeight": 800},
	}
	code, out, _ := runCLI("snapshot", "--mode", "full", "--scope", "@e1", "--max-tokens", "500")
	want := "[agb] space=sp_1 tab=t_1 url=https://x/ title=X\n" + untrustedStart + "\nmain @e1\n  button \"OK\" @e2\n" +
		"--- end page content · 2 refs · ~9 tokens · viewport 2 of 3 · 1 section collapsed to fit; use --scope or --max-tokens · hidden text omitted: 2 ---\n"
	if code != exitOK || out != want {
		t.Fatalf("exit %d output:\n%s\nwant:\n%s", code, out, want)
	}
	p := lastParams(t, s)
	if p["mode"] != "full" || p["scope"] != "@e1" || p["maxTokens"] != float64(500) {
		t.Fatalf("params %v", p)
	}
	for _, bad := range [][]string{{"snapshot", "--mode", "pretty"}, {"snapshot", "--max-tokens", "10"}, {"snapshot", "extra"}} {
		if code, _, _ := runCLI(bad...); code != exitUsage {
			t.Fatalf("%v: exit %d", bad, code)
		}
	}
}

func TestC02SnapshotDiff(t *testing.T) {
	s := withAgentStub(t)
	scroll := map[string]any{"y": 0, "maxY": 0, "viewportHeight": 800}
	s.results["page.snapshot"] = map[string]any{"at": at1, "text": "", "refs": 3, "tokens": 0, "hiddenOmitted": 0, "collapsed": 0, "scroll": scroll, "changes": []string{`+ alert "Saved" @e9`, `- button "Save" @e4`}}
	code, out, _ := runCLI("snapshot", "--diff")
	if code != exitOK || !strings.Contains(out, "changes since the last snapshot:\n"+untrustedStart+"\n+ alert \"Saved\" @e9\n- button \"Save\" @e4\n--- end page content · 2 changes ---\n") {
		t.Fatalf("exit %d out %q", code, out)
	}
	if lastParams(t, s)["diff"] != true {
		t.Fatal("diff not sent")
	}
	s.results["page.snapshot"] = map[string]any{"at": at1, "text": "", "refs": 3, "tokens": 0, "hiddenOmitted": 0, "collapsed": 0, "scroll": scroll, "changes": []string{}}
	if _, out, _ := runCLI("snapshot", "--diff"); !strings.Contains(out, "no changes since the last snapshot") {
		t.Fatalf("out %q", out)
	}
}

func TestC03ClickOutput(t *testing.T) {
	s := withAgentStub(t)
	s.results["page.click"] = map[string]any{
		"at": at1, "action": "click", "target": map[string]any{"ref": "@e5", "role": "button", "name": "Sign in"},
		"note": "@e5 re-resolved", "changes": []string{`+ alert "Wrong password" @e9`}, "opened": []string{"t_2"},
		"downloads":   []any{map[string]any{"id": "d_1", "url": "u", "filename": "r.pdf", "path": "/dl/r.pdf", "state": "completed", "bytes": 2048}},
		"fileChooser": true, "durationMs": 300,
	}
	code, out, _ := runCLI("click", "@e5", "--modifiers", "ctrl,Shift", "--count", "2", "--button", "right", "--follow")
	want := "[agb] space=sp_1 tab=t_1 url=https://x/ title=X\n" +
		"ok: clicked button \"Sign in\" @e5\n" +
		"note: @e5 re-resolved\n" +
		"opened tab t_2 (use `agb tab select t_2`, or --follow next time)\n" +
		"downloaded: d_1 r.pdf (2 KB) → /dl/r.pdf\n" +
		"note: the page opened a file chooser; use `agb upload <ref> <file>`\n" +
		"changes:\n  + alert \"Wrong password\" @e9\n"
	if code != exitOK || out != want {
		t.Fatalf("exit %d output:\n%s\nwant:\n%s", code, out, want)
	}
	p := lastParams(t, s)
	mods, _ := p["modifiers"].([]any)
	if p["ref"] != "@e5" || p["count"] != float64(2) || p["button"] != "right" || p["follow"] != true || len(mods) != 2 || mods[0] != "Control" || mods[1] != "Shift" {
		t.Fatalf("params %v", p)
	}
	if code, _, errOut := runCLI("click", "@e5", "--modifiers", "hyper"); code != exitUsage || !strings.Contains(errOut, "unknown modifier") {
		t.Fatalf("bad modifier: exit %d %q", code, errOut)
	}
}

func TestC04NavigationAndDialogInResult(t *testing.T) {
	s := withAgentStub(t)
	s.results["page.click"] = map[string]any{"at": map[string]any{"space": "sp_1", "tab": "t_1", "url": "https://x/docs", "title": "Docs"}, "action": "click",
		"target": map[string]any{"ref": "@e4", "role": "link", "name": "Docs"}, "navigated": true, "changes": []string{}, "durationMs": 9}
	_, out, _ := runCLI("click", "@e4")
	if !strings.Contains(out, "ok: clicked link \"Docs\" @e4 → navigated to https://x/docs (refs were reset; use agb snapshot)\n") {
		t.Fatalf("out %q", out)
	}
	s.results["page.click"] = map[string]any{"at": at1, "action": "click", "target": map[string]any{"ref": "@e6", "role": "button", "name": "Delete"},
		"dialog": map[string]any{"type": "confirm", "message": "Sure?"}, "changes": []string{}, "durationMs": 9}
	_, out, _ = runCLI("click", "@e6")
	if !strings.Contains(out, "dialog: a confirm dialog is waiting: \"Sure?\"\nhint: answer it with `agb dialog accept` or `agb dialog dismiss`\n") {
		t.Fatalf("out %q", out)
	}
}

func TestC05RefAndActionabilityExitCodes(t *testing.T) {
	for name, want := range map[string]int{"E_NO_REF": exitRef, "E_STALE_REF": exitRef, "E_NOT_ACTIONABLE": exitNotActive, "E_DIALOG_OPEN": exitError} {
		t.Run(name, func(t *testing.T) {
			s := withAgentStub(t)
			s.errors["page.click"] = rpcError(name, -32017, "@e9 problem", "snapshot again")
			if code, _, errOut := runCLI("click", "@e9"); code != want || !strings.Contains(errOut, name) {
				t.Fatalf("exit %d, want %d (%q)", code, want, errOut)
			}
		})
	}
}

func TestC06FillClearFlag(t *testing.T) {
	s := withAgentStub(t)
	s.results["page.fill"] = map[string]any{"at": at1, "action": "fill", "target": map[string]any{"ref": "@e2", "role": "textbox", "name": "Email"}, "value": "a@b.c", "changes": []string{}, "durationMs": 1}
	runCLI("fill", "@e2", "a@b.c", "--submit")
	if p := lastParams(t, s); p["text"] != "a@b.c" || p["submit"] != true || p["clear"] != nil {
		t.Fatalf("default: %v", p)
	}
	for _, flag := range []string{"--no-clear", "--clear=false"} {
		runCLI("fill", "@e2", "more", flag)
		if p := lastParams(t, s); p["clear"] != false {
			t.Fatalf("%s: %v", flag, p)
		}
	}
	if code, _, _ := runCLI("fill", "@e2"); code != exitUsage {
		t.Fatalf("missing text: exit %d", code)
	}
}

func TestC07TypeAndPressNameTheirInput(t *testing.T) {
	s := withAgentStub(t)
	s.results["page.press"] = map[string]any{"at": at1, "action": "press", "changes": []string{}, "durationMs": 1}
	s.results["page.type"] = map[string]any{"at": at1, "action": "type", "target": map[string]any{"ref": "@e3", "role": "searchbox", "name": "Search"}, "changes": []string{}, "durationMs": 1}
	if _, out, _ := runCLI("press", "Control+A"); !strings.Contains(out, "ok: pressed Control+A\n") {
		t.Fatalf("out %q", out)
	}
	if _, out, _ := runCLI("type", "hello world", "--ref", "@e3"); !strings.Contains(out, "ok: typed \"hello world\" into searchbox \"Search\" @e3\n") {
		t.Fatalf("out %q", out)
	}
	if p := lastParams(t, s); p["text"] != "hello world" || p["ref"] != "@e3" {
		t.Fatalf("params %v", p)
	}
}

func TestC08ScrollSelectUpload(t *testing.T) {
	s := withAgentStub(t)
	s.results["page.scroll"] = map[string]any{"at": at1, "action": "scroll", "scroll": map[string]any{"y": 680, "maxY": 1560, "viewportHeight": 800}, "changes": []string{}, "durationMs": 1}
	if _, out, _ := runCLI("scroll", "--by", "0,600"); !strings.Contains(out, "ok: scrolled to 680 of 1560 px (viewport 2 of 3)\n") {
		t.Fatalf("out %q", out)
	}
	if p := lastParams(t, s); p["dy"] != float64(600) || p["dx"] != nil {
		t.Fatalf("params %v", p)
	}
	runCLI("scroll", "@e7", "--to", "bottom")
	if p := lastParams(t, s); p["ref"] != "@e7" || p["to"] != "bottom" {
		t.Fatalf("params %v", p)
	}
	for _, bad := range [][]string{{"scroll", "--by", "600"}, {"scroll", "--page", "left"}, {"scroll", "@e1", "@e2"}} {
		if code, _, _ := runCLI(bad...); code != exitUsage {
			t.Fatalf("%v: exit %d", bad, code)
		}
	}

	s.results["page.select"] = map[string]any{"at": at1, "action": "select", "target": map[string]any{"ref": "@e4", "role": "combobox", "name": "Country"}, "value": "Kenya", "changes": []string{}, "durationMs": 1}
	if _, out, _ := runCLI("select", "@e4", "Kenya"); !strings.Contains(out, "ok: selected \"Kenya\" in combobox \"Country\" @e4\n") {
		t.Fatalf("out %q", out)
	}

	s.results["page.upload"] = map[string]any{"at": at1, "action": "upload", "target": map[string]any{"ref": "@e9", "role": "button", "name": "Choose File"}, "value": "2 files", "changes": []string{}, "durationMs": 1}
	if _, out, _ := runCLI("upload", "@e9", "a.pdf", filepath.Join("docs", "b.pdf")); !strings.Contains(out, "ok: uploaded 2 files to button \"Choose File\" @e9\n") {
		t.Fatalf("out %q", out)
	}
	cwd, _ := os.Getwd()
	files, _ := lastParams(t, s)["files"].([]any)
	if len(files) != 2 || files[0] != filepath.Join(cwd, "a.pdf") || files[1] != filepath.Join(cwd, "docs", "b.pdf") {
		t.Fatalf("files %v (must be absolute)", files)
	}
}

func TestC09SnapshotFlagOnActions(t *testing.T) {
	s := withAgentStub(t)
	s.results["page.check"] = map[string]any{"at": at1, "action": "check", "target": map[string]any{"ref": "@e5", "role": "checkbox", "name": "Agree"}, "changes": []string{"~ checkbox \"Agree\" @e5 checked"}, "durationMs": 1,
		"snapshot": map[string]any{"at": at1, "text": "checkbox \"Agree\" @e5 checked", "refs": 1, "tokens": 8, "hiddenOmitted": 0, "collapsed": 0, "scroll": map[string]any{"y": 0, "maxY": 0, "viewportHeight": 800}}}
	_, out, _ := runCLI("check", "@e5", "--snapshot")
	if !strings.Contains(out, "changes:\n  ~ checkbox \"Agree\" @e5 checked\n"+untrustedStart+"\ncheckbox \"Agree\" @e5 checked\n--- end page content · 1 ref · ~8 tokens · viewport 1 of 1 ---\n") {
		t.Fatalf("out %q", out)
	}
	if lastParams(t, s)["snapshot"] != true {
		t.Fatal("snapshot not requested")
	}
}

func TestC10Wait(t *testing.T) {
	s := withAgentStub(t)
	s.results["wait.for"] = map[string]any{"at": at1, "matched": "text \"Saved\" present", "waitedMs": 120}
	if code, out, _ := runCLI("wait", "--text", "Saved"); code != exitOK || !strings.Contains(out, "ok: text \"Saved\" present (after 120 ms)\n") {
		t.Fatalf("exit %d out %q", code, out)
	}
	runCLI("wait", "--ms", "0")
	if p := lastParams(t, s); p["ms"] != float64(0) {
		t.Fatalf("--ms 0 must be sent: %v", p)
	}
	runCLI("wait", "--ref", "@e3", "--gone")
	if p := lastParams(t, s); p["ref"] != "@e3" || p["gone"] != true {
		t.Fatalf("params %v", p)
	}
	if code, _, _ := runCLI("wait", "--ms", "-1"); code != exitUsage {
		t.Fatalf("--ms -1: exit %d", code)
	}
}

func TestC11DialogAndDownloadCommands(t *testing.T) {
	s := withAgentStub(t)
	s.results["dialog.list"] = map[string]any{"at": at1, "dialog": map[string]any{"type": "prompt", "message": "Name?", "defaultPrompt": "Ana"}}
	if _, out, _ := runCLI("dialog"); !strings.Contains(out, "prompt dialog: \"Name?\"\ndefault answer: \"Ana\"\n") {
		t.Fatalf("out %q", out)
	}
	s.results["dialog.list"] = map[string]any{"at": at1}
	if _, out, _ := runCLI("dialog", "list"); !strings.Contains(out, "no dialog is open") {
		t.Fatalf("out %q", out)
	}
	s.results["dialog.accept"] = map[string]any{"at": at1, "action": "accept", "note": "accepted prompt \"Name?\"", "changes": []string{}, "durationMs": 1}
	if _, out, _ := runCLI("dialog", "accept", "--text", "Bo"); !strings.Contains(out, "ok: accepted the dialog\nnote: accepted prompt \"Name?\"\n") {
		t.Fatalf("out %q", out)
	}
	if p := lastParams(t, s); p["text"] != "Bo" {
		t.Fatalf("params %v", p)
	}
	if code, _, _ := runCLI("dialog", "dismiss", "--text", "x"); code != exitUsage {
		t.Fatalf("dismiss --text: exit %d", code)
	}

	dl := map[string]any{"id": "d_1", "url": "u", "filename": "r.pdf", "path": "/dl/r.pdf", "state": "completed", "bytes": 10}
	s.results["download.list"] = map[string]any{"space": "sp_1", "downloads": []any{dl}}
	if _, out, _ := runCLI("download"); !strings.Contains(out, "d_1  completed  10 bytes  r.pdf  /dl/r.pdf\n") {
		t.Fatalf("out %q", out)
	}
	s.results["download.wait"] = map[string]any{"space": "sp_1", "download": map[string]any{"id": "d_2", "url": "u", "filename": "x.zip", "path": "/dl/x.zip", "state": "interrupted", "bytes": 5}}
	if code, _, errOut := runCLI("download", "wait", "d_2"); code != exitError || !strings.Contains(errOut, "interrupted") {
		t.Fatalf("exit %d err %q", code, errOut)
	}
	if p := lastParams(t, s); p["id"] != "d_2" {
		t.Fatalf("params %v", p)
	}
}

func TestC12JSONActionResult(t *testing.T) {
	s := withAgentStub(t)
	s.results["page.hover"] = map[string]any{"at": at1, "action": "hover", "target": map[string]any{"ref": "@e2", "role": "link", "name": "Menu"}, "changes": []string{"+ menu @e8"}, "durationMs": 7}
	code, out, _ := runCLI("--json", "hover", "@e2")
	var v map[string]any
	if code != exitOK || json.Unmarshal([]byte(out), &v) != nil || v["ok"] != true || v["space"] != "sp_1" || v["action"] != "hover" || v["at"] != nil {
		t.Fatalf("exit %d out %q", code, out)
	}
}
