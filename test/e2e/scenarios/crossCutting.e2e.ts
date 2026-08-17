import assert from "node:assert/strict";
import { scenario } from "../lib/scenario";
import { initScratchRepo, isolatedHome, graspEnv, commitFile, writeFile, CLI_PATH } from "../lib/env";
import { runGraspCli } from "../lib/cli";
import { fireFullTurn } from "../lib/hooks";
import { runGraspPty, waitFor, sendText, sleepStep, Key, PtyStep } from "../lib/ptyDriver";
import { openHomeDb } from "../lib/db";

/**
 * Cross-cutting behavior that spans multiple commands/repos: bidirectional
 * concept-tag memoization (live diff <-> scan, in both directions),
 * `--help`/unknown-command trimming, and the question cap counting real
 * questions (not event rows) under LIVE, pty-driven generation — not just
 * the unit-level coverage src/store.ts's own test suite already has.
 */

function scanPty(home: string, repo: string, steps: PtyStep[]) {
  return runGraspPty(CLI_PATH, ["scan"], steps, { cwd: repo, env: graspEnv(home, { mode: "normal", conceptTag: "e2e-shared-concept-tag" }), cols: 120, rows: 45 });
}

function reviewPty(home: string, repo: string, steps: PtyStep[]) {
  return runGraspPty(CLI_PATH, ["review"], steps, { cwd: repo, env: graspEnv(home), cols: 120, rows: 45 });
}

function answerBoth(): PtyStep[] {
  return [
    waitFor("Concept question:"),
    sendText("real concept answer"),
    sleepStep(0.3),
    sendText(Key.ENTER),
    waitFor("Press any key to continue"),
    sendText(Key.ENTER),
    waitFor("Instance question:"),
    sendText("real instance answer"),
    sleepStep(0.3),
    sendText(Key.ENTER),
    waitFor("Press any key to continue"),
    sendText(Key.ENTER),
  ];
}

