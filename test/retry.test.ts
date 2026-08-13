import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync, spawnSync } from "child_process";
import { resolveRepoRoot } from "../src/git";
import { getUnresolvedCapturedDiffs, insertCapturedDiff, openStore, upsertTurn } from "../src/store";
import { CLI_PATH, diffFile } from "./helpers";

/**
 * `grasp retry` (Prompt 7): a standalone command that gathers every
 * unresolved captured diff for the current repo across EVERY session — not
 * just a still-live one — and runs one batch generation attempt covering
 * them, under a fresh synthetic session_id. See DECISIONS.md's "grasp
 * retry: cap behavior" entry and generation.ts's `runRetryGeneration` for
 * the design. Spawns the real built CLI binary throughout, matching
 * batchGeneration.test.ts's own end-to-end style for internal:hook.
 */

const FIXTURE_CLAUDE_DIR = path.resolve(process.cwd(), "test/fixtures/mock-claude");

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepoWithCommit(): string {
  const repo = mkTempDir("grasp-test-retry-repo-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "app.ts"), "export function original() {\n  return 1;\n}\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  return repo;
}

function tempDbPath(home: string): string {
  const dbPath = path.join(home, ".grasp", "history.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return dbPath;
}

function seedUnresolvedDiff(dbPath: string, repo: string, sessionId: string, promptId: string): void {
  const db = openStore(dbPath);
  upsertTurn(db, { sessionId, promptId, repo });
  insertCapturedDiff(db, {
    sessionId,
    promptId,
    repo,
    capturedAt: new Date().toISOString(),
    diff: {
      repo,
      capturedAt: new Date().toISOString(),
      files: [diffFile({ path: "a.ts", insertions: 10, deletions: 1 })],
      rawDiffText: "",
      diffHash: null,
    },
    filtered: false,
    filterReason: null,
    significantFiles: [diffFile({ path: "a.ts", insertions: 10, deletions: 1 })],
  });
  db.close();
}

function runRetryCli(repo: string, home: string, env: Record<string, string> = {}): { stdout: string; status: number } {
  const result = spawnSync(process.execPath, [CLI_PATH, "retry"], {
    cwd: repo,
    env: { ...process.env, HOME: home, PATH: `${FIXTURE_CLAUDE_DIR}:${process.env.PATH}`, ...env },
  });
  return { stdout: result.stdout.toString(), status: result.status ?? 1 };
}

test("grasp retry: nothing unresolved prints a clean message and exits without error", () => {
  const rawRepo = initRepoWithCommit();
  const repo = resolveRepoRoot(rawRepo);
  const home = mkTempDir("grasp-test-retry-home-");

  const { stdout, status } = runRetryCli(repo, home);

  assert.equal(status, 0);
  assert.match(stdout, /Nothing to retry — no unresolved captured diffs for this repo\./);
});

test("grasp retry: picks up a diff left unresolved by a different, no-longer-live session", () => {
  const rawRepo = initRepoWithCommit();
  const repo = resolveRepoRoot(rawRepo);
  const home = mkTempDir("grasp-test-retry-home-");
  const dbPath = tempDbPath(home);

  // Simulates a session that captured a diff, hit an error at Stop, and then
  // ended for good — no future Stop firing for THIS session_id will ever
  // come along to retry it.
  seedUnresolvedDiff(dbPath, repo, "long-dead-session", "p1");

  const { stdout, status } = runRetryCli(repo, home, { GRASP_TEST_MOCK_MODE: "normal", GRASP_TEST_MOCK_COST: "0.001" });

  assert.equal(status, 0);
  assert.match(stdout, /Generated a new question from 1 previously-stuck diff — run `grasp review` to see it\./);

  const db = openStore(dbPath);
  assert.equal(
    getUnresolvedCapturedDiffs(db, "long-dead-session", repo).length,
    0,
    "the retried diff must now be marked resolved"
  );
  const row = db.prepare(`SELECT session_id, question_type FROM events WHERE question_type IS NOT NULL`).get() as any;
  assert.match(row.session_id, /^retry-/, "the generated event must be recorded under a fresh synthetic retry- session_id, not the dead session's own");
  db.close();
});

test("grasp retry: combines unresolved diffs from MULTIPLE different sessions into one attempt", () => {
  const rawRepo = initRepoWithCommit();
  const repo = resolveRepoRoot(rawRepo);
  const home = mkTempDir("grasp-test-retry-home-");
  const dbPath = tempDbPath(home);

  seedUnresolvedDiff(dbPath, repo, "dead-session-a", "p1");
  seedUnresolvedDiff(dbPath, repo, "dead-session-b", "p1");

  const { stdout, status } = runRetryCli(repo, home, { GRASP_TEST_MOCK_MODE: "normal", GRASP_TEST_MOCK_COST: "0.001" });

  assert.equal(status, 0);
  assert.match(stdout, /Generated a new question from 2 previously-stuck diffs — run `grasp review` to see it\./);

  const db = openStore(dbPath);
  assert.equal(getUnresolvedCapturedDiffs(db, "dead-session-a", repo).length, 0);
  assert.equal(getUnresolvedCapturedDiffs(db, "dead-session-b", repo).length, 0);
  const questionCount = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE question_type IS NOT NULL`).get() as { n: number }).n;
  assert.equal(questionCount, 1, "both diffs must be covered by ONE combined question, not two separate ones");
  db.close();
});

test("grasp retry: a failed attempt leaves its diffs unresolved, not lost", () => {
  const rawRepo = initRepoWithCommit();
  const repo = resolveRepoRoot(rawRepo);
  const home = mkTempDir("grasp-test-retry-home-");
  const dbPath = tempDbPath(home);

  seedUnresolvedDiff(dbPath, repo, "dead-session-c", "p1");

  const { stdout, status } = runRetryCli(repo, home, { GRASP_TEST_MOCK_MODE: "error" });

  assert.equal(status, 0, "a failed retry attempt itself must still exit cleanly, not crash the CLI");
  assert.match(stdout, /Retry attempt failed \(error\) — 1 diff remain unresolved\. Run `grasp retry` again to try once more\./);

  const db = openStore(dbPath);
  assert.equal(
    getUnresolvedCapturedDiffs(db, "dead-session-c", repo).length,
    1,
    "a failed attempt must never mark its diffs resolved"
  );
  db.close();
});
