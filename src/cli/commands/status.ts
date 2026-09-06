/**
 * `grasp status`.  GOVERNED BY: §17, §9.6
 *
 * Reads the PID file and the database directly. It NEVER talks to the daemon
 * (§5.3) — there is nothing to talk to.
 */
import os from "node:os";
import chalk from "chalk";
import { loadConfig } from "../../config/config.js";
import { closeDatabase, openDatabaseWithResult } from "../../storage/db.js";
import { listProjects } from "../../storage/models/projects.js";
import { listPendingQuestions, listAllQuestions } from "../../storage/models/questions.js";
import { listConcepts } from "../../storage/models/concepts.js";
import { countFailures } from "../../storage/models/generationFailures.js";
import { isDaemonRunning } from "../../daemon/daemon.js";
import { getEffectiveTier } from "../../mastery/decay.js";
import { isExpired } from "../../review/queue.js";
import { gateModeFor } from "../../gate/gateModes.js";

export function formatUptime(startedAt: string, now = new Date()): string {
  const ms = now.getTime() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** `~/dev/my-app` reads better than the absolute path in a status list. */
export function tildify(target: string, home = os.homedir()): string {
  return target.startsWith(home) ? `~${target.slice(home.length)}` : target;
}

export function runStatus(options: { dbFile?: string } = {}): { exitCode: number; output: string } {
  const opened = openDatabaseWithResult(options.dbFile ? { file: options.dbFile } : {});
  const db = opened.db;
  try {
    if (opened.replacedForeign) {
      process.stderr.write(
        chalk.yellow(
          `An older or unrecognized database was moved to ${opened.replacedForeign} and replaced with a fresh one.\n`,
        ),
      );
    }
    const { config } = loadConfig();
    const lines: string[] = [];
    const daemon = isDaemonRunning();

    lines.push(
      daemon
        ? chalk.green(`Grasp — running (pid ${daemon.pid}, up ${formatUptime(daemon.startedAt)})`)
        : `${chalk.yellow("Grasp — not running")}. Start it with \`grasp enable\`.`,
    );

    const projects = listProjects(db);
    lines.push("", `Projects (${projects.length}):`);
    if (projects.length === 0) {
      lines.push(chalk.dim("  none yet — run `grasp init` inside a repo"));
    }
    for (const project of projects) {
      const pending = listPendingQuestions(db, project.id);
      const expired = pending.filter((q) => isExpired(q, config.questionStaleDays)).length;
      const live = pending.length - expired;
      const mode = gateModeFor(db, project.path, config.gateMode);
      // padEnd alone collapses the columns for a path longer than the width,
      // which is most real paths.
      const shown = tildify(project.path);
      lines.push(
        `  ${shown.padEnd(22)}  ${mode.padEnd(6)}  ${live} pending${expired > 0 ? ` · ${expired} expired` : ""}`,
      );
    }

    const all = listAllQuestions(db);
    const pendingCount = all.filter((q) => q.status === "pending").length;
    const answeredCount = all.filter((q) => q.status === "answered").length;
    const failures = countFailures(db);

    lines.push(
      "",
      `Questions: ${pendingCount} pending · ${answeredCount} answered` +
        (failures > 0
          ? ` · ${failures} generation failure${failures === 1 ? "" : "s"} (\`grasp retry\`)`
          : ""),
    );

    const concepts = listConcepts(db);
    const atReconstruct = concepts.filter(
      (concept) => getEffectiveTier(concept, config.decayWindows) === "reconstruct",
    ).length;
    lines.push(
      `Mastery:   ${concepts.length} concept${concepts.length === 1 ? "" : "s"} tracked · ${atReconstruct} at reconstruct`,
    );

    const output = `${lines.join("\n")}\n`;
    process.stdout.write(output);
    return { exitCode: 0, output };
  } finally {
    closeDatabase(db);
  }
}
