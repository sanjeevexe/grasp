import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { checkForFileEdits, orderFilesRoundRobin, runScanWalk } from "../src/scan";
import { evaluateCapturedDiff } from "../src/filter";
import { diffFileContents } from "../src/adapters/gitDiffCapture";
import { CapturedDiff, DiffFile } from "../src/adapters/agentAdapter";
import {
  clearHistory,
  getHistoryRowCounts,
  getScanCompletedFilePaths,
  getScanFileHash,
  getScannedChunkIndexes,
  openStore,
  upsertScanFileHash,
} from "../src/store";
import { testConfig } from "./helpers";

/**
 * Hash-based re-scan for edited files (Prompt 9): `checkForFileEdits`
 * exercised directly (no interactive review UI needed — same rationale as
 * scanWalk.test.ts's own direct testing of `runScanWalk`). See
 * DECISIONS.md's "grasp scan: hash-based re-scan" entry for the design this
 * verifies: whole-file hashing (not per-chunk), the mechanical-filter reuse
 * for the "is this edit trivial" decision, and the practical hash-tracking
 * size limit.
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

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo(): string {
  const repo = mkTempDir("grasp-test-rescan-repo-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  return repo;
}

function tempDbPath(): string {
  return path.join(mkTempDir("grasp-test-rescan-db-"), "history.db");
}

function writeAndCommit(repo: string, rel: string, content: string): void {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "update " + rel]);
}

// --- checkForFileEdits: the individual decision branches --------------------

test("checkForFileEdits: a file with no stored hash is left alone, no diff attempted (never scanned before under this feature)", () => {
  const repo = initRepo();
  writeAndCommit(repo, "a.ts", "export const x = 1;\n");
  const db = openStore(tempDbPath());

  // No scan_file_hashes row exists — must not throw, must not reopen.
  const reopened = checkForFileEdits(db, repo, testConfig(), "a.ts");
  assert.equal(reopened, false);
  assert.equal(getScanFileHash(db, repo, "a.ts"), null, "no hash should have been written for a file that was never fully scanned");
  db.close();
});

test("checkForFileEdits: an unchanged file (hash matches) is left alone", () => {
  const repo = initRepo();
  const content = "export const x = 1;\n";
  writeAndCommit(repo, "a.ts", content);
  const db = openStore(tempDbPath());
  const hash = createHash("sha256").update(content).digest("hex");
  upsertScanFileHash(db, repo, "a.ts", hash, content);

  const reopened = checkForFileEdits(db, repo, testConfig(), "a.ts");
  assert.equal(reopened, false);
  db.close();
});

test("checkForFileEdits: a trivial (formatting-only) edit updates the stored hash/content but does not reopen the file", () => {
  const repo = initRepo();
  const oldContent = "  const x = 1;\n";
  const newContent = "const   x = 1;\n";
  writeAndCommit(repo, "a.ts", newContent);
  const db = openStore(tempDbPath());
  const oldHash = createHash("sha256").update(oldContent).digest("hex");
  upsertScanFileHash(db, repo, "a.ts", oldHash, oldContent);

  const reopened = checkForFileEdits(db, repo, testConfig(), "a.ts");
  assert.equal(reopened, false, "a whitespace-only change must not reopen the file for re-scanning");

  const updated = getScanFileHash(db, repo, "a.ts");
  assert.ok(updated);
  assert.equal(updated!.content, newContent, "the stored content must be updated to the current content even though it wasn't reprocessed");
  assert.notEqual(updated!.contentHash, oldHash, "the stored hash must be updated to match the new content");
  db.close();
});

test("checkForFileEdits: a real (non-trivial) edit clears chunk progress and reopens the file", () => {
  const repo = initRepo();
  const oldContent = "export function original() {\n  return 1;\n}\n";
  const newContent = "export function original() {\n  return 2;\n}\n\nexport function addedFunction() {\n  return 3;\n}\n";
  writeAndCommit(repo, "a.ts", newContent);
  const db = openStore(tempDbPath());
  const oldHash = createHash("sha256").update(oldContent).digest("hex");
  upsertScanFileHash(db, repo, "a.ts", oldHash, oldContent);
  // Simulate the file having been previously fully covered (a single final chunk).
  db.prepare(
    `INSERT INTO scan_progress (repo, file_path, chunk_index, is_final_chunk, scanned_at) VALUES (?, ?, 0, 1, ?)`
  ).run(repo, "a.ts", new Date().toISOString());
  assert.ok(getScanCompletedFilePaths(db, repo).has("a.ts"), "sanity check: the file starts out fully covered");

  const reopened = checkForFileEdits(db, repo, testConfig(), "a.ts");
  assert.equal(reopened, true, "a real logic change must reopen the file");

  assert.equal(getScannedChunkIndexes(db, repo, "a.ts").size, 0, "stale chunk progress must be cleared");
  assert.ok(!getScanCompletedFilePaths(db, repo).has("a.ts"), "the file must no longer read as fully covered");

  const updated = getScanFileHash(db, repo, "a.ts");
  assert.equal(updated!.content, newContent, "the stored hash/content must be updated immediately, not deferred until a re-walk completes");
  db.close();
});

test("checkForFileEdits: an unreadable file (deleted since last scan) is left alone, not crashed on", () => {
  const repo = initRepo();
  const db = openStore(tempDbPath());
  const oldContent = "export const x = 1;\n";
  upsertScanFileHash(db, repo, "gone.ts", createHash("sha256").update(oldContent).digest("hex"), oldContent);

  // "gone.ts" was never actually written to disk in this repo.
  const reopened = checkForFileEdits(db, repo, testConfig(), "gone.ts");
  assert.equal(reopened, false);
  db.close();
});

test("checkForFileEdits: a file over the hash-tracking size limit is left alone even though its content changed", () => {
  const repo = initRepo();
  // Over MAX_SCAN_HASH_TRACKING_LINES (5000) but comfortably under the
  // much larger chunking ceiling — a legitimate large file that's simply
  // too big to bother hash-tracking (see DECISIONS.md's reasoning).
  const bigLines = (n: number) => Array.from({ length: n }, (_, i) => `// line ${i + 1}`).join("\n") + "\n";
  const oldContent = bigLines(5500);
  const newContent = bigLines(5500).replace("// line 1\n", "// line 1 CHANGED\n");
  writeAndCommit(repo, "big.ts", newContent);
  const db = openStore(tempDbPath());
  upsertScanFileHash(db, repo, "big.ts", createHash("sha256").update(oldContent).digest("hex"), oldContent);

  const reopened = checkForFileEdits(db, repo, testConfig(), "big.ts");
  assert.equal(reopened, false, "a file over the hash-tracking size limit must never be reopened via hash comparison");
  db.close();
});

// --- End-to-end: a genuinely edited file re-enters the chunked walk --------

test("runScanWalk + checkForFileEdits: a meaningful edit to a previously fully-scanned file produces a fresh question, resuming from chunk 0", () => {
  const repo = initRepo();
  writeAndCommit(repo, "a.ts", "export function original() {\n  return 1;\n}\n");
  const dbPath = tempDbPath();

  // Run 1: fully scan the file, writing its scan_file_hashes row.
  const db1 = openStore(dbPath);
  withMockClaude({ GRASP_TEST_MOCK_MODE: "normal", GRASP_TEST_MOCK_COST: "0.001" }, () => {
    runScanWalk(db1, repo, "scan-run-1", testConfig({ scanQuestionsCap: 999 }), ["a.ts"], false);
  });
  assert.ok(getScanCompletedFilePaths(db1, repo).has("a.ts"));
  const hashAfterRun1 = getScanFileHash(db1, repo, "a.ts");
  assert.ok(hashAfterRun1, "a hash must be recorded once the file is fully scanned");
  const questionsAfterRun1 = (db1.prepare(`SELECT COUNT(*) AS n FROM events WHERE question_type IS NOT NULL`).get() as { n: number }).n;
  assert.equal(questionsAfterRun1, 1);
  db1.close();

  // Edit the file for real (new function added).
  writeAndCommit(
    repo,
    "a.ts",
    "export function original() {\n  return 1;\n}\n\nexport function addedByHand() {\n  return 2;\n}\n"
  );

  // Run 2: the candidate-selection step a real `grasp scan` invocation
  // performs — checkForFileEdits decides whether "a.ts" re-enters the walk.
  const db2 = openStore(dbPath);
  const allTracked = ["a.ts"];
  const completedSet = getScanCompletedFilePaths(db2, repo);
  const config = testConfig({ scanQuestionsCap: 999 });
  const candidates = allTracked.filter((f) => !completedSet.has(f) || checkForFileEdits(db2, repo, config, f));
  assert.deepEqual(candidates, ["a.ts"], "the edited file must re-enter the candidate list");

  withMockClaude({ GRASP_TEST_MOCK_MODE: "normal", GRASP_TEST_MOCK_COST: "0.001" }, () => {
    const result = runScanWalk(db2, repo, "scan-run-2", config, orderFilesRoundRobin(candidates), false);
    assert.equal(result.chunksProcessed, 1, "the small edited file is still just one chunk, resumed from chunk 0");
  });

  const questionsAfterRun2 = (db2.prepare(`SELECT COUNT(*) AS n FROM events WHERE question_type IS NOT NULL`).get() as { n: number }).n;
  assert.equal(questionsAfterRun2, 2, "the re-scan must produce a genuinely new question, not reuse the old one");
  assert.ok(getScanCompletedFilePaths(db2, repo).has("a.ts"), "the file must be fully covered again after the re-scan");
  db2.close();
});

// --- Diff-filter thresholds match the live diff-capture path ---------------

test("evaluateCapturedDiff behaves identically for a hash-detected content edit and an equivalent real git-captured diff", () => {
  // Same formatting-only edit, computed two ways: once via diffFileContents
  // (the hash-check path, two arbitrary content strings), once via a real
  // `git diff` on an actual repo commit (the live diff-capture path's own
  // parsing). Both DiffFiles are run through the SAME evaluateCapturedDiff
  // and must agree.
  const repo = initRepo();
  const oldContent = "  const x = 1;\n";
  const newContent = "const   x = 1;\n";
  writeAndCommit(repo, "a.ts", oldContent);
  writeAndCommit(repo, "a.ts", newContent);

  // Live diff-capture path: a real `git diff HEAD~1 HEAD -- a.ts`.
  const rawDiff = execFileSync("git", ["diff", "--no-color", "HEAD~1", "HEAD", "--", "a.ts"], {
    cwd: repo,
    encoding: "utf-8",
  });
  const hunkLines = rawDiff
    .split("\n")
    .filter((l) => l.startsWith("+") || l.startsWith("-"))
    .filter((l) => !l.startsWith("+++") && !l.startsWith("---"));
  const liveDiffFile: DiffFile = {
    path: "a.ts",
    oldPath: null,
    status: "modified",
    insertions: hunkLines.filter((l) => l.startsWith("+")).length,
    deletions: hunkLines.filter((l) => l.startsWith("-")).length,
    hunks: [{ header: "@@ -1,1 +1,1 @@", lines: hunkLines }],
  };
  const liveVerdict = evaluateCapturedDiff(
    { repo, capturedAt: new Date().toISOString(), files: [liveDiffFile], rawDiffText: rawDiff, diffHash: null },
    testConfig()
  );

  // Hash-check path: diffFileContents on the two raw strings directly.
  const { insertions, deletions, hunks } = diffFileContents(repo, oldContent, newContent);
  const hashCheckDiffFile: DiffFile = { path: "a.ts", oldPath: null, status: "modified", insertions, deletions, hunks };
  const hashCheckVerdict = evaluateCapturedDiff(
    { repo, capturedAt: new Date().toISOString(), files: [hashCheckDiffFile], rawDiffText: "", diffHash: null },
    testConfig()
  );

  assert.equal(liveVerdict.passed, false, "sanity check: a whitespace-only edit is filtered on the live diff-capture path");
  assert.equal(hashCheckVerdict.passed, liveVerdict.passed);
  assert.equal(hashCheckVerdict.reason, liveVerdict.reason);
  assert.equal(hashCheckVerdict.reason, "formatting_only");
});

// --- grasp reset history clears scan_file_hashes too ------------------------

test("clearHistory: also wipes scan_file_hashes", () => {
  const db = openStore(tempDbPath());
  upsertScanFileHash(db, "/tmp/some-repo", "a.ts", "deadbeef", "content");
  assert.equal(getHistoryRowCounts(db).scanFileHashes, 1);

  const deleted = clearHistory(db);
  assert.equal(deleted.scanFileHashes, 1);
  assert.equal(getHistoryRowCounts(db).scanFileHashes, 0);
  db.close();
});
