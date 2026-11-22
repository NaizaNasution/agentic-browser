import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PROTOCOL_VERSION } from "@agb/protocol";
import { pipePath } from "../src/shared/paths";
import { createDispatcher } from "../src/gateway/rpc";
import { startTransports, writeDiscovery, type RunningGateway } from "../src/gateway/server";

const TOKEN = "test-token-0123456789";
const home = mkdtempSync(join(tmpdir(), "agb-test-"));
let gw: RunningGateway;

before(async () => {
  const transports = ["pipe", "http"];
  const dispatch = createDispatcher({
    token: TOKEN,
    appInfo: { appVersion: "9.9.9", electronVersion: "e", chromeVersion: "c", mainPid: 4242, startedAt: Date.now() - 1000 },
    shellCounts: async () => ({ windows: 1, tabs: 3 }),
    transports: () => transports,
  });
  gw = await startTransports({ dispatch, token: TOKEN, pipePath: pipePath(home), http: true });
});

after(async () => {
  await gw.close();
});

/** Sends newline-delimited requests on one pipe connection and collects the replies. */
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
    for (const m of messages) sock.write((typeof m === "string" ? m : JSON.stringify(m)) + "\n");
  });
}

function httpCall(body: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const url = new URL(gw.http! + "/rpc");
  return new Promise((resolve, reject) => {
    const req = request(
      { host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/json", ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const hello = (token = TOKEN, protocol = PROTOCOL_VERSION) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "gateway.hello",
  params: { token, client: "test", clientVersion: "0", protocol },
});
const status = { jsonrpc: "2.0", id: 2, method: "gateway.status" };

test("pipe: hello then status", async () => {
  const [h, s] = await pipeCall([hello(), status]);
  assert.equal(h.result.appVersion, "9.9.9");
  assert.equal(h.result.protocol, PROTOCOL_VERSION);
  assert.equal(s.result.tabs, 3);
  assert.equal(s.result.pid, 4242);
  assert.deepEqual(s.result.transports, ["pipe", "http"]);
});

test("pipe: status without hello is unauthorized", async () => {
  const [s] = await pipeCall([status]);
  assert.equal(s.error.data.name, "E_UNAUTHORIZED");
});

test("pipe: wrong token is rejected and does not authorize the connection", async () => {
  const [h, s] = await pipeCall([hello("wrong"), status]);
  assert.equal(h.error.data.name, "E_UNAUTHORIZED");
  assert.equal(s.error.data.name, "E_UNAUTHORIZED");
});

test("pipe: incompatible protocol major is rejected", async () => {
  const [h] = await pipeCall([hello(TOKEN, "2.0")]);
  assert.equal(h.error.data.name, "E_VERSION");
  assert.ok(h.error.data.hint);
});

test("pipe: bad JSON and unknown methods return errors, connection stays usable", async () => {
  const [a, b, c] = await pipeCall(["{not json", { jsonrpc: "2.0", id: 5, method: "nope.nope" }, hello()]);
  assert.equal(a.error.data.name, "E_PARSE");
  assert.equal(b.error.data.name, "E_METHOD_NOT_FOUND");
  assert.ok(c.result);
});

test("http: bearer token authorizes", async () => {
  const r = await httpCall(JSON.stringify(status), { authorization: `Bearer ${TOKEN}` });
  assert.equal(r.status, 200);
  assert.equal(r.json.result.windows, 1);
});

test("http: missing token is 401", async () => {
  const r = await httpCall(JSON.stringify(status));
  assert.equal(r.status, 401);
  assert.equal(r.json.error.data.name, "E_UNAUTHORIZED");
});

test("http: requests from web pages (Origin header) are refused", async () => {
  const r = await httpCall(JSON.stringify(status), { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" });
  assert.equal(r.status, 403);
});

test("http: wrong Host header is refused (DNS rebinding)", async () => {
  const r = await httpCall(JSON.stringify(status), { authorization: `Bearer ${TOKEN}`, host: "evil.example:80" });
  assert.equal(r.status, 403);
});

test("discovery file is written with protocol and private permissions", () => {
  const file = join(home, "gateway.json");
  writeDiscovery(file, { version: "9.9.9", pipe: gw.pipe, http: gw.http, token: TOKEN, pid: 4242, startedAt: new Date().toISOString() });
  const d = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(d.protocol, PROTOCOL_VERSION);
  assert.equal(d.token, TOKEN);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o077, 0);
});
