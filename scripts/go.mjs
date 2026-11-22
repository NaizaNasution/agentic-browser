// Finds the Go toolchain (PATH first, then the default install location) and runs it.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function goBin(tool = "go") {
  const exe = process.platform === "win32" ? `${tool}.exe` : tool;
  const which = spawnSync(process.platform === "win32" ? "where" : "which", [tool], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.split(/\r?\n/)[0].trim();
  const candidates =
    process.platform === "win32"
      ? [join(process.env.ProgramFiles ?? "C:\\Program Files", "Go", "bin", exe)]
      : ["/usr/local/go/bin/" + exe, "/opt/homebrew/bin/" + exe];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.error(`${tool} not found. Install Go 1.24+ (https://go.dev/dl/) and try again.`);
    process.exit(1);
  }
  return found;
}

export function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
