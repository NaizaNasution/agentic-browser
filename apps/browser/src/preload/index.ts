// Preload for the shell UI only (never for web pages). Exposes a narrow API as `window.agb`.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type ShellApi, type ShellState } from "../shared/shell";

const api: ShellApi = {
  onState(cb) {
    const listener = (_e: IpcRendererEvent, state: ShellState) => cb(state);
    ipcRenderer.on(IPC.state, listener);
    return () => ipcRenderer.removeListener(IPC.state, listener);
  },
  onFocusAddressBar(cb) {
    const listener = () => cb();
    ipcRenderer.on(IPC.focusAddressBar, listener);
    return () => ipcRenderer.removeListener(IPC.focusAddressBar, listener);
  },
  ready: () => ipcRenderer.send(IPC.ready),
  newTab: (url) => ipcRenderer.send(IPC.newTab, url),
  closeTab: (id) => ipcRenderer.send(IPC.closeTab, id),
  activateTab: (id) => ipcRenderer.send(IPC.activateTab, id),
  navigate: (input) => ipcRenderer.send(IPC.navigate, input),
  back: () => ipcRenderer.send(IPC.back),
  forward: () => ipcRenderer.send(IPC.forward),
  reload: () => ipcRenderer.send(IPC.reload),
  stop: () => ipcRenderer.send(IPC.stop),
};

contextBridge.exposeInMainWorld("agb", api);
