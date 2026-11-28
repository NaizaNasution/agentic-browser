// AgentService with a fake driver: Space resolution (SPEC §8.5), ownership, limits, per-tab queues (§8.6),
// timeouts, visibility, popups, and URL rules. Case IDs are from docs/testing/M1-test-cases.md.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentContext, DialogInfo, DownloadInfo, WaitParams } from "@agb/protocol";
import { AgentError } from "../src/main/agent/errors";
import {
  AgentService,
  truncateText,
  type ActionOutcome,
  type ActionRequest,
  type AgentDriver,
  type SnapshotRequest,
  type SpaceBackend,
  type TabBackend,
  type TabEvents,
  type TabSpec,
  type WaitUntil,
} from "../src/main/agent/service";
import { normalizeAgentUrl } from "../src/main/agent/urls";

class FakeTab implements TabBackend {
  currentUrl = "about:blank";
  currentTitle = "";
  closed = false;
  visible = false;
  stopped = 0;
  log: string[] = [];
  /** Override to control navigation timing and results. */
  onNavigate: (url: string, wait: WaitUntil) => Promise<{ status?: number }> = async () => ({ status: 200 });
  text = "Hello";

  constructor(
    readonly spec: TabSpec,
    readonly events: TabEvents,
  ) {}
  url() {
    return this.currentUrl;
  }
  title() {
    return this.currentTitle;
  }
  loading() {
    return false;
  }
  async navigate(url: string, wait: WaitUntil) {
    this.log.push(`navigate ${url} ${wait}`);
    const r = await this.onNavigate(url, wait);
    this.currentUrl = url;
    this.currentTitle = `Title of ${url}`;
    return r;
  }
  async history(action: "back" | "forward" | "reload") {
    this.log.push(action);
    return { moved: action !== "forward", status: 200 };
  }
  stop() {
    this.stopped++;
  }
  async capture(opts: { fullPage: boolean; format: "png" | "jpeg" }) {
    this.log.push(`capture ${opts.fullPage} ${opts.format}`);
    return { data: Buffer.from("fake-image"), width: 1280, height: opts.fullPage ? 3000 : 800, truncated: false };
  }
  async readText() {
    this.log.push("text");
    return { text: this.text, hiddenOmitted: 2 };
  }
  show(position?: { x: number; y: number }) {
    this.visible = true;
    return position ?? { x: 10, y: 20 };
  }
  hide() {
    this.visible = false;
  }
  close() {
    this.closed = true;
  }
  // M2
  dialog: DialogInfo | undefined;
  actions: ActionRequest[] = [];
  /** Override to control what an action does. */
  onAct: (req: ActionRequest) => Promise<ActionOutcome> = async (req) => ({ action: req.kind, changes: ["+ alert \"Saved\" @e9"] });
  async snapshot(req: SnapshotRequest) {
    this.log.push(`snapshot ${req.mode ?? "interactive"}${req.scope ? " " + req.scope : ""}${req.diff ? " diff" : ""}`);
    return { text: 'button "OK" @e1', refs: 1, tokens: 5, hiddenOmitted: 0, collapsed: 0, scroll: { y: 0, maxY: 0, viewportHeight: 800 } };
  }
  async act(req: ActionRequest) {
    this.actions.push(req);
    return this.onAct(req);
  }
  async waitFor(p: WaitParams) {
    this.log.push(`wait ${JSON.stringify(p)}`);
    return { matched: "ok" };
  }
  pendingDialog() {
    return this.dialog;
  }
}

class FakeDriver implements AgentDriver {
  tabs: FakeTab[] = [];
  disposed: string[] = [];
  createSpaceDelay = 0;
  downloadDirs = new Map<string, string>();
  async createSpace(id: string, _mode: string, agent: string): Promise<SpaceBackend> {
    if (this.createSpaceDelay) await new Promise((r) => setTimeout(r, this.createSpaceDelay));
    const downloadDir = mkdtempSync(join(tmpdir(), `agb-dl-${agent}-`));
    this.downloadDirs.set(id, downloadDir);
    const downloads: DownloadInfo[] = [{ id: "d_1", url: "https://x/report.pdf", filename: "report.pdf", path: join(downloadDir, "report.pdf"), state: "completed", bytes: 10 }];
    return {
      partition: `agb-space-${id}`,
      downloadDir,
      downloads: () => downloads,
      waitDownload: async (did) => {
        const d = downloads.find((x) => !did || x.id === did);
        if (!d) throw new AgentError("E_INVALID_PARAMS", `no download ${did}`);
        return d;
      },
      dispose: async () => void this.disposed.push(id),
    };
  }
  async createTab(spec: TabSpec, events: TabEvents): Promise<TabBackend> {
    const t = new FakeTab(spec, events);
    this.tabs.push(t);
    return t;
  }
}

