// Agent Gateway utility-process entry. Talks to the main process over parentPort.
import { randomBytes } from "node:crypto";
import type { GatewayToMain, MainToGateway, ShellCounts } from "../shared/gateway-ipc";
import { discoveryPath } from "../shared/paths";
import { createDispatcher } from "./rpc";
import { startTransports, writeDiscovery, type RunningGateway } from "./server";

const port = process.parentPort;
const post = (msg: GatewayToMain) => port.postMessage(msg);
const log = (level: "info" | "warn" | "error", message: string) => post({ type: "log", level, message });

let askSeq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function ask<T>(what: "shellCounts"): Promise<T> {
  const id = ++askSeq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    post({ type: "ask", id, what });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`main process did not answer ${what}`));
    }, 5000).unref();
  });
}

let running: RunningGateway | null = null;

port.on("message", async (e: { data: MainToGateway }) => {
  const msg = e.data;
  switch (msg.type) {
    case "init": {
      const token = randomBytes(32).toString("base64url"); // rotated on every launch (SPEC §8.1)
      const transports: string[] = [];
      const dispatch = createDispatcher({
        token,
        appInfo: msg.appInfo,
        shellCounts: () => ask<ShellCounts>("shellCounts"),
        transports: () => transports,
      });
      try {
        running = await startTransports({ dispatch, token, pipePath: msg.pipePath, http: msg.http, log });
        if (running.pipe) transports.push("pipe");
        if (running.http) transports.push("http");
        const file = discoveryPath(msg.home);
        writeDiscovery(file, {
          version: msg.appInfo.appVersion,
          pipe: running.pipe,
          http: running.http,
          token,
          pid: msg.appInfo.mainPid,
          startedAt: new Date(msg.appInfo.startedAt).toISOString(),
        });
        post({ type: "ready", pipe: running.pipe, http: running.http, discoveryPath: file });
      } catch (err) {
        post({ type: "fatal", error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
      }
      break;
    }
    case "reply": {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
      break;
    }
    case "shutdown":
      await running?.close();
      process.exit(0);
  }
});
