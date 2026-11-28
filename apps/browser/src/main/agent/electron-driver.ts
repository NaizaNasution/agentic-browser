// Electron side of agent Spaces (docs/SPEC.md §7.2–7.3, §10, §11).
//
// Each agent tab is its own BrowserWindow, shown (inactive, never focused, not in the taskbar) at an off-screen
// position. "Showing" a Space to the human moves its active tab's window on-screen; hiding moves it back.
//
// Why not a hidden window: Chromium throttles a hidden window to about 1 frame per second once it receives input,
// so requestAnimationFrame, IntersectionObserver, and lazy loading stall and every pointer event waits ~0.8 s for a
// frame. A shown window keeps rendering normally, as long as Chromium's native occlusion tracking doesn't mark it
// covered; index.ts turns that off (CalculateNativeWinOcclusion). Measured in M2: docs/testing/M2-test-cases.md.
//
// CDP goes through webContents.debugger, so no remote-debugging port is ever opened. Cross-site iframes run in
// their own renderer; they are attached as flat CDP sessions (Target.setAutoAttach) and addressed by session ID.
import { BrowserWindow, screen, session as electronSession, type DownloadItem, type WebContents } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { DialogInfo, DownloadInfo, SnapshotResult, WaitParams } from "@agb/protocol";
import { Actor, ELEMENT_FUNCTIONS as FN, type ActorHost, type FrameRef, type Target } from "./actions";
import { AgentError, tabClosed, timedOut } from "./errors";
import { extractReadableText, type ReadableText } from "./readable-text";
import { buildSnapshot, type DiffLine } from "./snapshot/build";
import { diffSnapshots, formatChanges } from "./snapshot/diff";
import { assemblePage } from "./snapshot/layout";
import { RefTable } from "./snapshot/refs";
import { SNAPSHOT_STYLES, type PageData, type RawPage } from "./snapshot/types";
import type {
  ActionOutcome,
  ActionRequest,
  AgentDriver,
  SnapshotRequest,
  SpaceBackend,
  SpaceMode,
  TabBackend,
  TabEvents,
  TabSpec,
  WaitUntil,
} from "./service";

/** Longest full-page capture, in device pixels (Chromium's texture limit). */
const MAX_FULL_PAGE_HEIGHT = 16_384;
/** networkidle: no requests in flight for this long. */
const NETWORK_IDLE_MS = 500;
/** After an aborted main-frame load (ERR_ABORTED), how long to wait for a replacement navigation to commit. */
const ABORT_GRACE_MS = 1500;
/** After an action: how long to wait at most for the network and DOM to go quiet (§11.4). */
const SETTLE_MAX_MS = 1500;
const QUIET_MS = 300;
/** After an action that navigates: how long to wait at most for the new page to load. */
const ACTION_NAV_MAX_MS = 15_000;
/** Lines of changes reported after an action. */
const MAX_CHANGES = 12;
const DEFAULT_SNAPSHOT_TOKENS = 4000;
/** Where agent windows live while the human isn't looking: off every monitor (Windows allows ±32767). */
const OFF_SCREEN = { x: -32000, y: -32000 };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface DriverOptions {
  log?: (message: string) => void;
  /** Root of the download sandboxes: `<root>/<agent>/<space>/` (SPEC §15.6). */
  downloadsRoot: string;
}

// ---------- downloads ----------

interface DownloadRec {
  info: DownloadInfo;
  done: Promise<void>;
}

class SpaceDownloads {
  readonly items: DownloadRec[] = [];
  private seq = 0;
  private listeners = new Set<(d: DownloadInfo) => void>();

  constructor(readonly dir: string) {}

  add(item: DownloadItem, tab: string | undefined): void {
    mkdirSync(this.dir, { recursive: true });
    const path = uniquePath(this.dir, safeFileName(item.getFilename() || "download"));
    item.setSavePath(path);
    const info: DownloadInfo = {
      id: `d_${++this.seq}`,
      ...(tab ? { tab } : {}),
      url: item.getURL(),
      filename: basename(path),
      path,
      state: "progressing",
      bytes: 0,
      ...(item.getTotalBytes() > 0 ? { totalBytes: item.getTotalBytes() } : {}),
    };
    const done = new Promise<void>((resolve) => {
      item.on("updated", () => {
        info.bytes = item.getReceivedBytes();
        if (item.getTotalBytes() > 0) info.totalBytes = item.getTotalBytes();
      });
      item.once("done", (_e, state) => {
        info.bytes = item.getReceivedBytes();
        info.state = state;
        resolve();
      });
    });
    this.items.push({ info, done });
    for (const l of this.listeners) l(info);
  }

  onStart(cb: (d: DownloadInfo) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async wait(id: string | undefined, deadline: number): Promise<DownloadInfo> {
    const rec = id ? this.items.find((d) => d.info.id === id) : this.items[this.items.length - 1];
    if (!rec) {
      throw new AgentError(id ? "E_INVALID_PARAMS" : "E_NO_TAB", id ? `no download ${id} in this Space` : "nothing has been downloaded in this Space", "see `agb download list`");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([rec.done, new Promise<void>((_, rej) => (timer = setTimeout(() => rej(timedOut("the download")), Math.max(0, deadline - Date.now()))))]).finally(() => clearTimeout(timer));
    return rec.info;
  }
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "_").slice(0, 150);
  return cleaned || "download";
}

function uniquePath(dir: string, name: string): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let p = join(dir, name);
  for (let i = 2; existsSync(p); i++) p = join(dir, `${stem} (${i})${ext}`);
  return p;
}

// ---------- driver ----------

export class ElectronAgentDriver implements AgentDriver {
  private readonly log: (message: string) => void;
  private readonly downloads = new Map<string, SpaceDownloads>();
  private readonly tabsByContents = new Map<number, string>();

  constructor(private readonly opts: DriverOptions) {
    this.log = opts.log ?? (() => {});
  }

  async createSpace(id: string, mode: SpaceMode, agent: string): Promise<SpaceBackend> {
    if (mode !== "isolated") throw new AgentError("E_UNSUPPORTED", `${mode} Spaces aren't available yet`);
    // No "persist:" prefix: an in-memory partition, thrown away with the Space.
    const partition = `agb-space-${id}`;
    const ses = electronSession.fromPartition(partition);
    // Deny-by-default until the policy engine exists (SPEC §15).
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    const downloads = new SpaceDownloads(join(this.opts.downloadsRoot, safeFileName(agent), id));
    this.downloads.set(id, downloads);
    const onDownload = (_event: Electron.Event, item: DownloadItem, wc: WebContents) => {
      downloads.add(item, this.tabsByContents.get(wc.id));
      this.log(`space ${id}: downloading ${item.getURL()}`);
    };
    ses.on("will-download", onDownload);
    return {
      partition,
      downloadDir: downloads.dir,
      downloads: () => downloads.items.map((d) => ({ ...d.info })),
      waitDownload: (did, deadline) => downloads.wait(did, deadline),
      dispose: async () => {
        ses.off("will-download", onDownload);
        this.downloads.delete(id);
        await ses.clearStorageData();
        await ses.clearCache();
      },
    };
  }

