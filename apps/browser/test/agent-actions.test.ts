// M2 service routing with a fake driver (snapshots, actions, dialogs, uploads, waits, downloads), plus the pure
// key parser and URL glob. Case IDs are from docs/testing/M2-test-cases.md.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentContext, DialogInfo, DownloadInfo, WaitParams } from "@agb/protocol";
import { globMatch } from "../src/main/agent/electron-driver";
import { AgentError } from "../src/main/agent/errors";
import { charKey, modifierBits, parseCombo } from "../src/main/agent/keys";
import {
  AgentService,
  type ActionOutcome,
  type ActionRequest,
  type AgentDriver,
  type SnapshotRequest,
  type SpaceBackend,
  type TabBackend,
  type TabEvents,
  type TabSpec,
} from "../src/main/agent/service";

class FakeTab implements TabBackend {
  dialog: DialogInfo | undefined;
  actions: ActionRequest[] = [];
  snapshots: SnapshotRequest[] = [];
  waits: WaitParams[] = [];
  onAct: (req: ActionRequest) => Promise<ActionOutcome> = async (req) => ({ action: req.kind === "dialog" ? "accept" : req.kind, changes: ['+ alert "Saved" @e9'] });
  constructor(readonly spec: TabSpec, readonly events: TabEvents) {}
  url = () => "https://example.com/";
  title = () => "Example";
  loading = () => false;
  navigate = async () => ({ status: 200 });
  history = async () => ({ moved: true });
  stop() {}
  capture = async () => ({ data: Buffer.from("x"), width: 1, height: 1, truncated: false });
  readText = async () => ({ text: "t", hiddenOmitted: 0 });
  show = () => ({ x: 0, y: 0 });
  hide() {}
  close() {}
  async snapshot(req: SnapshotRequest) {
    this.snapshots.push(req);
    return { text: 'button "OK" @e1', refs: 1, tokens: 5, hiddenOmitted: 0, collapsed: 0, scroll: { y: 0, maxY: 0, viewportHeight: 800 } };
  }
  async act(req: ActionRequest) {
    this.actions.push(req);
    return this.onAct(req);
  }
  async waitFor(p: WaitParams) {
    this.waits.push(p);
    return { matched: "text present" };
  }
  pendingDialog() {
    return this.dialog;
  }
}

function setup() {
  const tabs: FakeTab[] = [];
  const downloadDirs: string[] = [];
  const driver: AgentDriver = {
    async createSpace(id): Promise<SpaceBackend> {
      const downloadDir = mkdtempSync(join(tmpdir(), "agb-dl-"));
      downloadDirs.push(downloadDir);
      const list: DownloadInfo[] = [{ id: "d_1", url: "https://x/r.pdf", filename: "r.pdf", path: join(downloadDir, "r.pdf"), state: "completed", bytes: 3 }];
      return {
        partition: `p-${id}`,
        downloadDir,
        downloads: () => list,
        waitDownload: async (did) => {
          const d = list.find((x) => !did || x.id === did);
          if (!d) throw new AgentError("E_INVALID_PARAMS", `no download ${did}`);
          return d;
        },
        dispose: async () => {},
      };
    },
    async createTab(spec, events) {
      const t = new FakeTab(spec, events);
      tabs.push(t);
      return t;
    },
  };
  const svc = new AgentService(driver, { captureDir: mkdtempSync(join(tmpdir(), "agb-cap-")), randomId: () => "0001" });
  const work = mkdtempSync(join(tmpdir(), "agb-work-"));
  const call = (method: string, params: unknown = {}, ctx: AgentContext = {}): Promise<any> =>
    svc.handle(method, params, { agent: "claude-code", cwd: work, ...ctx }, 10_000);
  return { svc, tabs, call, work, downloadDirs };
}

async function rejectsWith(p: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof AgentError, String(e));
    assert.equal(e.code, code, e.message);
    if (message) assert.match(e.message, message);
    return true;
  });
}

test("Q-01: snapshot and actions need a page; they never create a Space", async () => {
  const { call, tabs } = setup();
  for (const [m, p] of [["page.snapshot", {}], ["page.click", { ref: "@e1" }], ["page.fill", { ref: "@e1", text: "x" }], ["wait.for", { ms: 1 }], ["dialog.list", {}], ["download.list", {}]] as const) {
    await rejectsWith(call(m, p), "E_NO_SPACE");
  }
  assert.equal(tabs.length, 0);
});

