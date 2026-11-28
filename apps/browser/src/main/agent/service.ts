// Agent Spaces and their tabs (docs/SPEC.md §7, §8.5, §8.6): ownership, sticky Space resolution, limits,
// per-tab command queues, timeouts, and the agent methods (space.*, tab.*, nav.*, page.*).
// Free of Electron imports: the browser side is behind AgentDriver, so this logic is unit-tested with a fake.
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  ActionResult,
  AgentContext,
  CaptureParams,
  CaptureResult,
  ClickParams,
  DialogInfo,
  DialogListResult,
  DialogParams,
  DownloadInfo,
  DownloadListResult,
  DownloadWaitParams,
  DownloadWaitResult,
  FillParams,
  GotoParams,
  HistoryParams,
  Location,
  NavResult,
  PressParams,
  RefParams,
  ScrollParams,
  SelectParams,
  SnapshotParams,
  SnapshotResult,
  SpaceCloseResult,
  SpaceCreateParams,
  SpaceInfo,
  SpaceListResult,
  SpaceRefParams,
  TabCloseResult,
  TabInfo,
  TabListResult,
  TabOpenParams,
  TabRefParams,
  TabResult,
  TabSelectParams,
  TextParams,
  TextResult,
  TypeParams,
  UploadParams,
  WaitParams,
  WaitResult,
} from "@agb/protocol";
import { AgentError, tabClosed, timedOut } from "./errors";
import type { Modifier } from "./keys";
import { normalizeAgentUrl } from "./urls";

export type WaitUntil = "load" | "domcontentloaded" | "networkidle" | "none";
export type SpaceMode = SpaceInfo["mode"];

export interface Viewport {
  width: number;
  height: number;
}

/** One agent tab in the browser. Implemented with Electron in electron-driver.ts. */
export interface TabBackend {
  url(): string;
  title(): string;
  loading(): boolean;
  /** Navigates and waits. Rejects with AgentError (E_NAV_FAILED, E_TIMEOUT, E_NO_TAB). */
  navigate(url: string, wait: WaitUntil, deadline: number): Promise<{ status?: number; dialog?: DialogInfo }>;
  /** Back, forward, or reload. `moved` is false when there is no history entry in that direction. */
  history(action: "back" | "forward" | "reload", wait: WaitUntil, deadline: number): Promise<{ moved: boolean; status?: number; dialog?: DialogInfo }>;
  /** Stops loading (used when a command times out). */
  stop(): void;
  capture(opts: { fullPage: boolean; format: "png" | "jpeg"; quality: number }, deadline: number): Promise<{ data: Buffer; width: number; height: number; truncated: boolean }>;
  /** Readable main text, already filtered for hidden text. Not truncated. */
  readText(deadline: number): Promise<{ text: string; hiddenOmitted: number }>;
  /** Shows the tab's window to the human without focusing it. Returns its position. */
  show(position?: { x: number; y: number }): { x: number; y: number };
  hide(): void;
  close(): void;
  /** Text snapshot with refs (§10). */
  snapshot(req: SnapshotRequest, deadline: number): Promise<Omit<SnapshotResult, "at">>;
  /** Acts on the page (§11): resolve, check, input, settle, report changes. */
  act(req: ActionRequest, deadline: number): Promise<ActionOutcome>;
  waitFor(params: WaitParams, deadline: number): Promise<{ matched: string }>;
  /** The JavaScript dialog blocking the page, if any. */
  pendingDialog(): DialogInfo | undefined;
}

export interface SnapshotRequest {
  mode?: "interactive" | "full";
  scope?: string;
  maxTokens?: number;
  diff?: boolean;
}

/** An action for TabBackend.act. `snapshot` asks for a fresh snapshot with the result. */
export type ActionRequest = { snapshot?: boolean } & (
  | { kind: "click"; ref: string; button?: "left" | "right" | "middle"; count?: number; modifiers?: Modifier[] }
  | { kind: "hover"; ref: string }
  | { kind: "fill"; ref: string; text: string; submit?: boolean; clear?: boolean; direct?: boolean }
  | { kind: "type"; text: string; ref?: string }
  | { kind: "press"; keys: string; ref?: string }
  | { kind: "select"; ref: string; values: string[] }
  | { kind: "check" | "uncheck"; ref: string }
  | { kind: "scroll"; ref?: string; dx?: number; dy?: number; page?: "up" | "down"; to?: string }
  | { kind: "upload"; ref: string; files: string[] }
  | { kind: "dialog"; accept: boolean; text?: string }
);

/** What TabBackend.act reports; the service adds the location, opened tabs, and duration. */
export type ActionOutcome = Omit<ActionResult, "at" | "opened" | "durationMs" | "snapshot"> & { snapshot?: Omit<SnapshotResult, "at"> };

