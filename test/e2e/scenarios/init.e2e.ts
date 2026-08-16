import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { scenario } from "../lib/scenario";
import { initScratchRepo, isolatedHome, graspEnv, commitFile } from "../lib/env";
import { runGraspCli } from "../lib/cli";

/**
 * `grasp init` — TESTING_GUIDE.md §0's own checklist: the pre-write consent
 * explanation, the `v`/`y`/`N` flow (including viewing the literal JSON
 * before deciding), and no duplication on a second run. `grasp init` uses
 * plain `readline` against stdin (not ink raw-mode), so this drives it via
 * direct non-interactive CLI invocation with piped answers — a real pty
 * isn't needed here (see `test/e2e/lib/cli.ts`'s own doc comment for why).
 */

export const initScenarios = [
  scenario("init: consent explanation shown before writing, declining (N) writes nothing", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "README.md", "# scratch repo\n");
    const home = isolatedHome();
    const env = graspEnv(home);

    const result = runGraspCli(["init"], { cwd: repo, env, input: "N\n" });
    assert.equal(result.status, 0, `grasp init should exit 0 on decline; stderr=${result.stderr}`);

    // Plain-language explanation, read once for real per TESTING_GUIDE §0.
    assert.match(result.stdout, /observe file/, "must explain what the hooks do");
    assert.match(
      result.stdout,
      /existing Claude plan\/usage/,
      "must plainly disclose that question generation draws from the user's existing Claude plan/usage, not a hidden third thing"
    );
    assert.match(result.stdout, /Apply these changes\?/, "must show the confirmation prompt");
    assert.match(result.stdout, /Aborted — no changes made\./, "declining must say plainly that nothing was written");

    const settingsPath = path.join(repo, ".claude", "settings.local.json");
    assert.ok(!fs.existsSync(settingsPath), "declining must not create settings.local.json at all");
  }),

  scenario("init: 'v' shows the literal JSON before deciding, then y applies it", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "README.md", "# scratch repo\n");
    const home = isolatedHome();
    const env = graspEnv(home);

    const result = runGraspCli(["init"], { cwd: repo, env, input: "v\ny\n" });
    assert.equal(result.status, 0, `grasp init should exit 0; stderr=${result.stderr}`);
    assert.match(result.stdout, /Exact JSON Grasp will add/, "'v' must show the literal JSON, not a summary");
    assert.match(result.stdout, /"command": "grasp internal:hook"/, "the literal JSON preview must show the real hook command");
    assert.match(result.stdout, /Wrote .*settings\.local\.json/, "answering y after viewing must still apply the change");

    const settingsPath = path.join(repo, ".claude", "settings.local.json");
    assert.ok(fs.existsSync(settingsPath), "settings.local.json must exist after applying");
    const written = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    for (const eventName of ["PreToolUse", "PostToolUse", "Stop"]) {
      assert.ok(Array.isArray(written.hooks[eventName]), `${eventName} hook entry must be written`);
      assert.ok(
        written.hooks[eventName].some((e: any) => e.hooks?.some((h: any) => h.command === "grasp internal:hook")),
        `${eventName} must register the grasp internal:hook command`
      );
    }
  }),

  scenario("init: running again in the same repo reports 'already installed', writes nothing new", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "README.md", "# scratch repo\n");
    const home = isolatedHome();
    const env = graspEnv(home);

    const first = runGraspCli(["init"], { cwd: repo, env, input: "y\n" });
    assert.equal(first.status, 0);
    const settingsPath = path.join(repo, ".claude", "settings.local.json");
    const afterFirst = fs.readFileSync(settingsPath, "utf-8");

    const second = runGraspCli(["init"], { cwd: repo, env, input: "y\n" });
    assert.equal(second.status, 0, `stderr=${second.stderr}`);
    assert.match(second.stdout, /already installed and up to date/, "a second run must report no-op, not silently re-apply or duplicate");

    const afterSecond = fs.readFileSync(settingsPath, "utf-8");
    assert.equal(afterSecond, afterFirst, "a second grasp init must not modify the settings file at all");
    const parsed = JSON.parse(afterSecond);
    assert.equal(parsed.hooks.PreToolUse.length, 1, "no duplicate PreToolUse hook entries after a second init");
  }),
];
