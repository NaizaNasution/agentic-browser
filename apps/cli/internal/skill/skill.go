// Package skill holds the skill package that agb installs into agents' skill folders, and the
// guide `agb skill` prints when the browser isn't running (docs/SPEC.md §13).
//
// The files under files/ are a copy of packages/skill, made by scripts/sync-skill.mjs.
// Edit packages/skill, then run `npm run codegen`.
package skill

import (
	"bufio"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"strings"
)

//go:embed files
var files embed.FS

// Name is the skill's folder name and its `name:` in SKILL.md.
const Name = "agentic-browser"

// GuideEnd is the guide's last line. Agents check for it to know the output wasn't cut off.
const GuideEnd = "[agb:skill] end of guide"

func read(name string) []byte {
	b, err := files.ReadFile("files/" + name)
	if err != nil {
		panic("skill: missing embedded file " + name) // a build problem; tests catch it
	}
	return b
}

var placeholder = regexp.MustCompile(`\{\{(appVersion|protocol)\}\}`)

// Guide renders the guide template. Must match apps/browser/src/shared/skill-guide.ts (renderGuide).
func Guide(appVersion, protocol string) string {
	vars := map[string]string{"appVersion": appVersion, "protocol": protocol}
	text := strings.ReplaceAll(string(read("guide.md")), "\r\n", "\n")
	text = placeholder.ReplaceAllStringFunc(text, func(m string) string { return vars[m[2:len(m)-2]] })
	if !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	return text
}

// Meta is the version information in SKILL.md's frontmatter.
type Meta struct {
	Name          string `json:"name"`
	Version       string `json:"version"`
	MinAppVersion string `json:"minAppVersion"`
}

// ParseMeta reads name, metadata.version, and metadata.min_app_version from a SKILL.md.
// It understands only the flat frontmatter this package writes, not YAML in general.
func ParseMeta(skillMD []byte) Meta {
	var m Meta
	sc := bufio.NewScanner(strings.NewReader(strings.ReplaceAll(string(skillMD), "\r\n", "\n")))
	inFront := false
	for sc.Scan() {
		line := sc.Text()
		if strings.TrimSpace(line) == "---" {
			if inFront {
				break
			}
			inFront = true
			continue
		}
		if !inFront {
			continue
		}
		key, val, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok {
			continue
		}
		val = strings.Trim(strings.TrimSpace(val), `"'`)
		switch key {
		case "name":
			m.Name = val
		case "version":
			m.Version = val
		case "min_app_version":
			m.MinAppVersion = val
		}
	}
	return m
}

// Bundled is the metadata of the SKILL.md built into this agb.
func Bundled() Meta { return ParseMeta(read("SKILL.md")) }

// PackageFiles are the files installed into a skill folder, by slash-separated relative path.
func PackageFiles() map[string][]byte {
	out := map[string][]byte{"SKILL.md": read("SKILL.md")}
	_ = fs.WalkDir(files, "files/references", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && path.Ext(p) == ".md" {
			out[strings.TrimPrefix(p, "files/")] = read(strings.TrimPrefix(p, "files/"))
		}
		return nil
	})
	return out
}

// ---------- targets (skill-targets.json) ----------

// Folder is a skill folder that one or more agents read.
type Folder struct {
	ID      string `json:"id"`
	User    string `json:"user"`    // e.g. ~/.claude/skills
	Project string `json:"project"` // e.g. .claude/skills
	Always  bool   `json:"always"`  // written by a default install even if no agent that reads it is found
	Docs    string `json:"docs"`
}

// Agent is an agent tool agb knows how to find.
type Agent struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Folders []string `json:"folders"`
	Detect  struct {
		Dirs     []string `json:"dirs"`
		Commands []string `json:"commands"`
	} `json:"detect"`
	Docs    string `json:"docs"`
	Note    string `json:"note"`
	Checked string `json:"checked"`
}

// Targets is the parsed skill-targets.json.
type Targets struct {
	Schema  int      `json:"schema"`
	Skill   string   `json:"skill"`
	Folders []Folder `json:"folders"`
	Agents  []Agent  `json:"agents"`
}

// LoadTargets parses the bundled skill-targets.json.
func LoadTargets() (*Targets, error) {
	var t Targets
	if err := json.Unmarshal(read("skill-targets.json"), &t); err != nil {
		return nil, fmt.Errorf("skill-targets.json: %w", err)
	}
	if t.Schema != 1 {
		return nil, fmt.Errorf("skill-targets.json: unsupported schema %d", t.Schema)
	}
	return &t, nil
}

// Folder returns the folder with this ID.
func (t *Targets) Folder(id string) (Folder, bool) {
	for _, f := range t.Folders {
		if f.ID == id {
			return f, true
		}
	}
	return Folder{}, false
}

// AgentIDs lists the known agent IDs, for usage messages.
func (t *Targets) AgentIDs() []string {
	ids := make([]string, len(t.Agents))
	for i, a := range t.Agents {
		ids[i] = a.ID
	}
	return ids
}
