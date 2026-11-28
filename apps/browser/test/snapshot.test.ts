// Snapshot engine (docs/SPEC.md §10): layout facts, filters, refs, text format, budget, scope, and diffs.
// Uses a recorded page (test/fixtures/rich-page.raw.json: forms, hidden text, shadow DOM, same- and cross-site
// iframes) and small hand-made layout snapshots. Case IDs are from docs/testing/M2-test-cases.md.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildSnapshot, listRefTargets } from "../src/main/agent/snapshot/build";
import { diffSnapshots, formatChanges } from "../src/main/agent/snapshot/diff";
import { assemblePage, parseDomSnapshot } from "../src/main/agent/snapshot/layout";
import { normalizeRef, RefTable } from "../src/main/agent/snapshot/refs";
import type { DomSnapshot, RawPage } from "../src/main/agent/snapshot/types";

const fixture = (): RawPage => JSON.parse(readFileSync(join(__dirname, "../../test/fixtures/rich-page.raw.json"), "utf8"));
const build = (raw: RawPage, refs = new RefTable(), opts: Partial<Parameters<typeof buildSnapshot>[2]> = {}) =>
  buildSnapshot(assemblePage(raw), refs, { mode: "interactive", maxTokens: 4000, ...opts });
const lines = (text: string) => text.split("\n");

test("P-01: interactive snapshot of a rich page", () => {
  const r = build(fixture());
  const text = r.text;
  // Landmarks with refs, interactive elements with refs and state, headings without refs.
  for (const expected of [
    "banner @e1",
    '  navigation "Main" @e3',
    "main @e6",
    '  heading "Sign in" level=1',
    '  form "Login" @e7',
    '    textbox "Email" @e8 value="a@b.c" required',
    '    checkbox "Remember me" @e10 checked',
    '    group "Plan"',
    '      radio "Free" @e11 checked',
    '    combobox "Country" @e13 value="Japan" options="Indonesia | Japan* | Kenya"',
    '    button "Disabled" @e15 disabled',
    '    button "Menu" @e16 expanded=false',
    '    clickable "Clickable div" @e17',
    '    textbox "Editor" @e18 value="Edit me"',
    '  alert "Wrong password" @e19',
    '    option "Apple" @e21 selected',
    '  button "Shadow button" @e23',
    "contentinfo @e29",
  ]) {
    assert.ok(lines(text).includes(expected), `missing line: ${expected}\n---\n${text}`);
  }
  assert.equal(r.refs, 30);
  assert.ok(r.tokens > 200 && r.tokens < 400, String(r.tokens));
});

test("P-02: passwords are redacted, and type=password comes first", () => {
  const text = build(fixture()).text;
  assert.ok(lines(text).includes('    textbox "Password" @e9 type=password value=<redacted>'), text);
  assert.doesNotMatch(text, /hunter2|•••/);
});

test("P-03: text people can't see is left out and counted", () => {
  const r = build(fixture());
  for (const hidden of ["display none", "tiny", "transparent", "Ghost", "Aria hidden button", "Offscreen button"]) {
    assert.ok(!r.text.includes(hidden), `"${hidden}" should be filtered`);
  }
  assert.equal(r.hiddenOmitted, 3);
});

test("P-04: same-site and cross-site iframes are nested under their <iframe>", () => {
  const text = build(fixture()).text;
  assert.match(text, /\n  iframe "Same frame" @e24 \(127\.0\.0\.1:8000\/same\)\n    link "Same-origin link" @e25\n/);
  assert.match(text, /\n  iframe "Cross frame" @e26 \(localhost:9000\/\)\n    button "Cross button" @e27\n/);
});

test("P-05: long text is summarized in interactive mode and complete in full mode", () => {
  const raw = fixture();
  const interactive = build(raw).text;
  assert.match(interactive, /\n  text "Welcome back\. Please sign in with your account to continue…" \(\+\d+ words\)\n/);
  const full = build(raw, new RefTable(), { mode: "full" }).text;
  assert.match(full, /text "Welcome back\. Please sign in with your account to continue to the dashboard and see everything\."/);
  assert.match(full, /link "Docs" @e4 href=127\.0\.0\.1:8000\/a/);
  assert.match(full, /\n  table\n    row "Name \| Qty"\n    row "Apple \| 3"\n/);
  assert.match(full, /img "Diagram"/);
  assert.match(interactive, /table \(2 rows\)/);
  assert.doesNotMatch(interactive, /href=|img "Diagram"/);
});

