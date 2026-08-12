import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { deepMerge, DEFAULT_CONFIG, ensureGlobalConfigFile, loadConfig } from "../src/config";

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- deepMerge ---------------------------------------------------------------

test("deepMerge: plain objects merge key-by-key", () => {
  const merged = deepMerge({ a: 1, b: { x: 1, y: 2 } }, { b: { y: 99 } });
  assert.deepEqual(merged, { a: 1, b: { x: 1, y: 99 } });
});

test("deepMerge: arrays REPLACE wholesale, never concatenate", () => {
  const merged = deepMerge({ ignorePatterns: ["a", "b"] }, { ignorePatterns: ["c"] });
  assert.deepEqual(merged.ignorePatterns, ["c"]);
});

test("deepMerge: an override key with undefined value doesn't clobber the base value", () => {
  const merged = deepMerge<{ a: number; b?: number }>({ a: 1, b: 2 }, { b: undefined });
  assert.equal(merged.b, 2);
});

test("deepMerge: a non-plain-object override (e.g. null) returns base unchanged", () => {
  const base = { a: 1 };
  assert.deepEqual(deepMerge(base, null), base);
  assert.deepEqual(deepMerge(base, "not an object"), base);
});

// --- ensureGlobalConfigFile / loadConfig, against a temp $HOME-equivalent --

test("ensureGlobalConfigFile: creates the file with defaults on first run", () => {
  const graspHome = mkTempDir("grasp-test-home-");
  const globalConfigPath = path.join(graspHome, "config.json");
  const config = ensureGlobalConfigFile(globalConfigPath, graspHome);
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal(fs.existsSync(globalConfigPath), true);
  const onDisk = JSON.parse(fs.readFileSync(globalConfigPath, "utf-8"));
  assert.deepEqual(onDisk, DEFAULT_CONFIG);
});

test("ensureGlobalConfigFile: never overwrites an existing file, even a customized one", () => {
  const graspHome = mkTempDir("grasp-test-home-");
  const globalConfigPath = path.join(graspHome, "config.json");
  fs.mkdirSync(graspHome, { recursive: true });
  fs.writeFileSync(globalConfigPath, JSON.stringify({ gateMode: "hard" }), "utf-8");
  const config = ensureGlobalConfigFile(globalConfigPath, graspHome);
  assert.equal(config.gateMode, "hard");
  // Everything NOT overridden still comes from defaults via deepMerge.
  assert.equal(config.questionsPerSessionCap, DEFAULT_CONFIG.questionsPerSessionCap);
});

test("ensureGlobalConfigFile: throws a clear error on malformed JSON, never silently regenerates", () => {
  const graspHome = mkTempDir("grasp-test-home-");
  const globalConfigPath = path.join(graspHome, "config.json");
  fs.mkdirSync(graspHome, { recursive: true });
  fs.writeFileSync(globalConfigPath, "{ not valid json", "utf-8");
  assert.throws(() => ensureGlobalConfigFile(globalConfigPath, graspHome), /not valid JSON/);
});

test("loadConfig: repo-level .grasp.json values win over global on conflict", () => {
  const graspHome = mkTempDir("grasp-test-home-");
  const globalConfigPath = path.join(graspHome, "config.json");
  const repoRoot = mkTempDir("grasp-test-repo-");
  fs.writeFileSync(path.join(repoRoot, ".grasp.json"), JSON.stringify({ gateMode: "hard", questionsPerSessionCap: 2 }), "utf-8");

  const loaded = loadConfig(repoRoot, globalConfigPath, graspHome);
  assert.equal(loaded.config.gateMode, "hard");
  assert.equal(loaded.config.questionsPerSessionCap, 2);
  // Untouched settings still come from the (default) global config.
  assert.deepEqual(loaded.config.ignorePatterns, DEFAULT_CONFIG.ignorePatterns);
  assert.equal(loaded.repoConfigPath, path.join(repoRoot, ".grasp.json"));
});

test("loadConfig: a repo with no .grasp.json falls back to global config alone", () => {
  const graspHome = mkTempDir("grasp-test-home-");
  const globalConfigPath = path.join(graspHome, "config.json");
  const repoRoot = mkTempDir("grasp-test-repo-");

  const loaded = loadConfig(repoRoot, globalConfigPath, graspHome);
  assert.deepEqual(loaded.config, DEFAULT_CONFIG);
  assert.equal(loaded.repoConfigPath, null);
});

test("loadConfig: two different repos under the same global config get independent overrides", () => {
  const graspHome = mkTempDir("grasp-test-home-");
  const globalConfigPath = path.join(graspHome, "config.json");
  const repoA = mkTempDir("grasp-test-repo-a-");
  const repoB = mkTempDir("grasp-test-repo-b-");
  fs.writeFileSync(path.join(repoA, ".grasp.json"), JSON.stringify({ ignorePatterns: ["only-in-a/"] }), "utf-8");

  const loadedA = loadConfig(repoA, globalConfigPath, graspHome);
  const loadedB = loadConfig(repoB, globalConfigPath, graspHome);
  assert.deepEqual(loadedA.config.ignorePatterns, ["only-in-a/"]);
  assert.deepEqual(loadedB.config.ignorePatterns, []);
});

