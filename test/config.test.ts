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
  assert.equal(config.costCapUsd, DEFAULT_CONFIG.costCapUsd);
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
  assert.equal(loaded.config.costCapUsd, DEFAULT_CONFIG.costCapUsd);
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
