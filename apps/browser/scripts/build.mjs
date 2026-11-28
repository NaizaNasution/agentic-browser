#!/usr/bin/env node
// Bundles the Electron main process, Agent Gateway, preload, and renderer with esbuild.
// Usage: node scripts/build.mjs [--tests] [--e2e] [--watch]
import { build, context } from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const dist = join(app, "dist");
const withTests = process.argv.includes("--tests");
const withE2e = process.argv.includes("--e2e");
const watch = process.argv.includes("--watch");

const alias = { "@agb/protocol": resolve(app, "../../packages/protocol/gen/ts/index.ts") };
const nodeCommon = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  external: ["electron"],
  alias,
  loader: { ".md": "text" }, // the skill guide template (src/shared/skill-guide.ts)
  logLevel: "warning",
};

const configs = [
  { ...nodeCommon, entryPoints: [join(app, "src/main/index.ts")], outfile: join(dist, "main/index.js") },
  { ...nodeCommon, entryPoints: [join(app, "src/gateway/index.ts")], outfile: join(dist, "gateway/index.js") },
  { ...nodeCommon, entryPoints: [join(app, "src/preload/index.ts")], outfile: join(dist, "preload/index.js") },
  {
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome130",
    sourcemap: true,
    alias,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
    entryPoints: [join(app, "src/renderer/main.tsx")],
    outfile: join(dist, "renderer/main.js"),
    logLevel: "warning",
  },
];

if (withTests) {
  const testDir = join(app, "test");
  const tests = readdirSync(testDir).filter((f) => f.endsWith(".test.ts"));
  configs.push({
    ...nodeCommon,
    entryPoints: tests.map((f) => join(testDir, f)),
    outdir: join(dist, "test"),
  });
}

if (withE2e) {
  const e2eDir = join(app, "test/e2e");
  const tests = readdirSync(e2eDir).filter((f) => f.endsWith(".e2e.ts"));
  configs.push({
    ...nodeCommon,
    entryPoints: tests.map((f) => join(e2eDir, f)),
    outdir: join(dist, "test-e2e"),
  });
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "renderer"), { recursive: true });
cpSync(join(app, "src/renderer/index.html"), join(dist, "renderer/index.html"));
cpSync(join(app, "src/renderer/styles.css"), join(dist, "renderer/styles.css"));

if (watch) {
  for (const c of configs) await (await context(c)).watch();
  console.log("build: watching for changes…");
} else {
  await Promise.all(configs.map((c) => build(c)));
  console.log(`build: ok${withTests ? " (with tests)" : ""}${withE2e ? " (with e2e)" : ""}`);
}
