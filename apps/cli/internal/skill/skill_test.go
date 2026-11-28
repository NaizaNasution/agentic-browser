package skill

// Skill package and installer tests (docs/testing/M3-test-cases.md, U-01 to U-12).

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// U-01: the guide renders, has no leftover placeholders, and ends with the end marker.
func TestU01Guide(t *testing.T) {
	g := Guide("9.8.7", "1.0")
	if !strings.HasSuffix(g, GuideEnd+"\n") {
		t.Fatalf("guide must end with %q; ends with %q", GuideEnd, g[max(0, len(g)-60):])
	}
	if strings.Contains(g, "{{") || !strings.Contains(g, "app 9.8.7, protocol 1.0") {
		t.Fatalf("placeholders not filled: %q", g[:120])
	}
	if strings.Contains(g, "\r") {
		t.Fatal("guide has CR characters")
	}
	// §13.4: about 2–3k tokens (≈4 characters per token).
	if n := len(g) / 4; n < 1500 || n > 4000 {
		t.Fatalf("guide is ~%d tokens; keep it near 2–3k", n)
	}
}

// U-02: SKILL.md frontmatter follows the Agent Skills rules the target agents enforce.
func TestU02SkillFrontmatter(t *testing.T) {
	m := Bundled()
	if m.Name != Name {
		t.Fatalf("name %q must match the folder name %q (Cursor requires it)", m.Name, Name)
	}
	if !regexp.MustCompile(`^[a-z0-9-]{1,64}$`).MatchString(m.Name) {
		t.Fatalf("name %q: lowercase letters, numbers, and hyphens only", m.Name)
	}
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(m.Version) || m.MinAppVersion == "" {
		t.Fatalf("metadata: version %q, min_app_version %q", m.Version, m.MinAppVersion)
	}
	md := string(read("SKILL.md"))
	front := strings.SplitN(md, "---", 3)
	if len(front) < 3 || !strings.Contains(front[1], "description:") {
		t.Fatal("SKILL.md needs a description in its frontmatter")
	}
	// The bootstrap instructions (§13.1) and the ground rules must be there.
	for _, want := range []string{"agb skill", GuideEnd, "references/install.md", "untrusted", "code 4"} {
		if !strings.Contains(md, want) {
			t.Errorf("SKILL.md lacks %q", want)
		}
	}
	// Supporting files SKILL.md points to exist.
	for _, ref := range []string{"references/install.md", "references/troubleshooting.md", "references/state.md"} {
		if _, ok := PackageFiles()[ref]; !ok {
			t.Errorf("missing %s", ref)
		}
	}
}

