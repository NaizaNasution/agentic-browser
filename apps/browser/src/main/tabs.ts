// Human Space tab manager: one WebContentsView per tab, laid out below the shell toolbar.
import { BaseWindow, WebContentsView, shell } from "electron";
import { EventEmitter } from "node:events";
import { TOOLBAR_HEIGHT, type ShellState, type TabState } from "../shared/shell";
import { resolveInput } from "./url";

export const HUMAN_PARTITION = "persist:main";

interface Tab {
  id: string;
  view: WebContentsView;
  favicon?: string;
}

export class TabManager extends EventEmitter<{ change: [ShellState]; empty: [] }> {
  private tabs = new Map<string, Tab>();
  private order: string[] = [];
  private activeId: string | null = null;
  private seq = 0;

  constructor(private readonly win: BaseWindow) {
    super();
    win.on("resize", () => this.layout());
  }

  get count(): number {
    return this.tabs.size;
  }

  create(url = "about:blank", opts: { activate?: boolean; afterId?: string } = {}): string {
    const id = `t_${++this.seq}`;
    const view = new WebContentsView({
      webPreferences: {
        partition: HUMAN_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    const tab: Tab = { id, view };
    this.tabs.set(id, tab);
    const afterIdx = opts.afterId ? this.order.indexOf(opts.afterId) : -1;
    if (afterIdx >= 0) this.order.splice(afterIdx + 1, 0, id);
    else this.order.push(id);

    const wc = view.webContents;
    const emit = () => this.emitChange();
    wc.on("did-start-loading", emit);
    wc.on("did-stop-loading", emit);
    wc.on("did-navigate", emit);
    wc.on("did-navigate-in-page", emit);
    wc.on("page-title-updated", emit);
    wc.on("page-favicon-updated", (_e, favicons) => {
      tab.favicon = favicons[0];
      emit();
    });
    // Links that open new windows become new tabs next to this one.
    wc.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/i.test(target)) this.create(target, { activate: true, afterId: id });
      else if (/^mailto:/i.test(target)) void shell.openExternal(target);
      return { action: "deny" };
    });

    void wc.loadURL(url).catch(() => {
      /* load errors are shown by Chromium's error page */
    });
    if (opts.activate !== false) this.activate(id);
    else this.emitChange();
    return id;
  }

  activate(id: string): void {
    const next = this.tabs.get(id);
    if (!next) return;
    if (this.activeId && this.activeId !== id) {
      const prev = this.tabs.get(this.activeId);
      if (prev) this.win.contentView.removeChildView(prev.view);
    }
    this.activeId = id;
    this.win.contentView.addChildView(next.view);
    this.layout();
    next.view.webContents.focus();
    this.emitChange();
  }

  close(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const idx = this.order.indexOf(id);
    this.win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    this.tabs.delete(id);
    this.order.splice(idx, 1);
    if (this.activeId === id) {
      this.activeId = null;
      const nextId = this.order[Math.min(idx, this.order.length - 1)];
      if (nextId) this.activate(nextId);
    }
    if (this.tabs.size === 0) this.emit("empty");
    else this.emitChange();
  }

  cycle(delta: 1 | -1): void {
    if (!this.activeId || this.order.length < 2) return;
    const idx = this.order.indexOf(this.activeId);
    const next = this.order[(idx + delta + this.order.length) % this.order.length];
    if (next) this.activate(next);
  }

  navigate(input: string): void {
    const tab = this.active();
    if (!tab) return;
    void tab.view.webContents.loadURL(resolveInput(input)).catch(() => {});
    tab.view.webContents.focus();
  }

  back(): void {
    const h = this.active()?.view.webContents.navigationHistory;
    if (h?.canGoBack()) h.goBack();
  }

  forward(): void {
    const h = this.active()?.view.webContents.navigationHistory;
    if (h?.canGoForward()) h.goForward();
  }

  reload(ignoreCache = false): void {
    const wc = this.active()?.view.webContents;
    if (ignoreCache) wc?.reloadIgnoringCache();
    else wc?.reload();
  }

  stop(): void {
    this.active()?.view.webContents.stop();
  }

  toggleDevTools(): void {
    this.active()?.view.webContents.toggleDevTools();
  }

  state(): ShellState {
    return {
      activeId: this.activeId,
      tabs: this.order.map((id) => this.tabState(this.tabs.get(id)!)),
    };
  }

  destroy(): void {
    for (const tab of this.tabs.values()) tab.view.webContents.close();
    this.tabs.clear();
    this.order = [];
  }

  private active(): Tab | undefined {
    return this.activeId ? this.tabs.get(this.activeId) : undefined;
  }

  private tabState(tab: Tab): TabState {
    const wc = tab.view.webContents;
    const url = wc.getURL();
    const blank = !url || url === "about:blank";
    return {
      id: tab.id,
      title: blank ? "New Tab" : wc.getTitle() || url,
      url: blank ? "" : url,
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      favicon: tab.favicon,
    };
  }

  private layout(): void {
    const tab = this.active();
    if (!tab) return;
    const { width, height } = this.win.getContentBounds();
    tab.view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) });
  }

  private emitChange(): void {
    this.emit("change", this.state());
  }
}
