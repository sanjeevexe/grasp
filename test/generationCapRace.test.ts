import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import Database from "better-sqlite3";
import { openStore } from "../src/store";

/**
 * Regression test for the release-blocking cap-enforcement race an
 * independent test pass reproduced: six overlapping `runGeneration` calls
 * for the SAME session, each backed by a mock `claude` slow enough to keep
 * several calls in flight at once, all read the same pre-call cost/question
 * totals and all invoked Claude — a one-question cap producing six question
 * events, a $0.001 cost cap allowing $0.006 spent. Reproduces the bug shape
 * for real: several separate OS processes racing one shared SQLite store,
 * not a single-process simulation — matching the style already established
 * in test/checkpointRace.test.ts and test/concurrency.test.ts.
 */

const WORKER_COUNT = 6;
const FIXTURE_PATH = path.resolve(process.cwd(), "test-dist/test/fixtures/generationRaceWorker.js");
const FIXTURE_CLAUDE_DIR = path.resolve(process.cwd(), "test/fixtures/mock-claude");

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-test-cap-race-"));
  return path.join(dir, "history.db");
}

function runWorker(
  dbPath: string,
  sessionId: string,
  workerId: number,
  costCapUsd: number,
  questionsPerSessionCap: number,
  env: Record<string, string>
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [FIXTURE_PATH, dbPath, sessionId, String(workerId), String(costCapUsd), String(questionsPerSessionCap)],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test(
  "runGeneration: overlapping processes for the same session never exceed the questions-per-session cap",
  { timeout: 30_000 },
  async () => {
    assert.ok(
      fs.existsSync(FIXTURE_PATH),
      `compiled fixture not found at ${FIXTURE_PATH} — run \`npm test\` (which builds test-dist first)`
    );

    const dbPath = tempDbPath();
    openStore(dbPath).close();
    const sessionId = "cap-race-session";

    const env = {
      PATH: `${FIXTURE_CLAUDE_DIR}:${process.env.PATH}`,
      GRASP_TEST_MOCK_MODE: "normal",
      GRASP_TEST_MOCK_COST: "0.001",
      GRASP_TEST_MOCK_DELAY_MS: "2000",
      GRASP_TEST_MOCK_COUNTER: path.join(path.dirname(dbPath), "counter.txt"),
    };

    // Six workers race the SAME session with a one-question cap, each
    // backed by a mock claude that stays "in flight" for 2s — long enough
    // that, without serialization, all six would read the same
    // pre-call question count (0) and all decide they're under the cap.
    const results = await Promise.all(
      Array.from({ length: WORKER_COUNT }, (_, i) => runWorker(dbPath, sessionId, i, 999, 1, env))
    );

    const failures = results.filter((r) => r.code !== 0);
    if (failures.length > 0) {
      assert.fail(`${failures.length}/${WORKER_COUNT} worker processes failed:\n` + failures.map((f) => f.stderr.trim()).join("\n"));
    }

    const db = new Database(dbPath, { readonly: true });
    const realQuestions = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND question_type IS NOT NULL`)
      .get(sessionId) as { n: number };
    const capMisses = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND miss_reason = 'cap_reached'`)
      .get(sessionId) as { n: number };
    db.close();

    assert.equal(
      realQuestions.n,
      1,
      `questionsPerSessionCap=1 must produce exactly 1 real question event even with ${WORKER_COUNT} overlapping callers, got ${realQuestions.n}`
    );
    assert.equal(
      capMisses.n,
      WORKER_COUNT - 1,
      `the remaining ${WORKER_COUNT - 1} callers must all be logged as cap_reached misses, got ${capMisses.n}`
    );
  }
);

test(
  "runGeneration: overlapping processes for the same session never exceed the cost cap",
  { timeout: 30_000 },
  async () => {
    const dbPath = tempDbPath();
    openStore(dbPath).close();
    const sessionId = "cost-cap-race-session";

    const env = {
      PATH: `${FIXTURE_CLAUDE_DIR}:${process.env.PATH}`,
      GRASP_TEST_MOCK_MODE: "normal",
      GRASP_TEST_MOCK_COST: "0.001",
      GRASP_TEST_MOCK_DELAY_MS: "2000",
      GRASP_TEST_MOCK_COUNTER: path.join(path.dirname(dbPath), "counter.txt"),
    };

    // A $0.001 cap with six $0.001-per-call workers racing: without
    // serialization every one of them reads spentSoFar=0 before any commits
    // and all six invoke Claude, landing $0.006. With serialization, only
    // the first caller can ever see spentSoFar (0) below the cap.
    const results = await Promise.all(
      Array.from({ length: WORKER_COUNT }, (_, i) => runWorker(dbPath, sessionId, i, 0.001, 999, env))
    );

    const failures = results.filter((r) => r.code !== 0);
    if (failures.length > 0) {
      assert.fail(`${failures.length}/${WORKER_COUNT} worker processes failed:\n` + failures.map((f) => f.stderr.trim()).join("\n"));
    }

    const db = new Database(dbPath, { readonly: true });
    const totalCost = db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM events WHERE session_id = ?`)
      .get(sessionId) as { total: number };
    db.close();

    assert.ok(
      totalCost.total <= 0.001 + 1e-9,
      `expected at most one call's worth of spend (~0.001) under a $0.001 cap with ${WORKER_COUNT} overlapping callers, got ${totalCost.total}`
    );
  }
);
