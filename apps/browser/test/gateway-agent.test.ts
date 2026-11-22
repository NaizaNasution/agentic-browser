// Gateway handling of agent commands: validation against the schema, forwarding to the main process,
// error mapping, and timeouts. Case IDs are from docs/testing/M1-test-cases.md.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentContext } from "@agb/protocol";
import { createDispatcher, DEFAULT_TIMEOUT_MS, type GatewayDeps } from "../src/gateway/rpc";
import { validate } from "../src/gateway/validate";

interface Sent {
  method: string;
  params: unknown;
  ctx: AgentContext;
  timeoutMs: number;
}

function gateway(call?: GatewayDeps["call"]) {
  const sent: Sent[] = [];
  const dispatch = createDispatcher({
    token: "t",
    appInfo: { appVersion: "1", electronVersion: "e", chromeVersion: "c", mainPid: 1, startedAt: Date.now() },
    shellCounts: async () => ({ windows: 1, tabs: 2, agentSpaces: 3, agentTabs: 4 }),
    transports: () => ["pipe"],
    call:
      call ??
      (async (method, params, ctx, timeoutMs) => {
        sent.push({ method, params, ctx, timeoutMs });
        return { echoed: method };
      }),
  });
  const conn = { transport: "pipe" as const, authed: true };
  const rpc = (method: string, params?: unknown, ctx?: unknown) =>
    dispatch({ jsonrpc: "2.0", id: 1, method, ...(params !== undefined ? { params } : {}), ...(ctx !== undefined ? { ctx } : {}) }, conn);
  return { rpc, sent, dispatch };
}

test("V-01: agent methods are forwarded with params, ctx, and the default timeout", async () => {
  const { rpc, sent } = gateway();
  const res = await rpc("nav.goto", { url: "https://example.com", wait: "networkidle" }, { agent: "claude-code", cwd: "/w" });
  assert.deepEqual(res.result, { echoed: "nav.goto" });
  assert.deepEqual(sent, [
    { method: "nav.goto", params: { url: "https://example.com", wait: "networkidle" }, ctx: { agent: "claude-code", cwd: "/w" }, timeoutMs: DEFAULT_TIMEOUT_MS },
  ]);
  await rpc("page.text", undefined, { timeoutMs: 120_000 });
  assert.equal(sent[1]!.timeoutMs, 120_000);
  assert.deepEqual(sent[1]!.params, {});
});

test("V-02: invalid params and ctx are rejected before reaching the browser", async () => {
  const { rpc, sent } = gateway();
  const cases: [string, unknown, unknown, RegExp][] = [
    ["nav.goto", {}, undefined, /params\.url is required/],
    ["nav.goto", { url: "" }, undefined, /params\.url must not be empty/],
    ["nav.goto", { url: 42 }, undefined, /params\.url must be a string/],
    ["nav.goto", { url: "https://x", wait: "forever" }, undefined, /params\.wait must be one of load, domcontentloaded, networkidle, none/],
    ["page.capture", { quality: 0 }, undefined, /params\.quality must be at least 1/],
    ["page.capture", { quality: 50.5 }, undefined, /whole number/],
    ["page.capture", { fullPage: "yes" }, undefined, /params\.fullPage must be true or false/],
    ["page.text", { maxChars: 10 }, undefined, /at least 100/],
    ["tab.select", {}, undefined, /params\.tab is required/],
    ["space.create", { mode: "temporary" }, undefined, /params\.mode must be one of/],
    ["space.create", [], undefined, /params must be an object/],
    ["page.text", {}, { timeoutMs: 500 }, /ctx\.timeoutMs must be at least 1000/],
    ["page.text", {}, { timeoutMs: 600_000 }, /ctx\.timeoutMs must be at most 300000/],
    ["page.text", {}, { agent: 7 }, /ctx\.agent must be a string/],
    ["page.text", {}, "ctx", /ctx must be an object/],
  ];
  for (const [method, params, ctx, message] of cases) {
    const res = await rpc(method, params, ctx);
    assert.equal(res.error?.data?.name, "E_INVALID_PARAMS", `${method} ${JSON.stringify(params)}`);
    assert.match(res.error!.message, message);
  }
  assert.equal(sent.length, 0);
});

test("V-03: unknown extra fields are ignored (a newer client with the same major version still works)", async () => {
  const { rpc, sent } = gateway();
  const res = await rpc("page.capture", { fullPage: true, futureOption: 1 }, { agent: "a", futureCtx: "x" });
  assert.ok(res.result);
  assert.equal(sent.length, 1);
});

test("V-04: errors from the browser keep their name and hint", async () => {
  const { rpc } = gateway(async () => {
    throw { name: "E_NO_TAB", message: "no tab t_9 in Space sp_1", hint: "run `agb tab list`" };
  });
  const res = await rpc("tab.select", { tab: "t_9" });
  assert.equal(res.error?.code, -32011);
  assert.equal(res.error?.message, "no tab t_9 in Space sp_1");
  assert.deepEqual(res.error?.data, { name: "E_NO_TAB", hint: "run `agb tab list`" });
});

test("V-05: unexpected errors from the browser are E_INTERNAL", async () => {
  for (const thrown of [new Error("boom"), { name: "E_MADE_UP", message: "x" }, "plain string"]) {
    const { rpc } = gateway(async () => {
      throw thrown;
    });
    const res = await rpc("page.text");
    assert.equal(res.error?.data?.name, "E_INTERNAL", JSON.stringify(thrown));
  }
});

test("V-06: agent methods need authentication like everything else", async () => {
  const { dispatch, sent } = gateway();
  const res = await dispatch({ jsonrpc: "2.0", id: 1, method: "nav.goto", params: { url: "https://x" } }, { transport: "pipe", authed: false });
  assert.equal(res.error?.data?.name, "E_UNAUTHORIZED");
  assert.equal(sent.length, 0);
});

test("V-07: method names from Object.prototype are not methods", async () => {
  const { rpc } = gateway();
  for (const m of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal((await rpc(m)).error?.data?.name, "E_METHOD_NOT_FOUND", m);
  }
});

test("V-08: gateway.status includes agent Space and tab counts", async () => {
  const { rpc } = gateway();
  const st = (await rpc("gateway.status")).result as unknown as Record<string, unknown>;
  assert.equal(st.windows, 1);
  assert.equal(st.tabs, 2);
  assert.equal(st.agentSpaces, 3);
  assert.equal(st.agentTabs, 4);
});

test("V-09: validate() handles refs, arrays, and nested objects", () => {
  assert.equal(validate({ spaces: [{ id: "sp_1" }] }, "SpaceListResult"), "params.spaces[0].agent is required");
  assert.equal(validate({ at: { space: 1 }, tab: {} }, "TabResult"), "params.at.space must be a string");
  assert.equal(validate({ url: "x".repeat(8193) }, "GotoParams"), "params.url is longer than 8192 characters");
  assert.equal(validate(null, "TextParams"), "params must be an object");
  assert.equal(validate({}, "NoSuchType"), "params: unknown type NoSuchType");
  assert.equal(validate({ space: "sp_1" }, "Location"), null);
});
