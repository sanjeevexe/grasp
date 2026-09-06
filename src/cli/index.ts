#!/usr/bin/env node
/**
 * CLI wiring.  GOVERNED BY: §16.2, §17
 *
 * THE ONLY FILE PERMITTED TO CALL `process.exit` (§3). Every command module
 * returns an exit code; this file is where one becomes a process exit, so the
 * rest of the codebase stays importable by the test suite.
 *
 * Exit codes (§16.2): 0 success · 1 unexpected error · 2 user/usage error ·
 * 3 hard gate block.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import chalk from "chalk";
import { runReview } from "./commands/review.js";
import { runInit } from "./commands/init.js";
import { runEnable } from "./commands/enable.js";
import { runDisable } from "./commands/disable.js";
import { Daemon } from "../daemon/daemon.js";
import { runPrecommit } from "./commands/precommit.js";
import { runScanCommand } from "./commands/scan.js";
import { runStatus } from "./commands/status.js";
import { runHistory } from "./commands/history.js";
import { runRetry } from "./commands/retry.js";
import { runReset } from "./commands/reset.js";
import { runSet } from "./commands/set.js";
import { runExport } from "./commands/export.js";
import { runUninstallHooks } from "./commands/uninstall-hooks.js";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_GATE_BLOCKED = 3;

function fail(error: unknown): never {
  // §16.1 — CLI diagnostics go to stderr; normal output goes to stdout.
  process.stderr.write(
    `${chalk.red("grasp:")} ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(EXIT_ERROR);
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("grasp")
    .description("Forces active comprehension of AI-generated code before you move on.")
    .version("0.1.0");

  program
    .command("init")
    .description("Register the current repo. Bootstraps the daemon on first run, then exits.")
    .option("--yes", "accept defaults without prompting")
    .action(async (options: { yes?: boolean }) => {
      const result = await runInit({ yes: options.yes });
      process.exit(result.exitCode);
    });

  program
    .command("enable")
    .description("Resume the background daemon globally.")
    .action(async () => {
      process.exit((await runEnable()).exitCode);
    });

  program
    .command("disable")
    .description("Pause the daemon globally. Data, registrations, and hooks preserved.")
    .action(async () => {
      process.exit((await runDisable()).exitCode);
    });

  // Hidden: the entry point the OS service manager launches (§6.2).
  program
    .command("__daemon", { hidden: true })
    .description("Run the resident daemon in the foreground.")
    .action(() => {
      new Daemon().start();
    });

  // Hidden: invoked by the pre-commit hook, never by a user (§13.2, §17).
  program
    .command("__precommit", { hidden: true })
    .description("Internal: the pre-commit gate check.")
    .action(async () => {
      process.exit((await runPrecommit()).exitCode);
    });

  program
    .command("scan")
    .description("Onboarding walk of existing code. --full bypasses the cap (with a warning).")
    .option("--full", "bypass the per-run question cap")
    .action(async (options: { full?: boolean }) => {
      process.exit((await runScanCommand({ full: options.full })).exitCode);
    });

  program
    .command("review")
    .description("Answer pending questions. Current project by default.")
    .option("--all", "answer across every registered project, including expired questions")
    .action(async (options: { all?: boolean }) => {
      const result = await runReview({ all: options.all });
      process.exit(result.exitCode);
    });

  program
    .command("retry")
    .description("Re-attempt all failed generation calls.")
    .action(async () => {
      process.exit((await runRetry()).exitCode);
    });

  program
    .command("status")
    .description("Daemon state, pending counts, projects, failures.")
    .action(() => {
      process.exit(runStatus().exitCode);
    });

  program
    .command("history")
    .description("Browse past answered questions.")
    .option("--tag <tag>", "only this concept tag")
    .action((options: { tag?: string }) => {
      process.exit(runHistory({ tag: options.tag }).exitCode);
    });

  program
    .command("set")
    .description("Edit config via dot-notation (e.g. decayWindows.trace 120).")
    .argument("<key>")
    .argument("<value>")
    .action((key: string, value: string) => {
      process.exit(runSet({ key, value }).exitCode);
    });

  program
    .command("reset")
    .description("Restore default config, or wipe history.")
    .argument("<target>", "config | history")
    .option("--yes", "skip the confirmation prompt")
    .action(async (target: string, options: { yes?: boolean }) => {
      const result = await runReset({ target: target as "config" | "history", yes: options.yes });
      process.exit(result.exitCode);
    });

  program
    .command("export")
    .description("Export question data.")
    .option("--anki", "tab-separated Anki cards")
    .option("--raw", "JSON dump")
    .option("--out <path>", "write to a file instead of stdout")
    .option("--tag <tag>", "only this concept tag")
    .option("--project", "only the current repo")
    .action(
      (options: {
        anki?: boolean;
        raw?: boolean;
        out?: string;
        tag?: string;
        project?: boolean;
      }) => {
        if (!options.anki && !options.raw) {
          process.stderr.write(chalk.red("Choose an export format: --anki or --raw\n"));
          process.exit(EXIT_USAGE);
        }
        const result = runExport({
          format: options.anki ? "anki" : "raw",
          out: options.out,
          tag: options.tag,
          project: options.project,
        });
        process.exit(result.exitCode);
      },
    );

  program
    .command("uninstall-hooks")
    .description("Remove Grasp git hooks from all repos, restoring originals.")
    .action(() => {
      process.exit(runUninstallHooks().exitCode);
    });

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  try {
    await buildProgram().parseAsync(argv);
  } catch (error) {
    fail(error);
  }
}

// `node dist/cli/index.js` runs the CLI; importing this module does not, which
// is what keeps §3's "importable with no side effects" true for the test suite.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) void main();
