/**
 * Hourly cap and rollup backpressure.  GOVERNED BY: §8.1, §8.2, §8.3
 *
 * When a batch would exceed the cap, Grasp does NOT generate and does NOT
 * advance the checkpoint (§8.2). The un-captured changes stay in the diff and
 * roll into the next batch, coalescing into one larger, more synthesis-worthy
 * change once capacity returns. Better than dropping (silent coverage loss) and
 * better than queueing (a deferred flood).
 *
 * ESCAPE VALVE: a rolled-up diff past `maxDiffLines` generates anyway, cap or
 * no cap, then advances. That is what stops the rollup growing without bound
 * and guarantees no code is skipped permanently.
 */
import type { DatabaseSync } from "node:sqlite";
import { countQuestionsSince } from "../storage/models/questions.js";

export interface RateLimitSettings {
  maxQuestionsPerHour: number;
  maxDiffLines: number;
}

export type RateLimitDecision =
  | { generate: true; reason: "under_cap" | "escape_valve" }
  | { generate: false; reason: "over_cap" };

export const ROLLING_WINDOW_MS = 60 * 60 * 1000;

/** §8.1 — counted from `questions.created_at` over a rolling 60 minutes, all projects. */
export function questionsInLastHour(db: DatabaseSync, now = new Date()): number {
  return countQuestionsSince(db, new Date(now.getTime() - ROLLING_WINDOW_MS).toISOString());
}

export function countDiffLines(diff: string): number {
  return diff.split("\n").filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line))
    .length;
}

export function decide(
  db: DatabaseSync,
  diffLines: number,
  settings: RateLimitSettings,
  now = new Date(),
): RateLimitDecision {
  const used = questionsInLastHour(db, now);
  if (used < settings.maxQuestionsPerHour) return { generate: true, reason: "under_cap" };

  // Over the cap, but the rollup has grown past the point where deferring again
  // would risk unbounded growth: spend the call (§8.2).
  if (diffLines > settings.maxDiffLines) return { generate: true, reason: "escape_valve" };

  return { generate: false, reason: "over_cap" };
}
