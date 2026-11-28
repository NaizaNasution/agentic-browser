// Data the snapshot engine works on (docs/SPEC.md §10). Plain JSON, so recorded pages can be test fixtures.

/** Accessibility node as returned by CDP Accessibility.getFullAXTree. */
export interface AXValue {
  type?: string;
  value?: unknown;
}
export interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

/** CDP DOMSnapshot.captureSnapshot result (only the parts the engine reads). */
export interface DomSnapshot {
  strings: string[];
  documents: {
    frameId: number;
    scrollOffsetX?: number;
    scrollOffsetY?: number;
    contentWidth?: number;
    contentHeight?: number;
    nodes: {
      parentIndex?: number[];
      nodeName?: number[];
      backendNodeId?: number[];
      attributes?: number[][];
      isClickable?: { index: number[] };
    };
    layout: {
      nodeIndex: number[];
      styles: number[][];
      bounds: number[][];
    };
  }[];
}

/** Computed styles requested from DOMSnapshot, in this order. */
export const SNAPSHOT_STYLES = ["display", "visibility", "opacity", "font-size", "color", "background-color", "cursor"] as const;

/** Everything collected from a page with CDP, before any processing. */
export interface RawPage {
  /** Frames in tree order; the first is the main frame. `session` is "" for the root CDP session. */
  frames: { frameId: string; parentFrameId?: string; url: string; session: string; ax: AXNode[] }[];
  /** DOMSnapshot per CDP session (each covers all same-process frames of that session). */
  snapshots: Record<string, DomSnapshot>;
  /** Owner element (<iframe>) of each child frame, as a backend node ID in its parent frame. */
  owners: Record<string, number>;
  /** Main frame viewport in CSS pixels and its scroll position. */
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the engine knows about one DOM node from the layout snapshot. */
export interface NodeInfo {
  tag: string;
  attrs: Record<string, string>;
  /** Box in the frame's document coordinates; absent when the node isn't rendered as a box. */
  rect?: Rect;
  /** Rendered, not visibility:hidden, not under opacity 0, not zero-size, not positioned off the page. */
  visible: boolean;
  /** Text that people can't read: tiny font, transparent, or the background's color. */
  unreadable: boolean;
  clickable: boolean;
  pointer: boolean;
}

export interface FrameData {
  frameId: string;
  parentFrameId?: string;
  url: string;
  session: string;
  ax: AXNode[];
  nodes: Map<number, NodeInfo>;
  ownerBackendId?: number;
  /** Where the frame's document origin is, in main-frame document coordinates. */
  offset: { x: number; y: number };
}

export interface PageData {
  frames: FrameData[];
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  content: { width: number; height: number };
}
