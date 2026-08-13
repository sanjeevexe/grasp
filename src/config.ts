import * as fs from "fs";
import * as path from "path";
import { GLOBAL_CONFIG_PATH, GRASP_HOME, REPO_CONFIG_FILENAME } from "./paths";
import { GraspConfig } from "./types";

export const DEFAULT_CONFIG: GraspConfig = {
  gateMode: "soft",
  ignorePatterns: [],
  questionsPerSessionCap: 8,
  diffThresholds: {
    minChangedLines: 3,
    maxTotalChangedLines: 1500,
    maxSingleFileChangedLines: 800,
  },
  difficultyMode: "medium",
  scanQuestionsCap: 15,
};

export interface LoadedConfig {
  config: GraspConfig;
  globalConfigPath: string;
  repoConfigPath: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively merges `override` onto `base`. Plain objects merge key-by-key;
 * arrays and primitives are replaced wholesale (a repo's `ignorePatterns`
 * override replaces the global list rather than concatenating with it —
 * see DECISIONS.md's config-merge-semantics entry). Exported (not just used
 * internally) so the test suite can exercise the merge/precedence logic
 * directly — see DECISIONS.md's "automated test suite" entry.
 */
export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(override)) return base;
  const result: any = { ...(base as any) };
  for (const key of Object.keys(override)) {
    const overrideValue = (override as Record<string, unknown>)[key];
    const baseValue = (base as any)[key];
    if (overrideValue === undefined) continue;
    if (isPlainObject(overrideValue) && isPlainObject(baseValue)) {
      result[key] = deepMerge(baseValue, overrideValue);
    } else {
      result[key] = overrideValue;
    }
  }
  return result as T;
}

function readJsonFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Grasp: ${filePath} exists but is not valid JSON (${(err as Error).message}). ` +
        `Fix or remove it manually — Grasp will not overwrite a file it can't parse.`
    );
  }
}

const GATE_MODES = ["soft", "hard"] as const;

const DIFFICULTY_MODES = ["easy", "medium", "hard"] as const;

const KNOWN_TOP_LEVEL_KEYS = [
  "gateMode",
  "ignorePatterns",
  "questionsPerSessionCap",
  "diffThresholds",
  "difficultyMode",
  "scanQuestionsCap",
] as const;

/**
 * `costCapUsd` was removed (see DECISIONS.md's "Remove costCapUsd and the
 * unknown-cost-halt mechanism" entry): a single timed-out generation call
 * used to permanently and silently halt all further generation for that
 * session the moment its true cost became unknowable, indistinguishably
 * from a real cap hit. Generation is now batched-at-Stop with retry instead
 * (see the same entry), which removes the multi-call queuing that caused
 * the timeout in the first place — `questionsPerSessionCap` is the sole
 * remaining safety rail. An old config file with this key would otherwise
 * just fail the generic "unknown config key" check below, which is correct
 * but unhelpfully vague for a key that used to be real and meaningful — this
 * gets its own message instead.
 */
const REMOVED_TOP_LEVEL_KEYS: Record<string, string> = {
  costCapUsd:
    "costCapUsd was removed — Grasp no longer enforces a dollar-cost cap on generation (see README.md/DECISIONS.md). questionsPerSessionCap is now the sole generation safety rail. Delete this key from your config file.",
};

const KNOWN_DIFF_THRESHOLD_KEYS = [
  "minChangedLines",
  "maxTotalChangedLines",
  "maxSingleFileChangedLines",
] as const;

/**
 * Validates the *shape* of an override object read from a config file —
 * each key present must have the right type/enum/range, not just be valid
 * JSON. Only checks keys that are actually present (this validates a
 * partial override, not a fully-merged GraspConfig — `DEFAULT_CONFIG`
 * itself is always valid and never runs through this).
 *
 * Found by an independent test pass: a syntactically valid config with the
 * wrong field type (e.g. `"ignorePatterns": "scripts/"` instead of an
 * array) previously reached `Array.prototype.some` deep inside the filter
 * and crashed there — well past the point where a clear, attributable error
 * could be shown, and (before `checkAndCapture`'s atomic-transaction
 * rewrite) after the checkpoint had already advanced, permanently losing
 * the diff that triggered it. Validating here, at load time, with the same
 * "throw a clear error, never silently coerce or drop the value" policy
 * already used for malformed JSON, catches it at the actual source instead.
 * See DECISIONS.md's "Config schema validation" entry.
 */