export const crossCuttingScenarios = [
  scenario("cross-cutting: --help and an unknown command both show the same trimmed, public-only command list", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "README.md", "# scratch\n");
    const home = isolatedHome();
    const env = graspEnv(home);

    const help = runGraspCli(["--help"], { cwd: repo, env });
    assert.equal(help.status, 0);
    for (const devCmd of ["debug:seed", "debug:capture", "debug:answer", "internal:hook"]) {
      assert.ok(!help.stdout.includes(devCmd), `--help must never mention ${devCmd}`);
    }
    for (const publicCmd of ["grasp init", "grasp review", "grasp scan", "grasp retry", "grasp set", "grasp reset", "grasp export"]) {
      assert.ok(help.stdout.includes(publicCmd), `--help must mention ${publicCmd}`);
    }

    const bad = runGraspCli(["totallyMadeUpCommand"], { cwd: repo, env });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Unknown command: totallyMadeUpCommand/);
    for (const devCmd of ["debug:seed", "debug:capture", "debug:answer", "internal:hook"]) {
      assert.ok(!bad.stdout.includes(devCmd), `the unknown-command fallback must never mention ${devCmd} either`);
    }
    assert.ok(bad.stdout.includes("grasp init"), "the unknown-command fallback must still show the same trimmed help");
  }),

  scenario("cross-cutting: concept-tag memoization is real, global, and bidirectional between grasp review and grasp scan", async () => {
    const homeA = isolatedHome();
    const repoReview1 = initScratchRepo();
    commitFile(repoReview1, "seed.ts", "export function seed() {\n  return 1;\n}\n");
    const repoScan1 = initScratchRepo();
    commitFile(repoScan1, "scanned.ts", "export function scanned() {\n  return 1;\n}\n");

    // Direction 1: master a concept via a real `grasp review` answer, then
    // confirm `grasp scan` in a DIFFERENT repo (same home) skips straight to
    // the instance question for that same tag — no "Concept question:" step.
    const sessionId = "e2e-memo-review-session";
    const { post, stop } = fireFullTurn(repoReview1, graspEnv(homeA, { mode: "normal", conceptTag: "e2e-shared-concept-tag" }), sessionId, "p1", () => {
      writeFile(repoReview1, "seed.ts", "export function seed() {\n  return 1;\n}\n\nexport function seedExtra() {\n  return 2;\n}\n\nexport function seedExtraMore() {\n  return 3;\n}\n");
    });
    assert.equal(post.status, 0);
    assert.equal(stop.status, 0);
    assert.ok(stop.output, "the real turn must produce a real question");

    const reviewResult = await reviewPty(homeA, repoReview1, answerBoth());
    assert.equal(reviewResult.code, 0, `pty driver failed: ${reviewResult.stderr}`);

    const scanResult = await scanPty(homeA, repoScan1, [
      waitFor("Instance question:"), // concept must be SKIPPED — instance appears first, with no "Concept question:" anywhere on screen
      sendText("scan instance answer"),
      sleepStep(0.3),
      sendText(Key.ENTER),
      waitFor("Press any key to continue"),
      sendText(Key.ENTER),
    ]);
    assert.equal(scanResult.code, 0, `pty driver failed: ${scanResult.stderr}`);
    assert.ok(!scanResult.screen.includes("Concept question:"), "a concept already mastered via grasp review must never be re-taught via grasp scan");

    // Direction 2: master a DIFFERENT concept via `grasp scan` first, then
    // confirm a later live `grasp review` in yet another repo skips it too.
    const homeB = isolatedHome();
    const repoScan2 = initScratchRepo();
    commitFile(repoScan2, "scanfirst.ts", "export function scanFirst() {\n  return 1;\n}\n");
    const repoReview2 = initScratchRepo();
    commitFile(repoReview2, "reviewsecond.ts", "export function reviewSecond() {\n  return 1;\n}\n");

    const scanFirstResult = await runGraspPty(
      CLI_PATH,
      ["scan"],
      answerBoth(),
      { cwd: repoScan2, env: graspEnv(homeB, { mode: "normal", conceptTag: "e2e-second-shared-tag" }), cols: 120, rows: 45 }
    );
    assert.equal(scanFirstResult.code, 0, `pty driver failed: ${scanFirstResult.stderr}`);

    const sessionId2 = "e2e-memo-scan-first-session";
    const { post: post2, stop: stop2 } = fireFullTurn(repoReview2, graspEnv(homeB, { mode: "normal", conceptTag: "e2e-second-shared-tag" }), sessionId2, "p1", () => {
      writeFile(repoReview2, "reviewsecond.ts", "export function reviewSecond() {\n  return 1;\n}\n\nexport function reviewSecondExtra() {\n  return 2;\n}\n\nexport function reviewSecondExtraMore() {\n  return 3;\n}\n");
    });
    assert.equal(post2.status, 0);
    assert.equal(stop2.status, 0);

    const reviewSecondResult = await reviewPty(homeB, repoReview2, [
      waitFor("Instance question:"),
      sendText("review second instance answer"),
      sleepStep(0.3),
      sendText(Key.ENTER),
      waitFor("Press any key to continue"),
      sendText(Key.ENTER),
    ]);
    assert.equal(reviewSecondResult.code, 0, `pty driver failed: ${reviewSecondResult.stderr}`);
    assert.ok(
      !reviewSecondResult.screen.includes("Concept question:"),
      "a concept already mastered via grasp scan must never be re-taught via grasp review, in a different repo"
    );
  }),

  scenario("cross-cutting: the question cap counts real questions (concept+instance), not event rows, under real live pty-driven generation", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "capfile.ts", "export function original() {\n  return 1;\n}\n");
    const home = isolatedHome();
    const sessionId = "e2e-realcap-session";

    const setCap = runGraspCli(["set", "questions-cap", "3"], { cwd: repo, env: graspEnv(home) });
    assert.equal(setCap.status, 0);

    // Turn 1: a real "both" question (2 real questions). count=2, under cap(3).
    const env1 = graspEnv(home, { mode: "normal", conceptTag: "e2e-cap-tag-1" });
    const turn1 = fireFullTurn(repo, env1, sessionId, "p1", () => {
      writeFile(repo, "capfile.ts", "export function original() {\n  return 1;\n}\n\nexport function turnOne() {\n  return 2;\n}\n\nexport function turnOneExtra() {\n  return 3;\n}\n");
    });
    assert.equal(turn1.stop.status, 0);
    assert.ok((turn1.stop.output as any)?.systemMessage, "turn 1 must produce a real question");
    assert.ok(!((turn1.stop.output as any)?.systemMessage ?? "").includes("question cap"), "turn 1 must not hit the cap yet (2 real questions < cap of 3)");

    // Turn 2: another real "both" question (2 more real questions, total 4)
    // — the cap check runs BEFORE the call, so this is allowed to overshoot
    // by one "both" event, per README's documented cap semantics.
    const env2 = graspEnv(home, { mode: "normal", conceptTag: "e2e-cap-tag-2" });
    const turn2 = fireFullTurn(repo, env2, sessionId, "p2", () => {
      writeFile(repo, "capfile.ts", "export function original() {\n  return 1;\n}\n\nexport function turnOne() {\n  return 2;\n}\n\nexport function turnTwo() {\n  return 4;\n}\n\nexport function turnTwoExtra() {\n  return 5;\n}\n");
    });
    assert.equal(turn2.stop.status, 0);
    assert.ok((turn2.stop.output as any)?.systemMessage, "turn 2 must still be allowed to generate (count was 2, under the cap of 3 at check time)");

    const db = openHomeDb(home);
    const realQuestionCount = countRealQuestions(db, sessionId);
    assert.equal(realQuestionCount, 4, "after 2 real 'both' turns, exactly 4 real questions must be recorded (2 events x 2 questions each)");
    db.close();

    // Turn 3: must now be BLOCKED before ever invoking claude — count (4) >= cap (3).
    const env3 = graspEnv(home, { mode: "normal", conceptTag: "e2e-cap-tag-3" });
    const turn3 = fireFullTurn(repo, env3, sessionId, "p3", () => {
      writeFile(repo, "capfile.ts", "export function original() {\n  return 1;\n}\n\nexport function turnThree() {\n  return 6;\n}\n\nexport function turnThreeExtra() {\n  return 7;\n}\n");
    });
    assert.equal(turn3.stop.status, 0);
    assert.match((turn3.stop.output as any)?.systemMessage ?? "", /hit this session's question cap \(3\)/, "turn 3 must be blocked by the cap, matching real-question counting (not the 6-question ceiling event-row counting would allow)");

    const dbAfter = openHomeDb(home);
    const finalCount = countRealQuestions(dbAfter, sessionId);
    dbAfter.close();
    assert.equal(finalCount, 4, "turn 3 must not have added any further real questions once blocked");
  }),
];

function countRealQuestions(db: ReturnType<typeof openHomeDb>, sessionId: string): number {
  const row = db
    .prepare(`SELECT SUM((question_concept IS NOT NULL) + (question_instance IS NOT NULL)) AS n FROM events WHERE session_id = ? AND question_type IS NOT NULL`)
    .get(sessionId) as { n: number };
  return row.n;
}
