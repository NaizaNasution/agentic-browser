package skill

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
)

// ManifestFile records what agb wrote into a skill folder, so it can tell your edits from its own
// files (§13.3: never overwrite a SKILL.md the user has edited; uninstall removes only what agb wrote).
const ManifestFile = ".agb-skill.json"

// Manifest is the content of ManifestFile.
type Manifest struct {
	Skill      string            `json:"skill"`
	Version    string            `json:"version"`
	AgbVersion string            `json:"agbVersion"`
	Files      map[string]string `json:"files"` // relative path -> sha256 of the content agb wrote
}

// Env is what detection and planning look at, so tests can fake it.
type Env struct {
	Home     string
	LookPath func(name string) (string, error)
}

// ExpandHome turns a leading ~/ into the home directory.
func ExpandHome(p, home string) string {
	if p == "~" {
		return home
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(home, filepath.FromSlash(p[2:]))
	}
	return filepath.FromSlash(p)
}

// Found reports whether the agent seems to be installed, and why.
func (a Agent) Found(env Env) (bool, string) {
	for _, d := range a.Detect.Dirs {
		if st, err := os.Stat(ExpandHome(d, env.Home)); err == nil && st.IsDir() {
			return true, d + " exists"
		}
	}
	if env.LookPath != nil {
		for _, c := range a.Detect.Commands {
			if p, err := env.LookPath(c); err == nil {
				return true, c + " on PATH (" + p + ")"
			}
		}
	}
	return false, ""
}

// Selection says where `agb skill install` should write.
type Selection struct {
	Agents  []string // agent IDs, or "all"; empty means the agents found on this computer
	Project string   // project directory for a project install; empty for a user install
	Path    string   // an explicit skills directory; overrides Agents and Project
}

// Destination is one skill folder to write.
type Destination struct {
	Folder string   // folder ID from skill-targets.json, or "custom"
	Dir    string   // full path, ending in /agentic-browser
	Agents []string // names of the agents (in this selection) that read it
}

// Plan works out the skill folders for a selection.
func (t *Targets) Plan(sel Selection, env Env) ([]Destination, error) {
	if sel.Path != "" {
		abs, err := filepath.Abs(ExpandHome(sel.Path, env.Home))
		if err != nil {
			return nil, err
		}
		return []Destination{{Folder: "custom", Dir: filepath.Join(abs, Name)}}, nil
	}

	var agents []Agent
	explicit := false
	switch {
	case len(sel.Agents) == 0:
		for _, a := range t.Agents {
			if ok, _ := a.Found(env); ok {
				agents = append(agents, a)
			}
		}
	case slices.Contains(sel.Agents, "all"):
		agents = t.Agents
	default:
		explicit = true
		for _, id := range sel.Agents {
			i := slices.IndexFunc(t.Agents, func(a Agent) bool { return a.ID == id })
			if i < 0 {
				return nil, fmt.Errorf("unknown agent %q (use %s, or all)", id, strings.Join(t.AgentIDs(), ", "))
			}
			agents = append(agents, t.Agents[i])
		}
	}

	var out []Destination
	for _, f := range t.Folders {
		var names []string
		for _, a := range agents {
			if slices.Contains(a.Folders, f.ID) {
				names = append(names, a.Name)
			}
		}
		if len(names) == 0 && !(f.Always && !explicit) {
			continue
		}
		base := ExpandHome(f.User, env.Home)
		if sel.Project != "" {
			base = filepath.Join(sel.Project, filepath.FromSlash(f.Project))
		}
		out = append(out, Destination{Folder: f.ID, Dir: filepath.Join(base, Name), Agents: names})
	}
	return out, nil
}

// ---------- install, uninstall, inspect ----------

// File actions reported by Install and Uninstall.
const (
	Created   = "created"
	Updated   = "updated"
	Unchanged = "unchanged"
	KeptEdits = "kept your edits" // the new version was written next to it as <file>.new
	Removed   = "removed"
	Kept      = "kept" // uninstall left a file agb didn't write, or one you changed
)

// FileResult is what happened to one file.
type FileResult struct {
	Path   string `json:"path"` // relative, slash-separated
	Action string `json:"action"`
}

// Result is what happened in one skill folder.
type Result struct {
	Dir   string       `json:"dir"`
	Files []FileResult `json:"files"`
}

// Changed reports whether anything was written or removed.
func (r Result) Changed() bool {
	for _, f := range r.Files {
		if f.Action != Unchanged && f.Action != Kept {
			return true
		}
	}
	return false
}

// Edited lists files left alone because you changed them.
func (r Result) Edited() []string {
	var out []string
	for _, f := range r.Files {
		if f.Action == KeptEdits || f.Action == Kept {
			out = append(out, f.Path)
		}
	}
	return out
}

func hash(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func readManifest(dir string) (*Manifest, error) {
	b, err := os.ReadFile(filepath.Join(dir, ManifestFile))
	if err != nil {
		return nil, err
	}
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("%s: %w", filepath.Join(dir, ManifestFile), err)
	}
	if m.Files == nil {
		m.Files = map[string]string{}
	}
	return &m, nil
}

