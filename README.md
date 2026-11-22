# Agentic Browser

A desktop browser that people and AI agents share. Agents (Claude Code, Codex, Cursor, …) drive it through an installed skill and the `agb` command-line tool, in their own Spaces, with human-like input and the human in control.

The full design is in [docs/SPEC.md](docs/SPEC.md).

## Status

**Milestone M0 (Foundations)** is done:

- Electron shell with tabs, an address bar (URL or search), back/forward/reload, and Chrome-style shortcuts
- Agent Gateway in a separate utility process: JSON-RPC 2.0 over a named pipe (Unix socket on macOS/Linux), with a loopback HTTP fallback, a per-launch token, and a discovery file
- `agb` CLI in Go with `version` and `status`
- Protocol schema as the single source of truth, generating TypeScript and Go types

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
| `npm test` | Codegen tests, app unit tests (URL handling, Gateway transports and auth), and CLI tests |
| `npm run test:e2e` | End-to-end tests that launch the real app (needs a desktop session) |
| `npm run codegen:check` | Fail if the generated protocol code is out of date |
| `npm run typecheck` | Type-check the app |
| `npm run codegen` | Regenerate protocol types after editing `packages/protocol/schema/protocol.json` |

With the browser running:

```
bin/agb version
bin/agb status
bin/agb --json status
```

Smoke test (throwaway profile, saves a screenshot and tab state, then quits):

```
cd apps/browser && npx electron . --smoke-test <output-dir>
```

Set `AGB_HOME` to run a second, isolated copy (its own pipe and `gateway.json`).

## Layout

```
apps/browser/        Electron app
  src/main/          window, tabs, menu, Gateway host
  src/gateway/       Agent Gateway (JSON-RPC dispatch, transports, discovery)
  src/preload/       shell-only preload (window.agb)
  src/renderer/      shell UI (React)
  test/              node:test suites
apps/cli/            agb CLI (Go)
packages/protocol/   protocol schema + generated TS types
scripts/             CLI build/test helpers
docs/SPEC.md         product and technical specification
```
