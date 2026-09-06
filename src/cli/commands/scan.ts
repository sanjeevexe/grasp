/**
 * `grasp scan [--full]`.  GOVERNED BY: §8.4, §12, §16.5
 */
import chalk from "chalk";
import path from "node:path";
import prompts from "prompts";
import { loadConfig } from "../../config/config.js";
import { closeDatabase, openDatabase } from "../../storage/db.js";
import { getProjectByPath } from "../../storage/models/projects.js";
import { runScan, type ScanSettings } from "../../scan/scanRunner.js";
import { acquireLock, isLockHandle } from "../../util/lock.js";
import { graspHome } from "../../util/home.js";
import { findGitRoot, resolveProjectPath } from "../../util/paths.js";
import { createLogger } from "../../daemon/logger.js";

export interface ScanCommandOptions {
  full?: boolean;
  cwd?: string;
  dbFile?: string;
  /** Skips the --full confirmation; tests and CI use this. */
  yes?: boolean;
}

export async function runScanCommand(
  options: ScanCommandOptions = {},
): Promise<{ exitCode: number }> {
  const repoRoot = findGitRoot(options.cwd ?? process.cwd());
  if (!repoRoot) {
    process.stderr.write(chalk.red("grasp scan must be run inside a git repository.\n"));
    return { exitCode: 2 };
  }
  const projectPath = resolveProjectPath(repoRoot);
  const db = openDatabase(options.dbFile ? { file: options.dbFile } : {});

  try {
    const project = getProjectByPath(db, projectPath);
    if (!project) {
      process.stderr.write(chalk.red("This repo is not tracked yet — run `grasp init` first.\n"));
      return { exitCode: 2 };
    }

    // §16.5 — one scan per project at a time.
    const lock = acquireLock(path.join(graspHome(), `scan-${project.id}.lock`));
    if (!isLockHandle(lock)) {
      process.stderr.write(
        chalk.yellow(`A scan is already running for this project (pid ${lock.held.pid}).\n`),
      );
      return { exitCode: 2 };
    }

    try {
      const { config, warnings } = loadConfig({ projectRoot: projectPath });
      for (const warning of warnings) process.stderr.write(chalk.yellow(`warning: ${warning}\n`));

      // §8.4 — --full MUST print an explicit cost warning and confirm.
      if (options.full && !options.yes) {
        process.stdout.write(
          chalk.yellow(
            "\n--full removes the question cap for this run.\n" +
              `Every eligible file is sent to ${config.model}, one call per file or section.\n` +
              (config.provider === "api"
                ? "That is billed to your API key.\n"
                : "On the Claude Code path that draws down the same subscription rate limit your editor uses.\n"),
          ),
        );
        const confirmed = await prompts({
          type: "confirm",
          name: "value",
          message: "Continue with an uncapped scan?",
          initial: false,
        });
        if (confirmed.value !== true) {
          process.stdout.write(chalk.dim("Cancelled.\n"));
          return { exitCode: 0 };
        }
      }

      const settings: ScanSettings = {
        minLines: config.diffSizeThreshold.minLines,
        ignorePatterns: config.ignorePatterns,
        maxQuestionsPerHour: config.maxQuestionsPerHour,
        maxDiffLines: config.maxDiffLines,
        minDiffCount: config.synthesisTrigger.minDiffCount,
        minMasteryTier: config.synthesisTrigger.minMasteryTier,
        decayWindows: config.decayWindows,
        scanQuestionsCap: config.scanQuestionsCap,
      };

      const result = await runScan(
        db,
        {
          projectId: project.id,
          projectPath,
          full: options.full,
          // §12.2 — scan is long-running and interactive-blocking, so it must
          // never look hung.
          onProgress: (line) => process.stdout.write(chalk.dim(`${line}\n`)),
          logger: createLogger(),
        },
        settings,
        { providerSetting: config.provider, apiKey: config.apiKey, model: config.model },
      );

      process.stdout.write(
        `\n${chalk.green(`${result.questionsCreated} question(s)`)} from ${result.filesScanned} file(s)` +
          `${result.filesSkippedUnchanged > 0 ? `, ${result.filesSkippedUnchanged} unchanged` : ""}.\n`,
      );
      if (result.cappedOut) {
        process.stdout.write(
          chalk.dim(
            "Stopped at the scan cap — run `grasp scan` again to continue where it left off.\n",
          ),
        );
      }
      if (result.eligibleSynthesisTags.length > 0) {
        process.stdout.write(
          chalk.dim(`Synthesis checkpoint ready: ${result.eligibleSynthesisTags.join(", ")}\n`),
        );
      }
      process.stdout.write(chalk.dim("Answer them any time with `grasp review`.\n"));
      return { exitCode: 0 };
    } finally {
      lock.release();
    }
  } finally {
    closeDatabase(db);
  }
}
