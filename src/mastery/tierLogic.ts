/**
 * Self-assessment → tier transitions.  GOVERNED BY: §10.3, §2.1
 *
 * THE ONLY PROGRESSION MECHANISM. Grasp never grades an answer (§2.1); the user
 * tells it how they did and that report is taken at face value.
 *
 * ALL TRANSITIONS OPERATE ON THE EFFECTIVE (POST-DECAY) TIER, and the result is
 * written to the STORED tier. A `reconstruct` that decayed to an effective
 * `predict_break`, answered `nailed_it`, returns to stored `reconstruct`:
 * demonstration UNDOES decay rather than compounding it (§10.3).
 *
 * `assistance_level` MUST NOT affect any of this (§10.4). It is signal, not
 * score — and nothing in this file reads it.
 */
import type { SelfAssessment, Tier } from "../types/index.js";
import { oneTierDown, oneTierUp } from "./decay.js";

export interface TierTransition {
  /** What to write to `concepts.tier`. */
  tier: Tier;
  /** What to write to `concepts.last_demonstrated_at`; null means leave it. */
  lastDemonstratedAt: string | null;
  /** §10.3 — `way_off` auto-shows the explanation, overriding the skip default. */
  autoShowExplanation: boolean;
}

/**
 * @param effective the POST-DECAY tier (§11.2), not the stored one.
 */
export function applySelfAssessment(
  effective: Tier,
  assessment: SelfAssessment,
  now = new Date(),
): TierTransition {
  const timestamp = now.toISOString();
  switch (assessment) {
    case "nailed_it":
      // Capped at reconstruct: there is nothing above it.
      return {
        tier: oneTierUp(effective),
        lastDemonstratedAt: timestamp,
        autoShowExplanation: false,
      };
    case "mostly_there":
      // Unchanged tier, but the clock still resets: engagement counts.
      return { tier: effective, lastDemonstratedAt: timestamp, autoShowExplanation: false };
    case "way_off":
      // Below `trace` becomes `none`, which re-arms the teaching card (§10.2).
      return {
        tier: oneTierDown(effective),
        lastDemonstratedAt: timestamp,
        autoShowExplanation: true,
      };
  }
}

// §10.3 — an explicit skip changes NOTHING: not the tier, not the clock. There
// is deliberately no `applySkip` here: a skip never reaches this module at all,
// because mastery/apply.ts returns before calling it.
