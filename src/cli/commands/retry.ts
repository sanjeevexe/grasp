/**
 * `grasp retry`.  GOVERNED BY: §9.6, §19.1
 *
 * Replays stored `generation_failures` payloads, increments `attempts`, and
 * deletes the row on success. Rows at `attempts >= 5` are REPORTED but not
 * auto-retried (§19.1).
 */
import chalk from "chalk";
import { loadConfig } from "../../config/config.js";
import { closeDatabase, openDatabase, withTransaction } from "../../storage/db.js";
import {
  MAX_RETRY_ATTEMPTS,
  deleteFailure,
  listFailures,
  listRetryableFailures,
  parsePayload,
  recordRetryAttempt,
} from "../../storage/models/generationFailures.js";
import { insertQuestion } from "../../storage/models/questions.js";
import { generateQuestions, type GenerationDeps } from "../../generation/generateQuestion.js";
import { onNewQuestionForTag } from "../../synthesis/trigger.js";
import type { GenerationInput, QuestionType } from "../../types/index.js";

export interface RetryOptions {
  dbFile?: string;
  /** Injected by tests; production resolves the provider from config (§6.3). */
  deps?: GenerationDeps;
}

export async function runRetry(
  options: RetryOptions = {},
): Promise<{ exitCode: number; recovered: number }> {
  const db = openDatabase(options.dbFile ? { file: options.dbFile } : {});
  try {
    const { config } = loadConfig();
    const all = listFailures(db);
    const retryable = listRetryableFailures(db);
    const exhausted = all.length - retryable.length;

    if (all.length === 0) {
      process.stdout.write(chalk.dim("No failed generation calls.\n"));
      return { exitCode: 0, recovered: 0 };
    }

    let recovered = 0;
    for (const failure of retryable) {
      const payload = parsePayload<GenerationInput>(failure);
      if (!payload) {
        recordRetryAttempt(db, failure.id, "payload could not be parsed");
        continue;
      }

      const outcome = await generateQuestions(payload, {
        providerSetting: config.provider,
        apiKey: config.apiKey,
        model: config.model,
        ...options.deps,
      });

      if (!outcome.ok) {
        recordRetryAttempt(db, failure.id, outcome.error);
        continue;
      }

      if (!outcome.result.skip) {
        withTransaction(db, () => {
          for (const question of outcome.result.questions) {
            insertQuestion(db, {
              project_id: failure.project_id ?? 0,
              type: question.tier as QuestionType,
              concept_tag: question.concept_tag,
              origin: failure.kind === "synthesis" ? "synthesis" : failure.kind,
              question_text: question.question,
              sample_answer: question.sample_answer,
              teaching_card_text: question.teaching_card?.body ?? null,
              teaching_card_deeper: question.teaching_card?.deeper ?? null,
              hint: question.hint,
              scaffold: question.scaffold,
              code_snippet: payload.kind === "live" ? payload.diff : payload.section,
              files: question.files,
            });
            onNewQuestionForTag(db, question.concept_tag, {
              minDiffCount: config.synthesisTrigger.minDiffCount,
              minMasteryTier: config.synthesisTrigger.minMasteryTier,
              decayWindows: config.decayWindows,
            });
          }
        });
        recovered += outcome.result.questions.length;
      }
      // Success — including an explicit skip — retires the failure.
      deleteFailure(db, failure.id);
    }

    process.stdout.write(
      `${chalk.green(`${recovered} question(s)`)} recovered from ${retryable.length} failed call(s).\n`,
    );
    if (exhausted > 0) {
      process.stdout.write(
        chalk.dim(
          `${exhausted} failure(s) have hit ${MAX_RETRY_ATTEMPTS} attempts and are no longer retried automatically.\n`,
        ),
      );
    }
    return { exitCode: 0, recovered };
  } finally {
    closeDatabase(db);
  }
}
