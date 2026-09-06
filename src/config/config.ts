/**
 * Load / deep-merge / save config.  GOVERNED BY: §16.3, §18
 *
 * Global `~/.grasp/config.json` (mode 0600) with an optional per-repo
 * `<project>/.grasp.json` deep-merged over it.
 *
 * SECURITY (§18.2): `apiKey` in a per-repo config is IGNORED and warned about,
 * loudly. `.grasp.json` is meant to be committable so a team can share ignore
 * patterns, and a committed API key is a serious incident — so the merge drops
 * the key before it can ever reach a provider.
 *
 * A corrupt config never crashes anything (§16.3): back it up, write fresh
 * defaults, warn on stderr, continue. Unknown keys are preserved on write so a
 * newer Grasp's config survives an older Grasp reading it.
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG } from "./defaults.js";
import { resolveReviewKeys } from "../review/keys.js";
import { ensureGraspHome, graspConfigPath } from "../util/home.js";

export type GraspConfig = typeof DEFAULT_CONFIG;

/** Anything not in DEFAULT_CONFIG: preserved on write, warned about once. */
export type ConfigWithUnknown = GraspConfig & Record<string, unknown>;

export const PER_REPO_CONFIG_NAME = ".grasp.json";

export interface LoadResult {
  config: ConfigWithUnknown;
  /** Surfaced to stderr by the CLI; the daemon logs them at warn (§16.1). */
  warnings: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep merge, arrays replaced wholesale. A per-repo `ignorePatterns` overrides
 * the global list rather than appending: a project that lists three patterns
 * means those three, not those plus fourteen it never mentioned.
 */
export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(override)) return base;
  if (!isPlainObject(base)) return override as T;

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = (base as Record<string, unknown>)[key];
    result[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return result as T;
}

function readJsonFile(file: string): { value: unknown; error: Error | null } {
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf8")) as unknown, error: null };
  } catch (error) {
    return { value: null, error: error as Error };
  }
}

/**
 * §16.3 — a corrupt global config is backed up and replaced, never fatal. The
 * daemon must keep running; the user keeps whatever they had for inspection.
 */
function loadGlobal(file: string, warnings: string[]): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};

  const { value, error } = readJsonFile(file);
  if (error || !isPlainObject(value)) {
    const backup = `${file}.bak`;
    try {
      fs.copyFileSync(file, backup);
    } catch {
      // Best effort: an unreadable backup must not stop us writing defaults.
    }
    warnings.push(
      `config at ${file} is unparseable — backed up to ${path.basename(backup)} and replaced with defaults`,
    );
    saveConfig(DEFAULT_CONFIG as ConfigWithUnknown, file);
    return {};
  }
  return value;
}

/** §18.2 — strip `apiKey` from a per-repo config before it can be merged. */
export function sanitizePerRepo(
  value: Record<string, unknown>,
  file: string,
  warnings: string[],
): Record<string, unknown> {
  if (!("apiKey" in value)) return value;
  const rest = { ...value };
  delete rest.apiKey;
  warnings.push(
    `IGNORING apiKey in ${file}: per-repo config is committable, so Grasp never reads a key from it (§18.2). ` +
      `Remove it from that file and from your git history — treat it as leaked.`,
  );
  return rest;
}

function warnUnknownKeys(value: Record<string, unknown>, source: string, warnings: string[]): void {
  const known = new Set(Object.keys(DEFAULT_CONFIG));
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    warnings.push(
      `unknown config key(s) in ${source}: ${unknown.join(", ")} (preserved, not used)`,
    );
  }
}

export interface LoadOptions {
  /** Project root to look for `.grasp.json` in. Omit for global-only. */
  projectRoot?: string;
  /** Override the global config path. Tests use this; nothing else should. */
  globalFile?: string;
}

export function loadConfig(options: LoadOptions = {}): LoadResult {
  const warnings: string[] = [];
  const globalFile = options.globalFile ?? graspConfigPath();

  const global = loadGlobal(globalFile, warnings);
  warnUnknownKeys(global, globalFile, warnings);
  let config = deepMerge(DEFAULT_CONFIG as ConfigWithUnknown, global);

  if (options.projectRoot) {
    const perRepoFile = path.join(options.projectRoot, PER_REPO_CONFIG_NAME);
    if (fs.existsSync(perRepoFile)) {
      const { value, error } = readJsonFile(perRepoFile);
      if (error || !isPlainObject(value)) {
        // A broken per-repo file is skipped, not fatal, and not backed up:
        // it belongs to the repo, not to Grasp.
        warnings.push(`ignoring unparseable ${perRepoFile}`);
      } else {
        const safe = sanitizePerRepo(value, perRepoFile, warnings);
        warnUnknownKeys(safe, perRepoFile, warnings);
        config = deepMerge(config, safe);
      }
    }
  }

  // §14.4 — a hand-edited binding that is reserved, malformed, or duplicated
  // falls back to its default and warns. An unusable map must never leave an
  // action unreachable, and must never take a review session down.
  const resolved = resolveReviewKeys(
    (config.review as { keys?: Record<string, unknown> } | undefined)?.keys ?? {},
  );
  config = { ...config, review: { ...config.review, keys: resolved.keys } };
  warnings.push(...resolved.warnings);

  return { config, warnings };
}

/** Mode 0600 (§6.3): the file can hold an API key. Best effort on Windows. */
export function saveConfig(config: ConfigWithUnknown, file?: string): void {
  const target = file ?? graspConfigPath();
  if (!file) ensureGraspHome();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // Windows: no POSIX modes. Documented as best-effort (§6.3).
  }
}
