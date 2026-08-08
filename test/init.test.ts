import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

/**
 * Regression tests for two `grasp init` confirmation-preview bugs found by
 * independent test passes:
 *
 * 1. A transparency bug: `grasp init` claims its preview shows exactly what
 *    it will write, but the preview printed each hook entry as a bare
 *    object, while the settings file Claude Code actually reads stores each
 *    event's hook entries inside an ARRAY (see src/init.ts's HooksSection
 *    type) — so the preview and the write were not the same JSON shape.
 * 2. A real dogfooding usability bug: printing the full literal hook JSON
 *    unconditionally, before even asking "Apply these changes?", was
 *    confusing on first run. The JSON is now collapsed by default behind a
 *    short summary line, with the exact literal JSON still available
 *    verbatim on request (typing "v") — see DECISIONS.md's "grasp init:
 *    collapse JSON preview by default" entry. Guarantee (1) must keep
 *    holding for whatever the "v" view prints, which is what these tests
 *    check; a second test locks in that the collapsed default view never
 *    leaks the raw JSON un-requested.
 *
 * Spawns the real built CLI binary since both bugs are in runInit's own
 * message-building/confirmation flow.
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

test("grasp init: the JSON is collapsed by default — no literal hook JSON appears before the user asks to view it", () => {
  const repo = initRepo();
  const home = mkTempDir("grasp-test-init-home-");

  // Plain "y" with no "v" — the default path a user takes if they never ask
  // to view the JSON. If this regresses back to always-printing the JSON,
  // this string would appear in the output before the confirmation prompt.
  const output = runInit(repo, home, "y\n");

  assert.ok(output.includes("Grasp will add hook(s) for: PreToolUse, PostToolUse, Stop"), "the collapsed summary line must still be shown");
  assert.ok(!output.includes('"type": "command"'), "the literal hook JSON must never appear unless the user explicitly asks to view it");
  assert.ok(output.includes("Apply these changes?"), "the plain-language explanation and confirmation prompt must still be shown");

  // The write itself must still succeed the same as before — collapsing the
  // preview must not affect the underlying apply flow.
  const settingsPath = path.join(repo, ".claude", "settings.local.json");
  assert.ok(fs.existsSync(settingsPath), "answering y with no view request must still write the settings file");
});

test("grasp init: the preview JSON shown on request ('v') exactly matches what gets written to settings.local.json", () => {
  const repo = initRepo();
  const home = mkTempDir("grasp-test-init-home-");

  const output = runInit(repo, home, "v\ny\n");

  const settingsPath = path.join(repo, ".claude", "settings.local.json");
  const written = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));

  // Extract the JSON block the "v" view printed (between the "Exact JSON
  // Grasp will add" line and the first blank line following it).
  const previewMatch = output.match(/Exact JSON Grasp will add to.*?:\n\n([\s\S]*?)\n\n/);
  assert.ok(previewMatch, "expected to find a viewed JSON block in stdout after answering 'v'");
  const previewed = JSON.parse(previewMatch![1]);

  for (const eventName of ["PreToolUse", "PostToolUse", "Stop"]) {
    assert.ok(Array.isArray(previewed.hooks[eventName]), `previewed ${eventName} must be an array, matching the written file's shape`);
    assert.deepEqual(previewed.hooks[eventName], written.hooks[eventName], `previewed ${eventName} must exactly match what was written`);
  }
});

test("grasp init: a stale existing hook's viewed before/after diff matches the real prior file and the real write", () => {
  const repo = initRepo();
  const home = mkTempDir("grasp-test-init-home-");

  // Seed a pre-existing, out-of-date install (old timeout value) the same
  // way an older `grasp init` run would have left it.
  const settingsPath = path.join(repo, ".claude", "settings.local.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const staleBefore = {
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "grasp internal:hook", timeout: 15 }] }],
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(staleBefore, null, 2));

  const collapsedOutput = runInit(repo, home, "n\n");
  assert.ok(collapsedOutput.includes("Grasp will UPDATE out-of-date hook(s) for: PreToolUse"), "the collapsed stale summary line must be shown");
  assert.ok(!collapsedOutput.includes('"timeout": 15'), "the literal before/after JSON must never appear unless the user asks to view it");
  assert.ok(fs.readFileSync(settingsPath, "utf-8").includes('"timeout": 15'), "declining must leave the stale file untouched");

  const viewedOutput = runInit(repo, home, "v\ny\n");
  assert.ok(viewedOutput.includes('before: [{"matcher":"*","hooks":[{"type":"command","command":"grasp internal:hook","timeout":15}]}]'), "the viewed 'before' must exactly reflect the real prior file content, not a paraphrase");

  const written = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  assert.equal(written.hooks.PreToolUse[0].hooks[0].timeout, 45, "accepting the update must actually rewrite the stale timeout");
});
