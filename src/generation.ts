import { execFileSync } from "child_process";
import Database from "better-sqlite3";
import { DiffFile } from "./adapters/agentAdapter";
import { GraspConfig } from "./types";
import {
  getAllAnsweredConceptTags,
  getConceptTagGlobal,
  getSessionCostUsd,
  getSessionQuestionCount,
  insertEvent,
} from "./store";

/**
 * The single generation path from brief §3.3: one headless `claude -p`
 * call that judges whether a diff is worth a question AND generates the
 * question(s) in the same response. Prompt/response contract design is
 * this phase's own — see DECISIONS.md's "Judge+generate prompt and
 * response contract" entry for the reasoning.
 */

const GENERATION_SOURCE = "headless-claude-p";

/**
 * Ceiling on the `claude -p` subprocess call itself. Deliberately well
 * under the Phase 5 outer Claude Code hook timeout (45s, src/init.ts) —
 * see DECISIONS.md's "Generation subprocess timeout value" entry for the
 * margin reasoning. Hardcoded, not exposed in GraspConfig — see
 * DECISIONS.md's "hardcoded vs configurable" entry for why.
 */
const GENERATION_TIMEOUT_MS = 20_000;

export type MissReason = "cap_reached" | "error" | "timeout";

export interface GenerationOutcome {
  eventId: number;
  missReason: MissReason | null;
  questionType: "concept" | "instance" | "both" | null;
}

export interface GenerationParams {
  sessionId: string;
  repo: string;
  significantFiles: DiffFile[];
  config: GraspConfig;
  /** From `CapturedDiff.diffHash` — see DECISIONS.md's "Checkpoint-based incremental capture" entry. Null when the capturing adapter doesn't compute one. */
  diffHash: string | null;
}

// --- diff_summary (local, deterministic, no model call) -------------------

export function buildDiffSummary(files: DiffFile[]): string {
  const totalInsertions = files.reduce((sum, f) => sum + f.insertions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);
  const fileList = files.map((f) => f.path).join(", ");
  return `${files.length} file${files.length === 1 ? "" : "s"} changed (+${totalInsertions}/-${totalDeletions}): ${fileList}`;
}

// --- prompt construction ----------------------------------------------------

/** Renders significant files as readable "File: ... / @@ hunk @@ / lines" text — the hunk data already IS unified-diff shaped, so no reconstruction of diff --git headers is needed for a model that just needs to read the change. */
function formatDiffForPrompt(files: DiffFile[]): string {
  return files
    .map((file) => {
      const header = `File: ${file.path} (${file.status}, +${file.insertions}/-${file.deletions})`;
      const hunkText = file.hunks
        .map((h) => [h.header, ...h.lines].join("\n"))
        .join("\n");
      return hunkText ? `${header}\n${hunkText}` : header;
    })
    .join("\n\n");
}

function buildJudgePrompt(diffText: string, answeredTags: string[]): string {
  const answeredList = answeredTags.length > 0 ? answeredTags.join(", ") : "none yet";
  return `You are a code-comprehension tutor helping a developer understand a change an AI coding agent just made to their own codebase.

Below is a diff the agent produced. Decide, in this single response:
1. Is this diff worth asking the developer a comprehension question about? Trivial, self-explanatory, or purely mechanical changes are not worth asking about.
2. If worth asking about, pick ONE concept tag naming the general programming concept this diff exercises (e.g. "mutex-vs-channel", "recursion", "sql-injection", "async-await", "binary-search"). Use a short, reusable, kebab-case tag — the same underlying concept in a different file should get the same tag.
3. Check the developer's already-answered concept tags below. If your chosen tag is already in that list, do NOT write a concept question — write the instance question only.
4. If a concept question is warranted (tag not already answered), write one: it tests/teaches the general idea, independent of this specific codebase.
5. Write an instance question that applies the concept directly to this diff. If a concept question was written, the instance question should be answerable BECAUSE of it. If no concept question was written (already known), the instance question should stand alone, referencing the diff directly.

Developer's already-answered concept tags (do not re-teach these): ${answeredList}

Diff:
${diffText}

Respond with ONLY a single JSON object, no other text, no markdown code fence, matching exactly this shape:
{"worthAsking": boolean, "conceptTag": string | null, "questionConcept": string | null, "questionInstance": string | null}

Rules for the JSON:
- If worthAsking is false: conceptTag, questionConcept, and questionInstance must all be null.
- If worthAsking is true: conceptTag must be a non-empty kebab-case string, and questionInstance must be a non-empty string.
- questionConcept must be null if conceptTag is in the already-answered list above; otherwise it must be a non-empty string.`;
}