function setup(opts: { maxSpaces?: number; maxTabsPerSpace?: number } = {}) {
  const driver = new FakeDriver();
  let clock = 1_700_000_000_000;
  let ids = 0;
  const captureDir = mkdtempSync(join(tmpdir(), "agb-captures-"));
  const svc = new AgentService(driver, {
    captureDir,
    now: () => clock,
    randomId: () => (++ids).toString(16).padStart(4, "0"),
    ...opts,
  });
  const ctx = (extra: AgentContext = {}): AgentContext => ({ agent: "claude-code", cwd: "/work", ...extra });
  const call = (method: string, params: unknown = {}, extra: AgentContext = {}, timeoutMs = 30_000): Promise<any> =>
    svc.handle(method, params, ctx(extra), timeoutMs);
  return { svc, driver, call, captureDir, advance: (ms: number) => (clock += ms) };
}

async function rejectsWith(p: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof AgentError, `expected AgentError, got ${String(e)}`);
    assert.equal(e.code, code, e.message);
    if (message) assert.match(e.message, message);
    return true;
  });
}

test("S-01: goto with no Space creates an isolated one and reports it in the location", async () => {
  const { call, driver } = setup();
  const r = await call("nav.goto", { url: "https://example.com" });
  assert.deepEqual(r.at, {
    space: "sp_0001",
    tab: "t_1",
    url: "https://example.com/",
    title: "Title of https://example.com/",
    spaceCreated: true,
    spaceMode: "isolated",
  });
  assert.equal(r.status, 200);
  assert.equal(driver.tabs[0]!.spec.partition, "agb-space-sp_0001");
  assert.deepEqual(driver.tabs[0]!.spec.viewport, { width: 1280, height: 800 });
});

test("S-02: the next command reuses the sticky Space and its active tab", async () => {
  const { call, driver } = setup();
  await call("nav.goto", { url: "https://a.example" });
  const r = await call("nav.goto", { url: "https://b.example" });
  assert.equal(r.at.space, "sp_0001");
  assert.equal(r.at.tab, "t_1");
  assert.equal(r.at.spaceCreated, undefined);
  assert.equal(driver.tabs.length, 1);
});

test("S-03: the sticky Space is per agent and working directory", async () => {
  const { call } = setup();
  await call("nav.goto", { url: "https://a.example" });
  await rejectsWith(call("page.text", {}, { cwd: "/elsewhere" }), "E_NO_SPACE");
  await rejectsWith(call("page.text", {}, { agent: "codex" }), "E_NO_SPACE");
  const other = await call("nav.goto", { url: "https://b.example" }, { cwd: "/elsewhere" });
  assert.equal(other.at.space, "sp_0002");
  assert.equal(other.at.spaceCreated, true);
});

test("S-04: the sticky Space expires 30 minutes after its last use", async () => {
  const { call, advance } = setup();
  await call("nav.goto", { url: "https://a.example" });
  advance(29 * 60_000);
  assert.equal((await call("page.text")).at.space, "sp_0001");
  advance(29 * 60_000); // 29 min after the last use: still sticky
  assert.equal((await call("page.text")).at.space, "sp_0001");
  advance(31 * 60_000);
  await rejectsWith(call("page.text"), "E_NO_SPACE");
  // The Space itself still exists and can be named explicitly.
  assert.equal((await call("page.text", {}, { space: "sp_0001" })).at.space, "sp_0001");
});

test("S-05: reading commands never create a Space", async () => {
  const { call, driver } = setup();
  for (const m of ["page.text", "page.capture", "tab.list", "tab.info", "tab.close", "nav.back", "nav.reload", "space.info", "space.close", "space.show"]) {
    await rejectsWith(call(m), "E_NO_SPACE");
  }
  assert.equal(driver.tabs.length, 0);
  assert.deepEqual((await call("space.list")).spaces, []);
});

