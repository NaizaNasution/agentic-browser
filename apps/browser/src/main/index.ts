// Electron main process: the browser window, the human Space's tabs, and the Agent Gateway.
import { app, BaseWindow, ipcMain, session, WebContentsView, type IpcMainEvent } from "electron";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IPC, TOOLBAR_HEIGHT } from "../shared/shell";
import { ElectronAgentDriver } from "./agent/electron-driver";
import { AgentService } from "./agent/service";
import { appInfo, GatewayHost } from "./gateway-host";
import { installMenu } from "./menu";
import { HUMAN_PARTITION, TabManager } from "./tabs";

app.setName("Agentic Browser");

// `--smoke-test <dir>`: start with a throwaway profile, open two tabs, save screenshots and state, quit.
const smokeIdx = process.argv.indexOf("--smoke-test");
const smokeDir = smokeIdx >= 0 ? process.argv[smokeIdx + 1] : undefined;
if (smokeDir) app.setPath("userData", join(smokeDir, "profile"));
// AGB_PROFILE_DIR: run with a separate browser profile (tests, side-by-side dev copies).
else if (process.env.AGB_PROFILE_DIR) app.setPath("userData", process.env.AGB_PROFILE_DIR);

if (!app.requestSingleInstanceLock()) {
  // Another instance owns the Gateway pipe; it will open a window for us (see 'second-instance').
  app.quit();
} else {
  let win: BaseWindow | null = null;
  let shellView: WebContentsView | null = null;
  let tabs: TabManager | null = null;
  const agentLog = (m: string) => console.log(`[agent] ${m}`);
  // Agent Spaces (SPEC §7). Screenshots go to the OS temp folder (SPEC §15.6).
  const agents = new AgentService(new ElectronAgentDriver(agentLog), {
    captureDir: join(tmpdir(), "agentic-browser", "captures"),
    log: agentLog,
  });
  const gateway = new GatewayHost(
    appInfo(),
    () => ({
      windows: win ? 1 : 0, // the human's windows; agent tab windows are counted as agentTabs
      tabs: tabs?.count ?? 0,
      ...agents.counts(),
    }),
    (method, params, ctx, timeoutMs) => agents.handle(method, params, ctx, timeoutMs),
  );

  const focusAddressBar = () => {
    if (!shellView) return;
    shellView.webContents.focus();
    shellView.webContents.send(IPC.focusAddressBar);
  };

  function createWindow(): void {
    win = new BaseWindow({
      width: 1280,
      height: 820,
      minWidth: 480,
      minHeight: 320,
      title: "Agentic Browser",
      autoHideMenuBar: true,
      backgroundColor: "#ffffff",
    });

    shellView = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.contentView.addChildView(shellView);
    const layoutShell = () => {
      if (!win || !shellView) return;
      const { width } = win.getContentBounds();
      shellView.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT });
    };
    layoutShell();
    win.on("resize", layoutShell);
    void shellView.webContents.loadFile(join(__dirname, "../renderer/index.html"));

    tabs = new TabManager(win);
    tabs.on("change", (state) => {
      shellView?.webContents.send(IPC.state, state);
      const active = state.tabs.find((t) => t.id === state.activeId);
      win?.setTitle(active ? `${active.title} - Agentic Browser` : "Agentic Browser");
    });
    tabs.on("empty", () => win?.close());

    win.on("closed", () => {
      tabs?.destroy();
      tabs = null;
      shellView = null;
      win = null;
      // Hidden agent windows would keep 'window-all-closed' from firing, so quit here (not on macOS).
      if (process.platform !== "darwin") app.quit();
    });

    const startUrl = process.argv.find((a) => /^https?:\/\//i.test(a));
    tabs.create(startUrl ?? "about:blank");
    if (!startUrl) shellView.webContents.once("did-finish-load", focusAddressBar);
  }

  /** Only the shell renderer may send shell commands. */
  const fromShell = (e: IpcMainEvent) => shellView !== null && e.sender === shellView.webContents;

  function registerIpc(): void {
    ipcMain.on(IPC.ready, (e) => fromShell(e) && tabs && e.sender.send(IPC.state, tabs.state()));
    ipcMain.on(IPC.newTab, (e, url?: unknown) => {
      if (!fromShell(e)) return;
      tabs?.create(typeof url === "string" ? url : undefined);
      focusAddressBar();
    });
    ipcMain.on(IPC.closeTab, (e, id: unknown) => fromShell(e) && typeof id === "string" && tabs?.close(id));
    ipcMain.on(IPC.activateTab, (e, id: unknown) => fromShell(e) && typeof id === "string" && tabs?.activate(id));
    ipcMain.on(IPC.navigate, (e, input: unknown) => fromShell(e) && typeof input === "string" && tabs?.navigate(input));
    ipcMain.on(IPC.back, (e) => fromShell(e) && tabs?.back());
    ipcMain.on(IPC.forward, (e) => fromShell(e) && tabs?.forward());
    ipcMain.on(IPC.reload, (e) => fromShell(e) && tabs?.reload());
    ipcMain.on(IPC.stop, (e) => fromShell(e) && tabs?.stop());
  }

  function configureSessions(): void {
    // Deny-by-default for site permissions until the permissions UI exists (SPEC §6.1).
    const allowed = new Set(["fullscreen", "clipboard-sanitized-write"]);
    session.fromPartition(HUMAN_PARTITION).setPermissionRequestHandler((_wc, permission, callback) => {
      callback(allowed.has(permission));
    });
  }

  app.on("second-instance", () => {
    if (!win) createWindow();
    else {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    configureSessions();
    registerIpc();
    installMenu(() => tabs, focusAddressBar);
    gateway.start();
    void agents.cleanupCaptures();
    createWindow();
    if (smokeDir) void runSmokeTest(smokeDir);

    app.on("activate", () => {
      if (!win) createWindow();
    });
  });

  // The Gateway keeps running with no windows on macOS; elsewhere closing the last window quits.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    agents.disposeAll();
    gateway.stop();
  });

  async function runSmokeTest(dir: string): Promise<void> {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      await wait(1500);
      const page = "<title>Smoke test page</title><body style='font:24px system-ui;padding:40px'><h1>Agentic Browser</h1><p>Second tab loaded.</p></body>";
      tabs!.create("data:text/html," + encodeURIComponent(page));
      await wait(1500);
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "shell.png"), (await shellView!.webContents.capturePage()).toPNG());
      writeFileSync(join(dir, "state.json"), JSON.stringify(tabs!.state(), null, 2));
      console.log(`[smoke] wrote ${dir}`);
    } catch (e) {
      console.error("[smoke] failed:", e);
      process.exitCode = 1;
    }
    app.quit();
  }
}
