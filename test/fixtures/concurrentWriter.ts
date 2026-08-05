/**
 * Spawnable fixture (not itself a test): opens the DB at argv[2] and writes
 * `count` events in `batches` separate transactions, so each process makes
 * several distinct lock-acquisition attempts rather than one. Used by
 * test/concurrency.test.ts to launch several real OS processes against the
 * same SQLite file nearly simultaneously — matching how Codex originally
 * reproduced "database is locked" (several independent CLI invocations at
 * once), not a single-process simulation of it.
 */
import { openStore, insertEvent } from "../../src/store";

const dbPath = process.argv[2];
const workerId = process.argv[3];
const rowsPerBatch = Number(process.argv[4] || "5");
const batches = Number(process.argv[5] || "6");

/**
 * Synchronous busy-wait, purely to widen this transaction's write-lock hold
 * time. Without this, a real `insertEvent` transaction on this tiny
 * workload completes in far less time than it takes the OS to even finish
 * scheduling/starting the other sibling processes, so two processes are
 * essentially never *actually* mid-transaction at the same wall-clock
 * moment regardless of busy_timeout — the test would pass even with the
 * fix disabled, silently proving nothing. Widening the window makes
 * contention the expected case, not a rare scheduling accident, which is
 * what makes this a real regression test rather than a coin flip.
 */
function busyWaitMs(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // spin
  }
}

const db = openStore(dbPath);
try {
  for (let b = 0; b < batches; b++) {
    const insertBatch = db.transaction(() => {
      for (let i = 0; i < rowsPerBatch; i++) {
        insertEvent(db, {
          timestamp: new Date().toISOString(),
          repo: `/tmp/concurrency-test-${workerId}`,
          sessionId: `worker-${workerId}`,
          diffHash: null,
          diffSummary: `concurrency test row batch=${b} i=${i}`,
          questionConcept: null,
          questionInstance: null,
          questionType: null,
          generationSource: "concurrency-test",
          missReason: null,
          answerConcept: null,
          answerInstance: null,
          skipped: false,
          skipReason: null,
          costUsd: null,
          diffFiles: null,
        });
        busyWaitMs(3);
      }
    });
    insertBatch();
  }
  process.stdout.write("OK\n");
} catch (err) {
  process.stderr.write(`FAIL: ${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  db.close();
}