// --- claude -p invocation and response parsing -----------------------------

interface ClaudeEnvelope {
  /**
   * Null when `total_cost_usd` was missing or not a number in the response
   * — genuinely unknown, never coerced to 0. A response can't be trusted
   * for cap accounting without a real cost figure; see DECISIONS.md's
   * "Missing total_cost_usd treated as unknown, not zero" entry.
   */
  totalCostUsd: number | null;
  resultText: string;
  isError: boolean;
}

/** True when a caught execFileSync error is specifically a timeout kill, not any other failure (spawn error, nonzero exit, ...). Empirically verified (not assumed) against this Node version: a timeout sets `error.code === "ETIMEDOUT"` — `error.killed` is NOT reliably `true` the way Node's own docs might suggest, and `error.signal === "SIGTERM"` alone isn't a safe-enough signal on its own since a process could plausibly exit via SIGTERM for unrelated reasons. See DECISIONS.md's "Timeout detection mechanism" entry. */
export function isTimeoutError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ETIMEDOUT";
}

/** Shells out to `claude -p`, exactly per brief §3.3's recommended invocation shape. Throws if the process fails, times out, or its stdout isn't valid JSON at all — callers must catch, and can use `isTimeoutError` to distinguish a timeout from any other failure. */
function invokeClaudeJudge(prompt: string): ClaudeEnvelope {
  const stdout = execFileSync(
    "claude",
    ["-p", prompt, "--output-format", "json", "--allowedTools", "", "--max-turns", "1"],
    {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 16,
      timeout: GENERATION_TIMEOUT_MS,
      // Explicit, not the execFileSync default: Node's exec-family helpers
      // send a failing child's stderr straight to the PARENT's stderr by
      // default (only stdout is piped/captured for the return value). Since
      // this parent is a Claude Code hook process, that meant a `claude -p`
      // failure printed the child's raw stderr where the user could see it
      // — found by an independent test pass, contradicting the documented
      // "fails gracefully, no confusing error message in your way" behavior
      // (README/TESTING_GUIDE). Piping stderr here instead means it's only
      // ever available via the caught error's `.stderr`, which this code
      // doesn't surface anywhere — a failure stays genuinely quiet, logged
      // to the DB as a miss like every other failure mode.
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const envelope = JSON.parse(stdout);
  return {
    totalCostUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null,
    resultText: typeof envelope.result === "string" ? envelope.result : "",
    isError: Boolean(envelope.is_error),
  };
}

export interface JudgeResponse {
  worthAsking: boolean;
  conceptTag: string | null;
  questionConcept: string | null;
  questionInstance: string | null;
}

/** Strips a ```json ... ``` / ``` ... ``` fence if the model wrapped its JSON in one despite instructions not to. */
function extractJsonBlock(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

/**
 * The prompt tells the model conceptTag must be "a short, reusable,
 * kebab-case tag" specifically because memoization (brief §3.2) is a plain
 * string match against previously-stored tags — a differently-spelled or
 * differently-cased tag for the same underlying concept (e.g.
 * "Not Kebab Case!" or "mutex_vs_channel") would defeat the "don't re-teach
 * this" check silently. Found by an independent test pass: a malformed tag
 * was accepted and stored as-is. Enforced here, deterministically, rather
 * than trusted from the model's own compliance — same posture as every
 * other part of the response contract this parser checks.
 */
const KEBAB_CASE_TAG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Returns null for anything that doesn't match the contract — malformed JSON, wrong types, or an internally inconsistent shape. Never throws. */
export function parseJudgeResponse(raw: string): JudgeResponse | null {
  let obj: any;
  try {
    obj = JSON.parse(extractJsonBlock(raw));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  if (typeof obj.worthAsking !== "boolean") return null;

  if (obj.worthAsking === false) {
    if (obj.conceptTag !== null || obj.questionConcept !== null || obj.questionInstance !== null) {
      return null;
    }
    return { worthAsking: false, conceptTag: null, questionConcept: null, questionInstance: null };
  }

  if (typeof obj.conceptTag !== "string" || !KEBAB_CASE_TAG.test(obj.conceptTag.trim())) return null;
  if (typeof obj.questionInstance !== "string" || obj.questionInstance.trim().length === 0) return null;
  if (
    obj.questionConcept !== null &&
    (typeof obj.questionConcept !== "string" || obj.questionConcept.trim().length === 0)
  ) {
    return null;
  }

  return {
    worthAsking: true,
    conceptTag: obj.conceptTag.trim(),
    questionConcept: typeof obj.questionConcept === "string" ? obj.questionConcept.trim() : null,
    questionInstance: obj.questionInstance.trim(),
  };
}

// --- main entry point --------------------------------------------------------

function recordMiss(
  db: Database.Database,
  params: GenerationParams,
  diffSummary: string,
  missReason: MissReason,
  costUsd: number | null
): GenerationOutcome {
  const eventId = insertEvent(db, {
    timestamp: new Date().toISOString(),
    repo: params.repo,
    sessionId: params.sessionId,
    diffHash: params.diffHash,
    diffSummary,
    questionConcept: null,
    questionInstance: null,
    questionType: null,
    generationSource: GENERATION_SOURCE,
    missReason,
    answerConcept: null,
    answerInstance: null,
    skipped: false,
    skipReason: null,
    costUsd,
    diffFiles: null,
  });
  return { eventId, missReason, questionType: null };
}

/**
 * Given a diff that already passed Phase 4's mechanical filter, enforces
 * the session-wide cost cap, then (if not capped) runs the single judge+
 * generate call and writes exactly one `events` row — whether or not it
 * produced a question. See DECISIONS.md's prompt/response-contract and
 * malformed-response entries for the design reasoning.
 */
export function runGeneration(db: Database.Database, params: GenerationParams): GenerationOutcome {
  const { sessionId, significantFiles, config } = params;
  const diffSummary = buildDiffSummary(significantFiles);

  const spentSoFar = getSessionCostUsd(db, sessionId);
  if (spentSoFar >= config.costCapUsd) {
    // Cap already met/exceeded — never invoke `claude -p` at all.
    return recordMiss(db, params, diffSummary, "cap_reached", null);
  }

  const questionsSoFar = getSessionQuestionCount(db, sessionId);
  if (questionsSoFar >= config.questionsPerSessionCap) {
    // Same "never invoke claude -p at all" pattern as the cost cap above,
    // and the same miss_reason — see DECISIONS.md's "Questions-per-session
    // cap: miss-reason reuse" entry for why cap_reached is shared rather
    // than a new value, and for how the two remain distinguishable after
    // the fact from the session's own cost/question totals at the time.
    return recordMiss(db, params, diffSummary, "cap_reached", null);
  }

  const answeredTags = getAllAnsweredConceptTags(db);
  const diffText = formatDiffForPrompt(significantFiles);
  const prompt = buildJudgePrompt(diffText, answeredTags);

  let envelope: ClaudeEnvelope;
  try {
    envelope = invokeClaudeJudge(prompt);
  } catch (err) {
    // Process never produced a usable envelope at all — no cost figure to
    // record either way (genuinely unknown, not 0). A timeout kill is
    // distinguished from every other spawn/exit failure specifically —
    // see isTimeoutError's own comment for how that's actually detected.
    const missReason: MissReason = isTimeoutError(err) ? "timeout" : "error";
    return recordMiss(db, params, diffSummary, missReason, null);
  }

  if (envelope.isError) {
    return recordMiss(db, params, diffSummary, "error", envelope.totalCostUsd);
  }

  if (envelope.totalCostUsd === null) {
    // A well-formed, non-error envelope that's missing its own cost figure
    // can't be trusted for cap accounting — recording it as a "free"
    // successful call would let repeated uncosted responses bypass the
    // cost cap entirely (it sums cost_usd, and NULL contributes 0). Treat
    // it as a miss instead — see DECISIONS.md's "Missing total_cost_usd"
    // entry. This intentionally never reaches parseJudgeResponse: even a
    // perfectly well-formed question in this response isn't recorded,
    // since there's no way to know what it actually cost.
    return recordMiss(db, params, diffSummary, "error", null);
  }

  const parsed = parseJudgeResponse(envelope.resultText);
  if (!parsed) {
    // The call succeeded and cost money, but didn't return a usable
    // response — still record that cost so a misbehaving/malformed
    // response can't be used to bypass the cap.
    return recordMiss(db, params, diffSummary, "error", envelope.totalCostUsd);
  }

  if (!parsed.worthAsking) {
    const eventId = insertEvent(db, {
      timestamp: new Date().toISOString(),
      repo: params.repo,
      sessionId,
      diffHash: params.diffHash,
      diffSummary,
      questionConcept: null,
      questionInstance: null,
      questionType: null,
      generationSource: GENERATION_SOURCE,
      missReason: null,
      answerConcept: null,
      answerInstance: null,
      skipped: false,
      skipReason: null,
      costUsd: envelope.totalCostUsd,
      diffFiles: null,
    });
    return { eventId, missReason: null, questionType: null };
  }

  // worthAsking === true. The model was told the already-answered list and
  // instructed to self-censor, but Grasp still enforces the §3.2 rule
  // deterministically against its own DB — the model's own judgment isn't
  // trusted as the sole authority for a correctness guarantee.
  const alreadyAnswered = getConceptTagGlobal(db, parsed.conceptTag as string, true).length > 0;

  if (!alreadyAnswered && parsed.questionConcept === null) {
    // The model proposed a concept tag it has never been told was already
    // answered, yet omitted the concept question the prompt's own contract
    // requires in that case ("questionConcept must be null if conceptTag is
    // in the already-answered list ... otherwise it must be a non-empty
    // string"). Silently accepting this as an instance-only question would
    // let a brand-new concept get marked "answered" the moment the user
    // answers the instance question — teaching nothing, in direct violation
    // of brief §3.2's concept-first requirement. Found by an independent
    // test pass. Treated as a contract violation like any other malformed
    // response: a paid-for miss, not a silently-accepted success — see
    // DECISIONS.md's "Concept-first enforcement" entry.
    return recordMiss(db, params, diffSummary, "error", envelope.totalCostUsd);
  }

  const includeConceptQuestion = !alreadyAnswered;
  const questionType: "instance" | "both" = includeConceptQuestion ? "both" : "instance";

  const eventId = insertEvent(
    db,
    {
      timestamp: new Date().toISOString(),
      repo: params.repo,
      sessionId,
      diffHash: params.diffHash,
      diffSummary,
      questionConcept: includeConceptQuestion ? parsed.questionConcept : null,
      questionInstance: parsed.questionInstance,
      questionType,
      generationSource: GENERATION_SOURCE,
      missReason: null,
      answerConcept: null,
      answerInstance: null,
      skipped: false,
      skipReason: null,
      costUsd: envelope.totalCostUsd,
      // Persisted verbatim so `grasp review` renders exactly what the judge
      // model saw — no re-fetch from git, no re-running the Phase 4 filter
      // against a working tree that may have moved on since.
      diffFiles: significantFiles,
    },
    [{ tag: parsed.conceptTag as string, answered: false }]
  );

  return { eventId, missReason: null, questionType };
}