export interface TabEvents {
  /** The page opened a new window (target=_blank, window.open). */
  onPopup(url: string): void;
  /** The human closed the tab's window; it was hidden, not destroyed. */
  onUserHide(): void;
  /** The tab went away on its own (renderer destroyed). */
  onGone(): void;
}

export interface SpaceBackend {
  readonly partition: string;
  /** Where the Space's downloads are saved (SPEC §15.6). */
  readonly downloadDir: string;
  downloads(): DownloadInfo[];
  /** Waits for a download (default: the latest) to finish. */
  waitDownload(id: string | undefined, deadline: number): Promise<DownloadInfo>;
  /** Throws away the Space's storage. */
  dispose(): Promise<void>;
}

export interface TabSpec {
  spaceId: string;
  tabId: string;
  agent: string;
  partition: string;
  viewport: Viewport;
}

export interface AgentDriver {
  createSpace(id: string, mode: SpaceMode, agent: string): Promise<SpaceBackend>;
  createTab(spec: TabSpec, events: TabEvents): Promise<TabBackend>;
}

export interface AgentServiceOptions {
  captureDir: string;
  maxSpaces?: number;
  maxTabsPerSpace?: number;
  /** How long a Space stays the sticky default for (agent, cwd) after its last use (SPEC §8.5). */
  stickyMs?: number;
  viewport?: Viewport;
  now?: () => number;
  randomId?: () => string;
  log?: (message: string) => void;
}

interface TabRec {
  id: string;
  backend: TabBackend;
  queue: Promise<unknown>;
  closed: boolean;
}

interface SpaceRec {
  id: string;
  agent: string;
  name?: string;
  mode: SpaceMode;
  backend: SpaceBackend;
  tabs: Map<string, TabRec>;
  order: string[];
  activeTab?: string;
  tabSeq: number;
  visible: boolean;
  windowPos?: { x: number; y: number };
  createdAt: number;
  lastUsedAt: number;
  closed: boolean;
  /** Tabs being opened because a page opened a window (reported as `opened` by the action that caused it). */
  pendingPopups: Set<Promise<void>>;
}

interface Resolved {
  space: SpaceRec;
  created: boolean;
}

const DEFAULT_TEXT_CHARS = 20_000;
const OUTER_GRACE_MS = 100;
const MAX_TEXT_CHARS = 1_000_000;
const CAPTURE_RETENTION_MS = 24 * 60 * 60 * 1000;

export class AgentService {
  private spaces = new Map<string, SpaceRec>();
  private sticky = new Map<string, { spaceId: string; at: number }>();
  private creating = new Map<string, Promise<SpaceRec>>();
  /** IDs of Spaces being created (counted against the limit before the driver finishes). */
  private reserved = new Set<string>();
  private readonly maxSpaces: number;
  private readonly maxTabs: number;
  private readonly stickyMs: number;
  private readonly viewport: Viewport;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly log: (m: string) => void;

  constructor(
    private readonly driver: AgentDriver,
    private readonly opts: AgentServiceOptions,
  ) {
    this.maxSpaces = opts.maxSpaces ?? 8;
    this.maxTabs = opts.maxTabsPerSpace ?? 10;
    this.stickyMs = opts.stickyMs ?? 30 * 60 * 1000;
    this.viewport = opts.viewport ?? { width: 1280, height: 800 };
    this.now = opts.now ?? Date.now;
    this.randomId = opts.randomId ?? (() => randomBytes(2).toString("hex"));
    this.log = opts.log ?? (() => {});
  }

  counts(): { agentSpaces: number; agentTabs: number } {
    let agentTabs = 0;
    for (const s of this.spaces.values()) agentTabs += s.tabs.size;
    return { agentSpaces: this.spaces.size, agentTabs };
  }

  /** Runs one agent command. Throws AgentError for protocol errors. */
  async handle(method: string, params: unknown, ctx: AgentContext, timeoutMs: number): Promise<unknown> {
    const deadline = this.now() + timeoutMs;
    const p: unknown = params ?? {};
    const work = this.dispatch(method, p, ctx, deadline);
    // A little later than the deadline, so a command's own timeout handling (e.g. stopping the page) runs first.
    return withDeadline(work, deadline + OUTER_GRACE_MS, this.now, method);
  }

  /** Closes every Space (app quit). Storage of in-memory partitions goes away with the process. */
  disposeAll(): void {
    for (const space of [...this.spaces.values()]) {
      space.closed = true;
      for (const tab of space.tabs.values()) this.destroyTab(tab);
      this.spaces.delete(space.id);
    }
    this.sticky.clear();
  }

