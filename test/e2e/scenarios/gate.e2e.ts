import assert from "node:assert/strict";
import { scenario } from "../lib/scenario";
import { initScratchRepo, isolatedHome, graspEnv, commitFile, writeFile } from "../lib/env";
import { runGraspCli } from "../lib/cli";
import { firePreToolUse, fireFullTurn } from "../lib/hooks";
import { openHomeDb } from "../lib/db";
import { insertEvent, markInstanceAnswered, HARD_GATE_MAX_AGE_MS } from "../../../src/store";

/**
 * The hard/soft gate (`PreToolUse`), driven via real hand-constructed hook
 * payloads piped into `grasp internal:hook` — soft never blocks; hard denies
 * the next tool call while a real pending question exists for the CURRENT
 * session, and unblocks immediately once it's answered. Also confirms the
 * gate only ever considers today's pending questions for that specific
 * session (`getBlockingPendingQuestionsForSession`'s 24h cutoff,
 * `src/store.ts`), not stale ones left over from days ago.
 */

function seedPendingEvent(home: string, repo: string, sessionId: string, timestamp: string): number {
  const db = openHomeDb(home);
  const id = insertEvent(db, {
    timestamp,
    repo,
    sessionId,
    diffHash: "e2e-gate-hash",
    diffSummary: "1 file changed",
    questionConcept: "What is a mutex?",
    questionInstance: "Given that, why was one used here?",
    questionType: "both",
    generationSource: "e2e-seed",
    missReason: null,
    answerConcept: null,
    answerInstance: null,
    skipped: false,
    skipReason: null,
    costUsd: 0.001,
    diffFiles: [],
  });
  db.close();
  return id;
}

