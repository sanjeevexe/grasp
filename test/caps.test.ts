import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openStore, getSessionCostUsd, getSessionQuestionCount, hasUnknownCostFailure } from "../src/store";
import { runGeneration, GenerationParams } from "../src/generation";
import { diffFile, testConfig } from "./helpers";

/**
 * Integration-level tests for runGeneration's cap math and cost-integrity
 * handling — real `openStore`, real `runGeneration`, a controllable mock
 * `claude` binary on PATH (same technique used throughout this project's
 * manual verification passes, now automated). Deliberately not mocking
 * anything *inside* generation.ts — these prove the actual wiring, not a
 * reimplementation of it.
 */

const FIXTURE_CLAUDE_DIR = path.resolve(process.cwd(), "test/fixtures/mock-claude");

function withMockClaude(env: Record<string, string>, fn: () => void): void {
  const originalPath = process.env.PATH;
  const originalEnv: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) originalEnv[key] = process.env[key];
  process.env.PATH = `${FIXTURE_CLAUDE_DIR}:${originalPath}`;
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    process.env.PATH = originalPath;
    for (const key of Object.keys(env)) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
}

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-test-db-"));
  return path.join(dir, "history.db");
}

function tempCounterPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-test-counter-"));
  return path.join(dir, "counter.txt");
}

function baseParams(overrides: Partial<GenerationParams> = {}): GenerationParams {
  return {
    sessionId: "test-session",
    repo: "/tmp/test-repo",
    significantFiles: [diffFile({ path: "a.ts", insertions: 10, deletions: 2 })],
    config: testConfig(),
    diffHash: null,
    ...overrides,
  };
}

test("runGeneration: cost cap stops generation once cumulative session cost meets the cap, not before", () => {
  const db = openStore(tempDbPath());
  const counter = tempCounterPath();
  const config = testConfig({ costCapUsd: 0.0015, questionsPerSessionCap: 999 });
  const params = baseParams({ config });

  withMockClaude(
    { GRASP_TEST_MOCK_MODE: "normal", GRASP_TEST_MOCK_COST: "0.001", GRASP_TEST_MOCK_COUNTER: counter },
    () => {
      const r1 = runGeneration(db, params);
      const r2 = runGeneration(db, params);
      const r3 = runGeneration(db, params);
      assert.equal(r1.missReason, null, "call 1: under the cap, should succeed");
      assert.equal(r2.missReason, null, "call 2: still under the cap (0.001 < 0.0015), should succeed");
      assert.equal(r3.missReason, "cap_reached", "call 3: 0.002 spent >= 0.0015 cap, should be blocked");
      assert.equal(r3.questionType, null);
    }
  );

  assert.equal(getSessionCostUsd(db, "test-session"), 0.002, "the cap-blocked call must never have invoked claude, so cost stays at exactly 2 calls' worth");
  db.close();
});

test("runGeneration: questions-per-session cap stops generation after N real questions, independent of cost cap", () => {
  const db = openStore(tempDbPath());
  const counter = tempCounterPath();
  const config = testConfig({ costCapUsd: 999, questionsPerSessionCap: 2 });
  const params = baseParams({ config });

  withMockClaude(
    { GRASP_TEST_MOCK_MODE: "normal", GRASP_TEST_MOCK_COST: "0.001", GRASP_TEST_MOCK_COUNTER: counter },
    () => {
      const r1 = runGeneration(db, params);
      const r2 = runGeneration(db, params);
      const r3 = runGeneration(db, params);
      assert.equal(r1.missReason, null);
      assert.equal(r2.missReason, null);
      assert.equal(r3.missReason, "cap_reached");
    }
  );

  assert.equal(getSessionQuestionCount(db, "test-session"), 2);
  // Cost cap (999) was nowhere near hit — proves this session's cap_reached
  // came from the QUESTION cap, distinguishable from the cost-cap test
  // above by comparing each session's own totals against its own caps.
  assert.ok(getSessionCostUsd(db, "test-session") < 1);
  db.close();
});

