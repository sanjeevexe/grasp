/**
 * Batch → questions.  GOVERNED BY: §4.1, §7.5, §8.2, §8.3, §9.1
 *
 * The shared path both live capture (§6) and `grasp scan` (§12) run through:
 * "everything downstream MUST be shared code, not duplicated" (§4.3).
 *
 * THE CHECKPOINT ADVANCE RULE (§8.3) IS ENFORCED HERE, IN ONE PLACE:
 *
 *   advance ⟺ the batch reached a terminal state
 *             (questions persisted, or explicitly filtered as not worth asking)
 *
 * Never on API failure, rate-limit deferral, malformed output, or crash. Every
 * return path below states which it is, and the caller advances only when
 * `advanceCheckpoint` is true. Nothing else in the codebase writes the
 * checkpoint.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MAX_KNOWN_TAGS } from "../generation/prompts/systemPrompt.js";
import { generateQuestions, type GenerationDeps } from "../generation/generateQuestion.js";
import { getEffectiveTier, type DecayWindows } from "../mastery/decay.js";
import { onNewQuestionForTag, type SynthesisSettings } from "../synthesis/trigger.js";
import { getConcept, listTagsByRecency } from "../storage/models/concepts.js";
import { recordFailure } from "../storage/models/generationFailures.js";
import { insertQuestion, questionExistsForHash } from "../storage/models/questions.js";
import { withTransaction } from "../storage/db.js";
import { countDiffLines, decide, type RateLimitSettings } from "../capture/rateLimit.js";
import { filterDiffs, type DiffFilterSettings } from "../capture/diffFilter.js";
import { hashDiff, type FileDiff } from "../capture/snapshot.js";
import type { GenerationInput, QuestionType, Tier } from "../types/index.js";
import type { Logger } from "./logger.js";

export interface PipelineSettings extends DiffFilterSettings, RateLimitSettings, SynthesisSettings {
  decayWindows: DecayWindows;
}

export type PipelineOutcome =
  /** Terminal: questions were persisted. Advance (§8.3). */
  | { kind: "questions"; ids: number[]; advanceCheckpoint: true }
  /** Terminal: nothing here is worth asking about. Advance (§8.3). */
  | { kind: "skipped"; reason: string; advanceCheckpoint: true }
  /** Terminal: every file was filtered as noise (§7.5). Advance. */
  | { kind: "filtered"; advanceCheckpoint: true }
  /** Terminal: this exact diff already produced a question. Advance. */
  | { kind: "duplicate"; advanceCheckpoint: true }
  /** NOT terminal: over the hourly cap, rolls into the next batch (§8.2). */
  | { kind: "deferred"; advanceCheckpoint: false }
  /** NOT terminal: the call failed. The payload is re-runnable (§9.6). */
  | { kind: "failed"; reason: string; failureId: number | null; advanceCheckpoint: false };

export interface PipelineInput {
  projectId: number;
  files: FileDiff[];
  origin: "live" | "scan";
  /** §7.6 — ordering signal only; MUST NEVER suppress a question. */
  authorConfidence?: number | null;
}

/** §9.3 — the model's tagging context, capped and most-recently-demonstrated first. */
function masteryContextFor(
  db: DatabaseSync,
  tags: string[],
  windows: DecayWindows,
): Record<string, Tier> {
  const context: Record<string, Tier> = {};
  for (const tag of tags) {
    context[tag] = getEffectiveTier(getConcept(db, tag), windows);
  }
  return context;
}

