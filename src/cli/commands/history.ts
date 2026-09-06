/**
 * `grasp history [--tag <t>]`.  GOVERNED BY: §17, §2.1
 *
 * Browsing only. The stored `user_answer` is shown back verbatim and is NEVER
 * evaluated (§2.1) — this command displays what happened, it does not judge it.
 */
import chalk from "chalk";
import { closeDatabase, openDatabase } from "../../storage/db.js";
import { listAllQuestions, listQuestionsByTag } from "../../storage/models/questions.js";

export interface HistoryOptions {
  tag?: string;
  limit?: number;
  dbFile?: string;
}

const ASSESSMENT_LABEL: Record<string, string> = {
  nailed_it: "nailed it",
  mostly_there: "mostly there",
  way_off: "way off",
};

export function runHistory(options: HistoryOptions = {}): { exitCode: number } {
  const db = openDatabase(options.dbFile ? { file: options.dbFile } : {});
  try {
    const questions = (options.tag ? listQuestionsByTag(db, options.tag) : listAllQuestions(db))
      .filter((question) => question.status !== "pending")
      .slice(0, options.limit ?? 50);

    if (questions.length === 0) {
      process.stdout.write(
        chalk.dim(
          options.tag
            ? `Nothing answered yet under "${options.tag}".\n`
            : "Nothing answered yet.\n",
        ),
      );
      return { exitCode: 0 };
    }

    for (const question of questions) {
      const when = question.answered_at?.slice(0, 10) ?? "";
      const assessment = question.self_assessment
        ? ASSESSMENT_LABEL[question.self_assessment]
        : "skipped";
      const assisted =
        question.assistance_level !== "none" ? chalk.dim(` (${question.assistance_level})`) : "";

      process.stdout.write(
        `\n${chalk.dim(when)}  ${chalk.cyan(question.concept_tag ?? "untagged")}  ` +
          `${chalk.bold(question.type)}  ${assessment}${assisted}\n`,
      );
      process.stdout.write(`${question.question_text}\n`);
      if (question.user_answer) {
        process.stdout.write(chalk.dim(`you: ${question.user_answer}\n`));
      }
    }
    return { exitCode: 0 };
  } finally {
    closeDatabase(db);
  }
}
