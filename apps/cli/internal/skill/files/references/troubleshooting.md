# `agb doctor` explained

`agb doctor` prints one line per check: `ok`, `warn`, or `fail`, the check's name, and what it
found. A `hint:` line follows each problem. It exits with code 1 if any check fails.

| Check | `fail` / `warn` means | Fix |
|---|---|---|
| `agb on PATH` | `agb` isn't on `PATH`, or `PATH` finds a different copy than the one you ran | Add the right folder to `PATH` (see `install.md`), or remove the old copy |
| `browser` | No discovery file: the app isn't running. Or the file exists but the gateway doesn't answer (the app crashed) | Start, or restart, Agentic Browser |
| `discovery file` | `gateway.json` can be read by other users (macOS/Linux) | `chmod 600` the file, then restart the browser |
| `versions` | The CLI, app, and protocol versions don't match | Use the `agb` that came with the app; update both together |
| `skill: <folder>` | The skill isn't installed there, is older than this `agb`, or you edited `SKILL.md` (a `SKILL.md.new` is waiting) | `agb skill install`; for edits, compare `SKILL.md` with `SKILL.md.new` and keep what you want |
| `agents` | Lists the agents found on this computer and which skill folder each one reads | Informational |

## Skill folders

| Agent | Reads the skill from |
|---|---|
| Claude Code | `~/.claude/skills/agentic-browser/` |
| Codex CLI, Gemini CLI, Cursor, and other Agent Skills tools | `~/.agents/skills/agentic-browser/` |

Cursor reads both folders, so it may list the skill twice; both copies are identical.
Project installs (`agb skill install --project`) use `.claude/skills/` and `.agents/skills/`
in the current directory.

`agb skill install` never overwrites a `SKILL.md` you edited. It writes the new version next
to it as `SKILL.md.new`. `agb skill uninstall` removes only files `agb` wrote and you didn't
change.
