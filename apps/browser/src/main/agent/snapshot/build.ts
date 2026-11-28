// Builds the text snapshot of a page (docs/SPEC.md §10.1–10.3, §10.5). Pure: PageData in, text and refs out.
//
//   banner @e1
//     link "GitHub" @e2
//   main @e3
//     heading "Sign in to GitHub" level=1
//     textbox "Username or email address" @e4 value=""
//     textbox "Password" @e5 type=password value=<redacted>
//     button "Sign in" @e6
import { RefTable, type Fingerprint } from "./refs";
import type { AXNode, FrameData, NodeInfo, PageData, Rect } from "./types";

export type SnapshotMode = "interactive" | "full";

export interface BuildOptions {
  mode: SnapshotMode;
  /** Only this ref's subtree. */
  scope?: string;
  /** Token budget (≈ 4 characters per token). */
  maxTokens: number;
}

/** One line of a snapshot, for diffs: `key` identifies the element across snapshots. */
export interface DiffLine {
  key: string;
  ref?: string;
  text: string;
}

export interface BuildResult {
  text: string;
  refs: number;
  tokens: number;
  hiddenOmitted: number;
  /** Sections replaced by a "collapsed" line to fit the budget. */
  collapsed: number;
  /** Every line of the whole page (no budget, no scope), for --diff and action diffs. */
  baseline: DiffLine[];
  scopeFound: boolean;
}

/** A node of the simplified tree. */
export interface SNode {
  role: string;
  name: string;
  value?: string;
  attrs: string[];
  ref?: string;
  frameId: string;
  backendId?: number;
  rect?: Rect;
  children: SNode[];
  /** Fingerprint fields, for refs assigned later (collapsed sections). */
  fp?: Omit<Fingerprint, "index">;
}

// ---------- role tables ----------

/** Elements an agent can act on. */
const INTERACTIVE = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "listbox", "option", "checkbox", "radio", "switch", "slider",
  "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem", "ToggleButton", "PopUpButton",
  "DisclosureTriangle", "Date", "DateTime", "InputTime", "ColorWell", "textField", "menubutton",
]);
/** Interactive elements whose text content is already their name: their static text isn't repeated. */
const LEAF = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "option", "checkbox", "radio", "switch", "slider", "spinbutton",
  "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem", "ToggleButton", "PopUpButton", "DisclosureTriangle",
  "Date", "DateTime", "InputTime", "ColorWell", "textField", "menubutton",
]);
const LANDMARKS = new Set(["banner", "navigation", "main", "complementary", "contentinfo", "search", "form", "region"]);
/** Landmarks that only count when they have a name (as in ARIA). */
const NAMED_LANDMARKS = new Set(["form", "region"]);
const OVERLAYS = new Set(["dialog", "alertdialog", "alert", "status"]);
const ROLE_NAMES: Record<string, string> = {
  ToggleButton: "button",
  PopUpButton: "combobox",
  DisclosureTriangle: "button",
  textField: "textbox",
  Date: "date",
  DateTime: "datetime",
  InputTime: "time",
  ColorWell: "color",
  Iframe: "iframe",
  IframePresentational: "iframe",
};
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider", "date", "datetime", "time", "color"]);
const SECRET_AUTOCOMPLETE = /(^|\s)(cc-|one-time-code|current-password|new-password)/i;

const prop = (n: AXNode, name: string): unknown => n.properties?.find((p) => p.name === name)?.value.value;
const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ---------- tree building ----------

interface Ctx {
  /** Inside an interactive leaf: static text is already in its name. */
  inLeaf: boolean;
  /** Inside a <label> or <legend>: their text is the name of a control or group. */
  inLabel: boolean;
  landmark: string;
}

class Builder {
  hiddenOmitted = 0;
  private counts = new Map<string, number>();
  private byFrame: Map<string, Map<string, AXNode>>;

  constructor(
    private readonly page: PageData,
    private readonly refs: RefTable,
    private readonly mode: SnapshotMode,
  ) {
    this.byFrame = new Map(page.frames.map((f) => [f.frameId, new Map(f.ax.map((n) => [n.nodeId, n]))]));
  }

  build(): SNode {
    const main = this.page.frames[0];
    if (!main) return { role: "page", name: "", attrs: [], frameId: "", children: [] };
    return { role: "page", name: "", attrs: [], frameId: main.frameId, children: this.visitFrame(main, { inLeaf: false, inLabel: false, landmark: "" }) };
  }