  /** Deletes captures older than a day from the capture folder. */
  async cleanupCaptures(): Promise<void> {
    try {
      for (const name of await readdir(this.opts.captureDir)) {
        const file = join(this.opts.captureDir, name);
        const st = await stat(file);
        if (this.now() - st.mtimeMs > CAPTURE_RETENTION_MS) await rm(file, { force: true });
      }
    } catch {
      /* folder doesn't exist yet */
    }
  }

  // ---------- dispatch ----------

  private async dispatch(method: string, p: any, ctx: AgentContext, deadline: number): Promise<unknown> {
    switch (method) {
      case "space.create":
        return this.spaceCreate(p as SpaceCreateParams, ctx);
      case "space.list":
        return this.spaceList(ctx);
      case "space.info":
        return this.info(this.spaceByRef(p as SpaceRefParams, ctx), ctx);
      case "space.close":
        return this.spaceClose(this.spaceByRef(p as SpaceRefParams, ctx));
      case "space.show":
      case "space.hide": {
        const space = this.spaceByRef(p as SpaceRefParams, ctx);
        space.visible = method === "space.show";
        this.syncVisibility(space);
        return this.info(space, ctx);
      }
      case "tab.open":
        return this.tabOpen(p as TabOpenParams, ctx, deadline);
      case "tab.list":
        return this.tabList(ctx);
      case "tab.info": {
        const { space, tab } = this.existingTab(ctx, (p as TabRefParams).tab);
        return { at: this.location(space, tab), tab: this.tabInfo(space, tab) } satisfies TabResult;
      }
      case "tab.select":
        return this.tabSelect(p as TabSelectParams, ctx);
      case "tab.close":
        return this.tabClose(p as TabRefParams, ctx);
      case "nav.goto":
        return this.goto(p as GotoParams, ctx, deadline);
      case "nav.back":
      case "nav.forward":
      case "nav.reload":
        return this.history(method.slice(4) as "back" | "forward" | "reload", p as HistoryParams, ctx, deadline);
      case "page.text":
        return this.text(p as TextParams, ctx, deadline);
      case "page.capture":
        return this.capture(p as CaptureParams, ctx, deadline);
      case "page.snapshot":
        return this.snapshot(p as SnapshotParams, ctx, deadline);
      case "page.click": {
        const c = p as ClickParams;
        return this.action(ctx, deadline, { kind: "click", ref: c.ref, ...pick(c, "button", "count", "snapshot"), ...(c.modifiers ? { modifiers: c.modifiers as Modifier[] } : {}) }, c.follow);
      }
      case "page.hover":
        return this.action(ctx, deadline, { kind: "hover", ...pick(p as RefParams, "ref", "snapshot") } as ActionRequest);
      case "page.fill":
        return this.action(ctx, deadline, { kind: "fill", ...pick(p as FillParams, "ref", "text", "submit", "clear", "direct", "snapshot") } as ActionRequest);
      case "page.type":
        return this.action(ctx, deadline, { kind: "type", ...pick(p as TypeParams, "text", "ref", "snapshot") } as ActionRequest);
      case "page.press":
        return this.action(ctx, deadline, { kind: "press", ...pick(p as PressParams, "keys", "ref", "snapshot") } as ActionRequest);
      case "page.select":
        return this.action(ctx, deadline, { kind: "select", ...pick(p as SelectParams, "ref", "values", "snapshot") } as ActionRequest);
      case "page.check":
      case "page.uncheck":
        return this.action(ctx, deadline, { kind: method === "page.check" ? "check" : "uncheck", ...pick(p as RefParams, "ref", "snapshot") } as ActionRequest);
      case "page.scroll":
        return this.action(ctx, deadline, { kind: "scroll", ...pick(p as ScrollParams, "ref", "dx", "dy", "page", "to", "snapshot") } as ActionRequest);
      case "page.upload":
        return this.upload(p as UploadParams, ctx, deadline);
      case "wait.for":
        return this.waitFor(p as WaitParams, ctx, deadline);
      case "dialog.list": {
        const { space, tab } = this.existingTab(ctx);
        const dialog = tab.backend.pendingDialog();
        return { at: this.location(space, tab), ...(dialog ? { dialog } : {}) } satisfies DialogListResult;
      }
      case "dialog.accept":
      case "dialog.dismiss": {
        const d = p as DialogParams;
        return this.action(ctx, deadline, { kind: "dialog", accept: method === "dialog.accept", ...pick(d, "text", "snapshot") } as ActionRequest, false, true);
      }
      case "download.list": {
        const space = this.findSpace(ctx);
        if (!space) throw noSpace(ctx);
        return { space: space.id, downloads: space.backend.downloads() } satisfies DownloadListResult;
      }
      case "download.wait": {
        const space = this.findSpace(ctx);
        if (!space) throw noSpace(ctx);
        const download = await space.backend.waitDownload((p as DownloadWaitParams).id, deadline);
        return { space: space.id, download } satisfies DownloadWaitResult;
      }
      default:
        throw new AgentError("E_UNSUPPORTED", `${method} is not available yet`);
    }
  }

