// End-to-end harness: launches the real app with an isolated profile and AGB_HOME, and drives
// its web contents (shell UI and tabs) over the Chrome DevTools Protocol.
//
// The DevTools port is opened only here, with --remote-debugging-port=0 on 127.0.0.1.
// The shipped app never opens one (docs/testing/M0-test-cases.md F-05).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// In plain Node, require("electron") returns the path to the Electron binary.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath: string = require("electron");
const appDir = resolve(__dirname, "../..");

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ELECTRON_RUN_AS_NODE (set by some tools) would start Electron as plain Node; the app must not inherit it. */
function withoutRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _ignored, ...rest } = env;
  return rest;
}

export async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      lastErr = e;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}${lastErr ? `: ${String(lastErr)}` : ""}`);
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `agb-e2e-${prefix}-`));
}

// ---------- CDP ----------

export interface Target {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

export class Cdp {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private constructor(private ws: WebSocket) {
    // If the page goes away (tab or window closed), fail outstanding calls instead of hanging.
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error(`cannot open ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) return reject(new Error("CDP connection closed"));
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluates an expression in the page and returns its JSON value. */
  async eval<T = any>(expression: string, opts: { userGesture?: boolean } = {}): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: opts.userGesture ?? false });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }

  close(): void {
    this.ws.close();
  }
}

// ---------- app process ----------

export interface LaunchOptions {
  home?: string;
  profile?: string;
  args?: string[];
  /** Wait for "[gateway] ready" before resolving (default true). */
  waitForGateway?: boolean;
  /** Extra environment variables for the app. */
  env?: Record<string, string>;
}

export class App {
  readonly logs: string[] = [];
  private exitCode: number | null = null;
  private exited: Promise<number | null>;
  devtoolsPort = 0;

  private constructor(
    readonly proc: ChildProcess,
    readonly home: string,
    readonly profile: string,
  ) {
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.logs.push(line);
        const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(line);
        if (m) this.devtoolsPort = Number(m[1]);
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    this.exited = new Promise((res) =>
      proc.on("exit", (code) => {
        this.exitCode = code;
        res(code);
      }),
    );
  }

  static async launch(opts: LaunchOptions = {}): Promise<App> {
    const home = opts.home ?? tempDir("home");
    const profile = opts.profile ?? tempDir("profile");
    const proc = spawn(electronPath, [appDir, "--remote-debugging-port=0", ...(opts.args ?? [])], {
      env: { ...withoutRunAsNode(process.env), AGB_HOME: home, AGB_PROFILE_DIR: profile, ELECTRON_ENABLE_LOGGING: "0", ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const app = new App(proc, home, profile);
    await waitFor("DevTools port", () => app.devtoolsPort || (app.exitCode !== null && Promise.reject(new Error("app exited"))), 20_000);
    if (opts.waitForGateway !== false) await waitFor("gateway ready", () => app.hasLog("[gateway] ready"), 20_000);
    return app;
  }

  hasLog(text: string): boolean {
    return this.logs.some((l) => l.includes(text));
  }

  countLogs(text: string): number {
    return this.logs.filter((l) => l.includes(text)).length;
  }

  get discoveryFile(): string {
    return join(this.home, "gateway.json");
  }

  discovery(): { token: string; http: string; pipe: string; pid: number } {
    return JSON.parse(readFileSync(this.discoveryFile, "utf8"));
  }

  hasDiscovery(): boolean {
    return existsSync(this.discoveryFile);
  }

  async targets(): Promise<Target[]> {
    const res = await fetch(`http://127.0.0.1:${this.devtoolsPort}/json/list`);
    return (await res.json()) as Target[];
  }

  /** Connects to the first page target whose URL matches. */
  async page(match: (url: string) => boolean, what = "page"): Promise<Cdp> {
    const t = await waitFor(what, async () => (await this.targets()).find((x) => x.type === "page" && match(x.url)));
    return Cdp.connect(t.webSocketDebuggerUrl);
  }

  shell(): Promise<Cdp> {
    return this.page((u) => u.startsWith("file:") && u.endsWith("/renderer/index.html"), "shell UI");
  }

  /** Waits for the process to exit; returns its exit code. */
  waitExit(timeoutMs = 10_000): Promise<number | null> {
    return Promise.race([
      this.exited,
      sleep(timeoutMs).then(() => Promise.reject(new Error(`app did not exit; its last log lines:\n${this.logs.slice(-15).join("\n")}`))),
    ]);
  }

  get running(): boolean {
    return this.exitCode === null;
  }

  kill(): void {
    if (this.running) this.proc.kill();
  }
}

/** Starts the app without waiting for anything (for processes expected to exit at once). */
export function spawnApp(home: string, profile: string): ChildProcess {
  return spawn(electronPath, [appDir], { env: { ...process.env, AGB_HOME: home, AGB_PROFILE_DIR: profile }, stdio: "ignore" });
}

export const repoRoot = resolve(appDir, "../..");

// ---------- shell helpers ----------

export interface ShellTab {
  title: string;
  active: boolean;
}

export async function shellTabs(shell: Cdp): Promise<ShellTab[]> {
  return shell.eval(
    `[...document.querySelectorAll('.tab')].map(t => ({ title: t.querySelector('.tab-title').textContent, active: t.classList.contains('active') }))`,
  );
}

/** Closes every tab with the tabs' × buttons, which closes the window and quits the app. */
export async function closeAllTabs(shell: Cdp): Promise<void> {
  // Right after launch the shell may not have rendered its tabs yet, and an evaluation can fail while the page
  // settles; so wait for the tab strip, click, and check again (up to 3 rounds). If the tabs are gone but the app
  // keeps running, waitExit still fails: that would be an app bug, not a test race.
  for (let round = 0; round < 3; round++) {
    await shell
      .eval(`(async () => {
        for (let i = 0; i < 100 && !document.querySelector('.tab-close'); i++) await new Promise(r => setTimeout(r, 50));
        for (let i = 0; i < 20; i++) {
          const b = document.querySelector('.tab-close');
          if (!b) break;
          b.click();
          await new Promise(r => setTimeout(r, 150));
        }
      })()`)
      .catch(() => {
        /* the page goes away when the window closes */
      });
    await sleep(300);
    const left = await shell.eval<boolean>("!!document.querySelector('.tab-close')").catch(() => false);
    if (!left) return;
  }
}

// ---------- local test site ----------

export interface Site {
  url: string;
  close(): Promise<void>;
}

/** Serves small test pages on 127.0.0.1. */
export async function startSite(): Promise<Site> {
  const pages: Record<string, string> = {
    "/": "<title>Home</title><h1>Home</h1>",
    "/child": "<title>Child</title><h1>Child page</h1>",
    "/opener": "<title>Opener</title><a id='pop' href='/child' target='_blank'>open child</a>",
  };
  const server: Server = createServer((req, res) => {
    const body = pages[(req.url ?? "/").split("?")[0]!];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(body ?? "<title>Not found</title>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
