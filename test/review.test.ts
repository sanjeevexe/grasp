import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { getPendingQuestions, insertEvent, openStore } from "../src/store";
import { resolveRepoRoot } from "../src/git";
import { mkTempDir, runPty } from "./helpers";

/**
 * Coverage for `grasp review`'s default-to-current-repo scoping, added
 * after a real dogfooding session found the previous global-across-all-repos
 * default confusing: a user in one small repo got served a pile of unrelated
 * pending questions left over from entirely different repos, with no
 * indication they weren't about the repo the user was sitting in. See
 * DECISIONS.md's "grasp review defaults to the current repo" entry (which
 * supersedes the earlier "query scope: global" entry). Concept-tag
 * memoization itself stays global and untouched — only what a review batch
 * *shows* changed.
 */

function tempDbPath(): string {
  const dir = mkTempDir("grasp-test-review-db-");
  return path.join(dir, "history.db");
}

function seedPendingQuestion(db: ReturnType<typeof openStore>, repo: string, questionInstance: string): number {
  return insertEvent(db, {
    timestamp: new Date().toISOString(),
    repo,
    sessionId: null,
    diffHash: null,
    diffSummary: "1 file changed",
    questionConcept: null,
    questionInstance,
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

// --- getPendingQuestions repo scoping (store-level) -------------------------

test("getPendingQuestions: with no repoRoot, returns pending questions across every repo (the --all behavior)", () => {
  const db = openStore(tempDbPath());
  seedPendingQuestion(db, "/tmp/repo-a", "question about a");
  seedPendingQuestion(db, "/tmp/repo-b", "question about b");
  assert.equal(getPendingQuestions(db).length, 2);
  db.close();
});

test("getPendingQuestions: with a repoRoot, only returns that repo's pending questions when multiple repos have pending events", () => {
  const db = openStore(tempDbPath());
  seedPendingQuestion(db, "/tmp/repo-a", "question about a");
  seedPendingQuestion(db, "/tmp/repo-b", "question about b");
  seedPendingQuestion(db, "/tmp/repo-a", "second question about a");

  const scoped = getPendingQuestions(db, "/tmp/repo-a");
  assert.equal(scoped.length, 2);
  assert.ok(scoped.every((e) => e.repo === "/tmp/repo-a"));
  db.close();
});

test("getPendingQuestions: a repoRoot with no pending questions of its own returns empty, even though other repos have some", () => {
  const db = openStore(tempDbPath());
  seedPendingQuestion(db, "/tmp/repo-b", "question about b");
  assert.equal(getPendingQuestions(db, "/tmp/repo-a").length, 0);
  db.close();
});

// --- repo-root resolution from a subdirectory --------------------------------

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo(): string {
  const repo = mkTempDir("grasp-test-review-repo-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "file.txt"), "hello\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  return repo;
}

test("getPendingQuestions: scoping by a repo root resolved from a subdirectory (via resolveRepoRoot) still matches events recorded at the repo root", () => {
  const repo = initRepo();
  const realRepo = fs.realpathSync(repo);
  const subdir = path.join(repo, "src", "nested");
  fs.mkdirSync(subdir, { recursive: true });

  const db = openStore(tempDbPath());
  seedPendingQuestion(db, realRepo, "question about this repo");
  seedPendingQuestion(db, "/tmp/some-other-repo", "question about another repo");

  const resolvedRoot = resolveRepoRoot(subdir);
  assert.equal(resolvedRoot, realRepo, "resolveRepoRoot from a subdirectory must resolve to the same repo root");

  const scoped = getPendingQuestions(db, resolvedRoot);
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].questionInstance, "question about this repo");
  db.close();
});

// --- `grasp review` / `grasp review --all` end to end (real pty) ------------
//
// A shared scratch $HOME (so both repos' events land in the same
// ~/.grasp/history.db) with two distinct, non-git scratch "repos" — plain
// directories are enough here since `resolveRepoRoot` simply falls back to
// its input for anything that isn't a git work tree, matching how a
// dogfooding user's actual small test repos behaved.

function seedTwoRepoHome(): { home: string; repoA: string; repoB: string; dbPath: string } {
  const home = mkTempDir("grasp-test-review-pty-home-");
  const rawRepoA = path.join(home, "repo-a");
  const rawRepoB = path.join(home, "repo-b");
  fs.mkdirSync(rawRepoA, { recursive: true });
  fs.mkdirSync(rawRepoB, { recursive: true });
  // realpath'd: on macOS, os.tmpdir() paths run through a /var ->
  // /private/var symlink, and a real child process's own process.cwd()
  // resolves through that symlink after chdir'ing — a repo field seeded
  // with the un-resolved path would silently never match
  // resolveRepoRoot's output.
  const repoA = fs.realpathSync(rawRepoA);
  const repoB = fs.realpathSync(rawRepoB);

  const dbPath = path.join(home, ".grasp", "history.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openStore(dbPath);
  seedPendingQuestion(db, repoA, "Instance question: why does repo A's cache need a lock?");
  seedPendingQuestion(db, repoB, "Instance question: why does repo B's queue need a retry?");
  db.close();

  return { home, repoA, repoB, dbPath };
}

test(
  "grasp review: defaults to only the current repo's pending questions",
  { timeout: 20_000 },
  async () => {
    const { home, repoA } = seedTwoRepoHome();

    const result = await runPty(
      ["review"],
      [
        { type: "wait_for", text: "why does repo A's cache need a lock?", timeout: 8 },
        { type: "sleep", seconds: 0.3 },
      ],
      { ...process.env, HOME: home },
      repoA
    );

    assert.equal(result.code, 0, `pty driver reported a failure: ${result.stderr}`);
  }
);

test(
  "grasp review --all: shows pending questions from every repo",
  { timeout: 20_000 },
  async () => {
    const { home, repoA } = seedTwoRepoHome();

    const result = await runPty(
      ["review", "--all"],
      [
        { type: "wait_for", text: "why does repo A's cache need a lock?", timeout: 8 },
        { type: "sleep", seconds: 0.3 },
      ],
      { ...process.env, HOME: home },
      repoA
    );

    assert.equal(result.code, 0, `pty driver reported a failure: ${result.stderr}`);
  }
);

test(
  "grasp review: 'nothing pending here, but N pending elsewhere' message when only other repos have pending questions",
  { timeout: 20_000 },
  async () => {
    const home = mkTempDir("grasp-test-review-pty-home-");
    const repoA = path.join(home, "repo-a");
    const repoB = path.join(home, "repo-b");
    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });

    const dbPath = path.join(home, ".grasp", "history.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = openStore(dbPath);
    seedPendingQuestion(db, repoB, "Instance question: why does repo B's queue need a retry?");
    db.close();

    const result = await runPty(
      ["review"],
      [
        {
          type: "wait_for",
          text: "No pending questions for this repo. 1 question pending in other repos",
          timeout: 8,
        },
      ],
      { ...process.env, HOME: home },
      repoA
    );

    assert.equal(result.code, 0, `pty driver reported a failure: ${result.stderr}`);
  }
);

test(
  "grasp review: plain 'all caught up' message when there is truly nothing pending anywhere",
  { timeout: 20_000 },
  async () => {
    const home = mkTempDir("grasp-test-review-pty-home-");
    const repoA = path.join(home, "repo-a");
    fs.mkdirSync(repoA, { recursive: true });

    const result = await runPty(
      ["review"],
      [{ type: "wait_for", text: "No pending questions — you're caught up.", timeout: 8 }],
      { ...process.env, HOME: home },
      repoA
    );

    assert.equal(result.code, 0, `pty driver reported a failure: ${result.stderr}`);
  }
);

test(
  "grasp review: run from a subdirectory of a repo, still scopes to that repo's own pending questions",
  { timeout: 20_000 },
  async () => {
    const home = mkTempDir("grasp-test-review-pty-home-");
    const repoA = path.join(home, "repo-a");
    fs.mkdirSync(repoA, { recursive: true });
    git(repoA, ["init", "-q"]);
    git(repoA, ["config", "user.email", "test@example.com"]);
    git(repoA, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repoA, "file.txt"), "hello\n");
    git(repoA, ["add", "-A"]);
    git(repoA, ["commit", "-q", "-m", "initial"]);
    const realRepoA = fs.realpathSync(repoA);
    const subdir = path.join(repoA, "src", "nested");
    fs.mkdirSync(subdir, { recursive: true });

    const dbPath = path.join(home, ".grasp", "history.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = openStore(dbPath);
    seedPendingQuestion(db, realRepoA, "Instance question: why does repo A's cache need a lock?");
    db.close();

    const result = await runPty(
      ["review"],
      [{ type: "wait_for", text: "why does repo A's cache need a lock?", timeout: 8 }],
      { ...process.env, HOME: home },
      subdir
    );

    assert.equal(result.code, 0, `pty driver reported a failure: ${result.stderr}`);
  }
);
