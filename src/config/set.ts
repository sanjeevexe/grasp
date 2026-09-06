/**
 * `grasp set <key> <value>` — dot-notation config editing.  GOVERNED BY: §18.3
 *
 * The schema is DEFAULT_CONFIG itself: a key exists if it exists there, and its
 * type is that value's type. Nothing to keep in sync, and a key added to
 * defaults is settable the same day.
 *
 * Unknown key or wrong type → a usage error (exit 2 at the CLI boundary), and
 * NEVER a written config. An invalid config on disk is worse than a rejected
 * command.
 */
import { DEFAULT_CONFIG } from "./defaults.js";
import {
  REVIEW_ACTIONS,
  formatBinding,
  normalizeBinding,
  validateBinding,
  type ReviewAction,
} from "../review/keys.js";
import type { ConfigWithUnknown } from "./config.js";

export type SetResult =
  { ok: true; config: ConfigWithUnknown; parsed: unknown } | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every settable dot-path, derived from the shape of DEFAULT_CONFIG. */
export function configKeyPaths(
  node: unknown = DEFAULT_CONFIG,
  prefix = "",
): { path: string; sample: unknown }[] {
  if (!isPlainObject(node)) return [{ path: prefix, sample: node }];
  return Object.entries(node).flatMap(([key, value]) => {
    const next = prefix ? `${prefix}.${key}` : key;
    // A nested object is a namespace, not a leaf — except when it is null-able
    // config like notifications.quietHours, which is an array or null.
    return isPlainObject(value) ? configKeyPaths(value, next) : [{ path: next, sample: value }];
  });
}

function lookupSample(key: string): { found: boolean; sample: unknown } {
  const parts = key.split(".");
  let node: unknown = DEFAULT_CONFIG;
  for (const part of parts) {
    if (!isPlainObject(node) || !(part in node)) return { found: false, sample: undefined };
    node = node[part];
  }
  return { found: true, sample: node };
}

/**
 * Parse `value` to the type the default at `key` has.
 *
 * DECISION: the default's type is the contract, with two documented exceptions
 * where §18.1 shows `null` as a real value — `questionStaleDays` (null disables
 * staleness), and the notification fields. For those, "null" parses to null.
 */
export function parseConfigValue(
  key: string,
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const { found, sample } = lookupSample(key);
  if (!found) {
    return { ok: false, error: `unknown config key "${key}"` };
  }
  if (isPlainObject(sample)) {
    return {
      ok: false,
      error: `"${key}" is a group of settings, not a value — set one of its keys (e.g. ${key}.${Object.keys(sample)[0]})`,
    };
  }

  const lowered = raw.trim().toLowerCase();
  if (lowered === "null") {
    // §18.1 marks the nullable keys; anything else rejects null outright.
    const nullable = new Set([
      "apiKey",
      "questionStaleDays",
      "notifications.quietHours",
      "notifications.snoozeUntil",
      "gateMode",
    ]);
    return nullable.has(key)
      ? { ok: true, value: null }
      : { ok: false, error: `"${key}" cannot be null` };
  }

  if (typeof sample === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value))
      return { ok: false, error: `"${key}" expects a number, got "${raw}"` };
    if (value < 0) return { ok: false, error: `"${key}" cannot be negative` };
    return { ok: true, value };
  }

  if (typeof sample === "boolean") {
    if (lowered === "true") return { ok: true, value: true };
    if (lowered === "false") return { ok: true, value: false };
    return { ok: false, error: `"${key}" expects true or false, got "${raw}"` };
  }

  if (Array.isArray(sample)) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return { ok: false, error: `"${key}" expects a JSON array` };
      return { ok: true, value: parsed };
    } catch {
      return { ok: false, error: `"${key}" expects a JSON array, e.g. '["**/dist/**"]'` };
    }
  }

  // §14.4 — a keybinding is checked against the reserved list here, so an
  // unusable one is rejected at the moment it is typed rather than silently
  // falling back at review time.
  const bindingAction = /^review\.keys\.(\w+)$/.exec(key)?.[1] as ReviewAction | undefined;
  if (bindingAction) {
    const check = validateBinding(raw, bindingAction);
    return check.ok ? { ok: true, value: check.value } : { ok: false, error: check.error };
  }

  // Strings with a fixed set of legal values are checked against it, so a typo
  // is caught here rather than at the moment the daemon needs the value.
  const enums: Record<string, string[]> = {
    provider: ["auto", "claude-cli", "api"],
    gateMode: ["soft", "warn", "hard"],
    "notifications.batching": ["per_turn", "per_question"],
    "synthesisTrigger.minMasteryTier": ["none", "trace", "predict_break", "reconstruct"],
  };
  const allowed = enums[key];
  if (allowed && !allowed.includes(raw)) {
    return { ok: false, error: `"${key}" expects one of: ${allowed.join(", ")} (got "${raw}")` };
  }
  return { ok: true, value: raw };
}

/** Apply a parsed value onto a config object, returning a new object. */
export function setConfigValue(config: ConfigWithUnknown, key: string, raw: string): SetResult {
  const parsed = parseConfigValue(key, raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  // A binding must also be unique across actions; that can only be checked
  // against the whole map, not one key at a time.
  if (key.startsWith("review.keys.")) {
    const action = key.slice("review.keys.".length) as ReviewAction;
    const wanted = normalizeBinding(raw);
    const clash = REVIEW_ACTIONS.find(
      (other) =>
        other !== action && normalizeBinding(String(config.review?.keys?.[other] ?? "")) === wanted,
    );
    if (clash) {
      return {
        ok: false,
        error: `${formatBinding(wanted)} is already bound to "${clash}" — pick another key, or rebind "${clash}" first.`,
      };
    }
  }

  const next = structuredClone(config);
  const parts = key.split(".");
  let node = next as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const child = node[part];
    if (!isPlainObject(child)) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts.at(-1) as string] = parsed.value;
  return { ok: true, config: next, parsed: parsed.value };
}
