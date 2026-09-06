/**
 * `grasp reset config|history`.  GOVERNED BY: §17, §16.2
 *
 * Destructive, so it confirms before doing anything unless `--yes` is given.
 */
import fs from "node:fs";
import chalk from "chalk";
import prompts from "prompts";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import { saveConfig, type ConfigWithUnknown } from "../../config/config.js";
import { closeDatabase, openDatabase } from "../../storage/db.js";
import { graspConfigPath, graspDbPath } from "../../util/home.js";

export interface ResetOptions {
  target: "config" | "history";
  yes?: boolean;
  dbFile?: string;
  configFile?: string;
}

export async function runReset(options: ResetOptions): Promise<{ exitCode: number }> {
  if (options.target !== "config" && options.target !== "history") {
    process.stderr.write(
      chalk.red(`Unknown reset target "${String(options.target)}" — use config or history.\n`),
    );
    return { exitCode: 2 };
  }

  if (!options.yes) {
    const message =
      options.target === "config"
        ? "Restore the default configuration? Your API key will be cleared."
        : "Wipe every question, answer, and mastery record? This cannot be undone.";
    const confirmed = await prompts({ type: "confirm", name: "value", message, initial: false });
    if (confirmed.value !== true) {
      process.stdout.write(chalk.dim("Cancelled.\n"));
      return { exitCode: 0 };
    }
  }

  if (options.target === "config") {
    saveConfig(DEFAULT_CONFIG as ConfigWithUnknown, options.configFile);
    process.stdout.write(
      chalk.green(`Configuration reset (${options.configFile ?? graspConfigPath()}).\n`),
    );
    return { exitCode: 0 };
  }

  // history: drop the database file entirely and recreate an empty schema, so
  // no stale rows survive in a table someone forgot to clear.
  const file = options.dbFile ?? graspDbPath();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
  closeDatabase(openDatabase({ file }));
  process.stdout.write(
    chalk.green("History wiped. Registered projects and git hooks are untouched.\n"),
  );
  return { exitCode: 0 };
}
