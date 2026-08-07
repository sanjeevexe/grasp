import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

/**
 * Regression test for the most severe bug an independent test pass found:
 * a syntactically valid config with the wrong field type crashed the hook,
 * and — because the checkpoint used to advance BEFORE the config/filter
 * step ran — the edit that triggered the crash was permanently lost; a
 * retry after fixing the config only captured the config fix itself, not
 * the original change. `checkAndCapture` now does the whole claim (read
 * checkpoint, diff, load config, filter, record capture, advance
 * checkpoint) inside one transaction, so an error anywhere in that
 * sequence rolls the whole thing back — the checkpoint stays exactly where
 * it was, and the SAME diff is captured on the next successful attempt.
 *
 * `src/paths.ts` computes GRASP_HOME/GLOBAL_CONFIG_PATH from `os.homedir()`
 * as MODULE-LEVEL constants at first import, and ClaudeCodeAdapter's
 * internal `loadConfig(repoPath)` call always uses those real production
 * paths (no injection point, matching every other real call site in the
 * codebase). To exercise this through the real adapter without touching a
 * developer's actual `~/.grasp`, `HOME` is overridden BEFORE `src/store`/
 * `src/adapters/claudeCodeAdapter` are ever loaded in this process, via
 * deferred `require()` inside the test body rather than a static top-level
 * `import` (which would already have run, and cached the real
 * `os.homedir()`-derived paths, before this test body executes).
 */

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepoWithCommit(): string {
  const repo = mkTempDir("grasp-test-cfgrollback-repo-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "app.ts"), "export function original() {\n  return 1;\n}\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  return repo;
}

test("checkAndCapture: an invalid repo config rolls back the checkpoint instead of losing the edit", () => {
  const graspHome = mkTempDir("grasp-test-cfgrollback-home-");
  const originalHome = process.env.HOME;
  process.env.HOME = graspHome;

  // Deferred require, AFTER HOME is set — see this file's module doc
  // comment for why a static top-level import would be too late.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { openStore, getCheckpointTree } = require("../src/store");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ClaudeCodeAdapter } = require("../src/adapters/claudeCodeAdapter");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { GRASP_HOME } = require("../src/paths");

  assert.equal(
    GRASP_HOME,
    path.join(graspHome, ".grasp"),
    "sanity check: GRASP_HOME must reflect the overridden HOME, proving this test doesn't touch the real one"
  );

  const repo = initRepoWithCommit();
  const dbPath = path.join(mkTempDir("grasp-test-cfgrollback-db-"), "history.db");
  const sessionId = "cfg-rollback-session";
  const promptId = "cfg-rollback-prompt";

  try {
    const db = openStore(dbPath);
    const adapter = new ClaudeCodeAdapter(db, sessionId, promptId, repo);
    adapter.ensureTurnStarted();
    adapter.ensureCheckpointSeeded();
    const checkpointBeforeEdit = getCheckpointTree(db, sessionId, repo);

    // An invalid repo config — wrong type, exactly the shape the original
    // bug report reproduced.
    fs.writeFileSync(path.join(repo, ".grasp.json"), JSON.stringify({ ignorePatterns: "scripts/" }), "utf-8");

    // The real edit that must not be lost.
    fs.writeFileSync(
      path.join(repo, "app.ts"),
      "export function original() {\n  return 1;\n}\n\nexport function addedByAgent() {\n  return 2;\n}\n"
    );

    assert.throws(() => adapter.checkAndCapture(), /ignorePatterns must be an array of strings/);

    // The checkpoint must be untouched — still pointing at the pre-edit
    // state, not advanced past the diff that failed to record.
    assert.equal(getCheckpointTree(db, sessionId, repo), checkpointBeforeEdit);
    // And nothing should have been recorded for this failed attempt either.
    const capturedCount = db
      .prepare(`SELECT COUNT(*) AS n FROM captured_diffs WHERE session_id = ?`)
      .get(sessionId) as { n: number };
    assert.equal(capturedCount.n, 0);

    // Fix the config and retry — the SAME diff (the real edit) must now be
    // captured, not silently gone.
    fs.writeFileSync(path.join(repo, ".grasp.json"), JSON.stringify({ ignorePatterns: ["scripts/"] }), "utf-8");
    const diff = adapter.checkAndCapture();
    assert.equal(
      diff.files.some((f: { path: string }) => f.path === "app.ts"),
      true,
      "the original edit must still be captured, not lost"
    );

    db.close();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
