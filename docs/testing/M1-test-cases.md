# Milestone M1 (Basic control): Test Cases

| | |
|---|---|
| **Milestone** | M1: Gateway transport and auth, agent Spaces (isolated mode), `goto`, `tab`, `capture`, `text` ([SPEC §22](../SPEC.md#22-milestones)) |
| **Exit criterion** | An agent can open a page and screenshot it without touching human tabs |
| **Build under test** | App 0.1.0 · Electron 45.4.1 · protocol 1.0 · Windows 11 x64 |
| **Date** | 2026-11-22 |

Priorities and coverage labels are as in [M0-test-cases.md](M0-test-cases.md#how-to-read-this). Gateway transport and auth were built in M0 and are covered there (G-, H-, I-, K- cases); this document covers what M1 adds.

## Summary

| Area | Cases | Auto | Manual | Gap |
|---|---|---|---|---|
| S. Agent Spaces and tabs (service logic) | 23 | 23 | 0 | 0 |
| V. Gateway: validation and forwarding | 9 | 9 | 0 | 0 |
| A. CLI: agent commands | 12 | 12 | 0 | 0 |
| X. End-to-end in the real app | 11 | 11 | 0 | 0 |
| N. Manual checks | 7 | 0 | 7 | 0 |
| **Total** | **62** | **55** | **7** | **0** |

---

## S. Agent Spaces and tabs

Unit tests of `AgentService` with a fake browser driver (`apps/browser/test/agent-service.test.ts`).

| ID | P | Test case | Expected result |
|---|---|---|---|
| S-01 | P0 | `nav.goto` with no Space | Creates an isolated Space (`sp_xxxx`) and tab `t_1` with a 1280×800 viewport in its own partition; location says `spaceCreated`, `spaceMode: isolated` |
| S-02 | P0 | A second `nav.goto` | Reuses the sticky Space and active tab; no new Space |
| S-03 | P0 | Same agent from another directory, or another agent | `E_NO_SPACE` for reading commands; `goto` creates a separate Space |
| S-04 | P1 | Sticky Space after 29 and 31 minutes idle | Still the default at 29 min; at 31 min reading commands get `E_NO_SPACE`, but `--space` still works |
| S-05 | P0 | `text`, `capture`, `tab list/info/close`, `back`, `reload`, `space info/close/show` with no Space | `E_NO_SPACE` with a hint; nothing is created |
| S-06 | P0 | Agent B names agent A's Space (read, close, goto), or an agent with no ID does | `E_NO_SPACE`; A's Space isn't listed for B |
| S-07 | P1 | Three first commands in parallel from one agent and directory | One Space, shared by all three |
| S-08 | P1 | Limits: 2 Spaces, 2 tabs per Space (configured) | Third Space or tab is `E_LIMIT` with a hint |
| S-09 | P1 | `space.create` with `cloned`, `shared`, `persistent` | `E_UNSUPPORTED` (isolated only until M7); an isolated Space with a name becomes the sticky default |
| S-10 | P0 | `goto`/`tab.open` with `file:`, `chrome:`, `javascript:`, `data:`, `devtools:`; or "not a url" | `E_DENIED` ([SPEC §15.3](../SPEC.md#153-sensitive-action-classes) `file_scheme`); `E_INVALID_PARAMS`; no Space created |
| S-11 | P1 | URL normalization | `example.com` → https; `localhost:3000/app` and `127.0.0.1:8080` → http; scheme and host lowercased; empty, spaces, `ftp:`, `view-source:` rejected |
| S-12 | P0 | A slow navigation followed by `text` on the same tab, and a command on another tab | `text` runs after the navigation (FIFO per tab, §8.6); the other tab isn't blocked |
| S-13 | P0 | A navigation that never finishes, 50 ms timeout | `E_TIMEOUT`; the page is stopped |
| S-14 | P0 | Open three tabs, select, target with `ctx.tab`, close active, close all | Active tab follows open/select; `ctx.tab` targets without selecting; closing the active tab activates its neighbour; empty Space says "has no tabs"; `goto` then opens `t_4` |
| S-15 | P1 | `space show`, `tab select`, the human closing the window, `space hide` | Only the active tab's window is shown and follows selection; the human's close hides it and marks the Space hidden |
| S-16 | P1 | Page opens `https://…` and `file:///…` popups | The https one becomes a background tab in the same Space; the file one is ignored |
| S-17 | P0 | `space close` | Tabs closed, storage disposed, sticky entry and Space ID gone; next `goto` makes a new Space |
| S-18 | P1 | A command queued behind a tab that gets closed | `E_NO_TAB` ("closed while the command was running") |
| S-19 | P2 | A tab's renderer goes away on its own | The tab is removed from the Space |
| S-20 | P0 | `page.capture` (full page, JPEG; then PNG) | Image written to the capture folder as `sp_…-t_…-<time>.jpg/.png` with format, size, bytes |
| S-21 | P1 | `page.text` on 30,000 chars; `maxChars` 150 and 210 | Default limit 20,000; cut at a line break if it's within the last 20%, else exactly at the limit; `chars` is the full length |
| S-22 | P1 | `back`, `forward` (no history), `reload` | `moved: true`, `moved: false`, and no `moved` field for reload |
| S-23 | P2 | `counts()` and `disposeAll()` | Counts Spaces and tabs across agents; dispose closes everything |

## V. Gateway: validation and forwarding

`apps/browser/test/gateway-agent.test.ts`.

| ID | P | Test case | Expected result |
|---|---|---|---|
| V-01 | P0 | Valid `nav.goto` and `page.text` | Forwarded to the main process with params, ctx, and timeout (default 30 s, or `ctx.timeoutMs`) |
| V-02 | P0 | 15 kinds of bad params or ctx (missing/empty/wrong-type fields, bad enum, out-of-range numbers, ctx timeout outside 1 s–5 min) | `E_INVALID_PARAMS` naming the field; nothing forwarded |
| V-03 | P1 | Unknown extra fields in params and ctx | Ignored, so a newer client with the same major protocol still works |
| V-04 | P0 | Main process returns `{ name: E_NO_TAB, message, hint }` | Same name, message, hint, and code −32011 reach the client |
| V-05 | P1 | Main process throws an Error, an unknown error name, or a string | `E_INTERNAL` |
| V-06 | P0 | Agent method on an unauthenticated pipe connection | `E_UNAUTHORIZED`; nothing forwarded |
| V-07 | P1 | Method names `constructor`, `toString`, `__proto__`, `hasOwnProperty` | `E_METHOD_NOT_FOUND` (fixed: these used to resolve to `Object.prototype` members) |
| V-08 | P1 | `gateway.status` | Includes `agentSpaces` and `agentTabs` |
| V-09 | P2 | `validate()` on refs, arrays, nested objects, long strings, unknown types | Correct first error, with its path |

## A. CLI: agent commands

`apps/cli/agent_test.go`, against a stub gateway.

| ID | P | Test case | Expected result |
|---|---|---|---|
| A-01 | P1 | Command flag parsing | `--flag value`, `--flag=value`, booleans, `--`; unknown flags, missing values, and `--bool=maybe` are errors |
| A-02 | P0 | `agb --timeout 10m goto https://example.com --wait networkidle` with `AGB_AGENT`, `AGB_SPACE` set | Header `[agb] space=sp_3a1 (new, isolated) tab=t_1 url=… title="…"` then `ok: HTTP 200 in 321 ms`; ctx has agent, space, cwd, and `timeoutMs` clamped to 300000 |
| A-03 | P1 | `--space`/`--tab` flags with `AGB_SPACE` set | Flags win over env vars |
| A-04 | P0 | Gateway errors `E_NAV_FAILED`, `E_DENIED`, `E_TIMEOUT`, `E_INVALID_PARAMS`, `E_NO_SPACE`, `E_LIMIT`, in text and `--json` | Exit 8, 4, 7, 2, 1, 1 ([SPEC §9.4](../SPEC.md#94-exit-codes)); two-line error on stderr, or `{"ok": false, "error": {code, message, hint}}` on stdout |
| A-05 | P1 | `goto` a 404 page, with and without `--strict` | Without: exit 0 and a warning. With: `E_NAV_FAILED`, exit 8 |
| A-06 | P0 | `agb text --max-chars 200` | Text between `--- page content (untrusted; …) ---` and `--- end page content · 5000 chars · truncated … · hidden text omitted: 3 ---`; `--max-chars 5` is a usage error |
| A-07 | P0 | `agb capture -o shots/page.png` in a work folder; `-o ../outside.png`, an absolute path elsewhere, and `.` | Image moved into `shots/` (folder created). Paths outside the working directory: `E_DENIED`, exit 4, and no screenshot taken (§15.6) |
| A-08 | P2 | `capture --full-page --quality 70 -o x.jpg`; `--format gif` | Format inferred from `.jpg`; `gif` is a usage error |
| A-09 | P1 | `tab list` and `space list` output | `t_2  https://x/  "X"  (loading)  (active)`; blank tabs show `about:blank`; empty list says how to start; Space line shows mode, tabs, visibility, viewport, default, name |
| A-10 | P1 | `agb --json back` | Location fields flattened to the top level with `"ok": true` (Appendix B); text mode says "no previous page" when history didn't move |
| A-11 | P0 | 11 usage errors (missing URL, extra args, bad `--wait`, unknown flag, missing subcommand, …) | Exit 2 with `E_USAGE` and a hint |
| A-12 | P0 | Agent command with the browser not running, text and `--json` | `E_NO_GATEWAY`, exit 3, hint "start Agentic Browser" |

## X. End-to-end in the real app

`apps/browser/test/e2e/agent.e2e.ts`: launches the app with a human tab open, and drives it with the real `bin/agb`.

| ID | P | Test case | Expected result |
|---|---|---|---|
| X-01 | P0 | **Exit criterion.** `agb goto <site>/` then `agb capture -o shot.png` | New isolated Space; PNG of exactly 1280×800 CSS pixels saved in the working directory. Human tabs, active tab, and URL unchanged; `status` shows 1 human window and 1 agent tab |
| X-02 | P0 | Cookies set by the human page and by the agent page on the same origin | Each sees only its own cookie |
| X-03 | P0 | `agb text` on a page with five hidden prompt-injection texts and a `<nav>` | Markdown heading, paragraph, and list with link; none of the hidden texts or the nav; footer says `hidden text omitted: 5` |
| X-04 | P0 | A page that calls `alert()` and `confirm()`; a page with a `beforeunload` handler | `goto` finishes, text after the dialogs is readable; leaving the page isn't blocked |
| X-05 | P0 | Agent page while its window is hidden | Viewport 1280×800, `visibilityState` visible, animation frames run, IntersectionObserver fires after scrolling, page never has focus |
| X-06 | P1 | Full-page capture of a 3000 px page; JPEG capture | Full-page height ≥ 3000 CSS px; JPEG signature; viewport capture afterwards is back to 800 px |
| X-07 | P1 | Agent page clicks a `target=_blank` link | New background tab in the agent's Space; opener stays active; nothing opens in the human's window |
| X-08 | P0 | `goto file:///etc/passwd`, an unresolvable host, a 404 with `--strict` | Exit 4 `E_DENIED`; exit 8 `ERR_NAME_NOT_RESOLVED`; exit 8 |
| X-09 | P0 | Another agent lists or names this agent's Space; same agent from another directory | Not listed / `E_NO_SPACE`; `--space` works from any directory for the owner |
| X-10 | P1 | `space show`, `space hide`, `space close` | Visibility reported; after close the agent pages are gone and `agentSpaces` is 0 |
| X-11 | P0 | Close the human's last tab while an agent Space is open | App quits (exit 0) and deletes `gateway.json`. Fixed: hidden agent windows used to keep `window-all-closed` from firing |

## N. Manual checks

| ID | P | Test case | Expected result |
|---|---|---|---|
| N-01 | P1 | `agb goto https://example.com` while typing in another app | Focus, cursor, and keyboard input stay in the other app; no window or taskbar button appears |
| N-02 | P1 | `agb space show` | The agent window appears without taking focus, titled "`<page>` — `<agent>` · Space sp_… (agent)", not resizable; closing it with × hides it (the agent's next command still works) |
| N-03 | P1 | `agb space show`, then `agb tab new https://example.org` | The shown window switches to the new active tab at the same position |
| N-04 | P2 | An agent page starts a download | Download is blocked and logged (`[agent] space …: blocked download of …`); downloads arrive in M2 |
| N-05 | P2 | An agent page asks for camera, location, or notifications | Denied without a prompt |
| N-06 | P2 | `agb goto` a real site with long polling, with `--wait networkidle` | Returns `E_TIMEOUT` after the timeout if the network never goes idle; `--wait load` returns normally |
| N-07 | P2 | Performance baselines: `agb goto https://example.com` (warm), `agb capture`, `agb text` | Recorded: ~260–320 ms, ~40 ms, ~20 ms on the dev laptop (§18 has no target for these yet) |

---

## Automated test suites

| Suite | Command | Where | Cases |
|---|---|---|---|
| App unit | `npm run test --workspace apps/browser` (part of `npm test`) | `apps/browser/test/agent-service.test.ts`, `gateway-agent.test.ts` | S-*, V-* |
| CLI | `node scripts/test-cli.mjs` (part of `npm test`) | `apps/cli/agent_test.go` | A-* |
| End-to-end | `npm run build:cli && npm run test:e2e` | `apps/browser/test/e2e/agent.e2e.ts` | X-* (skipped if `bin/agb` isn't built) |

**Design findings while building M1:**
- A `WebContentsView` inside a hidden window produces no frames: `requestAnimationFrame`, IntersectionObserver, and screenshots stall. Each agent tab is therefore its own hidden `BrowserWindow`, which keeps painting. "Showing" a Space shows its active tab's window.
- CDP `Page.captureScreenshot` never answers for a hidden window. Viewport captures use `webContents.capturePage`; full-page captures temporarily emulate a viewport as tall as the page, then capture.
- The debugger can only attach after the first load, so every agent tab loads `about:blank` first.
- Hidden windows render without a frame-rate cap (about 180 fps for pages that animate continuously). Not a problem for M1; to revisit in M9 (efficiency).

**Bugs found while automating** (all fixed):
- `goto` could run after a later command on the same tab, because it joined the tab's queue only after an asynchronous Space lookup (S-12, S-18).
- On a command timeout the page wasn't always stopped (S-13).
- Hidden agent windows kept the app from quitting when the human closed their last window (X-11).
- Method names such as `constructor` were looked up on `Object.prototype` (V-07).

**Known limits of M1** (by design, later milestones): only `isolated` Spaces (the spec's default `cloned` mode needs the policy engine, M7), so a Space created by `goto` is isolated; no refs, clicking, or typing (M2); no `agb skill` (M3); agent windows are view-only when shown (takeover, M6); `agb` doesn't start the browser when it isn't running, and doesn't detect the agent from its parent process (`--agent`/`AGB_AGENT` set it); idle Spaces aren't suspended yet (§7.5).