  async createTab(spec: TabSpec, events: TabEvents): Promise<TabBackend> {
    const downloads = this.downloads.get(spec.spaceId);
    const tab = new ElectronTab(spec, events, this.log, downloads);
    this.tabsByContents.set(tab.contentsId, spec.tabId);
    tab.onClosed = () => this.tabsByContents.delete(tab.contentsId);
    try {
      await tab.init();
    } catch (e) {
      tab.close();
      throw e;
    }
    return tab;
  }
}

// ---------- tab ----------

interface PendingDialog extends DialogInfo {
  session: string;
}

class ElectronTab implements TabBackend, ActorHost {
  private readonly win: BrowserWindow;
  private readonly wc: WebContents;
  readonly contentsId: number;
  onClosed?: () => void;
  private disposed = false;
  private shownToHuman = false;
  /** Requests in flight, by request ID (a cross-site iframe's document request starts in the parent's session and ends in its own). */
  private readonly inflight = new Map<string, number>();
  private lastNetworkChange = Date.now();
  /** Rejects pending waits when the tab is closed. */
  private readonly onDispose = new Set<() => void>();

  // CDP sessions of cross-site iframes ("" is the root session).
  private readonly sessions = new Set<string>();
  private frames = new Map<string, FrameRef>();
  private readonly worlds = new Map<string, number>();

  readonly refs = new RefTable();
  private baseline: DiffLine[] | undefined;
  private navStarts = 0;
  private navCommits = 0;
  private dialog: PendingDialog | undefined;
  /**
   * Dialogs this tab answered itself whose Page.javascriptDialogClosed hasn't arrived yet. That event can come
   * after the next dialog's Page.javascriptDialogOpening (an alert() followed at once by a confirm(), on a slow
   * machine), so it must not clear the newer dialog.
   */
  private answeredDialogs = 0;
  private readonly dialogListeners = new Set<(d: DialogInfo) => void>();
  private readonly chooserListeners = new Set<(e: { backendNodeId: number; session: string }) => void>();
  private readonly actor: Actor;
  readonly platform = process.platform;

