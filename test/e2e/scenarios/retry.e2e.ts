import assert from "node:assert/strict";
import { scenario } from "../lib/scenario";
import { initScratchRepo, isolatedHome, graspEnv, commitFile, writeFile } from "../lib/env";
import { runGraspCli } from "../lib/cli";
import { fireFullTurn } from "../lib/hooks";
import { openHomeDb } from "../lib/db";
import { getUnresolvedCapturedDiffs } from "../../../src/store";

/**
 * `grasp retry` — nothing-to-retry, a genuine constructed timeout/error
 * outcome resolved on retry, and cross-session pickup (a diff from a
 * session that's no longer "live"). Real file edits + real hand-built hook
 * payloads throughout, matching gate.e2e.ts's own real-pipeline approach —
 * `grasp retry` itself has no interactive UI, so no pty is needed for the
 * command itself, only for the real capture pipeline that gets it into a
 * stuck state in the first place.
 */

export const retryScenarios = [
  scenario("retry: nothing to retry on a clean repo prints the plain message and exits 0", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "app.ts", "export function original() {\n  return 1;\n}\n");
    const home = isolatedHome();
    const env = graspEnv(home);

    const result = runGraspCli(["retry"], { cwd: repo, env });
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    assert.match(result.stdout, /Nothing to retry — no unresolved captured diffs for this repo\./);
  }),

  scenario("retry: a real error outcome from a real capture is resolved by a later `grasp retry`, from a session that's over", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "cache.ts", "export function original() {\n  return 1;\n}\n");
    const home = isolatedHome();
    const sessionId = "e2e-retry-error-session";

    // The failing turn: real capture, Stop attempt that errors (mock claude
    // mode "error") — the diff stays unresolved, and this session is never
    // touched again after this (exactly what "no longer live" means here —
    // there's no explicit session-close action in this codebase's model,
    // just the absence of any future hook firing for that session_id).
    const errorEnv = graspEnv(home, { mode: "error" });
    const { post, stop } = fireFullTurn(repo, errorEnv, sessionId, "p1", () => {
      writeFile(
        repo,
        "cache.ts",
        "export function original() {\n  return 1;\n}\n\nexport function addedByAgent() {\n  return 2;\n}\n\nexport function addedByAgentExtra() {\n  return 3;\n}\n"
      );
    });
    assert.equal(post.status, 0);
    assert.equal(stop.status, 0);
    assert.ok(stop.output, "an errored Stop attempt must still produce a visible failure systemMessage");
    assert.match((stop.output as any).systemMessage ?? "", /failed to generate \(error\)/, "must name the failure reason and point at grasp retry");

    const dbBefore = openHomeDb(home);
    assert.equal(getUnresolvedCapturedDiffs(dbBefore, sessionId, repo).length, 1, "the failed attempt must leave its diff unresolved, not lost");
    dbBefore.close();

    // A LATER, unrelated invocation — no session_id at all, matching how a
    // real user would run `grasp retry` well after the original session
    // ended. Mock claude now succeeds.
    const retryEnv = graspEnv(home, { mode: "normal", cost: "0.001" });
    const retryResult = runGraspCli(["retry"], { cwd: repo, env: retryEnv });
    assert.equal(retryResult.status, 0, `stderr=${retryResult.stderr}`);
    assert.match(retryResult.stdout, /Generated a new question from 1 previously-stuck diff — run `grasp review` to see it\./);

    const dbAfter = openHomeDb(home);
    assert.equal(getUnresolvedCapturedDiffs(dbAfter, sessionId, repo).length, 0, "retry must mark the originally-stuck diff resolved");
    const row = dbAfter.prepare(`SELECT session_id, question_type FROM events WHERE question_type IS NOT NULL`).get() as any;
    assert.ok(row, "retry must have produced a real question event");
    assert.match(row.session_id, /^retry-/, "the retried question must be recorded under a fresh synthetic retry- session, independent of the original dead session");
    dbAfter.close();
  }),

  scenario("retry: a genuine (not simulated) generation timeout is visibly reported, then resolved by a later retry", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "slow.ts", "export function original() {\n  return 1;\n}\n");
    const home = isolatedHome();
    const sessionId = "e2e-retry-timeout-session";

    // GENERATION_TIMEOUT_MS is a hardcoded 20s in src/generation.ts — this
    // forces the mock `claude` to sleep past it for real (Atomics.wait, a
    // genuine synchronous delay, not a simulated/injected error path), so
    // the resulting ETIMEDOUT is real, matching the prior TEST_LOG retest
    // pass's own "genuine ~20s ETIMEDOUT, not simulated" methodology.
    const slowEnv = graspEnv(home, { mode: "normal", delayMs: 22_000 });
    const { post, stop } = fireFullTurn(repo, slowEnv, sessionId, "p1", () => {
      writeFile(
        repo,
        "slow.ts",
        "export function original() {\n  return 1;\n}\n\nexport function addedByAgent() {\n  return 2;\n}\n\nexport function addedByAgentExtra() {\n  return 3;\n}\n"
      );
    });
    assert.equal(post.status, 0);
    assert.equal(stop.status, 0, `internal:hook must still exit 0 even after its own generation call genuinely times out; stderr=${stop.stderr}`);
    assert.ok(stop.output, "a genuinely timed-out Stop attempt must still produce a visible failure systemMessage");
    assert.match((stop.output as any).systemMessage ?? "", /failed to generate \(timeout\)/, "must name the failure as a timeout specifically, not a generic error");

    const fastEnv = graspEnv(home, { mode: "normal", cost: "0.001" });
    const retryResult = runGraspCli(["retry"], { cwd: repo, env: fastEnv });
    assert.equal(retryResult.status, 0, `stderr=${retryResult.stderr}`);
    assert.match(retryResult.stdout, /Generated a new question from 1 previously-stuck diff/);

    const db = openHomeDb(home);
    assert.equal(getUnresolvedCapturedDiffs(db, sessionId, repo).length, 0, "the genuinely-timed-out diff must be resolved after the retry");
    db.close();
  }),
];