test("S-06: an agent can't see or use another agent's Space", async () => {
  const { call } = setup();
  const { at } = await call("nav.goto", { url: "https://a.example" });
  assert.deepEqual((await call("space.list", {}, { agent: "codex" })).spaces, []);
  await rejectsWith(call("page.text", {}, { agent: "codex", space: at.space }), "E_NO_SPACE");
  await rejectsWith(call("space.close", { space: at.space }, { agent: "codex" }), "E_NO_SPACE");
  await rejectsWith(call("nav.goto", { url: "https://b.example" }, { agent: "codex", space: at.space }), "E_NO_SPACE");
  // An agent with no ID is "unknown", which is a different agent too.
  await rejectsWith(call("page.text", {}, { agent: "", space: at.space }), "E_NO_SPACE");
});

test("S-07: parallel first commands from one agent and directory share one new Space", async () => {
  const { call, driver } = setup();
  driver.createSpaceDelay = 20;
  const [a, b, c] = await Promise.all([
    call("nav.goto", { url: "https://a.example" }),
    call("tab.open", { url: "https://b.example" }),
    call("tab.open", {}),
  ]);
  assert.equal(a.at.space, "sp_0001");
  assert.equal(b.at.space, "sp_0001");
  assert.equal(c.at.space, "sp_0001");
  assert.equal((await call("space.list")).spaces.length, 1);
});

test("S-08: Space and tab limits", async () => {
  const { call } = setup({ maxSpaces: 2, maxTabsPerSpace: 2 });
  await call("space.create");
  await call("space.create");
  await rejectsWith(call("space.create"), "E_LIMIT", /2 agent Spaces/);
  await rejectsWith(call("nav.goto", { url: "https://x.example" }, { cwd: "/new" }), "E_LIMIT");
  await call("tab.open");
  await call("tab.open");
  await rejectsWith(call("tab.open"), "E_LIMIT", /2 tabs/);
});

test("S-09: only isolated Spaces exist in this version", async () => {
  const { call } = setup();
  for (const mode of ["cloned", "shared", "persistent"]) {
    await rejectsWith(call("space.create", { mode }), "E_UNSUPPORTED", new RegExp(mode));
  }
  const s = await call("space.create", { mode: "isolated", name: "research" });
  assert.equal(s.mode, "isolated");
  assert.equal(s.name, "research");
  assert.equal(s.sticky, true, "a new Space becomes the default for its agent and directory");
});

test("S-10: URLs agents may open", async () => {
  const { call } = setup();
  await rejectsWith(call("nav.goto", { url: "file:///C:/Windows/win.ini" }), "E_DENIED");
  await rejectsWith(call("nav.goto", { url: "chrome://settings" }), "E_DENIED");
  await rejectsWith(call("nav.goto", { url: "javascript:alert(1)" }), "E_DENIED");
  await rejectsWith(call("nav.goto", { url: "data:text/html,hi" }), "E_DENIED");
  await rejectsWith(call("tab.open", { url: "devtools://devtools/x" }), "E_DENIED");
  await rejectsWith(call("nav.goto", { url: "not a url" }), "E_INVALID_PARAMS");
  assert.deepEqual((await call("space.list")).spaces, [], "rejected URLs don't create a Space");
});

test("S-11: URL normalization", () => {
  const ok = (input: string) => {
    const r = normalizeAgentUrl(input);
    assert.ok(r.ok, `${input}: ${JSON.stringify(r)}`);
    return r.url;
  };
  assert.equal(ok("example.com"), "https://example.com/");
  assert.equal(ok("  https://example.com/a?b=1#c "), "https://example.com/a?b=1#c");
  assert.equal(ok("localhost:3000/app"), "http://localhost:3000/app");
  assert.equal(ok("127.0.0.1:8080"), "http://127.0.0.1:8080/");
  assert.equal(ok("HTTP://Example.COM"), "http://example.com/");
  assert.equal(ok("about:blank"), "about:blank");
  for (const bad of ["", "   ", "two words", "http://", "ftp://x.example", "view-source:https://x.example"]) {
    assert.equal(normalizeAgentUrl(bad).ok, false, bad);
  }
});

