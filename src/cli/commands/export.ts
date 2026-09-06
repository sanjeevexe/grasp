/**
 * `grasp export --anki|--raw`.  GOVERNED BY: §20
 *
 * Writes to stdout by default so it can be piped; `--out <path>` writes a file.
 */
import fs from "node:fs";
import chalk from "chalk";
import { closeDatabase, openDatabase } from "../../storage/db.js";
import { getProjectByPath } from "../../storage/models/projects.js";
import { renderAnkiExport } from "../../export/anki.js";
import { renderRawExport, selectQuestions, type ExportFilters } from "../../export/raw.js";
import { findGitRoot, resolveProjectPath } from "../../util/paths.js";

export interface ExportOptions {
  format: "anki" | "raw";
  out?: string;
  tag?: string;
  since?: string;
  until?: string;
  /** Limit to the current repo. */
  project?: boolean;
  cwd?: string;
  dbFile?: string;
}

export function runExport(options: ExportOptions): { exitCode: number; output: string } {
  const db = openDatabase(options.dbFile ? { file: options.dbFile } : {});
  try {
    const filters: ExportFilters = { tag: options.tag, since: options.since, until: options.until };

    if (options.project) {
      const repoRoot = findGitRoot(options.cwd ?? process.cwd());
      const project = repoRoot ? getProjectByPath(db, resolveProjectPath(repoRoot)) : undefined;
      if (!project) {
        process.stderr.write(chalk.red("Not inside a registered project.\n"));
        return { exitCode: 2, output: "" };
      }
      filters.projectId = project.id;
    }

    // §20 — ALL statuses, including pending and expired: an unanswered question
    // with a sample answer is still a valid flashcard.
    const questions = selectQuestions(db, filters);
    const output =
      options.format === "anki" ? renderAnkiExport(questions) : renderRawExport(db, questions);

    if (options.out) {
      fs.writeFileSync(options.out, output);
      process.stderr.write(
        chalk.dim(`${questions.length} question(s) written to ${options.out}\n`),
      );
    } else {
      process.stdout.write(output);
    }
    return { exitCode: 0, output };
  } finally {
    closeDatabase(db);
  }
}