test("P-06: refs are stable across snapshots of the same document, and new elements get new numbers", () => {
  const refs = new RefTable();
  const raw = fixture();
  const first = build(raw, refs).text;
  const second = build(raw, refs).text;
  assert.equal(second, first, "same page, same refs");

  // Remove the "Sign in" button from the page: other refs keep their numbers; nothing is renumbered.
  const changed = fixture();
  const main = changed.frames[0]!;
  const signIn = main.ax.find((n) => n.name?.value === "Sign in" && n.role?.value === "button")!;
  for (const n of main.ax) n.childIds = n.childIds?.filter((id) => id !== signIn.nodeId);
  const third = build(changed, refs).text;
  assert.ok(!third.includes('button "Sign in"'));
  assert.ok(third.includes('button "Disabled" @e15'), "later refs keep their numbers");

  // Put it back as a different element (new backend id): it gets the next free number, not @e14.
  const readded = fixture();
  readded.frames[0]!.ax.find((n) => n.nodeId === signIn.nodeId)!.backendDOMNodeId = 9999;
  const fourth = build(readded, refs).text;
  assert.ok(fourth.includes('button "Sign in" @e31'), fourth);
});

test("P-07: the token budget collapses the sections farthest from the viewport", () => {
  const r = build(fixture(), new RefTable(), { maxTokens: 200 });
  assert.ok(r.tokens <= 200, `${r.tokens} tokens`);
  assert.ok(r.collapsed >= 1);
  assert.match(r.text, /contentinfo @e29 \(collapsed: 1 refs; use --scope @e29\)|\(collapsed: \d+ refs; use --scope @e\d+\)/);
  assert.match(r.text, /^banner @e1\n  link "Logo" @e2/, "the top of the page, in the viewport, is kept");
  // Scrolled to the bottom, what's in view (bottom link, footer) is kept and the form at the top collapses.
  const bottom = fixture();
  bottom.viewport.scrollY = 1500;
  const rb = build(bottom, new RefTable(), { maxTokens: 120 });
  assert.ok(rb.tokens <= 120, `${rb.tokens} tokens`);
  assert.match(rb.text, /link "Bottom link" @e28\ncontentinfo @e29\n  link "Terms" @e30$/);
  assert.match(rb.text, /… \d+ more items collapsed \(\d+ refs; use --scope @e6 or a larger --max-tokens\)/);
  assert.ok(!rb.text.includes('textbox "Email"'));
});

test("P-08: --scope shows one element's subtree", () => {
  const refs = new RefTable();
  build(fixture(), refs);
  const r = build(fixture(), refs, { scope: "@e7" });
  assert.ok(r.scopeFound);
  assert.match(r.text, /^form "Login" @e7\n  textbox "Email" @e8/);
  assert.ok(!r.text.includes("banner"));
  assert.equal(build(fixture(), refs, { scope: "@e999" }).scopeFound, false);
});

test("P-09: diffs report added, removed, and changed elements, ignoring focus", () => {
  const refs = new RefTable();
  const before = build(fixture(), refs).baseline;
  const changed = fixture();
  const main = changed.frames[0]!;
  const email = main.ax.find((n) => n.name?.value === "Email" && n.role?.value === "textbox")!;
  email.value = { type: "string", value: "new@example.com" };
  email.properties = [...(email.properties ?? []), { name: "focused", value: { value: true } }];
  const alert = main.ax.find((n) => n.role?.value === "alert")!;
  for (const n of main.ax) n.childIds = n.childIds?.filter((id) => id !== alert.nodeId);
  const after = build(changed, refs).baseline;
  const changes = formatChanges(diffSnapshots(before, after), 10);
  assert.deepEqual(changes, ['~ textbox "Email" @e8 value="new@example.com" required', '- alert "Wrong password" @e19']);
  assert.deepEqual(formatChanges(diffSnapshots(before, before), 10), []);
  const many = formatChanges(Array.from({ length: 15 }, (_, i) => ({ op: "+" as const, text: `x${i}` })), 12);
  assert.equal(many.length, 13);
  assert.equal(many[12], "… 3 more changes (use agb snapshot)");
});

test("P-10: listRefTargets gives fingerprints for re-finding replaced elements", () => {
  const refs = new RefTable();
  build(fixture(), refs);
  const targets = listRefTargets(assemblePage(fixture()), refs);
  const signIn = targets.find((t) => t.name === "Sign in" && t.role === "button")!;
  assert.deepEqual(signIn.fp, { role: "button", name: "Sign in", tag: "BUTTON", landmark: "form:Login" });
  assert.equal(refs.get(signIn.ref!)!.fingerprint.index, 0);
});

