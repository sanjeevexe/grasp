import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { openStore, getCheckpointTree } from "../src/store";
import { ClaudeCodeAdapter } from "../src/adapters/claudeCodeAdapter";

/**
 * Regression test for the "git prune can break capture permanently" bug:
 * Grasp's checkpoint tree SHAs are deliberately unreferenced dangling git
 * objects (see gitDiffCapture.ts's checkpoint module doc), so `git gc`/
 * `git prune` can reclaim one out from under a stored checkpoint. Before
 * the fix, diffing against a pruned tree threw "fatal: bad object", which
 * propagated all the way out and left every future capture for that
 * session+repo permanently failing. This simulates the pruned-object state
 * directly (writing a plausible-but-nonexistent SHA into the checkpoint
 * table) rather than depending on real `git gc` timing, which isn't
 * reliably reproducible on demand.
 */

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepoWithCommit(): string {
  const repo = mkTempDir("grasp-test-selfheal-repo-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "app.ts"), "export function original() {\n  return 1;\n}\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  return repo;
}

test("checkAndCapture: a pruned/missing checkpoint object self-heals instead of failing forever", () => {
  const repo = initRepoWithCommit();
  const dbPath = path.join(mkTempDir("grasp-test-selfheal-db-"), "history.db");
  const sessionId = "selfheal-session";
  const promptId = "selfheal-prompt";

  const db = openStore(dbPath);
  const adapter = new ClaudeCodeAdapter(db, sessionId, promptId, repo);
  adapter.ensureTurnStarted();

  // Simulate a checkpoint whose underlying git tree object has been
  // reclaimed by `git gc`/`git prune` — a well-formed-looking SHA that
  // simply doesn't exist in this repo's object database.
  db.prepare(
    `INSERT INTO capture_checkpoints (session_id, repo, tree_sha, updated_at) VALUES (?, ?, ?, ?)`
  ).run(sessionId, repo, "0123456789abcdef0123456789abcdef01234567", new Date().toISOString());

  fs.writeFileSync(
    path.join(repo, "app.ts"),
    "export function original() {\n  return 1;\n}\n\nexport function addedByAgent() {\n  return 2;\n}\n"
  );

  // Must not throw — this is the actual regression: it used to bubble
  // "fatal: bad object" all the way out of checkAndCapture.
  const diff = adapter.checkAndCapture();

  // The prior state is genuinely unrecoverable, so no diff is reported for
  // THIS transition (accepted, documented degradation) — but the checkpoint
  // must have self-healed to the current state rather than staying broken.
  assert.equal(diff.files.length, 0);
  const healedTree = getCheckpointTree(db, sessionId, repo);
  assert.ok(healedTree && /^[0-9a-f]{40}$/.test(healedTree), "checkpoint must be re-seeded to a real tree SHA");

  // Prove it's actually healed, not just silently broken in a different
  // way: a SUBSEQUENT real edit must be captured normally.
  fs.writeFileSync(
    path.join(repo, "app.ts"),
    "export function original() {\n  return 1;\n}\n\nexport function addedByAgent() {\n  return 2;\n}\n\nexport function addedAfterHeal() {\n  return 3;\n}\n"
  );
  const nextDiff = adapter.checkAndCapture();
  assert.equal(nextDiff.files.length, 1);
  assert.equal(nextDiff.files[0].path, "app.ts");

  db.close();
});
