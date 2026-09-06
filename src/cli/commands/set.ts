/**
 * `grasp set <key> <value>`.  GOVERNED BY: §18.3, §16.2
 *
 * Unknown key or bad type → exit 2 with a clear message, and NEVER a written
 * config: an invalid config on disk is worse than a rejected command.
 */
import chalk from "chalk";
import fs from "node:fs";
import { loadConfig, saveConfig } from "../../config/config.js";
import { configKeyPaths, setConfigValue } from "../../config/set.js";
import { closeDatabase, openDatabase } from "../../storage/db.js";
import { listProjects } from "../../storage/models/projects.js";
import { gateModeFor, syncHookForMode } from "../../gate/gateModes.js";
import type { GateMode } from "../../types/index.js";

export interface SetOptions {
  key: string;
  value: string;
  globalFile?: string;
  dbFile?: string;
}

/**
 * §13.1 — the hook exists only for `warn` and `hard`, so changing the mode has
 * to add or remove it everywhere. Without this, `grasp set gateMode hard`
 * silently does nothing until the next `grasp init`.
 */
function resyncHooks(dbFile: string | undefined, gateMode: GateMode): void {
  const db = openDatabase(dbFile ? { file: dbFile } : {});
  try {
    for (const project of listProjects(db)) {
      if (!fs.existsSync(project.path)) continue;
      syncHookForMode(project.path, gateModeFor(db, project.path, gateMode));
    }
  } finally {
    closeDatabase(db);
  }
}

export function runSet(options: SetOptions): { exitCode: number } {
  const { config } = loadConfig({ globalFile: options.globalFile });
  const result = setConfigValue(config, options.key, options.value);

  if (!result.ok) {
    process.stderr.write(chalk.red(`${result.error}\n`));
    if (/unknown config key/.test(result.error)) {
      const near = configKeyPaths()
        .map((entry) => entry.path)
        .filter((candidate) => candidate.includes(options.key.split(".")[0]))
        .slice(0, 5);
      if (near.length > 0) process.stderr.write(chalk.dim(`Did you mean: ${near.join(", ")}?\n`));
    }
    return { exitCode: 2 };
  }

  saveConfig(result.config, options.globalFile);
  if (options.key === "gateMode") resyncHooks(options.dbFile, result.parsed as GateMode);
  process.stdout.write(`${options.key} = ${JSON.stringify(result.parsed)}\n`);
  return { exitCode: 0 };
}
