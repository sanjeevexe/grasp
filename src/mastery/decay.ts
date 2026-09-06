/**
 * Lazy read-time decay.  GOVERNED BY: §11.2, §11.3, §2.4
 *
 * NOTHING RUNS ON A SCHEDULE. There is no decay job and no stored decayed
 * value; `getEffectiveTier` computes it at the moment it is needed, triggered by
 * real activity (§2.4). A decayed concept surfaces the next time the user
 * touches that code — it never notifies (§11.3).
 *
 * Decay drops EXACTLY ONE TIER, never to zero: someone who earned `reconstruct`
 * six months ago gets a `predict_break` spot-check, not a from-scratch teaching
 * card (§11.2).
 */
import type { Tier } from "../types/index.js";

/** `config.decayWindows`, in days. `null` disables decay for that tier. */
export interface DecayWindows {
  trace: number | null;
  predictBreak: number | null;
  reconstruct: number | null;
}

const ORDER: Tier[] = ["none", "trace", "predict_break", "reconstruct"];

export function oneTierDown(tier: Tier): Tier {
  const index = ORDER.indexOf(tier);
  return index <= 0 ? "none" : ORDER[index - 1];
}

export function oneTierUp(tier: Tier): Tier {
  const index = ORDER.indexOf(tier);
  return index === -1 || index === ORDER.length - 1 ? "reconstruct" : ORDER[index + 1];
}

/** `none` is filtered out before this is reached — it cannot decay further. */
function windowFor(tier: Exclude<Tier, "none">, windows: DecayWindows): number | null {
  switch (tier) {
    case "trace":
      return windows.trace;
    case "predict_break":
      return windows.predictBreak;
    case "reconstruct":
      return windows.reconstruct;
  }
}

export interface EffectiveTierInput {
  tier: Tier;
  last_demonstrated_at: string | null;
}

/**
 * The post-decay tier. Boundary-exact does NOT decay: the comparison is `>`,
 * not `>=`, so a concept sitting exactly on its window is still current (§22.2).
 */
export function getEffectiveTier(
  concept: EffectiveTierInput | undefined,
  windows: DecayWindows,
  now = new Date(),
): Tier {
  if (!concept) return "none";
  if (concept.tier === "none") return "none";

  // Never demonstrated: there is no clock to measure, so nothing has decayed.
  // The stored tier stands (§22.2 treats a null timestamp as `none` because a
  // concept that was never demonstrated is stored at `none` anyway).
  if (!concept.last_demonstrated_at) return concept.tier;

  const window = windowFor(concept.tier, windows);
  if (window === null) return concept.tier;

  const demonstrated = Date.parse(concept.last_demonstrated_at);
  if (Number.isNaN(demonstrated)) return concept.tier;

  const elapsedDays = (now.getTime() - demonstrated) / 86_400_000;
  return elapsedDays > window ? oneTierDown(concept.tier) : concept.tier;
}