  // ---------- Spaces ----------

  private async spaceCreate(p: SpaceCreateParams, ctx: AgentContext): Promise<SpaceInfo> {
    const space = await this.createSpace(agentOf(ctx), p.mode ?? "isolated", p.name);
    this.touch(space, ctx);
    if (p.show) {
      space.visible = true;
      this.syncVisibility(space);
    }
    return this.info(space, ctx);
  }

  private spaceList(ctx: AgentContext): SpaceListResult {
    const agent = agentOf(ctx);
    const spaces = [...this.spaces.values()].filter((s) => s.agent === agent).sort((a, b) => a.createdAt - b.createdAt);
    return { spaces: spaces.map((s) => this.info(s, ctx)) };
  }

  private async spaceClose(space: SpaceRec): Promise<SpaceCloseResult> {
    const tabsClosed = space.tabs.size;
    space.closed = true;
    for (const tab of space.tabs.values()) this.destroyTab(tab);
    space.tabs.clear();
    space.order = [];
    this.spaces.delete(space.id);
    for (const [key, s] of this.sticky) if (s.spaceId === space.id) this.sticky.delete(key);
    try {
      await space.backend.dispose();
    } catch (e) {
      this.log(`space ${space.id}: clearing storage failed: ${String(e)}`);
    }
    return { closed: space.id, tabsClosed };
  }

  private async createSpace(agent: string, mode: SpaceMode, name?: string): Promise<SpaceRec> {
    if (mode !== "isolated") {
      throw new AgentError(
        "E_UNSUPPORTED",
        `${mode} Spaces aren't available yet; this version supports isolated Spaces only`,
        "omit --mode, or use --mode isolated (a fresh profile with no logins)",
      );
    }
    const open = this.spaces.size + this.reserved.size;
    if (open >= this.maxSpaces) {
      throw new AgentError("E_LIMIT", `there are already ${open} agent Spaces open (limit ${this.maxSpaces})`, "close unused Spaces with `agb space close <id>`");
    }
    let id: string;
    do id = `sp_${this.randomId()}`;
    while (this.spaces.has(id) || this.reserved.has(id));
    // Reserve the ID and a slot before the async part, so parallel creates respect the limit.
    this.reserved.add(id);
    let backend: SpaceBackend;
    try {
      backend = await this.driver.createSpace(id, mode, agent);
    } finally {
      this.reserved.delete(id);
    }
    const now = this.now();
    const space: SpaceRec = {
      id,
      agent,
      ...(name ? { name } : {}),
      mode,
      backend,
      tabs: new Map(),
      order: [],
      tabSeq: 0,
      visible: false,
      createdAt: now,
      lastUsedAt: now,
      closed: false,
      pendingPopups: new Set(),
    };
    this.spaces.set(id, space);
    this.log(`space ${id} created for ${agent} (${mode})`);
    return space;
  }

  /** Space named by params or ctx, else the sticky one. Never creates. */
  private spaceByRef(p: SpaceRefParams, ctx: AgentContext): SpaceRec {
    const id = p.space ?? ctx.space;
    const space = id ? this.ownedSpace(id, ctx) : this.stickySpace(ctx);
    if (!space) throw noSpace(ctx);
    this.touch(space, ctx);
    return space;
  }

  /**
   * Space for a tab/nav/page command (SPEC §8.5): explicit › sticky. Synchronous, so a command joins its tab's
   * queue in the order it arrived. Returns undefined when a new Space would be needed.
   */
  private findSpace(ctx: AgentContext): SpaceRec | undefined {
    if (ctx.space) {
      const space = this.ownedSpace(ctx.space, ctx);
      if (!space) throw new AgentError("E_NO_SPACE", `no Space ${ctx.space} for agent ${agentOf(ctx)}`, "run `agb space list`");
      this.touch(space, ctx);
      return space;
    }
    const sticky = this.stickySpace(ctx);
    if (sticky) this.touch(sticky, ctx);
    return sticky;
  }

