import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { captureDiffBetweenTrees, resolveNumstatNewPath, writeWorktreeTree } from "../src/adapters/gitDiffCapture";

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

// --- resolveNumstatNewPath --------------------------------------------
//
// Regression coverage for the "edited nested renames lose their size" bug:
// `git diff --numstat` compacts a rename's shared prefix/suffix into a
// `{old => new}` brace form whenever old and new paths share one, instead
// of always spelling out the full old and new paths. The naive
// `pathField.split(" => ")[1]` only handled the (rarer, no-shared-prefix)
// full-path form.

test("resolveNumstatNewPath: plain (no shared prefix) rename form", () => {
  assert.equal(resolveNumstatNewPath("old/path.ts => new/path.ts"), "new/path.ts");
});

test("resolveNumstatNewPath: compact brace form with a shared directory prefix", () => {
  assert.equal(
    resolveNumstatNewPath("src/{rename-source-verbose.ts => rename-target-verbose.ts}"),
    "src/rename-target-verbose.ts"
  );
});

test("resolveNumstatNewPath: compact brace form with both a shared prefix and suffix", () => {
  assert.equal(resolveNumstatNewPath("common/{old => new}/rest.ts"), "common/new/rest.ts");
});

test("resolveNumstatNewPath: a plain (non-renamed) path is returned unchanged", () => {
  assert.equal(resolveNumstatNewPath("src/app.ts"), "src/app.ts");
});

// --- End-to-end: an edited rename through the real checkpoint-diff path --
//
// Uses `writeWorktreeTree`/`captureDiffBetweenTrees` — the actual
// tree-vs-tree mechanism `ClaudeCodeAdapter` uses (see gitDiffCapture.ts's
// checkpoint module doc) — rather than `captureGitDiff`/HEAD, since a
// rename of an untracked-in-the-diff file only gets paired into an R-status
// entry by git when BOTH the old and new paths are part of the same
// comparison (true for a tree-vs-tree diff; not true for a plain `git diff
// HEAD` against an unstaged worktree, where the new path is simply
// untracked and invisible to that diff entirely — verified empirically
// before writing this test).

test("captureDiffBetweenTrees: an edited-and-renamed file keeps its real insertion/deletion counts, not 0/0", () => {
  const repo = mkTempDir("grasp-test-rename-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);

  const original = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n";
  fs.writeFileSync(path.join(repo, "rename-source-verbose.ts"), original, "utf-8");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  const beforeTree = writeWorktreeTree(repo);

  // Rename AND edit — enough shared content for git to detect it as a
  // rename (not delete+add) and enough of a shared path prefix that
  // `--numstat` uses the compact brace form rather than spelling out both
  // full paths.
  fs.renameSync(path.join(repo, "rename-source-verbose.ts"), path.join(repo, "rename-target-verbose.ts"));
  const edited = original + "line 20\nline 21\n";
  fs.writeFileSync(path.join(repo, "rename-target-verbose.ts"), edited, "utf-8");
  const afterTree = writeWorktreeTree(repo);

  const diff = captureDiffBetweenTrees(repo, beforeTree, afterTree, `${beforeTree}..${afterTree}`);
  const renamed = diff.files.find((f) => f.status === "renamed");
  assert.ok(renamed, "expected a renamed file entry");
  assert.equal(renamed!.path, "rename-target-verbose.ts");
  assert.equal(renamed!.oldPath, "rename-source-verbose.ts");
  assert.equal(renamed!.insertions, 2, "the 2 real added lines must be counted, not lost to 0");
  assert.equal(renamed!.deletions, 0);
});
