/**
 * Review key bindings and their validation.  GOVERNED BY: §14.4, §18.1
 *
 * Bindings are configurable because this problem is inherently machine-specific:
 * there is no key that is safe on every setup. `Ctrl+G` was a reasonable default
 * until macOS started opening Gemini with it — a collision at the OS layer, above
 * anything the terminal can see. Expect more of these, and let people fix them
 * without waiting for a release.
 *
 * Only `Ctrl`+letter is accepted. A bare letter would collide with answer text,
 * which is the bug this whole design exists to prevent (§14.4).
 */
import type { ReviewCommand } from "./io.js";

export type ReviewAction = ReviewCommand;

export const REVIEW_ACTIONS: ReviewAction[] = [
  "hint",
  "explain",
  "deeper",
  "breakdown",
  "skip",
  "quit",
];

/**
 * Defaults, each verified to arrive in a real PTY with raw mode on. Mnemonics
 * where the obvious letter was unavailable: hint is "tip" because `Ctrl+H` is
 * Backspace; deeper is "read more" because `Ctrl+D` is EOF; breakdown is
 * `Ctrl+K` because `Ctrl+B` is tmux's prefix; skip is "next".
 */
export const DEFAULT_REVIEW_KEYS: Record<ReviewAction, string> = {
  hint: "ctrl+t",
  explain: "ctrl+e",
  deeper: "ctrl+r",
  breakdown: "ctrl+k",
  skip: "ctrl+n",
  quit: "ctrl+c",
};

/**
 * Combinations that cannot be bound, and why. The first four are not policy: a
 * terminal genuinely cannot distinguish them from the ordinary key, so binding
 * one would also fire on Backspace, Tab, or Enter.
 */
export const RESERVED_KEYS: Record<string, string> = {
  "ctrl+h": "the terminal sends it as Backspace",
  "ctrl+i": "the terminal sends it as Tab",
  "ctrl+j": "the terminal sends it as Enter",
  "ctrl+m": "the terminal sends it as Return",
  "ctrl+[": "the terminal sends it as Escape",
  "ctrl+s": "XON/XOFF flow control — bound to an action it would freeze your terminal",
  "ctrl+q": "XON/XOFF flow control",
  "ctrl+z": "it suspends the process",
  "ctrl+d": "it is end-of-file, and already ends the session",
};

/** An action with no usable key. Ctrl+C still ends the session regardless. */
export const UNBOUND = "";

export function normalizeBinding(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "");
}

export interface ParsedBinding {
  ctrl: true;
  name: string;
}

export function parseBinding(binding: string): ParsedBinding | null {
  const match = /^ctrl\+([a-z])$/.exec(normalizeBinding(binding));
  return match ? { ctrl: true, name: match[1] } : null;
}

/** "ctrl+t" → "Ctrl+T", for the key hint line (§14.4). */
export function formatBinding(binding: string): string {
  if (binding === UNBOUND) return "(unbound)";
  const parsed = parseBinding(binding);
  return parsed ? `Ctrl+${parsed.name.toUpperCase()}` : binding;
}

export type BindingCheck = { ok: true; value: string } | { ok: false; error: string };

export function validateBinding(raw: string, action?: ReviewAction): BindingCheck {
  const binding = normalizeBinding(raw);

  if (!parseBinding(binding)) {
    return {
      ok: false,
      error:
        `"${raw}" is not a usable binding — use Ctrl+<letter>, e.g. "ctrl+t". ` +
        `A bare letter cannot be a command: letters are answer text (§14.4).`,
    };
  }

  const reserved = RESERVED_KEYS[binding];
  if (reserved) {
    return { ok: false, error: `${formatBinding(binding)} cannot be bound: ${reserved}.` };
  }

  // Ctrl+C always ends the session, so no other action may claim it.
  if (binding === "ctrl+c" && action !== undefined && action !== "quit") {
    return {
      ok: false,
      error: `${formatBinding(binding)} always quits the session, so it cannot also be "${action}".`,
    };
  }

  return { ok: true, value: binding };
}

export interface ResolvedKeys {
  keys: Record<ReviewAction, string>;
  warnings: string[];
}

/**
 * Sanitize a configured map: anything invalid, reserved, or duplicated falls
 * back to its default and warns. A bad binding must never leave an action
 * unreachable, and must never take the session down.
 */
export function resolveReviewKeys(configured: Partial<Record<string, unknown>> = {}): ResolvedKeys {
  const warnings: string[] = [];
  const explicit = new Map<ReviewAction, string>();
  const claimed = new Map<string, ReviewAction>();

  // Pass 1: explicit bindings win, in declaration order. Anything invalid,
  // reserved, or already claimed is dropped with its reason.
  for (const action of REVIEW_ACTIONS) {
    const raw = configured[action];
    if (raw === undefined || raw === null) continue;

    if (typeof raw !== "string") {
      warnings.push(`review.keys.${action} must be a string; ignoring it.`);
      continue;
    }
    const check = validateBinding(raw, action);
    if (!check.ok) {
      warnings.push(check.error);
      continue;
    }
    const holder = claimed.get(check.value);
    if (holder) {
      warnings.push(
        `${formatBinding(check.value)} is bound to both "${holder}" and "${action}"; keeping it for "${holder}".`,
      );
      continue;
    }
    explicit.set(action, check.value);
    claimed.set(check.value, action);
  }

  // Pass 2: everything else takes its default — unless an explicit binding has
  // already taken that key, in which case the action is left UNBOUND and said
  // so. Silently letting two actions share a key would make one of them dead
  // with nothing on screen to explain why.
  const keys = {} as Record<ReviewAction, string>;
  for (const action of REVIEW_ACTIONS) {
    const chosen = explicit.get(action);
    if (chosen) {
      keys[action] = chosen;
      continue;
    }
    const fallback = DEFAULT_REVIEW_KEYS[action];
    const holder = claimed.get(fallback);
    if (holder && holder !== action) {
      keys[action] = UNBOUND;
      warnings.push(
        `"${action}" has no key: its default ${formatBinding(fallback)} is bound to "${holder}". ` +
          `Pick one with \`grasp set review.keys.${action} ctrl+<letter>\`.`,
      );
      continue;
    }
    keys[action] = fallback;
    claimed.set(fallback, action);
  }

  return { keys, warnings };
}

/** Which action, if any, a keypress triggers. */
export function matchBinding(
  key: { ctrl?: boolean; name?: string },
  keys: Record<ReviewAction, string>,
): ReviewAction | undefined {
  if (!key.ctrl || !key.name) return undefined;
  const pressed = `ctrl+${key.name}`;
  return REVIEW_ACTIONS.find((action) => keys[action] !== UNBOUND && keys[action] === pressed);
}
