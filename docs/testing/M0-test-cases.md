# Milestone M0 (Foundations): Test Cases

| | |
|---|---|
| **Milestone** | M0: monorepo, Electron shell with tabs and address bar, Go CLI skeleton, protocol codegen ([SPEC §22](../SPEC.md#22-milestones)) |
| **Exit criterion** | `agb version` talks to a running app |
| **Build under test** | App 0.1.0 · Electron 45.4.1 · protocol 1.0 · Windows 11 x64 |
| **Date** | 2026-11-22 |

## How to read this

- **Priority**: **P0** = blocks the milestone exit criterion or is a security boundary; **P1** = core behavior; **P2** = polish and edge cases.
- **Coverage**:
  - **Auto** = covered by an existing automated test (the test name is given).
  - **Manual** = run by hand.
  - **Gap** = should be automated but isn't yet.
- **Setup** for manual cases: `npm install && npm run build`, then `npm start`. `agb` means `bin/agb.exe`. Automated cases run with `npm test` and `npm run test:e2e` (see [Automated test suites](#automated-test-suites)).
- For tests that need an isolated copy of the app, set `AGB_HOME` to a temporary folder and pass `--smoke-test <dir>` or start Electron from `apps/browser` with `npx electron .`.

## Summary

| Area | Cases | Auto | Manual | Gap |
|---|---|---|---|---|
| A. Build and setup | 7 | 2 | 5 | 0 |
| B. Protocol codegen | 5 | 4 | 1 | 0 |
| C. Shell: launch and window | 8 | 3 | 5 | 0 |
| D. Shell: tabs | 10 | 3 | 7 | 0 |
| E. Shell: address bar and navigation | 16 | 9 | 7 | 0 |
| F. Shell: security | 6 | 2 | 4 | 0 |
| G. Gateway: lifecycle and discovery | 10 | 7 | 3 | 0 |
| H. Gateway: pipe protocol | 10 | 10 | 0 | 0 |
| I. Gateway: HTTP fallback | 8 | 7 | 1 | 0 |
| J. CLI: commands and output | 13 | 9 | 4 | 0 |
| K. CLI: connection and errors | 9 | 8 | 1 | 0 |
| L. Cross-platform (macOS/Linux) | 4 | 1 | 3 | 0 |
| M. Performance (M0 baselines) | 3 | 0 | 3 | 0 |
| **Total** | **109** | **65** | **44** | **0** |

---

## A. Build and setup

| ID | P | Test case | Expected result | Coverage |
|---|---|---|---|---|
| A-01 | P0 | Fresh clone: `npm install` at the repo root | Installs without errors; Electron binary downloaded; `npx electron --version` prints 45.4.1 | Manual |
| A-02 | P0 | `npm run build` | Runs codegen, builds the app into `apps/browser/dist/{main,gateway,preload,renderer}`, writes `bin/agb.exe`; exit 0 | Manual |
| A-03 | P0 | `npm run typecheck` | No TypeScript errors | Auto (CI): `npm run typecheck` in `.github/workflows/ci.yml` |
| A-04 | P0 | `npm test` | App tests (15) and Go vet + tests all pass; exit 0 | Auto (CI): `npm test` in `.github/workflows/ci.yml` |
| A-05 | P1 | `npm run build:cli` stamps the version: run `bin/agb version` | First line shows `agb 0.1.0`, matching `apps/browser/package.json` | Manual |
| A-06 | P1 | `npm run build:cli` with Go not on PATH but installed at `C:\Program Files\Go` | Build still finds Go and succeeds | Manual |
| A-07 | P2 | `npm run build:cli` with Go not installed at all | Fails with "go not found. Install Go 1.24+ …" and a non-zero exit | Manual (needs a machine without Go) |

## B. Protocol codegen

| ID | P | Test case | Expected result | Coverage |
|---|---|---|---|---|
| B-01 | P0 | `npm run codegen` | Writes `packages/protocol/gen/ts/index.ts` and `apps/cli/internal/protocol/protocol_gen.go`; both start with "DO NOT EDIT" | Manual |
| B-02 | P0 | Generated files are up to date: run codegen + `gofmt`, then `git diff --exit-code` on the generated files | No diff (checked-in code matches the schema) | Auto: `B-02: checked-in generated files match the schema`; CI runs `npm run codegen:check` |
| B-03 | P1 | Codegen is deterministic: run it twice | Byte-identical output | Auto: `B-03: codegen is deterministic` |
| B-04 | P1 | Add a new method and type to `protocol.json`, run codegen | New TS interface and `Methods` entry; new Go struct with correct `json` tags and `omitempty` on optional fields; `MethodXxx` constant | Auto: `B-04: a new method and type appear in both outputs` |
| B-05 | P2 | Schema uses an unsupported type (e.g. `"type": "null"`) | Codegen fails with "unsupported type …"; no partial files written | Auto: `B-05: an unsupported type fails and writes nothing` |

## C. Shell: launch and window

| ID | P | Test case | Expected result | Coverage |
|---|---|---|---|---|
| C-01 | P0 | `npm start` | One window titled "New Tab - Agentic Browser" (or "Agentic Browser"), one blank tab, address bar focused | Manual |
| C-02 | P0 | Smoke test: `npx electron . --smoke-test <dir>` with `AGB_HOME=<dir>/agb-home` | Exit 0; `<dir>/shell.png` shows tab strip and toolbar; `state.json` has 2 tabs, titles "New Tab" and "Smoke test page", active `t_2` | Auto: `--smoke-test` (run manually today) |
| C-03 | P1 | Launch with a URL argument: `npx electron . https://example.com` | Starts with that page instead of a blank tab; address bar not focused | Manual |
| C-04 | P1 | Resize the window to 480×320 (the minimum) and back | Toolbar stays 80 px tall; page view fills the rest with no gap or overlap; no horizontal scrollbar in the shell | Manual |
| C-05 | P1 | Start a second instance while one is running | Second process exits at once; the first window is restored (if minimized) and focused; still only one gateway | Auto (e2e): `C-05: a second launch with the same profile exits…` |
| C-06 | P1 | Close the window (×) on Windows | App quits; gateway process ends; `gateway.json` is deleted | Auto (e2e): `D-06 / C-06 / G-04: closing the last tab quits the app…` |
| C-07 | P2 | OS dark mode on, then light mode | Shell colors follow the OS theme | Manual |
| C-08 | P2 | Menu bar is hidden; press `Alt` | Menu bar appears with File / Edit / View / History; shortcuts work whether it's shown or not | Manual (native menu bar can't be driven over CDP) |

## D. Shell: tabs

| ID | P | Test case | Expected result | Coverage |
|---|---|---|---|---|
| D-01 | P0 | Click **+** | New blank tab opens to the right, becomes active, address bar focused | Manual |
| D-02 | P0 | `Ctrl+T` | Same as D-01 | Manual |
| D-03 | P0 | Click a tab's **×** | That tab closes; the tab to its right (or the last tab) becomes active | Manual |
| D-04 | P1 | `Ctrl+W` | Active tab closes | Manual |
| D-05 | P1 | Middle-click a tab | Tab closes | Manual |
| D-06 | P1 | Close the last tab | Window closes and (on Windows) the app quits | Auto (e2e): `D-06 / C-06 / G-04: closing the last tab quits the app…` |
| D-07 | P1 | With 3 tabs, `Ctrl+Tab` ×3, then `Ctrl+Shift+Tab` | Cycles forward through all tabs and wraps around; then goes back one | Manual |
| D-08 | P1 | A page opens a link with `target="_blank"` (or `window.open`) to an `https:` URL | Opens as a new tab right after the opener, and becomes active; no new window | Auto (e2e): `D-08: a target=_blank link opens a new tab…` |
| D-09 | P2 | A page opens a `mailto:` link in a new window | Hands off to the OS mail client; no tab is created | Manual |
| D-10 | P2 | Blank tab title | Shows "New Tab" (not "about:blank") | Auto: `--smoke-test` state check |

## E. Shell: address bar and navigation

| ID | P | Test case | Expected result | Coverage |
|---|---|---|---|---|
| E-01 | P0 | Type `https://example.com/a?b=1`, Enter | Loads exactly that URL | Auto: `full URLs are kept`; typing in the bar: e2e `E-01 / E-09: typing in the address bar…` |
| E-02 | P0 | Type `example.com`, Enter | Loads `https://example.com/` | Auto: `host-like input gets a scheme` |
| E-03 | P0 | Type `localhost:5173`, `127.0.0.1:8080/x`, `myapp.test` | Loads over `http://` (local hosts) | Auto: `host-like input gets a scheme` |
| E-04 | P0 | Type `how to bake bread`, Enter | DuckDuckGo search for the text | Auto: `everything else is a search` |
| E-05 | P0 | Type `javascript:alert(1)` or `file:///C:/Windows/win.ini` | Treated as a search; no script runs and no local file opens | Auto: `disallowed schemes become a search…` |
| E-06 | P1 | Type only spaces, Enter | Nothing happens (Enter is ignored when the input is blank) | Auto (resolver): `empty input opens a blank page`; UI part Manual |
| E-07 | P1 | `Ctrl+L` and `F6` | Address bar gets focus and its text is selected | Manual |
| E-08 | P1 | Type text, then `Escape` | Text reverts to the current tab's URL, selected | Auto (e2e): `E-08: Escape in the address bar reverts…` |
| E-09 | P1 | Switch tabs while not typing | Address bar shows the newly active tab's URL (empty for a blank tab) | Auto (e2e): `E-01 / E-09: typing in the address bar…` |
| E-10 | P1 | Navigate A → B, then Back, then Forward (buttons and `Alt+Left` / `Alt+Right`) | Moves through history; Back/Forward buttons are disabled when not possible | Manual |
| E-11 | P1 | Click Reload, `Ctrl+R`, `F5`, `Ctrl+Shift+R` | Page reloads (hard reload bypasses the cache) | Manual |
| E-12 | P1 | Load a slow page | Tab shows a spinner; Reload button becomes Stop (✕); clicking it stops the load | Manual |
| E-13 | P1 | Load a page with a title and favicon | Tab shows the page title and favicon; window title becomes "<title> - Agentic Browser" | Manual |
| E-14 | P2 | Favicon URL is broken | Tab falls back to the grey placeholder dot; no broken-image icon | Manual |
| E-15 | P2 | Navigate to an unreachable host (e.g. `https://no-such-host.invalid`) | Chromium's error page shows in the tab; the shell keeps working | Manual |
| E-16 | P1 | Filenames and unknown suffixes: type `notes.txt`, `report.pdf`, `intranet.corp`, `wiki`; then `intranet.corp/`, `wiki/page`, `build-server:8080` | The first group is searched. The second group loads over `http://` (a trailing `/` or a port marks an internal host). Real suffixes (`example.dev`, `user.github.io`) load over `https://`. Like Chrome, `readme.md` loads as a site because `.md` is a real TLD | Auto: `E-16: filenames and unknown suffixes are searched…`, `intranet hosts load over http…`, `real public suffixes…` |

## F. Shell: security

| ID | P | Test case | Expected result | Coverage |
|---|---|---|---|---|
| F-01 | P0 | In a web page's DevTools console, check `window.agb`, `require`, `process` | All `undefined`: web pages get no preload, no Node, no shell API | Auto (e2e): `F-01: web pages get no preload, Node, or shell API` |
| F-02 | P0 | Shell IPC only from the shell: a web page can't send `shell:*` IPC (no `ipcRenderer`), and main ignores messages from any sender other than the shell view | Messages from other senders are ignored (`fromShell` check) | Manual (code review of `fromShell` in `src/main/index.ts`; F-01 shows pages have no IPC access) |
| F-03 | P0 | A page asks for camera, microphone, geolocation, or notifications | Denied without a prompt (deny-by-default until the permissions UI exists) | Manual |
| F-04 | P1 | A page requests fullscreen (`element.requestFullscreen()`) | Allowed | Manual |
| F-05 | P1 | No remote debugging port: while the app runs, `netstat -ano` filtered by the app's PIDs | Only the gateway's 127.0.0.1 HTTP port is listening; no DevTools port (e.g. 9222) | Manual |
| F-06 | P1 | Shell CSP: the shell renderer loads no remote scripts | `index.html` CSP allows `script-src 'self'` only; DevTools on the shell shows no CSP violations at startup | Auto (e2e): `F-06: the shell's CSP blocks inline scripts` |

## G. Gateway: lifecycle and discovery

| ID | P | Test case | Expected result | Coverage |
|---|---|---|---|---|
| G-01 | P0 | App start | Log shows `[gateway] ready · pipe \\.\pipe\agb-<hash> · http http://127.0.0.1:<port> · <path>\gateway.json` | Manual |
| G-02 | P0 | Read `%LOCALAPPDATA%\AgenticBrowser\gateway.json` | Has `version`, `protocol` ("1.0"), `pipe`, `http`, `token` (43 chars, base64url), `pid` (= the main app PID), `startedAt` | Auto (writer): `discovery file is written…`; live file Manual |
| G-03 | P0 | Restart the app twice and compare tokens | Token differs on every launch | Auto (e2e): `G-03: the token is different on every launch` |
| G-04 | P0 | Quit the app normally | `gateway.json` is deleted | Auto (e2e): `D-06 / C-06 / G-04: closing the last tab quits the app…` |
| G-05 | P1 | Quit when `gateway.json` belongs to another instance (different `pid`, e.g. a copy with the same `AGB_HOME` written later) | The file is left alone | Auto: `G-05: discovery cleanup only deletes the file this instance wrote` |
| G-06 | P1 | Kill the gateway utility process (Task Manager → "Agent Gateway") | Main restarts it within ~0.5 s; a new `gateway.json` with a new token is written; `agb status` works again | Manual |
| G-07 | P1 | Gateway fails during startup: start a second copy with the **same** `AGB_HOME` but a different profile (so the single-instance lock doesn't stop it), so its pipe name is already taken | The second copy logs `[gateway] fatal: …` and restarts it 3 times (0.5 s, 1 s, 1.5 s), then logs "gave up restarting"; its shell keeps working; the first copy and its `gateway.json` are untouched. (A gateway that reached "ready" resets the counter, so repeated kills after startup are always restarted.) | Auto (e2e): `G-07: a gateway that can't start is retried 3 times…` |
| G-08 | P1 | Two copies side by side with different `AGB_HOME` | Each has its own pipe name, port, token, and `gateway.json`; `AGB_HOME=<x> agb status` reaches the right one | Manual |
| G-09 | P1 | `gateway.status` counts: open 3 tabs, run `agb status` | `windows: 1  tabs: 3` | Auto (e2e): `G-09: gateway.status counts match the shell` |
| G-10 | P2 | Main process doesn't answer the gateway's question within 5 s | `gateway.status` returns `E_INTERNAL` "main process did not answer shellCounts" (no hang) | Auto: `G-10: when the main process doesn't answer…` |

## H. Gateway: pipe protocol (newline-delimited JSON-RPC)

| ID | P | Test case | Expected result | Coverage |
|---|---|---|---|---|
| H-01 | P0 | `gateway.hello` with the right token and protocol "1.0", then `gateway.status` | Hello returns `appVersion`, `protocol`, `serverTime`; status returns counts, pid, transports `["pipe","http"]` | Auto: `pipe: hello then status` |
| H-02 | P0 | `gateway.status` without hello | `E_UNAUTHORIZED` (-32001) with a hint | Auto: `pipe: status without hello…` |
| H-03 | P0 | Hello with a wrong token, then status on the same connection | Both `E_UNAUTHORIZED`; the connection does not become authorized | Auto: `pipe: wrong token…` |
| H-04 | P0 | Hello with protocol "2.0" | `E_VERSION` (-32002) with a hint | Auto: `pipe: incompatible protocol…` |
| H-05 | P1 | Hello with protocol "1.7" (same major) | Accepted | Auto: `H-05: same protocol major with a newer minor is accepted` |
| H-06 | P1 | Invalid JSON line, then an unknown method, then a valid hello | `E_PARSE`, `E_METHOD_NOT_FOUND`, then success: the connection survives errors | Auto: `pipe: bad JSON and unknown methods…` |
| H-07 | P1 | Request without `id`, with `jsonrpc: "1.0"`, or as a JSON array | `E_INVALID_REQUEST` (-32600) | Auto: `H-07: malformed JSON-RPC requests are E_INVALID_REQUEST` |
| H-08 | P1 | Several requests written in one chunk | Replies come back in the same order, one per line | Auto: `pipe: bad JSON and unknown methods…` (3 in a row) |
| H-09 | P1 | Send more than 1 MB without a newline | Gateway closes the connection; other connections are unaffected | Auto: `H-09: a message over 1 MB without a newline closes that connection only` |
| H-10 | P2 | Client disconnects mid-request | No crash or unhandled error in the gateway log | Auto: `H-10: a client that disconnects mid-request…` |

## I. Gateway: HTTP fallback (`POST /rpc`)

| ID | P | Test case | Expected result | Coverage |
|---|---|---|---|---|
| I-01 | P0 | `gateway.status` with `Authorization: Bearer <token>` | 200 with the status result (no hello needed) | Auto: `http: bearer token authorizes` |
| I-02 | P0 | No `Authorization` header | 401, `E_UNAUTHORIZED` | Auto: `http: missing token is 401` |
| I-03 | P0 | Request with an `Origin` header (as a web page's `fetch` would send) | 403, even with a valid token | Auto: `http: requests from web pages…` |
| I-04 | P0 | `Host: evil.example:80` (DNS rebinding) | 403 | Auto: `http: wrong Host header…` |
| I-05 | P0 | From a web page open in Agentic Browser itself, `fetch("http://127.0.0.1:<port>/rpc", {method:"POST", body:…})` | Fails (403 / CORS); no data returned to the page | Auto (e2e): `I-05: a web page can't call the gateway's HTTP endpoint` |
| I-06 | P1 | Listening address: from another machine on the LAN, connect to `<machine-ip>:<port>` | Connection refused (bound to 127.0.0.1 only) | Manual |
| I-07 | P1 | `GET /rpc`, `POST /other` | 404 | Auto: `I-07: wrong method or path is 404` |
| I-08 | P2 | Body larger than 1 MB | 413 | Auto: `I-08: body over 1 MB is rejected with 413` |

## J. CLI: commands and output

| ID | P | Test case | Expected result | Coverage |
|---|---|---|---|---|
| J-01 | P0 | **Exit criterion.** App running: `agb version` | Line 1 `agb 0.1.0 (protocol 1.0, windows/amd64)`; line 2 `app Agentic Browser 0.1.0 (protocol 1.0, Electron 45.4.1, Chrome …) via pipe`; exit 0 | Auto (e2e): `J-01 (exit criterion): agb version talks to the running app over the pipe` |
| J-02 | P0 | App not running: `agb version` | CLI line, then `app: not running` and a hint; exit 3 | Auto: `TestVersionWhenAppNotRunning` |
| J-03 | P0 | App running: `agb status` | Header `[agb] gateway=pipe pid=… app=0.1.0 protocol=1.0`, then `running: yes (up …)`, `windows/tabs`, `transports: pipe, http`; exit 0 | Manual |
| J-04 | P0 | App not running: `agb status` | stderr: `[agb] error E_NO_GATEWAY: …` + `hint: start Agentic Browser…`; exit 3 | Auto: `TestStatusWhenAppNotRunning` |
| J-05 | P1 | `agb --json status` (running and not running) | Valid JSON: `{"ok":true,"running":true,"transport":"pipe","status":{…}}`, or `{"ok":false,"running":false}` with exit 3 and nothing on stderr | Manual |
| J-06 | P1 | `agb --json version` (running and not running) | JSON with `cli` and `app` (or `"app": null`) | Auto: `TestJ06VersionJSON` |
| J-07 | P1 | `AGB_JSON=1 agb status` | Same as `--json` | Manual |
| J-08 | P1 | `agb --quiet status` / `-q` | No header line; body lines only | Auto: `TestJ12FlagForms` (`-q`) |
| J-09 | P1 | `agb`, `agb help`, `agb --help`, `agb -h` | Usage with the command list. `agb` alone exits 2; the others exit 0 | Auto (no args): `TestNoArgsPrintsUsage`; others Manual |
| J-10 | P1 | `agb frobnicate` | `[agb] error E_USAGE: unknown command frobnicate` + hint; exit 2 | Auto: `TestUnknownCommand` |
| J-11 | P1 | `agb --timeout soon status`, `agb --timeout` (no value) | Bad value: `E_USAGE: bad --timeout soon` + hint "use a duration like 30s or 2m". Missing value: `E_USAGE: --timeout needs a value` (no hint). Both exit 2 | Auto: `TestBadTimeoutFlag`, `TestJ11MissingFlagValue` |
| J-12 | P2 | Flag forms: `--timeout=5s status`, `status --json` (flag after command), `--agent claude-code status` | All accepted; `--agent` is sent as `ctx.agent` | Auto: `TestJ12FlagForms` |
| J-13 | P2 | Output has no ANSI color codes when piped: `agb status \| more` | Plain text only | Manual |

## K. CLI: connection and errors

| ID | P | Test case | Expected result | Coverage |
|---|---|---|---|---|
| K-01 | P0 | Pipe transport works | `via pipe` / `gateway=pipe` | Auto: `TestPipeHelloAndStatus` (fake gateway) |
| K-02 | P0 | Pipe missing but HTTP up | Falls back to HTTP; `gateway=http` | Auto: `TestFallsBackToHTTPWhenPipeIsMissing` |
| K-03 | P0 | Stale `gateway.json` after the app crashed (kill the main process, leaving the file) | `E_NO_GATEWAY` "cannot reach … (pipe: …; http: …)" + hint "may have crashed"; exit 3 | Auto (client): `TestUnreachable`; end-to-end Manual |
| K-04 | P0 | `gateway.json` with an old token (copy the file, restart the app, restore the old copy) | `E_UNAUTHORIZED` from the gateway; no fallback to HTTP; exit 1 | Auto (client): `TestWrongTokenIsAnRPCError` |
| K-05 | P1 | Corrupt `gateway.json` (invalid JSON) | `E_NO_GATEWAY: parse …` + hint "restart Agentic Browser"; exit 3 | Auto: `TestK05CorruptDiscovery` |
| K-06 | P1 | `gateway.json` missing `token` | `E_NO_GATEWAY: … is incomplete`; exit 3 | Auto: `TestK06IncompleteDiscovery` |
| K-07 | P1 | Unresponsive gateway, `--timeout 2s` (simulate with a stub pipe/HTTP server): (a) never answers `gateway.hello`; (b) answers hello but never answers `gateway.status` | (a) After ~2 s: `E_NO_GATEWAY` "cannot reach … context deadline exceeded"; exit 3. (b) After ~2 s: `E_TIMEOUT` "the gateway did not answer in time"; exit 7 | Auto: `TestK07UnresponsiveGateway` |
| K-08 | P1 | `agb version` when the gateway hangs | Gives up after at most 3 s, shows `app: not running`; exit 3 | Manual |
| K-09 | P2 | The token is never printed by `agb` in any mode (`version`, `status`, `--json`, errors) | No token in stdout/stderr | Auto: `TestK09TokenNeverPrinted` |

## L. Cross-platform (macOS / Linux): not yet run

| ID | P | Test case | Expected result | Coverage |
|---|---|---|---|---|
| L-01 | P1 | macOS: start the app | Socket at `~/Library/Application Support/AgenticBrowser/agb.sock`, mode `0600`; `gateway.json` mode `0600`; directory `0700` | Manual |
| L-02 | P1 | Linux: start the app | Same under `$XDG_STATE_HOME/agentic-browser/` | Manual |
| L-03 | P1 | Leftover socket file from a crash, then start the app | Stale socket removed; gateway starts normally | Auto (live socket never taken over): `L-03: a live pipe/socket is never taken over…`, runs on all CI OSes; stale-socket removal Manual |
| L-04 | P2 | macOS: close the window | App keeps running (dock icon), gateway stays up; clicking the dock icon opens a new window | Manual |

## M. Performance (M0 baselines)

Targets from [SPEC §18](../SPEC.md#18-performance-targets). M0 records baselines; failing them doesn't block M0.

| ID | P | Test case | Expected result | Coverage |
|---|---|---|---|---|
| M-01 | P2 | `agb status` wall time over 50 runs (app running) | p50 ≤ 25 ms, p95 ≤ 50 ms. Derived from §18 (CLI overhead 10/25 ms + no-op round trip 3/10 ms) plus Windows process start-up | Manual |
| M-02 | P2 | Cold start: time from `npm start`'s Electron launch to the `[gateway] ready` log line | ≤ 2.5 s p50 on a mid-range laptop | Manual |
| M-03 | P2 | Memory with one blank tab (all app processes) | Record a baseline for later milestones | Manual |

---

## Automated test suites

| Suite | Command | Where | Cases |
|---|---|---|---|
| Codegen | `node --test "packages/protocol/test/*.test.mjs"` (part of `npm test`) | `packages/protocol/test/codegen.test.mjs` | B-02 to B-05 |
| App unit | `npm run test --workspace apps/browser` (part of `npm test`) | `apps/browser/test/*.test.ts` | E-01 to E-06, G-02, G-05, G-10, H-*, I-01 to I-04, I-07, I-08, L-03 |
| CLI | `node scripts/test-cli.mjs` (part of `npm test`) | `apps/cli/*_test.go`, `apps/cli/internal/{client,discovery,format}/*_test.go` | J-*, K-*; plus unit tests for discovery paths per OS, `gateway.json` validation, header quoting, error and JSON formatting |
| End-to-end | `npm run test:e2e` (launches the real app; needs a desktop session) | `apps/browser/test/e2e/` | C-05, C-06, D-06, D-08, E-01, E-08, E-09, F-01, F-06, G-03, G-04, G-07, G-09, I-05, J-01 |
| CI | `.github/workflows/ci.yml` | GitHub Actions | All of the above: checks on Windows, Ubuntu, macOS; end-to-end on Windows. Not yet run on GitHub |

The end-to-end harness starts the app with its own profile (`AGB_PROFILE_DIR`) and `AGB_HOME`, plus `--remote-debugging-port=0` (test-only), and drives the shell and tabs over the Chrome DevTools Protocol. Test pages come from a local HTTP server on 127.0.0.1.

**Bugs found while automating** (both fixed):
- On macOS/Linux, a second gateway sharing `AGB_HOME` deleted the first one's live socket at startup. It now only removes a socket that nothing is listening on (L-03).
- Codegen wrote the TypeScript file before generating Go, so a schema error left partial output. It now generates everything before writing anything (B-05).
- `agb --json` escaped `&`, `<` and `>` in URLs as `&` etc. It now writes them as-is (`TestJSONDoesNotEscapeHTMLCharacters`).

**Gaps:** none. E-16 was fixed by checking hosts against the public suffix list (`tldts`, pinned to 7.4.19) in `src/main/url.ts`.
