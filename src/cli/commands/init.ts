/**
 * `grasp init` — the only command a user ever needs.  GOVERNED BY: §6.1
 *
 * MUST NOT STAY RESIDENT. The user closes the terminal; the daemon keeps
 * watching. The previous version of Grasp required a permanently-open second
 * terminal and that was its largest adoption blocker (§6.1).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import prompts from "prompts";
import { loadConfig } from "../../config/config.js";
import { closeDatabase, openDatabase } from "../../storage/db.js";
import { upsertProject } from "../../storage/models/projects.js";
import { populateSnapshot } from "../../capture/snapshot.js";
import { isDaemonRunning } from "../../daemon/daemon.js";
import { installService } from "../../daemon/service.js";
import { isSourceFile } from "../../daemon/parsers/index.js";
import { gateModeFor, syncHookForMode } from "../../gate/gateModes.js";
import { findGitRoot, resolveProjectPath, toProjectRelative } from "../../util/paths.js";
import { collectSourceFiles } from "../../util/walk.js";

export interface InitOptions {
  cwd?: string;
  dbFile?: string;
  /** Skips the scan prompt; tests and non-interactive shells use this. */
  yes?: boolean;
  noScan?: boolean;
  install?: typeof installService;
}

export interface InitOutcome {
  exitCode: number;
  projectPath?: string;
  created?: boolean;
  serviceMechanism?: string;
  scanSuggested?: boolean;
}

/** §6.1 step 5 — the heuristic for "this repo has substantial existing code". */
export const SCAN_SUGGESTION_FILES = 10;
export const SCAN_SUGGESTION_LOC = 500;

function daemonScriptPath(): string {
  // dist/cli/commands/init.js → dist/cli/index.js
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.js");
}

export async function runInit(options: InitOptions = {}): Promise<InitOutcome> {
  const cwd = options.cwd ?? process.cwd();

  // 1. Verify we are inside a git repo (§6.1 step 1).
  const repoRoot = findGitRoot(cwd);
  if (!repoRoot) {
    process.stderr.write(
      chalk.red("grasp init must be run inside a git repository.\n") +
        chalk.dim("Run `git init` first, then try again.\n"),
    );
    return { exitCode: 2 };
  }
  const projectPath = resolveProjectPath(repoRoot);
  const db = openDatabase(options.dbFile ? { file: options.dbFile } : {});

  try {
    const { config, warnings } = loadConfig({ projectRoot: projectPath });
    for (const warning of warnings) process.stderr.write(chalk.yellow(`warning: ${warning}\n`));

    // 2. Ensure the daemon exists (§6.1 step 2). Report, do not prompt.
    let serviceMechanism = "already running";
    if (!isDaemonRunning()) {
      const install = options.install ?? installService;
      const result = await install({
        target: { node: process.execPath, script: daemonScriptPath() },
        spawnDetached: () => {
          try {
            const child = spawn(process.execPath, [daemonScriptPath(), "__daemon"], {
              detached: true,
              stdio: "ignore",
            });
            child.unref();
            return true;
          } catch {
            return false;
          }
        },
      });
      serviceMechanism = result.mechanism;
      if (result.warning) process.stderr.write(chalk.yellow(`${result.warning}\n`));
      else process.stdout.write(chalk.dim(`Background service installed (${result.mechanism}).\n`));
    }

    // 3. Register the project (§6.1 step 3). Already registered → report, exit 0.
    const { row, created } = upsertProject(db, projectPath);
    process.stdout.write(
      created
        ? `${chalk.green("Tracking")} ${projectPath}\n`
        : chalk.dim(`Already tracking ${projectPath}\n`),
    );

    // 4. Populate the snapshot so the first captured diff is real (§6.1 step 4).
    const sourceFiles = collectSourceFiles(projectPath, config.ignorePatterns, isSourceFile);
    if (created) {
      populateSnapshot(
        projectPath,
        sourceFiles.map((file) => ({
          relativePath: toProjectRelative(projectPath, file),
          content: safeRead(file),
        })),
      );
    }

    // §13.1 — warn and hard need a pre-commit hook in this repo; soft must not
    // have one. Idempotent, so re-running init never double-installs.
    syncHookForMode(projectPath, gateModeFor(db, projectPath, config.gateMode));

    // 5. Offer a scan when there is substantial existing code (§6.1 step 5).
    const totalLoc = sourceFiles.reduce((sum, file) => sum + countLines(file), 0);
    const substantial =
      sourceFiles.length > SCAN_SUGGESTION_FILES || totalLoc > SCAN_SUGGESTION_LOC;
    let scanSuggested = false;

    if (substantial && created && !options.noScan) {
      scanSuggested = true;
      const shouldScan = options.yes
        ? false
        : (
            await prompts({
              type: "confirm",
              name: "value",
              message:
                "This repo has existing code. Scan it for onboarding before live tracking starts?",
              initial: false,
            })
          ).value === true;
      if (shouldScan) {
        process.stdout.write(chalk.dim("Run `grasp scan` to start the onboarding walk.\n"));
      }
    }

    process.stdout.write(
      chalk.dim(`Watching in the background. Answer questions any time with \`grasp review\`.\n`),
    );
    // 6. Exit immediately (§6.1 step 6) — never stay resident.
    return {
      exitCode: 0,
      projectPath: row.path,
      created,
      serviceMechanism,
      scanSuggested,
    };
  } finally {
    closeDatabase(db);
  }
}

function safeRead(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function countLines(file: string): number {
  return safeRead(file).split("\n").length;
}
