// Gateway transports (docs/SPEC.md §8.1): named pipe / Unix socket first, loopback HTTP as fallback.
import { mkdirSync, renameSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { createConnection, createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { PROTOCOL_VERSION, type Discovery } from "@agb/protocol";
import { tokenMatches, type Connection, type Dispatch } from "./rpc";

const MAX_MESSAGE_BYTES = 1024 * 1024;

export interface StartOptions {
  dispatch: Dispatch;
  token: string;
  pipePath?: string;
  http?: boolean;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface RunningGateway {
  pipe?: string;
  http?: string;
  close(): Promise<void>;
}

export async function startTransports(opts: StartOptions): Promise<RunningGateway> {
  const log = opts.log ?? (() => {});
  let pipeServer: NetServer | undefined;
  let httpServer: HttpServer | undefined;
  let httpUrl: string | undefined;

  if (opts.pipePath) {
    pipeServer = await listenPipe(opts.pipePath, opts.dispatch, log);
  }
  if (opts.http) {
    const r = await listenHttp(opts.dispatch, opts.token, log);
    httpServer = r.server;
    httpUrl = r.url;
  }

  return {
    pipe: pipeServer ? opts.pipePath : undefined,
    http: httpUrl,
    async close() {
      await Promise.all([
        pipeServer && new Promise<void>((res) => pipeServer!.close(() => res())),
        httpServer && new Promise<void>((res) => { httpServer!.closeAllConnections(); httpServer!.close(() => res()); }),
      ]);
      if (opts.pipePath && process.platform !== "win32") rmSync(opts.pipePath, { force: true });
    },
  };
}

// ---------- pipe / socket: newline-delimited JSON-RPC ----------

async function listenPipe(path: string, dispatch: Dispatch, log: StartOptions["log"] & {}): Promise<NetServer> {
  if (process.platform !== "win32") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      // Only remove a stale socket from a crashed run; never take over a live one.
      if (await socketIsLive(path)) throw Object.assign(new Error(`${path} is in use by another gateway`), { code: "EADDRINUSE" });
      rmSync(path, { force: true });
    }
  }
  const server = createNetServer((socket) => servePipeConnection(socket, dispatch, log));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return server;
}

function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

function servePipeConnection(socket: Socket, dispatch: Dispatch, log: (l: "warn", m: string) => void): void {
  const conn: Connection = { transport: "pipe", authed: false };
  let buffer = "";
  let queue = Promise.resolve();
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_MESSAGE_BYTES && !buffer.includes("\n")) {
      log("warn", "pipe message too large; closing connection");
      socket.destroy();
      return;
    }
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      // Requests on one connection are answered in order.
      queue = queue.then(async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          socket.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON", data: { name: "E_PARSE" } } }) + "\n");
          return;
        }
        const res = await dispatch(parsed, conn);
        if (!socket.destroyed) socket.write(JSON.stringify(res) + "\n");
      });
    }
  });
  socket.on("error", () => socket.destroy());
}

// ---------- HTTP fallback: POST /rpc with bearer token ----------

async function listenHttp(dispatch: Dispatch, token: string, log: (l: "warn", m: string) => void) {
  let port = 0;
  const server = createHttpServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    // Only local, non-browser callers (SPEC §15.1 T4): no Origin header, Host must be loopback:port.
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(403, { error: "bad host" });
    if (req.headers.origin !== undefined) return send(403, { error: "browser requests are not allowed" });
    if (req.method !== "POST" || req.url !== "/rpc") return send(404, { error: "not found" });
    const auth = req.headers.authorization ?? "";
    const authed = auth.startsWith("Bearer ") && tokenMatches(token, auth.slice(7));

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      log("warn", "http body too large");
      return send(413, { error: "too large" });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON", data: { name: "E_PARSE" } } });
    }
    const out = await dispatch(parsed, { transport: "http", authed });
    send(out.error?.data?.name === "E_UNAUTHORIZED" ? 401 : 200, out);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_MESSAGE_BYTES) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------- discovery file ----------

/** Writes gateway.json atomically, readable by the current user only. */
export function writeDiscovery(file: string, d: Omit<Discovery, "protocol">): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const content: Discovery = { protocol: PROTOCOL_VERSION, ...d };
  writeFileSync(tmp, JSON.stringify(content, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  // %LOCALAPPDATA% is already private to the user on Windows; chmod covers macOS/Linux.
  if (process.platform !== "win32") chmodSync(file, 0o600);
}