test("S-12: commands on one tab run in order; a slow command doesn't block another tab", async () => {
  const { call, driver } = setup();
  await call("nav.goto", { url: "https://a.example" });
  const tab1 = driver.tabs[0]!;
  let release!: () => void;
  tab1.onNavigate = () => new Promise((r) => (release = () => r({ status: 200 })));
  const slow = call("nav.goto", { url: "https://slow.example" });
  const read = call("page.text");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(tab1.log.slice(-1), ["navigate https://slow.example/ load"], "text waits for the navigation");

  // Another tab in the same Space is not blocked.
  const other = await call("tab.open", { url: "https://b.example" });
  assert.equal(other.at.tab, "t_2");
  release();
  await slow;
  assert.equal((await read).text, "Hello");
  assert.deepEqual(tab1.log.slice(-2), ["navigate https://slow.example/ load", "text"]);
});

test("S-13: a navigation that outlives its timeout returns E_TIMEOUT and stops the page", async () => {
  const { call, driver } = setup();
  await call("nav.goto", { url: "https://a.example" });
  driver.tabs[0]!.onNavigate = () => new Promise(() => {});
  await rejectsWith(call("nav.goto", { url: "https://hang.example" }, {}, 50), "E_TIMEOUT");
  assert.equal(driver.tabs[0]!.stopped, 1);
});

test("S-14: tabs: open, select, close, and the active tab", async () => {
  const { call, driver } = setup();
  await call("nav.goto", { url: "https://one.example" });
  await call("tab.open", { url: "https://two.example" });
  await call("tab.open", { url: "https://three.example" });
  let list = await call("tab.list");
  assert.deepEqual(list.tabs.map((t: any) => [t.id, t.active]), [["t_1", false], ["t_2", false], ["t_3", true]]);

  await call("tab.select", { tab: "t_1" });
  assert.equal((await call("page.text")).at.tab, "t_1", "commands go to the selected tab");
  assert.equal((await call("page.text", {}, { tab: "t_2" })).at.tab, "t_2", "ctx.tab targets a tab without selecting it");
  await rejectsWith(call("tab.select", { tab: "t_9" }), "E_NO_TAB", /t_9/);

  const closed = await call("tab.close", {}); // the active tab, t_1
  assert.equal(closed.closed, "t_1");
  assert.equal(closed.at.tab, "t_2", "the neighbour becomes active");
  assert.ok(driver.tabs[0]!.closed);
  await call("tab.close", { tab: "t_2" });
  const last = await call("tab.close", { tab: "t_3" });
  assert.equal(last.at, undefined);
  await rejectsWith(call("page.text"), "E_NO_TAB", /no tabs/);
  // goto opens a new tab in the now-empty Space.
  assert.equal((await call("nav.goto", { url: "https://four.example" })).at.tab, "t_4");
});

test("S-15: show and hide: only the active tab's window is visible, and it follows tab.select", async () => {
  const { call, driver } = setup();
  await call("nav.goto", { url: "https://one.example" });
  await call("tab.open", { url: "https://two.example" });
  const [t1, t2] = driver.tabs;
  assert.ok(!t1!.visible && !t2!.visible, "hidden by default");
  const shown = await call("space.show");
  assert.equal(shown.visible, true);
  assert.ok(!t1!.visible && t2!.visible);
  await call("tab.select", { tab: "t_1" });
  assert.ok(t1!.visible && !t2!.visible);
  // The human closes the window: it is hidden, and the Space is no longer visible.
  t1!.hide();
  t1!.events.onUserHide();
  assert.equal((await call("space.info")).visible, false);
  await call("space.show");
  await call("space.hide");
  assert.ok(!t1!.visible && !t2!.visible);
});

test("S-16: windows opened by a page become background tabs in the same Space", async () => {
  const { call, driver } = setup();
  await call("nav.goto", { url: "https://one.example" });
  driver.tabs[0]!.events.onPopup("https://popup.example/x");
  driver.tabs[0]!.events.onPopup("file:///etc/passwd"); // ignored
  await new Promise((r) => setTimeout(r, 10));
  const list = await call("tab.list");
  assert.deepEqual(list.tabs.map((t: any) => [t.id, t.url, t.active]), [
    ["t_1", "https://one.example/", true],
    ["t_2", "https://popup.example/x", false],
  ]);
  assert.deepEqual(driver.tabs[1]!.log, ["navigate https://popup.example/x none"]);
});

