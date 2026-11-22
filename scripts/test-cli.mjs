#!/usr/bin/env node
// Runs go vet and go test for the agb CLI.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { goBin, run } from "./go.mjs";

const cliDir = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "apps/cli");
run(goBin(), ["vet", "./..."], cliDir);
run(goBin(), ["test", "./..."], cliDir);
