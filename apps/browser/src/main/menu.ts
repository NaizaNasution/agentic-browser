// Application menu. The menu bar is hidden on Windows/Linux, but its accelerators stay active.
import { Menu, type MenuItemConstructorOptions } from "electron";
import type { TabManager } from "./tabs";

export function installMenu(tabs: () => TabManager | null, focusAddressBar: () => void): void {
  const t = () => tabs();
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "New Tab", accelerator: "CmdOrCtrl+T", click: () => { t()?.create(); focusAddressBar(); } },
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => { const s = t()?.state(); if (s?.activeId) t()?.close(s.activeId); } },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Focus Address Bar", accelerator: "CmdOrCtrl+L", click: focusAddressBar },
        { label: "Focus Address Bar", accelerator: "F6", visible: false, click: focusAddressBar },
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => t()?.reload() },
        { label: "Reload", accelerator: "F5", visible: false, click: () => t()?.reload() },
        { label: "Hard Reload", accelerator: "CmdOrCtrl+Shift+R", click: () => t()?.reload(true) },
        { type: "separator" },
        { label: "Next Tab", accelerator: "Ctrl+Tab", click: () => t()?.cycle(1) },
        { label: "Previous Tab", accelerator: "Ctrl+Shift+Tab", click: () => t()?.cycle(-1) },
        { type: "separator" },
        { label: "Developer Tools", accelerator: "F12", click: () => t()?.toggleDevTools() },
      ],
    },
    {
      label: "History",
      submenu: [
        { label: "Back", accelerator: process.platform === "darwin" ? "Cmd+[" : "Alt+Left", click: () => t()?.back() },
        { label: "Forward", accelerator: process.platform === "darwin" ? "Cmd+]" : "Alt+Right", click: () => t()?.forward() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
