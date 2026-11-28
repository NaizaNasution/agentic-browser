#!/usr/bin/env node
// Real-agent eval (docs/SPEC.md §21 "Agent evals", §22 M3 exit criterion): bundles eval.ts and runs it.
// Usage: npm run eval:agent -- [--only R-01,R-03] [--model <name>] [--claude <path>] [--budget-usd 3] [--keep]
// It uses your Claude account: each task is one headless Claude Code session. It never runs in npm test.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const out = join(here, "dist", "eval.cjs");

await build({
  entryPoints: [join(here, "eval.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  logLevel: "warning",
});

const r = spawnSync(process.execPath, [out, ...process.argv.slice(2)], { cwd: root, stdio: "inherit" });
process.exit(r.status ?? 1);
