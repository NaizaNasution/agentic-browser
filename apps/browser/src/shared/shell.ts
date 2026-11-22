// Types shared by the main process, preload, and the shell renderer.

export interface TabState {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  favicon?: string;
}

export interface ShellState {
  tabs: TabState[];
  activeId: string | null;
}

/** Channels between the shell renderer and the main process. */
export const IPC = {
  state: "shell:state",
  focusAddressBar: "shell:focus-address-bar",
  newTab: "shell:new-tab",
  closeTab: "shell:close-tab",
  activateTab: "shell:activate-tab",
  navigate: "shell:navigate",
  back: "shell:back",
  forward: "shell:forward",
  reload: "shell:reload",
  stop: "shell:stop",
  ready: "shell:ready",
} as const;

/** API the preload script exposes to the shell renderer as `window.agb`. */
export interface ShellApi {
  onState(cb: (state: ShellState) => void): () => void;
  onFocusAddressBar(cb: () => void): () => void;
  ready(): void;
  newTab(url?: string): void;
  closeTab(id: string): void;
  activateTab(id: string): void;
  navigate(input: string): void;
  back(): void;
  forward(): void;
  reload(): void;
  stop(): void;
}

/** Height of the tab strip plus toolbar, in CSS pixels. Tab views are placed below it. */
export const TOOLBAR_HEIGHT = 80;