test("P-11: RefTable: assign, rebind, reset, and ref spelling", () => {
  const refs = new RefTable();
  const fp = { role: "button", name: "OK", tag: "BUTTON", landmark: "", index: 0 };
  assert.equal(refs.assign("F", 10, fp), "@e1");
  assert.equal(refs.assign("F", 11, fp), "@e2");
  assert.equal(refs.assign("F", 10, fp), "@e1", "same element, same ref");
  refs.rebind("@e1", "F", 20);
  assert.equal(refs.refFor("F", 20), "@e1");
  assert.equal(refs.refFor("F", 10), undefined);
  assert.equal(refs.get("e1")!.backendId, 20);
  assert.equal(refs.issued, 2);
  refs.reset();
  assert.equal(refs.issued, 0);
  assert.equal(refs.get("@e1"), undefined, "a navigation forgets the old refs");
  assert.equal(refs.assign("F", 11, fp), "@e3", "numbering continues, so an old ref can't hit a new element");
  assert.ok(refs.fromEarlierDocument("@e2"));
  assert.ok(!refs.fromEarlierDocument("@e3"));
  assert.ok(!refs.fromEarlierDocument("@e9"));
  assert.deepEqual(["@e12", "e12", "12", " @E7 "].map(normalizeRef), ["@e12", "@e12", "@e12", "@e7"]);
});

// ---------- layout rules, on hand-made DOMSnapshots ----------

/** One document; each node: [parentIndex, tag, backendId, styles | null (no layout), bounds?]. */
function snapshotOf(nodes: [number, string, number, string[] | null, number[]?][], extra: Partial<DomSnapshot["documents"][number]> = {}): DomSnapshot {
  const strings: string[] = ["F1"];
  const s = (v: string) => {
    const i = strings.indexOf(v);
    if (i >= 0) return i;
    strings.push(v);
    return strings.length - 1;
  };
  const layout = { nodeIndex: [] as number[], styles: [] as number[][], bounds: [] as number[][] };
  nodes.forEach(([, , , styles, bounds], i) => {
    if (!styles) return;
    layout.nodeIndex.push(i);
    layout.styles.push(styles.map(s));
    layout.bounds.push(bounds ?? [0, 0, 100, 20]);
  });
  return {
    strings,
    documents: [
      {
        frameId: 0,
        contentWidth: 1000,
        contentHeight: 2000,
        nodes: { parentIndex: nodes.map((n) => n[0]), nodeName: nodes.map((n) => s(n[1])), backendNodeId: nodes.map((n) => n[2]), attributes: nodes.map(() => []), isClickable: { index: [] } },
        layout,
        ...extra,
      },
    ],
  };
}
const style = (o: Partial<Record<"display" | "visibility" | "opacity" | "font" | "color" | "bg" | "cursor", string>> = {}) => [
  o.display ?? "block", o.visibility ?? "visible", o.opacity ?? "1", o.font ?? "16px", o.color ?? "rgb(0, 0, 0)", o.bg ?? "rgba(0, 0, 0, 0)", o.cursor ?? "auto",
];

test("P-12: layout rules: visibility, opacity (inherited), size, position, font size, and contrast", () => {
  const [doc] = parseDomSnapshot(
    snapshotOf([
      [-1, "BODY", 1, style({ bg: "rgb(255, 255, 255)" })],
      [0, "DIV", 2, style({ visibility: "hidden" })],
      [0, "DIV", 3, style({ opacity: "0" })],
      [2, "SPAN", 4, style()], // inside opacity 0
      [0, "DIV", 5, style(), [0, 0, 0, 0]], // zero size
      [0, "DIV", 6, style(), [-5000, 10, 100, 20]], // off the page
      [0, "P", 7, style({ font: "1px" })],
      [6, "#text", 8, null], // text in the 1px paragraph: no layout of its own, parent's style
      [0, "P", 9, style({ color: "rgb(255, 255, 255)" })], // white on (inherited) white
      [8, "#text", 10, style({ color: "rgb(255, 255, 255)" })],
      [0, "P", 11, style()],
      [0, "DIV", 12, style({ display: "contents" }), [0, 0, 0, 0]], // contents: no box of its own, still shown
      [0, "OPTION", 13, null], // no layout object at all (closed <select> option)
    ]),
  );
  const n = doc!.nodes;
  const vis = (id: number) => n.get(id)!.visible;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 11, 12, 13].map(vis), [true, false, false, false, false, false, true, true, true]);
  assert.equal(n.get(7)!.unreadable, true, "tiny font");
  assert.equal(n.get(8)!.unreadable, true, "text uses its parent's style");
  assert.equal(n.get(9)!.unreadable, true, "same color as the inherited background");
  assert.equal(n.get(11)!.unreadable, false);
  assert.equal(doc!.frameId, "F1");
});