// --- Config schema validation ------------------------------------------
//
// Regression coverage for a bug an independent test pass found: a
// syntactically valid config with the WRONG field type (e.g.
// `"ignorePatterns": "scripts/"`, a string instead of an array) used to
// pass straight through to `Array.prototype.some` deep inside the filter
// and crash there — well past the point of a clear, attributable error,
// and (before the checkpoint-claim rewrite) after a diff-losing checkpoint
// advance had already happened. loadConfig now validates each present
// key's type/enum/range at load time, the same "throw a clear error, never
// silently coerce" policy already used for malformed JSON.

function repoWithConfig(overrideJson: string): string {
  const repoRoot = mkTempDir("grasp-test-repo-");
  fs.writeFileSync(path.join(repoRoot, ".grasp.json"), overrideJson, "utf-8");
  return repoRoot;
}

test("loadConfig: rejects ignorePatterns of the wrong type instead of crashing downstream", () => {
  const graspHome = mkTempDir("grasp-test-home-");
  const globalConfigPath = path.join(graspHome, "config.json");
  const repoRoot = repoWithConfig(JSON.stringify({ ignorePatterns: "scripts/" }));
  assert.throws(() => loadConfig(repoRoot, globalConfigPath, graspHome), /ignorePatterns must be an array of strings/);
});

test("loadConfig: rejects an invalid gateMode value instead of silently treating it as soft", () => {
  const graspHome = mkTempDir("grasp-test-home-");
  const globalConfigPath = path.join(graspHome, "config.json");
  const repoRoot = repoWithConfig(JSON.stringify({ gateMode: "hadr" }));
  assert.throws(() => loadConfig(repoRoot, globalConfigPath, graspHome), /gateMode must be one of/);
});

// Regression coverage for the reliability rework's removal of the
// dollar-cost cap (see DECISIONS.md's "Remove costCapUsd and the
// unknown-cost-halt mechanism" entry): an old config file with this key
// left over from before the removal must fail with a message that says
// what changed, not just a generic "unknown config key" — someone upgrading
// shouldn't have to guess why a key that used to work no longer does.

test("loadConfig: rejects a costCapUsd key with a specific removal message, not just 'unknown key'", () => {
  const graspHome = mkTempDir("grasp-test-home-");
  const globalConfigPath = path.join(graspHome, "config.json");
  const repoRoot = repoWithConfig(JSON.stringify({ costCapUsd: 0.25 }));
  assert.throws(
    () => loadConfig(repoRoot, globalConfigPath, graspHome),
    /costCapUsd was removed — Grasp no longer enforces a dollar-cost cap/
  );
});

test("loadConfig: rejects a non-integer questionsPerSessionCap", () => {
  const graspHome = mkTempDir("grasp-test-home-");
  const globalConfigPath = path.join(graspHome, "config.json");
  const repoRoot = repoWithConfig(JSON.stringify({ questionsPerSessionCap: 2.5 }));
  assert.throws(() => loadConfig(repoRoot, globalConfigPath, graspHome), /questionsPerSessionCap must be a positive integer/);
});

test("loadConfig: rejects a malformed diffThresholds field", () => {
  const graspHome = mkTempDir("grasp-test-home-");
  const globalConfigPath = path.join(graspHome, "config.json");
  const repoRoot = repoWithConfig(JSON.stringify({ diffThresholds: { minChangedLines: "three" } }));
  assert.throws(() => loadConfig(repoRoot, globalConfigPath, graspHome), /diffThresholds\.minChangedLines must be a non-negative number/);
});

// Regression coverage for a bug an independent test pass found: a
// misspelled key (e.g. "gateMod" instead of "gateMode") used to be silently
// accepted — deepMerge only reads keys it recognizes, so the typo'd key was
// retained as inert dead data while the real gateMode silently stayed at
// its default ("soft"), leaving the user believing hard-gating was enabled
// when it wasn't. Unknown keys are now rejected at load time like every
// other invalid value.

test("loadConfig: rejects an unknown top-level key instead of silently ignoring it (typo'd gateMode)", () => {
  const graspHome = mkTempDir("grasp-test-home-");
  const globalConfigPath = path.join(graspHome, "config.json");
  const repoRoot = repoWithConfig(JSON.stringify({ gateMod: "hard" }));
  assert.throws(() => loadConfig(repoRoot, globalConfigPath, graspHome), /unknown config key "gateMod"/);
});

test("loadConfig: rejects an unknown nested diffThresholds key", () => {
  const graspHome = mkTempDir("grasp-test-home-");
  const globalConfigPath = path.join(graspHome, "config.json");
  const repoRoot = repoWithConfig(JSON.stringify({ diffThresholds: { minChangedLinez: 5 } }));
  assert.throws(() => loadConfig(repoRoot, globalConfigPath, graspHome), /unknown diffThresholds key "minChangedLinez"/);
});

test("loadConfig: a fully valid override with every key set still passes", () => {
  const graspHome = mkTempDir("grasp-test-home-");
  const globalConfigPath = path.join(graspHome, "config.json");
  const repoRoot = repoWithConfig(
    JSON.stringify({
      gateMode: "hard",
      ignorePatterns: ["a/", "b.txt"],
      questionsPerSessionCap: 3,
      diffThresholds: { minChangedLines: 1, maxTotalChangedLines: 100, maxSingleFileChangedLines: 50 },
    })
  );
  const loaded = loadConfig(repoRoot, globalConfigPath, graspHome);
  assert.equal(loaded.config.gateMode, "hard");
  assert.equal(loaded.config.questionsPerSessionCap, 3);
});
