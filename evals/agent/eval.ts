// Real-agent eval for M3 (docs/SPEC.md §22): "Claude Code completes tasks from a fresh install with no extra
// instructions". Case IDs R-01 to R-08 are in docs/testing/M3-test-cases.md.
//
// For each task: a new, empty project folder; `agb skill install --project --agent claude-code` (the fresh install);
// then one headless Claude Code session with a plain task prompt that mentions neither the skill nor agb.
// The fixture web app records what really happened server-side, and that is what the check looks at.
//
// Claude Code runs with --setting-sources project (your user settings, CLAUDE.md, hooks, and user skills are
// not loaded), no MCP servers, no web tools, and permission only for `agb` commands (in Bash or PowerShell)
// and reading files.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { startFixtureApp, type FixtureApp, type FixtureState } from "../../apps/browser/test/tasks/fixture-app";

const root = resolve(__dirname, "../../..");
const appDir = join(root, "apps/browser");
const binDir = join(root, "bin");
const agbPath = join(binDir, process.platform === "win32" ? "agb.exe" : "agb");
const resultsDir = join(root, "test-results");

// ---------- options ----------

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const only = opt("--only")?.split(",").map((s) => s.trim());
const model = opt("--model");
const budget = opt("--budget-usd") ?? "3";
const keep = argv.includes("--keep");
const TASK_TIMEOUT_MS = Number(opt("--task-timeout-s") ?? 600) * 1000;

function findClaude(): string {
  const explicit = opt("--claude") ?? process.env.CLAUDE_BIN;
  if (explicit) return explicit;
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.split(/\r?\n/)[0]!.trim();
  // The Claude Code VS Code extension ships its own binary.
  const ext = join(homedir(), ".vscode", "extensions");
  if (existsSync(ext)) {
    const dirs = readdirSync(ext)
      .filter((d) => d.startsWith("anthropic.claude-code-"))
      .map((d) => join(ext, d, "resources", "native-binary", process.platform === "win32" ? "claude.exe" : "claude"))
      .filter((p) => existsSync(p))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (dirs[0]) return dirs[0];
  }
  throw new Error("Claude Code not found: put `claude` on PATH, or pass --claude <path> (or set CLAUDE_BIN)");
}

// ---------- tasks ----------

interface Ctx {
  fixture: FixtureApp;
  before: Snapshot;
  answer: string;
  downloads: string;
  project: string;
}
type Snapshot = { [K in keyof FixtureState]: number };
interface Task {
  id: string;
  name: string;
  prompt: (url: string) => string;
  setup?: (project: string) => void;
  check: (c: Ctx) => string | true;
}

const added = <K extends keyof FixtureState>(c: Ctx, k: K) => (c.fixture.state[k] as unknown[]).slice(c.before[k]) as FixtureState[K];

