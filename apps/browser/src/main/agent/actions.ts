// Acting on elements (docs/SPEC.md §10.4, §11.1–11.5): resolve the ref, check the element is actionable, send
// trusted input through CDP (Input.dispatch*), wait for the page to settle, and report what changed.
// Input is sent at the "fast" pace: one pointer move straight to the target. The human-like motion and typing
// models are M4 (§11.6–11.10).
//
// Element checks run as functions on the element in an isolated JavaScript world, so the page's own scripts can't
// change their answers.
import type { DialogInfo } from "@agb/protocol";
import { AgentError } from "./errors";
import { charKey, modifierBits, parseCombo, type KeyDef, type Modifier } from "./keys";
import { listRefTargets } from "./snapshot/build";
import { normalizeRef, sameFingerprint, type RefTable } from "./snapshot/refs";
import type { PageData } from "./snapshot/types";

export interface FrameRef {
  session: string;
  parentFrameId?: string;
  ownerBackendId?: number;
}

/** What the action engine needs from a tab. */
export interface ActorHost {
  cdp(method: string, params?: Record<string, unknown>, session?: string): Promise<any>;
  until<T>(deadline: number, what: string, p: Promise<T>): Promise<T>;
  readonly refs: RefTable;
  frame(frameId: string): FrameRef | undefined;
  /** Collects the page and refreshes frame info. */
  collect(deadline: number): Promise<PageData>;
  /** Isolated-world execution context for a frame. */
  isolated(frameId: string, session: string, deadline: number): Promise<number>;
  onDialog(cb: (d: DialogInfo) => void): () => void;
  onFileChooser(cb: (e: { backendNodeId: number; session: string }) => void): () => void;
  readonly platform: NodeJS.Platform;
}

export interface Target {
  ref: string;
  frameId: string;
  session: string;
  backendId: number;
  role: string;
  name: string;
  note?: string;
}

export interface Point {
  x: number;
  y: number;
}

const ACTIONABLE_WAIT_MS = 5000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Function bodies run on the element (`this`) in the isolated world. */
const FN = {
  isConnected: "function () { return this.isConnected; }",
  enabled: `function () {
    if (this.disabled === true) return false;
    if (this.getAttribute && this.getAttribute("aria-disabled") === "true") return false;
    const fs = this.closest && this.closest("fieldset[disabled]");
    if (fs) { const legend = fs.querySelector("legend"); if (!legend || !legend.contains(this)) return false; }
    return true;
  }`,
  contains: `function (other) {
    for (let n = other; n; n = n.parentNode || n.host) if (n === this) return true;
    return false;
  }`,
  field: `function () {
    const tag = this.tagName;
    const type = (this.getAttribute("type") || "").toLowerCase();
    const autocomplete = this.getAttribute("autocomplete") || "";
    const secret = type === "password" || /(^|\\s)(cc-|one-time-code|current-password|new-password)/i.test(autocomplete);
    if (tag === "SELECT") return { kind: "select", secret };
    if (tag === "INPUT" && type === "file") return { kind: "file", secret };
    if (tag === "INPUT" && ["checkbox", "radio", "button", "submit", "reset", "image", "range", "color"].includes(type)) return { kind: "other", secret };
    if (tag === "INPUT" || tag === "TEXTAREA") return { kind: this.readOnly ? "readonly" : "text", secret, value: this.value };
    if (this.isContentEditable) return { kind: "editable", secret, value: this.innerText };
    return { kind: "other", secret };
  }`,
  value: `function () { return this.isContentEditable ? this.innerText : this.value; }`,
  setValue: `function (v) {
    const proto = this.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : this.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    if (this.isContentEditable) this.innerText = v;
    else Object.getOwnPropertyDescriptor(proto, "value").set.call(this, v);
    this.dispatchEvent(new Event("input", { bubbles: true }));
    this.dispatchEvent(new Event("change", { bubbles: true }));
  }`,
  checked: `function () {
    if (this.tagName === "INPUT" && (this.type === "checkbox" || this.type === "radio")) return { checked: this.checked, radio: this.type === "radio" };
    const role = this.getAttribute("role");
    const aria = this.getAttribute("aria-checked") ?? this.getAttribute("aria-pressed");
    return { checked: aria === "true", radio: role === "radio" || role === "menuitemradio", known: aria !== null };
  }`,
  selectInfo: `function () {
    if (this.tagName !== "SELECT") return null;
    return { multiple: this.multiple, index: this.selectedIndex,
      options: Array.from(this.options).map((o) => ({ label: o.label.trim(), value: o.value, disabled: o.disabled, selected: o.selected })) };
  }`,
  selectDirect: `function (indexes) {
    Array.from(this.options).forEach((o, i) => { o.selected = indexes.includes(i); });
    this.dispatchEvent(new Event("input", { bubbles: true }));
    this.dispatchEvent(new Event("change", { bubbles: true }));
  }`,
  selectedLabels: `function () { return this.tagName === "SELECT" ? Array.from(this.selectedOptions).map((o) => o.label.trim()) : []; }`,
  fileCount: `function () { return this.files ? this.files.length : -1; }`,
  isFileInput: `function () { return this.tagName === "INPUT" && (this.type || "").toLowerCase() === "file"; }`,
};

