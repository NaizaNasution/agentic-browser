// Gateway edge cases from docs/testing/M0-test-cases.md (H-05, H-07, H-09, H-10, I-07, I-08, G-05, G-10).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { removeDiscoveryIfOwned } from "../src/shared/discovery-file";
import { pipePath } from "../src/shared/paths";
import { createDispatcher, type GatewayDeps } from "../src/gateway/rpc";
import { startTransports, type RunningGateway } from "../src/gateway/server";

const TOKEN = "edge-token-abcdef";
const home = mkdtempSync(join(tmpdir(), "agb-edge-"));
let gw: RunningGateway;

const deps = (overrides: Partial<GatewayDeps> = {}): GatewayDeps => ({
  token: TOKEN,
  appInfo: { appVersion: "1.2.3", electronVersion: "e", chromeVersion: "c", mainPid: 99, startedAt: Date.now() },
  shellCounts: async () => ({ windows: 1, tabs: 1 }),
  transports: () => ["pipe", "http"],
  ...overrides,
});

before(async () => {
  gw = await startTransports({ dispatch: createDispatcher(deps()), token: TOKEN, pipePath: pipePath(home), http: true });
});
after(async () => {
  await gw.close();
});

const hello = (protocol = "1.0") => ({
  jsonrpc: "2.0",
  id: 1,
  method: "gateway.hello",
  params: { token: TOKEN, client: "t", clientVersion: "0", protocol },
});

function pipeCall(messages: unknown[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const sock = connect(gw.pipe!);
    const replies: any[] = [];
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        replies.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
        if (replies.length === messages.length) {
          sock.end();
          resolve(replies);
        }
      }
    });
    sock.on("error", reject);
    for (const m of messages) sock.write(JSON.stringify(m) + "\n");
  });
}

function http(method: string, path: string, body: string | Buffer, headers: Record<string, string> = {}) {
  const url = new URL(gw.http!);
  return new Promise<number>((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path, method, headers: { authorization: `Bearer ${TOKEN}`, ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", (e) => (e as NodeJS.ErrnoException).code === "ECONNRESET" || (e as NodeJS.ErrnoException).code === "EPIPE" ? resolve(-1) : reject(e));
    req.end(body);
  });
}

function waitClose(sock: Socket, ms = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    sock.on("close", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

test("H-05: same protocol major with a newer minor is accepted", async () => {
  const [h] = await pipeCall([hello("1.7")]);
  assert.ok(h.result, JSON.stringify(h));
});

test("H-07: malformed JSON-RPC requests are E_INVALID_REQUEST", async () => {
  const replies = await pipeCall([
    { jsonrpc: "2.0", method: "gateway.hello" }, // no id
    { jsonrpc: "1.0", id: 2, method: "gateway.hello" }, // wrong version
    [hello()], // batch arrays are not supported
    { jsonrpc: "2.0", id: 4 }, // no method
  ]);
  for (const r of replies) assert.equal(r.error?.data?.name, "E_INVALID_REQUEST", JSON.stringify(r));
});

test("H-09: a message over 1 MB without a newline closes that connection only", async () => {
  const big = connect(gw.pipe!);
  big.on("error", () => {});
  const closed = waitClose(big);
  big.write("x".repeat(1024 * 1024 + 10));
  assert.equal(await closed, true, "oversized connection should be closed");
  const [h] = await pipeCall([hello()]);
  assert.ok(h.result, "other connections keep working");
});

test("H-10: a client that disconnects mid-request doesn't break the gateway", async () => {
  for (let i = 0; i < 5; i++) {
    const s = connect(gw.pipe!);
    s.on("error", () => {});
    s.write(JSON.stringify(hello()) + "\n");
    s.destroy();
  }
  const [h] = await pipeCall([hello()]);
  assert.ok(h.result);
});

test("I-07: wrong method or path is 404", async () => {
  assert.equal(await http("GET", "/rpc", ""), 404);
  assert.equal(await http("POST", "/other", "{}"), 404);
});

test("I-08: body over 1 MB is rejected with 413", async () => {
  const status = await http("POST", "/rpc", Buffer.alloc(1024 * 1024 + 10, 0x20), { "content-type": "application/json" });
  // The server may reset the connection while the client is still sending; both outcomes mean "rejected".
  assert.ok(status === 413 || status === -1, `got ${status}`);
});

test("G-10: when the main process doesn't answer, status fails with E_INTERNAL (no hang)", async () => {
  const dispatch = createDispatcher(
    deps({ shellCounts: () => Promise.reject(new Error("main process did not answer shellCounts")) }),
  );
  const conn = { transport: "pipe" as const, authed: true };
  const res = await dispatch({ jsonrpc: "2.0", id: 1, method: "gateway.status" }, conn);
  assert.equal(res.error?.data?.name, "E_INTERNAL");
  assert.match(res.error!.message, /did not answer/);
});

test("L-03: a live pipe/socket is never taken over by a second gateway", async () => {
  await assert.rejects(
    startTransports({ dispatch: createDispatcher(deps()), token: TOKEN, pipePath: gw.pipe! }),
    (e: NodeJS.ErrnoException) => e.code === "EADDRINUSE",
  );
  const [h] = await pipeCall([hello()]);
  assert.ok(h.result, "the first gateway still answers");
});

test("G-05: discovery cleanup only deletes the file this instance wrote", () => {
  const dir = mkdtempSync(join(tmpdir(), "agb-disc-"));
  const file = join(dir, "gateway.json");
  writeFileSync(file, JSON.stringify({ pid: 111, token: "x" }));
  assert.equal(removeDiscoveryIfOwned(file, 222), false);
  assert.ok(existsSync(file), "another instance's file is kept");
  assert.equal(removeDiscoveryIfOwned(file, 111), true);
  assert.ok(!existsSync(file));
  writeFileSync(file, "{corrupt");
  assert.equal(removeDiscoveryIfOwned(file, 111), false, "corrupt files are left alone without throwing");
});
