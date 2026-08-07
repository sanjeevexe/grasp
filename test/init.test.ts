import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

/**
 * Regression test for a transparency bug an independent test pass found:
 * `grasp init` claims its preview shows exactly what it will write, but the
 * preview printed each hook entry as a bare object, while the settings file
 * Claude Code actually reads stores each event's hook entries inside an
 * ARRAY (see src/init.ts's HooksSection type) — so the preview and the
 * write were not the same JSON shape. Spawns the real built CLI binary
 * since the bug is in runInit's own message-building/confirmation flow.
 */

const CLI_PATH = path.resolve(process.cwd(), "dist/cli.js");

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo(): string {
  const repo = mkTempDir("grasp-test-init-repo-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "initial"]);
  return repo;
}

function runInit(repo: string, home: string, answer: string): string {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, "init"], {
      cwd: repo,
      env: { ...process.env, HOME: home },
      input: answer,
    });
    return stdout.toString();
  } catch (err) {
    const e = err as { stdout: Buffer; stderr: Buffer };
    throw new Error(`grasp init failed: ${e.stderr?.toString()}`);
  }
}

test("grasp init: the preview JSON shape exactly matches what gets written to settings.local.json", () => {
  const repo = initRepo();
  const home = mkTempDir("grasp-test-init-home-");

  const output = runInit(repo, home, "y\n");

  const settingsPath = path.join(repo, ".claude", "settings.local.json");
  const written = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));

  // Extract the JSON block the preview printed (between the "will add" line
  // and the first blank line following it).
  const previewMatch = output.match(/Grasp will add the following hook\(s\).*?\n\n([\s\S]*?)\n\n/);
  assert.ok(previewMatch, "expected to find a preview JSON block in stdout");
  const previewed = JSON.parse(previewMatch![1]);

  for (const eventName of ["PreToolUse", "PostToolUse", "Stop"]) {
    assert.ok(Array.isArray(previewed.hooks[eventName]), `previewed ${eventName} must be an array, matching the written file's shape`);
    assert.deepEqual(previewed.hooks[eventName], written.hooks[eventName], `previewed ${eventName} must exactly match what was written`);
  }
});
