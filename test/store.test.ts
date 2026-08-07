import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getBlockingPendingQuestionsForSession,
  getPendingQuestionsForSession,
  insertEvent,
  openStore,
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
