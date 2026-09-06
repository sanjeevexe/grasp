/**
 * `grasp __precommit` — hidden, invoked by the git hook.  GOVERNED BY: §13, §16.2
 *
 * Exit codes: 0 to let the commit through, 3 to block it (§16.2). `warn` prints
 * the same list and still exits 0 — the difference between the modes is the exit
 * code and nothing else.
 */
import chalk from "chalk";
import { loadConfig } from "../../config/config.js";
import { closeDatabase, openDatabase } from "../../storage/db.js";
import { getProjectByPath } from "../../storage/models/projects.js";
import { gateModeFor } from "../../gate/gateModes.js";
import {
  questionsBlockingCommit,
  renderBlockedMessage,
  stagedFiles,
  type GitRunner,
} from "../../gate/gitHook.js";
import { findGitRoot, resolveProjectPath } from "../../util/paths.js";

export interface PrecommitOptions {
  cwd?: string;
  dbFile?: string;
  git?: GitRunner;
}

export async function runPrecommit(options: PrecommitOptions = {}): Promise<{ exitCode: number }> {
  const repoRoot = findGitRoot(options.cwd ?? process.cwd());
  // Not a repo, or not a repo Grasp tracks: never block a commit.
  if (!repoRoot) return { exitCode: 0 };

  const projectPath = resolveProjectPath(repoRoot);
  const db = openDatabase(options.dbFile ? { file: options.dbFile } : {});

  try {
    const project = getProjectByPath(db, projectPath);
    if (!project) return { exitCode: 0 };

    const { config } = loadConfig({ projectRoot: projectPath });
    const mode = gateModeFor(db, projectPath, config.gateMode);
    if (mode === "soft") return { exitCode: 0 };

    const staged = await stagedFiles(projectPath, options.git);
    const blocking = questionsBlockingCommit(db, project.id, staged, {
      staleDays: config.questionStaleDays,
    });
    if (blocking.length === 0) return { exitCode: 0 };

    const message = renderBlockedMessage(blocking);
    if (mode === "warn") {
      // §13 — print the list, let the commit proceed.
      process.stderr.write(
        chalk.yellow(
          message.replace("commit blocked (hard gate)", "pending questions (warn gate)"),
        ),
      );
      return { exitCode: 0 };
    }

    process.stderr.write(chalk.yellow(message));
    return { exitCode: 3 };
  } finally {
    closeDatabase(db);
  }
}
