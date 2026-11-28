// M2 exit criterion (docs/SPEC.md §22): "90% success on the fixture task suite".
//
// Each task drives the real app through the real `agb` CLI the way an agent would: take a snapshot, find the
// element by its role and name, act on its ref, and repeat. Success is checked against what the fixture app
// recorded server-side (or a downloaded file), not against what the agent believes happened.
// Run with `npm run build:cli && npm run test:e2e`. Case IDs (T-01…) are in docs/testing/M2-test-cases.md.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startFixtureApp, type FixtureApp } from "../tasks/fixture-app";
import { App, repoRoot } from "./harness";

const agbPath = join(repoRoot, "bin", process.platform === "win32" ? "agb.exe" : "agb");
const TASK_TIMEOUT_MS = 60_000;
const PASS_RATE = 0.9;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** An agent session: one agent ID and working directory, talking to the app through bin/agb. */
class Agent {
  commands = 0;
  constructor(
    private readonly app: App,
    readonly id: string,
    readonly work: string,
  ) {}

  run(...args: string[]): Promise<Run> {
    this.commands++;
    return new Promise((resolve, reject) => {
      const child = spawn(agbPath, args, { cwd: this.work, env: { ...process.env, AGB_HOME: this.app.home, AGB_AGENT: this.id, AGB_SPACE: "", AGB_TAB: "" }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  }

  /** Runs a command that must succeed. */
  async ok(...args: string[]): Promise<string> {
    const r = await this.run(...args);
    if (r.status !== 0) throw new Error(`agb ${args.join(" ")} exited ${r.status}: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout;
  }

  snapshot(): Promise<string> {
    return this.ok("snapshot", "--max-tokens", "20000");
  }

  /** The ref of the first element with this role and name in a fresh snapshot (like an agent reading it). */
  async ref(role: string, name: string | RegExp, snapshot?: string): Promise<string> {
    const text = snapshot ?? (await this.snapshot());
    for (const line of text.split("\n")) {
      const m = /^\s*(\S+)(?: "((?:[^"\\]|\\.)*)")? (@e\d+)/.exec(line);
      if (!m || m[1] !== role) continue;
      const n = (m[2] ?? "").replace(/\\"/g, '"');
      if (typeof name === "string" ? n === name : name.test(n)) return m[3]!;
    }
    throw new Error(`no ${role} ${String(name)} in the snapshot:\n${text}`);
  }

  async click(role: string, name: string | RegExp): Promise<string> {
    return this.ok("click", await this.ref(role, name));
  }

  text(): Promise<string> {
    return this.ok("text");
  }
}

interface Task {
  id: string;
  name: string;
  run(a: Agent, f: FixtureApp): Promise<void>;
}

/** T-09 and T-10 don't depend on T-08 having passed. */
function seedTodos(f: FixtureApp): void {
  for (const text of ["Buy milk", "Call mom", "Write report"]) {
    if (!f.state.todos.some((t) => t.text === text)) f.state.todos.push({ id: f.state.todos.length + 100, text, done: false });
  }
}

const eventually = async (what: string, fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`never happened: ${what}`);
};

const TASKS: Task[] = [
  {
    id: "T-01",
    name: "sign in and reach the dashboard",
    async run(a, f) {
      await a.ok("goto", f.url + "/login");
      const s = await a.snapshot();
      await a.ok("fill", await a.ref("textbox", "Username", s), "ana");
      await a.ok("fill", await a.ref("textbox", "Password", s), "correct horse");
      const out = await a.click("button", "Sign in");
      assert.match(out, /navigated to .*\/dashboard/);
      assert.match(await a.text(), /Welcome, ana/);
      assert.deepEqual(f.state.logins, ["ana"]);
    },
  },
  {
    id: "T-02",
    name: "a wrong password shows an error",
    async run(a, f) {
      await a.ok("goto", f.url + "/login");
      const s = await a.snapshot();
      await a.ok("fill", await a.ref("textbox", "Username", s), "bo");
      await a.ok("fill", await a.ref("textbox", "Password", s), "wrong", "--submit");
      await a.ref("alert", "Wrong username or password");
      assert.ok(!f.state.logins.includes("bo"));
    },
  },
  {
    id: "T-03",
    name: "fill a long sign-up form (text, email, select, radio, textarea, checkbox)",
    async run(a, f) {
      await a.ok("goto", f.url + "/signup");
      const s = await a.snapshot();
      await a.ok("fill", await a.ref("textbox", "Full name", s), "Ana Lima");
      await a.ok("fill", await a.ref("textbox", "Email", s), "ana@example.com");
      await a.ok("select", await a.ref("combobox", "Country", s), "Kenya");
      await a.ok("check", await a.ref("radio", "Pro", s));
      await a.ok("fill", await a.ref("textbox", "About you", s), "I build agents.\nAnd browsers.");
      await a.ok("check", await a.ref("checkbox", "I accept the terms", s));
      await a.click("button", "Create account");
      assert.deepEqual(f.state.signups.at(-1), { name: "Ana Lima", email: "ana@example.com", country: "Kenya", plan: "pro", bio: "I build agents.\r\nAnd browsers.", terms: "on" });
    },
  },
  {
    id: "T-04",
    name: "browser validation stops an incomplete form; fixing it submits",
    async run(a, f) {
      await a.ok("goto", f.url + "/signup");
      const s = await a.snapshot();
      const before = f.state.signups.length;
      await a.ok("fill", await a.ref("textbox", "Full name", s), "Bo");
      await a.click("button", "Create account");
      assert.equal(f.state.signups.length, before, "required fields are empty");
      await a.ok("fill", await a.ref("textbox", "Email", s), "bo@example.com");
      await a.ok("check", await a.ref("checkbox", "I accept the terms", s));
      await a.click("button", "Create account");
      assert.equal(f.state.signups.at(-1)!.email, "bo@example.com");
    },
  },
  {
    id: "T-05",
    name: "add items to the cart",
    async run(a, f) {
      await a.ok("goto", f.url + "/shop");
      await a.click("button", "Add Lamp to cart");
      await a.click("button", "Add Desk to cart");
      assert.match(await a.text(), /Cart: 2 items/);
    },
  },
  {
    id: "T-06",
    name: "place an order, accepting the confirm dialog",
    async run(a, f) {
      await a.ok("goto", f.url + "/shop");
      await a.click("button", "Add Chair to cart");
      await a.click("link", "View cart");
      const out = await a.click("button", "Place order");
      assert.match(out, /a confirm dialog is waiting: "Place an order for 1 items\?"/);
      const accepted = await a.ok("dialog", "accept");
      assert.match(accepted, /\+ status "Order placed"|~ status "Order placed"/);
      assert.deepEqual(f.state.orders.at(-1), ["Chair"]);
    },
  },
  {
    id: "T-07",
    name: "cancel an order by dismissing the confirm dialog",
    async run(a, f) {
      const before = f.state.orders.length;
      await a.ok("goto", f.url + "/shop");
      await a.click("button", "Add Lamp to cart");
      await a.click("link", "View cart");
      await a.click("button", "Place order");
      await a.ok("dialog", "dismiss");
      await a.ref("status", "Order cancelled");
      assert.equal(f.state.orders.length, before);
    },
  },
  {
    id: "T-08",
    name: "add three to-dos in a client-side app",
    async run(a, f) {
      await a.ok("goto", f.url + "/todo");
      for (const t of ["Buy milk", "Call mom", "Write report"]) await a.ok("fill", await a.ref("textbox", "New todo"), t, "--submit");
      await eventually("3 todos saved", () => f.state.todos.length === 3);
      assert.deepEqual(f.state.todos.map((t) => t.text), ["Buy milk", "Call mom", "Write report"]);
    },
  },
  {
    id: "T-09",
    name: "complete a to-do (the list re-renders after each change)",
    async run(a, f) {
      seedTodos(f);
      await a.ok("goto", f.url + "/todo");
      await a.ok("check", await a.ref("checkbox", "Call mom"));
      await eventually("todo done", () => f.state.todos.find((t) => t.text === "Call mom")?.done === true);
      assert.match(await a.text(), /2 left/);
    },
  },
  {
    id: "T-10",
    name: "delete a to-do",
    async run(a, f) {
      seedTodos(f);
      await a.ok("goto", f.url + "/todo");
      await a.click("button", "Delete Buy milk");
      await eventually("todo deleted", () => !f.state.todos.some((t) => t.text === "Buy milk"));
    },
  },
  {
    id: "T-11",
    name: "a cookie banner covers the page: dismiss it, then continue",
    async run(a, f) {
      await a.ok("goto", f.url + "/modal");
      const blocked = await a.run("click", await a.ref("link", "Continue"), "--timeout", "8s");
      assert.equal(blocked.status, 9, "E_NOT_ACTIONABLE");
      assert.match(blocked.stderr, /covered by dialog "Cookie consent" @e\d+/);
      await a.click("button", "Reject all");
      await a.click("link", "Continue");
      assert.ok(f.state.done.includes("modal"));
    },
  },
  {
    id: "T-12",
    name: "subscribe through a form inside shadow DOM",
    async run(a, f) {
      await a.ok("goto", f.url + "/shadow");
      await a.ok("fill", await a.ref("textbox", "Email address"), "ana@example.com");
      await a.click("button", "Subscribe");
      await a.ref("status", "Subscribed");
      assert.deepEqual(f.state.shadow, ["ana@example.com"]);
    },
  },
  {
    id: "T-13",
    name: "click a button inside a same-site iframe",
    async run(a, f) {
      await a.ok("goto", f.url + "/frames");
      const out = await a.click("button", "Like");
      assert.match(out, /~ button "Liked" @e\d+/);
    },
  },
  {
    id: "T-14",
    name: "submit a form inside a cross-site iframe",
    async run(a, f) {
      await a.ok("goto", f.url + "/frames");
      await a.ok("fill", await a.ref("textbox", "Partner code"), "SAVE10");
      await a.click("button", "Redeem");
      await eventually("partner got the code", () => f.state.partner.includes("SAVE10"));
    },
  },
  {
    id: "T-15",
    name: "scroll an infinite feed until story 40 appears, then open it",
    async run(a, f) {
      await a.ok("goto", f.url + "/feed");
      for (let i = 0; i < 20; i++) {
        const s = await a.snapshot();
        if (/link "Read story 40"/.test(s)) {
          await a.ok("click", await a.ref("link", "Read story 40", s));
          assert.deepEqual(f.state.opened, [40]);
          return;
        }
        await a.ok("scroll", "--to", "bottom");
      }
      assert.fail("story 40 never loaded");
    },
  },
  {
    id: "T-16",
    name: "acknowledge an alert",
    async run(a, f) {
      await a.ok("goto", f.url + "/dialogs");
      assert.match(await a.click("button", "Show notice"), /alert dialog is waiting: "Maintenance tonight"/);
      assert.equal((await a.run("text")).status, 1, "E_DIALOG_OPEN while the alert waits");
      await a.ok("dialog", "accept");
      await a.ref("status", "Notice seen");
    },
  },
  {
    id: "T-17",
    name: "a dialog opened later by a timer blocks the next command until answered",
    async run(a, f) {
      await a.ok("goto", f.url + "/dialogs");
      await a.click("button", "Remind me in a moment");
      await new Promise((r) => setTimeout(r, 1000));
      const blocked = await a.run("snapshot");
      assert.equal(blocked.status, 1);
      assert.match(blocked.stderr, /E_DIALOG_OPEN: a confirm dialog is open: "Time for your break\?"/);
      assert.match(await a.ok("dialog"), /confirm dialog: "Time for your break\?"/);
      await a.ok("dialog", "accept");
      await a.ref("status", "Break started");
    },
  },
  {
    id: "T-18",
    name: "download a CSV into the Space's download folder",
    async run(a, f) {
      await a.ok("goto", f.url + "/export");
      const out = await a.click("link", "Download CSV report");
      const path = /downloaded: d_1 report\.csv \(\d+ bytes\) → (.+)$/m.exec(out)?.[1];
      assert.ok(path, out);
      assert.equal(readFileSync(path.trim(), "utf8"), "country,visits\nKenya,42\nJapan,17\n");
      assert.match(await a.ok("download", "list"), /d_1 {2}completed/);
    },
  },
  {
    id: "T-19",
    name: "upload a file from the working directory",
    async run(a, f) {
      writeFileSync(join(a.work, "cv.txt"), "Ana Lima — CV");
      await a.ok("goto", f.url + "/upload");
      await a.ok("upload", await a.ref("button", "CV file"), "cv.txt");
      await a.click("button", "Send");
      assert.deepEqual(f.state.uploads.at(-1), { name: "cv.txt", size: Buffer.byteLength("Ana Lima — CV") });
    },
  },
  {
    id: "T-20",
    name: "open a hover menu and choose an item",
    async run(a, f) {
      await a.ok("goto", f.url + "/menu");
      const s = await a.snapshot();
      assert.ok(!/link "Settings"/.test(s), "the submenu starts hidden");
      // The trigger is a <span tabindex="0">: no role, but focusable, so it has a ref.
      await a.ok("hover", await a.ref("focusable", /^Account/, s));
      await a.click("link", "Settings");
      assert.ok(f.state.done.includes("menu-settings"));
    },
  },
  {
    id: "T-21",
    name: "choose from an ARIA combobox and a native select, then save",
    async run(a, f) {
      await a.ok("goto", f.url + "/widgets");
      const s = await a.snapshot();
      await a.ok("select", await a.ref("combobox", "Favorite fruit", s), "Mango");
      await a.ok("select", await a.ref("combobox", "Language", s), "Japanese");
      await a.click("button", "Save preferences");
      await eventually("prefs saved", () => f.state.fruit.includes("Mango/Japanese"));
    },
  },
  {
    id: "T-22",
    name: "switch to another tab panel and read it",
    async run(a, f) {
      await a.ok("goto", f.url + "/widgets");
      await a.click("tab", "Billing");
      assert.match(await a.text(), /Plan: Pro, renews 1 March/);
    },
  },
  {
    id: "T-23",
    name: "a link opens a new tab: follow it and read it",
    async run(a, f) {
      await a.ok("goto", f.url + "/popup");
      const out = await a.ok("click", await a.ref("link", "Open the refund policy"), "--follow");
      assert.match(out, /opened tab t_2/);
      assert.match(out, /^\[agb\] space=\S+ tab=t_2/m, "--follow made the new tab active");
      await a.ok("wait", "--text", "Refunds");
      assert.match(await a.text(), /Refunds within 30 days/);
    },
  },
  {
    id: "T-24",
    name: "search with live suggestions",
    async run(a, f) {
      await a.ok("goto", f.url + "/search");
      await a.ok("fill", await a.ref("searchbox", "Search countries"), "ke");
      await a.ok("wait", "--text", "Kenya");
      await a.click("link", "Kenya");
      assert.ok(f.state.done.includes("country:Kenya"));
    },
  },
  {
    id: "T-25",
    name: "a three-step wizard whose Next buttons start disabled",
    async run(a, f) {
      await a.ok("goto", f.url + "/wizard");
      const disabled = await a.run("click", await a.ref("button", "Next"), "--timeout", "8s");
      assert.equal(disabled.status, 9);
      assert.match(disabled.stderr, /is disabled/);
      await a.ok("fill", await a.ref("spinbutton", "Nights"), "3");
      await a.click("button", "Next");
      await a.ok("fill", await a.ref("textbox", "Guest name"), "Ana");
      await a.click("button", "Next");
      await a.ok("check", await a.ref("checkbox", "I agree to the house rules"));
      await a.click("button", "Book now");
      await eventually("booked", () => f.state.wizard.length === 1);
      assert.deepEqual(f.state.wizard[0], { nights: "3", guest: "Ana" });
    },
  },
  {
    id: "T-26",
    name: "page through a table to find a row and edit it",
    async run(a, f) {
      await a.ok("goto", f.url + "/table");
      for (let i = 0; i < 5; i++) {
        const s = await a.snapshot();
        if (/link "Edit Kenya"/.test(s)) {
          await a.ok("click", await a.ref("link", "Edit Kenya", s));
          assert.deepEqual(f.state.edits, ["Kenya"]);
          return;
        }
        await a.ok("click", await a.ref("link", "Next page", s));
      }
      assert.fail("Kenya not found");
    },
  },
  {
    id: "T-27",
    name: "open a command palette with Control+K and run a command",
    async run(a, f) {
      await a.ok("goto", f.url + "/palette");
      await a.ok("press", "Control+K");
      await a.ok("type", "dark");
      await a.ok("press", "Enter");
      await eventually("command ran", () => f.state.palette.includes("Dark mode"));
    },
  },
  {
    id: "T-28",
    name: "replace the text of a rich-text editor",
    async run(a, f) {
      await a.ok("goto", f.url + "/editor");
      await a.ok("fill", await a.ref("textbox", "Note"), "Ship M2 on Friday");
      await a.click("button", "Save note");
      await eventually("note saved", () => f.state.editor.length === 1);
      assert.equal(f.state.editor[0], "Ship M2 on Friday");
    },
  },
  {
    id: "T-29",
    name: "wait for content that arrives late",
    async run(a, f) {
      await a.ok("goto", f.url + "/slow");
      assert.ok(!/link "Open the report"/.test(await a.snapshot()));
      await a.ok("wait", "--text", "Open the report");
      await a.click("link", "Open the report");
      assert.ok(f.state.done.includes("slow"));
    },
  },
  {
    id: "T-30",
    name: "expand a disclosure to read the answer",
    async run(a, f) {
      await a.ok("goto", f.url + "/faq");
      assert.doesNotMatch(await a.snapshot(), /45 days/);
      assert.doesNotMatch(await a.text(), /45 days/, "a closed <details> body isn't readable text either");
      await a.click("button", "What is the return window?");
      assert.match(await a.text(), /within 45 days/);
    },
  },
  {
    id: "T-31",
    name: "navigate, go back, and go forward",
    async run(a, f) {
      await a.ok("goto", f.url + "/a");
      await a.click("link", "Go to B");
      assert.match(await a.ok("back"), /title="Page A"/);
      assert.match(await a.ok("forward"), /title="Page B"/);
    },
  },
  {
    id: "T-32",
    name: "work in two tabs",
    async run(a, f) {
      await a.ok("goto", f.url + "/a");
      await a.ok("tab", "new", f.url + "/b");
      assert.match(await a.ok("tab", "list"), /t_1 .*\/a .*\nt_2 .*\/b .*\(active\)/);
      await a.ok("tab", "select", "t_1");
      assert.match(await a.text(), /Page A/);
      await a.ok("tab", "close", "t_2");
    },
  },
  {
    id: "T-33",
    name: "an element replaced after every click is re-found by its ref",
    async run(a, f) {
      await a.ok("goto", f.url + "/rerender");
      const ref = await a.ref("button", "Increment");
      await a.ok("click", ref);
      const second = await a.ok("click", ref); // the old element is gone; the same ref finds its replacement
      assert.match(second, /note: @e\d+ re-resolved/);
      await eventually("counted twice", () => f.state.done.includes("count:2"));
    },
  },
  {
    id: "T-34",
    name: "an old ref after navigation is an error, not a wrong click",
    async run(a, f) {
      await a.ok("goto", f.url + "/a");
      const ref = await a.ref("link", "Go to B");
      await a.ok("click", ref);
      const r = await a.run("click", ref);
      assert.equal(r.status, 5, "E_NO_REF or E_STALE_REF");
      assert.match(await a.text(), /Page B/, "still on page B");
    },
  },
  {
    id: "T-35",
    name: "read a page's text and refs in a scoped snapshot",
    async run(a, f) {
      await a.ok("goto", f.url + "/signup");
      const form = await a.ok("snapshot", "--scope", await a.ref("main", ""));
      assert.match(form, /textbox "Full name" @e\d+/);
      assert.match(form, /combobox "Country" @e\d+ value="Argentina"/);
    },
  },
];

let fixture: FixtureApp;
let app: App;

before(async () => {
  fixture = await startFixtureApp();
  app = await App.launch({ args: [], env: { AGB_DOWNLOAD_DIR: mkdtempSync(join(tmpdir(), "agb-tasks-dl-")) } });
});

after(async () => {
  app?.kill();
  await fixture?.close();
});

// The suite takes about a minute, longer than test:e2e's per-test default (60 s), which would kill the app mid-suite.
test(`M2 exit criterion: at least ${PASS_RATE * 100}% of ${TASKS.length} fixture tasks succeed`, { timeout: 10 * 60_000, skip: !existsSync(agbPath) && "bin/agb not built; run npm run build:cli" }, async () => {
  const results: { id: string; name: string; ok: boolean; ms: number; commands: number; error?: string }[] = [];
  for (const task of TASKS) {
    // Each task is its own agent, so it starts with a fresh, isolated Space.
    const agent = new Agent(app, `task-${task.id.toLowerCase()}`, mkdtempSync(join(tmpdir(), "agb-task-")));
    const started = Date.now();
    let error: string | undefined;
    try {
      await Promise.race([task.run(agent, fixture), new Promise((_, reject) => setTimeout(() => reject(new Error("task timed out")), TASK_TIMEOUT_MS))]);
    } catch (e) {
      error = (e instanceof Error ? e.message : String(e)).split("\n").slice(0, 6).join("\n");
    } finally {
      await agent.run("space", "close");
    }
    results.push({ id: task.id, name: task.name, ok: !error, ms: Date.now() - started, commands: agent.commands - 1, ...(error ? { error } : {}) });
  }

  const passed = results.filter((r) => r.ok).length;
  if (passed < results.length || !app.running) {
    console.log(`\n${app.running ? "Some tasks failed" : "The app exited during the suite"}. The app's log (gateway, agent):\n${app.logs.filter((l) => /\[(gateway|agent)\]|rror|crash|exited/i.test(l)).slice(-60).join("\n")}\n`);
  }
  const rate = passed / results.length;
  const lines = results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.id}  ${String(r.ms).padStart(6)} ms  ${String(r.commands).padStart(2)} cmds  ${r.name}${r.error ? `\n        ${r.error.replace(/\n/g, "\n        ")}` : ""}`);
  const summary = `${passed}/${results.length} tasks succeeded (${(rate * 100).toFixed(1)}%; target ${PASS_RATE * 100}%)`;
  console.log(["", "Fixture task suite", ...lines, summary, ""].join("\n"));
  const reportDir = join(repoRoot, "test-results");
  try {
    (await import("node:fs")).mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, "m2-task-suite.json"), JSON.stringify({ summary, rate, results }, null, 2));
  } catch {
    /* the report is a convenience */
  }
  assert.ok(rate >= PASS_RATE, summary);
});