const TASKS: Task[] = [
  {
    id: "R-01",
    name: "fill in and submit a long sign-up form",
    prompt: (u) =>
      `Create an account for me on ${u}/signup. Name: Ada Lovelace, email: ada@example.com, country: Kenya, the Pro plan, and accept the terms. Tell me when it's done.`,
    check: (c) => {
      const s = added(c, "signups").find((x) => x.email === "ada@example.com");
      if (!s) return "no sign-up for ada@example.com reached the server";
      if (s.name !== "Ada Lovelace" || s.country !== "Kenya" || s.plan !== "pro" || s.terms !== "on") return `wrong values: ${JSON.stringify(s)}`;
      return true;
    },
  },
  {
    id: "R-02",
    name: "add items to a cart and place the order (confirm dialog)",
    prompt: (u) => `In the shop at ${u}/shop, put a Lamp and a Desk in the cart and place the order.`,
    check: (c) => {
      const o = added(c, "orders");
      return o.some((x) => [...x].sort().join(",") === "Desk,Lamp") || `orders: ${JSON.stringify(o)}`;
    },
  },
  {
    id: "R-03",
    name: "use a client-side to-do app",
    prompt: (u) => `Open my to-do list at ${u}/todo. Add "buy milk" and "call mom", then tick off "buy milk".`,
    check: (c) => {
      const t = c.fixture.state.todos;
      const milk = t.find((x) => x.text.toLowerCase() === "buy milk");
      const mom = t.find((x) => x.text.toLowerCase() === "call mom");
      return (milk?.done === true && mom?.done === false) || `todos: ${JSON.stringify(t)}`;
    },
  },
  {
    id: "R-04",
    name: "get past a cookie banner and report a heading",
    prompt: (u) => `Go to ${u}/modal, continue to the offer page, and tell me the offer page's main heading.`,
    check: (c) => {
      if (added(c, "done").filter((d) => d === "modal").length === 0) return "never reached the offer page";
      return /the offer/i.test(c.answer) || `answer doesn't name the heading: ${c.answer.slice(0, 200)}`;
    },
  },
  {
    id: "R-05",
    name: "upload a file from the project folder",
    setup: (p) => writeFileSync(join(p, "cv.txt"), "Ada Lovelace\nAnalyst, 1843\n"),
    prompt: (u) => `Upload my CV (cv.txt in this folder) using the form at ${u}/upload.`,
    check: (c) => {
      const up = added(c, "uploads");
      return up.some((x) => x.name === "cv.txt" && x.size === 27) || `uploads: ${JSON.stringify(up)}`;
    },
  },
  {
    id: "R-06",
    name: "find a row in a paginated table",
    prompt: (u) => `In the countries table at ${u}/table, open the Edit page for Japan.`,
    check: (c) => added(c, "edits").includes("Japan") || `edits: ${JSON.stringify(added(c, "edits"))}`,
  },
  {
    id: "R-07",
    name: "use search suggestions",
    prompt: (u) => `Use the country search on ${u}/search to open Norway's page.`,
    check: (c) => added(c, "done").includes("country:Norway") || `done: ${JSON.stringify(added(c, "done"))}`,
  },
  {
    id: "R-08",
    name: "download a report and read a value from it",
    prompt: (u) => `Download the CSV report from ${u}/export and tell me how many visits Kenya had.`,
    check: (c) => {
      if (!findFile(c.downloads, "report.csv")) return "report.csv was not downloaded";
      return /\b42\b/.test(c.answer) || `answer doesn't say 42: ${c.answer.slice(0, 200)}`;
    },
  },
];

function findFile(dir: string, name: string): boolean {
  if (!existsSync(dir)) return false;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() ? findFile(join(dir, e.name), name) : e.name === name) return true;
  }
  return false;
}

// ---------- the browser ----------

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of Object.keys(env)) {
    // Not inherited: the app must not start as plain Node, a nested Claude Code must not think it is inside
    // this session, and agb must work out its own Space and agent ID.
    if (k === "ELECTRON_RUN_AS_NODE" || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "AGB_SPACE" || k === "AGB_TAB" || k === "AGB_AGENT") delete env[k];
  }
  return env;
}