test("Q-02: snapshot passes its options and returns the location", async () => {
  const { call, tabs } = setup();
  await call("nav.goto", { url: "https://example.com" });
  const r = await call("page.snapshot", { mode: "full", scope: "@e3", maxTokens: 500, diff: true });
  assert.deepEqual(tabs[0]!.snapshots, [{ mode: "full", scope: "@e3", maxTokens: 500, diff: true }]);
  assert.equal(r.at.tab, "t_1");
  assert.equal(r.text, 'button "OK" @e1');
});

test("Q-03: each action method becomes the right request", async () => {
  const { call, tabs } = setup();
  await call("nav.goto", { url: "https://example.com" });
  await call("page.click", { ref: "@e1", button: "right", count: 2, modifiers: ["Control"], snapshot: true });
  await call("page.hover", { ref: "@e2" });
  await call("page.fill", { ref: "@e3", text: "hi", submit: true, clear: false });
  await call("page.type", { text: "abc" });
  await call("page.press", { keys: "Control+A", ref: "@e3" });
  await call("page.select", { ref: "@e4", values: ["Kenya"] });
  await call("page.check", { ref: "@e5" });
  await call("page.uncheck", { ref: "@e5" });
  await call("page.scroll", { page: "down" });
  await call("dialog.dismiss", { text: "ignored" });
  assert.deepEqual(tabs[0]!.actions, [
    { kind: "click", ref: "@e1", button: "right", count: 2, snapshot: true, modifiers: ["Control"] },
    { kind: "hover", ref: "@e2" },
    { kind: "fill", ref: "@e3", text: "hi", submit: true, clear: false },
    { kind: "type", text: "abc" },
    { kind: "press", keys: "Control+A", ref: "@e3" },
    { kind: "select", ref: "@e4", values: ["Kenya"] },
    { kind: "check", ref: "@e5" },
    { kind: "uncheck", ref: "@e5" },
    { kind: "scroll", page: "down" },
    { kind: "dialog", accept: false, text: "ignored" },
  ]);
});

test("Q-04: action results carry the location, changes, and duration", async () => {
  const { call } = setup();
  await call("nav.goto", { url: "https://example.com" });
  const r = await call("page.click", { ref: "@e1" });
  assert.deepEqual(r.at, { space: "sp_0001", tab: "t_1", url: "https://example.com/", title: "Example" });
  assert.deepEqual(r.changes, ['+ alert "Saved" @e9']);
  assert.equal(r.action, "click");
  assert.equal(typeof r.durationMs, "number");
  assert.equal(r.opened, undefined);
});

test("Q-05: a dialog blocks page commands with E_DIALOG_OPEN, but not capture or dialog answers", async () => {
  const { call, tabs } = setup();
  await call("nav.goto", { url: "https://example.com" });
  tabs[0]!.dialog = { type: "confirm", message: "Delete it?" };
  for (const [m, p] of [["page.snapshot", {}], ["page.click", { ref: "@e1" }], ["page.text", {}], ["nav.goto", { url: "https://x.example" }], ["nav.back", {}], ["wait.for", { ms: 1 }]] as const) {
    await rejectsWith(call(m, p), "E_DIALOG_OPEN", /confirm dialog is open: "Delete it\?"/);
  }
  assert.ok((await call("page.capture")).path);
  assert.deepEqual((await call("dialog.list")).dialog, { type: "confirm", message: "Delete it?" });
  await call("dialog.accept", { text: "yes" });
  assert.deepEqual(tabs[0]!.actions.at(-1), { kind: "dialog", accept: true, text: "yes" });
});

test("Q-06: tabs a page opens during an action are reported, and --follow selects the first", async () => {
  const { call, tabs } = setup();
  await call("nav.goto", { url: "https://example.com" });
  tabs[0]!.onAct = async (req) => {
    tabs[0]!.events.onPopup("https://popup.example/");
    return { action: req.kind, changes: [] };
  };
  const r = await call("page.click", { ref: "@e1" });
  assert.deepEqual(r.opened, ["t_2"]);
  assert.equal(r.at.tab, "t_1", "the opener stays active");
  const followed = await call("page.click", { ref: "@e1", follow: true });
  assert.deepEqual(followed.opened, ["t_3"]);
  assert.equal(followed.at.tab, "t_3");
  assert.equal((await call("tab.list")).tabs.find((t: any) => t.active).id, "t_3");
});

