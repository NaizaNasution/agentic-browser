import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveInput, SEARCH_URL } from "../src/main/url";

const search = (q: string) => SEARCH_URL + encodeURIComponent(q);

test("full URLs are kept", () => {
  assert.equal(resolveInput("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(resolveInput("http://localhost:3000/"), "http://localhost:3000/");
  assert.equal(resolveInput("about:blank"), "about:blank");
});

test("host-like input gets a scheme", () => {
  assert.equal(resolveInput("example.com"), "https://example.com/");
  assert.equal(resolveInput("docs.example.co.id/path"), "https://docs.example.co.id/path");
  assert.equal(resolveInput("localhost:5173"), "http://localhost:5173/");
  assert.equal(resolveInput("127.0.0.1:8080/x"), "http://127.0.0.1:8080/x");
  assert.equal(resolveInput("myapp.test"), "http://myapp.test/");
});

test("everything else is a search", () => {
  assert.equal(resolveInput("how to bake bread"), search("how to bake bread"));
  assert.equal(resolveInput("electron"), search("electron"));
});

test("E-16: filenames and unknown suffixes are searched, not loaded as sites", () => {
  for (const q of ["notes.txt", "report.pdf", "index.html", "main.go", "script.js", "intranet.corp", "wiki"]) {
    assert.equal(resolveInput(q), search(q), q);
  }
});

test("real public suffixes, including new and private ones, load over https", () => {
  assert.equal(resolveInput("example.dev"), "https://example.dev/");
  assert.equal(resolveInput("user.github.io"), "https://user.github.io/");
  assert.equal(resolveInput("EXAMPLE.COM/Path"), "https://example.com/Path");
  // Chrome does the same: .md and .zip are real TLDs.
  assert.equal(resolveInput("readme.md"), "https://readme.md/");
});

test("intranet hosts load over http when a port or path makes the intent clear", () => {
  assert.equal(resolveInput("intranet.corp/"), "http://intranet.corp/");
  assert.equal(resolveInput("wiki/page"), "http://wiki/page");
  assert.equal(resolveInput("build-server:8080"), "http://build-server:8080/");
  assert.equal(resolveInput("10.0.0.5"), "http://10.0.0.5/");
});

test("inputs that aren't valid hosts are searched", () => {
  assert.equal(resolveInput("c++"), search("c++"));
  assert.equal(resolveInput("a..b"), search("a..b"));
  assert.equal(resolveInput("what?"), search("what?"));
});

test("disallowed schemes become a search, not a navigation", () => {
  assert.equal(resolveInput("javascript:alert(1)"), search("javascript:alert(1)"));
  assert.equal(resolveInput("file:///C:/Windows/win.ini"), search("file:///C:/Windows/win.ini"));
});

test("empty input opens a blank page", () => {
  assert.equal(resolveInput("   "), "about:blank");
});
