import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openStore, getSessionQuestionCount } from "../src/store";
import { runGeneration, GenerationParams } from "../src/generation";
import { diffFile, testConfig } from "./helpers";

/**
 * Integration-level tests for runGeneration's cap math and cost-recording
 * behavior — real `openStore`, real `runGeneration`, a controllable mock
 * `claude` binary on PATH (same technique used throughout this project's
 * manual verification passes, now automated). Deliberately not mocking
 * anything *inside* generation.ts — these prove the actual wiring, not a
 * reimplementation of it.
 *
 * The dollar-cost cap (`costCapUsd`) and its unknown-cost-halt mechanism
 * (`hasUnknownCostFailure`) were removed in the reliability rework — see
 * DECISIONS.md's "Remove costCapUsd and the unknown-cost-halt mechanism"
 * entry: a single timed-out call used to permanently and silently halt all
 * further generation for that session, indistinguishable from a real cap
 * hit. `questionsPerSessionCap` is now the sole safety rail; `cost_usd` is
 * still recorded (see the same entry) purely as informational/audit
 * metadata, never gated on.
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

test("runGeneration: questions-per-session cap stops generation after N real questions", () => {
  const db = openStore(tempDbPath());
  const counter = tempCounterPath();
  const config = testConfig({ questionsPerSessionCap: 2 });
  const params = baseParams({ config });

  withMockClaude(
    { GRASP_TEST_MOCK_MODE: "normal", GRASP_TEST_MOCK_COST: "0.001", GRASP_TEST_MOCK_COUNTER: counter },
    () => {
      const r1 = runGeneration(db, params);
      const r2 = runGeneration(db, params);
      const r3 = runGeneration(db, params);
      assert.equal(r1.missReason, null);
      assert.equal(r2.missReason, null);
      assert.equal(r3.missReason, "cap_reached", "call 3: the cap must block before invoking claude at all");
    }
  );

  assert.equal(getSessionQuestionCount(db, "test-session"), 2);
  assert.equal(
    fs.readFileSync(counter, "utf-8"),
    "2",
    "the cap-blocked call must never have invoked claude — the mock must only have run twice"
  );
  db.close();
});

test("runGeneration: a missing total_cost_usd on an otherwise-successful response is a miss, cost recorded as unknown (NULL), never coerced to 0", () => {
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

test("runGeneration: repeated uncosted failures no longer halt the session — each call is actually retried (the removed unknown-cost-halt mechanism)", () => {
  // Before the reliability rework, a single call whose cost couldn't be
  // determined permanently blocked all further generation for the session —
  // every later call for that session was silently recorded as
  // miss_reason "cap_reached", indistinguishable from a real cap hit, even
  // with the question cap nowhere near met. That mechanism is gone: three
  // successive uncosted calls must now all actually reach the mock.
  const db = openStore(tempDbPath());
  const counter = tempCounterPath();
  const config = testConfig({ questionsPerSessionCap: 999 });
  const params = baseParams({ config });

  withMockClaude(
    { GRASP_TEST_MOCK_MODE: "missing-cost", GRASP_TEST_MOCK_COUNTER: counter },
    () => {
      const r1 = runGeneration(db, params);
      const r2 = runGeneration(db, params);
      const r3 = runGeneration(db, params);

      assert.equal(r1.missReason, "error");
      assert.equal(r2.missReason, "error", "must still actually invoke claude, not be pre-blocked");
      assert.equal(r3.missReason, "error", "same — the removed halt mechanism must not resurface");
    }
  );

  assert.equal(
    fs.readFileSync(counter, "utf-8"),
    "3",
    "the mock claude binary must have actually run all three times, not just once"
  );
  db.close();
});

test("runGeneration: a negative total_cost_usd is rejected, recorded as unknown (NULL), never stored as-is", () => {
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

test("runGeneration: a valid JSON error envelope on a nonzero exit has its reported cost recovered, not discarded (independent test report repro)", () => {
  // Reproduces the report's scenario: a mock that prints a well-formed JSON
  // envelope with a real total_cost_usd and then exits 1 (the same
  // convention the real, unauthenticated Claude CLI uses for some errors).
  // Before the fix, execFileSync's thrown error discarded stdout entirely
  // and the call was recorded with cost_usd = NULL. After the fix, the
  // reported cost must be recovered from the error's own .stdout.
  const db = openStore(tempDbPath());
  const params = baseParams();
  let outcome: ReturnType<typeof runGeneration> | undefined;

  withMockClaude({ GRASP_TEST_MOCK_MODE: "error-envelope-exit1" }, () => {
    outcome = runGeneration(db, params);
  });

  assert.equal(outcome!.missReason, "error");
  const row = db.prepare("SELECT cost_usd, cost_unknown FROM events WHERE id = ?").get(outcome!.eventId) as any;
  assert.equal(row.cost_usd, 0.001, "the cost reported in the exit-1 envelope must be recovered, not discarded as NULL");
  assert.equal(row.cost_unknown, 0, "a recovered, real cost figure is not an unknown-cost row");
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