// U-03: the embedded copy matches packages/skill (scripts/sync-skill.mjs was run).
func TestU03EmbeddedCopyIsCurrent(t *testing.T) {
	src := filepath.Join("..", "..", "..", "..", "packages", "skill")
	if _, err := os.Stat(src); err != nil {
		t.Skip("packages/skill not found (not running in the repository)")
	}
	err := filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !(strings.HasSuffix(p, ".md") || strings.HasSuffix(p, ".json")) {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		want, _ := os.ReadFile(p)
		got, err := files.ReadFile("files/" + filepath.ToSlash(rel))
		if err != nil || !bytes.Equal(got, want) {
			t.Errorf("%s: embedded copy differs; run `npm run codegen`", rel)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// U-04: skill-targets.json is consistent.
func TestU04Targets(t *testing.T) {
	tg, err := LoadTargets()
	if err != nil {
		t.Fatal(err)
	}
	if tg.Skill != Name {
		t.Fatalf("skill %q", tg.Skill)
	}
	for _, id := range []string{"claude-code", "codex", "cursor", "gemini"} {
		if !slices.Contains(tg.AgentIDs(), id) {
			t.Errorf("no agent %s", id)
		}
	}
	for _, a := range tg.Agents {
		if len(a.Folders) == 0 || a.Checked == "" {
			t.Errorf("%s: needs folders and a checked date", a.ID)
		}
		for _, f := range a.Folders {
			if _, ok := tg.Folder(f); !ok {
				t.Errorf("%s: unknown folder %s", a.ID, f)
			}
		}
	}
}

func fakeEnv(t *testing.T, dirs ...string) Env {
	home := t.TempDir()
	for _, d := range dirs {
		if err := os.MkdirAll(filepath.Join(home, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return Env{Home: home, LookPath: func(string) (string, error) { return "", errors.New("not found") }}
}

func dirsOf(ds []Destination) []string {
	var out []string
	for _, d := range ds {
		out = append(out, d.Folder)
	}
	return out
}

// U-05: which folders an install writes (§13.3).
func TestU05Plan(t *testing.T) {
	tg, _ := LoadTargets()

	env := fakeEnv(t, ".claude", ".codex")
	ds, err := tg.Plan(Selection{}, env)
	if err != nil || strings.Join(dirsOf(ds), ",") != "claude,agents" {
		t.Fatalf("detected: %v %v", dirsOf(ds), err)
	}
	if ds[0].Dir != filepath.Join(env.Home, ".claude", "skills", Name) || !slices.Contains(ds[1].Agents, "Codex CLI") {
		t.Fatalf("destinations: %+v", ds)
	}

	// Nothing detected: the shared folder is still written.
	if ds, _ := tg.Plan(Selection{}, fakeEnv(t)); strings.Join(dirsOf(ds), ",") != "agents" {
		t.Fatalf("none detected: %v", dirsOf(ds))
	}
	// A command on PATH counts as detected.
	env2 := fakeEnv(t)
	env2.LookPath = func(n string) (string, error) {
		if n == "claude" {
			return "/bin/claude", nil
		}
		return "", errors.New("no")
	}
	if ds, _ := tg.Plan(Selection{}, env2); strings.Join(dirsOf(ds), ",") != "claude,agents" {
		t.Fatalf("on PATH: %v", dirsOf(ds))
	}
	// Explicit agents: only their folders.
	if ds, _ := tg.Plan(Selection{Agents: []string{"claude-code"}}, env); strings.Join(dirsOf(ds), ",") != "claude" {
		t.Fatalf("claude-code: %v", dirsOf(ds))
	}
	if ds, _ := tg.Plan(Selection{Agents: []string{"codex", "gemini"}}, env); strings.Join(dirsOf(ds), ",") != "agents" {
		t.Fatalf("codex,gemini: %v", dirsOf(ds))
	}
	if ds, _ := tg.Plan(Selection{Agents: []string{"all"}}, fakeEnv(t)); strings.Join(dirsOf(ds), ",") != "claude,agents" {
		t.Fatalf("all: %v", dirsOf(ds))
	}
	if _, err := tg.Plan(Selection{Agents: []string{"copilot"}}, env); err == nil || !strings.Contains(err.Error(), "claude-code") {
		t.Fatalf("unknown agent: %v", err)
	}
	// Project and explicit path.
	proj := t.TempDir()
	ds, _ = tg.Plan(Selection{Agents: []string{"all"}, Project: proj}, env)
	if ds[0].Dir != filepath.Join(proj, ".claude", "skills", Name) || ds[1].Dir != filepath.Join(proj, ".agents", "skills", Name) {
		t.Fatalf("project: %+v", ds)
	}
	ds, _ = tg.Plan(Selection{Path: "~/my-skills", Agents: []string{"codex"}}, env)
	if len(ds) != 1 || ds[0].Dir != filepath.Join(env.Home, "my-skills", Name) {
		t.Fatalf("path: %+v", ds)
	}
}

func actions(r Result) map[string]string {
	m := map[string]string{}
	for _, f := range r.Files {
		m[f.Path] = f.Action
	}
	return m
}

// U-06: a fresh install writes every file and a manifest; a second install changes nothing.
func TestU06InstallFreshAndAgain(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "skills", Name)
	r, err := Install(dir, "1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	for p, a := range actions(r) {
		if a != Created {
			t.Errorf("%s: %s", p, a)
		}
	}
	if len(r.Files) != len(PackageFiles()) {
		t.Fatalf("%d files, want %d", len(r.Files), len(PackageFiles()))
	}
	got, _ := os.ReadFile(filepath.Join(dir, "SKILL.md"))
	if !bytes.Equal(got, read("SKILL.md")) {
		t.Fatal("SKILL.md content differs")
	}
	var m Manifest
	b, _ := os.ReadFile(filepath.Join(dir, ManifestFile))
	if err := json.Unmarshal(b, &m); err != nil || m.AgbVersion != "1.2.3" || m.Version != Bundled().Version || len(m.Files) != len(PackageFiles()) {
		t.Fatalf("manifest: %s %v", b, err)
	}
	if st := Inspect(dir); !st.Installed || !st.Ours || !st.Current || len(st.Edited) > 0 {
		t.Fatalf("inspect: %+v", st)
	}

	r, _ = Install(dir, "1.2.3")
	if r.Changed() {
		t.Fatalf("second install changed files: %+v", r.Files)
	}
}

// U-07: an older install agb wrote is updated in place.
func TestU07UpdateOlderInstall(t *testing.T) {
	dir := t.TempDir()
	if _, err := Install(dir, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	// Pretend an older agb wrote a different SKILL.md: change the file and record its hash.
	old := []byte("---\nname: agentic-browser\nmetadata:\n  version: \"0.9.0\"\n---\nold\n")
	_ = os.WriteFile(filepath.Join(dir, "SKILL.md"), old, 0o644)
	setManifestHash(t, dir, "SKILL.md", hash(old))
	if st := Inspect(dir); st.Current || st.Version != "0.9.0" || len(st.Edited) > 0 {
		t.Fatalf("before: %+v", st)
	}
	r, _ := Install(dir, "1.1.0")
	if actions(r)["SKILL.md"] != Updated {
		t.Fatalf("SKILL.md: %s", actions(r)["SKILL.md"])
	}
	if st := Inspect(dir); !st.Current {
		t.Fatalf("after: %+v", st)
	}
}

func setManifestHash(t *testing.T, dir, rel, h string) {
	t.Helper()
	m, err := readManifest(dir)
	if err != nil {
		t.Fatal(err)
	}
	m.Files[rel] = h
	b, _ := json.Marshal(m)
	_ = os.WriteFile(filepath.Join(dir, ManifestFile), b, 0o644)
}

// U-08: your edits to SKILL.md are never overwritten; the new version goes to SKILL.md.new (§13.3).
func TestU08KeepsEdits(t *testing.T) {
	dir := t.TempDir()
	_, _ = Install(dir, "1.0.0")
	edited := append(read("SKILL.md"), []byte("\nMy own note.\n")...)
	_ = os.WriteFile(filepath.Join(dir, "SKILL.md"), edited, 0o644)

	r, err := Install(dir, "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if actions(r)["SKILL.md"] != KeptEdits || !slices.Contains(r.Edited(), "SKILL.md") {
		t.Fatalf("result: %+v", r.Files)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "SKILL.md")); !bytes.Equal(got, edited) {
		t.Fatal("edited SKILL.md was overwritten")
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "SKILL.md.new")); !bytes.Equal(got, read("SKILL.md")) {
		t.Fatal("SKILL.md.new should hold the bundled version")
	}
	st := Inspect(dir)
	if !slices.Contains(st.Edited, "SKILL.md") || !slices.Contains(st.Pending, "SKILL.md.new") {
		t.Fatalf("inspect: %+v", st)
	}
	// Installing again still keeps the edits (the manifest remembers what agb wrote).
	if r, _ := Install(dir, "1.0.0"); actions(r)["SKILL.md"] != KeptEdits {
		t.Fatalf("third install: %+v", r.Files)
	}
	// Taking the new version clears the .new file on the next install.
	_ = os.WriteFile(filepath.Join(dir, "SKILL.md"), read("SKILL.md"), 0o644)
	if r, _ := Install(dir, "1.0.0"); actions(r)["SKILL.md"] != Unchanged {
		t.Fatalf("after taking the new version: %+v", r.Files)
	}
	if _, err := os.Stat(filepath.Join(dir, "SKILL.md.new")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("SKILL.md.new should be gone")
	}
}

// U-09: a SKILL.md agb didn't write (no manifest) is left alone.
func TestU09ForeignSkill(t *testing.T) {
	dir := t.TempDir()
	mine := []byte("---\nname: agentic-browser\ndescription: mine\n---\n")
	_ = os.WriteFile(filepath.Join(dir, "SKILL.md"), mine, 0o644)
	r, _ := Install(dir, "1.0.0")
	if actions(r)["SKILL.md"] != KeptEdits {
		t.Fatalf("result: %+v", r.Files)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "SKILL.md")); !bytes.Equal(got, mine) {
		t.Fatal("foreign SKILL.md was overwritten")
	}
	// Uninstall removes agb's files but not the user's SKILL.md.
	u, _ := Uninstall(dir)
	if _, err := os.Stat(filepath.Join(dir, "SKILL.md")); err != nil {
		t.Fatalf("foreign SKILL.md removed: %+v", u.Files)
	}
	if _, err := os.Stat(filepath.Join(dir, "references", "install.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("agb's reference files should be removed")
	}
}

// U-10: uninstall removes only what agb wrote and you didn't change, then empty folders.
func TestU10Uninstall(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, Name)
	_, _ = Install(dir, "1.0.0")
	u, err := Uninstall(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(u.Edited()) > 0 {
		t.Fatalf("kept: %v", u.Edited())
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("skill folder should be removed when empty")
	}

	_, _ = Install(dir, "1.0.0")
	_ = os.WriteFile(filepath.Join(dir, "references", "state.md"), []byte("changed"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("user file"), 0o644)
	u, _ = Uninstall(dir)
	if !slices.Contains(u.Edited(), "references/state.md") {
		t.Fatalf("edited file should be kept: %+v", u.Files)
	}
	for _, keep := range []string{"notes.txt", filepath.Join("references", "state.md")} {
		if _, err := os.Stat(filepath.Join(dir, keep)); err != nil {
			t.Errorf("%s should be kept", keep)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "SKILL.md")); !errors.Is(err, os.ErrNotExist) {
		t.Error("SKILL.md should be removed")
	}
	// Nothing to uninstall: no error, nothing reported.
	if u, err := Uninstall(filepath.Join(root, "nope")); err != nil || len(u.Files) > 0 {
		t.Fatalf("empty uninstall: %+v %v", u, err)
	}
}

// U-11: files an older version installed but this version doesn't ship are removed (if unchanged).
func TestU11RemovesRetiredFiles(t *testing.T) {
	dir := t.TempDir()
	_, _ = Install(dir, "1.0.0")
	retired := []byte("old reference")
	_ = os.WriteFile(filepath.Join(dir, "references", "old.md"), retired, 0o644)
	setManifestHash(t, dir, "references/old.md", hash(retired))
	r, _ := Install(dir, "1.0.0")
	if actions(r)["references/old.md"] != Removed {
		t.Fatalf("result: %+v", r.Files)
	}
	if _, err := os.Stat(filepath.Join(dir, "references", "old.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("retired file should be removed")
	}
}

// U-12: ParseMeta reads CRLF files and ignores the body.
func TestU12ParseMeta(t *testing.T) {
	m := ParseMeta([]byte("---\r\nname: x\r\nmetadata:\r\n  version: \"2.0.1\"\r\n  min_app_version: '1.4.0'\r\n---\r\nversion: 9\r\n"))
	if m.Name != "x" || m.Version != "2.0.1" || m.MinAppVersion != "1.4.0" {
		t.Fatalf("%+v", m)
	}
	if ExpandHome("~/a/b", "/h") != filepath.Join("/h", "a", "b") || ExpandHome("rel/p", "/h") != filepath.FromSlash("rel/p") {
		t.Fatal("ExpandHome")
	}
}
