import * as fs from "fs";
import * as path from "path";
import { GLOBAL_CONFIG_PATH, GRASP_HOME, REPO_CONFIG_FILENAME } from "./paths";
import { GraspConfig } from "./types";

export const DEFAULT_CONFIG: GraspConfig = {
  gateMode: "soft",
  costCapUsd: 0.25,
  ignorePatterns: [],
  questionsPerSessionCap: 8,
  diffThresholds: {
    minChangedLines: 3,
    maxTotalChangedLines: 1500,
    maxSingleFileChangedLines: 800,
  },
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
  const parsed = readJsonFile(globalConfigPath);
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

  const repoOverride = readJsonFile(repoConfigPath);
  const merged = deepMerge(globalConfig, repoOverride);
  return { config: merged, globalConfigPath, repoConfigPath };
}