function validateConfigOverride(value: unknown, filePath: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`Grasp: ${filePath} must contain a JSON object at its top level.`);
  }

  const errors: string[] = [];

  // Found by an independent test pass: a typo'd key (e.g. "gateMod" instead
  // of "gateMode") was silently accepted and ignored — `deepMerge` only ever
  // reads keys it recognizes off the override object, so a misspelled cap,
  // threshold, or gate-mode key left the user believing their override took
  // effect (it's sitting right there in the file they wrote) while Grasp
  // silently kept running on the default. That's a safety-relevant silent
  // failure specifically for `gateMode`/the cap fields, not just a cosmetic
  // one, so unknown keys are rejected here with the same "throw a clear
  // error, never silently ignore" posture as every other validation in this
  // function, rather than merely warned about. See DECISIONS.md's "Unknown
  // config keys are rejected, not silently ignored" entry.
  for (const key of Object.keys(value)) {
    if (key in REMOVED_TOP_LEVEL_KEYS) {
      errors.push(REMOVED_TOP_LEVEL_KEYS[key]);
      continue;
    }
    if (!(KNOWN_TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      errors.push(
        `unknown config key ${JSON.stringify(key)} (did you mean one of: ${KNOWN_TOP_LEVEL_KEYS.join(", ")}?)`
      );
    }
  }

  if (value.gateMode !== undefined && !GATE_MODES.includes(value.gateMode as any)) {
    errors.push(`gateMode must be one of ${GATE_MODES.map((m) => `"${m}"`).join(" | ")}, got ${JSON.stringify(value.gateMode)}`);
  }

  if (value.ignorePatterns !== undefined) {
    const isStringArray = Array.isArray(value.ignorePatterns) && value.ignorePatterns.every((p) => typeof p === "string");
    if (!isStringArray) {
      errors.push(`ignorePatterns must be an array of strings, got ${JSON.stringify(value.ignorePatterns)}`);
    }
  }

  if (value.questionsPerSessionCap !== undefined) {
    if (!Number.isInteger(value.questionsPerSessionCap) || (value.questionsPerSessionCap as number) < 1) {
      errors.push(`questionsPerSessionCap must be a positive integer, got ${JSON.stringify(value.questionsPerSessionCap)}`);
    }
  }

  if (value.scanQuestionsCap !== undefined) {
    if (!Number.isInteger(value.scanQuestionsCap) || (value.scanQuestionsCap as number) < 1) {
      errors.push(`scanQuestionsCap must be a positive integer, got ${JSON.stringify(value.scanQuestionsCap)}`);
    }
  }

  if (value.difficultyMode !== undefined && !DIFFICULTY_MODES.includes(value.difficultyMode as any)) {
    errors.push(
      `difficultyMode must be one of ${DIFFICULTY_MODES.map((m) => `"${m}"`).join(" | ")}, got ${JSON.stringify(value.difficultyMode)}`
    );
  }

  if (value.diffThresholds !== undefined) {
    if (!isPlainObject(value.diffThresholds)) {
      errors.push(`diffThresholds must be an object, got ${JSON.stringify(value.diffThresholds)}`);
    } else {
      for (const key of Object.keys(value.diffThresholds)) {
        if (!(KNOWN_DIFF_THRESHOLD_KEYS as readonly string[]).includes(key)) {
          errors.push(
            `unknown diffThresholds key ${JSON.stringify(key)} (did you mean one of: ${KNOWN_DIFF_THRESHOLD_KEYS.join(", ")}?)`
          );
        }
      }
      for (const key of KNOWN_DIFF_THRESHOLD_KEYS) {
        const fieldValue = (value.diffThresholds as Record<string, unknown>)[key];
        if (fieldValue === undefined) continue;
        if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue) || fieldValue < 0) {
          errors.push(`diffThresholds.${key} must be a non-negative number, got ${JSON.stringify(fieldValue)}`);
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Grasp: ${filePath} has invalid config value(s):\n` +
        errors.map((e) => `  - ${e}`).join("\n") +
        `\nFix the file manually — Grasp will not overwrite a file it can't validate.`
    );
  }
}

function readAndValidateConfigFile(filePath: string): Record<string, unknown> {
  const parsed = readJsonFile(filePath);
  validateConfigOverride(parsed, filePath);
  return parsed;
}

