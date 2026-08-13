import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import {
  GENERATION_RESERVATION_STALE_MS,
  getBlockingPendingQuestionsForSession,
  getPendingQuestionsForSession,
  insertEvent,
  openStore,
  releaseGenerationSlot,
  tryClaimGenerationSlot,
} from "../src/store";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-test-store-db-"));
  return path.join(dir, "history.db");
}

function seedPendingQuestion(db: ReturnType<typeof openStore>, sessionId: string, timestamp: string): number {
  return insertEvent(db, {
    timestamp,
    repo: "/tmp/test-repo",
    sessionId,
    diffHash: null,
    diffSummary: "1 file changed",
    questionConcept: null,
    questionInstance: "instance question",
    questionType: "instance",
    generationSource: "test-seed",
    missReason: null,
    answerConcept: null,
    answerInstance: null,
    skipped: false,
    skipReason: null,
    costUsd: 0.001,
    diffFiles: null,
  });
}

// Regression coverage for the "old pending work blocks a resumed session"
// bug: README/TESTING_GUIDE both document hard-gate as never blocking over
// something left over from a different day, but the query used to check
// only session_id — and a Claude Code session_id CAN be resumed (e.g.
// `claude --resume`) long after it was first used, so session scoping alone
// doesn't actually guarantee that claim. `getBlockingPendingQuestionsForSession`
// adds an age cutoff specifically for the hard-gate check; the plain,
// unfiltered-by-age `getPendingQuestionsForSession` (used by the `Stop`
// nudge and by `grasp review`, transitively via `getPendingQuestions`)
// deliberately keeps showing/counting everything regardless of age.

test("getPendingQuestionsForSession: counts a question regardless of how old it is (the nudge/review-facing view)", () => {
  const db = openStore(tempDbPath());
  seedPendingQuestion(db, "resumed-session", "2000-01-01T00:00:00.000Z");
  assert.equal(getPendingQuestionsForSession(db, "resumed-session").length, 1);
  db.close();
});

test("getBlockingPendingQuestionsForSession: does NOT block on a question from a different day, even for the same session_id", () => {
  const db = openStore(tempDbPath());
  seedPendingQuestion(db, "resumed-session", "2000-01-01T00:00:00.000Z");
  const now = new Date("2026-08-06T12:00:00.000Z");
  assert.equal(getBlockingPendingQuestionsForSession(db, "resumed-session", now).length, 0);
  db.close();
});

test("getBlockingPendingQuestionsForSession: DOES block on a genuinely recent question for the same session", () => {
  const db = openStore(tempDbPath());
  const now = new Date("2026-08-06T12:00:00.000Z");
  const recent = new Date(now.getTime() - 5 * 60 * 1000).toISOString(); // 5 minutes ago
  seedPendingQuestion(db, "active-session", recent);
  assert.equal(getBlockingPendingQuestionsForSession(db, "active-session", now).length, 1);
  db.close();
});

test("getBlockingPendingQuestionsForSession: a different session's pending questions never block this session, at any age", () => {
  const db = openStore(tempDbPath());
  const now = new Date("2026-08-06T12:00:00.000Z");
  const recent = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  seedPendingQuestion(db, "other-session", recent);
  assert.equal(getBlockingPendingQuestionsForSession(db, "this-session", now).length, 0);
  db.close();
});

// --- generation reservation ownership token ---------------------------------
//
// Regression coverage for the "stale worker's release steals a live
// reservation" race an independent test pass found: releaseGenerationSlot
// used to delete "whatever row is there for this session_id" unconditionally,
// with no check that the caller releasing it was actually the one currently
// holding it. A worker that paused past GENERATION_RESERVATION_STALE_MS
// (machine sleep, process suspension) and then resumed would find its
// reservation already stolen by a second worker; the first worker's own
// unconditional release would then delete the SECOND worker's still-active
// reservation out from under it.

test("releaseGenerationSlot: a stale worker's release does not delete a newer worker's reservation it already stole", () => {
  const db = openStore(tempDbPath());
  const sessionId = "reservation-race-session";

  const tokenA = tryClaimGenerationSlot(db, sessionId);
  assert.ok(tokenA, "worker A should claim the free slot");

  // Simulate worker A having genuinely paused past the staleness window.
  db.prepare(`UPDATE generation_reservations SET claimed_at = ? WHERE session_id = ?`).run(
    new Date(Date.now() - GENERATION_RESERVATION_STALE_MS - 1000).toISOString(),
    sessionId
  );

  const tokenB = tryClaimGenerationSlot(db, sessionId);
  assert.ok(tokenB, "worker B should be able to steal the now-stale slot");
  assert.notEqual(tokenB, tokenA, "worker B's token must differ from worker A's");

  // Worker A resumes and releases using its OWN (now-stale) token.
  releaseGenerationSlot(db, sessionId, tokenA as string);

  const stillHeldByB = db
    .prepare(`SELECT token FROM generation_reservations WHERE session_id = ?`)
    .get(sessionId) as { token: string } | undefined;
  assert.equal(stillHeldByB?.token, tokenB, "worker B's reservation must survive worker A's stale release");

  // Worker B finishes normally and releases with its real token.
  releaseGenerationSlot(db, sessionId, tokenB as string);
  const gone = db.prepare(`SELECT token FROM generation_reservations WHERE session_id = ?`).get(sessionId);
  assert.equal(gone, undefined, "a real release with the current token must clear the row");

  db.close();
});

test("tryClaimGenerationSlot: returns null (not a live claim) while another process holds a fresh reservation", () => {
  const db = openStore(tempDbPath());
  const sessionId = "reservation-contention-session";

  const token = tryClaimGenerationSlot(db, sessionId);
  assert.ok(token);
  assert.equal(tryClaimGenerationSlot(db, sessionId), null);

  releaseGenerationSlot(db, sessionId, token as string);
  assert.ok(tryClaimGenerationSlot(db, sessionId), "slot should be claimable again after a real release");

  db.close();
});

// --- pre-`resolved`-column database upgrade ---------------------------------
//
// Regression coverage for a dogfooding-discovered bug: SCHEMA_SQL used to
// embed `CREATE INDEX idx_captured_diffs_pending ... (..., resolved)`
// directly, right after captured_diffs's `CREATE TABLE IF NOT EXISTS`. On a
// database that predates the `resolved` column, that CREATE TABLE is a
// no-op (the table already exists with its old columns), so the index
// statement — still inside the same unconditional SCHEMA_SQL exec — failed
// with "no such column: resolved" before migrateSchema() ever got a chance
// to add the column. See DECISIONS.md.

test("openStore: migrates a pre-`resolved`-column captured_diffs table instead of throwing", () => {
  const dbPath = tempDbPath();
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE IF NOT EXISTS captured_diffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      diff_json TEXT NOT NULL,
      filtered INTEGER NOT NULL DEFAULT 0,
      filter_reason TEXT
    );
  `);
  legacy.close();

  const db = openStore(dbPath);
  const columns = db.prepare(`PRAGMA table_info(captured_diffs)`).all() as Array<{ name: string }>;
  assert.ok(
    columns.some((c) => c.name === "resolved"),
    "resolved column should be added by migrateSchema"
  );
  const indexes = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'captured_diffs'`)
    .all() as Array<{ name: string }>;
  assert.ok(
    indexes.some((i) => i.name === "idx_captured_diffs_pending"),
    "idx_captured_diffs_pending should still be created after migration"
  );
  db.close();
});
