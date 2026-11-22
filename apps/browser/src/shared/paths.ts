// Where the Gateway puts its discovery file and pipe/socket (docs/SPEC.md §8.1).
// The `agb` CLI resolves the same locations (apps/cli/internal/discovery).
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/** Directory for gateway.json and (on macOS/Linux) the socket. `AGB_HOME` overrides it. */
export function agbHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.AGB_HOME) return env.AGB_HOME;
  switch (platform) {
    case "win32":
      return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "AgenticBrowser");
    case "darwin":
      return join(homedir(), "Library", "Application Support", "AgenticBrowser");
    default:
      return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "agentic-browser");
  }
}

export function discoveryPath(home = agbHome()): string {
  return join(home, "gateway.json");
}

/** Named pipe (Windows) or Unix socket path. Unique per user and per AGB_HOME. */
export function pipePath(home = agbHome(), platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const id = createHash("sha256").update(`${userInfo().username}|${home.toLowerCase()}`).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\agb-${id}`;
  }
  return join(home, "agb.sock");
}