/**
 * Reads the global config, creating it with defaults on first run.
 * Never overwrites an existing (even malformed) file. `globalConfigPath`/
 * `graspHome` default to the real `~/.grasp` locations for every production
 * call site (none of them pass these) — the parameters exist solely so the
 * test suite can point this at a temp directory instead of touching a real
 * user's `~/.grasp`, without changing behavior for anyone else. See
 * DECISIONS.md's "automated test suite" entry.
 */
export function ensureGlobalConfigFile(
  globalConfigPath: string = GLOBAL_CONFIG_PATH,
  graspHome: string = GRASP_HOME
): GraspConfig {
  fs.mkdirSync(graspHome, { recursive: true });
  if (!fs.existsSync(globalConfigPath)) {
    fs.writeFileSync(
      globalConfigPath,
      JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n",
      "utf-8"
    );
    return structuredClone(DEFAULT_CONFIG);
  }
  const parsed = readAndValidateConfigFile(globalConfigPath);
  return deepMerge(DEFAULT_CONFIG, parsed);
}

/**
 * Loads the effective config for a given repo root: global config
 * deep-merged with an optional `.grasp.json` in that directory, with
 * repo-level values winning on conflict. Only looks in `repoRoot` itself —
 * it does not walk up parent directories looking for a repo/git root
 * (see DECISIONS.md's repo-config-resolution entry). `globalConfigPath`/
 * `graspHome` are the same test-only injection points as
 * `ensureGlobalConfigFile` above — every production call site omits them.
 */
export function loadConfig(
  repoRoot: string = process.cwd(),
  globalConfigPath: string = GLOBAL_CONFIG_PATH,
  graspHome: string = GRASP_HOME
): LoadedConfig {
  const globalConfig = ensureGlobalConfigFile(globalConfigPath, graspHome);
  const repoConfigPath = path.join(repoRoot, REPO_CONFIG_FILENAME);

  if (!fs.existsSync(repoConfigPath)) {
    return { config: globalConfig, globalConfigPath, repoConfigPath: null };
  }

  const repoOverride = readAndValidateConfigFile(repoConfigPath);
  const merged = deepMerge(globalConfig, repoOverride);
  return { config: merged, globalConfigPath, repoConfigPath };
}

/**
 * Reads an existing config file (if present) as a plain object, sets a
 * single top-level key, re-validates the WHOLE resulting object through
 * `validateConfigOverride`, and writes it back — preserving every other key
 * already in the file untouched. Used by `grasp set mode/gate/questions-cap`
 * for both the global and repo-scoped case, per the shared read-modify-write
 * contract those commands need (see DECISIONS.md's "grasp set: read-modify-
 * write config path" entry). Re-validating the full object (not just the
 * changed key) means a file with a pre-existing invalid value elsewhere is
 * caught here too, same as any other config load — it never gets silently
 * written back over.
 */
export function setConfigValue(filePath: string, key: string, value: unknown): void {
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    existing = readAndValidateConfigFile(filePath);
  }
  const updated: Record<string, unknown> = { ...existing, [key]: value };
  validateConfigOverride(updated, filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
}

/**
 * Resets global config back to `DEFAULT_CONFIG`, same shape/contents
 * `ensureGlobalConfigFile` writes on a genuine first run. Overwrites
 * unconditionally (unlike `ensureGlobalConfigFile`, which never touches an
 * existing file) — this IS the reset action.
 */
export function resetGlobalConfigFile(
  globalConfigPath: string = GLOBAL_CONFIG_PATH,
  graspHome: string = GRASP_HOME
): void {
  fs.mkdirSync(graspHome, { recursive: true });
  fs.writeFileSync(globalConfigPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf-8");
}

/**
 * Resets repo-level config by deleting `.grasp.json` if present — see
 * DECISIONS.md's "grasp reset config (local): delete vs empty-out" entry for
 * why deletion (not writing back an empty `{}`) is the chosen behavior.
 * Returns true if a file was actually deleted, false if there was nothing to
 * remove (so callers can print an accurate confirmation either way).
 */
export function resetRepoConfigFile(repoConfigPath: string): boolean {
  if (!fs.existsSync(repoConfigPath)) return false;
  fs.unlinkSync(repoConfigPath);
  return true;
}
