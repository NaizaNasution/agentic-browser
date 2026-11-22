// Agent Gateway utility-process entry. Talks to the main process over parentPort.
import { randomBytes } from "node:crypto";
import type { GatewayToMain, MainToGateway, ShellCounts } from "../shared/gateway-ipc";
import { discoveryPath } from "../shared/paths";
import type { AgentContext } from "@agb/protocol";
import { createDispatcher, RpcFailure, toRpcFailure } from "./rpc";
import { startTransports, writeDiscovery, type RunningGateway } from "./server";

const port = process.parentPort;
const post = (msg: GatewayToMain) => port.postMessage(msg);
const log = (level: "info" | "warn" | "error", message: string) => post({ type: "log", level, message });

let askSeq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

function ask<T>(what: "shellCounts"): Promise<T> {
  const id = ++askSeq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject: (e) => reject(e instanceof Error ? e : new Error(String((e as { message?: unknown })?.message ?? e))) });
    post({ type: "ask", id, what });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`main process did not answer ${what}`));
    }, 5000).unref();
  });
}

/** Grace period after a command's own timeout before the Gateway gives up on the main process. */
const CALL_GRACE_MS = 5000;

/** Sends an agent command to the main process. The main process enforces timeoutMs itself; this is a backstop. */
function call(method: string, params: unknown, ctx: AgentContext, timeoutMs: number): Promise<unknown> {
  const id = ++askSeq;
  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject: (e) => reject(toRpcFailure(e)) });
    post({ type: "call", id, method, params, ctx, timeoutMs });
    setTimeout(() => {
      if (pending.delete(id)) {
        reject(new RpcFailure("E_TIMEOUT", `the browser did not finish ${method} in time`, "check the page with `agb capture`, or raise --timeout"));
      }
    }, timeoutMs + CALL_GRACE_MS).unref();
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
        call,
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
      if (msg.error) p.reject(msg.error);
      else p.resolve(msg.result);
      break;
    }
    case "shutdown":
      await running?.close();
      process.exit(0);
  }
});
