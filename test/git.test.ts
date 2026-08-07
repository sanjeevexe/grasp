import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync, spawnSync } from "child_process";
import { EMPTY_TREE_HASH, isMissingGitObjectError, resolveRepoRoot, runGit } from "../src/git";

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo(): string {
  const repo = mkTempDir("grasp-test-gitroot-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "file.txt"), "hello\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  return repo;
}

// --- resolveRepoRoot ------------------------------------------------------
//
// Regression coverage for the "repo overrides vanish in a subdirectory" bug
// an independent test pass found: config loading (and therefore hard-gate,
// cost cap, question cap, ignore patterns) used the exact `cwd` Claude Code
// reported, which is often a subdirectory of the actual repo — so a
// repo-root `.grasp.json` silently stopped applying whenever a session's
// cwd wasn't the exact repo root.

test("resolveRepoRoot: resolves to the repo root when called from the root itself", () => {
  const repo = initRepo();
  const realRepo = fs.realpathSync(repo);
  assert.equal(fs.realpathSync(resolveRepoRoot(repo)), realRepo);
});

test("resolveRepoRoot: resolves to the SAME repo root when called from a subdirectory", () => {
  const repo = initRepo();
  const subdir = path.join(repo, "src", "nested");
  fs.mkdirSync(subdir, { recursive: true });
  const realRepo = fs.realpathSync(repo);
  assert.equal(fs.realpathSync(resolveRepoRoot(subdir)), realRepo);
});

test("resolveRepoRoot: falls back to the given path when it isn't inside a git work tree", () => {
  const notARepo = mkTempDir("grasp-test-not-a-repo-");
  assert.equal(resolveRepoRoot(notARepo), notARepo);
});

// --- isMissingGitObjectError -----------------------------------------------
//
// Regression coverage for the "git prune breaks capture permanently" bug:
// Grasp's checkpoint trees are deliberately unreferenced dangling objects,
// so `git gc`/`git prune` can reclaim one out from under a stored
// checkpoint. Diffing against a since-pruned tree SHA fails with "fatal:
// bad object <sha>" — this must be distinguished from any other git
// failure so the caller can self-heal instead of failing forever.

test("isMissingGitObjectError: true for a real 'fatal: bad object' failure from git", () => {
  const repo = initRepo();
  const fakeSha = "0123456789abcdef0123456789abcdef01234567";
  let caught: unknown;
  try {
    runGit(repo, ["diff", "--no-color", "-M", "--name-status", fakeSha, "HEAD"]);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "expected runGit to throw for a nonexistent object");
  assert.equal(isMissingGitObjectError(caught), true);
});

test("isMissingGitObjectError: false for an unrelated git failure", () => {
  const repo = initRepo();
  let caught: unknown;
  try {
    runGit(repo, ["not-a-real-git-command"]);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  assert.equal(isMissingGitObjectError(caught), false);
});

test("isMissingGitObjectError: false for a plain Error unrelated to git", () => {
  assert.equal(isMissingGitObjectError(new Error("something else entirely")), false);
});

// --- runGit stderr isolation ------------------------------------------------
//
// Regression coverage for the "expected git failure leaks to the user" bug
// an independent test pass found: `resolveBaseRef`'s `rev-parse --verify
// HEAD` probe is EXPECTED to fail in a brand-new repo with no commits yet
// (that's how it decides to fall back to git's empty-tree hash), but
// `runGit`'s underlying `execFileSync` call left stderr on Node's default
// (inherited) setting, so git's own "fatal: Needed a single revision"
// message printed straight to the real process's stderr as if something had
// actually gone wrong, even though the call succeeded end to end. This has
// to be checked from a REAL child process (not by calling runGit in-process
// and inspecting the caught error), since the leak is specifically about
// what got written to the process's own stderr stream, independent of
// whatever the error object itself carries.

const GIT_STDERR_FIXTURE = path.resolve(process.cwd(), "test-dist/test/fixtures/gitStderrWorker.js");

test("runGit: an expected git failure (no commits yet) never leaks to the process's own stderr", () => {
  assert.ok(
    fs.existsSync(GIT_STDERR_FIXTURE),
    `compiled fixture not found at ${GIT_STDERR_FIXTURE} — run \`npm test\` (which builds test-dist first)`
  );
  const repo = mkTempDir("grasp-test-no-commits-");
  git(repo, ["init", "-q"]);

  const result = spawnSync(process.execPath, [GIT_STDERR_FIXTURE, repo], { encoding: "utf-8" });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), EMPTY_TREE_HASH);
  assert.equal(result.stderr.trim(), "", `expected no stderr output, got: ${result.stderr}`);
});
