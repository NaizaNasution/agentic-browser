// Errors that agent commands return to the Gateway. Free of Electron imports.
import type { ErrorName } from "@agb/protocol";
import type { MainError } from "../../shared/gateway-ipc";

export class AgentError extends Error {
  constructor(
    readonly code: ErrorName,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/** Converts anything thrown by an agent command into the message sent back to the Gateway. */
export function toMainError(e: unknown): MainError {
  if (e instanceof AgentError) return { name: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) };
  return { name: "E_INTERNAL", message: e instanceof Error ? e.message : String(e) };
}

export const tabClosed = () => new AgentError("E_NO_TAB", "the tab was closed while the command was running", "run `agb tab list`");

export const timedOut = (what: string) =>
  new AgentError("E_TIMEOUT", `${what} did not finish in time`, "check the page with `agb capture`, or raise --timeout");
