/**
 * Spawnable fixture (not itself a test): opens the shared DB given on argv
 * and runs exactly one `runGeneration` call for the given sessionId, then
 * prints its outcome as JSON. Used by test/generationCapRace.test.ts to
 * launch several real OS processes calling `runGeneration` for the SAME
 * session concurrently — the actual shape of the cap-enforcement race an
 * independent test pass found (overlapping generation workers all reading
 * the same pre-call cost/question totals before any of them committed a
 * result, so all of them invoked Claude and all of them landed).
 */
import { openStore } from "../../src/store";
import { runGeneration } from "../../src/generation";
import { DEFAULT_CONFIG } from "../../src/config";
import { DiffFile } from "../../src/adapters/agentAdapter";

const dbPath = process.argv[2];
const sessionId = process.argv[3];
const workerId = process.argv[4];
const costCapUsd = parseFloat(process.argv[5]);
const questionsPerSessionCap = parseInt(process.argv[6], 10);

const significantFiles: DiffFile[] = [
  {
    path: `worker-${workerId}.ts`,
    oldPath: null,
    status: "modified",
    insertions: 10,
    deletions: 2,
    hunks: [{ header: "@@ -1,2 +1,10 @@", lines: [`+// change from worker ${workerId}`] }],
  },
];

const db = openStore(dbPath);
try {
  const outcome = runGeneration(db, {
    sessionId,
    repo: "/tmp/race-repo",
    significantFiles,
    config: { ...DEFAULT_CONFIG, costCapUsd, questionsPerSessionCap },
    diffHash: `race-${workerId}`,
  });
  process.stdout.write(JSON.stringify(outcome) + "\n");
} catch (err) {
  process.stderr.write(`FAIL: ${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  db.close();
}
