// End-to-end tests for M3 against the real app: agb skill, agb doctor, goto --snapshot, and agent ID detection.
// Case IDs are from docs/testing/M3-test-cases.md. Needs bin/agb (`npm run build:cli`).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { App, repoRoot } from "./harness";

const agbPath = join(repoRoot, "bin", process.platform === "win32" ? "agb.exe" : "agb");
const appVersion: string = JSON.parse(readFileSync(join(repoRoot, "apps/browser/package.json"), "utf8")).version;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs bin/agb asynchronously (the fixture server lives in this process). `env` entries set to undefined are removed. */
function agb(app: App, args: string[], env: Record<string, string | undefined> = {}, cwd?: string): Promise<Run> {
  const merged: Record<string, string | undefined> = { ...process.env, AGB_HOME: app.home, AGB_AGENT: "e2e-skill", AGB_SPACE: "", AGB_TAB: "", ...env };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return new Promise((resolve, reject) => {
    const child = spawn(agbPath, args, { cwd, env: merged as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

describe("skill and doctor", { skip: !existsSync(agbPath) && "bin/agb not built; run npm run build:cli" }, () => {
  let app: App;
  let server: Server;
  let site = "";
  const home = mkdtempSync(join(tmpdir(), "agb-e2e-userhome-"));
  const work = mkdtempSync(join(tmpdir(), "agb-e2e-skill-work-"));
  // A user home with Claude Code "installed", and agb on PATH.
  const userEnv = {
    HOME: home,
    USERPROFILE: home,
    PATH: `${dirname(agbPath)}${delimiter}${process.env.PATH ?? ""}`,
  };

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<title>Shop</title><main><h1>Shop</h1><label>Search <input name="q"></label><button>Find</button><a href="/cart">Cart</a></main>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    site = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    app = await App.launch();
  });

  after(async () => {
    app?.kill();
    await new Promise<void>((r) => server?.close(() => r()));
  });

  test("Z-06: agb skill prints the running app's guide, ending with the end marker", async () => {
    const r = await agb(app, ["skill"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.startsWith("note:"), `no fallback note expected:\n${r.stdout.slice(0, 300)}`);
    assert.match(r.stdout, new RegExp(`^# Agentic Browser guide \\(app ${appVersion.replaceAll(".", "\\.")}, protocol \\d+\\.\\d+\\)`));
    assert.ok(r.stdout.endsWith("[agb:skill] end of guide\n"));
    const j = JSON.parse((await agb(app, ["--json", "skill"])).stdout);
    assert.equal(j.source, "app");
    assert.equal(j.appVersion, appVersion);
  });

  test("Z-07: skill install, then doctor reports everything ok", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const inst = await agb(app, ["skill", "install"], userEnv);
    assert.equal(inst.status, 0, inst.stderr);
    assert.match(inst.stdout, /installed: .*\.claude[\\/]skills[\\/]agentic-browser \(Claude Code\)/);
    assert.ok(existsSync(join(home, ".claude", "skills", "agentic-browser", "SKILL.md")));
    assert.ok(existsSync(join(home, ".agents", "skills", "agentic-browser", "references", "install.md")));

    const doc = await agb(app, ["--json", "doctor"], userEnv);
    const v = JSON.parse(doc.stdout);
    const by = Object.fromEntries(v.checks.map((c: { name: string }) => [c.name, c]));
    assert.equal(doc.status, 0, doc.stdout);
    for (const name of ["agb on PATH", "browser", "versions", "discovery file"]) {
      assert.ok(by[name], `missing check ${name}`);
      // On Windows CI the temp AGB_HOME may sit outside %LOCALAPPDATA%; that is a warning, not a failure.
      if (name !== "discovery file") assert.equal(by[name].level, "ok", `${name}: ${JSON.stringify(by[name])}`);
    }
    assert.match(by["browser"].detail, new RegExp(`app ${appVersion.replaceAll(".", "\\.")}`));
    const skillChecks = v.checks.filter((c: { name: string }) => c.name.startsWith("skill: "));
    assert.ok(skillChecks.length >= 2 && skillChecks.every((c: { level: string }) => c.level === "ok"), JSON.stringify(skillChecks));
  });

  test("Z-08: goto --snapshot returns the page's refs in one call", async () => {
    const r = await agb(app, ["goto", site + "/", "--snapshot"], {}, work);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^\[agb\] space=sp_\w+ \(new, isolated\) tab=t_1 url=http:\/\/127\.0\.0\.1:\d+\/ title=Shop\nok: HTTP 200 in \d+ ms\n--- page content \(untrusted/);
    assert.match(r.stdout, /textbox "Search" @e\d+/);
    assert.match(r.stdout, /button "Find" @e\d+/);
    assert.match(r.stdout, /--- end page content · \d+ refs/);
  });

  test("Z-09: without --agent or AGB_AGENT, agb labels the caller from its environment", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agb-e2e-detect-"));
    const go = await agb(app, ["goto", site + "/"], { AGB_AGENT: undefined, CLAUDECODE: "1" }, cwd);
    assert.equal(go.status, 0, go.stderr);
    const space = /space=(sp_\w+)/.exec(go.stdout)?.[1];
    assert.ok(space, go.stdout);
    const mine = JSON.parse((await agb(app, ["--json", "space", "list"], { AGB_AGENT: "claude-code" }, cwd)).stdout);
    assert.ok(mine.spaces.some((s: { id: string }) => s.id === space), `claude-code owns ${space}: ${JSON.stringify(mine)}`);
    const other = JSON.parse((await agb(app, ["--json", "space", "list"], { AGB_AGENT: "someone-else" }, cwd)).stdout);
    assert.ok(!other.spaces.some((s: { id: string }) => s.id === space), "another agent doesn't see it");
  });
});
