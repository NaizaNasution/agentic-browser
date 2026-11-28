#!/usr/bin/env node
// Builds the agb CLI into bin/agb(.exe), stamped with the app version.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { goBin, run } from "./go.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = join(root, "apps/cli");
const { version } = JSON.parse(readFileSync(join(root, "apps/browser/package.json"), "utf8"));
const out = join(root, "bin", process.platform === "win32" ? "agb.exe" : "agb");

run(process.execPath, [join(root, "scripts/sync-skill.mjs")], root); // the embedded skill package
run(goBin("gofmt"), ["-w", "internal/protocol"], cliDir); // generated code
run(goBin(), ["build", "-trimpath", "-ldflags", `-s -w -X main.version=${version}`, "-o", out, "."], cliDir);
console.log(`build-cli: wrote ${out}`);
