# Agentic Browser

A desktop browser that people and AI agents share. Agents (Claude Code, Codex, Cursor, …) drive it through an installed skill and the `agb` command-line tool, in their own Spaces, with human-like input and the human in control.

The full design is in [docs/SPEC.md](docs/SPEC.md).

## Status

**Milestone M1 (Basic control)** is done: an agent can open a page and screenshot it without touching the human's tabs.

- Agent Spaces in **isolated** mode: each Space has its own in-memory storage, and each agent tab is a hidden window that never takes focus. Spaces belong to one agent; the default Space is the agent's most recent one in the current directory.
- `agb goto`, `back`, `forward`, `reload`, `text` (readable Markdown, with hidden text left out), `capture` (viewport or full page, PNG or JPEG), `tab new|list|select|close|info`, `space new|list|info|close|show|hide`
- The Gateway validates every request against the protocol schema; agents may open `http` and `https` URLs only
- Test cases: [docs/testing/M1-test-cases.md](docs/testing/M1-test-cases.md)

**Milestone M0 (Foundations)**: Electron shell with tabs and an address bar; Agent Gateway (JSON-RPC 2.0 over a named pipe or Unix socket, loopback HTTP fallback, per-launch token, discovery file); `agb version` and `status`; protocol schema generating TypeScript and Go types. Test cases: [docs/testing/M0-test-cases.md](docs/testing/M0-test-cases.md).

Next: **M2 Snapshot and actions** (refs, click, type).

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
| `npm run test:e2e` | End-to-end tests that launch the real app (needs a desktop session; run `npm run build:cli` first for the agent tests) |
| `npm run codegen:check` | Fail if the generated protocol code is out of date |
| `npm run typecheck` | Type-check the app |
| `npm run codegen` | Regenerate protocol types after editing `packages/protocol/schema/protocol.json` |

With the browser running:

```
bin/agb version
bin/agb status
bin/agb goto https://example.com      # starts an isolated agent Space
bin/agb text                          # readable text of the page
bin/agb capture -o page.png           # screenshot into the current directory
bin/agb tab list
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
  src/main/agent/    agent Spaces: service logic, Electron driver, readable-text extractor
  src/gateway/       Agent Gateway (JSON-RPC dispatch, schema validation, transports, discovery)
  src/preload/       shell-only preload (window.agb)
  src/renderer/      shell UI (React)
  test/              node:test suites
apps/cli/            agb CLI (Go)
packages/protocol/   protocol schema + generated TS types
scripts/             CLI build/test helpers
docs/SPEC.md         product and technical specification
docs/testing/        test cases per milestone
```
