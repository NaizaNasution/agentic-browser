# Milestone M2 (Snapshot and actions): Test Cases

| | |
|---|---|
| **Milestone** | M2: snapshot engine with refs, diff, budget; actions with actionability checks; dialogs, uploads, downloads ([SPEC §22](../SPEC.md#22-milestones)) |
| **Exit criterion** | 90% success on the fixture task suite |
| **Result** | **35 of 35 tasks (100%)**, in every run of the suite; see [T. Fixture task suite](#t-fixture-task-suite-exit-criterion) |
| **Build under test** | App 0.1.0 · Electron 45.4.1 · protocol 1.0 · Windows 11 x64 |
| **Date** | 2026-11-28 |

Priorities and coverage labels are as in [M0-test-cases.md](M0-test-cases.md#how-to-read-this). M0 and M1 cases still apply and still pass; M1's X-04 changed with the new dialog behavior (below).

## Summary

| Area | Cases | Auto | Manual | Gap |
|---|---|---|---|---|
| P. Snapshot engine (unit, recorded page) | 12 | 12 | 0 | 0 |
| Q. Actions, dialogs, uploads, waits, downloads (unit, fake driver) | 12 | 12 | 0 | 0 |
| C. CLI commands (stub gateway) | 12 | 12 | 0 | 0 |
| T. Fixture task suite in the real app (exit criterion) | 35 | 35 | 0 | 0 |
| N. Manual checks | 8 | 0 | 8 | 0 |
| **Total** | **79** | **71** | **8** | **0** |

---

## P. Snapshot engine

`apps/browser/test/snapshot.test.ts`, on a page recorded from the real app (`test/fixtures/rich-page.raw.json`: forms, hidden text, shadow DOM, a same-site and a cross-site iframe).

| ID | P | Test case | Expected result |
|---|---|---|---|
| P-01 | P0 | Interactive snapshot of the recorded page | Landmarks and controls with refs (`banner @e1`, `form "Login" @e7`, `textbox "Email" @e8 value="a@b.c" required`, `combobox "Country" @e13 value="Japan" options="Indonesia \| Japan* \| Kenya"`, `button "Disabled" @e15 disabled`, a click-handler `<div>` as `clickable`, contenteditable as `textbox`, `alert "Wrong password" @e19`); headings without refs; 30 refs, ~300 tokens |
| P-02 | P0 | Password field | `textbox "Password" @e9 type=password value=<redacted>`; the value never appears |
| P-03 | P0 | Text people can't see (§10.1) | `display:none`, 1 px font, transparent, `opacity:0` parent, `aria-hidden`, and off-page content are left out; 3 hidden texts counted |
| P-04 | P0 | Iframes | Same-site and cross-site frames nested under `iframe "…" @eN (host/path)` |
| P-05 | P1 | Modes | Interactive: long text summarized as `text "…" (+N words)`, tables as `table (2 rows)`. Full: complete text, `href=`, table rows, images |
| P-06 | P0 | Ref stability (§10.3) | Same page, same refs; removing an element leaves other refs unchanged; a new element gets the next number, never a reused one |
| P-07 | P0 | Token budget (§10.5) | 200 and 120 token budgets are never exceeded; sections nearest the viewport stay whole; others become `form "Login" @e7 (collapsed: 11 refs; use --scope @e7)` or `… N more items collapsed (… use --scope @e6 …)`; scrolled to the bottom, the footer stays and the top collapses |
| P-08 | P1 | `--scope` | Only that subtree; unknown scope reported |
| P-09 | P0 | Diffs (§10.6) | `~ textbox "Email" @e8 value="new@example.com" required` and `- alert "Wrong password" @e19`; focus changes are not reported; long lists end with `… N more changes` |
| P-10 | P1 | Fingerprints for re-finding (§10.4) | `{ role, name, tag, landmark: "form:Login" }` plus index |
| P-11 | P0 | RefTable | Assign, rebind, ref spellings (`@e12`, `e12`, `12`); after a navigation old refs are forgotten and numbering **continues** (`fromEarlierDocument`) |
| P-12 | P0 | Layout rules on hand-made DOM snapshots | Hidden: `visibility:hidden`, `opacity:0` (inherited), zero size, off the page. Visible: `display:contents`, nodes with no layout object. Unreadable: tiny font, text in its parent's style, same color as the inherited background |

## Q. Actions, dialogs, uploads, waits, downloads

`apps/browser/test/agent-actions.test.ts`, with a fake driver.

| ID | P | Test case | Expected result |
|---|---|---|---|
| Q-01 | P0 | Snapshot, actions, wait, dialog, download with no Space | `E_NO_SPACE`; nothing created |
| Q-02 | P1 | `page.snapshot` options | mode, scope, maxTokens, diff passed through; result has the location |
| Q-03 | P0 | Every action method | Becomes the right request (click button/count/modifiers/snapshot, hover, fill submit/clear, type, press, select, check, uncheck, scroll, dialog dismiss) |
| Q-04 | P0 | Action result | Location, action, changes, duration |
| Q-05 | P0 | A dialog is waiting | `snapshot`, `click`, `text`, `goto`, `back`, `wait` → `E_DIALOG_OPEN` with the message; `capture`, `dialog list`, `dialog accept` still work |
| Q-06 | P0 | A page opens a tab during an action | `opened: ["t_2"]`, opener stays active; `--follow` makes the new tab active |
| Q-07 | P0 | Upload paths (§15.6) | Files in the working directory or the Space's download folder pass; anything else (absolute elsewhere, `../`, `.`) → `E_DENIED`; missing files → `E_INVALID_PARAMS` |
| Q-08 | P1 | `wait` conditions | Nothing to wait for, two conditions, `--gone` without text or ref → `E_INVALID_PARAMS` with a fitting message |
| Q-09 | P1 | Downloads | Listed per Space; wait for the latest or a given ID |
| Q-10 | P1 | Key combinations | `Enter`, `Control+A` (sends the `a` key), aliases (`ctrl`, `esc`), `Control++`, `F5`; errors for non-modifiers and unknown keys |
| Q-11 | P1 | Typed characters | US-keyboard keys with Shift where needed; others (é, 日) are inserted as text |
| Q-12 | P2 | `wait --url` globs | `*` and `?`; no wildcards means "contains" |

## C. CLI commands

`apps/cli/actions_test.go`, against a stub gateway.

| ID | P | Test case | Expected result |
|---|---|---|---|
| C-01 | P0 | `agb snapshot --mode full --scope @e1 --max-tokens 500` | Header, untrusted-content delimiters, footer `2 refs · ~9 tokens · viewport 2 of 3 · 1 section collapsed … · hidden text omitted: 2`; bad mode/budget/args → exit 2 |
| C-02 | P0 | `agb snapshot --diff` | `changes since the last snapshot:` inside the delimiters, or `no changes since the last snapshot` |
| C-03 | P0 | `agb click` with everything in the result | `ok: clicked button "Sign in" @e5`, re-resolve note, `opened tab t_2 (…)`, `downloaded: d_1 r.pdf (2 KB) → …`, file-chooser note, `changes:`; modifiers sent as Control/Shift; unknown modifier → exit 2 |
| C-04 | P0 | Navigation and dialogs in a result | `→ navigated to … (refs were reset; use agb snapshot)`; `dialog: a confirm dialog is waiting: "Sure?"` with a hint |
| C-05 | P0 | Exit codes (§9.4) | `E_NO_REF`, `E_STALE_REF` → 5; `E_NOT_ACTIONABLE` → 9; `E_DIALOG_OPEN` → 1 |
| C-06 | P1 | `fill --no-clear` / `--clear=false` | Sends `"clear": false`; default leaves it out |
| C-07 | P1 | `press` and `type` | `ok: pressed Control+A`; `ok: typed "hello world" into searchbox "Search" @e3` |
| C-08 | P1 | `scroll`, `select`, `upload` | `ok: scrolled to 680 of 1560 px (viewport 2 of 3)`; `--by 0,600`; `ok: selected "Kenya" in combobox "Country" @e4`; upload sends absolute paths |
| C-09 | P1 | `--snapshot` on an action | Sends `snapshot: true`; prints the changes, then the snapshot |
| C-10 | P1 | `agb wait` | Prints what matched; `--ms 0` is sent; `--ref --gone` |
| C-11 | P1 | `agb dialog` and `agb download` | list, accept `--text`, dismiss (no `--text`); download list; `download wait` on an interrupted download exits 1 |
| C-12 | P2 | `--json` on an action | `"ok": true` with the location flattened |

## T. Fixture task suite (exit criterion)

`apps/browser/test/e2e/tasks.e2e.ts` with the fixture app in `apps/browser/test/tasks/fixture-app.ts`. Each task drives the real app with the real `agb`, finding elements by role and name in snapshots, and is checked against what the fixture's server recorded. Each task runs as its own agent, in a fresh isolated Space.

| ID | Task | What it exercises |
|---|---|---|
| T-01 | Sign in and reach the dashboard | fill, click, navigation, cookie session |
| T-02 | A wrong password shows an error | `fill --submit`, alert role |
| T-03 | Long sign-up form | text, email, `<select>`, radio, multi-line textarea, checkbox |
| T-04 | Browser validation stops an incomplete form | required fields, retry |
| T-05 | Add items to a cart | buttons named by `aria-label` |
| T-06 | Place an order, accepting a confirm | dialog in an action result, `dialog accept` |
| T-07 | Cancel an order, dismissing a confirm | `dialog dismiss` |
| T-08 | Add three to-dos in a client-side app | SPA, `fill --submit` |
| T-09 | Complete a to-do in a re-rendering list | `check` |
| T-10 | Delete a to-do | click |
| T-11 | A cookie banner covers the page | `E_NOT_ACTIONABLE … covered by dialog "Cookie consent" @eN (on a full-page overlay)`, dismiss, continue |
| T-12 | Form inside shadow DOM | fill, click in a shadow root |
| T-13 | Button in a same-site iframe | click in a child frame |
| T-14 | Form in a cross-site iframe | fill and submit in an out-of-process frame |
| T-15 | Infinite feed until story 40 appears | `scroll --to bottom`, IntersectionObserver loading |
| T-16 | Acknowledge an alert | `E_DIALOG_OPEN` while it waits |
| T-17 | A dialog opened later by a timer | the next command is blocked until it is answered |
| T-18 | Download a CSV | download folder, file content, `download list` |
| T-19 | Upload a file | `upload` from the working directory, server receives it |
| T-20 | Hover menu | `hover` on a focusable `<span tabindex="0">`, then click the revealed link |
| T-21 | ARIA combobox and native select | `select` on both kinds |
| T-22 | Tab panels | `tab` role |
| T-23 | A link opens a new tab | `click --follow`, `wait --text` |
| T-24 | Search with live suggestions | debounced fetch, `wait --text` |
| T-25 | Wizard with disabled Next buttons | `E_NOT_ACTIONABLE … is disabled`, number input, steps |
| T-26 | Paginated table | navigate pages, click a row action |
| T-27 | Command palette | `press Control+K`, `type`, `press Enter` |
| T-28 | Rich-text editor | `fill` on contenteditable |
| T-29 | Content that arrives late | `wait --text` |
| T-30 | Disclosure (`<details>`) | closed content isn't in the snapshot or the text; expand and read |
| T-31 | Back and forward | history |
| T-32 | Two tabs | `tab new/list/select/close` |
| T-33 | An element replaced on every click | the same ref keeps working: `note: @eN re-resolved` |
| T-34 | An old ref after navigation | exit 5, and nothing is clicked by mistake |
| T-35 | Scoped snapshot | `snapshot --scope` |

**Results:** 35 of 35 in every run that completed (between 60 and 70 s for the whole suite; the slowest task is T-25 at ~9 s, which includes a deliberate 5 s wait on a disabled button). The suite writes `test-results/m2-task-suite.json`.

## N. Manual checks

| ID | P | Test case | Expected result |
|---|---|---|---|
| N-01 | P1 | Run the task suite while typing in another app | Focus and typing stay in the other app; no window or taskbar button appears |
| N-02 | P1 | `agb space show` during a task, then `agb space hide` | The agent's window appears on the primary display without focus, follows the active tab, and goes back off-screen |
| N-03 | P1 | Multiple monitors, including one left of or above the primary | Agent windows at −32000,−32000 never appear on any monitor |
| N-04 | P1 | `agb snapshot` on five real sites (a news site, a docs site, a web app sign-in, a shop, a search page) | Readable; under the default 4,000 tokens or collapsed sensibly; passwords redacted |
| N-05 | P2 | CPU with three idle agent tabs, and with the human's window covered by another app | Recorded as a baseline (native occlusion tracking is off: SPEC R12) |
| N-06 | P2 | A large download, then `agb download wait` | Progress, then completed with the right size |
| N-07 | P2 | A page using `prompt()` | Nothing appears and the page gets `null` (Electron doesn't support prompt; SPEC §11.5) |
| N-08 | P2 | macOS | Off-screen agent windows keep rendering (not yet verified; SPEC R12) |

---

## Automated test suites

| Suite | Command | Where | Cases |
|---|---|---|---|
| App unit | `npm run test --workspace apps/browser` (part of `npm test`) | `apps/browser/test/snapshot.test.ts`, `agent-actions.test.ts` | P-*, Q-* |
| CLI | `node scripts/test-cli.mjs` (part of `npm test`) | `apps/cli/actions_test.go` | C-* |
| End-to-end | `npm run build:cli && npm run test:e2e` | `apps/browser/test/e2e/tasks.e2e.ts` (and the M0/M1 suites) | T-* |

## What M2 found

**Design changes, each measured before deciding:**
- **Agent windows are shown off-screen instead of hidden.** A hidden window drops to about 1 frame per second once it receives input, so pointer events took 500–800 ms to reach the page and animation-driven code stalled. Off-screen, shown inactive, with native occlusion tracking off: 180 fps and 3–7 ms per click. Offscreen rendering (30 fps, ~20 ms) was the runner-up; it would make showing the window to the human (M1, and takeover in M6) much harder. Recorded as SPEC §7.3 and risk R12.
- **Refs are never renumbered within a tab.** With numbering restarting at `@e1` after each navigation, a ref from the previous page silently clicked a different element on the new one (T-34). Numbering now continues across navigations; old refs fail with `E_STALE_REF`. SPEC §10.3 updated.
- **A ref is checked before any automatic snapshot.** The first action on a page takes a baseline snapshot, which hands out refs; checking first means a ref the agent never saw fails instead of matching a fresh number.
- **`prompt()` doesn't exist in Electron** (it returns `null`, no dialog). Documented in SPEC §11.5; the fixture uses confirm and alert.

**Bugs found while automating** (all fixed):
- A cross-site iframe's document request starts in the parent's CDP session and ends in the frame's own, so it looked like it never finished and every action waited the full 1.5 s settle time. Requests are now tracked by ID across sessions (actions went from ~1.7 s to ~0.5 s).
- Wheel scrolling is animated and starts late; the position was read before it moved. `scroll` now waits for the expected position.
- Answering a dialog first ran a script in the page, which can't run while the dialog is open: 30 s timeout. And `goto` to a page that opens a dialog while loading hung until the timeout. Both now return at once and report the dialog (`goto` results gained a `dialog` field).
- The covering element was described as `RootWebArea "…"` when the click landed on a backdrop; it now names the dialog on the overlay.
- The token budget could be overshot by many "collapsed" lines; collapsed siblings are now merged and the budget is enforced.
- A re-resolved ref's note was lost after the up-front ref check.
- Hidden text: the closed body of a `<details>` was included by the readable-text extractor (now uses `checkVisibility()`).
- Test harness (no app changes): the task suite runs about a minute, longer than `test:e2e`'s 60 s per-test default, which killed the app mid-suite (it now has its own 10 min timeout); M1's setup raced the human tab's first load and the shell's first render; M0's `closeAllTabs` could click before the tab strip existed (G-03 failed about 1 run in 10; now 0 in 10); fixture byte counting used the wrong encoding.

**Stability:** after these fixes, three consecutive full `npm run test:e2e` runs passed 24 of 24 tests with 35 of 35 tasks each.

**Known limits of M2** (by design, later milestones): input uses the `fast` pace with one straight pointer move (human-like motion and typing are M4); no approvals for sensitive actions (M7); `prompt()` unsupported; HTTP authentication and permission prompts are denied rather than handed to the human (handoff, M6); multi-select `<select>`s and macOS `<select>`s are set directly (with a note) because their popups can't be driven with keys; wheel scrolling takes ~0.5 s per scroll.