  /** findSpace, or a new isolated Space when there is none (only for commands that can start one). */
  private async resolveSpace(ctx: AgentContext, create: boolean): Promise<Resolved> {
    const found = this.findSpace(ctx);
    if (found) return { space: found, created: false };
    if (!create) throw noSpace(ctx);
    const key = stickyKey(ctx);
    let pending = this.creating.get(key);
    let created = false;
    if (!pending) {
      created = true;
      pending = this.createSpace(agentOf(ctx), "isolated").finally(() => this.creating.delete(key));
      this.creating.set(key, pending);
    }
    const space = await pending;
    this.touch(space, ctx);
    return { space, created };
  }

  private ownedSpace(id: string, ctx: AgentContext): SpaceRec | undefined {
    const space = this.spaces.get(id);
    return space && !space.closed && space.agent === agentOf(ctx) ? space : undefined;
  }

  private stickySpace(ctx: AgentContext): SpaceRec | undefined {
    const s = this.sticky.get(stickyKey(ctx));
    if (!s || this.now() - s.at > this.stickyMs) return undefined;
    return this.ownedSpace(s.spaceId, ctx);
  }

  private touch(space: SpaceRec, ctx: AgentContext): void {
    space.lastUsedAt = this.now();
    this.sticky.set(stickyKey(ctx), { spaceId: space.id, at: space.lastUsedAt });
  }

  private info(space: SpaceRec, ctx: AgentContext): SpaceInfo {
    const sticky = this.sticky.get(stickyKey(ctx));
    return {
      id: space.id,
      agent: space.agent,
      ...(space.name ? { name: space.name } : {}),
      mode: space.mode,
      visible: space.visible,
      tabs: space.tabs.size,
      ...(space.activeTab ? { activeTab: space.activeTab } : {}),
      viewport: `${this.viewport.width}x${this.viewport.height}`,
      createdAt: new Date(space.createdAt).toISOString(),
      lastUsedAt: new Date(space.lastUsedAt).toISOString(),
      sticky: sticky?.spaceId === space.id && this.now() - sticky.at <= this.stickyMs,
    };
  }

  /** Shows the active tab's window when the Space is visible; hides every other window. */
  private syncVisibility(space: SpaceRec): void {
    for (const tab of space.tabs.values()) {
      if (space.visible && tab.id === space.activeTab) space.windowPos = tab.backend.show(space.windowPos);
      else tab.backend.hide();
    }
  }

  // ---------- tabs ----------

  private async tabOpen(p: TabOpenParams, ctx: AgentContext, deadline: number): Promise<TabResult> {
    let url: string | undefined;
    if (p.url && p.url !== "about:blank") url = checkUrl(p.url);
    const { space, created } = await this.resolveSpace(ctx, true);
    const tab = await this.createTab(space, true);
    let status: number | undefined;
    if (url) status = (await this.onTab(tab, () => tab.backend.navigate(url, p.wait ?? "load", deadline))).status;
    return { at: this.location(space, tab, created), tab: this.tabInfo(space, tab), ...(status ? { status } : {}) };
  }

  private tabList(ctx: AgentContext): TabListResult {
    const space = this.findSpace(ctx);
    if (!space) throw noSpace(ctx);
    return { space: space.id, tabs: space.order.map((id) => this.tabInfo(space, space.tabs.get(id)!)) };
  }

  private async tabSelect(p: TabSelectParams, ctx: AgentContext): Promise<TabResult> {
    const { space, tab } = this.existingTab(ctx, p.tab);
    space.activeTab = tab.id;
    this.syncVisibility(space);
    return { at: this.location(space, tab), tab: this.tabInfo(space, tab) };
  }

  private async tabClose(p: TabRefParams, ctx: AgentContext): Promise<TabCloseResult> {
    const { space, tab } = this.existingTab(ctx, p.tab);
    this.removeTab(space, tab);
    const active = space.activeTab ? space.tabs.get(space.activeTab) : undefined;
    return { closed: tab.id, space: space.id, ...(active ? { at: this.location(space, active) } : {}) };
  }

  private async createTab(space: SpaceRec, activate: boolean): Promise<TabRec> {
    if (space.tabs.size >= this.maxTabs) {
      throw new AgentError("E_LIMIT", `Space ${space.id} already has ${space.tabs.size} tabs (limit ${this.maxTabs})`, "close tabs you no longer need with `agb tab close <id>`");
    }
    const id = `t_${++space.tabSeq}`;
    const holder: { tab?: TabRec } = {};
    const backend = await this.driver.createTab(
      { spaceId: space.id, tabId: id, agent: space.agent, partition: space.backend.partition, viewport: this.viewport },
      {
        onPopup: (url) => void this.openPopup(space, url),
        onUserHide: () => {
          if (!space.visible) return;
          space.visible = false;
          this.syncVisibility(space);
        },
        onGone: () => {
          if (holder.tab && !holder.tab.closed) this.removeTab(space, holder.tab);
        },
      },
    );
    if (space.closed) {
      backend.close();
      throw new AgentError("E_NO_SPACE", `Space ${space.id} was closed`, "run `agb space list`");
    }
    const tab: TabRec = { id, backend, queue: Promise.resolve(), closed: false };
    holder.tab = tab;
    space.tabs.set(id, tab);
    space.order.push(id);
    if (activate || !space.activeTab) space.activeTab = id;
    this.syncVisibility(space);
    return tab;
  }