  constructor(
    private readonly spec: TabSpec,
    private readonly events: TabEvents,
    private readonly log: (message: string) => void,
    private readonly downloads: SpaceDownloads | undefined,
  ) {
    this.win = new BrowserWindow({
      width: spec.viewport.width,
      height: spec.viewport.height,
      x: OFF_SCREEN.x,
      y: OFF_SCREEN.y,
      useContentSize: true,
      show: false,
      paintWhenInitiallyHidden: true,
      focusable: false,
      skipTaskbar: true,
      resizable: false, // the viewport is fixed by the Space (SPEC §7.3)
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      backgroundColor: "#ffffff",
      title: this.windowTitle(),
      webPreferences: {
        partition: spec.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    this.win.setMenu(null); // the app menu's shortcuts act on the human's tabs, not here
    // Shown but off-screen and never activated: it keeps rendering at full speed and takes no focus.
    this.win.showInactive();
    this.win.setPosition(OFF_SCREEN.x, OFF_SCREEN.y);
    this.wc = this.win.webContents;
    this.contentsId = this.wc.id;
    this.actor = new Actor(this);

    // The human closing the window moves it back off-screen; only the agent (or app quit) closes the tab.
    this.win.on("close", (e) => {
      if (this.disposed) return;
      e.preventDefault();
      this.hide();
      this.events.onUserHide();
    });
    this.wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) this.events.onPopup(url);
      return { action: "deny" };
    });
    this.wc.on("page-title-updated", () => this.win.setTitle(this.windowTitle()));
    // "Leave site?" never blocks an agent.
    this.wc.on("will-prevent-unload", (e) => e.preventDefault());
    this.wc.on("render-process-gone", (_e, details) => this.log(`space ${spec.spaceId}: renderer gone (${details.reason})`));
    this.wc.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.navStarts++;
    });
    this.wc.on("did-navigate", () => {
      // A new document: refs start again at @e1 (§10.3).
      this.navCommits++;
      this.refs.reset();
      this.baseline = undefined;
      this.worlds.clear();
      this.dialog = undefined;
      this.answeredDialogs = 0;
    });
    this.wc.on("did-frame-navigate", () => this.worlds.clear());
    this.wc.on("destroyed", () => {
      if (!this.disposed) {
        this.dispose();
        this.events.onGone();
      }
    });
  }

  /** Loads about:blank (CDP needs a renderer) and attaches the debugger. */
  async init(): Promise<void> {
    await this.wc.loadURL("about:blank");
    const dbg = this.wc.debugger;
    dbg.attach("1.3");
    dbg.on("message", (_e, method, params, sessionId) => this.onCdpEvent(method, params, sessionId ?? ""));
    dbg.on("detach", (_e, reason) => {
      if (!this.disposed) this.log(`space ${this.spec.spaceId}: debugger detached (${reason})`);
    });
    await this.enableSession("");
    await this.pinViewport();
  }

  /**
   * Sets the page's viewport to the Space's (SPEC §7.3) through device emulation, whatever size the OS lets the
   * window be: Windows shrinks a window that is bigger than the screen (1280x800 became 1008x681 on a 1024x768
   * CI runner). capturePage and CDP input both follow the emulated size, even beyond the real window.
   */
  private pinViewport(height = this.spec.viewport.height): Promise<unknown> {
    return this.cdp("Emulation.setDeviceMetricsOverride", { width: this.spec.viewport.width, height, deviceScaleFactor: 0, mobile: false });
  }

  private async enableSession(session: string): Promise<void> {
    await Promise.all([
      this.cdp("Page.enable", {}, session),
      this.cdp("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, session),
      this.cdp("Page.setInterceptFileChooserDialog", { enabled: true }, session),
      this.cdp("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "iframe", exclude: false }] }, session),
    ]);
    if (session) await this.cdp("Runtime.runIfWaitingForDebugger", {}, session).catch(() => {});
  }

  // ---------- TabBackend: M1 ----------

  url(): string {
    return this.disposed ? "" : this.wc.getURL();
  }

  title(): string {
    if (this.disposed) return "";
    const url = this.wc.getURL();
    const title = this.wc.getTitle();
    return !url || url === "about:blank" ? "" : title === url ? "" : title;
  }

  loading(): boolean {
    return !this.disposed && this.wc.isLoading();
  }

  pendingDialog(): DialogInfo | undefined {
    if (!this.dialog) return undefined;
    const { session: _s, ...info } = this.dialog;
    return info;
  }

  navigate(url: string, wait: WaitUntil, deadline: number): Promise<{ status?: number; dialog?: DialogInfo }> {
    return this.waitForLoad(wait, deadline, () => void this.wc.loadURL(url).catch(() => {}), url);
  }

  async history(action: "back" | "forward" | "reload", wait: WaitUntil, deadline: number): Promise<{ moved: boolean; status?: number; dialog?: DialogInfo }> {
    const h = this.wc.navigationHistory;
    if (action === "back" && !h.canGoBack()) return { moved: false };
    if (action === "forward" && !h.canGoForward()) return { moved: false };
    const start = action === "back" ? () => h.goBack() : action === "forward" ? () => h.goForward() : () => this.wc.reload();
    const r = await this.waitForLoad(wait, deadline, start);
    return { moved: true, ...r };
  }

  stop(): void {
    if (!this.disposed) this.wc.stop();
  }

  async capture(opts: { fullPage: boolean; format: "png" | "jpeg"; quality: number }, deadline: number) {
    this.assertOpen();
    if (!opts.fullPage) {
      const img = await this.until(deadline, "capture", this.wc.capturePage(undefined, { stayHidden: true }));
      if (img.isEmpty()) throw new AgentError("E_INTERNAL", "the capture came back empty", "try again after the page finishes loading");
      const { width, height } = img.getSize();
      const data = opts.format === "jpeg" ? img.toJPEG(opts.quality) : img.toPNG();
      return { data, width, height, truncated: false };
    }
    // Full page: grow the emulated viewport to the page's height, capture, then restore. (CDP's
    // Page.captureScreenshot never answers for a hidden window, so capturePage is used for both modes.)
    const metrics = await this.until(deadline, "capture", this.cdp("Page.getLayoutMetrics"));
    const dpr = (await this.evaluate("window.devicePixelRatio", deadline)) as number;
    const fullHeight = Math.ceil(metrics.cssContentSize?.height ?? this.spec.viewport.height);
    const maxHeight = Math.floor(MAX_FULL_PAGE_HEIGHT / Math.max(1, dpr || 1));
    const height = Math.max(this.spec.viewport.height, Math.min(fullHeight, maxHeight));
    await this.pinViewport(height);
    try {
      await this.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))", deadline, true);
      const img = await this.until(deadline, "capture", this.wc.capturePage(undefined, { stayHidden: true }));
      if (img.isEmpty()) throw new AgentError("E_INTERNAL", "the capture came back empty", "try again after the page finishes loading");
      const size = img.getSize();
      const data = opts.format === "jpeg" ? img.toJPEG(opts.quality) : img.toPNG();
      return { data, width: size.width, height: size.height, truncated: fullHeight > height };
    } finally {
      await this.pinViewport().catch(() => {}); // back to the Space's viewport (clearing would fall back to the window's size)
    }
  }

  async readText(deadline: number): Promise<ReadableText> {
    this.assertOpen();
    // Isolated world: the page's own scripts can't change what the extractor sees or does.
    return (await this.evaluate(`(${extractReadableText.toString()})()`, deadline)) as ReadableText;
  }

  /** Moves the window on-screen (where it was last shown, or centered on the primary display), without focus. */
  show(position?: { x: number; y: number }): { x: number; y: number } {
    this.assertOpen();
    let p = position;
    if (!p) {
      const area = screen.getPrimaryDisplay().workArea;
      const [w = 0, h = 0] = this.win.getSize();
      p = { x: Math.round(area.x + Math.max(0, (area.width - w) / 2)), y: Math.round(area.y + Math.max(0, (area.height - h) / 2)) };
    }
    this.win.setPosition(p.x, p.y);
    if (!this.win.isVisible()) this.win.showInactive();
    this.shownToHuman = true;
    return p;
  }

  /** Moves the window back off-screen. It stays shown, so the page keeps rendering. */
  hide(): void {
    if (this.disposed || !this.shownToHuman) return;
    this.win.setPosition(OFF_SCREEN.x, OFF_SCREEN.y);
    this.shownToHuman = false;
  }

  close(): void {
    if (this.disposed) return;
    this.dispose();
    try {
      if (this.wc.debugger.isAttached()) this.wc.debugger.detach();
    } catch {
      /* already detached */
    }
    this.win.destroy();
  }

  // ---------- page collection and snapshots (§10) ----------

  /** Frames of the root session and every cross-site iframe session, with AX trees, layout, and owners. */
  private async collectRaw(deadline: number): Promise<RawPage> {
    this.assertOpen();
    type F = RawPage["frames"][number];
    const flat = (ft: any, session: string, acc: Omit<F, "ax">[]) => {
      acc.push({ frameId: ft.frame.id, ...(ft.frame.parentId ? { parentFrameId: ft.frame.parentId } : {}), url: ft.frame.url, session });
      for (const c of ft.childFrames ?? []) flat(c, session, acc);
      return acc;
    };
    const sessions = ["", ...this.sessions];
    const trees = await Promise.all(
      sessions.map((s) =>
        this.until(deadline, "snapshot", this.cdp("Page.getFrameTree", {}, s)).then(
          (r) => flat(r.frameTree, s, []),
          () => [] as Omit<F, "ax">[], // a frame session that just went away
        ),
      ),
    );
    const frameList = trees.flat();
    const [axes, snaps, metrics] = await Promise.all([
      Promise.all(frameList.map((f) => this.until(deadline, "snapshot", this.cdp("Accessibility.getFullAXTree", { frameId: f.frameId }, f.session)).then((r) => r.nodes, () => []))),
      Promise.all(sessions.map((s) => this.until(deadline, "snapshot", this.cdp("DOMSnapshot.captureSnapshot", { computedStyles: [...SNAPSHOT_STYLES] }, s)).catch(() => undefined))),
      this.until(deadline, "snapshot", this.cdp("Page.getLayoutMetrics")),
    ]);
    const sessionOf = new Map(frameList.map((f) => [f.frameId, f.session]));
    const owners: Record<string, number> = {};
    await Promise.all(
      frameList
        .filter((f) => f.parentFrameId)
        .map(async (f) => {
          const parentSession = sessionOf.get(f.parentFrameId!) ?? "";
          try {
            owners[f.frameId] = (await this.cdp("DOM.getFrameOwner", { frameId: f.frameId }, parentSession)).backendNodeId;
          } catch {
            /* detached meanwhile */
          }
        }),
    );
    const snapshots: RawPage["snapshots"] = {};
    sessions.forEach((s, i) => {
      if (snaps[i]) snapshots[s] = snaps[i];
    });
    const vp = metrics.cssLayoutViewport ?? {};
    return {
      frames: frameList.map((f, i) => ({ ...f, ax: axes[i] ?? [] })),
      snapshots,
      owners,
      viewport: { width: vp.clientWidth ?? this.spec.viewport.width, height: vp.clientHeight ?? this.spec.viewport.height, scrollX: vp.pageX ?? 0, scrollY: vp.pageY ?? 0 },
    };
  }

  async collect(deadline: number): Promise<PageData> {
    const page = assemblePage(await this.collectRaw(deadline));
    this.frames = new Map(page.frames.map((f) => [f.frameId, { session: f.session, ...(f.parentFrameId ? { parentFrameId: f.parentFrameId } : {}), ...(f.ownerBackendId !== undefined ? { ownerBackendId: f.ownerBackendId } : {}) }]));
    return page;
  }

  frame(frameId: string): FrameRef | undefined {
    return this.frames.get(frameId);
  }

  async snapshot(req: SnapshotRequest, deadline: number): Promise<Omit<SnapshotResult, "at">> {
    const page = await this.collect(deadline);
    const maxTokens = req.maxTokens ?? DEFAULT_SNAPSHOT_TOKENS;
    const r = buildSnapshot(page, this.refs, { mode: req.mode ?? "interactive", ...(req.scope ? { scope: req.scope } : {}), maxTokens });
    if (req.scope && !r.scopeFound) {
      throw this.refs.get(req.scope)
        ? new AgentError("E_STALE_REF", `${req.scope} is no longer on the page`, "run `agb snapshot` again and use the new ref")
        : new AgentError("E_NO_REF", `no ${req.scope} on this page`, "run `agb snapshot` and use a ref from it");
    }
    const scroll = scrollInfo(page);
    let changes: string[] | undefined;
    let note: string | undefined;
    if (req.diff) {
      if (this.baseline) changes = formatChanges(diffSnapshots(this.baseline, r.baseline), 200);
      else note = "no earlier snapshot of this page to compare with; showing the whole snapshot";
    }
    this.baseline = r.baseline;
    return {
      text: changes ? "" : r.text,
      refs: r.refs,
      tokens: r.tokens,
      hiddenOmitted: r.hiddenOmitted,
      collapsed: r.collapsed,
      scroll,
      ...(changes ? { changes } : {}),
      ...(note ? { note } : {}),
    };
  }

  // ---------- actions (§11) ----------

  async act(req: ActionRequest, deadline: number): Promise<ActionOutcome> {
    this.assertOpen();
    // Check the ref first: the baseline snapshot below hands out refs, and a ref the agent never saw must fail,
    // not match whatever got that number.
    const ref = "ref" in req ? req.ref : req.kind === "scroll" ? req.to : undefined;
    const pre = ref && /^@?e?\d+$/i.test(ref) ? await this.actor.resolve(ref, deadline) : undefined;
    // Nothing can be read from a page while a dialog blocks it; a dialog answer goes without a baseline.
    if (!this.baseline && req.kind !== "dialog") await this.snapshot({ mode: "interactive" }, deadline);
    const before = this.baseline;
    const navStarts = this.navStarts;
    const navCommits = this.navCommits;
    const started: DownloadInfo[] = [];
    const offDownload = this.downloads?.onStart((d) => started.push(d)) ?? (() => {});
    let chooser = false;
    const offChooser = req.kind === "upload" ? () => {} : this.onFileChooser(() => (chooser = true));
    // Page scripts can't run while a dialog is open, so for dialog answers the counter starts afterwards.
    let mutationsBefore = req.kind === "dialog" ? -1 : await this.mutationCount(deadline);
    const out: ActionOutcome = { action: req.kind === "dialog" ? (req.accept ? "accept" : "dismiss") : req.kind, changes: [] };
    try {
      out.dialog = await this.perform(req, out, deadline);
      // The check above may have re-found a replaced element; say so.
      if (pre?.note) out.note = [pre.note, out.note].filter(Boolean).join("; ");
      if (out.dialog) return out; // the page is blocked until the agent handles the dialog
      if (req.kind === "dialog") mutationsBefore = await this.mutationCount(deadline);

      // Settle (§11.4): a navigation the action started, else up to 1.5 s of network and DOM quiet.
      await sleep(50);
      if (this.navStarts > navStarts || this.navCommits > navCommits) {
        await this.waitNotLoading(Math.min(deadline, Date.now() + ACTION_NAV_MAX_MS));
      } else {
        await this.quiet(Math.min(deadline, Date.now() + SETTLE_MAX_MS), mutationsBefore);
      }
      if (this.dialog) out.dialog = this.pendingDialog();
      if (started.length) {
        await Promise.all(started.map((d) => this.downloads!.wait(d.id, Math.min(deadline, Date.now() + 3000)).catch(() => undefined)));
        out.downloads = started.map((d) => ({ ...d }));
      }
      if (chooser) out.fileChooser = true;

      if (this.navCommits > navCommits) {
        out.navigated = true;
        if (req.snapshot) out.snapshot = await this.snapshot({ mode: "interactive" }, deadline);
      } else if (!out.dialog) {
        const snap = await this.snapshot({ mode: "interactive", maxTokens: DEFAULT_SNAPSHOT_TOKENS }, deadline);
        if (before && this.baseline) out.changes = formatChanges(diffSnapshots(before, this.baseline), MAX_CHANGES);
        if (req.snapshot) out.snapshot = snap;
      }
      return out;
    } finally {
      offDownload();
      offChooser();
    }
  }

  /** Does the action. Returns a dialog if one opened and is blocking the page. */
  private async perform(req: ActionRequest, out: ActionOutcome, deadline: number): Promise<DialogInfo | undefined> {
    const a = this.actor;
    const targetInfo = (t: Target) => {
      out.target = { ref: t.ref, role: t.role, ...(t.name ? { name: t.name } : {}) };
      if (t.note) out.note = t.note;
    };
    switch (req.kind) {
      case "click": {
        const t = await a.resolve(req.ref, deadline);
        targetInfo(t);
        const p = await a.actionable(t, deadline);
        return a.raceDialog(() => a.click(p, { ...(req.button ? { button: req.button } : {}), ...(req.count ? { count: req.count } : {}), ...(req.modifiers ? { modifiers: req.modifiers } : {}) }));
      }
      case "hover": {
        const t = await a.resolve(req.ref, deadline);
        targetInfo(t);
        const p = await a.actionable(t, deadline, { enabled: false });
        const d = await a.raceDialog(() => a.mouse("mouseMoved", p));
        await sleep(150);
        return d;
      }
      case "fill": {
        const t = await a.resolve(req.ref, deadline);
        targetInfo(t);
        const field = (await a.callOn(t, FN.field, [], deadline)) as { kind: string; secret: boolean; value?: string };
        if (field.kind === "select") throw new AgentError("E_NOT_ACTIONABLE", `${t.ref} is a dropdown, not a text field`, `use \`agb select ${t.ref} <option>\``);
        if (field.kind === "file") throw new AgentError("E_NOT_ACTIONABLE", `${t.ref} is a file input`, `use \`agb upload ${t.ref} <file>\``);
        if (field.kind === "readonly") throw new AgentError("E_NOT_ACTIONABLE", `${t.ref} is read-only`, "pick an editable field from `agb snapshot`");
        if (field.kind === "other") throw new AgentError("E_NOT_ACTIONABLE", `${t.role} ${t.ref} isn't a text field`, "fill works on text fields; use click, check, or select for other elements");
        if (req.direct) {
          await a.callOn(t, FN.setValue, [req.text], deadline);
        } else {
          const p = await a.actionable(t, deadline);
          const d = await a.raceDialog(async () => {
            await a.click(p);
            if (req.clear !== false) await a.clearFocused();
            await a.type(req.text);
          });
          if (d) return d;
        }
        const value = String((await a.callOn(t, FN.value, [], deadline)) ?? "");
        out.value = field.secret ? "<redacted>" : value.slice(0, 200);
        if (!field.secret && value !== req.text && req.clear !== false) out.note = `the field changed the text to "${value.slice(0, 80)}"`;
        if (req.submit) return a.raceDialog(() => a.press("Enter"));
        return undefined;
      }
      case "type": {
        if (req.ref) {
          const t = await a.resolve(req.ref, deadline);
          targetInfo(t);
          const p = await a.actionable(t, deadline);
          return a.raceDialog(async () => {
            await a.click(p);
            await a.type(req.text);
          });
        }
        return a.raceDialog(() => a.type(req.text));
      }
      case "press": {
        if (req.ref) {
          const t = await a.resolve(req.ref, deadline);
          targetInfo(t);
          await this.cdp("DOM.focus", { backendNodeId: t.backendId }, t.session);
        }
        return a.raceDialog(() => a.press(req.keys));
      }
      case "check":
      case "uncheck": {
        const want = req.kind === "check";
        const t = await a.resolve(req.ref, deadline);
        targetInfo(t);
        const state = (await a.callOn(t, FN.checked, [], deadline)) as { checked: boolean; radio: boolean };
        if (!want && state.radio) throw new AgentError("E_NOT_ACTIONABLE", `${t.ref} is a radio button; it can't be unchecked`, "check a different option in the same group instead");
        if (state.checked === want) {
          out.note = `${t.ref} was already ${want ? "checked" : "unchecked"}`;
          return undefined;
        }
        const p = await a.actionable(t, deadline);
        const d = await a.raceDialog(() => a.click(p));
        if (d) return d;
        await sleep(50);
        const after = (await a.callOn(t, FN.checked, [], deadline)) as { checked: boolean };
        if (after.checked !== want) throw new AgentError("E_NOT_ACTIONABLE", `clicking ${t.ref} didn't ${req.kind} it`, "the page may handle this control differently; check with `agb snapshot`");
        return undefined;
      }
      case "select":
        return this.select(req.ref, req.values, out, deadline);
      case "scroll":
        return this.scroll(req, out, deadline);
      case "upload": {
        const t = await a.resolve(req.ref, deadline);
        targetInfo(t);
        if ((await a.callOn(t, FN.isFileInput, [], deadline)) === true) {
          await this.cdp("DOM.setFileInputFiles", { files: req.files, backendNodeId: t.backendId }, t.session);
        } else {
          // Something that opens a file chooser (a styled button): click it and answer the chooser.
          let off = () => {};
          const chooser = new Promise<{ backendNodeId: number; session: string }>((resolve) => (off = this.onFileChooser(resolve)));
          try {
            const p = await a.actionable(t, deadline);
            const d = await a.raceDialog(() => a.click(p));
            if (d) return d;
            const ev = await this.until(Math.min(deadline, Date.now() + 3000), "a file chooser", chooser).catch(() => undefined);
            if (!ev) throw new AgentError("E_NOT_ACTIONABLE", `clicking ${t.ref} didn't open a file chooser`, "pass the file input itself (`input type=file`), or the button that opens the chooser");
            await this.cdp("DOM.setFileInputFiles", { files: req.files, backendNodeId: ev.backendNodeId }, ev.session);
          } finally {
            off();
          }
        }
        out.value = `${req.files.length} ${req.files.length === 1 ? "file" : "files"}`;
        return undefined;
      }
      case "dialog": {
        const d = this.dialog;
        if (!d) throw new AgentError("E_INVALID_PARAMS", "no dialog is open in this tab", "dialogs show up in action results and in `agb dialog list`");
        this.dialog = undefined;
        this.answeredDialogs++;
        try {
          await this.cdp("Page.handleJavaScriptDialog", { accept: req.accept, ...(req.text !== undefined ? { promptText: req.text } : {}) }, d.session);
        } catch (e) {
          this.answeredDialogs = Math.max(0, this.answeredDialogs - 1); // no close event will come
          throw e;
        }
        out.note = `${req.accept ? "accepted" : "dismissed"} ${d.type} "${d.message.slice(0, 80)}"`;
        return undefined;
      }
    }
  }

  private async select(ref: string, values: string[], out: ActionOutcome, deadline: number): Promise<DialogInfo | undefined> {
    const a = this.actor;
    const t = await a.resolve(ref, deadline);
    out.target = { ref: t.ref, role: t.role, ...(t.name ? { name: t.name } : {}) };
    if (t.note) out.note = t.note;
    const info = (await a.callOn(t, FN.selectInfo, [], deadline)) as { multiple: boolean; index: number; options: { label: string; value: string; disabled: boolean }[] } | null;

    if (info) {
      const wanted = values.map((v) => {
        const lv = v.trim().toLowerCase();
        const i = info.options.findIndex((o) => !o.disabled && (o.label.toLowerCase() === lv || o.value === v));
        if (i < 0) {
          const avail = info.options.filter((o) => !o.disabled).map((o) => o.label).slice(0, 20).join(", ");
          throw new AgentError("E_NOT_ACTIONABLE", `${t.ref} has no option "${v}"`, `options: ${avail}`);
        }
        return i;
      });
      if (!info.multiple && wanted.length > 1) throw new AgentError("E_INVALID_PARAMS", `${t.ref} allows one option`, "pass a single value");
      await a.actionable(t, deadline);
      if (info.multiple || this.platform === "darwin") {
        // Multi-selects, and macOS (where arrow keys open the popup), are set directly.
        await a.callOn(t, FN.selectDirect, [wanted], deadline);
        out.note = [out.note, "options set directly"].filter(Boolean).join("; ");
      } else {
        // Keyboard on the focused, closed <select>: each arrow press moves to the next enabled option.
        const enabled = info.options.map((o, i) => ({ ...o, i })).filter((o) => !o.disabled);
        const from = Math.max(0, enabled.findIndex((o) => o.i === info.index));
        const to = enabled.findIndex((o) => o.i === wanted[0]);
        await this.cdp("DOM.focus", { backendNodeId: t.backendId }, t.session);
        const key = to > from ? "ArrowDown" : "ArrowUp";
        for (let i = 0; i < Math.abs(to - from); i++) {
          const d = await a.raceDialog(() => a.press(key));
          if (d) return d;
        }
      }
      const labels = (await a.callOn(t, FN.selectedLabels, [], deadline)) as string[];
      const expected = wanted.map((i) => info.options[i]!.label);
      if (labels.join("\n") !== expected.join("\n")) {
        await a.callOn(t, FN.selectDirect, [wanted], deadline);
        out.note = [out.note, "options set directly"].filter(Boolean).join("; ");
      }
      out.value = ((await a.callOn(t, FN.selectedLabels, [], deadline)) as string[]).join(", ");
      return undefined;
    }

    // ARIA listbox or combobox: open it if needed, then click each option by name.
    if (t.role !== "listbox") {
      const p = await a.actionable(t, deadline);
      const d = await a.raceDialog(() => a.click(p));
      if (d) return d;
      await sleep(300);
    }
    const chosen: string[] = [];
    for (const v of values) {
      const page = await this.collect(deadline);
      const lv = v.trim().toLowerCase();
      const optionRef = [...findOptions(page, this.refs, lv)][0];
      if (!optionRef) throw new AgentError("E_NOT_ACTIONABLE", `no option "${v}" appeared for ${t.ref}`, "check the open list with `agb snapshot`");
      const o = await a.resolve(optionRef, deadline);
      const p = await a.actionable(o, deadline);
      const d = await a.raceDialog(() => a.click(p));
      if (d) return d;
      chosen.push(o.name);
      await sleep(150);
    }
    out.value = chosen.join(", ");
    return undefined;
  }

  private async scroll(req: Extract<ActionRequest, { kind: "scroll" }>, out: ActionOutcome, deadline: number): Promise<DialogInfo | undefined> {
    const a = this.actor;
    const vp = this.spec.viewport;
    const metrics = () => this.until(deadline, "scroll", this.cdp("Page.getLayoutMetrics"));
    const yOf = (m: any): number => m.cssLayoutViewport?.pageY ?? 0;
    const maxYOf = (m: any): number => Math.max(0, (m.cssContentSize?.height ?? vp.height) - (m.cssLayoutViewport?.clientHeight ?? vp.height));
    let m = await metrics();
    const y0 = yOf(m);
    /** Where the page should end up, when that is known (page scrolls, not containers). */
    let expected: number | undefined;
    let point = { x: vp.width / 2, y: vp.height / 2 };
    if (req.to && req.to !== "top" && req.to !== "bottom") {
      const t = await a.resolve(req.to, deadline);
      out.target = { ref: t.ref, role: t.role, ...(t.name ? { name: t.name } : {}) };
      await this.cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId: t.backendId }, t.session);
    } else {
      if (req.ref) {
        const t = await a.resolve(req.ref, deadline);
        out.target = { ref: t.ref, role: t.role, ...(t.name ? { name: t.name } : {}) };
        const c = await a.center(t, deadline);
        if (!c) throw new AgentError("E_NOT_ACTIONABLE", `${t.ref} is not visible`, "scroll the page to it first (`agb scroll --to <ref>`)");
        point = c;
      }
      let dx = req.dx ?? 0;
      let dy = req.dy ?? 0;
      if (req.page) dy = (req.page === "down" ? 1 : -1) * Math.round(vp.height * 0.85);
      if (req.to === "top") dy = -(y0 + vp.height);
      if (req.to === "bottom") dy = maxYOf(m) - y0 + vp.height;
      if (!dx && !dy && !req.to) dy = Math.round(vp.height * 0.85);
      if (!req.ref) expected = Math.min(maxYOf(m), Math.max(0, y0 + dy));
      const d = await a.raceDialog(() => a.wheel(point, dx, dy));
      if (d) return d;
    }
    // Wheel scrolling is animated and can start late in a hidden window: wait until the page reaches the
    // expected position, or has moved and then stopped (at most 2 s).
    const settleBy = Math.min(deadline, Date.now() + 2000);
    let stable = 0;
    while (Date.now() < settleBy) {
      await sleep(50);
      const next = await metrics();
      if (expected !== undefined && Math.abs(yOf(next) - expected) < 2) {
        m = next;
        break;
      }
      stable = yOf(next) === yOf(m) && yOf(next) !== y0 ? stable + 1 : 0;
      m = next;
      if (stable >= 3) break;
    }
    const h = m.cssLayoutViewport?.clientHeight ?? vp.height;
    out.scroll = { y: Math.round(m.cssLayoutViewport?.pageY ?? 0), maxY: Math.max(0, Math.round((m.cssContentSize?.height ?? h) - h)), viewportHeight: Math.round(h) };
    return undefined;
  }

  async waitFor(p: WaitParams, deadline: number): Promise<{ matched: string }> {
    const start = Date.now();
    if (p.ms !== undefined && !p.text && !p.ref && !p.url && !p.load && !p.networkidle) {
      await this.until(deadline, "wait", sleep(p.ms));
      return { matched: `${p.ms} ms` };
    }
    for (;;) {
      this.assertOpen();
      if (this.dialog) throw dialogOpen(this.pendingDialog()!);
      let matched: string | undefined;
      if (p.text) {
        const found = await this.pageHasText(p.text, deadline);
        if (found !== !!p.gone) matched = `text "${p.text}" ${p.gone ? "gone" : "present"}`;
      } else if (p.ref) {
        let visible = false;
        try {
          const t = await this.actor.resolve(p.ref, deadline);
          visible = !!(await this.actor.center(t, deadline));
        } catch (e) {
          if (!(e instanceof AgentError) || (e.code !== "E_STALE_REF" && e.code !== "E_NO_REF")) throw e;
          if (!p.gone) throw e;
        }
        if (visible !== !!p.gone) matched = `${p.ref} ${p.gone ? "gone" : "visible"}`;
      } else if (p.url) {
        if (globMatch(p.url, this.wc.getURL())) matched = `url ${this.wc.getURL()}`;
      } else if (p.load) {
        if (!this.wc.isLoading()) matched = "page loaded";
      } else if (p.networkidle) {
        if (!this.wc.isLoading() && this.activeRequests() === 0 && Date.now() - this.lastNetworkChange >= NETWORK_IDLE_MS) matched = "network idle";
      }
      if (matched) {
        if (p.ms) await sleep(p.ms);
        return { matched };
      }
      if (Date.now() >= deadline) throw timedOut(`waiting (${Date.now() - start} ms)`);
      await sleep(100);
    }
  }

  private async pageHasText(text: string, deadline: number): Promise<boolean> {
    const needle = text.toLowerCase();
    if (!this.frames.size) await this.collect(deadline);
    for (const [frameId, f] of this.frames) {
      try {
        const ctx = await this.isolated(frameId, f.session, deadline);
        const r = await this.cdp("Runtime.evaluate", { expression: "document.body ? document.body.innerText : ''", contextId: ctx, returnByValue: true }, f.session);
        if (String(r.result?.value ?? "").toLowerCase().includes(needle)) return true;
      } catch {
        this.worlds.delete(frameId);
      }
    }
    // Frames change; refresh for the next poll.
    await this.collect(deadline).catch(() => undefined);
    return false;
  }

  // ---------- ActorHost ----------

  async isolated(frameId: string, session: string, deadline: number): Promise<number> {
    const cached = this.worlds.get(frameId);
    if (cached !== undefined) return cached;
    const { executionContextId } = await this.until(deadline, "page script", this.cdp("Page.createIsolatedWorld", { frameId, worldName: "agb", grantUniveralAccess: false }, session));
    this.worlds.set(frameId, executionContextId);
    return executionContextId;
  }

  onDialog(cb: (d: DialogInfo) => void): () => void {
    this.dialogListeners.add(cb);
    return () => this.dialogListeners.delete(cb);
  }

  onFileChooser(cb: (e: { backendNodeId: number; session: string }) => void): () => void {
    this.chooserListeners.add(cb);
    return () => this.chooserListeners.delete(cb);
  }

  // ---------- internals ----------

  private dispose(): void {
    this.disposed = true;
    for (const reject of this.onDispose) reject();
    this.onDispose.clear();
    this.onClosed?.();
  }

  private assertOpen(): void {
    if (this.disposed) throw tabClosed();
  }

  private windowTitle(): string {
    const page = this.wc && !this.wc.isDestroyed() ? this.wc.getTitle() : "";
    const label = `${this.spec.agent} · Space ${this.spec.spaceId} (agent)`;
    return page && page !== "about:blank" ? `${page} — ${label}` : label;
  }

  cdp(method: string, params?: Record<string, unknown>, session = ""): Promise<any> {
    if (this.disposed) return Promise.reject(tabClosed());
    return session ? this.wc.debugger.sendCommand(method, params, session) : this.wc.debugger.sendCommand(method, params);
  }

  /** Evaluates an expression in an isolated world of the main frame (never the page's own JS world). */
  private async evaluate(expression: string, deadline: number, awaitPromise = false): Promise<unknown> {
    const { frameTree } = await this.until(deadline, "page script", this.cdp("Page.getFrameTree"));
    const contextId = await this.isolated(frameTree.frame.id, "", deadline);
    const timeout = Math.max(1000, deadline - Date.now());
    let r = await this.until(deadline, "page script", this.cdp("Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise, timeout }).catch((e) => ({ stale: e })));
    if ((r as { stale?: unknown }).stale) {
      // The cached world belonged to an earlier document.
      this.worlds.delete(frameTree.frame.id);
      const fresh = await this.isolated(frameTree.frame.id, "", deadline);
      r = await this.until(deadline, "page script", this.cdp("Runtime.evaluate", { expression, contextId: fresh, returnByValue: true, awaitPromise, timeout }));
    }
    if (r.exceptionDetails) {
      throw new AgentError("E_INTERNAL", `page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result.value;
  }

  /** DOM mutations seen so far in the main frame (installs the observer on first use per document). */
  private async mutationCount(deadline: number): Promise<number> {
    // Page scripts don't run while a dialog is open; don't wait for them.
    if (this.dialog) return -1;
    deadline = Math.min(deadline, Date.now() + 1000);
    try {
      return (await this.evaluate(
        `(() => { const g = globalThis; if (!g.__agbMutations) { g.__agbMutations = { n: 0 }; new MutationObserver((l) => { g.__agbMutations.n += l.length; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); } return g.__agbMutations.n; })()`,
        deadline,
      )) as number;
    } catch {
      return -1;
    }
  }

  /** Waits until the network and the DOM have been quiet for a moment, or `until`. */
  private async quiet(until: number, mutationsBefore: number): Promise<void> {
    let last = mutationsBefore;
    let lastChange = Date.now();
    const started = Date.now();
    while (Date.now() < until && !this.disposed) {
      await sleep(50);
      const n = await this.mutationCount(Math.min(until, Date.now() + 1000));
      if (n !== last) {
        last = n;
        lastChange = Date.now();
      }
      const domQuiet = Date.now() - lastChange >= QUIET_MS;
      const netQuiet = this.activeRequests() === 0 && Date.now() - this.lastNetworkChange >= QUIET_MS;
      if (domQuiet && netQuiet && !this.wc.isLoading()) return;
      if (this.dialog) return;
    }
    if (!this.disposed) {
      this.log(`space ${this.spec.spaceId}: page still busy after ${Date.now() - started} ms (${this.activeRequests()} requests in flight, last DOM change ${Date.now() - lastChange} ms ago, loading=${this.wc.isLoading()})`);
    }
  }

  /** Requests in flight, ignoring ones open for over 10 s (long polling, streams). */
  private activeRequests(): number {
    const cutoff = Date.now() - 10_000;
    let n = 0;
    for (const started of this.inflight.values()) if (started > cutoff) n++;
    return n;
  }

  private async waitNotLoading(until: number): Promise<void> {
    await sleep(100);
    while (Date.now() < until && !this.disposed && this.wc.isLoading() && !this.dialog) await sleep(50);
  }

  private onCdpEvent(method: string, params: any, session: string): void {
    switch (method) {
      case "Target.attachedToTarget":
        if (params.targetInfo?.type === "iframe") {
          this.sessions.add(params.sessionId);
          void this.enableSession(params.sessionId).catch(() => {});
        } else {
          void this.cdp("Runtime.runIfWaitingForDebugger", {}, params.sessionId).catch(() => {});
        }
        break;
      case "Target.detachedFromTarget":
        this.sessions.delete(params.sessionId);
        break;
      case "Page.javascriptDialogOpening": {
        const message = String(params.message ?? "");
        if (params.type === "beforeunload") {
          // "Leave site?" never blocks an agent (policy can change this later, §11.5).
          this.answeredDialogs++;
          void this.cdp("Page.handleJavaScriptDialog", { accept: true }, session).catch(() => {
            this.answeredDialogs = Math.max(0, this.answeredDialogs - 1);
          });
          break;
        }
        this.dialog = { type: params.type, message, ...(params.type === "prompt" ? { defaultPrompt: String(params.defaultPrompt ?? "") } : {}), session };
        this.log(`space ${this.spec.spaceId}: ${params.type} dialog waiting: ${message.slice(0, 120)}`);
        for (const l of this.dialogListeners) l(this.pendingDialog()!);
        break;
      }
      case "Page.javascriptDialogClosed":
        // The close of a dialog this tab answered: the dialog is already cleared, and a newer one may be open.
        if (this.answeredDialogs > 0) this.answeredDialogs--;
        else this.dialog = undefined; // closed some other way (the page went away)
        break;
      case "Page.fileChooserOpened":
        if (params.backendNodeId !== undefined) for (const l of this.chooserListeners) l({ backendNodeId: params.backendNodeId, session });
        break;
      case "Network.requestWillBeSent":
        this.inflight.set(params.requestId, Date.now());
        this.lastNetworkChange = Date.now();
        break;
      case "Network.loadingFinished":
      case "Network.loadingFailed":
        this.inflight.delete(params.requestId);
        this.lastNetworkChange = Date.now();
        break;
    }
  }

  /** Races `p` against the deadline and against the tab closing. */
  until<T>(deadline: number, what: string, p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => finish(() => reject(timedOut(what))), Math.max(0, deadline - Date.now()));
      const onClose = () => finish(() => reject(tabClosed()));
      this.onDispose.add(onClose);
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        this.onDispose.delete(onClose);
        fn();
      };
      p.then(
        (v) => finish(() => resolve(v)),
        (e) => finish(() => reject(e)),
      );
    });
  }

  /**
   * Starts a navigation with `start` and waits for `wait`. Tracks the main frame through webContents events:
   * did-navigate (commit, HTTP status), dom-ready, did-finish-load, did-fail-load, did-navigate-in-page.
   */
  private waitForLoad(wait: WaitUntil, deadline: number, start: () => void, target?: string): Promise<{ status?: number; dialog?: DialogInfo }> {
    this.assertOpen();
    const wc = this.wc;
    return new Promise<{ status?: number; dialog?: DialogInfo }>((resolve, reject) => {
      let status: number | undefined;
      let committed = false;
      let sameDocument = false;
      let settled = false;
      let abortTimer: ReturnType<typeof setTimeout> | undefined;
      let idleTimer: ReturnType<typeof setInterval> | undefined;
      let loadedCheck: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        settled = true;
        clearTimeout(deadlineTimer);
        clearTimeout(abortTimer);
        clearTimeout(loadedCheck);
        clearInterval(idleTimer);
        wc.off("did-start-navigation", onStart);
        wc.off("did-navigate", onNavigate);
        wc.off("did-navigate-in-page", onInPage);
        wc.off("dom-ready", onDomReady);
        wc.off("did-finish-load", onFinish);
        wc.off("did-fail-load", onFail);
        this.onDispose.delete(onClose);
        offDialog();
      };
      const done = (dialog?: DialogInfo) => {
        if (settled) return;
        cleanup();
        resolve({ ...(status && status > 0 ? { status } : {}), ...(dialog ? { dialog } : {}) });
      };
      // A dialog blocks the page from loading further: return now and report it (§11.5).
      const offDialog = this.onDialog((d) => done(d));
      const fail = (e: Error) => {
        if (settled) return;
        cleanup();
        reject(e);
      };
      const loaded = () => {
        if (wait === "networkidle") waitIdle();
        else done();
      };
      const waitIdle = () => {
        if (idleTimer || settled) return;
        idleTimer = setInterval(() => {
          if (this.activeRequests() === 0 && Date.now() - this.lastNetworkChange >= NETWORK_IDLE_MS) done();
        }, 50);
      };

      const onStart = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
        if (!details.isMainFrame) return;
        if (details.isSameDocument) sameDocument = true;
        else if (wait === "none") done();
      };
      const onNavigate = (_e: Electron.Event, _url: string, httpResponseCode: number) => {
        committed = true;
        status = httpResponseCode;
        clearTimeout(abortTimer);
        if (wait === "none") return done();
        // Pages restored from the back/forward cache don't fire did-finish-load.
        loadedCheck = setTimeout(() => {
          if (!wc.isDestroyed() && !wc.isLoading()) loaded();
        }, 250);
      };
      // A fragment navigation (#section) we started. history.pushState from page scripts doesn't count.
      const onInPage = (_e: Electron.Event, _url: string, isMainFrame: boolean) => {
        if (isMainFrame && sameDocument && !committed) done();
      };
      const onDomReady = () => {
        if (wait === "domcontentloaded") done();
      };
      const onFinish = () => {
        if (wait !== "domcontentloaded") loaded();
        else done();
      };
      const onFail = (_e: Electron.Event, code: number, description: string, validatedURL: string, isMainFrame: boolean) => {
        if (!isMainFrame) return;
        if (code === -3) {
          // ERR_ABORTED: superseded (redirect, beforeunload handling, a second navigation, a download). Wait for a commit.
          clearTimeout(abortTimer);
          abortTimer = setTimeout(() => {
            if (!committed) fail(new AgentError("E_NAV_FAILED", `loading ${validatedURL || target || "the page"} was aborted`, "check the URL, then try again"));
            else if (!wc.isLoading()) loaded();
          }, ABORT_GRACE_MS);
          return;
        }
        fail(new AgentError("E_NAV_FAILED", `${description || "error"} (${code}) loading ${validatedURL || target || "the page"}`, "check the URL; the site may be down or unreachable"));
      };
      const onClose = () => fail(tabClosed());
      const deadlineTimer = setTimeout(() => fail(timedOut("navigation")), Math.max(0, deadline - Date.now()));

      wc.on("did-start-navigation", onStart);
      wc.on("did-navigate", onNavigate);
      wc.on("did-navigate-in-page", onInPage);
      wc.on("dom-ready", onDomReady);
      wc.on("did-finish-load", onFinish);
      wc.on("did-fail-load", onFail);
      this.onDispose.add(onClose);
      try {
        start();
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}

// ---------- helpers ----------

function scrollInfo(page: PageData) {
  const vh = Math.round(page.viewport.height);
  return { y: Math.round(page.viewport.scrollY), maxY: Math.max(0, Math.round(page.content.height - vh)), viewportHeight: vh };
}

function* findOptions(page: PageData, refs: RefTable, label: string): Generator<string> {
  const r = buildSnapshot(page, refs, { mode: "interactive", maxTokens: 1_000_000 });
  for (const line of r.baseline) {
    if (!line.ref) continue;
    const m = /^option "((?:[^"\\]|\\.)*)"/.exec(line.text);
    if (m && m[1]!.replace(/\\"/g, '"').toLowerCase() === label) yield line.ref;
  }
}

export function globMatch(glob: string, value: string): boolean {
  const re = new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
  return re.test(value) || (!/[*?]/.test(glob) && value.toLowerCase().includes(glob.toLowerCase()));
}

export function dialogOpen(d: DialogInfo): AgentError {
  return new AgentError("E_DIALOG_OPEN", `a ${d.type} dialog is open: "${d.message.slice(0, 200)}"`, "answer it with `agb dialog accept` or `agb dialog dismiss`");
}