  /** Assigns a ref to a node that didn't get one while building (collapsed sections). */
  ensureRef(node: SNode): string | undefined {
    if (node.ref) return node.ref;
    if (node.backendId === undefined || !node.fp) return undefined;
    node.ref = this.refs.assign(node.frameId, node.backendId, { ...node.fp, index: this.nextIndex(node.fp) });
    return node.ref;
  }

  private visitFrame(frame: FrameData, ctx: Ctx): SNode[] {
    const nodes = this.byFrame.get(frame.frameId)!;
    const root = frame.ax.find((n) => !n.parentId) ?? frame.ax[0];
    return root ? this.visit(root, frame, nodes, ctx) : [];
  }

  private children(n: AXNode, frame: FrameData, nodes: Map<string, AXNode>, ctx: Ctx): SNode[] {
    const out: SNode[] = [];
    for (const id of n.childIds ?? []) {
      const child = nodes.get(id);
      if (child) out.push(...this.visit(child, frame, nodes, ctx));
    }
    return mergeText(out);
  }

  private nextIndex(fp: Omit<Fingerprint, "index">): number {
    const k = `${fp.role}|${fp.name}|${fp.tag}|${fp.landmark}`;
    const i = this.counts.get(k) ?? 0;
    this.counts.set(k, i + 1);
    return i;
  }