test("runGeneration: the two caps are independently distinguishable after the fact from a session's own totals", () => {
  const costCapDb = openStore(tempDbPath());
  const questionCapDb = openStore(tempDbPath());
  const counter1 = tempCounterPath();
  const counter2 = tempCounterPath();

  withMockClaude(
    { GRASP_TEST_MOCK_MODE: "normal", GRASP_TEST_MOCK_COST: "0.01", GRASP_TEST_MOCK_COUNTER: counter1 },
    () => {
      // Cap check happens BEFORE each call using the total spent so far, not
      // after — so with a $0.01/call cost and a $0.015 cap, calls 1 and 2
      // both still pass (0 < 0.015, then 0.01 < 0.015); call 3 is the first
      // one that sees spentSoFar (0.02) >= the cap and gets blocked.
      const config = testConfig({ costCapUsd: 0.015, questionsPerSessionCap: 999 });
      runGeneration(costCapDb, baseParams({ config, sessionId: "cost-cap-session" }));
      runGeneration(costCapDb, baseParams({ config, sessionId: "cost-cap-session" }));
      runGeneration(costCapDb, baseParams({ config, sessionId: "cost-cap-session" }));
    }
  );
  withMockClaude(
    { GRASP_TEST_MOCK_MODE: "normal", GRASP_TEST_MOCK_COST: "0.001", GRASP_TEST_MOCK_COUNTER: counter2 },
    () => {
      const config = testConfig({ costCapUsd: 999, questionsPerSessionCap: 2 });
      runGeneration(questionCapDb, baseParams({ config, sessionId: "question-cap-session" }));
      runGeneration(questionCapDb, baseParams({ config, sessionId: "question-cap-session" }));
      runGeneration(questionCapDb, baseParams({ config, sessionId: "question-cap-session" }));
    }
  );

  // cost-cap-session: cost hit its cap (0.02 >= 0.015) after 2 real calls;
  // question count (2) is nowhere near its own cap (999).
  assert.ok(getSessionCostUsd(costCapDb, "cost-cap-session") >= 0.015);
  assert.equal(getSessionQuestionCount(costCapDb, "cost-cap-session"), 2);

  // question-cap-session: question count hit its cap (2 >= 2) after 2 real
  // calls; cost (0.002) is nowhere near its own cap (999).
  assert.equal(getSessionQuestionCount(questionCapDb, "question-cap-session"), 2);
  assert.ok(getSessionCostUsd(questionCapDb, "question-cap-session") < 1);

  costCapDb.close();
  questionCapDb.close();
});

test("runGeneration: a missing total_cost_usd on an otherwise-successful response is a miss, never a free success", () => {
  const db = openStore(tempDbPath());
  const params = baseParams();
  let outcome: ReturnType<typeof runGeneration> | undefined;

  withMockClaude({ GRASP_TEST_MOCK_MODE: "missing-cost" }, () => {
    outcome = runGeneration(db, params);
  });

  assert.equal(outcome!.missReason, "error");
  assert.equal(outcome!.questionType, null);

  const row = db.prepare("SELECT cost_usd, question_type, miss_reason FROM events WHERE id = ?").get(outcome!.eventId) as any;
  assert.equal(row.cost_usd, null, "cost must be recorded as genuinely unknown (NULL), not coerced to 0");
  assert.equal(row.question_type, null, "no question should be recorded when its own cost is unknown");
  assert.equal(row.miss_reason, "error");
  db.close();
});

test("runGeneration: a negative total_cost_usd is rejected, not summed into the session cap total", () => {
  const db = openStore(tempDbPath());
  const params = baseParams();
  let outcome: ReturnType<typeof runGeneration> | undefined;

  withMockClaude({ GRASP_TEST_MOCK_MODE: "negative-cost" }, () => {
    outcome = runGeneration(db, params);
  });

  assert.equal(outcome!.missReason, "error");
  assert.equal(outcome!.questionType, null);

  const row = db.prepare("SELECT cost_usd, question_type, miss_reason FROM events WHERE id = ?").get(outcome!.eventId) as any;
  assert.equal(row.cost_usd, null, "a negative cost figure must be treated as unknown (NULL), never stored as-is");
  assert.equal(row.question_type, null);
  assert.equal(row.miss_reason, "error");

  // The session's cumulative cost must not go negative from this response —
  // that would let later calls see artificial room under the cost cap.
  assert.equal(getSessionCostUsd(db, params.sessionId), 0);
  db.close();
});

test("runGeneration: a well-formed error envelope (is_error: true) is a miss, cost still recorded when present", () => {
  const db = openStore(tempDbPath());
  const params = baseParams();
  let outcome: ReturnType<typeof runGeneration> | undefined;

  withMockClaude({ GRASP_TEST_MOCK_MODE: "error" }, () => {
    outcome = runGeneration(db, params);
  });

  assert.equal(outcome!.missReason, "error");
  const row = db.prepare("SELECT cost_usd FROM events WHERE id = ?").get(outcome!.eventId) as any;
  assert.equal(row.cost_usd, 0.001);
  db.close();
});

