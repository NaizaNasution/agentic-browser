// JSON-RPC dispatch for the Agent Gateway (docs/SPEC.md §8.2). Transport-independent.
import { timingSafeEqual } from "node:crypto";
import {
  ErrorCodes,
  ErrorMessages,
  PROTOCOL_VERSION,
  type ErrorName,
  type HelloParams,
  type HelloResult,
  type MethodName,
  type Methods,
  type RpcResponse,
  type StatusResult,
} from "@agb/protocol";
import type { AppInfo, ShellCounts } from "../shared/gateway-ipc";

export interface GatewayDeps {
  token: string;
  appInfo: AppInfo;
  shellCounts(): Promise<ShellCounts>;
  transports(): string[];
}

/** Per-connection state. Pipe connections must say hello first; HTTP requests are authorized by header. */
export interface Connection {
  transport: "pipe" | "http";
  authed: boolean;
}

export class RpcFailure extends Error {
  constructor(
    readonly name_: ErrorName,
    message?: string,
    readonly hint?: string,
  ) {
    super(message ?? ErrorMessages[name_]);
  }
}

type Handler<M extends MethodName> = (params: unknown, conn: Connection) => Promise<Methods[M]["result"]>;

export function tokenMatches(expected: string, given: unknown): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function major(v: string): string {
  return v.split(".")[0] ?? "";
}

export function createDispatcher(deps: GatewayDeps) {
  const handlers: { [M in MethodName]: Handler<M> } = {
    "gateway.hello": async (raw, conn): Promise<HelloResult> => {
      const p = raw as Partial<HelloParams> | undefined;
      if (!p || typeof p !== "object") throw new RpcFailure("E_INVALID_PARAMS", "params must be an object");
      if (!tokenMatches(deps.token, p.token)) {
        throw new RpcFailure("E_UNAUTHORIZED", "Wrong token", "Read the token from the current gateway.json");
      }
      if (typeof p.protocol !== "string" || major(p.protocol) !== major(PROTOCOL_VERSION)) {
        throw new RpcFailure(
          "E_VERSION",
          `Client speaks protocol ${String(p.protocol)}, gateway speaks ${PROTOCOL_VERSION}`,
          "run `agb upgrade`, or update Agentic Browser",
        );
      }
      conn.authed = true;
      return { appVersion: deps.appInfo.appVersion, protocol: PROTOCOL_VERSION, serverTime: new Date().toISOString() };
    },

    "gateway.status": async (): Promise<StatusResult> => {
      const counts = await deps.shellCounts();
      return {
        appVersion: deps.appInfo.appVersion,
        electronVersion: deps.appInfo.electronVersion,
        chromeVersion: deps.appInfo.chromeVersion,
        protocol: PROTOCOL_VERSION,
        pid: deps.appInfo.mainPid,
        uptimeMs: Date.now() - deps.appInfo.startedAt,
        windows: counts.windows,
        tabs: counts.tabs,
        transports: deps.transports(),
      };
    },
  };

  const error = (id: RpcResponse["id"], name: ErrorName, message?: string, hint?: string): RpcResponse => ({
    jsonrpc: "2.0",
    id,
    error: { code: ErrorCodes[name], message: message ?? ErrorMessages[name], data: { name, ...(hint ? { hint } : {}) } },
  });

  /** Handles one parsed JSON value. Never throws. */
  return async function dispatch(msg: unknown, conn: Connection): Promise<RpcResponse> {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return error(null, "E_INVALID_REQUEST");
    const req = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const id = typeof req.id === "number" || typeof req.id === "string" ? req.id : null;
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string" || id === null) {
      return error(id, "E_INVALID_REQUEST");
    }
    const handler = (handlers as Record<string, Handler<MethodName>>)[req.method];
    if (!handler) return error(id, "E_METHOD_NOT_FOUND", `Unknown method ${req.method}`);
    if (!conn.authed && req.method !== "gateway.hello") {
      return error(id, "E_UNAUTHORIZED", undefined, "Send gateway.hello with the token from gateway.json first");
    }
    try {
      const result = await handler(req.params ?? {}, conn);
      return { jsonrpc: "2.0", id, result };
    } catch (e) {
      if (e instanceof RpcFailure) return error(id, e.name_, e.message, e.hint);
      return error(id, "E_INTERNAL", e instanceof Error ? e.message : String(e));
    }
  };
}

export type Dispatch = ReturnType<typeof createDispatcher>;
