/**
 * Config load, merge, security, and `grasp set`.  GOVERNED BY: §16.3, §18, §22.2
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import {
  PER_REPO_CONFIG_NAME,
  deepMerge,
  loadConfig,
  saveConfig,
  type ConfigWithUnknown,
} from "../src/config/config.js";
import { configKeyPaths, parseConfigValue, setConfigValue } from "../src/config/set.js";

let dir: string;
let globalFile: string;
let projectRoot: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-config-"));
  globalFile = path.join(dir, "config.json");
  projectRoot = path.join(dir, "repo");
  fs.mkdirSync(projectRoot);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeGlobal(value: unknown): void {
  fs.writeFileSync(globalFile, JSON.stringify(value));
}

function writePerRepo(value: unknown): void {
  fs.writeFileSync(path.join(projectRoot, PER_REPO_CONFIG_NAME), JSON.stringify(value));
}

describe("loading and merging (§18.1)", () => {
  it("returns defaults when nothing exists", () => {
    const { config, warnings } = loadConfig({ globalFile });
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toEqual([]);
  });

  it("deep-merges a per-repo file over global", () => {
    writeGlobal({ debounceMs: 1000, decayWindows: { trace: 30 } });
    writePerRepo({ decayWindows: { reconstruct: 5 } });

    const { config } = loadConfig({ globalFile, projectRoot });
    expect(config.debounceMs).toBe(1000);
    // Nested keys merge rather than replacing the whole object.
    expect(config.decayWindows).toEqual({ trace: 30, predictBreak: 60, reconstruct: 5 });
  });

  it("replaces arrays wholesale rather than concatenating", () => {
    writePerRepo({ ignorePatterns: ["**/only-this/**"] });
    const { config } = loadConfig({ globalFile, projectRoot });
    expect(config.ignorePatterns).toEqual(["**/only-this/**"]);
  });

  it("ignores a per-repo file in an unregistered directory", () => {
    writePerRepo({ debounceMs: 99 });
    const { config } = loadConfig({ globalFile });
    expect(config.debounceMs).toBe(DEFAULT_CONFIG.debounceMs);
  });

  it("deepMerge leaves the base untouched", () => {
    const base = { a: { b: 1 } };
    const merged = deepMerge(base, { a: { c: 2 } });
    expect(merged).toEqual({ a: { b: 1, c: 2 } });
    expect(base).toEqual({ a: { b: 1 } });
  });
});

describe("per-repo security (§18.2)", () => {
  it("IGNORES apiKey from a per-repo config and warns loudly", () => {
    writeGlobal({ apiKey: "global-test-key" });
    writePerRepo({ apiKey: "repo-key-that-must-be-ignored", debounceMs: 2000 });

    const { config, warnings } = loadConfig({ globalFile, projectRoot });
    // The global key survives; the committed one never reaches the config.
    expect(config.apiKey).toBe("global-test-key");
    expect(JSON.stringify(config)).not.toContain("must-be-ignored");
    // Other keys in the same file still apply — only apiKey is dropped.
    expect(config.debounceMs).toBe(2000);
    expect(warnings.join(" ")).toMatch(/IGNORING apiKey/);
    expect(warnings.join(" ")).toMatch(/§18\.2/);
  });

  it("does not warn when the per-repo file has no apiKey", () => {
    writePerRepo({ gateMode: "warn" });
    const { warnings } = loadConfig({ globalFile, projectRoot });
    expect(warnings.join(" ")).not.toMatch(/apiKey/);
  });
});

describe("corrupt config (§16.3)", () => {
  it("backs up, replaces with defaults, warns, and does not throw", () => {
    fs.writeFileSync(globalFile, "{ this is not json");
    const { config, warnings } = loadConfig({ globalFile });

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(fs.existsSync(`${globalFile}.bak`)).toBe(true);
    expect(fs.readFileSync(`${globalFile}.bak`, "utf8")).toBe("{ this is not json");
    expect(warnings.join(" ")).toMatch(/unparseable/);
    // The replacement on disk is valid, so the next run is clean.
    expect(JSON.parse(fs.readFileSync(globalFile, "utf8"))).toEqual(DEFAULT_CONFIG);
  });

  it("treats a non-object config as corrupt", () => {
    fs.writeFileSync(globalFile, "[1, 2, 3]");
    expect(loadConfig({ globalFile }).config).toEqual(DEFAULT_CONFIG);
  });

  it("skips an unparseable per-repo file without touching it", () => {
    const perRepo = path.join(projectRoot, PER_REPO_CONFIG_NAME);
    fs.writeFileSync(perRepo, "nope");
    const { config, warnings } = loadConfig({ globalFile, projectRoot });
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings.join(" ")).toMatch(/ignoring unparseable/);
    // It belongs to the repo, not to Grasp — no .bak, no rewrite.
    expect(fs.existsSync(`${perRepo}.bak`)).toBe(false);
    expect(fs.readFileSync(perRepo, "utf8")).toBe("nope");
  });
});

describe("unknown keys (§16.3)", () => {
  it("preserves them on write and warns once", () => {
    writeGlobal({ fromANewerGrasp: true, debounceMs: 500 });
    const { config, warnings } = loadConfig({ globalFile });
    expect((config as Record<string, unknown>).fromANewerGrasp).toBe(true);
    expect(warnings.join(" ")).toMatch(/unknown config key\(s\).*fromANewerGrasp/);

    saveConfig(config, globalFile);
    expect(JSON.parse(fs.readFileSync(globalFile, "utf8")).fromANewerGrasp).toBe(true);
  });
});

describe("saving (§6.3)", () => {
  it("writes mode 0600 because the file can hold an API key", () => {
    saveConfig({ ...DEFAULT_CONFIG, apiKey: "test-api-key" } as ConfigWithUnknown, globalFile);
    const mode = fs.statSync(globalFile).mode & 0o777;
    // Best-effort on Windows; POSIX must be exact.
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  it("round-trips through load", () => {
    saveConfig({ ...DEFAULT_CONFIG, maxQuestionsPerHour: 3 } as ConfigWithUnknown, globalFile);
    expect(loadConfig({ globalFile }).config.maxQuestionsPerHour).toBe(3);
  });
});

describe("grasp set (§18.3)", () => {
  const base = DEFAULT_CONFIG as ConfigWithUnknown;

  it("sets a nested numeric key by dot-notation", () => {
    const result = setConfigValue(base, "decayWindows.trace", "120");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.decayWindows.trace).toBe(120);
      // The original is untouched.
      expect(base.decayWindows.trace).toBe(90);
    }
  });

  it("rejects an unknown key", () => {
    const result = setConfigValue(base, "decayWindows.nope", "1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown config key/);
  });

  it("rejects a wrong type rather than writing it", () => {
    expect(parseConfigValue("debounceMs", "soon").ok).toBe(false);
    expect(parseConfigValue("maxFilesPerBatch", "-5").ok).toBe(false);
    expect(parseConfigValue("ignorePatterns", "not-an-array").ok).toBe(false);
  });

  it("rejects an invalid enum value", () => {
    expect(parseConfigValue("gateMode", "strict").ok).toBe(false);
    expect(parseConfigValue("gateMode", "hard").ok).toBe(true);
    expect(parseConfigValue("provider", "openai").ok).toBe(false);
    expect(parseConfigValue("provider", "claude-cli").ok).toBe(true);
  });

  it("accepts null only where §18.1 marks a key nullable", () => {
    expect(parseConfigValue("questionStaleDays", "null")).toEqual({ ok: true, value: null });
    expect(parseConfigValue("notifications.snoozeUntil", "null")).toEqual({
      ok: true,
      value: null,
    });
    expect(parseConfigValue("debounceMs", "null").ok).toBe(false);
  });

  it("refuses to set a whole group and names a real child key", () => {
    const result = parseConfigValue("decayWindows", "{}");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/decayWindows\.trace/);
  });

  it("exposes every leaf key as a settable path", () => {
    const paths = configKeyPaths().map((entry) => entry.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "model",
        "provider",
        "decayWindows.predictBreak",
        "synthesisTrigger.minDiffCount",
        "notifications.batching",
        "diffSizeThreshold.minLines",
      ]),
    );
    expect(paths).not.toContain("decayWindows");
  });

  it("parses a JSON array for ignorePatterns", () => {
    const result = setConfigValue(base, "ignorePatterns", '["**/vendor/**"]');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.ignorePatterns).toEqual(["**/vendor/**"]);
  });
});

describe("review keybindings (§14.4, §18.1)", () => {
  const base = DEFAULT_CONFIG as ConfigWithUnknown;

  it("ships defaults that are settable by dot-notation", () => {
    expect(base.review.keys.hint).toBe("ctrl+t");
    const result = setConfigValue(base, "review.keys.hint", "ctrl+y");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.review.keys.hint).toBe("ctrl+y");
  });

  it("normalizes case and spacing", () => {
    expect(parseConfigValue("review.keys.hint", "Ctrl+Y")).toEqual({ ok: true, value: "ctrl+y" });
    expect(parseConfigValue("review.keys.hint", " ctrl + y ")).toEqual({
      ok: true,
      value: "ctrl+y",
    });
  });

  it.each([
    ["ctrl+h", /Backspace/],
    ["ctrl+i", /Tab/],
    ["ctrl+j", /Enter/],
    ["ctrl+m", /Return/],
    ["ctrl+s", /freeze your terminal/],
    ["ctrl+q", /flow control/],
    ["ctrl+z", /suspends/],
  ])("rejects the reserved %s and says why", (binding, reason) => {
    const result = parseConfigValue("review.keys.skip", binding);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(reason);
  });

  it("rejects a bare letter, because letters are answer text", () => {
    const result = parseConfigValue("review.keys.hint", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/letters are answer text/);
  });

  it("rejects a duplicate binding and names the action that holds it", () => {
    // ctrl+e is already explain.
    const result = setConfigValue(base, "review.keys.hint", "ctrl+e");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already bound to "explain"/);
  });

  it("lets an action keep its own binding rather than calling it a duplicate", () => {
    expect(setConfigValue(base, "review.keys.hint", "ctrl+t").ok).toBe(true);
  });

  it("reserves Ctrl+C for quit", () => {
    expect(parseConfigValue("review.keys.skip", "ctrl+c").ok).toBe(false);
    expect(parseConfigValue("review.keys.quit", "ctrl+c").ok).toBe(true);
  });

  it("falls back and warns for a hand-edited config that is unusable", () => {
    writeGlobal({
      review: { keys: { hint: "ctrl+s", explain: "nonsense", deeper: "ctrl+k" } },
    });
    const { config, warnings } = loadConfig({ globalFile });

    // Reserved → default, and the reason is explained.
    expect(config.review.keys.hint).toBe("ctrl+t");
    expect(warnings.join(" ")).toMatch(/Ctrl\+S cannot be bound/);
    // Malformed → default.
    expect(config.review.keys.explain).toBe("ctrl+e");
    // An explicit binding that lands on another action's default wins, and the
    // displaced action is left unbound rather than silently sharing the key.
    expect(config.review.keys.deeper).toBe("ctrl+k");
    expect(config.review.keys.breakdown).toBe("");
    expect(warnings.join(" ")).toMatch(/"breakdown" has no key/);
    expect(warnings.join(" ")).toMatch(/grasp set review\.keys\.breakdown/);
  });

  it("keeps a valid custom map intact", () => {
    writeGlobal({ review: { keys: { hint: "ctrl+y", skip: "ctrl+p" } } });
    const { config, warnings } = loadConfig({ globalFile });
    expect(config.review.keys.hint).toBe("ctrl+y");
    expect(config.review.keys.skip).toBe("ctrl+p");
    expect(config.review.keys.explain).toBe("ctrl+e");
    expect(warnings).toEqual([]);
  });
});
