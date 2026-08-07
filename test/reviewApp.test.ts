import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenDiffFiles, wrapLine } from "../src/reviewApp";
import { diffFile, hunk } from "./helpers";

// --- wrapLine ---------------------------------------------------------

test("wrapLine: text shorter than width is returned unchanged, as a single-element array", () => {
  assert.deepEqual(wrapLine("short", 80), ["short"]);
});

test("wrapLine: text exactly at width is not split", () => {
  assert.deepEqual(wrapLine("12345", 5), ["12345"]);
});

test("wrapLine: text longer than width is split into width-sized chunks, no characters dropped", () => {
  const text = "a".repeat(203);
  const chunks = wrapLine(text, 80);
  assert.deepEqual(chunks.map((c) => c.length), [80, 80, 43]);
  assert.equal(chunks.join(""), text);
});

test("wrapLine: empty string returns itself, not an empty array (so a blank diff line still renders a row)", () => {
  assert.deepEqual(wrapLine("", 80), [""]);
});

// --- flattenDiffFiles ---------------------------------------------------
//
// Regression coverage for the release-blocking review UI bug an independent
// test pass reported: long changed lines were rendered with `wrap="truncate-end"`
// and only up/down scrolling was implemented, so the hidden tail of a long
// line could never be revealed. The fix hard-wraps every rendered line to
// the box's actual content width *before* it reaches ink, so nothing is
// ever cut off — see DECISIONS.md's "Review diff view: line wrapping instead
// of truncation" entry.

test("flattenDiffFiles: a changed line longer than the given width is wrapped into multiple rows, not truncated", () => {
  const longCondition =
    "  if (!isValidUserSessionToken(token) || hasSessionExpired(token, nowMs) || !userHasRequiredScope(user, \"admin:write\")) {";
  const f = diffFile({
    path: "auth.js",
    insertions: 1,
    deletions: 1,
    hunks: [hunk("@@ -10,1 +10,1 @@", [`+${longCondition}`])],
  });

  const width = 80;
  const rendered = flattenDiffFiles([f], width);
  const addRows = rendered.filter((r) => r.kind === "add");

  // Every row individually fits within the given width...
  for (const row of addRows) {
    assert.ok(row.text.length <= width, `row exceeds width: "${row.text}"`);
  }
  // ...and reassembling all the wrapped rows recovers the exact original
  // line (with its "+" diff marker), proving no trailing text was dropped.
  assert.equal(addRows.map((r) => r.text).join(""), `+${longCondition}`);
  assert.ok(addRows.length > 1, "a line longer than the width must wrap onto more than one row");
});

test("flattenDiffFiles: a short line is not wrapped, and still yields exactly one row", () => {
  const f = diffFile({
    path: "a.js",
    insertions: 1,
    deletions: 0,
    hunks: [hunk("@@ -1,0 +1,1 @@", ["+  const x = 1;"])],
  });
  const rendered = flattenDiffFiles([f], 80);
  const addRows = rendered.filter((r) => r.kind === "add");
  assert.deepEqual(addRows, [{ text: "+  const x = 1;", kind: "add" }]);
});