export async function runPipeline(
  db: DatabaseSync,
  input: PipelineInput,
  settings: PipelineSettings,
  deps: GenerationDeps & { logger?: Logger; now?: Date } = {},
): Promise<PipelineOutcome> {
  const now = deps.now ?? new Date();
  const logger = deps.logger;

  // §7.5 — free local filter first, before anything costs money (§2.6).
  // In scan mode only `ignorePatterns` applies (§12.2).
  const { kept, rejected } = filterDiffs(input.files, settings, { mode: input.origin });
  if (kept.length === 0) {
    logger?.debug("batch filtered as noise", {
      projectId: input.projectId,
      files: input.files.length,
      rejected: rejected.length,
    });
    // Nothing worth asking about: terminal, so the checkpoint advances (§7.5).
    return { kind: "filtered", advanceCheckpoint: true };
  }

  const combinedDiff = kept.map((file) => file.diff).join("\n");
  const diffHash = hashDiff(combinedDiff);

  // §19 dedup: the same diff must never produce two questions.
  if (questionExistsForHash(db, input.projectId, "diff_hash", diffHash)) {
    logger?.debug("batch already captured", { projectId: input.projectId, files: kept.length });
    return { kind: "duplicate", advanceCheckpoint: true };
  }

  // §8.1/§8.2 — the cap, and the escape valve that bounds the rollup.
  const decision = decide(db, countDiffLines(combinedDiff), settings, now);
  if (!decision.generate) {
    logger?.info("over hourly cap, rolling into the next batch", {
      projectId: input.projectId,
      files: kept.length,
    });
    // NOT terminal (§8.3): the changes stay un-captured and roll forward.
    return { kind: "deferred", advanceCheckpoint: false };
  }

  const knownTags = listTagsByRecency(db, MAX_KNOWN_TAGS);
  const generationInput: GenerationInput = {
    kind: input.origin === "scan" ? "scan" : "live",
    projectId: input.projectId,
    files: kept.map((file) => file.path),
    masteryContext: masteryContextFor(db, knownTags, settings.decayWindows),
    knownTags,
    ...(input.origin === "scan" ? { section: combinedDiff } : { diff: combinedDiff }),
  } as GenerationInput;

  const started = Date.now();
  const outcome = await generateQuestions(generationInput, deps);
  logger?.info("generation call finished", {
    projectId: input.projectId,
    files: kept.length,
    ok: outcome.ok,
    ms: Date.now() - started,
  });

  if (!outcome.ok) {
    // NOT terminal (§8.3, §9.6): record the re-runnable payload and leave the
    // checkpoint where it is, so the same changes come back.
    const failureId = recordFailure(db, {
      projectId: input.projectId,
      kind: input.origin,
      payload: outcome.payload,
      error: outcome.error,
    });
    logger?.warn("generation failed", {
      projectId: input.projectId,
      reason: outcome.reason,
      attempts: outcome.attempts,
    });
    return { kind: "failed", reason: outcome.reason, failureId, advanceCheckpoint: false };
  }

  if (outcome.result.skip) {
    // §9.2 step 1 — explicitly not worth asking about: terminal, advance.
    logger?.debug("model judged the batch not worth asking about", { projectId: input.projectId });
    return { kind: "skipped", reason: outcome.result.skip_reason ?? "", advanceCheckpoint: true };
  }

  const batchId = randomUUID();
  const byPath = new Map(kept.map((file) => [file.path, file]));

  const ids = withTransaction(db, () =>
    outcome.result.questions.map((question) => {
      // Only the files this question is actually about (§9.2 step 10, §13.3).
      const snippet = question.files
        .map((file) => byPath.get(file)?.diff)
        .filter((diff): diff is string => Boolean(diff))
        .join("\n");

      const id = insertQuestion(db, {
        project_id: input.projectId,
        type: question.tier as QuestionType,
        concept_tag: question.concept_tag,
        origin: input.origin,
        batch_id: batchId,
        diff_hash: input.origin === "live" ? diffHash : null,
        file_hash: input.origin === "scan" ? diffHash : null,
        question_text: question.question,
        sample_answer: question.sample_answer,
        teaching_card_text: question.teaching_card?.body ?? null,
        teaching_card_deeper: question.teaching_card?.deeper ?? null,
        hint: question.hint,
        scaffold: question.scaffold,
        code_snippet: snippet || combinedDiff,
        author_confidence: input.authorConfidence ?? null,
        files: question.files,
      });

      // §11.8 — a new question under a struggled tag re-surfaces its checkpoint.
      onNewQuestionForTag(db, question.concept_tag, settings, now);
      return id;
    }),
  );

  for (const warning of outcome.warnings) logger?.debug("generation warning", { warning });

  // Terminal: questions persisted, so the checkpoint may advance (§8.3).
  return { kind: "questions", ids, advanceCheckpoint: true };
}