test("Q-07: uploads take existing files from the working directory or the Space's downloads only", async () => {
  const { call, tabs, work, downloadDirs } = setup();
  await call("nav.goto", { url: "https://example.com" });
  writeFileSync(join(work, "cv.pdf"), "x");
  await call("page.upload", { ref: "@e1", files: ["cv.pdf"] });
  assert.deepEqual(tabs[0]!.actions.at(-1), { kind: "upload", ref: "@e1", files: [join(work, "cv.pdf")] });
  writeFileSync(join(downloadDirs[0]!, "r.pdf"), "x");
  await call("page.upload", { ref: "@e1", files: [join(downloadDirs[0]!, "r.pdf")] });
  const outside = join(mkdtempSync(join(tmpdir(), "agb-elsewhere-")), "secret.txt");
  writeFileSync(outside, "x");
  await rejectsWith(call("page.upload", { ref: "@e1", files: [outside] }), "E_DENIED", /outside the working directory/);
  await rejectsWith(call("page.upload", { ref: "@e1", files: ["../escape.txt"] }), "E_DENIED");
  await rejectsWith(call("page.upload", { ref: "@e1", files: ["missing.pdf"] }), "E_INVALID_PARAMS", /not a file/);
  await rejectsWith(call("page.upload", { ref: "@e1", files: [] }), "E_INVALID_PARAMS");
  await rejectsWith(call("page.upload", { ref: "@e1", files: ["."] }), "E_DENIED", /outside/);
});

test("Q-08: wait validates its conditions", async () => {
  const { call, tabs } = setup();
  await call("nav.goto", { url: "https://example.com" });
  await rejectsWith(call("wait.for", {}), "E_INVALID_PARAMS", /nothing to wait for/);
  await rejectsWith(call("wait.for", { text: "a", url: "*b" }), "E_INVALID_PARAMS", /one thing at a time/);
  await rejectsWith(call("wait.for", { gone: true }), "E_INVALID_PARAMS", /--gone needs/);
  const r = await call("wait.for", { text: "Saved", ms: 100 });
  assert.equal(r.matched, "text present");
  assert.deepEqual(tabs[0]!.waits, [{ text: "Saved", ms: 100 }]);
});

test("Q-09: downloads are listed and waited for per Space", async () => {
  const { call } = setup();
  await call("nav.goto", { url: "https://example.com" });
  assert.deepEqual((await call("download.list")).downloads.map((d: DownloadInfo) => d.id), ["d_1"]);
  assert.equal((await call("download.wait", {})).download.id, "d_1");
  await rejectsWith(call("download.wait", { id: "d_9" }), "E_INVALID_PARAMS");
});

test("Q-10: key combinations", () => {
  assert.deepEqual(parseCombo("Enter"), { modifiers: [], key: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" } });
  const ctrlA = parseCombo("Control+A");
  assert.deepEqual(ctrlA.modifiers, ["Control"]);
  assert.equal(ctrlA.key.code, "KeyA");
  assert.equal(ctrlA.key.key, "a", "Control+A sends the a key, not a capital");
  assert.deepEqual(parseCombo("ctrl+shift+tab").modifiers, ["Control", "Shift"]);
  assert.equal(parseCombo("esc").key.key, "Escape");
  assert.equal(parseCombo("Control++").key.key, "+");
  assert.equal(parseCombo("F5").key.keyCode, 116);
  assert.throws(() => parseCombo("Enter+A"), /isn't a modifier/);
  assert.throws(() => parseCombo("Bogus"), /unknown key/);
  assert.equal(modifierBits(["Alt", "Control", "Meta", "Shift"]), 15);
});

test("Q-11: characters map to US-keyboard keys; others are inserted as text", () => {
  assert.deepEqual(charKey("a"), { key: "a", code: "KeyA", keyCode: 65, text: "a" });
  assert.deepEqual(charKey("A"), { key: "A", code: "KeyA", keyCode: 65, text: "A", shift: true });
  assert.deepEqual(charKey("@"), { key: "@", code: "Digit2", keyCode: 50, text: "@", shift: true });
  assert.equal(charKey("?")!.code, "Slash");
  assert.equal(charKey("\n")!.key, "Enter");
  assert.equal(charKey("é"), undefined);
  assert.equal(charKey("日"), undefined);
});

test("Q-12: URL globs for wait --url", () => {
  assert.ok(globMatch("*/next", "http://site/next"));
  assert.ok(globMatch("https://*.example.com/*", "https://app.example.com/a/b"));
  assert.ok(!globMatch("*/next", "http://site/next/page"));
  assert.ok(globMatch("/checkout", "https://shop.example/checkout?step=2"), "no wildcards: substring");
  assert.ok(globMatch("http://site/a?b", "http://site/a1b"), "? matches one character");
});