  /** Pages that open new windows get a new tab in the same Space, without changing the active tab. */
  private openPopup(space: SpaceRec, url: string): Promise<void> {
    if (space.closed) return Promise.resolve();
    const checked = normalizeAgentUrl(url);
    if (!checked.ok) return Promise.resolve();
    const work = (async () => {
      try {
        const tab = await this.createTab(space, false);
        await tab.backend.navigate(checked.url, "none", this.now() + 30_000);
      } catch (e) {
        this.log(`space ${space.id}: popup ${url} not opened: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    space.pendingPopups.add(work);
    void work.finally(() => space.pendingPopups.delete(work));
    return work;
  }

  private removeTab(space: SpaceRec, tab: TabRec): void {
    this.destroyTab(tab);
    space.tabs.delete(tab.id);
    const idx = space.order.indexOf(tab.id);
    if (idx >= 0) space.order.splice(idx, 1);
    if (space.activeTab === tab.id) {
      const next = space.order[Math.min(idx, space.order.length - 1)];
      if (next) space.activeTab = next;
      else delete space.activeTab;
      this.syncVisibility(space);
    }
  }

  private destroyTab(tab: TabRec): void {
    if (tab.closed) return;
    tab.closed = true;
    try {
      tab.backend.close();
    } catch {
      /* already gone */
    }
  }

  /** The tab named by `explicit`, ctx.tab, or the active tab, in the resolved Space. Never creates. */
  private existingTab(ctx: AgentContext, explicit?: string): { space: SpaceRec; tab: TabRec } {
    const space = ctx.space ? this.ownedSpace(ctx.space, ctx) : this.stickySpace(ctx);
    if (!space) {
      if (ctx.space) throw new AgentError("E_NO_SPACE", `no Space ${ctx.space} for agent ${agentOf(ctx)}`, "run `agb space list`");
      throw noSpace(ctx);
    }
    this.touch(space, ctx);
    const id = explicit ?? ctx.tab ?? space.activeTab;
    const tab = id ? space.tabs.get(id) : undefined;
    if (!tab) {
      if (id) throw new AgentError("E_NO_TAB", `no tab ${id} in Space ${space.id}`, "run `agb tab list`");
      throw new AgentError("E_NO_TAB", `Space ${space.id} has no tabs`, "open a page with `agb goto <url>`");
    }
    return { space, tab };
  }

  /** Runs `fn` after the tab's earlier commands finish (FIFO per tab, SPEC §8.6). */
  private onTab<T>(tab: TabRec, fn: () => Promise<T>, allowDialog = false): Promise<T> {
    const run = tab.queue.then(() => {
      if (tab.closed) throw tabClosed();
      // A JavaScript dialog blocks the page until the agent answers it (§11.5).
      const dialog = allowDialog ? undefined : tab.backend.pendingDialog();
      if (dialog) {
        throw new AgentError("E_DIALOG_OPEN", `a ${dialog.type} dialog is open: "${dialog.message.slice(0, 200)}"`, "answer it with `agb dialog accept` or `agb dialog dismiss`");
      }
      return fn();
    });
    tab.queue = run.catch(() => {});
    return run;
  }

  private tabInfo(space: SpaceRec, tab: TabRec): TabInfo {
    return {
      id: tab.id,
      url: displayUrl(tab.backend.url()),
      title: tab.backend.title(),
      active: space.activeTab === tab.id,
      loading: tab.backend.loading(),
    };
  }

  private location(space: SpaceRec, tab?: TabRec, created = false): Location {
    return {
      space: space.id,
      ...(tab ? { tab: tab.id, url: displayUrl(tab.backend.url()), title: tab.backend.title() } : {}),
      ...(created ? { spaceCreated: true, spaceMode: space.mode } : {}),
    };
  }

  // ---------- navigation and reading ----------

  private async goto(p: GotoParams, ctx: AgentContext, deadline: number): Promise<NavResult> {
    const url = checkUrl(p.url);
    const started = this.now();
    const found = this.findSpace(ctx);
    const { space, created } = found ? { space: found, created: false } : await this.resolveSpace(ctx, true);
    let tab: TabRec;
    if (ctx.tab) tab = this.existingTab({ ...ctx, space: space.id }).tab;
    else tab = (space.activeTab && space.tabs.get(space.activeTab)) || (await this.createTab(space, true));
    const { status, dialog } = await this.onTab(tab, () => this.guard(tab, deadline, "navigation", () => tab.backend.navigate(url, p.wait ?? "load", deadline)));
    const snapshot = p.snapshot && !dialog ? await this.navSnapshot(space, tab, deadline) : undefined;
    return {
      at: this.location(space, tab, created),
      ...(status ? { status } : {}),
      ...(dialog ? { dialog } : {}),
      ...(snapshot ? { snapshot } : {}),
      durationMs: this.now() - started,
    };
  }

  private async history(action: "back" | "forward" | "reload", p: HistoryParams, ctx: AgentContext, deadline: number): Promise<NavResult> {
    const started = this.now();
    const { space, tab } = this.existingTab(ctx);
    const r = await this.onTab(tab, () => this.guard(tab, deadline, action, () => tab.backend.history(action, p.wait ?? "load", deadline)));
    const snapshot = p.snapshot && !r.dialog ? await this.navSnapshot(space, tab, deadline) : undefined;
    return {
      at: this.location(space, tab),
      ...(r.status ? { status: r.status } : {}),
      ...(r.dialog ? { dialog: r.dialog } : {}),
      ...(action !== "reload" ? { moved: r.moved } : {}),
      ...(snapshot ? { snapshot } : {}),
      durationMs: this.now() - started,
    };
  }

  /** The interactive snapshot that goto/back/forward/reload --snapshot add to their result. */
  private async navSnapshot(space: SpaceRec, tab: TabRec, deadline: number): Promise<SnapshotResult> {
    const r = await this.onTab(tab, () => tab.backend.snapshot({}, deadline));
    return { at: this.location(space, tab), ...r };
  }

  private async text(p: TextParams, ctx: AgentContext, deadline: number): Promise<TextResult> {
    const { space, tab } = this.existingTab(ctx);
    const max = Math.min(p.maxChars ?? DEFAULT_TEXT_CHARS, MAX_TEXT_CHARS);
    const r = await this.onTab(tab, () => tab.backend.readText(deadline));
    const { text, truncated } = truncateText(r.text, max);
    return { at: this.location(space, tab), text, chars: r.text.length, truncated, hiddenOmitted: r.hiddenOmitted };
  }

  private async capture(p: CaptureParams, ctx: AgentContext, deadline: number): Promise<CaptureResult> {
    const { space, tab } = this.existingTab(ctx);
    const format = p.format ?? "png";
    // A screenshot is fine while a dialog waits (the dialog isn't drawn on the page).
    const shot = await this.onTab(tab, () => tab.backend.capture({ fullPage: p.fullPage ?? false, format, quality: p.quality ?? 80 }, deadline), true);
    await mkdir(this.opts.captureDir, { recursive: true });
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
    const path = join(this.opts.captureDir, `${space.id}-${tab.id}-${stamp}-${randomBytes(2).toString("hex")}.${format === "jpeg" ? "jpg" : "png"}`);
    await writeFile(path, shot.data);
    return { at: this.location(space, tab), path, format, width: shot.width, height: shot.height, bytes: shot.data.length, truncated: shot.truncated };
  }

  // ---------- snapshots and actions (§10, §11) ----------

  private async snapshot(p: SnapshotParams, ctx: AgentContext, deadline: number): Promise<SnapshotResult> {
    const { space, tab } = this.existingTab(ctx);
    const r = await this.onTab(tab, () => tab.backend.snapshot(pick(p, "mode", "scope", "maxTokens", "diff"), deadline));
    return { at: this.location(space, tab), ...r };
  }

  /** Runs an action on the target tab and reports where it ended up, tabs it opened, and its duration. */
  private async action(ctx: AgentContext, deadline: number, req: ActionRequest, follow = false, allowDialog = false): Promise<ActionResult> {
    const started = this.now();
    const { space, tab } = this.existingTab(ctx);
    const before = new Set(space.order);
    const out = await this.onTab(tab, () => tab.backend.act(req, deadline), allowDialog);
    // Tabs a page opens arrive asynchronously; give them a moment.
    if (space.pendingPopups.size) await Promise.race([Promise.allSettled([...space.pendingPopups]), new Promise((r) => setTimeout(r, 1000))]);
    const opened = space.order.filter((id) => !before.has(id));
    let at = tab;
    if (follow && opened[0]) {
      space.activeTab = opened[0];
      this.syncVisibility(space);
      at = space.tabs.get(opened[0]) ?? tab;
    }
    const { snapshot, ...rest } = out;
    return {
      at: this.location(space, at),
      ...rest,
      ...(opened.length ? { opened } : {}),
      ...(snapshot ? { snapshot: { at: this.location(space, at), ...snapshot } } : {}),
      durationMs: this.now() - started,
    };
  }

  /** Files must exist and come from the caller's working directory or the Space's download folder (§15.6). */
  private async upload(p: UploadParams, ctx: AgentContext, deadline: number): Promise<ActionResult> {
    if (!p.files.length) throw new AgentError("E_INVALID_PARAMS", "no files given", "pass one or more file paths");
    const space = this.findSpace(ctx);
    if (!space) throw noSpace(ctx);
    const allowed = [ctx.cwd, space.backend.downloadDir].filter((d): d is string => !!d).map((d) => resolve(d));
    const files: string[] = [];
    for (const f of p.files) {
      const abs = resolve(ctx.cwd ?? "", f);
      const inside = allowed.some((dir) => {
        const rel = relative(dir, abs);
        return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
      });
      if (!inside) throw new AgentError("E_DENIED", `${f} is outside the working directory and the Space's download folder`, "copy the file into the current directory first, or upload a file this Space downloaded");
      const st = await stat(abs).catch(() => undefined);
      if (!st?.isFile()) throw new AgentError("E_INVALID_PARAMS", `${f} is not a file`, "check the path");
      files.push(abs);
    }
    return this.action(ctx, deadline, { kind: "upload", ref: p.ref, files, ...(p.snapshot ? { snapshot: true } : {}) });
  }

  private async waitFor(p: WaitParams, ctx: AgentContext, deadline: number): Promise<WaitResult> {
    const conditions = [p.text, p.ref, p.url, p.load, p.networkidle].filter((c) => c !== undefined && c !== false).length;
    if (p.gone && !p.text && !p.ref) throw new AgentError("E_INVALID_PARAMS", "--gone needs --text or --ref", "for example `agb wait --text Loading --gone`");
    if (conditions > 1) throw new AgentError("E_INVALID_PARAMS", "wait for one thing at a time", "use one of --text, --ref, --url, --load, --networkidle (with --ms for an extra pause)");
    if (conditions === 0 && p.ms === undefined) throw new AgentError("E_INVALID_PARAMS", "nothing to wait for", "use --text, --ref, --url, --load, --networkidle, or --ms");
    const started = this.now();
    const { space, tab } = this.existingTab(ctx);
    const r = await this.onTab(tab, () => tab.backend.waitFor(p, deadline));
    return { at: this.location(space, tab), matched: r.matched, waitedMs: this.now() - started };
  }

  /** Stops the page if a navigation outlives the command's deadline. */
  private guard<T>(tab: TabRec, deadline: number, what: string, fn: () => Promise<T>): Promise<T> {
    return withDeadline(fn(), deadline, this.now, what).catch((e) => {
      if (e instanceof AgentError && e.code === "E_TIMEOUT" && !tab.closed) tab.backend.stop();
      throw e;
    });
  }
}

// ---------- helpers ----------

function agentOf(ctx: AgentContext): string {
  return ctx.agent?.trim() || "unknown";
}

function stickyKey(ctx: AgentContext): string {
  return `${agentOf(ctx)}\n${ctx.cwd ?? ""}`;
}

function noSpace(ctx: AgentContext): AgentError {
  return new AgentError(
    "E_NO_SPACE",
    `agent ${agentOf(ctx)} has no active Space here`,
    "start with `agb goto <url>` (it creates a Space), or pass --space <id> (see `agb space list`)",
  );
}

function checkUrl(input: string): string {
  const r = normalizeAgentUrl(input);
  if (r.ok) return r.url;
  if (r.reason === "denied") throw new AgentError("E_DENIED", r.message, "agents can open http and https pages only");
  throw new AgentError("E_INVALID_PARAMS", r.message, "pass a full URL such as https://example.com");
}

function displayUrl(url: string): string {
  return url === "about:blank" ? "" : url;
}

/** The listed keys of `o` that are set. */
function pick<T extends object, K extends keyof T>(o: T, ...keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/** Cuts text at a line break near the limit when there is one. */
export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.lastIndexOf("\n", max);
  return { text: text.slice(0, cut > max * 0.8 ? cut : max).trimEnd(), truncated: true };
}

/** Rejects with E_TIMEOUT if `work` hasn't settled by `deadline`. */
export function withDeadline<T>(work: Promise<T>, deadline: number, now: () => number, what: string): Promise<T> {
  const ms = deadline - now();
  if (ms <= 0) {
    work.catch(() => {});
    return Promise.reject(timedOut(what));
  }
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timedOut(what)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