test("S-17: closing a Space closes its tabs, clears its storage, and forgets it", async () => {
  const { call, driver } = setup();
  await call("nav.goto", { url: "https://one.example" });
  await call("tab.open", { url: "https://two.example" });
  const r = await call("space.close");
  assert.deepEqual(r, { closed: "sp_0001", tabsClosed: 2 });
  assert.ok(driver.tabs.every((t) => t.closed));
  assert.deepEqual(driver.disposed, ["sp_0001"]);
  await rejectsWith(call("page.text"), "E_NO_SPACE");
  await rejectsWith(call("page.text", {}, { space: "sp_0001" }), "E_NO_SPACE");
  assert.equal((await call("nav.goto", { url: "https://three.example" })).at.space, "sp_0002");
});

test("S-18: a command queued behind a closed tab fails with E_NO_TAB", async () => {
  const { call, driver } = setup();
  await call("nav.goto", { url: "https://one.example" });
  let release!: () => void;
  driver.tabs[0]!.onNavigate = () => new Promise((r) => (release = () => r({})));
  const nav = call("nav.goto", { url: "https://slow.example" });
  const read = call("page.text");
  await new Promise((r) => setTimeout(r, 10));
  await call("tab.close");
  release();
  await nav;
  await rejectsWith(read, "E_NO_TAB", /closed/);
});

test("S-19: a tab that goes away on its own is removed", async () => {
  const { call, driver } = setup();
  await call("nav.goto", { url: "https://one.example" });
  await call("tab.open", { url: "https://two.example" });
  driver.tabs[1]!.events.onGone();
  const list = await call("tab.list");
  assert.deepEqual(list.tabs.map((t: any) => [t.id, t.active]), [["t_1", true]]);
});

test("S-20: capture writes the image to the capture folder", async () => {
  const { call, captureDir } = setup();
  await call("nav.goto", { url: "https://one.example" });
  const r = await call("page.capture", { fullPage: true, format: "jpeg" });
  assert.ok(r.path.startsWith(captureDir));
  assert.match(r.path, /sp_0001-t_1-.*\.jpg$/);
  assert.ok(existsSync(r.path));
  assert.equal(readFileSync(r.path, "utf8"), "fake-image");
  assert.deepEqual([r.format, r.width, r.height, r.bytes, r.truncated], ["jpeg", 1280, 3000, 10, false]);
  const png = await call("page.capture");
  assert.match(png.path, /\.png$/);
});

test("S-21: text: default limit, maxChars, and truncation at a line break", async () => {
  const { call, driver } = setup();
  await call("nav.goto", { url: "https://one.example" });
  driver.tabs[0]!.text = ("x".repeat(99) + "\n").repeat(300); // 30,000 chars
  const r = await call("page.text");
  assert.equal(r.chars, 30_000);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 20_000 && r.text.length > 19_800, String(r.text.length));
  assert.ok(r.text.endsWith("x"), "cut at a line break");
  assert.equal(r.hiddenOmitted, 2);
  const small = await call("page.text", { maxChars: 150 });
  assert.equal(small.text.length, 150, "the last line break is too far back, so the cut is exact");
  const near = await call("page.text", { maxChars: 210 });
  assert.equal(near.text.length, 199, "cut at the line break at 200");

  assert.deepEqual(truncateText("short", 100), { text: "short", truncated: false });
  assert.deepEqual(truncateText("abcdefghij", 4), { text: "abcd", truncated: true });
});

test("S-22: back, forward, and reload report whether history moved", async () => {
  const { call } = setup();
  await call("nav.goto", { url: "https://one.example" });
  const back = await call("nav.back");
  assert.equal(back.moved, true);
  const fwd = await call("nav.forward");
  assert.equal(fwd.moved, false);
  const reload = await call("nav.reload");
  assert.equal(reload.moved, undefined);
  assert.equal(reload.status, 200);
});

test("S-23: counts and disposeAll", async () => {
  const { svc, call, driver } = setup();
  await call("nav.goto", { url: "https://one.example" });
  await call("tab.open");
  await call("nav.goto", { url: "https://x.example" }, { agent: "codex" });
  assert.deepEqual(svc.counts(), { agentSpaces: 2, agentTabs: 3 });
  svc.disposeAll();
  assert.deepEqual(svc.counts(), { agentSpaces: 0, agentTabs: 0 });
  assert.ok(driver.tabs.every((t) => t.closed));
});
