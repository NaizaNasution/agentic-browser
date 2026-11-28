#!/usr/bin/env node
// Copies the skill package (packages/skill) into the agb CLI, which embeds it (apps/cli/internal/skill/files).
// Go can only embed files inside its own module, so the copy is checked in, like the generated protocol code.
// Usage: node scripts/sync-skill.mjs [--check]   (--check fails if the copy is out of date)
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "packages/skill");
const dst = join(root, "apps/cli/internal/skill/files");
const check = process.argv.includes("--check");

/** Files that ship: SKILL.md, the guide template, the target list, and references/*.md. */
function list(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...list(p, base));
    else if (/\.(md|json)$/.test(e.name) && e.name !== "package.json") out.push(relative(base, p).replaceAll("\\", "/"));
  }
  return out.sort();
}

const want = list(src);
const have = existsSync(dst) ? list(dst) : [];
const stale = [];
for (const f of want) {
  const body = readFileSync(join(src, f));
  const target = join(dst, f);
  if (existsSync(target) && readFileSync(target).equals(body)) continue;
  stale.push(f);
  if (!check) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
}
for (const f of have.filter((f) => !want.includes(f))) {
  stale.push(`${f} (removed)`);
  if (!check) rmSync(join(dst, f));
}

if (check && stale.length) {
  console.error(`sync-skill: apps/cli/internal/skill/files is out of date: ${stale.join(", ")}\nrun \`npm run codegen\``);
  process.exit(1);
}
console.log(`sync-skill: ${check ? "up to date" : stale.length ? `updated ${stale.join(", ")}` : "already up to date"}`);