export const gateScenarios = [
  scenario("gate: soft mode never blocks PreToolUse even with a real pending question", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "app.ts", "export function original() {\n  return 1;\n}\n");
    const home = isolatedHome();
    const env = graspEnv(home);
    const sessionId = "e2e-soft-session";

    // gateMode defaults to "soft" — no `grasp set gate` call needed.
    seedPendingEvent(home, repo, sessionId, new Date().toISOString());

    const result = firePreToolUse(repo, env, sessionId);
    assert.equal(result.status, 0, `internal:hook must always exit 0; stderr=${result.stderr}`);
    assert.equal(result.output, null, "soft gate must never emit a deny hookOutput, even with a real pending question");
  }),

  scenario("gate: hard mode denies PreToolUse with a real pending question, then unblocks immediately once answered", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "app.ts", "export function original() {\n  return 1;\n}\n");
    const home = isolatedHome();
    const env = graspEnv(home);
    const sessionId = "e2e-hard-session";

    const setGate = runGraspCli(["set", "gate", "hard"], { cwd: repo, env });
    assert.equal(setGate.status, 0, `grasp set gate hard failed: ${setGate.stderr}`);

    const eventId = seedPendingEvent(home, repo, sessionId, new Date().toISOString());

    const denied = firePreToolUse(repo, env, sessionId);
    assert.equal(denied.status, 0);
    assert.ok(denied.output, "hard gate with a real pending question must produce a deny hookOutput");
    assert.equal((denied.output as any).hookSpecificOutput?.permissionDecision, "deny", "must deny, not allow or ask");
    assert.match(
      (denied.output as any).hookSpecificOutput?.permissionDecisionReason ?? "",
      /question.*waiting.*grasp review/i,
      "the deny reason must point the user at grasp review"
    );

    // Simulate answering via `grasp review` (same DAL write review.ts's own
    // onResolved callback makes when the instance phase gets a real answer).
    const db = openHomeDb(home);
    markInstanceAnswered(db, eventId, "answered via e2e harness");
    db.close();

    const allowed = firePreToolUse(repo, env, sessionId);
    assert.equal(allowed.status, 0);
    assert.equal(allowed.output, null, "once the pending question is answered, PreToolUse must unblock immediately");

    const backToSoft = runGraspCli(["set", "gate", "soft"], { cwd: repo, env });
    assert.equal(backToSoft.status, 0);
  }),

  scenario("gate: hard mode only considers TODAY's pending questions for THIS session, not stale ones", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "app.ts", "export function original() {\n  return 1;\n}\n");
    const home = isolatedHome();
    const env = graspEnv(home);
    const sessionId = "e2e-stale-session";

    const setGate = runGraspCli(["set", "gate", "hard"], { cwd: repo, env });
    assert.equal(setGate.status, 0);

    // A pending question for THIS session, but old enough to be past
    // HARD_GATE_MAX_AGE_MS (24h) — must NOT block, per getBlockingPendingQuestionsForSession's
    // own cutoff (src/store.ts).
    const staleTimestamp = new Date(Date.now() - HARD_GATE_MAX_AGE_MS - 60_000).toISOString();
    seedPendingEvent(home, repo, sessionId, staleTimestamp);

    const staleResult = firePreToolUse(repo, env, sessionId);
    assert.equal(staleResult.output, null, "a stale (>24h) pending question for this session must never block PreToolUse");

    // Now add a genuinely fresh pending question for the SAME session — this one must block.
    seedPendingEvent(home, repo, sessionId, new Date().toISOString());
    const freshResult = firePreToolUse(repo, env, sessionId);
    assert.ok(freshResult.output, "a fresh pending question for this session must block PreToolUse");
    assert.equal((freshResult.output as any).hookSpecificOutput?.permissionDecision, "deny");

    // A pending question for a DIFFERENT session must not block this one.
    seedPendingEvent(home, repo, "e2e-other-session", new Date().toISOString());
    const otherSessionResult = firePreToolUse(repo, env, "e2e-yet-another-session");
    assert.equal(otherSessionResult.output, null, "a pending question from an unrelated session must never block a different session");
  }),

  scenario("gate: real end-to-end pipeline — real file edit, real capture+generation via hand-built hooks, then hard-gate block/unblock", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "cache.ts", "export function original() {\n  return 1;\n}\n");
    const home = isolatedHome();
    const env = graspEnv(home, { mode: "normal", cost: "0.002" });
    const sessionId = "e2e-realpipe-session";
    const promptId = "p1";

    const setGate = runGraspCli(["set", "gate", "hard"], { cwd: repo, env });
    assert.equal(setGate.status, 0);

    const { post, stop } = fireFullTurn(repo, env, sessionId, promptId, () => {
      writeFile(
        repo,
        "cache.ts",
        "export function original() {\n  return 1;\n}\n\nexport function addedByAgent() {\n  return 2;\n}\n\nexport function addedByAgentExtra() {\n  return 3;\n}\n"
      );
    });
    assert.equal(post.status, 0);
    assert.equal(stop.status, 0);
    assert.ok(stop.output, "Stop with a real meaningful edit + mock claude must produce a systemMessage nudge");
    assert.match((stop.output as any).systemMessage ?? "", /question.*waiting/i);

    const denied = firePreToolUse(repo, env, sessionId, promptId);
    assert.ok(denied.output, "hard gate must deny the next tool call once a real question exists from this real pipeline");
    assert.equal((denied.output as any).hookSpecificOutput?.permissionDecision, "deny");

    const db = openHomeDb(home);
    const pendingRow = db.prepare(`SELECT id FROM events WHERE session_id = ? AND question_type IS NOT NULL`).get(sessionId) as { id: number } | undefined;
    assert.ok(pendingRow, "a real question row must exist for this session after the real capture+generation pipeline");
    markInstanceAnswered(db, pendingRow!.id, "answered via e2e harness");
    db.close();

    const allowed = firePreToolUse(repo, env, sessionId, promptId);
    assert.equal(allowed.output, null, "answering the real question must immediately unblock PreToolUse");
  }),
];
