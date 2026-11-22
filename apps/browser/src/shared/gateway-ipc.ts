// Messages between the main process and the Gateway utility process.

export interface AppInfo {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  mainPid: number;
  startedAt: number;
}

export interface ShellCounts {
  windows: number;
  tabs: number;
}

export type MainToGateway =
  | { type: "init"; appInfo: AppInfo; home: string; pipePath: string; http: boolean }
  | { type: "reply"; id: number; result?: unknown; error?: string }
  | { type: "shutdown" };

export type GatewayToMain =
  | { type: "ready"; pipe?: string; http?: string; discoveryPath: string }
  | { type: "fatal"; error: string }
  | { type: "ask"; id: number; what: "shellCounts" }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };
