// Messages between the main process and the Gateway utility process.
import type { AgentContext } from "@agb/protocol";

export interface AppInfo {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  mainPid: number;
  startedAt: number;
}

export interface ShellCounts {
  /** Human windows and tabs. Agent Space windows are not counted here. */
  windows: number;
  tabs: number;
  agentSpaces?: number;
  agentTabs?: number;
}

/** An error the main process returns for an agent command. `name` is a protocol error name such as E_NO_TAB. */
export interface MainError {
  name: string;
  message: string;
  hint?: string;
}

export type MainToGateway =
  | { type: "init"; appInfo: AppInfo; home: string; pipePath: string; http: boolean }
  | { type: "reply"; id: number; result?: unknown; error?: MainError }
  | { type: "shutdown" };

export type GatewayToMain =
  | { type: "ready"; pipe?: string; http?: string; discoveryPath: string }
  | { type: "fatal"; error: string }
  | { type: "ask"; id: number; what: "shellCounts" }
  /** An agent command (space.*, tab.*, nav.*, page.*), already authorized and validated by the Gateway. */
  | { type: "call"; id: number; method: string; params: unknown; ctx: AgentContext; timeoutMs: number }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };
