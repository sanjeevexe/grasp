import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCapturedDiff, isFileFormattingOnly, matchesIgnorePattern } from "../src/filter";
import { capturedDiff, diffFile, hunk, testConfig } from "./helpers";

// --- matchesIgnorePattern -------------------------------------------------

test("matchesIgnorePattern: trailing-slash pattern matches a directory segment anywhere in the path", () => {
  assert.equal(matchesIgnorePattern("packages/a/node_modules/x.js", "node_modules/"), true);
  assert.equal(matchesIgnorePattern("node_modules/x.js", "node_modules/"), true);
  assert.equal(matchesIgnorePattern("src/node_modules_backup/x.js", "node_modules/"), false);
});

test("matchesIgnorePattern: bare pattern matches exact basename anywhere", () => {
  assert.equal(matchesIgnorePattern("package-lock.json", "package-lock.json"), true);
  assert.equal(matchesIgnorePattern("packages/a/package-lock.json", "package-lock.json"), true);
  assert.equal(matchesIgnorePattern("packages/a/package-lock.json.bak", "package-lock.json"), false);
});

test("matchesIgnorePattern: bare pattern also matches an exact full relative path", () => {
  assert.equal(matchesIgnorePattern(".claude/settings.local.json", ".claude/settings.local.json"), true);
  assert.equal(matchesIgnorePattern("other/.claude/settings.local.json", ".claude/settings.local.json"), false);
});

test("matchesIgnorePattern: no glob support — '**' is matched literally, not as a wildcard", () => {
  assert.equal(matchesIgnorePattern("generated/foo.ts", "generated/**"), false);
  assert.equal(matchesIgnorePattern("generated/foo.ts", "generated/"), true);
});

// --- isFileFormattingOnly -------------------------------------------------

test("isFileFormattingOnly: true when added/removed lines are identical after whitespace normalization", () => {
  const f = diffFile({
    path: "a.ts",
    insertions: 1,
    deletions: 1,
    hunks: [hunk("@@ -1,1 +1,1 @@", ["-  const x = 1;", "+const   x = 1;"])],
  });
  assert.equal(isFileFormattingOnly(f), true);
});

test("isFileFormattingOnly: false when real tokens change, even with matching whitespace", () => {
  const f = diffFile({
    path: "a.ts",
    insertions: 1,
    deletions: 1,
    hunks: [hunk("@@ -1,1 +1,1 @@", ["-const x = 1;", "+const x = 2;"])],
  });
  assert.equal(isFileFormattingOnly(f), false);
});

test("isFileFormattingOnly: false for a genuine reordering of two lines (order matters, not just multiset)", () => {
  const f = diffFile({
    path: "a.ts",
    insertions: 2,
    deletions: 2,
    hunks: [hunk("@@ -1,2 +1,2 @@", ["-line A", "-line B", "+line B", "+line A"])],
  });
  assert.equal(isFileFormattingOnly(f), false);
});

// --- evaluateCapturedDiff --------------------------------------------------

function bigHunk(prefix: "+" | "-", n: number) {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(`${prefix}line ${i}`);
  return hunk(`@@ -1,${n} +1,${n} @@`, lines);
}

test("evaluateCapturedDiff: a normal-sized real change passes", () => {
  const config = testConfig();
  const diff = capturedDiff([
    diffFile({ path: "src/app.ts", insertions: 20, deletions: 5, hunks: [bigHunk("+", 20)] }),
  ]);
  const result = evaluateCapturedDiff(diff, config);
  assert.equal(result.passed, true);
  assert.equal(result.significantFiles.length, 1);
});

test("evaluateCapturedDiff: baseline-ignored lockfile is filtered even with a big diff", () => {
  const config = testConfig();
  const diff = capturedDiff([
    diffFile({ path: "package-lock.json", insertions: 50, deletions: 50, hunks: [bigHunk("+", 50)] }),
  ]);
  const result = evaluateCapturedDiff(diff, config);
  assert.equal(result.passed, false);
  assert.equal(result.reason, "baseline_ignore");
});

