// Shell UI: tab strip + toolbar. Page content is drawn by WebContentsViews below this view.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ShellApi, ShellState, TabState } from "../shared/shell";

declare global {
  interface Window {
    agb: ShellApi;
  }
}

const agb = window.agb;

export function App() {
  const [state, setState] = useState<ShellState>({ tabs: [], activeId: null });
  const active = state.tabs.find((t) => t.id === state.activeId);

  useEffect(() => {
    const off = agb.onState(setState);
    agb.ready();
    return off;
  }, []);

  return (
    <div className="shell">
      <TabStrip state={state} />
      <Toolbar tab={active} />
    </div>
  );
}

function TabStrip({ state }: { state: ShellState }) {
  return (
    <div className="tabstrip" role="tablist" aria-label="Tabs">
      {state.tabs.map((t) => (
        <div
          key={t.id}
          role="tab"
          aria-selected={t.id === state.activeId}
          className={`tab${t.id === state.activeId ? " active" : ""}`}
          title={t.title}
          onMouseDown={(e) => {
            if (e.button === 1) agb.closeTab(t.id);
            else if (e.button === 0) agb.activateTab(t.id);
          }}
        >
          <TabIcon tab={t} />
          <span className="tab-title">{t.title}</span>
          <button
            className="tab-close"
            aria-label={`Close ${t.title}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => agb.closeTab(t.id)}
          >
            ×
          </button>
        </div>
      ))}
      <button className="newtab" aria-label="New tab" title="New tab (Ctrl+T)" onClick={() => agb.newTab()}>
        +
      </button>
    </div>
  );
}

function TabIcon({ tab }: { tab: TabState }) {
  const [broken, setBroken] = useState(false);
  if (tab.loading) return <span className="tab-icon spinner" aria-hidden />;
  if (tab.favicon && !broken) return <img className="tab-icon" src={tab.favicon} alt="" onError={() => setBroken(true)} />;
  return <span className="tab-icon placeholder" aria-hidden />;
}

function Toolbar({ tab }: { tab: TabState | undefined }) {
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // Show the tab's URL unless the user is typing.
  useEffect(() => {
    if (!editing) setValue(tab?.url ?? "");
  }, [tab?.url, tab?.id, editing]);

  useEffect(
    () =>
      agb.onFocusAddressBar(() => {
        input.current?.focus();
        input.current?.select();
      }),
    [],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && value.trim()) {
      agb.navigate(value);
      setEditing(false);
      input.current?.blur();
    } else if (e.key === "Escape") {
      setEditing(false);
      setValue(tab?.url ?? "");
      input.current?.select();
    }
  };

  return (
    <div className="toolbar">
      <button aria-label="Back" title="Back (Alt+Left)" disabled={!tab?.canGoBack} onClick={() => agb.back()}>
        ←
      </button>
      <button aria-label="Forward" title="Forward (Alt+Right)" disabled={!tab?.canGoForward} onClick={() => agb.forward()}>
        →
      </button>
      {tab?.loading ? (
        <button aria-label="Stop" title="Stop" onClick={() => agb.stop()}>
          ✕
        </button>
      ) : (
        <button aria-label="Reload" title="Reload (Ctrl+R)" onClick={() => agb.reload()}>
          ↻
        </button>
      )}
      <input
        ref={input}
        className="address"
        aria-label="Address and search bar"
        placeholder="Search or enter address"
        spellCheck={false}
        value={value}
        onChange={(e) => {
          setEditing(true);
          setValue(e.target.value);
        }}
        onFocus={(e) => e.target.select()}
        onBlur={() => setEditing(false)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