  private visit(n: AXNode, frame: FrameData, nodes: Map<string, AXNode>, ctx: Ctx): SNode[] {
    const axRole = str(n.role?.value);
    if (axRole === "InlineTextBox" || axRole === "ListMarker") return [];
    const backendId = n.backendDOMNodeId;
    const info: NodeInfo | undefined = backendId !== undefined ? frame.nodes.get(backendId) : undefined;

    if (info && !info.visible) {
      if (hasText(n, nodes)) this.hiddenOmitted++;
      return [];
    }
    if (n.ignored) return this.children(n, frame, nodes, ctx);

    const name = clean(str(n.name?.value));
    if (axRole === "StaticText") {
      if (ctx.inLeaf || ctx.inLabel || !name) return [];
      if (info?.unreadable) {
        this.hiddenOmitted++;
        return [];
      }
      return [{ role: "text", name, attrs: [], frameId: frame.frameId, ...(info?.rect ? { rect: offsetRect(info.rect, frame) } : {}), children: [] }];
    }
    if (axRole === "LineBreak") return [];

    const base = (role: string, extra: Partial<SNode> = {}): SNode => ({
      role,
      name,
      attrs: [],
      frameId: frame.frameId,
      ...(backendId !== undefined ? { backendId } : {}),
      ...(info?.rect ? { rect: offsetRect(info.rect, frame) } : {}),
      children: [],
      ...extra,
    });
    const withRef = (node: SNode): SNode => {
      if (backendId === undefined) return node;
      const fp = { role: node.role, name: node.name, tag: info?.tag ?? "", landmark: ctx.landmark };
      node.fp = fp;
      node.ref = this.refs.assign(frame.frameId, backendId, { ...fp, index: this.nextIndex(fp) });
      return node;
    };

    // Frames: the child document goes under its <iframe>.
    if (axRole === "Iframe" || axRole === "IframePresentational") {
      const child = this.page.frames.find((f) => f.parentFrameId === frame.frameId && f.ownerBackendId === backendId);
      const node = withRef(base("iframe"));
      if (child) {
        node.attrs.push(`(${shortUrl(child.url, 80)})`);
        node.children = this.visitFrame(child, { ...ctx, inLeaf: false, inLabel: false });
      }
      return [node];
    }

    let role = ROLE_NAMES[axRole] ?? axRole;
    const editable = str(prop(n, "editable"));
    if ((role === "generic" || role === "none" || role === "paragraph") && editable === "richtext" && !ctx.inLeaf) role = "textbox";
    const clickable = !INTERACTIVE.has(axRole) && info?.clickable && info.pointer && info.tag !== "LABEL" && !ctx.inLeaf;
    // Keyboard-focusable elements without a role (tabindex="0" menu triggers, custom widgets) can be acted on too.
    const focusable = !INTERACTIVE.has(axRole) && !clickable && (role === "generic" || role === "none") && prop(n, "focusable") === true && editable === "" && !ctx.inLeaf;

    if (INTERACTIVE.has(axRole) || role === "textbox" || clickable || focusable) {
      if (ctx.inLeaf && !INTERACTIVE.has(axRole)) return this.children(n, frame, nodes, ctx);
      const node = base(clickable ? "clickable" : focusable ? "focusable" : role);
      if ((clickable || focusable) && !node.name) node.name = clean(textOf(n, nodes));
      this.addState(node, n, info, axRole);
      withRef(node);
      if (axRole === "combobox" || axRole === "PopUpButton") {
        const options = optionNames(n, nodes);
        if (options.length && !node.attrs.some((a) => a.startsWith("options="))) {
          node.attrs.push(`options=${quote(truncate(options.join(" | "), 120))}`);
        }
        // A native <select> lists its options in the attribute; an ARIA combobox may own a real listbox.
        if (info?.tag === "SELECT") return [node];
      }
      const leaf = LEAF.has(axRole) || LEAF.has(node.role) || clickable || focusable;
      const kids = this.children(n, frame, nodes, { ...ctx, inLeaf: ctx.inLeaf || !!leaf });
      node.children = leaf ? kids.filter((k) => k.role !== "text") : kids;
      return [node];
    }

    if (LANDMARKS.has(role) || OVERLAYS.has(role)) {
      if (NAMED_LANDMARKS.has(role) && !name) return this.children(n, frame, nodes, ctx);
      const node = withRef(base(role));
      node.children = this.children(n, frame, nodes, { ...ctx, landmark: `${role}:${name}` });
      // An alert or status message without a name is named by its text (`alert "Wrong password" @e9`).
      if ((role === "alert" || role === "status") && !node.name) {
        node.name = clean(node.children.filter((k) => k.role === "text").map((k) => k.name).join(" "));
        node.children = node.children.filter((k) => k.role !== "text");
      }
      return [node];
    }

    switch (role) {
      case "RootWebArea":
      case "WebArea":
        return this.children(n, frame, nodes, ctx);
      case "heading": {
        const node = base("heading");
        const level = prop(n, "level");
        if (level !== undefined) node.attrs.push(`level=${str(level)}`);
        node.children = this.children(n, frame, nodes, { ...ctx, inLeaf: true }).filter((k) => k.role !== "text");
        return [node];
      }
      case "LabelText":
      case "Legend":
        return this.children(n, frame, nodes, { ...ctx, inLabel: true });
      case "group":
      case "radiogroup":
      case "tablist":
      case "menu":
      case "menubar":
      case "tree":
      case "grid":
      case "toolbar": {
        const kids = this.children(n, frame, nodes, ctx);
        if (!name && role === "group") return kids;
        return [{ ...base(role), children: kids }];
      }
      case "table":
        return [this.table(n, frame, nodes, ctx, base)];
      case "image":
      case "img":
        if (this.mode === "full" && name && !ctx.inLeaf) return [base("img")];
        return [];
      case "MenuListPopup":
        return [];
      default:
        return this.children(n, frame, nodes, ctx);
    }
  }

  private table(n: AXNode, frame: FrameData, nodes: Map<string, AXNode>, ctx: Ctx, base: (role: string) => SNode): SNode {
    const node = base("table");
    const rows: AXNode[] = [];
    const collect = (x: AXNode) => {
      for (const id of x.childIds ?? []) {
        const c = nodes.get(id);
        if (!c) continue;
        if (str(c.role?.value) === "row") rows.push(c);
        else if (str(c.role?.value) !== "table") collect(c);
      }
    };
    collect(n);
    if (this.mode === "interactive") {
      node.attrs.push(`(${rows.length} rows)`);
      node.children = this.children(n, frame, nodes, { ...ctx, inLeaf: true }).filter((k) => k.role !== "text");
      return node;
    }
    node.children = rows.map((r) => {
      const cells = (r.childIds ?? []).map((id) => nodes.get(id)).filter((c): c is AXNode => !!c && !c.ignored);
      const row: SNode = { role: "row", name: cells.map((c) => clean(str(c.name?.value) || textOf(c, nodes))).join(" | "), attrs: [], frameId: frame.frameId, children: [] };
      row.children = this.children(r, frame, nodes, { ...ctx, inLeaf: true }).filter((k) => k.role !== "text");
      return row;
    });
    return node;
  }