export class Actor {
  constructor(private readonly host: ActorHost) {}

  // ---------- refs ----------

  /** Resolves a ref to a live element, re-finding it by fingerprint if it was replaced (§10.4). */
  async resolve(input: string, deadline: number): Promise<Target> {
    const ref = normalizeRef(input);
    const entry = this.host.refs.get(ref);
    if (!entry) {
      if (this.host.refs.fromEarlierDocument(ref)) {
        throw new AgentError("E_STALE_REF", `${ref} was on an earlier page; the tab has navigated since`, "run `agb snapshot` and use a ref from the current page");
      }
      if (this.host.refs.issued === 0) throw new AgentError("E_NO_REF", `there are no refs on this page yet (${ref})`, "run `agb snapshot` first, then use a ref from it");
      throw new AgentError("E_NO_REF", `no ${ref} on this page`, "run `agb snapshot` and use a ref from it");
    }
    const fp = entry.fingerprint;
    const frame = this.host.frame(entry.frameId);
    if (frame && (await this.alive(entry.frameId, frame.session, entry.backendId, deadline))) {
      return { ref, frameId: entry.frameId, session: frame.session, backendId: entry.backendId, role: fp.role, name: fp.name };
    }
    // Gone: look for exactly one element with the same fingerprint.
    const page = await this.host.collect(deadline);
    const candidates = listRefTargets(page, this.host.refs).filter((n) => {
      if (n.backendId === undefined || !n.fp) return false;
      if (n.frameId === entry.frameId && n.backendId === entry.backendId) return false;
      return n.fp.role === fp.role && n.fp.name === fp.name && n.fp.tag === fp.tag && n.fp.landmark === fp.landmark;
    });
    let match = candidates.length === 1 ? candidates[0] : undefined;
    if (!match && candidates.length > 1) {
      const same = candidates.filter((c) => {
        const e = c.ref ? this.host.refs.get(c.ref) : undefined;
        return e ? sameFingerprint(e.fingerprint, fp) : false;
      });
      if (same.length === 1) match = same[0];
    }
    const desc = `${fp.role}${fp.name ? ` "${fp.name}"` : ""}`;
    if (!match || match.backendId === undefined) {
      throw new AgentError("E_STALE_REF", `${ref} (${desc}) is no longer on the page`, "run `agb snapshot` again and use the new ref");
    }
    this.host.refs.rebind(ref, match.frameId, match.backendId);
    const session = this.host.frame(match.frameId)?.session ?? "";
    return { ref, frameId: match.frameId, session, backendId: match.backendId, role: fp.role, name: fp.name, note: `${ref} re-resolved` };
  }

  private async alive(frameId: string, session: string, backendId: number, deadline: number): Promise<boolean> {
    try {
      return (await this.call(frameId, session, backendId, FN.isConnected, [], deadline)) === true;
    } catch {
      return false;
    }
  }

