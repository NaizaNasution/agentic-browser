// Element refs (@e1, @e2, …) for one tab (docs/SPEC.md §10.3–10.4).
// A ref stays with its element while the document lives. Numbers are never reused within a tab: when the main
// frame navigates, the old refs are forgotten but numbering continues, so a ref from an earlier page can never
// point at a different element on the new one (it fails with E_STALE_REF instead).

/** Identifies an element across snapshots of the same document. */
export interface Fingerprint {
  role: string;
  name: string;
  tag: string;
  /** Nearest landmark ancestor, e.g. `form:Login`. */
  landmark: string;
  /** Position among elements with the same role, name, tag, and landmark, in document order. */
  index: number;
}

export interface RefEntry {
  ref: string;
  frameId: string;
  backendId: number;
  fingerprint: Fingerprint;
}

export const nodeKey = (frameId: string, backendId: number) => `${frameId}:${backendId}`;

export class RefTable {
  private byKey = new Map<string, string>();
  private byRef = new Map<string, RefEntry>();
  private next = 1;
  /** First number handed out on the current document. */
  private documentStart = 1;

  /** Ref for this element: its existing one, or the next number. Updates the fingerprint. */
  assign(frameId: string, backendId: number, fingerprint: Fingerprint): string {
    const key = nodeKey(frameId, backendId);
    let ref = this.byKey.get(key);
    if (!ref) {
      ref = `@e${this.next++}`;
      this.byKey.set(key, ref);
    }
    this.byRef.set(ref, { ref, frameId, backendId, fingerprint });
    return ref;
  }

  get(ref: string): RefEntry | undefined {
    return this.byRef.get(normalizeRef(ref));
  }

  refFor(frameId: string, backendId: number): string | undefined {
    return this.byKey.get(nodeKey(frameId, backendId));
  }

  /** Points an existing ref at a replacement element (stale-ref re-resolution, §10.4). */
  rebind(ref: string, frameId: string, backendId: number): void {
    const entry = this.byRef.get(ref);
    if (!entry) return;
    this.byKey.delete(nodeKey(entry.frameId, entry.backendId));
    const previous = this.byKey.get(nodeKey(frameId, backendId));
    if (previous && previous !== ref) this.byRef.delete(previous);
    this.byKey.set(nodeKey(frameId, backendId), ref);
    this.byRef.set(ref, { ...entry, frameId, backendId });
  }

  /** Forgets every ref (main-frame navigation). Numbering continues, so old refs can't match new elements. */
  reset(): void {
    this.byKey.clear();
    this.byRef.clear();
    this.documentStart = this.next;
  }

  /** Refs handed out on the current document. */
  get issued(): number {
    return this.next - this.documentStart;
  }

  /** Whether a ref was handed out on an earlier document of this tab. */
  fromEarlierDocument(ref: string): boolean {
    const n = Number(/^@e(\d+)$/.exec(normalizeRef(ref))?.[1] ?? NaN);
    return n < this.documentStart;
  }
}

/** Accepts "@e12", "e12", or "12". */
export function normalizeRef(input: string): string {
  const m = /^@?e?(\d+)$/i.exec(input.trim());
  return m ? `@e${Number(m[1])}` : input.trim();
}

export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.role === b.role && a.name === b.name && a.tag === b.tag && a.landmark === b.landmark && a.index === b.index;
}
