// Codegen tests from docs/testing/M0-test-cases.md (B-02, B-03, B-04, B-05).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codegen = join(pkg, "scripts/codegen.mjs");
const realSchema = JSON.parse(readFileSync(join(pkg, "schema/protocol.json"), "utf8"));

function gen(args) {
  return spawnSync(process.execPath, [codegen, ...args], { encoding: "utf8" });
}

function genTo(schema) {
  const dir = mkdtempSync(join(tmpdir(), "agb-codegen-"));
  const schemaFile = join(dir, "schema.json");
  writeFileSync(schemaFile, JSON.stringify(schema));
  const ts = join(dir, "out.ts");
  const go = join(dir, "out.go");
  const r = gen(["--schema", schemaFile, "--ts-out", ts, "--go-out", go]);
  return { r, ts, go };
}

test("B-02: checked-in generated files match the schema", () => {
  const r = gen(["--check"]);
  assert.equal(r.status, 0, r.stderr);
});

test("B-03: codegen is deterministic", () => {
  const a = genTo(realSchema);
  const b = genTo(realSchema);
  assert.equal(a.r.status, 0, a.r.stderr);
  assert.equal(readFileSync(a.ts, "utf8"), readFileSync(b.ts, "utf8"));
  assert.equal(readFileSync(a.go, "utf8"), readFileSync(b.go, "utf8"));
});

test("B-04: a new method and type appear in both outputs", () => {
  const schema = structuredClone(realSchema);
  schema.types.EchoParams = {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string" }, times: { type: "integer" }, loud: { type: "boolean" } },
  };
  schema.types.EchoResult = { type: "object", required: ["lines"], properties: { lines: { type: "array", items: { type: "string" } } } };
  schema.methods["test.echo"] = { description: "Echo text.", params: "EchoParams", result: "EchoResult" };
  const { r, ts, go } = genTo(schema);
  assert.equal(r.status, 0, r.stderr);
  const tsSrc = readFileSync(ts, "utf8");
  const goSrc = readFileSync(go, "utf8");
  assert.match(tsSrc, /export interface EchoParams \{\n  text: string;\n  times\?: number;\n  loud\?: boolean;\n\}/);
  assert.match(tsSrc, /"test\.echo": \{ params: EchoParams; result: EchoResult \}/);
  assert.match(goSrc, /type EchoParams struct \{/);
  assert.match(goSrc, /Text\s+string\s+`json:"text"`/);
  assert.match(goSrc, /Times\s+int64\s+`json:"times,omitempty"`/);
  assert.match(goSrc, /Lines\s+\[\]string\s+`json:"lines"`/);
  assert.match(goSrc, /MethodTestEcho\s+= "test\.echo"/);
});

test("B-05: an unsupported type fails and writes nothing", () => {
  const schema = structuredClone(realSchema);
  schema.types.Bad = { type: "object", properties: { x: { type: "null" } } };
  const { r, ts, go } = genTo(schema);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unsupported type/);
  assert.ok(!existsSync(ts) && !existsSync(go), "no partial output");
});
