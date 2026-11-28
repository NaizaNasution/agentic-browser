# Milestone M3 (Skill and agents): Test Cases

| | |
|---|---|
| **Milestone** | M3: `SKILL.md`, `agb skill` guide, `skill install` for Claude Code, Codex, Cursor, Gemini; `agb doctor` ([SPEC §22](../SPEC.md#22-milestones)) |
| **Exit criterion** | Claude Code completes tasks from a fresh install with no extra instructions |
| **Result** | U, W, Y, Z: **all 37 automated cases pass**, and the M0 to M2 suites still pass (`npm test`: 89 app unit tests and every Go package; `npm run test:e2e`: 28 of 28, task suite 35 of 35). R (the exit criterion): **7 of 8 in both full runs; accepted.** Every task where the agent loaded the skill passed. R-08 fails because the agent never loads the skill, and it stays in the suite unchanged as a measure of when the skill gets picked (SPEC risk R4); see [R](#r-real-agent-eval-exit-criterion) |
| **Build under test** | App 0.1.0 · Electron 45.4.1 · protocol 1.0 · Windows 11 x64 |
| **Date** | 2026-11-28 |

Priorities and coverage labels are as in [M0-test-cases.md](M0-test-cases.md#how-to-read-this). M0 to M2 cases still apply.

## Summary

| Area | Cases | Auto | Manual | Gap |
|---|---|---|---|---|
| U. Skill package and installer (Go unit) | 12 | 12 | 0 | 0 |
| W. `agb skill`, `agb doctor`, `goto --snapshot` (stub gateway) | 12 | 12 | 0 | 0 |
| Y. Agent ID detection (Go unit) | 4 | 4 | 0 | 0 |
| Z. App side: `gateway.guide`, navigation snapshots, end to end | 9 | 9 | 0 | 0 |
| R. Real-agent eval with Claude Code (exit criterion) | 8 | 8 | 0 | 0 |
| O. Manual checks | 5 | 0 | 5 | 0 |
| **Total** | **50** | **45** | **5** | **0** |

---

## U. Skill package and installer

`apps/cli/internal/skill/skill_test.go`. The package lives in `packages/skill` and is embedded into `agb` (a copy in `apps/cli/internal/skill/files`, kept current by `npm run codegen` and checked in CI by `npm run codegen:check`).

| ID | P | Test case | Expected result |
|---|---|---|---|
| U-01 | P0 | Guide rendering | Version and protocol filled in; no `{{` left; no CR characters; ends with `[agb:skill] end of guide`; about 2–3k tokens (§13.4) |
| U-02 | P0 | `SKILL.md` frontmatter | `name` is `agentic-browser`, matches the folder, lowercase letters, numbers, and hyphens only (Cursor's rule); has a description, `version`, `min_app_version`; the bootstrap text and ground rules are there; every file it points to ships |
| U-03 | P0 | Embedded copy is current | Every file in `packages/skill` is byte-identical in the embedded copy |
| U-04 | P1 | `skill-targets.json` | Has Claude Code, Codex, Cursor, Gemini; every agent has folders that exist and a "checked" date |
| U-05 | P0 | Which folders an install writes (§13.3) | Detected by folder or by command on PATH; nothing found still writes `~/.agents/skills`; `--agent claude-code` writes only `~/.claude/skills`; `codex`, `gemini` only `~/.agents/skills`; `all` both; an unknown agent is an error listing the valid ones; `--project` uses `.claude/skills` and `.agents/skills` in the project; `--path` uses that folder |
| U-06 | P0 | Fresh install, then again | Every file created, with a manifest (skill version, agb version, hashes); the second install changes nothing |
| U-07 | P0 | Updating an older install | Files agb wrote earlier are replaced with the new version |
| U-08 | P0 | Edited `SKILL.md` (§13.3) | Never overwritten; the new version goes to `SKILL.md.new`; still counted as edited on later installs; when the user copies the new version in, the next install removes `.new` |
| U-09 | P0 | A `SKILL.md` agb didn't write | Left alone (`.new` written); uninstall removes agb's other files but not that one |
| U-10 | P0 | Uninstall | Removes only agb's unchanged files and empty folders; keeps edited files and files agb didn't write; nothing installed is not an error |
| U-11 | P1 | Retired files | A file an older version installed and this one doesn't ship is removed if unchanged |
| U-12 | P2 | Parsing | Frontmatter with CRLF and quotes; the body is ignored; `~/` expands to the home folder |

## W. CLI commands

`apps/cli/skillcmd_test.go`, against the stub gateway, with a temporary home folder.

| ID | P | Test case | Expected result |
|---|---|---|---|
| W-01 | P0 | `agb skill` with the browser down | Prints `note: Agentic Browser is not running, so this is the guide built into agb …`, then the guide with agb's version, ending with the end marker; exit 0 |
| W-02 | P0 | `agb skill` with the browser up | Prints the app's guide exactly (it matches the running version); if the app's version differs from agb's, a note says so and the app's guide still wins |
| W-03 | P1 | Browser too old for `gateway.guide` | agb's copy, with a note that the browser is older |
| W-04 | P1 | `agb --json skill` | `source`, `appVersion`, `protocol`, `text`, `note` |
| W-05 | P0 | `agb skill install` with Claude Code and Gemini CLI found | `installed: …/.claude/skills/agentic-browser (Claude Code)` and `installed: …/.agents/skills/agentic-browser (Gemini CLI)`; `agents found: Claude Code, Gemini CLI (not found: …)`; hint to start a new session; nothing in `~/.codex/skills`; run again: `up to date` twice, no hint |
| W-06 | P0 | `--agent` | Picks the folders (`codex` writes only the shared folder); `AGB_AGENT` doesn't; comma lists work; an unknown agent exits 2 |
| W-07 | P1 | `--project`, `--path` | Project install writes both folders in the current directory; `--path` writes `<dir>/agentic-browser` (`custom folder`); both together exit 2 |
| W-08 | P0 | `agb skill uninstall` | Removes the skill everywhere agb put it; an edited `SKILL.md` stays and is reported (`removed (except your changes)`, `kept SKILL.md`) |
| W-09 | P0 | `agb doctor` with nothing set up | `fail agb on PATH`, `fail browser: not running` with `hint: start Agentic Browser`, `warn skill: …: not installed (read by Claude Code)`, `ok agents: found Claude Code …`; exit 1; `--json` gives the same checks |
| W-10 | P0 | `agb doctor` with everything set up | `agb on PATH`, `browser`, `versions`, `agent ID`, and the skill folders are `ok`; exit 0. An edited `SKILL.md` with a waiting `.new` is a warning (exit 0); a different app version is a `versions` warning |
| W-11 | P0 | `goto --snapshot`, `back --snapshot` | Sends `snapshot: true`; prints the `ok:` line, then the snapshot between the untrusted-content lines; without the flag, no snapshot is requested |
| W-12 | P2 | Usage errors | `skill publish`, `skill install extra`, `doctor now` exit 2 |

## Y. Agent ID detection

`apps/cli/internal/agentid/agentid_test.go` (SPEC §8.4).

| ID | P | Test case | Expected result |
|---|---|---|---|
| Y-01 | P0 | Environment markers | `CLAUDECODE=1` gives `claude-code` (even with `codex` as a parent process); `GEMINI_CLI=1` gives `gemini`; other values are ignored |
| Y-02 | P0 | Parent processes | The nearest known name wins; paths, case, and `.exe` don't matter (`…\claude.exe`, `/opt/homebrew/bin/codex`, `Cursor-Agent`) |
| Y-03 | P1 | Nothing known | `""` (the gateway then uses `unknown`); ancestors beyond 12 levels are not looked at |
| Y-04 | P1 | The real process walk | Finds at least one parent on this platform, with no empty names |

## Z. App side and end to end

`apps/browser/test/skill-guide.test.ts` (Z-01 to Z-03), `test/agent-service.test.ts` (Z-04, Z-05), and `test/e2e/skill.e2e.ts` against the real app and `bin/agb` (Z-06 to Z-09).

| ID | P | Test case | Expected result |
|---|---|---|---|
| Z-01 | P0 | `gateway.guide` | Returns the app version, protocol, and the guide for that version, ending with the end marker |
| Z-02 | P0 | `gateway.guide` without the token | `E_UNAUTHORIZED` |
| Z-03 | P1 | Same template, same rendering | The app's bundled template is `packages/skill/guide.md`, rendered like agb renders it; CRLF input renders like LF |
| Z-04 | P0 | `nav.goto` / `nav.back` with `snapshot` | The result has an interactive snapshot of the new page (with its location); without the flag, none is taken |
| Z-05 | P0 | Navigation that opens a dialog | No snapshot (the page is blocked); the dialog is reported |
| Z-06 | P0 | `agb skill` against the real app | The app's guide (no fallback note), with the app's version, ending with the end marker; `--json` says `source: app` |
| Z-07 | P0 | `agb skill install`, then `agb doctor` | Installs into a temporary home with `~/.claude`; doctor: `agb on PATH`, `browser`, `versions`, and both skill folders `ok`; exit 0 |
| Z-08 | P0 | `agb goto <url> --snapshot` | One call prints the header, `ok: HTTP 200 …`, and the page's refs (`textbox "Search" @eN`, `button "Find" @eN`) |
| Z-09 | P0 | Agent ID from the environment, end to end | With `CLAUDECODE=1` and no `AGB_AGENT`, the new Space belongs to `claude-code`: listed for `claude-code`, not for another agent |

## R. Real-agent eval (exit criterion)

`npm run eval:agent` (`evals/agent/eval.ts`). Opt-in: it uses the Claude account of whoever runs it, so it never runs in `npm test` or CI.

How it works:
- **Fresh install.** For each task, a new empty project folder gets `agb skill install --project --agent claude-code`, and nothing else.
- **One headless session per task.** Claude Code (`claude -p`) gets a plain task prompt that mentions neither the skill nor `agb`.
- **A clean Claude Code.** It runs with:
  - `--setting-sources project`, so the user's own settings, CLAUDE.md, hooks, and skills are not loaded;
  - no MCP servers;
  - `WebFetch` and `WebSearch` disallowed;
  - permission only for `agb` commands and reading files.
- **The real app.** A real Agentic Browser runs with a temporary profile, home, and download folder.
- **Checked server-side.** Each check reads what the M2 fixture app's server received, not what the agent says it did.
- **What it records:** whether the agent loaded the skill and ran `agb skill`, `agb` calls, other tools tried, turns, tokens, cost, and a full transcript per task, in `test-results/m3-agent-eval/`.

| ID | P | Task prompt (abridged) | Passes when |
|---|---|---|---|
| R-01 | P0 | Create an account on /signup: Ada Lovelace, ada@example.com, Kenya, Pro plan, accept the terms | The server got that sign-up with every value right |
| R-02 | P0 | Put a Lamp and a Desk in the cart and place the order | The server got an order for exactly Desk and Lamp (the agent had to accept a `confirm()`) |
| R-03 | P0 | Add "buy milk" and "call mom" to the to-do list, tick off "buy milk" | Server state: buy milk done, call mom not done |
| R-04 | P0 | Continue past /modal to the offer page and report its heading | The offer page was loaded (the cookie banner was dealt with) and the answer says "The offer" |
| R-05 | P0 | Upload cv.txt from this folder using /upload | The server got cv.txt, 27 bytes |
| R-06 | P1 | Open the Edit page for Japan in the paginated table | The server got the Japan edit page request (Japan is on page 2) |
| R-07 | P1 | Use the country search to open Norway's page | The server got Norway's page request (through the suggestions) |
| R-08 | P1 | Download the CSV report and say how many visits Kenya had | report.csv is in the Space's download folder and the answer says 42 |

**First run (R-01 and R-02 only, Claude Code 2.1.332):**
- Both passed, about 25 s, 5–6 `agb` calls, and $0.15 each.
- In both, the agent loaded the skill by itself from the plain prompt and ran `agb skill` before anything else.
- **Found:** on Windows, Claude Code's first call (`agb skill`) went through its PowerShell tool, which `SKILL.md`'s `allowed-tools: Bash(agb:*)` didn't cover. The call needed approval, so the agent retried in Bash, wasting a turn; in an interactive session it would have been a permission prompt.
- **Fixed:** `allowed-tools: Bash(agb:*), PowerShell(agb:*)`. The eval allows both too, and counts `agb` calls in either shell.

**Full run (R-01 to R-08, after the fix):** 7 of 8 passed (87.5%), 38 `agb` calls, 69 turns, $1.14, about 3.5 minutes.

- **The PowerShell fix worked:** `agb skill` and `agb goto` ran in PowerShell without approval.
- **Found, PowerShell splatting:** in PowerShell, `@e5` is splatting syntax (it expands a variable named `e5`), so Claude Code's PowerShell tool refuses any command with a ref. It happened in 6 of the 7 passing tasks. Each time the agent recovered, by switching to Bash or quoting the ref (`'@e8'`), at the cost of one turn. `agb` already accepts `e5` and `5` as refs.
- **Found, R-08 failed on triggering:** the agent read "Download the CSV report from …/export" as a file download, and never loaded the skill. It tried `curl` and `Invoke-WebRequest` six times (all needed approval, which the eval doesn't give), then asked the user. The skill's description says nothing about downloading or uploading files. R-05 started the same way (`curl` first), then loaded the skill and passed.

**Second full run (after a PowerShell ref note in the guide, and downloads and uploads in the skill's description):** 7 of 8 again (87.5%), 38 `agb` calls, 66 turns, $1.07.

- **The PowerShell note worked.** Every agent wrote refs as `e5` in PowerShell, and no command was refused for splatting.
- **Tasks got shorter.** 7–9 turns instead of 8–11. R-05 loaded the skill at once instead of trying `curl` first.
- **One refusal was left.** Claude Code's PowerShell tool wants approval for `agb` inside an `if ($?) { … }` chain (R-01). The agent then ran the steps one by one.
- **R-08 still failed the same way.** The agent took `…/export` to be the CSV file itself, tried `curl` and `Invoke-WebRequest` (both refused), and asked the user. It never considered the browser. The wording change didn't reach it, because it never saw this as a web-page task.

**Decision (2026-11-28):** M3 is accepted at 7 of 8. R-08 stays unchanged: rewording its prompt would make it pass, but would stop it measuring whether agents pick the skill for tasks that look like plain downloads (SPEC risk R4, user story US19). Later changes to the skill's description are measured against it.

## O. Manual checks

| ID | P | Check | How |
|---|---|---|---|
| O-01 | P0 | The skill triggers in an interactive Claude Code session | `agb skill install`, start a new session, ask "open example.com in the browser and tell me the title"; Claude loads the skill, runs `agb skill`, then `agb goto` |
| O-02 | P1 | Codex CLI and Gemini CLI see the skill | After `agb skill install`, the skill is listed (`/skills` in Gemini CLI; Codex's skill list) |
| O-03 | P1 | Cursor lists it (possibly twice) | Cursor reads `~/.claude/skills` and `~/.agents/skills`; both copies are identical |
| O-04 | P1 | `agb doctor` reads well | Every problem line has a hint that says what to do |
| O-05 | P2 | macOS and Linux | `agb doctor` discovery-file check (mode 600), the process walk (`ps` on macOS, `/proc` on Linux) |
