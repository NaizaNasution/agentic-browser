// Cleanup of gateway.json on quit. Kept free of Electron imports so it can be unit-tested.
import { existsSync, readFileSync, rmSync } from "node:fs";

/**
 * Deletes the discovery file only if it was written by the process with `ownerPid`.
 * Another instance's file (e.g. a second copy sharing AGB_HOME) is left alone.
 * Returns true if the file was deleted.
 */
export function removeDiscoveryIfOwned(file: string, ownerPid: number): boolean {
  try {
    if (!existsSync(file)) return false;
    const d = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
    if (d.pid !== ownerPid) return false;
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}
