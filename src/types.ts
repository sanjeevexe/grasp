import { DiffFile } from "./adapters/agentAdapter";

export type GateMode = "soft" | "hard";

export interface DiffThresholds {
  minChangedLines: number;
  maxTotalChangedLines: number;
  maxSingleFileChangedLines: number;
}

export interface GraspConfig {
  gateMode: GateMode;
  costCapUsd: number;
  ignorePatterns: string[];
  questionsPerSessionCap: number;
  diffThresholds: DiffThresholds;
}

export interface EventRecord {
  id?: number;
  timestamp: string;
  repo: string;
  /** Claude Code's session_id — the boundary the cost cap and questions-per-session cap accumulate against. Null for events not tied to a Claude Code session (e.g. future non-hook adapters). */
  sessionId: string | null;
  diffHash: string | null;
  diffSummary: string | null;
  questionConcept: string | null;
  questionInstance: string | null;
  questionType: string | null;
  generationSource: string | null;
  missReason: string | null;
  answerConcept: string | null;
  answerInstance: string | null;
  skipped: boolean;
  skipReason: string | null;
  costUsd: number | null;
  /**
   * True only for a miss row where a real `claude -p` invocation was
   * genuinely attempted but its cost could not be determined (process
   * failure/timeout with no recoverable envelope, or a well-formed
   * response missing `total_cost_usd`) — distinct from `costUsd === null`
   * on a `cap_reached`/slot-wait-timeout row, where no call was ever
   * attempted at all and there's nothing unknown about it. Drives the
   * "stop generating for this session once its budget is unknowable"
   * safety rail — see `hasUnknownCostFailure` (store.ts) and
   * DECISIONS.md's "Unknown-cost failures halt further generation for the
   * session" entry. Optional/defaults to false so existing call sites
   * (cli.ts debug:answer, tests) that never set it don't need updating.
   */
  costUnknown?: boolean;
  /**
   * The exact significant/post-filter files+hunks shown to the judge model
   * when this question was generated (Phase 4's `significantFiles`),
   * persisted verbatim so `grasp review` can render them without re-fetching
   * from git or re-running the filter against a working tree that may have
   * since moved on. Null for miss rows and declined ("not worth asking")
   * rows — there's no question to render for either.
   */
  diffFiles: DiffFile[] | null;
  /**
   * A concise reference answer for `questionConcept`, generated in the same
   * judge call — shown to the user in `grasp review` AFTER they've already
   * submitted their own answer (or genuinely declined), for self-comparison
   * only. Never used to grade, score, or judge the user's own answer — see
   * DECISIONS.md's "sample answers and concept explanation" entry and the
   * brief §4 deferred-table guardrail on answer grading. Null exactly when
   * `questionConcept` is null (no concept question, nothing to sample), and
   * always null on pre-migration ("legacy") rows. Optional so existing call
   * sites (miss rows, `debug:seed`, older tests) that never set it don't
   * need updating — same pattern as `costUnknown`.
   */
  sampleAnswerConcept?: string | null;
  /**
   * Same as `sampleAnswerConcept`, for `questionInstance`. `questionInstance`
   * is always present on a real question event, so this is only null on a
   * miss/declined row (no question at all) or a pre-migration legacy row.
   */
  sampleAnswerInstance?: string | null;
  /**
   * A short, standalone explanation of the underlying concept — written to
   * make sense on its own, without having seen the diff or either question
   * first. Shown in `grasp review` if the user presses Escape on a question
   * they're stuck on, before giving them one retry at it (see DECISIONS.md's
   * "grasp review: explain-then-retry skip flow" entry). One explanation per
   * event, reused for both the concept and instance phase's Escape — not
   * regenerated per phase, since it's explaining the same underlying idea
   * either way. Null exactly when there's no question at all (miss/declined
   * row), or on a pre-migration legacy row — `grasp review` falls back to an
   * immediate, no-retry skip in that case rather than showing a blank
   * explanation screen.
   */
  conceptExplanation?: string | null;
}

export interface ConceptTagRecord {
  id?: number;
  eventId: number;
  tag: string;
  answered: boolean;
}

export interface ConceptTagGlobalRow extends ConceptTagRecord {
  repo: string;
  eventTimestamp: string;
}