test("evaluateCapturedDiff: user-configured ignorePatterns filters a matching path", () => {
  const config = testConfig({ ignorePatterns: ["generated/"] });
  const diff = capturedDiff([
    diffFile({ path: "generated/schema.ts", insertions: 20, deletions: 0, hunks: [bigHunk("+", 20)] }),
  ]);
  const result = evaluateCapturedDiff(diff, config);
  assert.equal(result.passed, false);
  assert.equal(result.reason, "user_ignore_pattern");
});

test("evaluateCapturedDiff: a diff below the per-file minimum is filtered", () => {
  const config = testConfig();
  const diff = capturedDiff([
    diffFile({ path: "src/app.ts", insertions: 1, deletions: 1, hunks: [hunk("@@ -1,1 +1,1 @@", ["-a", "+b"])] }),
  ]);
  const result = evaluateCapturedDiff(diff, config);
  assert.equal(result.passed, false);
  assert.equal(result.reason, "below_min_threshold");
});

test("evaluateCapturedDiff: multi-file diff passes if ANY file individually clears the minimum (not a sum across files)", () => {
  const config = testConfig();
  const diff = capturedDiff([
    diffFile({ path: "a.ts", insertions: 1, deletions: 0, hunks: [hunk("@@ -1,1 +1,1 @@", ["+x"])] }),
    diffFile({ path: "b.ts", insertions: 10, deletions: 0, hunks: [bigHunk("+", 10)] }),
  ]);
  const result = evaluateCapturedDiff(diff, config);
  assert.equal(result.passed, true);
  assert.equal(result.significantFiles.length, 2);
});

test("evaluateCapturedDiff: a single file over the per-file max is filtered", () => {
  const config = testConfig({ diffThresholds: { minChangedLines: 3, maxTotalChangedLines: 1500, maxSingleFileChangedLines: 50 } });
  const diff = capturedDiff([
    diffFile({ path: "huge.ts", insertions: 100, deletions: 0, hunks: [bigHunk("+", 100)] }),
  ]);
  const result = evaluateCapturedDiff(diff, config);
  assert.equal(result.passed, false);
  assert.equal(result.reason, "above_max_threshold");
});

test("evaluateCapturedDiff: total changed lines over the max is filtered even if no single file crosses the per-file cap", () => {
  const config = testConfig({ diffThresholds: { minChangedLines: 3, maxTotalChangedLines: 30, maxSingleFileChangedLines: 800 } });
  const diff = capturedDiff([
    diffFile({ path: "a.ts", insertions: 20, deletions: 0, hunks: [bigHunk("+", 20)] }),
    diffFile({ path: "b.ts", insertions: 20, deletions: 0, hunks: [bigHunk("+", 20)] }),
  ]);
  const result = evaluateCapturedDiff(diff, config);
  assert.equal(result.passed, false);
  assert.equal(result.reason, "above_max_threshold");
});

test("evaluateCapturedDiff: formatting-only file is filtered, independent of size thresholds", () => {
  const config = testConfig();
  const lines: string[] = [];
  for (let i = 0; i < 20; i++) lines.push(`-  const x${i} = ${i};`);
  for (let i = 0; i < 20; i++) lines.push(`+const   x${i} = ${i};`);
  const diff = capturedDiff([
    diffFile({ path: "a.ts", insertions: 20, deletions: 20, hunks: [hunk("@@ -1,20 +1,20 @@", lines)] }),
  ]);
  const result = evaluateCapturedDiff(diff, config);
  assert.equal(result.passed, false);
  assert.equal(result.reason, "formatting_only");
});

test("evaluateCapturedDiff: a diff touching only Grasp's own hook config files is filtered (baseline)", () => {
  const config = testConfig();
  const diff = capturedDiff([
    diffFile({ path: ".grasp.json", insertions: 5, deletions: 0, hunks: [bigHunk("+", 5)] }),
    diffFile({ path: ".claude/settings.local.json", insertions: 20, deletions: 0, hunks: [bigHunk("+", 20)] }),
  ]);
  const result = evaluateCapturedDiff(diff, config);
  assert.equal(result.passed, false);
  assert.equal(result.reason, "baseline_ignore");
});