  private addState(node: SNode, n: AXNode, info: NodeInfo | undefined, axRole: string): void {
    const type = info?.attrs.type?.toLowerCase();
    const secret = type === "password" || SECRET_AUTOCOMPLETE.test(info?.attrs.autocomplete ?? "");
    if (type === "password") node.attrs.push("type=password");
    if (VALUE_ROLES.has(node.role)) {
      const v = str(n.value?.value);
      node.value = secret ? "<redacted>" : quote(truncate(clean(v), 80));
    }
    const checked = str(prop(n, "checked"));
    if (checked === "true") node.attrs.push("checked");
    else if (checked === "mixed") node.attrs.push("checked=mixed");
    if (prop(n, "selected") === true) node.attrs.push("selected");
    const pressed = str(prop(n, "pressed"));
    if (pressed === "true") node.attrs.push("pressed");
    const expanded = info?.tag === "SELECT" ? undefined : prop(n, "expanded");
    if (expanded === true) node.attrs.push("expanded");
    else if (expanded === false) node.attrs.push("expanded=false");
    if (prop(n, "disabled") === true) node.attrs.push("disabled");
    if (prop(n, "required") === true) node.attrs.push("required");
    const invalid = str(prop(n, "invalid"));
    if (invalid && invalid !== "false") node.attrs.push("invalid");
    if (prop(n, "readonly") === true && VALUE_ROLES.has(node.role)) node.attrs.push("readonly");
    if (prop(n, "focused") === true) node.attrs.push("focused");
    if (this.mode === "full" && node.role === "link") {
      const href = str(prop(n, "url")) || info?.attrs.href || "";
      if (href) node.attrs.push(`href=${shortUrl(href, 60)}`);
    }
  }
}

function hasText(n: AXNode, nodes: Map<string, AXNode>, depth = 0): boolean {
  if (depth > 50) return false;
  if (str(n.role?.value) === "StaticText" && clean(str(n.name?.value))) return true;
  if (clean(str(n.name?.value)) && depth === 0 && str(n.role?.value) !== "generic") return true;
  return (n.childIds ?? []).some((id) => {
    const c = nodes.get(id);
    return c ? hasText(c, nodes, depth + 1) : false;
  });
}

function textOf(n: AXNode, nodes: Map<string, AXNode>, depth = 0): string {
  if (depth > 50) return "";
  if (str(n.role?.value) === "StaticText") return str(n.name?.value);
  return (n.childIds ?? [])
    .map((id) => nodes.get(id))
    .filter((c): c is AXNode => !!c)
    .map((c) => textOf(c, nodes, depth + 1))
    .join(" ");
}

function optionNames(n: AXNode, nodes: Map<string, AXNode>): string[] {
  const out: string[] = [];
  const walk = (x: AXNode, depth: number) => {
    if (depth > 6) return;
    for (const id of x.childIds ?? []) {
      const c = nodes.get(id);
      if (!c) continue;
      if (str(c.role?.value) === "option") out.push(clean(str(c.name?.value)) + (c.properties?.some((p) => p.name === "selected" && p.value.value === true) ? "*" : ""));
      else walk(c, depth + 1);
    }
  };
  walk(n, 0);
  return out;
}

/** Joins neighbouring text runs into one. */
function mergeText(nodes: SNode[]): SNode[] {
  const out: SNode[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (n.role === "text" && prev?.role === "text" && prev.children.length === 0) {
      prev.name = clean(`${prev.name} ${n.name}`);
      prev.rect = unionRect(prev.rect, n.rect);
    } else out.push(n);
  }
  return out;
}

function offsetRect(r: Rect, frame: FrameData): Rect {
  return { x: r.x + frame.offset.x, y: r.y + frame.offset.y, width: r.width, height: r.height };
}

