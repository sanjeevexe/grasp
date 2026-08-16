import * as path from "path";
import { execFileSync } from "child_process";
import { E2ELogger } from "./lib/log";
import { runScenario, Scenario } from "./lib/scenario";
import { cleanupAllScratch, claudeMode } from "./lib/env";

import { initScenarios } from "./scenarios/init.e2e";
import { gateScenarios } from "./scenarios/gate.e2e";
import { reviewScenarios } from "./scenarios/review.e2e";
import { scanScenarios } from "./scenarios/scan.e2e";
import { retryScenarios } from "./scenarios/retry.e2e";
import { setResetExportScenarios } from "./scenarios/setResetExport.e2e";
import { crossCuttingScenarios } from "./scenarios/crossCutting.e2e";
import { questionQualityScenarios } from "./scenarios/questionQuality.e2e";

/**
 * `npm run test:e2e` entrypoint. Runs every scenario in every module below,
 * NEVER stopping on a failure — each scenario is independently try/caught
 * by `runScenario` (see lib/scenario.ts), logged, and the run continues.
 * Prints a pass/fail summary and writes the full findings log at the end.
 * Deliberately not a `node:test` file (unlike the fast `npm test` suite) —
 * this is a standalone script, run directly with `node`, so it can control
 * its own "never stop on failure" behavior instead of inheriting
 * node:test's own runner semantics.
 */

function gitInfo(): { branch: string; commit: string } {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8" }).trim();
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    return { branch, commit };
  } catch {
    return { branch: "unknown", commit: "unknown" };
  }
}

async function main(): Promise<void> {
  const allScenarios: Scenario[] = [
    ...initScenarios,
    ...gateScenarios,
    ...reviewScenarios,
    ...scanScenarios,
    ...retryScenarios,
    ...setResetExportScenarios,
    ...crossCuttingScenarios,
    ...questionQualityScenarios,
  ];

  const logger = new E2ELogger();
  const { branch, commit } = gitInfo();

  process.stdout.write(`Grasp PTY e2e harness — ${allScenarios.length} scenario(s), claude mode: ${claudeMode()}\n`);
  process.stdout.write(`branch ${branch} @ ${commit}\n\n`);

  const startedAt = Date.now();
  for (const s of allScenarios) {
    await runScenario(s, logger);
  }
  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  const counts = logger.counts();
  process.stdout.write(`\n${"=".repeat(60)}\n`);
  process.stdout.write(
    `Done in ${durationSec}s — ${counts.scenariosPassed} passed, ${counts.scenariosFailed} failed. ` +
      `${counts.bug} BUG, ${counts.doc} DOC, ${counts.needsHuman} NEEDS-HUMAN finding(s).\n`
  );

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.resolve(process.cwd(), "test/e2e/logs", `run-${timestamp}.md`);
  logger.write(logPath, { branch, commit, claudeMode: claudeMode() });
  process.stdout.write(`Full log: ${logPath}\n`);

  const cleanup = cleanupAllScratch();
  process.stdout.write(`Cleaned up ${cleanup.removed} scratch dir tree(s)${cleanup.failed.length > 0 ? `; ${cleanup.failed.length} failed to remove` : ""}.\n`);

  process.exitCode = counts.scenariosFailed > 0 ? 1 : 0;
}

// Best-effort cleanup even on an unexpected crash or Ctrl+C — a leaked
// scratch temp directory is a minor annoyance; a leaked pty CHILD PROCESS
// is the thing this harness treats as unacceptable, and every pty spawn's
// own cleanup (test/fixtures/ptyDriver.py's try/finally) is already
// unconditional and independent of this handler, so this only needs to
// mop up temp directories.
process.on("SIGINT", () => {
  cleanupAllScratch();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanupAllScratch();
  process.exit(143);
});

main().catch((err) => {
  process.stderr.write(`Fatal error in e2e runner itself: ${(err as Error).stack ?? err}\n`);
  cleanupAllScratch();
  process.exitCode = 1;
});
