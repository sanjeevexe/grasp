/**
 * `grasp disable`.  GOVERNED BY: §6.4
 *
 * Explicit global pause. Stops the service and leaves ALL data, registrations,
 * and hooks intact, so a user can silence Grasp everywhere without unregistering
 * anything (§6.4). Returns an exit code; never calls process.exit (§3).
 */
import chalk from "chalk";
import { isDaemonRunning, removePidFile } from "../../daemon/daemon.js";
import { uninstallService } from "../../daemon/service.js";
import { daemonTarget } from "./enable.js";

export async function runDisable(): Promise<{ exitCode: number }> {
  await uninstallService({ target: daemonTarget() });
  const running = isDaemonRunning();
  if (running) {
    try {
      process.kill(running.pid, "SIGTERM");
    } catch {
      // Already gone between the check and the signal.
    }
  }
  removePidFile();
  process.stdout.write(
    chalk.dim(
      "Grasp paused. Data, registrations, and git hooks are untouched — `grasp enable` resumes.\n",
    ),
  );
  return { exitCode: 0 };
}