function unionRect(a: Rect | undefined, b: Rect | undefined): Rect | undefined {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

export function shortUrl(url: string, max: number): string {
  return truncate(url.replace(/^https?:\/\//, ""), max);
}

// ---------- rendering ----------

function line(n: SNode, mode: SnapshotMode): string {
  if (n.role === "text") {
    if (mode === "full") return `text ${quote(truncate(n.name, 2000))}`;
    if (n.name.length <= 80) return `text ${quote(n.name)}`;
    const words = n.name.split(" ");
    const head = truncate(n.name, 60);
    const shown = head.replace(/…$/, "").split(" ").length;
    return `text ${quote(head)} (+${Math.max(1, words.length - shown)} words)`;
  }
  const parts = [n.role];
  if (n.name) parts.push(quote(truncate(n.name, 80)));
  if (n.ref) parts.push(n.ref);
  // `type=password value=<redacted>`, as in §10.2.
  const typeAttr = n.attrs.includes("type=password");
  if (typeAttr) parts.push("type=password");
  if (n.value !== undefined) parts.push(`value=${n.value}`);
  parts.push(...(typeAttr ? n.attrs.filter((a) => a !== "type=password") : n.attrs));
  return parts.join(" ");
}

interface Rendered {
  lines: string[];
  refs: number;
}

function render(n: SNode, mode: SnapshotMode, depth: number, out: Rendered): void {
  out.lines.push("  ".repeat(depth) + line(n, mode));
  if (n.ref) out.refs++;
  for (const c of n.children) render(c, mode, depth + 1, out);
}

const tokensOf = (chars: number) => Math.ceil(chars / 4);
const cost = (n: SNode, mode: SnapshotMode, depth: number): number => {
  const r: Rendered = { lines: [], refs: 0 };
  render(n, mode, depth, r);
  return tokensOf(r.lines.reduce((s, l) => s + l.length + 1, 0));
};
const refCount = (n: SNode): number => (n.ref ? 1 : 0) + n.children.reduce((s, c) => s + refCount(c), 0);
const bbox = (n: SNode): Rect | undefined => n.children.reduce<Rect | undefined>((r, c) => unionRect(r, bbox(c)), n.rect);

// ---------- entry point ----------

export function buildSnapshot(page: PageData, refs: RefTable, opts: BuildOptions): BuildResult {
  const builder = new Builder(page, refs, opts.mode);
  const root = builder.build();

  // Diff baseline: the whole page, always in interactive form (the format actions report changes in).
  const baselineRoot = opts.mode === "interactive" ? root : new Builder(page, refs, "interactive").build();
  const baseline: DiffLine[] = [];
  const collectBaseline = (n: SNode, path: string) => {
    if (n.role !== "page") {
      // Focus moves with every action; it isn't a change worth reporting.
      const text = line(n, "interactive").replace(/ focused(?= |$)/, "");
      const key = n.backendId !== undefined ? `${n.frameId}:${n.backendId}` : `${path}/${text}`;
      baseline.push({ key, ...(n.ref ? { ref: n.ref } : {}), text });
    }
    const childPath = n.backendId !== undefined ? `${n.frameId}:${n.backendId}` : path;
    for (const c of n.children) collectBaseline(c, childPath);
  };
  collectBaseline(baselineRoot, "");

  let top: SNode[] = root.children;
  let scopeFound = true;
  if (opts.scope) {
    const found = findRef(root, opts.scope);
    scopeFound = !!found;
    top = found ? [found] : [];
  }

  const vp = page.viewport;
  const viewTop = vp.scrollY;
  const viewBottom = vp.scrollY + vp.height;
  const distance = (n: SNode): number => {
    const r = bbox(n);
    if (!r) return Number.MAX_SAFE_INTEGER / 2;
    if (r.y + r.height < viewTop) return viewTop - (r.y + r.height);
    if (r.y > viewBottom) return r.y - viewBottom;
    return 0;
  };

  let collapsed = 0;
  const out: Rendered = { lines: [], refs: 0 };

  /** Line for a run of left-out siblings: one section with its own ref, or a count with the parent's ref. */
  const collapsedLine = (run: SNode[], depth: number, parentRef: string | undefined): string => {
    const pad = "  ".repeat(depth);
    collapsed += run.length;
    // A single section that has refs inside gets its own line and ref, so the agent can --scope into it.
    const only = run.length === 1 && run[0]!.role !== "text" && refCount(run[0]!) - (run[0]!.ref ? 1 : 0) > 0 ? run[0] : undefined;
    const ref = only ? builder.ensureRef(only) : undefined;
    if (only && ref) {
      const inside = refCount(only) - (only.ref ? 1 : 0);
      const label = `${only.role}${only.name ? " " + quote(truncate(only.name, 60)) : ""}`;
      return `${pad}${label} ${ref} (collapsed: ${inside} refs; use --scope ${ref})`;
    }
    const refs = run.reduce((s, n) => s + refCount(n), 0);
    const where = parentRef ? `use --scope ${parentRef} or a larger --max-tokens` : "use a larger --max-tokens";
    return `${pad}… ${run.length} more ${run.length === 1 ? "item" : "items"} collapsed (${refs} refs; ${where})`;
  };

  /**
   * Renders `nodes` at `depth` within `budget` tokens. Sections closest to the viewport are kept whole; the
   * nearest one that doesn't fit is opened up and fitted recursively; the rest become "collapsed" lines.
   */
  const fit = (nodes: SNode[], depth: number, budget: number, parentRef: string | undefined): void => {
    const costs = nodes.map((n) => cost(n, opts.mode, depth));
    if (costs.reduce((a, b) => a + b, 0) <= budget) {
      for (const n of nodes) render(n, opts.mode, depth, out);
      return;
    }
    const LINE_COST = 22; // a "collapsed" line
    // Closest to the viewport first; ties in document order.
    const order = nodes.map((n, i) => ({ n, i, d: distance(n), c: costs[i]! })).sort((a, b) => a.d - b.d || a.i - b.i);
    const full = new Set<number>();
    let used = 0;
    for (const o of order) {
      if (used + o.c <= budget - LINE_COST) {
        full.add(o.i);
        used += o.c;
      }
    }
    // The nearest section that didn't fit whole is opened up with what is left.
    const splitAt = order.find((o) => !full.has(o.i) && o.n.children.length)?.i;
    const runsOf = () => {
      let runs = 0;
      let inRun = false;
      nodes.forEach((_, i) => {
        const left = !full.has(i) && i !== splitAt;
        if (left && !inRun) runs++;
        inRun = left;
      });
      return runs;
    };
    // Make room for every "collapsed" line: drop the farthest whole sections until it all fits.
    const byDistanceDesc = [...order].reverse();
    while (used + runsOf() * LINE_COST > budget && full.size) {
      const drop = byDistanceDesc.find((o) => full.has(o.i))!;
      full.delete(drop.i);
      used -= drop.c;
    }
    const splitBudget = budget - used - runsOf() * LINE_COST;
    const plan = new Map<number, { kind: "full" } | { kind: "split"; budget: number }>();
    for (const i of full) plan.set(i, { kind: "full" });
    if (splitAt !== undefined && splitBudget >= LINE_COST * 2) plan.set(splitAt, { kind: "split", budget: splitBudget });
    let run: SNode[] = [];
    const flush = () => {
      if (run.length) out.lines.push(collapsedLine(run, depth, parentRef));
      run = [];
    };
    nodes.forEach((n, i) => {
      const p = plan.get(i);
      if (!p) {
        run.push(n);
        return;
      }
      flush();
      if (p.kind === "full") render(n, opts.mode, depth, out);
      else {
        const head = "  ".repeat(depth) + line(n, opts.mode);
        out.lines.push(head);
        if (n.ref) out.refs++;
        fit(n.children, depth + 1, p.budget - tokensOf(head.length + 1), n.ref ?? builder.ensureRef(n) ?? parentRef);
      }
    });
    flush();
  };
  fit(top, 0, opts.maxTokens, opts.scope);

  // Hard limit: never return more than the budget.
  let text = out.lines.join("\n");
  if (tokensOf(text.length) > opts.maxTokens) {
    const kept: string[] = [];
    let chars = 0;
    const room = opts.maxTokens * 4 - 80;
    for (const l of out.lines) {
      if (chars + l.length + 1 > room) break;
      kept.push(l);
      chars += l.length + 1;
    }
    kept.push(`… cut to fit ${opts.maxTokens} tokens (use --scope or a larger --max-tokens)`);
    text = kept.join("\n");
    out.refs = kept.reduce((s, l) => s + (/ @e\d+/.test(l) ? 1 : 0), 0);
  }
  return { text, refs: out.refs, tokens: tokensOf(text.length), hiddenOmitted: builder.hiddenOmitted, collapsed, baseline, scopeFound };
}

function findRef(n: SNode, ref: string): SNode | undefined {
  if (n.ref === ref) return n;
  for (const c of n.children) {
    const f = findRef(c, ref);
    if (f) return f;
  }
  return undefined;
}

/** Elements in the tree with their fingerprints, for re-finding a stale ref (§10.4). */
export function listRefTargets(page: PageData, refs: RefTable): SNode[] {
  const root = new Builder(page, refs, "interactive").build();
  const out: SNode[] = [];
  const walk = (n: SNode) => {
    if (n.ref) out.push(n);
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}
