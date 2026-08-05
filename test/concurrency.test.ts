import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import Database from "better-sqlite3";
import { openStore } from "../src/store";

/**
 * Regression test for the "database is locked" bug Codex reproduced by
 * launching several independent CLI invocations against the same store at
 * once (six of seven failed outright). This spawns real, separate OS
 * processes — not a single-process simulation — against one shared SQLite
 * file, matching that repro shape, and asserts on the actual outcome (every
 * process succeeds, every row lands) rather than merely reading back
 * `PRAGMA busy_timeout` and trusting it's load-bearing.
 */

const WORKER_COUNT = 8;
const ROWS_PER_BATCH = 5;
const BATCHES = 6;
const FIXTURE_PATH = path.resolve(process.cwd(), "test-dist/test/fixtures/concurrentWriter.js");

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-test-concurrency-"));
  return path.join(dir, "history.db");
}

function runWorker(dbPath: string, workerId: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [FIXTURE_PATH, dbPath, String(workerId), String(ROWS_PER_BATCH), String(BATCHES)],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test(
  "concurrent Grasp processes against the same store do not fail with 'database is locked'",
  { timeout: 30_000 },
  async () => {
    assert.ok(
      fs.existsSync(FIXTURE_PATH),
      `compiled fixture not found at ${FIXTURE_PATH} — run \`npm test\` (which builds test-dist first), not \`node --test\` directly`
    );

    const dbPath = tempDbPath();
    // Pre-create the store in a single process first, exactly like real
    // Grasp usage always does: `grasp init` (one-shot, interactive, never
    // itself concurrent) runs `ensureInitialized()`/`openStore()` and is a
    // hard prerequisite for hooks to exist at all, so no hook-triggered
    // process can ever be racing to create a brand-new database file —
    // only to open an already-established one. (A brand-new, never-before-
    // opened WAL database being raced by several processes AT ONCE turns
    // out to be a materially different, narrower case — see DECISIONS.md's
    // "SQLite busy_timeout" entry for what was found there and why it's a
    // real but practically unreachable edge case, not something this test
    // needs to cover.)
    openStore(dbPath).close();

    // Launched without awaiting between them, so all WORKER_COUNT processes
    // start within the same event-loop tick — the closest a test can get to
    // Codex's "launched seven independent CLI capture checks at once".
    const results = await Promise.all(
      Array.from({ length: WORKER_COUNT }, (_, i) => runWorker(dbPath, i))
    );

    const failures = results.filter((r) => r.code !== 0);
    if (failures.length > 0) {
      assert.fail(
        `${failures.length}/${WORKER_COUNT} worker processes failed:\n` +
          failures.map((f) => f.stderr.trim()).join("\n")
      );
    }

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number };
    db.close();
    assert.equal(
      row.n,
      WORKER_COUNT * ROWS_PER_BATCH * BATCHES,
      "every row from every worker must have landed — a silent partial failure would under-count here even if no process reported an error"
    );
  }
);
