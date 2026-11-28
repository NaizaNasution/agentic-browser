// Snapshot diffs (docs/SPEC.md §10.6, §11.4): what changed between two snapshots of the same document.
import type { DiffLine } from "./build";

export interface Change {
  op: "+" | "-" | "~";
  text: string;
  ref?: string;
}

/**
 * Compares two baselines. Elements are matched by key: present only in `next` is "+", only in `prev` is "-",
 * in both with different text is "~". Text runs have no element of their own and are matched by content.
 */
export function diffSnapshots(prev: DiffLine[], next: DiffLine[]): Change[] {
  const before = new Map<string, DiffLine>();
  for (const l of prev) before.set(l.key, l);
  const after = new Map<string, DiffLine>();
  for (const l of next) after.set(l.key, l);

  const changes: Change[] = [];
  for (const l of next) {
    const old = before.get(l.key);
    if (!old) changes.push({ op: "+", text: l.text, ...(l.ref ? { ref: l.ref } : {}) });
    else if (old.text !== l.text) changes.push({ op: "~", text: l.text, ...(l.ref ? { ref: l.ref } : {}) });
  }
  for (const l of prev) {
    if (!after.has(l.key)) changes.push({ op: "-", text: l.text, ...(l.ref ? { ref: l.ref } : {}) });
  }
  return changes;
}

/** "+ alert "…" @e9" lines, at most `max`, with a note for the rest. */
export function formatChanges(changes: Change[], max: number): string[] {
  const lines = changes.slice(0, max).map((c) => `${c.op} ${c.text}`);
  if (changes.length > max) lines.push(`… ${changes.length - max} more changes (use agb snapshot)`);
  return lines;
}
