# Agentic Browser

A desktop browser that people and AI agents share. Agents (Claude Code, Codex, Cursor, …) drive it through an installed skill and the `agb` command-line tool, in their own Spaces, with human-like input and the human in control.

The full design is in [docs/SPEC.md](docs/SPEC.md).

## Status

**Milestone M2 (Snapshot and actions)** is done: an agent can read a page as text with element refs and act on it. Exit criterion: 35 of 35 tasks on the fixture task suite (target 90%).

- `agb snapshot`: the page as compact text with refs (`button "Sign in" @e5`), covering shadow DOM and same- and cross-site iframes; passwords redacted; text people can't see left out; `--mode full`, `--scope`, `--max-tokens` (sections far from the viewport collapse), `--diff`
- `agb click`, `fill`, `type`, `press`, `select`, `check`/`uncheck`, `hover`, `scroll`, `upload`: real (trusted) input, after checking the element is visible, still, enabled, and not covered (the error names what covers it). Each action reports what changed on the page, tabs it opened, and downloads
- Refs survive re-renders (a replaced element is re-found) and never point at a different element after a navigation
- `agb wait`, `agb dialog list|accept|dismiss` (dialogs wait for the agent), `agb download list|wait` (downloads go to `~/Downloads/Agentic Browser/<agent>/<space>/`)
- Test cases: [docs/testing/M2-test-cases.md](docs/testing/M2-test-cases.md)

**Milestone M1 (Basic control)**: isolated agent Spaces whose windows never take focus; `goto`, `back`, `forward`, `reload`, `text`, `capture`, `tab …`, `space …`; schema-validated Gateway requests; `http`/`https` only. Test cases: [docs/testing/M1-test-cases.md](docs/testing/M1-test-cases.md).

**Milestone M0 (Foundations)**: Electron shell with tabs and an address bar; Agent Gateway (JSON-RPC 2.0 over a named pipe or Unix socket, loopback HTTP fallback, per-launch token, discovery file); `agb version` and `status`; protocol schema generating TypeScript and Go types. Test cases: [docs/testing/M0-test-cases.md](docs/testing/M0-test-cases.md).

Next: **M3 Skill and agents** (`SKILL.md`, `agb skill`, installing the skill for Claude Code and other agents).

## Requirements

- Node.js 22+
- Go 1.24+

## Commands

Run from the repository root:

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run build` | Generate protocol types, build the app, and build `bin/agb(.exe)` |
| `npm start` | Build and launch the browser |
| `npm test` | Codegen tests, app unit tests (URL handling, Gateway, agent Spaces), and CLI tests |
| `npm run test:e2e` | End-to-end tests that launch the real app, including the 35-task fixture suite (needs a desktop session; run `npm run build:cli` first for the agent tests) |
| `npm run codegen:check` | Fail if the generated protocol code is out of date |
| `npm run typecheck` | Type-check the app |
| `npm run codegen` | Regenerate protocol types after editing `packages/protocol/schema/protocol.json` |

With the browser running:

```
bin/agb version
bin/agb status
bin/agb goto https://example.com      # starts an isolated agent Space
bin/agb snapshot                      # the page as text with refs (@e1, @e2, …)
bin/agb click @e2                     # act on a ref; the result lists what changed
bin/agb fill @e5 "ana@example.com" --submit
bin/agb text                          # readable text of the page
bin/agb capture -o page.png           # screenshot into the current directory
bin/agb space close
```

Run `bin/agb help` for every command. Set `AGB_AGENT` (or `--agent`) to name the agent; each agent sees only its own Spaces.

Smoke test (throwaway profile, saves a screenshot and tab state, then quits):

```
cd apps/browser && npx electron . --smoke-test <output-dir>
```

Set `AGB_HOME` to run a second, isolated copy (its own pipe and `gateway.json`).

## Layout

```
apps/browser/        Electron app
  src/main/          window, tabs, menu, Gateway host
  src/main/agent/    agent Spaces: service logic, Electron driver, actions, keys, readable text
    snapshot/        snapshot engine: layout facts, tree and text format, refs, diffs
  src/gateway/       Agent Gateway (JSON-RPC dispatch, schema validation, transports, discovery)
  src/preload/       shell-only preload (window.agb)
  src/renderer/      shell UI (React)
  test/              node:test suites (unit, e2e/, fixtures/)
  test/tasks/        fixture web app for the task suite
apps/cli/            agb CLI (Go)
packages/protocol/   protocol schema + generated TS types
scripts/             CLI build/test helpers
docs/SPEC.md         product and technical specification
docs/testing/        test cases per milestone
```