async function launchBrowser(home: string, profile: string, downloads: string): Promise<{ proc: ChildProcess; logs: string[] }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron: string = require("electron");
  const logs: string[] = [];
  const proc = spawn(electron, [appDir], {
    env: cleanEnv({ AGB_HOME: home, AGB_PROFILE_DIR: profile, AGB_DOWNLOAD_DIR: downloads }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const onData = (d: Buffer) => logs.push(...d.toString("utf8").split(/\r?\n/).filter(Boolean));
  proc.stdout!.on("data", onData);
  proc.stderr!.on("data", onData);
  const end = Date.now() + 30_000;
  while (!logs.some((l) => l.includes("[gateway] ready"))) {
    if (proc.exitCode !== null || Date.now() > end) throw new Error(`the browser didn't start:\n${logs.slice(-20).join("\n")}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { proc, logs };
}

// ---------- one Claude Code session ----------

interface Transcript {
  answer: string;
  isError: boolean;
  turns: number;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  skillInvoked: boolean;
  ranGuide: boolean;
  agbCalls: number;
  otherTools: string[];
  denied: number;
  skillsListed: string[];
  timedOut: boolean;
}

function runClaude(claude: string, prompt: string, cwd: string, env: NodeJS.ProcessEnv, transcriptFile: string): Promise<Transcript> {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--max-budget-usd", budget,
    "--disallowedTools", "WebFetch", "WebSearch",
    "--allowedTools", "Bash(agb:*)", "PowerShell(agb:*)", "Read", "Glob", "Grep", "Skill",
    ...(model ? ["--model", model] : []),
  ];
  const t: Transcript = {
    answer: "", isError: false, turns: 0, costUsd: 0, durationMs: 0, inputTokens: 0, outputTokens: 0,
    skillInvoked: false, ranGuide: false, agbCalls: 0, otherTools: [], denied: 0, skillsListed: [], timedOut: false,
  };
  const lines: string[] = [];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(claude, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(prompt); // the prompt goes on stdin, so the variadic --allowedTools can't swallow it
    let buf = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        lines.push(line);
        try {
          onEvent(JSON.parse(line), t);
        } catch {
          /* not JSON */
        }
      }
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => {
      t.timedOut = true;
      child.kill();
    }, TASK_TIMEOUT_MS);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(transcriptFile, lines.join("\n") + "\n" + (stderr ? `\n# stderr\n${stderr}` : ""));
      if (code !== 0 && !t.answer) t.isError = true;
      resolvePromise(t);
    });
  });
}

