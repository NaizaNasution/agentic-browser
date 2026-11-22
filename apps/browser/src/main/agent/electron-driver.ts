// Electron side of agent Spaces (docs/SPEC.md §7.2–7.3).
//
// Each agent tab is its own hidden BrowserWindow. A hidden BrowserWindow keeps producing frames
// (paintWhenInitiallyHidden), so requestAnimationFrame, IntersectionObserver, lazy loading, and capturePage work;
// a WebContentsView inside a hidden window does not. The window is never focused and never shown in the taskbar.
// "Showing" a Space shows its active tab's window with showInactive().
//
// CDP goes through webContents.debugger, so no remote-debugging port is ever opened.
import { BrowserWindow, session, type WebContents } from "electron";
import { AgentError, tabClosed, timedOut } from "./errors";
import { extractReadableText, type ReadableText } from "./readable-text";
import type { AgentDriver, SpaceBackend, SpaceMode, TabBackend, TabEvents, TabSpec, WaitUntil } from "./service";

/** Longest full-page capture, in device pixels (Chromium's texture limit). */
const MAX_FULL_PAGE_HEIGHT = 16_384;
/** networkidle: no requests in flight for this long. */
const NETWORK_IDLE_MS = 500;
/** After an aborted main-frame load (ERR_ABORTED), how long to wait for a replacement navigation to commit. */
const ABORT_GRACE_MS = 1500;

export class ElectronAgentDriver implements AgentDriver {
  constructor(private readonly log: (message: string) => void = () => {}) {}

  async createSpace(id: string, mode: SpaceMode): Promise<SpaceBackend> {
    if (mode !== "isolated") throw new AgentError("E_UNSUPPORTED", `${mode} Spaces aren't available yet`);
    // No "persist:" prefix: an in-memory partition, thrown away with the Space.
    const partition = `agb-space-${id}`;
    const ses = session.fromPartition(partition);
    // Deny-by-default until the policy engine exists (SPEC §15).
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    const onDownload = (event: Electron.Event, item: Electron.DownloadItem) => {
      event.preventDefault(); // downloads arrive with the download sandbox (SPEC §15.6, M2)
      this.log(`space ${id}: blocked download of ${item.getURL()}`);
    };
    ses.on("will-download", onDownload);
    return {
      partition,
      dispose: async () => {
        ses.off("will-download", onDownload);
        await ses.clearStorageData();
        await ses.clearCache();
      },
    };
  }

  async createTab(spec: TabSpec, events: TabEvents): Promise<TabBackend> {
    const tab = new ElectronTab(spec, events, this.log);
    try {
      await tab.init();
    } catch (e) {
      tab.close();
      throw e;
    }
    return tab;
  }
}

class ElectronTab implements TabBackend {
  private readonly win: BrowserWindow;
  private readonly wc: WebContents;
  private disposed = false;
  private readonly inflight = new Set<string>();
  private lastNetworkChange = Date.now();
  /** Rejects pending waits when the tab is closed. */
  private readonly onDispose = new Set<() => void>();

