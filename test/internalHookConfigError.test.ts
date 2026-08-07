import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync, spawnSync } from "child_process";

/**
 * Regression test for a real reliability bug an independent test pass
 * found: `main()` (src/cli.ts) called `ensureInitialized(process.cwd())` —
 * which loads and VALIDATES config, throwing on a malformed `.grasp.json` —
 * before dispatching to `internal:hook`, so an invalid repo config escaped
 * to main()'s own top-level `.catch()`, which sets `process.exitCode = 1`.
 * Per Claude Code's hook docs, exit 1 is non-blocking (the tool action still
 * proceeds) but Claude Code shows a hook-error notice on every firing — the
 * opposite of `runInternalHook`'s own documented "never exit nonzero, never
 * surface a visible failure" contract. Spawns the real built CLI binary
 * (not a direct function import) because the bug is specifically about
 * `main()`'s top-level dispatch order, which only exists at the process
 * entry point.
 */

const CLI_PATH = path.resolve(process.cwd(), "dist/cli.js");

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepoWithInvalidConfig(): string {
  const repo = mkTempDir("grasp-test-hook-cfgerr-repo-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "initial"]);
  // A realistic typo, the exact shape the report reproduced.
  fs.writeFileSync(path.join(repo, ".grasp.json"), JSON.stringify({ gateMod: "hard" }), "utf-8");
  return repo;
}

/**
 * Uses `spawnSync`, not `execFileSync`, deliberately: `execFileSync` only
 * gives you `stdout`/`stderr` back when it throws (i.e. on a nonzero exit),
 * which meant an earlier version of this helper hardcoded `stderr: ""` on
 * the success path — silently discarding whatever the process actually
 * wrote to stderr on a normal exit 0. That's exactly the kind of gap that
 * would make a test claiming a hook "exits 0 quietly" pass whether or not
 * it actually stayed quiet. `spawnSync` reports both streams regardless of
 * exit code, so a real assertion on stderr content is possible even for the
 * (intended, documented) exit-0-but-still-logs-a-diagnostic case.
 */
function runCli(args: string[], cwd: string, home: string, input?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, HOME: home },
    input: input ?? "",
  });
  return { status: result.status, stdout: result.stdout?.toString() ?? "", stderr: result.stderr?.toString() ?? "" };
}

test("internal:hook: an invalid .grasp.json exits 0 with no stdout hookOutput, but does write a diagnostic to stderr", () => {
  const repo = initRepoWithInvalidConfig();
  const home = mkTempDir("grasp-test-hook-cfgerr-home-");

  const payload = JSON.stringify({ session_id: "s1", hook_event_name: "PreToolUse", cwd: repo });
  const result = runCli(["internal:hook"], repo, home, payload);

  // "Quiet" here means "exit 0, no hookOutput on stdout that could deny/alter
  // the tool call" — NOT "silent." runInternalHook() deliberately still
  // writes a diagnostic to stderr (src/cli.ts's catch block) so the failure
  // isn't invisible to someone debugging, even though it must never fail the
  // hook itself. Whether Claude Code surfaces stderr from a successful (exit
  // 0) hook to the user is not something this test can verify without a real
  // authenticated session — see the README/TESTING_GUIDE's noted blind spot.
  assert.equal(result.status, 0, `internal:hook must exit 0 even with an invalid repo config; got status=${result.status}, stderr=${result.stderr}`);
  assert.equal(result.stdout, "", "no hookOutput should be emitted when the hook errored out internally");
  assert.match(result.stderr, /gateMod/, "the diagnostic should name the actual invalid config field, for anyone who does go looking");
});

test("internal:hook: same invalid config across PostToolUse and Stop also exits 0 quietly", () => {
  const repo = initRepoWithInvalidConfig();
  const home = mkTempDir("grasp-test-hook-cfgerr-home-2-");

  for (const eventName of ["PostToolUse", "Stop"]) {
    const payload = JSON.stringify({ session_id: "s1", hook_event_name: eventName, cwd: repo });
    const result = runCli(["internal:hook"], repo, home, payload);
    assert.equal(result.status, 0, `${eventName}: expected exit 0, got status=${result.status}, stderr=${result.stderr}`);
  }
});

test("internal:hook: ordinary foreground commands still fail loudly (exit 1, clear message) on the same invalid config — this behavior must not regress", () => {
  const repo = initRepoWithInvalidConfig();
  const home = mkTempDir("grasp-test-hook-cfgerr-home-3-");

  const result = runCli(["--version"], repo, home);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /gateMod/);
});
