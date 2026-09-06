/**
 * Applies one answered question to mastery and synthesis.  GOVERNED BY: §10.3, §11.6, §11.7
 *
 * The seam between the review session and the two scoring systems. It exists so
 * §11.7's separation is visible in one place: a synthesis checkpoint's outcome
 * goes to `synthesis_clusters`, a concept question's outcome goes to `concepts`,
 * and neither path can reach the other.
 */
import type { DatabaseSync } from "node:sqlite";
import { getConcept, setTier } from "../storage/models/concepts.js";
import { countQuestionsForTag } from "../storage/models/questions.js";
import { withTransaction } from "../storage/db.js";
import { getEffectiveTier } from "./decay.js";
import { applySelfAssessment } from "./tierLogic.js";
import { recordOutcome, refreshEligibility, type SynthesisSettings } from "../synthesis/trigger.js";
import type { AnsweredQuestion } from "../review/reviewSession.js";
import type { Tier } from "../types/index.js";

export interface ApplyResult {
  /** Null when nothing changed: a skip, or an untagged question. */
  tag: string | null;
  before: Tier | null;
  effective: Tier | null;
  after: Tier | null;
  synthesisRecorded: boolean;
  eligibleNow: boolean;
}

export function applyAnsweredQuestion(
  db: DatabaseSync,
  answered: AnsweredQuestion,
  settings: SynthesisSettings,
  now = new Date(),
): ApplyResult {
  const empty: ApplyResult = {
    tag: null,
    before: null,
    effective: null,
    after: null,
    synthesisRecorded: false,
    eligibleNow: false,
  };

  const tag = answered.question.concept_tag;
  const assessment = answered.assessment;
  // §10.3 — a skip changes nothing: no tier change, no clock reset.
  if (!tag || answered.skipped || assessment === null) return empty;

  return withTransaction(db, () => {
    // A synthesis checkpoint is scored ONLY against its cluster (§11.7).
    if (answered.question.type === "synthesis") {
      recordOutcome(db, tag, assessment, countQuestionsForTag(db, tag));
      return { ...empty, tag, synthesisRecorded: true };
    }

    const concept = getConcept(db, tag);
    const before = concept?.tier ?? "none";
    // Transitions operate on the EFFECTIVE tier and write the STORED one (§10.3).
    const effective = getEffectiveTier(concept, settings.decayWindows, now);
    const transition = applySelfAssessment(effective, assessment, now);
    setTier(db, tag, transition.tier, transition.lastDemonstratedAt);

    const eligibility = refreshEligibility(db, tag, settings, now);
    return {
      tag,
      before,
      effective,
      after: transition.tier,
      synthesisRecorded: false,
      eligibleNow: eligibility.eligible,
    };
  });
}