  constructor(
    private readonly spec: TabSpec,
    private readonly events: TabEvents,
    private readonly log: (message: string) => void,
  ) {
    this.win = new BrowserWindow({
      width: spec.viewport.width,
      height: spec.viewport.height,
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
    this.wc = this.win.webContents;

    // The human closing the window hides it; only the agent (or app quit) closes the tab.
    this.win.on("close", (e) => {
      if (this.disposed) return;
      e.preventDefault();
      this.win.hide();
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
    dbg.on("message", (_e, method, params) => this.onCdpEvent(method, params));
    dbg.on("detach", (_e, reason) => {
      if (!this.disposed) this.log(`space ${this.spec.spaceId}: debugger detached (${reason})`);
    });
    await this.cdp("Page.enable");
    await this.cdp("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
  }

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

  navigate(url: string, wait: WaitUntil, deadline: number): Promise<{ status?: number }> {
    return this.waitForLoad(wait, deadline, () => void this.wc.loadURL(url).catch(() => {}), url);
  }

  async history(action: "back" | "forward" | "reload", wait: WaitUntil, deadline: number): Promise<{ moved: boolean; status?: number }> {
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
    await this.cdp("Emulation.setDeviceMetricsOverride", { width: this.spec.viewport.width, height, deviceScaleFactor: 0, mobile: false });
    try {
      await this.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))", deadline, true);
      const img = await this.until(deadline, "capture", this.wc.capturePage(undefined, { stayHidden: true }));
      if (img.isEmpty()) throw new AgentError("E_INTERNAL", "the capture came back empty", "try again after the page finishes loading");
      const size = img.getSize();
      const data = opts.format === "jpeg" ? img.toJPEG(opts.quality) : img.toPNG();
      return { data, width: size.width, height: size.height, truncated: fullHeight > height };
    } finally {
      await this.cdp("Emulation.clearDeviceMetricsOverride").catch(() => {});
    }
  }

  /** Evaluates an expression in an isolated world of the main frame (never the page's own JS world). */
  private async evaluate(expression: string, deadline: number, awaitPromise = false): Promise<unknown> {
    const { frameTree } = await this.until(deadline, "page script", this.cdp("Page.getFrameTree"));
    const { executionContextId } = await this.until(
      deadline,
      "page script",
      this.cdp("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "agb" }),
    );
    const timeout = Math.max(1000, deadline - Date.now());
    const r = await this.until(
      deadline,
      "page script",
      this.cdp("Runtime.evaluate", { expression, contextId: executionContextId, returnByValue: true, awaitPromise, timeout }),
    );
    if (r.exceptionDetails) {
      throw new AgentError("E_INTERNAL", `page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result.value;
  }

  async readText(deadline: number): Promise<ReadableText> {
    this.assertOpen();
    // Isolated world: the page's own scripts can't change what the extractor sees or does.
    return (await this.evaluate(`(${extractReadableText.toString()})()`, deadline)) as ReadableText;
  }

  show(position?: { x: number; y: number }): { x: number; y: number } {
    this.assertOpen();
    if (position) this.win.setPosition(position.x, position.y);
    if (!this.win.isVisible()) this.win.showInactive();
    const [x = 0, y = 0] = this.win.getPosition();
    return { x, y };
  }

  hide(): void {
    if (!this.disposed && this.win.isVisible()) this.win.hide();
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

  // ---------- internals ----------

  private dispose(): void {
    this.disposed = true;
    for (const reject of this.onDispose) reject();
    this.onDispose.clear();
  }

  private assertOpen(): void {
    if (this.disposed) throw tabClosed();
  }

  private windowTitle(): string {
    const page = this.wc && !this.wc.isDestroyed() ? this.wc.getTitle() : "";
    const label = `${this.spec.agent} · Space ${this.spec.spaceId} (agent)`;
    return page && page !== "about:blank" ? `${page} — ${label}` : label;
  }

  private cdp(method: string, params?: Record<string, unknown>): Promise<any> {
    if (this.disposed) return Promise.reject(tabClosed());
    return this.wc.debugger.sendCommand(method, params);
  }

  private onCdpEvent(method: string, params: any): void {
    switch (method) {
      case "Page.javascriptDialogOpening":
        // alert/confirm/prompt are dismissed and beforeunload accepted, so a dialog never blocks an agent.
        // Handling them through agb dialog comes with M2.
        this.log(`space ${this.spec.spaceId}: ${params.type} dialog ${params.type === "beforeunload" ? "accepted" : "dismissed"}: ${String(params.message).slice(0, 120)}`);
        void this.cdp("Page.handleJavaScriptDialog", { accept: params.type === "beforeunload" }).catch(() => {});
        break;
      case "Network.requestWillBeSent":
        this.inflight.add(params.requestId);
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
  private until<T>(deadline: number, what: string, p: Promise<T>): Promise<T> {
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
  private waitForLoad(wait: WaitUntil, deadline: number, start: () => void, target?: string): Promise<{ status?: number }> {
    this.assertOpen();
    const wc = this.wc;
    return new Promise<{ status?: number }>((resolve, reject) => {
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
      };
      const done = () => {
        if (settled) return;
        cleanup();
        resolve(status && status > 0 ? { status } : {});
      };
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
          if (this.inflight.size === 0 && Date.now() - this.lastNetworkChange >= NETWORK_IDLE_MS) done();
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
          // ERR_ABORTED: superseded (redirect, beforeunload handling, a second navigation). Wait for a commit.
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
