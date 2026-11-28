// End-to-end tests against the real app. Cases are from docs/testing/M0-test-cases.md.
// Run with `npm run test:e2e` (opens real windows; Windows/macOS desktop or Linux with a display).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { App, closeAllTabs, repoRoot, shellTabs, spawnApp, startSite, tempDir, waitFor, type Cdp, type Site } from "./harness";

let site: Site;
before(async () => {
  site = await startSite();
});
after(async () => {
  await site.close();
});

async function gatewayStatus(app: App): Promise<any> {
  const d = app.discovery();
  const res = await fetch(d.http + "/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${d.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "gateway.status" }),
  });
  return (await res.json()).result;
}

describe("one running app", () => {
  let app: App;
  let shell: Cdp;
  let opener: Cdp;

  before(async () => {
    app = await App.launch({ args: [site.url + "/opener"] });
    shell = await app.shell();
    opener = await app.page((u) => u.endsWith("/opener"), "opener page");
    // The DevTools target reports the URL before the page has committed, so readyState alone can be the previous
    // (blank) document's; wait for the opener's own content (D-08 clicks #pop).
    await waitFor("opener loaded", () =>
      opener.eval("location.pathname === '/opener' && document.readyState === 'complete' && !!document.getElementById('pop')"),
    );
  });

  after(() => {
    shell?.close();
    opener?.close();
    app?.kill();
  });

  test("J-01 (exit criterion): agb version talks to the running app over the pipe", (t) => {
    const agb = join(repoRoot, "bin", process.platform === "win32" ? "agb.exe" : "agb");
    if (!existsSync(agb)) return t.skip("bin/agb not built; run npm run build:cli");
    const r = spawnSync(agb, ["version"], { env: { ...process.env, AGB_HOME: app.home }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^agb \S+ \(protocol 1\.0, /m);
    assert.match(r.stdout, /^app Agentic Browser \S+ \(protocol 1\.0, Electron [\d.]+, Chrome [\d.]+\) via pipe$/m);
  });

  test("F-01: web pages get no preload, Node, or shell API", async () => {
    const types = await opener.eval<string[]>("[typeof window.agb, typeof require, typeof process, typeof module]");
    assert.deepEqual(types, ["undefined", "undefined", "undefined", "undefined"]);
  });

  test("F-06: the shell's CSP blocks inline scripts", async () => {
    const csp = await shell.eval<string>("document.querySelector('meta[http-equiv=Content-Security-Policy]').content");
    assert.match(csp, /script-src 'self'(;|$)/);
    const blocked = await shell.eval<boolean>(
      "(() => { const s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.head.appendChild(s); return window.__inline === undefined; })()",
    );
    assert.equal(blocked, true);
  });

  test("I-05: a web page can't call the gateway's HTTP endpoint", async () => {
    const { http } = app.discovery();
    const outcome = await opener.eval<string>(`(async () => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "gateway.status" });
      const results = [];
      for (const init of [
        { method: "POST", body },
        { method: "POST", body, headers: { "content-type": "application/json", authorization: "Bearer guessed" } },
      ]) {
        try { const r = await fetch(${JSON.stringify(http)} + "/rpc", init); results.push("status " + r.status + " " + (await r.text())); }
        catch (e) { results.push("blocked"); }
      }
      return results.join(" | ");
    })()`);
    assert.doesNotMatch(outcome, /appVersion|status 200/, outcome);
  });

  test("D-08: a target=_blank link opens a new tab after the opener and activates it", async () => {
    await opener.eval("document.getElementById('pop').click()", { userGesture: true });
    const tabs = await waitFor("child tab", async () => {
      const t = await shellTabs(shell);
      return t.length === 2 && t[1]!.title === "Child" ? t : undefined;
    });
    assert.deepEqual(tabs, [
      { title: "Opener", active: false },
      { title: "Child", active: true },
    ]);
  });

  test("G-09: gateway.status counts match the shell", async () => {
    const st = await gatewayStatus(app);
    assert.equal(st.tabs, (await shellTabs(shell)).length);
    assert.equal(st.windows, 1);
    assert.deepEqual(st.transports, ["pipe", "http"]);
  });

  test("E-01 / E-09: typing in the address bar navigates the active tab; the bar shows its URL", async () => {
    await shell.eval("document.querySelector('.address').focus()");
    await shell.send("Input.insertText", { text: site.url.replace("http://", "") + "/" });
    for (const type of ["keyDown", "keyUp"]) {
      await shell.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) });
    }
    await waitFor("Home title", async () => (await shellTabs(shell)).find((t) => t.active)?.title === "Home");
    const bar = await shell.eval<string>("document.querySelector('.address').value");
    assert.equal(bar, site.url + "/");
  });

  test("E-08: Escape in the address bar reverts to the tab's URL", async () => {
    await shell.eval("document.querySelector('.address').focus()");
    await shell.send("Input.insertText", { text: "something else" });
    await shell.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await shell.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await waitFor("revert", async () => (await shell.eval<string>("document.querySelector('.address').value")) === site.url + "/");
  });

  test("C-05: a second launch with the same profile exits and leaves the first running", async () => {
    const second = spawnApp(app.home, app.profile);
    const code = await new Promise<number | null>((res) => second.on("exit", res));
    assert.equal(code, 0);
    assert.ok(app.running);
    assert.equal((await gatewayStatus(app)).windows, 1);
  });

  test("D-06 / C-06 / G-04: closing the last tab quits the app and deletes gateway.json", async () => {
    assert.ok(app.hasDiscovery());
    await closeAllTabs(shell);
    assert.equal(await app.waitExit(), 0);
    assert.ok(!app.hasDiscovery(), "gateway.json should be removed on quit");
  });
});

describe("restarts", () => {
  test("G-03: the token is different on every launch", async () => {
    const home = tempDir("home");
    const profile = tempDir("profile");
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      const app = await App.launch({ home, profile });
      try {
        tokens.push(app.discovery().token);
        const shell = await app.shell();
        await closeAllTabs(shell);
        await app.waitExit();
      } finally {
        app.kill();
      }
    }
    assert.equal(tokens.length, 2);
    assert.match(tokens[0]!, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(tokens[0], tokens[1]);
  });

  test("G-07: a gateway that can't start is retried 3 times, then given up; the other copy is untouched", async () => {
    const home = tempDir("home");
    const first = await App.launch({ home });
    const second = await App.launch({ home, waitForGateway: false }); // same AGB_HOME, own profile
    try {
      const tokenBefore = first.discovery().token;
      await waitFor("second copy gives up", () => second.hasLog("gave up restarting"), 30_000);
      assert.equal(second.countLogs("[gateway] fatal"), 4, second.logs.join("\n"));
      assert.equal(first.discovery().token, tokenBefore, "first copy's gateway.json is unchanged");
      assert.equal((await gatewayStatus(first)).windows, 1, "first copy still answers");
      assert.ok(second.running, "the second copy's shell keeps running without a gateway");
    } finally {
      first.kill();
      second.kill();
    }
  });
});