  /** Calls `fn` on the element in the isolated world and returns its JSON result. */
  async call(frameId: string, session: string, backendId: number, fn: string, args: unknown[], deadline: number, objectArgs: string[] = []): Promise<unknown> {
    const contextId = await this.host.isolated(frameId, session, deadline);
    const { object } = await this.host.until(deadline, "element", this.host.cdp("DOM.resolveNode", { backendNodeId: backendId, executionContextId: contextId }, session));
    try {
      const r = await this.host.until(
        deadline,
        "element",
        this.host.cdp(
          "Runtime.callFunctionOn",
          {
            objectId: object.objectId,
            functionDeclaration: fn,
            arguments: [...objectArgs.map((objectId) => ({ objectId })), ...args.map((value) => ({ value }))],
            returnByValue: true,
            awaitPromise: true,
          },
          session,
        ),
      );
      if (r.exceptionDetails) throw new AgentError("E_INTERNAL", `element script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    } finally {
      void this.host.cdp("Runtime.releaseObject", { objectId: object.objectId }, session).catch(() => {});
    }
  }

  /** Calls `fn` on a resolved target element (isolated world). */
  async callOn(t: Target, fn: string, args: unknown[], deadline: number): Promise<any> {
    return this.call(t.frameId, t.session, t.backendId, fn, args, deadline);
  }

  // ---------- geometry ----------

  /** Offset of a session's root document within the main frame viewport (CSS px). */
  private async sessionOffset(frameId: string, deadline: number, depth = 0): Promise<Point> {
    const f = this.host.frame(frameId);
    if (!f || !f.parentFrameId || depth > 10) return { x: 0, y: 0 };
    const parent = this.host.frame(f.parentFrameId);
    if (!parent) return { x: 0, y: 0 };
    // Frames in the same process report quads relative to that session's root viewport already.
    if (parent.session === f.session) return this.sessionOffset(f.parentFrameId, deadline, depth + 1);
    if (f.ownerBackendId === undefined) return { x: 0, y: 0 };
    const { model } = await this.host.until(deadline, "frame", this.host.cdp("DOM.getBoxModel", { backendNodeId: f.ownerBackendId }, parent.session));
    const above = await this.sessionOffset(f.parentFrameId, deadline, depth + 1);
    return { x: above.x + model.content[0], y: above.y + model.content[1] };
  }

  /** Center of the element's largest visible box, in main-viewport coordinates; undefined if it has no box. */
  async center(t: Target, deadline: number): Promise<Point | undefined> {
    let quads: number[][];
    try {
      ({ quads } = await this.host.until(deadline, "element", this.host.cdp("DOM.getContentQuads", { backendNodeId: t.backendId }, t.session)));
    } catch {
      return undefined;
    }
    let best: number[] | undefined;
    let bestArea = 0;
    for (const q of quads) {
      const area = Math.abs((q[2]! - q[0]!) * (q[5]! - q[1]!));
      if (area > bestArea) {
        bestArea = area;
        best = q;
      }
    }
    if (!best || bestArea < 1) return undefined;
    const off = await this.sessionOffset(t.frameId, deadline);
    return { x: off.x + (best[0]! + best[2]! + best[4]! + best[6]!) / 4, y: off.y + (best[1]! + best[3]! + best[5]! + best[7]!) / 4 };
  }

  private async scrollIntoView(t: Target, deadline: number): Promise<void> {
    // Bring the frame's <iframe> into view first, then the element inside it.
    const chain: { session: string; backendId: number }[] = [];
    let f = this.host.frame(t.frameId);
    while (f?.parentFrameId && f.ownerBackendId !== undefined) {
      const parent = this.host.frame(f.parentFrameId);
      if (!parent) break;
      chain.unshift({ session: parent.session, backendId: f.ownerBackendId });
      f = parent;
    }
    for (const c of [...chain, { session: t.session, backendId: t.backendId }]) {
      await this.host.until(deadline, "scroll", this.host.cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId: c.backendId }, c.session)).catch(() => {});
    }
  }

  /** Who receives a click at `p`: the target (or something inside it), or the covering element. */
  private async hitTest(t: Target, p: Point, deadline: number): Promise<{ ok: true } | { ok: false; cover: string }> {
    const off = await this.sessionOffset(t.frameId, deadline);
    const local = { x: Math.round(p.x - off.x), y: Math.round(p.y - off.y) };
    let hit: { backendNodeId: number; frameId?: string };
    try {
      hit = await this.host.until(
        deadline,
        "hit test",
        this.host.cdp("DOM.getNodeForLocation", { ...local, includeUserAgentShadowDOM: false, ignorePointerEventsNone: true }, t.session),
      );
    } catch {
      return { ok: true }; // nothing to compare against (e.g. the point is in a scrollbar); let the click decide
    }
    if (hit.backendNodeId === t.backendId) return { ok: true };
    const hitFrame = hit.frameId ?? t.frameId;
    if (hitFrame === t.frameId) {
      const contextId = await this.host.isolated(t.frameId, t.session, deadline);
      const { object } = await this.host.cdp("DOM.resolveNode", { backendNodeId: hit.backendNodeId, executionContextId: contextId }, t.session);
      try {
        if ((await this.call(t.frameId, t.session, t.backendId, FN.contains, [], deadline, [object.objectId])) === true) return { ok: true };
      } finally {
        void this.host.cdp("Runtime.releaseObject", { objectId: object.objectId }, t.session).catch(() => {});
      }
    }
    return { ok: false, cover: await this.describe(hitFrame, t.session, hit.backendNodeId, deadline) };
  }

  /**
   * Names the element that covers a target, so the agent can dismiss it: `dialog "Cookies" @e40`.
   * 1. The element itself or its nearest meaningful ancestor (one with a ref, or a real role).
   * 2. A backdrop with no role of its own: the dialog inside it.
   * 3. Otherwise the tag, id, and class: `div#banner`.
   */
  private async describe(frameId: string, session: string, backendId: number, deadline: number): Promise<string> {
    const label = (n: any, ref?: string) => `${n.role?.value ?? "element"}${n.name?.value ? ` "${String(n.name.value).slice(0, 60)}"` : ""}${ref ? ` ${ref}` : ""}`;
    const UNNAMED = ["generic", "none", "StaticText", "InlineTextBox", "RootWebArea", "WebArea"];
    try {
      const { nodes } = await this.host.until(deadline, "describe", this.host.cdp("Accessibility.getPartialAXTree", { backendNodeId: backendId, fetchRelatives: true }, session));
      const byId = new Map<string, any>(nodes.map((n: any) => [n.nodeId, n]));
      let n = nodes.find((x: any) => x.backendDOMNodeId === backendId);
      for (let i = 0; n && i < 30; i++) {
        const ref = n.backendDOMNodeId !== undefined ? this.host.refs.refFor(frameId, n.backendDOMNodeId) : undefined;
        if (ref || (n.role?.value && !UNNAMED.includes(n.role.value) && !n.ignored)) return label(n, ref);
        n = n.parentId ? byId.get(n.parentId) : undefined;
      }
    } catch {
      /* fall through */
    }
    try {
      const contextId = await this.host.isolated(frameId, session, deadline);
      const { object } = await this.host.cdp("DOM.resolveNode", { backendNodeId: backendId, executionContextId: contextId }, session);
      const found = await this.host.cdp(
        "Runtime.callFunctionOn",
        { objectId: object.objectId, functionDeclaration: "function () { return this.querySelector && this.querySelector('[role=dialog], [role=alertdialog], dialog, [aria-modal=true]'); }" },
        session,
      );
      if (found.result?.objectId) {
        const { node } = await this.host.cdp("DOM.describeNode", { objectId: found.result.objectId }, session);
        const { nodes } = await this.host.cdp("Accessibility.getPartialAXTree", { backendNodeId: node.backendNodeId, fetchRelatives: false }, session);
        const d = nodes.find((x: any) => x.backendDOMNodeId === node.backendNodeId);
        if (d) return `${label(d, this.host.refs.refFor(frameId, node.backendNodeId))} (on a full-page overlay)`;
      }
    } catch {
      /* fall through */
    }
    const { node } = await this.host.cdp("DOM.describeNode", { backendNodeId: backendId }, session).catch(() => ({ node: { nodeName: "element", attributes: [] } }));
    const attrs: string[] = node.attributes ?? [];
    const attr = (k: string) => {
      const i = attrs.indexOf(k);
      return i >= 0 && i % 2 === 0 ? attrs[i + 1] : undefined;
    };
    const id = attr("id");
    const cls = attr("class")?.trim().split(/\s+/)[0];
    return `${String(node.localName || node.nodeName || "element").toLowerCase()}${id ? `#${id}` : ""}${cls ? `.${cls}` : ""}`;
  }

  /** Scrolls the element into view and waits until it is visible, still, enabled, and not covered (§11.2). */
  async actionable(t: Target, deadline: number, opts: { enabled?: boolean; hitTest?: boolean } = {}): Promise<Point> {
    const until = Math.min(deadline, Date.now() + ACTIONABLE_WAIT_MS);
    const desc = `${t.role}${t.name ? ` "${t.name}"` : ""} ${t.ref}`;
    let reason = "is not visible";
    let scrolled = false;
    while (Date.now() < until) {
      if (!scrolled) {
        await this.scrollIntoView(t, deadline);
        scrolled = true;
      }
      const a = await this.center(t, deadline);
      if (!a) {
        reason = "is not visible (it has no size or is hidden)";
        scrolled = false;
        await sleep(100);
        continue;
      }
      await sleep(34); // two animation frames
      const b = await this.center(t, deadline);
      if (!b || Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1) {
        reason = "is still moving";
        continue;
      }
      if (opts.enabled !== false && (await this.callOn(t, FN.enabled, [], deadline)) === false) {
        reason = "is disabled";
        await sleep(100);
        continue;
      }
      if (opts.hitTest !== false) {
        const hit = await this.hitTest(t, b, deadline);
        if (!hit.ok) {
          reason = `is covered by ${hit.cover}`;
          scrolled = false;
          await sleep(100);
          continue;
        }
      }
      return b;
    }
    const hint = reason.startsWith("is covered")
      ? "close or dismiss the covering element (for example click its close button), or scroll, then try again"
      : reason === "is disabled"
        ? "the page must enable it first (fill in required fields?); check with `agb snapshot`"
        : "check the element with `agb snapshot`; it may be hidden or off the page";
    throw new AgentError("E_NOT_ACTIONABLE", `${desc} ${reason}`, hint);
  }

  // ---------- input ----------

  async mouse(type: "mouseMoved" | "mousePressed" | "mouseReleased", p: Point, extra: Record<string, unknown> = {}): Promise<void> {
    await this.host.cdp("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, ...extra });
  }

  async click(p: Point, opts: { button?: "left" | "right" | "middle"; count?: number; modifiers?: Modifier[] } = {}): Promise<void> {
    const button = opts.button ?? "left";
    const modifiers = modifierBits(opts.modifiers ?? []);
    const buttons = button === "left" ? 1 : button === "right" ? 2 : 4;
    await this.mouse("mouseMoved", p, { modifiers });
    for (let i = 1; i <= (opts.count ?? 1); i++) {
      await this.mouse("mousePressed", p, { button, buttons, clickCount: i, modifiers });
      await this.mouse("mouseReleased", p, { button, buttons: 0, clickCount: i, modifiers });
    }
  }

  async key(def: KeyDef, modifiers: Modifier[] = [], commands?: string[]): Promise<void> {
    const mods = [...modifiers];
    if (def.shift && !mods.includes("Shift")) mods.push("Shift");
    const bits = modifierBits(mods);
    // Text is only sent when no command modifier is held (Shift alone still types).
    const types = bits & ~MODIFIER_SHIFT ? undefined : def.text;
    await this.host.cdp("Input.dispatchKeyEvent", {
      type: types ? "keyDown" : "rawKeyDown",
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      modifiers: bits,
      ...(types ? { text: types, unmodifiedText: types } : {}),
      ...(commands ? { commands } : {}),
    });
    await this.host.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers: bits });
  }

  async press(combo: string): Promise<void> {
    let parsed;
    try {
      parsed = parseCombo(combo);
    } catch (e) {
      throw new AgentError("E_INVALID_PARAMS", (e as Error).message, "use names like Enter, Escape, Tab, ArrowDown, Control+A, Shift+Tab");
    }
    const held: Modifier[] = [];
    for (const m of parsed.modifiers) {
      held.push(m);
      await this.host.cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: m, code: `${m}Left`, windowsVirtualKeyCode: MOD_CODES[m], modifiers: modifierBits(held) });
    }
    const selectAll = parsed.modifiers.length === 1 && (parsed.modifiers[0] === "Control" || parsed.modifiers[0] === "Meta") && parsed.key.code === "KeyA";
    await this.key(parsed.key, parsed.modifiers, selectAll ? ["selectAll"] : undefined);
    for (const m of [...parsed.modifiers].reverse()) {
      held.splice(held.indexOf(m), 1);
      await this.host.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: m, code: `${m}Left`, windowsVirtualKeyCode: MOD_CODES[m], modifiers: modifierBits(held) });
    }
  }

  /** Types text key by key; characters without a US-keyboard key are inserted as text. */
  async type(text: string): Promise<void> {
    for (const ch of text) {
      const def = charKey(ch);
      if (def) await this.key(def);
      else await this.host.cdp("Input.insertText", { text: ch });
    }
  }

  /** Select-all and delete in the focused field. */
  async clearFocused(): Promise<void> {
    const mod: Modifier = this.host.platform === "darwin" ? "Meta" : "Control";
    await this.key({ key: "a", code: "KeyA", keyCode: 65 }, [mod], ["selectAll"]);
    await this.key({ key: "Backspace", code: "Backspace", keyCode: 8 });
  }

  async wheel(p: Point, dx: number, dy: number): Promise<void> {
    await this.host.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, deltaX: dx, deltaY: dy });
  }

  /** Runs `fn`, but returns early if a JavaScript dialog opens (input blocks until a dialog is handled). */
  async raceDialog(fn: () => Promise<void>): Promise<DialogInfo | undefined> {
    let off = () => {};
    const opened = new Promise<DialogInfo>((resolve) => {
      off = this.host.onDialog(resolve);
    });
    try {
      const r = await Promise.race([fn().then(() => undefined), opened]);
      return r;
    } finally {
      off();
    }
  }
}

const MODIFIER_SHIFT = 8;
const MOD_CODES: Record<Modifier, number> = { Alt: 18, Control: 17, Meta: 91, Shift: 16 };

export { FN as ELEMENT_FUNCTIONS };