func writeFile(p string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp := p + ".agb-tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// Install writes the bundled skill into dir (…/agentic-browser). Files you edited are kept, and
// the new version goes next to them as <file>.new.
func Install(dir, agbVersion string) (Result, error) {
	res := Result{Dir: dir}
	old, err := readManifest(dir)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return res, err
	}
	if old == nil {
		old = &Manifest{Files: map[string]string{}}
	}
	meta := Bundled()
	next := &Manifest{Skill: Name, Version: meta.Version, AgbVersion: agbVersion, Files: map[string]string{}}

	pkg := PackageFiles()
	names := make([]string, 0, len(pkg))
	for n := range pkg {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, rel := range names {
		content := pkg[rel]
		want := hash(content)
		p := filepath.Join(dir, filepath.FromSlash(rel))
		action := Created
		cur, err := os.ReadFile(p)
		switch {
		case errors.Is(err, fs.ErrNotExist):
		case err != nil:
			return res, err
		case hash(cur) == want:
			action = Unchanged
		case old.Files[rel] != "" && hash(cur) == old.Files[rel]:
			action = Updated // still the version agb wrote last time
		default:
			action = KeptEdits
		}
		switch action {
		case Created, Updated:
			if err := writeFile(p, content); err != nil {
				return res, err
			}
			next.Files[rel] = want
		case Unchanged:
			next.Files[rel] = want
		case KeptEdits:
			if err := writeFile(p+".new", content); err != nil {
				return res, err
			}
			if h := old.Files[rel]; h != "" {
				next.Files[rel] = h // keep the hash agb wrote, so the file still counts as edited
			}
		}
		if action != KeptEdits {
			removeIfSame(p+".new", content) // an old .new that is now the installed version
		}
		res.Files = append(res.Files, FileResult{Path: rel, Action: action})
	}

	// Files an older version installed that this version no longer ships.
	for rel, h := range old.Files {
		if _, ok := pkg[rel]; ok {
			continue
		}
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if cur, err := os.ReadFile(p); err == nil {
			if hash(cur) == h {
				_ = os.Remove(p)
				res.Files = append(res.Files, FileResult{Path: rel, Action: Removed})
			} else {
				res.Files = append(res.Files, FileResult{Path: rel, Action: Kept})
			}
		}
	}

	b, _ := json.MarshalIndent(next, "", "  ")
	if err := writeFile(filepath.Join(dir, ManifestFile), append(b, '\n')); err != nil {
		return res, err
	}
	return res, nil
}

func removeIfSame(p string, content []byte) {
	if cur, err := os.ReadFile(p); err == nil && hash(cur) == hash(content) {
		_ = os.Remove(p)
	}
}

// Uninstall removes the files agb wrote into dir and you didn't change, then the folder if it is empty.
func Uninstall(dir string) (Result, error) {
	res := Result{Dir: dir}
	m, err := readManifest(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return res, nil // nothing agb wrote
	}
	if err != nil {
		return res, err
	}
	rels := make([]string, 0, len(m.Files))
	for rel := range m.Files {
		rels = append(rels, rel)
	}
	sort.Strings(rels)
	for _, rel := range rels {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		cur, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		if hash(cur) == m.Files[rel] {
			if err := os.Remove(p); err != nil {
				return res, err
			}
			res.Files = append(res.Files, FileResult{Path: rel, Action: Removed})
		} else {
			res.Files = append(res.Files, FileResult{Path: rel, Action: Kept})
		}
	}
	// .new files are always agb's.
	for rel := range PackageFiles() {
		if os.Remove(filepath.Join(dir, filepath.FromSlash(rel)+".new")) == nil {
			res.Files = append(res.Files, FileResult{Path: rel + ".new", Action: Removed})
		}
	}
	if err := os.Remove(filepath.Join(dir, ManifestFile)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return res, err
	}
	removeEmptyDirs(dir)
	return res, nil
}

func removeEmptyDirs(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			removeEmptyDirs(filepath.Join(dir, e.Name()))
		}
	}
	_ = os.Remove(dir) // fails if not empty, which is fine
}

// Status describes an installed skill folder, for `agb doctor`.
type Status struct {
	Dir       string   `json:"dir"`
	Installed bool     `json:"installed"`         // SKILL.md exists
	Ours      bool     `json:"ours"`              // agb wrote it (a manifest exists)
	Version   string   `json:"version,omitempty"` // from the installed SKILL.md
	Current   bool     `json:"current"`           // every file matches this agb's bundled skill
	Edited    []string `json:"edited,omitempty"`  // files changed since agb wrote them
	Pending   []string `json:"pending,omitempty"` // <file>.new waiting for you to review
	Missing   []string `json:"missing,omitempty"` // bundled files that aren't there
}

// Inspect reports the state of a skill folder without changing it.
func Inspect(dir string) Status {
	st := Status{Dir: dir}
	skillMD, err := os.ReadFile(filepath.Join(dir, "SKILL.md"))
	if err != nil {
		return st
	}
	st.Installed = true
	st.Version = ParseMeta(skillMD).Version
	m, err := readManifest(dir)
	st.Ours = err == nil
	st.Current = true
	pkg := PackageFiles()
	rels := make([]string, 0, len(pkg))
	for rel := range pkg {
		rels = append(rels, rel)
	}
	sort.Strings(rels)
	for _, rel := range rels {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		cur, err := os.ReadFile(p)
		if err != nil {
			st.Missing = append(st.Missing, rel)
			st.Current = false
			continue
		}
		h := hash(cur)
		if h != hash(pkg[rel]) {
			st.Current = false
		}
		if m != nil && m.Files[rel] != "" && h != m.Files[rel] {
			st.Edited = append(st.Edited, rel)
		}
		if _, err := os.Stat(p + ".new"); err == nil {
			st.Pending = append(st.Pending, rel+".new")
		}
	}
	return st
}