/** Reads Claude Code's stream-json events. */
function onEvent(e: any, t: Transcript): void {
  if (e.type === "system" && e.subtype === "init") {
    t.skillsListed = (e.skills ?? e.slash_commands ?? []).map(String);
  }
  if (e.type === "assistant") {
    for (const b of e.message?.content ?? []) {
      if (b.type !== "tool_use") continue;
      if (b.name === "Skill") {
        if (JSON.stringify(b.input ?? {}).includes("agentic-browser")) t.skillInvoked = true;
      } else if (b.name === "Bash" || b.name === "PowerShell") {
        const cmd = String(b.input?.command ?? "");
        if (/(^|[\s;&|(])agb(\.exe)?\s/.test(cmd + " ")) t.agbCalls++;
        if (/(^|[\s;&|(])agb(\.exe)?\s+skill(\s*$|\s*[;&|>]|\s+--json)/.test(cmd)) t.ranGuide = true;
        if (!/(^|[\s;&|(])agb(\.exe)?\s/.test(cmd + " ")) t.otherTools.push(`${b.name}: ${cmd.slice(0, 80)}`);
      } else {
        t.otherTools.push(b.name);
      }
    }
  }
  if (e.type === "user") {
    for (const b of e.message?.content ?? []) {
      if (b.type === "tool_result" && b.is_error && /permission|denied|not allowed/i.test(JSON.stringify(b.content ?? ""))) t.denied++;
    }
  }
  if (e.type === "result") {
    t.answer = String(e.result ?? "");
    t.isError = Boolean(e.is_error);
    t.turns = e.num_turns ?? 0;
    t.costUsd = e.total_cost_usd ?? 0;
    t.durationMs = e.duration_ms ?? 0;
    t.inputTokens = (e.usage?.input_tokens ?? 0) + (e.usage?.cache_read_input_tokens ?? 0) + (e.usage?.cache_creation_input_tokens ?? 0);
    t.outputTokens = e.usage?.output_tokens ?? 0;
  }
}

// ---------- main ----------

async function main() {
  const tasks = TASKS.filter((t) => !only || only.includes(t.id));
  if (!tasks.length) throw new Error(`no tasks match --only ${only?.join(",")}`);
  const claude = findClaude();
  console.log(`eval: Claude Code at ${claude}`);
  const version = spawnSync(claude, ["--version"], { encoding: "utf8", env: cleanEnv({}) }).stdout.trim();
  console.log(`eval: ${version}; ${tasks.length} task(s); budget $${budget} per task`);

  console.log("eval: building the app and agb");
  for (const [cmd, args] of [[process.execPath, [join(appDir, "scripts/build.mjs")]], [process.execPath, [join(root, "scripts/build-cli.mjs")]]] as const) {
    const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
    if (r.status !== 0) throw new Error(`build failed: ${args.join(" ")}`);
  }

  const work = mkdtempSync(join(tmpdir(), "agb-eval-"));
  const home = join(work, "agb-home");
  const downloads = join(work, "downloads");
  mkdirSync(home);
  mkdirSync(downloads);
  const transcripts = join(resultsDir, "m3-agent-eval");
  mkdirSync(transcripts, { recursive: true });

  const fixture = await startFixtureApp();
  const browser = await launchBrowser(home, join(work, "profile"), downloads);
  console.log(`eval: browser running; fixture at ${fixture.url}; work folder ${work}`);

  const results: Record<string, unknown>[] = [];
  try {
    for (const task of tasks) {
      const project = join(work, `project-${task.id}`);
      mkdirSync(project);
      task.setup?.(project);
      const env = cleanEnv({ AGB_HOME: home, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` });
      // The fresh install: the skill in this project's .claude/skills, nothing else.
      const inst = spawnSync(agbPath, ["skill", "install", "--project", "--agent", "claude-code"], { cwd: project, env, encoding: "utf8" });
      if (inst.status !== 0) throw new Error(`agb skill install failed: ${inst.stdout}${inst.stderr}`);

      const before = Object.fromEntries(Object.entries(fixture.state).map(([k, v]) => [k, (v as unknown[]).length])) as Snapshot;
      process.stdout.write(`${task.id} ${task.name} … `);
      const started = Date.now();
      const t = await runClaude(claude, task.prompt(fixture.url), project, env, join(transcripts, `${task.id}.jsonl`));
      await new Promise((r) => setTimeout(r, 300)); // let the last requests reach the fixture
      const verdict = t.timedOut ? "timed out" : t.isError && !t.answer ? "Claude Code failed (see transcript)" : task.check({ fixture, before, answer: t.answer, downloads, project });
      const ok = verdict === true;
      console.log(`${ok ? "ok" : "FAIL"} (${((Date.now() - started) / 1000).toFixed(0)} s, ${t.agbCalls} agb calls, skill ${t.skillInvoked ? "loaded" : "not loaded"}${t.ranGuide ? ", read the guide" : ""})${ok ? "" : `: ${verdict}`}`);
      results.push({ id: task.id, name: task.name, ok, why: ok ? undefined : verdict, ...t, answer: t.answer.slice(0, 2000) });
    }
  } finally {
    browser.proc.kill();
    await fixture.close();
  }

  const passed = results.filter((r) => r.ok).length;
  const sum = (k: string) => results.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const summary = {
    summary: `${passed}/${results.length} tasks succeeded (${((100 * passed) / results.length).toFixed(1)}%)`,
    claudeCode: version,
    model: model ?? "default",
    skillLoaded: `${results.filter((r) => r.skillInvoked).length}/${results.length}`,
    readGuide: `${results.filter((r) => r.ranGuide).length}/${results.length}`,
    agbCalls: sum("agbCalls"),
    turns: sum("turns"),
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    costUsd: Number(sum("costUsd").toFixed(4)),
    results,
  };
  const reportFile = join(resultsDir, "m3-agent-eval.json");
  writeFileSync(reportFile, JSON.stringify(summary, null, 2) + "\n");
  console.log(`\neval: ${summary.summary}; skill loaded ${summary.skillLoaded}; guide read ${summary.readGuide}; ${summary.agbCalls} agb calls; $${summary.costUsd}`);
  console.log(`eval: report ${reportFile}; transcripts in ${transcripts}`);
  if (!keep) {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* the browser may still hold files for a moment */
    }
  } else console.log(`eval: kept ${work}`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(`eval: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
