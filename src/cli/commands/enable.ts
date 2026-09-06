/**
 * `grasp enable`.  GOVERNED BY: §6.4
 *
 * Explicit global pause/resume, NOT part of setup. `disable` stops the service
 * and leaves all data, registrations, and hooks intact, so a user can silence
 * Grasp everywhere without unregistering anything.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { isDaemonRunning } from "../../daemon/daemon.js";
import { installService, type InstallOptions } from "../../daemon/service.js";

export function daemonTarget(): InstallOptions["target"] {
  return {
    node: process.execPath,
    script: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.js"),
  };
}

export async function runEnable(): Promise<{ exitCode: number }> {
  if (isDaemonRunning()) {
    process.stdout.write(chalk.dim("Grasp is already running.\n"));
    return { exitCode: 0 };
  }
  const result = await installService({ target: daemonTarget() });
  if (result.warning) process.stderr.write(chalk.yellow(`${result.warning}\n`));
  else process.stdout.write(chalk.green(`Grasp enabled (${result.mechanism}).\n`));
  return { exitCode: 0 };
}
