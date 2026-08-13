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
  getSessionQuestionCount,
  insertEvent,
  openStore,
  releaseGenerationSlot,
  tryClaimGenerationSlot,
} from "../src/store";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-test-store-db-"));
  return path.join(dir, "history.db");
}

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

// getSessionQuestionCount counts real, individual questions — not event
// rows. One event can carry ONE real question (question_type "instance",
// question_concept NULL — the concept was already memoized) or TWO
// (question_type "both", both question_concept and question_instance set).
// Before this fix, a cap of N could silently admit up to 2N actual
// questions since the cap checked row count, not question count — see
// DECISIONS.md's "question caps count real questions, not event-rows"
// entry.
test("getSessionQuestionCount: a 'both' event counts as 2, an 'instance'-only event counts as 1, a miss (question_type NULL) counts as 0", () => {
  const db = openStore(tempDbPath());
  const sessionId = "mixed-session";

  insertEvent(db, {
    timestamp: "2020-01-01T00:00:00.000Z",
    repo: "/tmp/test-repo",
    sessionId,
    diffHash: null,
    diffSummary: "1 file changed",
    questionConcept: "concept question",
    questionInstance: "instance question",
    questionType: "both",
    generationSource: "test-seed",
    missReason: null,
    answerConcept: null,
    answerInstance: null,
    skipped: false,
    skipReason: null,
    costUsd: 0.001,
    diffFiles: null,
  });

  insertEvent(db, {
    timestamp: "2020-01-01T00:01:00.000Z",
    repo: "/tmp/test-repo",
    sessionId,
    diffHash: null,
    diffSummary: "1 file changed",
    questionConcept: null,
    questionInstance: "instance question only",
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

  // A miss (no question at all) must contribute 0, not be miscounted.
  insertEvent(db, {
    timestamp: "2020-01-01T00:02:00.000Z",
    repo: "/tmp/test-repo",
    sessionId,
    diffHash: null,
    diffSummary: "1 file changed",
    questionConcept: null,
    questionInstance: null,
    questionType: null,
    generationSource: "test-seed",
    missReason: "error",
    answerConcept: null,
    answerInstance: null,
    skipped: false,
    skipReason: null,
    costUsd: 0.001,
    diffFiles: null,
  });

  // 2 (both) + 1 (instance-only) + 0 (miss) = 3 real questions across 3 event rows.
  assert.equal(getSessionQuestionCount(db, sessionId), 3);
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

// --- Prompt 8: pre-chunking scan_progress migration -------------------------
//
// Before chunking, scan_progress had one row per (repo, file_path) meaning
// "this file was already fully scanned." The chunk-granularity redesign
// needs a real PRIMARY KEY change (repo, file_path, chunk_index), which
// SQLite can't do via ALTER TABLE — migrateSchema() renames the old table
// aside, recreates it, and expands each old row into every chunk the file
// CURRENTLY has on disk (not just chunk_index=0), so the schema change
// doesn't trigger stale reprocessing of an already-covered file. See
// DECISIONS.md's "grasp scan: chunking for large files" entry.

test("openStore: migrates pre-chunking scan_progress rows into every chunk the file currently has, all marked done", () => {
  const dbPath = tempDbPath();
  const repo = mkTempDir("grasp-test-scanmigrate-repo-");
  // 900 lines -> 3 chunks under MAX_SCAN_CHUNK_LINES=400 (400 + 400 + 100).
  const lines: string[] = [];
  for (let i = 1; i <= 900; i++) lines.push(`// line ${i}`);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "big.ts"), lines.join("\n") + "\n");

  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE IF NOT EXISTS scan_progress (
      repo TEXT NOT NULL,
      file_path TEXT NOT NULL,
      scanned_at TEXT NOT NULL,
      PRIMARY KEY (repo, file_path)
    );
  `);
  legacy
    .prepare(`INSERT INTO scan_progress (repo, file_path, scanned_at) VALUES (?, ?, ?)`)
    .run(repo, "src/big.ts", "2020-01-01T00:00:00.000Z");
  legacy.close();

  const db = openStore(dbPath);
  const columns = db.prepare(`PRAGMA table_info(scan_progress)`).all() as Array<{ name: string }>;
  assert.ok(columns.some((c) => c.name === "chunk_index"), "chunk_index column should exist after migration");
  assert.ok(columns.some((c) => c.name === "is_final_chunk"), "is_final_chunk column should exist after migration");

  const rows = db
    .prepare(`SELECT chunk_index, is_final_chunk FROM scan_progress WHERE repo = ? AND file_path = ? ORDER BY chunk_index ASC`)
    .all(repo, "src/big.ts") as Array<{ chunk_index: number; is_final_chunk: number }>;
  assert.deepEqual(
    rows.map((r) => r.chunk_index),
    [0, 1, 2],
    "a 900-line file's 3 CURRENT chunks must all be migrated, not just chunk_index=0"
  );
  assert.deepEqual(
    rows.map((r) => r.is_final_chunk),
    [0, 0, 1],
    "only the last chunk should be marked final"
  );

  const indexes = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'scan_progress'`)
    .all() as Array<{ name: string }>;
  assert.ok(indexes.some((i) => i.name === "idx_scan_progress_final"), "idx_scan_progress_final should be created after migration");
  db.close();
});

test("openStore: migrating a pre-chunking scan_progress row for an unreadable file (repo gone/moved) falls back to a single final chunk", () => {
  const dbPath = tempDbPath();
  const goneRepo = path.join(mkTempDir("grasp-test-scanmigrate-gone-"), "no-longer-here");

  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE IF NOT EXISTS scan_progress (
      repo TEXT NOT NULL,
      file_path TEXT NOT NULL,
      scanned_at TEXT NOT NULL,
      PRIMARY KEY (repo, file_path)
    );
  `);
  legacy
    .prepare(`INSERT INTO scan_progress (repo, file_path, scanned_at) VALUES (?, ?, ?)`)
    .run(goneRepo, "src/gone.ts", "2020-01-01T00:00:00.000Z");
  legacy.close();

  const db = openStore(dbPath);
  const rows = db
    .prepare(`SELECT chunk_index, is_final_chunk FROM scan_progress WHERE repo = ? AND file_path = ?`)
    .all(goneRepo, "src/gone.ts") as Array<{ chunk_index: number; is_final_chunk: number }>;
  assert.deepEqual(rows, [{ chunk_index: 0, is_final_chunk: 1 }], "an unreadable file must fall back to one final chunk, not error or lose the row");
  db.close();
});
