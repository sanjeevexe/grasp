/**
 * `grasp review [--all]`.  GOVERNED BY: §14.1, §14.2, §16.2, §16.5
 *
 * Reads the persisted queue and nothing else: no daemon connection, no
 * requirement that anything be running (§14.1).
 */
import path from "node:path";
import chalk from "chalk";
import { loadConfig } from "../../config/config.js";
import { closeDatabase, openDatabase } from "../../storage/db.js";
import { getProjectByPath, listProjects } from "../../storage/models/projects.js";
import { listPendingQuestions } from "../../storage/models/questions.js";
import { createTerminalIo, type ReviewIo } from "../../review/io.js";
import { resolveReviewKeys } from "../../review/keys.js";
import { orderQueue, partitionExpired } from "../../review/queue.js";
import { runReviewSession, type SessionDeps } from "../../review/reviewSession.js";
import { applyAnsweredQuestion } from "../../mastery/apply.js";
import { getEffectiveTier } from "../../mastery/decay.js";
import { getConcept } from "../../storage/models/concepts.js";
import { acquireLock, isLockHandle } from "../../util/lock.js";
import { graspReviewLockPath } from "../../util/home.js";
import { resolveProjectPath } from "../../util/paths.js";

export interface ReviewOptions {
  all?: boolean;
  cwd?: string;
  /** Injected by tests; the CLI uses the terminal. */
  io?: ReviewIo;
  dbFile?: string;
}

export interface ReviewOutcome {
  exitCode: number;
  answered: number;
  skipped: number;
}

export async function runReview(options: ReviewOptions = {}): Promise<ReviewOutcome> {
  const cwd = options.cwd ?? process.cwd();
  const lock = acquireLock(graspReviewLockPath());
  if (!isLockHandle(lock)) {
    process.stderr.write(
      chalk.yellow(
        `Another \`grasp review\` is already running (pid ${lock.held.pid}, since ${lock.held.acquiredAt}).\n`,
      ),
    );
    return { exitCode: 2, answered: 0, skipped: 0 };
  }

  const db = openDatabase(options.dbFile ? { file: options.dbFile } : {});
  let io: ReviewIo | undefined;

  try {
    // §14.1 — directory-aware by default; outside any registered project, or
    // with --all, the queue spans every project.
    const projectRoot = resolveProjectPath(cwd);
    const project = options.all ? undefined : getProjectByPath(db, projectRoot);
    const scoped = !options.all && project !== undefined;

    const { config, warnings } = loadConfig({ projectRoot: scoped ? projectRoot : undefined });
    // §14.4 — surface an unusable binding before the session starts, not after
    // the user presses a key that does nothing.
    for (const warning of warnings) process.stderr.write(chalk.yellow(`warning: ${warning}\n`));
    const { keys } = resolveReviewKeys(config.review?.keys ?? {});
    // Created here, not before the config load, so the reader and the key hint
    // line always agree on the live bindings.
    io = options.io ?? createTerminalIo({ keys });
    const pending = listPendingQuestions(db, scoped ? project.id : undefined);
    const { expired } = partitionExpired(pending, config.questionStaleDays);
    const queue = orderQueue(pending, {
      staleDays: config.questionStaleDays,
      includeExpired: options.all === true,
    });

    if (queue.length === 0) {
      const scopeLabel = scoped ? path.basename(projectRoot) : "any project";
      io.write(chalk.dim(`Nothing pending for ${scopeLabel}.\n`));
      if (expired.length > 0 && !options.all) {
        io.write(
          chalk.dim(`${expired.length} expired question(s) — see \`grasp review --all\`.\n`),
        );
      }
      if (!scoped && !options.all && listProjects(db).length > 0) {
        io.write(chalk.dim("(not inside a registered project, so this covered all of them)\n"));
      }
      return { exitCode: 0, answered: 0, skipped: 0 };
    }

    io.write(
      chalk.dim(
        `${queue.length} question(s) pending${expired.length > 0 ? `, ${expired.length} expired` : ""}.\n`,
      ),
    );

    const settings = {
      minDiffCount: config.synthesisTrigger.minDiffCount,
      minMasteryTier: config.synthesisTrigger.minMasteryTier,
      decayWindows: config.decayWindows,
    };
    const deps: SessionDeps = {
      db,
      io,
      keys,
      // §11.2 — decay is computed here, at read time, never stored.
      effectiveTier: (tag) => getEffectiveTier(getConcept(db, tag), config.decayWindows),
      onAnswered: (result) => applyAnsweredQuestion(db, result, settings),
    };
    const result = await runReviewSession(queue, deps);

    const answered = result.answered.filter((a) => !a.skipped).length;
    const skipped = result.answered.filter((a) => a.skipped).length;
    io.write(
      chalk.dim(
        `\n${answered} answered, ${skipped} skipped${result.quit ? ", session ended early" : ""}.\n`,
      ),
    );
    return { exitCode: 0, answered, skipped };
  } finally {
    io?.close();
    closeDatabase(db);
    lock.release();
  }
}
