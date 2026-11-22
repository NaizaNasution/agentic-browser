// Starts the Agent Gateway in a utility process and answers its questions about the shell.
import { app, utilityProcess, type UtilityProcess } from "electron";
import { join } from "node:path";
import { removeDiscoveryIfOwned } from "../shared/discovery-file";
import type { AgentContext } from "@agb/protocol";
import type { AppInfo, GatewayToMain, MainToGateway, ShellCounts } from "../shared/gateway-ipc";
import { toMainError } from "./agent/errors";
import { agbHome, discoveryPath, pipePath } from "../shared/paths";

const MAX_RESTARTS = 3;

/** Runs an agent command that the Gateway has authorized and validated. */
export type AgentCallHandler = (method: string, params: unknown, ctx: AgentContext, timeoutMs: number) => Promise<unknown>;

export class GatewayHost {
  private child: UtilityProcess | null = null;
  private restarts = 0;
  private stopping = false;

  constructor(
    private readonly appInfo: AppInfo,
    private readonly counts: () => ShellCounts,
    private readonly handleCall: AgentCallHandler,
  ) {}

  start(): void {
    const home = agbHome();
    const child = utilityProcess.fork(join(__dirname, "../gateway/index.js"), [], {
      serviceName: "Agent Gateway",
      stdio: "inherit",
    });
    this.child = child;

    child.on("message", (msg: GatewayToMain) => this.onMessage(msg));
    child.on("exit", (code) => {
      this.child = null;
      if (this.stopping) return;
      console.error(`[gateway] exited with code ${code}`);
      if (this.restarts < MAX_RESTARTS) {
        this.restarts++;
        setTimeout(() => this.start(), 500 * this.restarts);
      } else {
        console.error("[gateway] gave up restarting; agents can't connect until the app restarts");
      }
    });

    this.send({ type: "init", appInfo: this.appInfo, home, pipePath: pipePath(home), http: true });
  }

  stop(): void {
    this.stopping = true;
    if (this.child) {
      this.send({ type: "shutdown" });
      const child = this.child;
      setTimeout(() => child.kill(), 1000).unref();
    }
    removeOwnDiscoveryFile();
  }

  private onMessage(msg: GatewayToMain): void {
    switch (msg.type) {
      case "ready":
        this.restarts = 0;
        console.log(`[gateway] ready · pipe ${msg.pipe ?? "-"} · http ${msg.http ?? "-"} · ${msg.discoveryPath}`);
        break;
      case "fatal":
        console.error(`[gateway] fatal: ${msg.error}`);
        break;
      case "ask":
        if (msg.what === "shellCounts") this.send({ type: "reply", id: msg.id, result: this.counts() });
        break;
      case "call": {
        const { id, method } = msg;
        this.handleCall(method, msg.params, msg.ctx, msg.timeoutMs).then(
          (result) => this.send({ type: "reply", id, result }),
          (err: unknown) => {
            const error = toMainError(err);
            if (error.name === "E_INTERNAL") console.error(`[agent] ${method} failed:`, err);
            this.send({ type: "reply", id, error });
          },
        );
        break;
      }
      case "log":
        (msg.level === "error" ? console.error : msg.level === "warn" ? console.warn : console.log)(`[gateway] ${msg.message}`);
        break;
    }
  }

  private send(msg: MainToGateway): void {
    this.child?.postMessage(msg);
  }
}

/** Deletes gateway.json if this app instance wrote it (another instance's file is left alone). */
function removeOwnDiscoveryFile(): void {
  removeDiscoveryIfOwned(discoveryPath(), process.pid);
}

export function appInfo(): AppInfo {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? "",
    chromeVersion: process.versions.chrome ?? "",
    mainPid: process.pid,
    startedAt: Date.now(),
  };
}
