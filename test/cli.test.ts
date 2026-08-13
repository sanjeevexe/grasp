import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

/**
 * Regression tests for Prompt 5: dev-only commands (`debug:*`, `internal:hook`)
 * must never appear in printed help output, but must still run correctly
 * when invoked by name. Spawns the real built CLI binary since both the
 * printed-help and dispatch behavior live in cli.ts's own main().
 */

const CLI_PATH = path.resolve(process.cwd(), "dist/cli.js");
const DEV_COMMAND_NAMES = ["debug:seed", "debug:capture", "debug:answer", "internal:hook"];

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo(): string {
  const repo = mkTempDir("grasp-test-cli-repo-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "initial"]);
  return repo;
}

function run(
  repo: string,
  home: string,
  args: string[],
  input?: string
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd: repo,
      env: { ...process.env, HOME: home },
      input: input ?? "",
    });
    return { stdout: stdout.toString(), stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stdout: Buffer; stderr: Buffer; status: number };
    return { stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "", status: e.status ?? 1 };
  }
}

test("grasp --help lists only public commands, never debug:*/internal:hook", () => {
  const repo = initRepo();
  const home = mkTempDir("grasp-test-cli-home-");

  const { stdout } = run(repo, home, ["--help"]);

  for (const name of DEV_COMMAND_NAMES) {
    assert.ok(!stdout.includes(name), `--help output should not mention ${name}`);
  }
  // Sanity check the public commands are still there.
  for (const name of ["init", "review", "scan", "set", "reset", "export"]) {
    assert.ok(stdout.includes(`grasp ${name}`), `--help output should still mention grasp ${name}`);
  }
});

test("grasp with an unrecognized command shows the same trimmed, public-only help", () => {
  const repo = initRepo();
  const home = mkTempDir("grasp-test-cli-home-");

  const { stdout, stderr, status } = run(repo, home, ["somebadcommand"]);

  assert.equal(status, 1);
  assert.ok(stderr.includes("Unknown command: somebadcommand"));
  for (const name of DEV_COMMAND_NAMES) {
    assert.ok(!stdout.includes(name), `unknown-command fallback should not mention ${name}`);
  }
  assert.ok(stdout.includes("grasp init"));
});

test("grasp debug:seed still runs correctly when invoked directly, despite being hidden from help", () => {
  const repo = initRepo();
  const home = mkTempDir("grasp-test-cli-home-");

  const { stdout, status } = run(repo, home, ["debug:seed"]);

  assert.equal(status, 0);
  assert.ok(stdout.includes("Inserted debug event id="));
});

test("grasp debug:capture still runs correctly when invoked directly", () => {
  const repo = initRepo();
  const home = mkTempDir("grasp-test-cli-home-");

  fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");

  const { stdout, status } = run(repo, home, ["debug:capture", repo]);

  assert.equal(status, 0);
  assert.ok(stdout.includes("Captured diff for"));
});

test("grasp debug:answer still runs correctly when invoked directly", () => {
  const repo = initRepo();
  const home = mkTempDir("grasp-test-cli-home-");

  const seeded = run(repo, home, ["debug:seed"]);
  const match = seeded.stdout.match(/Inserted debug event id=(\d+)/);
  assert.ok(match, "expected debug:seed to report an inserted event id");
  const eventId = match![1];

  const { stdout, status } = run(repo, home, ["debug:answer", eventId]);

  assert.equal(status, 0);
  assert.ok(stdout.includes(`Marked event id=${eventId} answered.`));
});

test("grasp internal:hook still runs correctly when invoked directly (never exits non-zero)", () => {
  const repo = initRepo();
  const home = mkTempDir("grasp-test-cli-home-");

  const payload = JSON.stringify({
    session_id: "test-session",
    hook_event_name: "PreToolUse",
    cwd: repo,
  });

  const { status } = run(repo, home, ["internal:hook"], payload);

  assert.equal(status, 0);
});
