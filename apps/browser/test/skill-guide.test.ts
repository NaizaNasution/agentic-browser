// gateway.guide and the guide template (docs/testing/M3-test-cases.md, Z-01 to Z-03).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION } from "@agb/protocol";
import { createDispatcher } from "../src/gateway/rpc";
import { GUIDE_END, renderGuide } from "../src/shared/skill-guide";

const dispatch = createDispatcher({
  token: "t",
  appInfo: { appVersion: "9.9.9", electronVersion: "e", chromeVersion: "c", mainPid: 1, startedAt: Date.now() },
  shellCounts: async () => ({ windows: 1, tabs: 1 }),
  transports: () => ["pipe"],
});

test("Z-01: gateway.guide returns the guide for the running app version", async () => {
  const r = await dispatch({ jsonrpc: "2.0", id: 1, method: "gateway.guide" }, { transport: "pipe", authed: true });
  assert.equal(r.error, undefined);
  const g = r.result as { appVersion: string; protocol: string; text: string };
  assert.equal(g.appVersion, "9.9.9");
  assert.equal(g.protocol, PROTOCOL_VERSION);
  assert.ok(g.text.endsWith(`${GUIDE_END}\n`), "ends with the end marker");
  assert.match(g.text, /^# Agentic Browser guide \(app 9\.9\.9, protocol \d+\.\d+\)/);
  assert.ok(!g.text.includes("{{"), "no placeholders left");
});

test("Z-02: gateway.guide needs the token like every other method", async () => {
  const r = await dispatch({ jsonrpc: "2.0", id: 1, method: "gateway.guide" }, { transport: "pipe", authed: false });
  assert.equal(r.error?.data?.name, "E_UNAUTHORIZED");
});

test("Z-03: the bundled template is packages/skill/guide.md, rendered like the CLI renders it", () => {
  // The test bundle runs from apps/browser/dist/test.
  const file = readFileSync(join(__dirname, "../../../../packages/skill/guide.md"), "utf8");
  const expected = file.replace(/\r\n/g, "\n").replaceAll("{{appVersion}}", "1.2.3").replaceAll("{{protocol}}", "1.0");
  assert.equal(renderGuide({ appVersion: "1.2.3", protocol: "1.0" }), expected.endsWith("\n") ? expected : `${expected}\n`);
  // CRLF input (a Windows checkout) renders the same as LF.
  assert.equal(renderGuide({ appVersion: "a", protocol: "b" }, "x {{appVersion}}\r\ny {{protocol}}"), "x a\ny b\n");
});
