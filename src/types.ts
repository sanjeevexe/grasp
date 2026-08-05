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
   * The exact significant/post-filter files+hunks shown to the judge model
   * when this question was generated (Phase 4's `significantFiles`),
   * persisted verbatim so `grasp review` can render them without re-fetching
   * from git or re-running the filter against a working tree that may have
   * since moved on. Null for miss rows and declined ("not worth asking")
   * rows — there's no question to render for either.
   */
  diffFiles: DiffFile[] | null;
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