test("runGeneration: a malformed result with a real, present cost is a miss with that cost recorded (not discarded)", () => {
  const db = openStore(tempDbPath());
  const params = baseParams();
  let outcome: ReturnType<typeof runGeneration> | undefined;

  withMockClaude({ GRASP_TEST_MOCK_MODE: "bad-json-result" }, () => {
    outcome = runGeneration(db, params);
  });

  assert.equal(outcome!.missReason, "error");
  const row = db.prepare("SELECT cost_usd FROM events WHERE id = ?").get(outcome!.eventId) as any;
  assert.equal(row.cost_usd, 0.002, "a known cost must still be recorded even when the response body itself is unusable");
  db.close();
});

test("runGeneration: repeated unknown-cost failures do not keep invoking claude — the first one halts the session (independent test report repro)", () => {
  // Reproduces the report's exact scenario: costCapUsd set very low, three
  // successive meaningful diffs in one session, and a mock that always
  // returns a well-formed response with NO total_cost_usd. Before the fix,
  // all three calls actually ran (cost summed as 0 each time, so the cap
  // was never crossed). After the fix, only the first call should ever
  // reach the mock — every later call for the same session must be blocked
  // before invoking claude at all, once the session's true cost becomes
  // unknowable.
  const db = openStore(tempDbPath());
  const counter = tempCounterPath();
  const config = testConfig({ costCapUsd: 0.001, questionsPerSessionCap: 999 });
  const params = baseParams({ config });

  withMockClaude(
    { GRASP_TEST_MOCK_MODE: "missing-cost", GRASP_TEST_MOCK_COUNTER: counter },
    () => {
      const r1 = runGeneration(db, params);
      const r2 = runGeneration(db, params);
      const r3 = runGeneration(db, params);

      assert.equal(r1.missReason, "error", "call 1: claude was actually invoked and returned an uncosted response");
      assert.equal(r2.missReason, "cap_reached", "call 2: must be blocked BEFORE invoking claude — cost is unknowable");
      assert.equal(r3.missReason, "cap_reached", "call 3: same — must never reach claude either");
    }
  );

  assert.equal(
    fs.readFileSync(counter, "utf-8"),
    "1",
    "the mock claude binary must only have actually run once across all three runGeneration calls"
  );
  assert.equal(hasUnknownCostFailure(db, params.sessionId), true);
  assert.equal(getSessionCostUsd(db, params.sessionId), 0, "cost sum stays 0 (never fabricated), but the session is still halted via the separate unknown-cost signal");
  db.close();
});

test("runGeneration: a valid JSON error envelope on a nonzero exit has its reported cost recovered, not discarded (independent test report repro)", () => {
  // Reproduces the report's second scenario: a mock that prints a
  // well-formed JSON envelope with a real total_cost_usd and then exits 1
  // (the same convention the real, unauthenticated Claude CLI uses for some
  // errors). Before the fix, execFileSync's thrown error discarded stdout
  // entirely and the call was recorded with cost_usd = NULL. After the fix,
  // the reported cost must be recovered from the error's own .stdout.
  const db = openStore(tempDbPath());
  const params = baseParams();
  let outcome: ReturnType<typeof runGeneration> | undefined;

  withMockClaude({ GRASP_TEST_MOCK_MODE: "error-envelope-exit1" }, () => {
    outcome = runGeneration(db, params);
  });

  assert.equal(outcome!.missReason, "error");
  const row = db.prepare("SELECT cost_usd, cost_unknown FROM events WHERE id = ?").get(outcome!.eventId) as any;
  assert.equal(row.cost_usd, 0.001, "the cost reported in the exit-1 envelope must be recovered, not discarded as NULL");
  assert.equal(row.cost_unknown, 0, "a recovered, real cost figure means this is NOT an unknown-cost failure");
  assert.equal(hasUnknownCostFailure(db, params.sessionId), false, "a recovered real cost must not halt further generation for the session");
  db.close();
});

test("runGeneration: diffHash from CapturedDiff is threaded through to the events row", () => {
  const db = openStore(tempDbPath());
  const counter = tempCounterPath();
  const params = baseParams({ diffHash: "abc123..def456" });
  let outcome: ReturnType<typeof runGeneration> | undefined;

  withMockClaude(
    { GRASP_TEST_MOCK_MODE: "normal", GRASP_TEST_MOCK_COST: "0.001", GRASP_TEST_MOCK_COUNTER: counter },
    () => {
      outcome = runGeneration(db, params);
    }
  );

  const row = db.prepare("SELECT diff_hash FROM events WHERE id = ?").get(outcome!.eventId) as any;
  assert.equal(row.diff_hash, "abc123..def456");
  db.close();
});
