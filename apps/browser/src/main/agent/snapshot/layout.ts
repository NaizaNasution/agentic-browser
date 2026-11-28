// Turns raw CDP data into PageData: per-frame node info (visibility, readability, clickability) and frame offsets.
// Pure; see types.ts.
import type { DomSnapshot, FrameData, NodeInfo, PageData, RawPage, Rect } from "./types";

const KEPT_ATTRS = new Set(["type", "autocomplete", "href", "contenteditable", "name", "id", "placeholder", "aria-autocomplete"]);

type Rgba = [number, number, number, number];

function parseColor(c: string | undefined): Rgba | null {
  const m = c ? /rgba?\(([^)]+)\)/.exec(c) : null;
  if (!m) return null;
  const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
}

interface DocNodes {
  frameId: string;
  scroll: { x: number; y: number };
  content: { width: number; height: number };
  nodes: Map<number, NodeInfo>;
}

/** Parses one DOMSnapshot into node info for each document (frame) it contains. */
export function parseDomSnapshot(snap: DomSnapshot): DocNodes[] {
  const str = (i: number | undefined) => (i === undefined || i < 0 ? "" : (snap.strings[i] ?? ""));
  return snap.documents.map((doc) => {
    const n = doc.nodes;
    const count = n.backendNodeId?.length ?? 0;
    const layoutOf = new Map<number, number>();
    doc.layout.nodeIndex.forEach((nodeIdx, li) => layoutOf.set(nodeIdx, li));
    const clickable = new Set(n.isClickable?.index ?? []);
    const contentW = doc.contentWidth ?? 0;
    const contentH = doc.contentHeight ?? 0;

    // Effective (inherited) facts, computed in document order: parents come before children.
    const opacityZero = new Array<boolean>(count).fill(false);
    const bg = new Array<Rgba | null>(count).fill(null);
    const style = (i: number): string[] => {
      const li = layoutOf.get(i);
      return li === undefined ? [] : (doc.layout.styles[li] ?? []).map(str);
    };
    const nodes = new Map<number, NodeInfo>();

    for (let i = 0; i < count; i++) {
      const parent = n.parentIndex?.[i] ?? -1;
      const tag = str(n.nodeName?.[i]);
      const li = layoutOf.get(i);
      // Text nodes use their parent element's computed style.
      const s = li !== undefined && tag !== "#text" ? style(i) : parent >= 0 ? style(parent) : [];
      const [display, visibility, opacity, fontSize, color, background, cursor] = s;
      opacityZero[i] = (parent >= 0 && opacityZero[parent]!) || (tag !== "#text" && opacity !== undefined && parseFloat(opacity) === 0);
      const ownBg = tag !== "#text" ? parseColor(background) : null;
      bg[i] = ownBg && ownBg[3] > 0.5 ? ownBg : parent >= 0 ? bg[parent]! : null;

      const attrs: Record<string, string> = {};
      const raw = n.attributes?.[i] ?? [];
      for (let a = 0; a + 1 < raw.length; a += 2) {
        const k = str(raw[a]);
        if (KEPT_ATTRS.has(k)) attrs[k] = str(raw[a + 1]);
      }

      let rect: Rect | undefined;
      const b = li !== undefined ? doc.layout.bounds[li] : undefined;
      if (b && b.length >= 4) rect = { x: b[0]!, y: b[1]!, width: b[2]!, height: b[3]! };

      // No layout object: display:none or display:contents. The accessibility tree already drops display:none,
      // so a node it still reports without a box (contents, closed <select> options) counts as visible.
      let visible = true;
      if (li !== undefined) {
        if (visibility === "hidden" || visibility === "collapse" || opacityZero[i]) visible = false;
        else if (rect && display !== "contents" && rect.width <= 0 && rect.height <= 0) visible = false;
        else if (rect && (rect.x + rect.width < 0 || rect.y + rect.height < 0 || rect.x > contentW + 100 || rect.y > contentH + 100)) visible = false;
      } else if (parent >= 0 && opacityZero[parent]) visible = false;

      const fg = parseColor(color);
      const back = bg[i] ?? null;
      const unreadable =
        (fontSize !== undefined && parseFloat(fontSize) < 4) ||
        (fg !== null && fg[3] < 0.1) ||
        (fg !== null && back !== null && Math.abs(fg[0] - back[0]) + Math.abs(fg[1] - back[1]) + Math.abs(fg[2] - back[2]) < 12);

      const id = n.backendNodeId?.[i];
      if (id !== undefined) {
        nodes.set(id, { tag, attrs, ...(rect ? { rect } : {}), visible, unreadable, clickable: clickable.has(i), pointer: cursor === "pointer" });
      }
    }
    return {
      frameId: str(doc.frameId),
      scroll: { x: doc.scrollOffsetX ?? 0, y: doc.scrollOffsetY ?? 0 },
      content: { width: contentW, height: contentH },
      nodes,
    };
  });
}

/** Combines raw CDP data into PageData with frame offsets in main-document coordinates. */
export function assemblePage(raw: RawPage): PageData {
  const docs = new Map<string, DocNodes>();
  for (const snap of Object.values(raw.snapshots)) for (const d of parseDomSnapshot(snap)) docs.set(d.frameId, d);

  const frames: FrameData[] = raw.frames.map((f) => ({
    frameId: f.frameId,
    ...(f.parentFrameId ? { parentFrameId: f.parentFrameId } : {}),
    url: f.url,
    session: f.session,
    ax: f.ax,
    nodes: docs.get(f.frameId)?.nodes ?? new Map(),
    ...(raw.owners[f.frameId] !== undefined ? { ownerBackendId: raw.owners[f.frameId] } : {}),
    offset: { x: 0, y: 0 },
  }));

  // Frame offsets: the owner <iframe>'s box in its parent, minus the child document's scroll. Parents first.
  const byId = new Map(frames.map((f) => [f.frameId, f]));
  for (const f of frames) {
    if (!f.parentFrameId || f.ownerBackendId === undefined) continue;
    const parent = byId.get(f.parentFrameId);
    const owner = parent?.nodes.get(f.ownerBackendId)?.rect;
    if (!parent || !owner) continue;
    const scroll = docs.get(f.frameId)?.scroll ?? { x: 0, y: 0 };
    f.offset = { x: parent.offset.x + owner.x - scroll.x, y: parent.offset.y + owner.y - scroll.y };
  }

  const main = docs.get(raw.frames[0]?.frameId ?? "");
  return {
    frames,
    viewport: raw.viewport,
    content: main?.content ?? { width: raw.viewport.width, height: raw.viewport.height },
  };
}
