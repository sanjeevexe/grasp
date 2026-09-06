/**
 * Synthesis eligibility and re-surfacing.  GOVERNED BY: §11.5, §11.6, §11.7, §11.8
 *
 * SCORED SEPARATELY, ALWAYS (§11.7). Nothing in this file reads or writes
 * `concepts.tier`, with one deliberate exception: eligibility condition 2 READS
 * the effective tier to decide whether a capstone is appropriate yet. That is a
 * gate, not scoring — the outcome of a checkpoint never touches mastery, and
 * `recordOutcome` below cannot: it only writes `synthesis_clusters`.
 *
 * Clustering comes from the model's `concept_tag` (§11.5), never from timing
 * proximity or file adjacency.
 */
import type { DatabaseSync } from "node:sqlite";
import { getConcept } from "../storage/models/concepts.js";
import { countQuestionsForTag } from "../storage/models/questions.js";
import {
  getCluster,
  recordCheckpointOutcome,
  setEligible,
} from "../storage/models/synthesisClusters.js";
import { getEffectiveTier, type DecayWindows } from "../mastery/decay.js";
import type { SelfAssessment, SynthesisStatus, Tier } from "../types/index.js";

const TIER_RANK: Record<Tier, number> = {
  none: 0,
  trace: 1,
  predict_break: 2,
  reconstruct: 3,
};

export interface SynthesisSettings {
  minDiffCount: number;
  minMasteryTier: Tier;
  decayWindows: DecayWindows;
}

export interface EligibilityResult {
  eligible: boolean;
  /** Why not, for `grasp status` and for tests to assert against. */
  reason:
    | "eligible"
    | "count"
    | "mastery"
    | "passed_and_not_grown"
    | "struggled_awaiting_new_question"
    | "no_questions";
  questionCount: number;
  effectiveTier: Tier;
}

/**
 * §11.6 — BOTH conditions, every time. Condition 2 is what stops the hardest
 * question in the system from firing on material the user just met.
 */
export function evaluateEligibility(
  db: DatabaseSync,
  tag: string,
  settings: SynthesisSettings,
  now = new Date(),
): EligibilityResult {
  // Condition 1: derived with a COUNT, never a stored counter (§11.6).
  const questionCount = countQuestionsForTag(db, tag);
  const effectiveTier = getEffectiveTier(getConcept(db, tag), settings.decayWindows, now);
  const base = { questionCount, effectiveTier };

  if (questionCount === 0) return { ...base, eligible: false, reason: "no_questions" };

  const cluster = getCluster(db, tag);

  // §11.8 — a passed cluster stays closed until it grows by another
  // minDiffCount BEYOND the count at the last checkpoint.
  if (cluster?.status === "passed") {
    const grown = questionCount - cluster.count_at_last_checkpoint;
    if (grown < settings.minDiffCount) {
      return { ...base, eligible: false, reason: "passed_and_not_grown" };
    }
  }

  if (questionCount < settings.minDiffCount) return { ...base, eligible: false, reason: "count" };
  if (TIER_RANK[effectiveTier] < TIER_RANK[settings.minMasteryTier]) {
    return { ...base, eligible: false, reason: "mastery" };
  }

  // §11.8 — a `struggled` cluster re-surfaces on a NEW question under the tag,
  // and on nothing else. Recomputation alone must not re-arm it, or the
  // checkpoint returns on a timer, which is exactly what §2.4 forbids. The
  // stored flag is authoritative here; `onNewQuestionForTag` is what sets it.
  if (cluster?.status === "struggled" && cluster.eligible !== 1) {
    return { ...base, eligible: false, reason: "struggled_awaiting_new_question" };
  }

  return { ...base, eligible: true, reason: "eligible" };
}

/**
 * Evaluated after each answered question — cheap and local (§11.6). Persists the
 * flag so `grasp review` and `grasp status` can read it without recomputing.
 */
export function refreshEligibility(
  db: DatabaseSync,
  tag: string,
  settings: SynthesisSettings,
  now = new Date(),
): EligibilityResult {
  const result = evaluateEligibility(db, tag, settings, now);
  // Only touch the row when there is something to record; creating a cluster for
  // an ineligible tag would litter the table.
  if (result.eligible || getCluster(db, tag)) setEligible(db, tag, result.eligible);
  return result;
}

/**
 * §11.8 — a `struggled` cluster becomes eligible again the next time a NEW
 * question lands under the tag. No timer, no reminder: the same lazy pattern as
 * decay. Called by the capture pipeline when it persists a question.
 */
export function onNewQuestionForTag(
  db: DatabaseSync,
  tag: string,
  settings: SynthesisSettings,
  now = new Date(),
): void {
  const cluster = getCluster(db, tag);
  if (cluster?.status === "struggled") {
    setEligible(db, tag, true);
    return;
  }
  refreshEligibility(db, tag, settings, now);
}

/** §11.7 — `nailed_it` → passed; anything less → struggled. */
export function statusForAssessment(assessment: SelfAssessment): SynthesisStatus {
  return assessment === "nailed_it" ? "passed" : "struggled";
}

/**
 * Records a checkpoint outcome. Writes `synthesis_clusters` and NOTHING ELSE —
 * §11.7's separation is enforced by this function not importing anything that
 * can write `concepts`.
 */
export function recordOutcome(
  db: DatabaseSync,
  tag: string,
  assessment: SelfAssessment,
  questionCount: number,
): SynthesisStatus {
  const status = statusForAssessment(assessment);
  recordCheckpointOutcome(db, tag, status, questionCount);
  return status;
}
