import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { scenario } from "../lib/scenario";
import { isolatedHome, mkTempDir, graspEnv, CLI_PATH } from "../lib/env";
import { runGraspPty, Key, waitFor, waitForFresh, sendText, sleepStep, resizeStep, PtyStep } from "../lib/ptyDriver";
import { openHomeDb } from "../lib/db";
import { insertEvent, getEventById, getConceptTagsByEventId } from "../../../src/store";
import type { DiffFile } from "../../../src/adapters/agentAdapter";

/**
 * `grasp review` — driven entirely through a real pty (real keystrokes,
 * real rendered screen assertions), per the task brief. This is where the
 * two specific gaps the prior TEST_LOG.md retest pass explicitly couldn't
 * cover live: real arrow-key scrolling against live-rendered content, and
 * terminal resize mid-render. Most scenarios seed pending events directly
 * via the store (same DAL `debug:seed`/the existing *Pty.test.ts suite
 * already uses) rather than through real generation — the UI mechanics
 * under test here don't depend on how the question got there, and seeding
 * directly keeps each scenario fast and independent.
 */

function shortDiffFiles(): DiffFile[] {
  return [
    {
      path: "cache.go",
      oldPath: null,
      status: "modified",
      insertions: 3,
      deletions: 0,
      hunks: [{ header: "@@ -1,0 +1,3 @@", lines: ["+line a", "+line b", "+line c"] }],
    },
  ];
}

function longDiffFiles(lineCount: number): DiffFile[] {
  const lines = Array.from({ length: lineCount }, (_, i) => `+  line number ${i} of a long function body`);
  return [
    {
      path: "long.go",
      oldPath: null,
      status: "modified",
      insertions: lineCount,
      deletions: 0,
      hunks: [{ header: `@@ -1,0 +1,${lineCount} @@`, lines }],
    },
  ];
}

/**
 * A diff with exactly one genuinely long line, engineered so a unique end
 * marker lands cleanly at the START of the second wrapped chunk (not split
 * across the wrap boundary) for a pty run at cols=120. `flattenDiffFiles`
 * hard-wraps at `columns - 4` (see src/reviewApp.tsx's `diffContentWidth`
 * and its own exported `wrapLine`) — at cols=120 that's a width of 116.
 * Padding the line to exactly one multiple of that width before the marker
 * guarantees the marker starts exactly at a chunk boundary, so it can never
 * land split across two wrapped rows regardless of exactly how wrapping
 * slices it.
 */
function longLineDiffFiles(width: number): { files: DiffFile[]; marker: string } {
  const marker = "ZZZMARKERTAIL";
  const prefixLen = width - 1; // "+" itself is the 1 already-accounted-for char
  const line = "+" + "A".repeat(prefixLen) + marker + "B".repeat(60);
  return {
    files: [
      {
        path: "longline.go",
        oldPath: null,
        status: "modified",
        insertions: 1,
        deletions: 0,
        hunks: [{ header: "@@ -1,0 +1,1 @@", lines: [line] }],
      },
    ],
    marker,
  };
}

interface SeedExtras {
  sampleAnswerConcept?: string | null;
  sampleAnswerInstance?: string | null;
  conceptExplanation?: string | null;
}

function seedEvent(
  home: string,
  repo: string,
  sessionId: string | null,
  diffFiles: DiffFile[],
  extras: SeedExtras = {},
  questionConcept: string | null = "What is the difference between a mutex and a channel?"
): number {
  const db = openHomeDb(home);
  const id = insertEvent(
    db,
    {
      timestamp: new Date().toISOString(),
      repo,
      sessionId,
      diffHash: "e2e-review-hash",
      diffSummary: "1 file changed",
      questionConcept,
      questionInstance: "Given that, why did this change use one?",
      questionType: questionConcept ? "both" : "instance",
      generationSource: "e2e-seed",
      missReason: null,
      answerConcept: null,
      answerInstance: null,
      skipped: false,
      skipReason: null,
      costUsd: 0.001,
      diffFiles,
      sampleAnswerConcept: extras.sampleAnswerConcept,
      sampleAnswerInstance: extras.sampleAnswerInstance,
      conceptExplanation: extras.conceptExplanation,
    },
    questionConcept ? [{ tag: "mutex-vs-channel", answered: false }] : []
  );
  db.close();
  return id;
}

function reviewPty(home: string, repo: string, steps: PtyStep[], args: string[] = ["review"], opts: { cols?: number; rows?: number } = {}) {
  return runGraspPty(CLI_PATH, args, steps, { cwd: repo, env: graspEnv(home), cols: opts.cols ?? 120, rows: opts.rows ?? 45 });
}

export const reviewScenarios = [
  scenario("review: singular-batch banner reads correctly for exactly one pending question (no '1 sessions')", async () => {
    const home = isolatedHome();
    const repo = mkTempDir("grasp-e2e-review-repo-");
    seedEvent(home, repo, "s1", shortDiffFiles());

    const result = await reviewPty(home, repo, [waitFor("Concept question:"), waitFor("1 question pending."), sleepStep(0.2)]);
    assert.equal(result.code, 0, `pty driver failed: ${result.stderr}`);
    assert.ok(!result.screen.includes("1 sessions"), "must never pluralize 'sessions' for a lone question");
  }),

  scenario("review: multi-question banner across multiple sessions reads 'N questions pending across M sessions'", async () => {
    const home = isolatedHome();
    const repo = mkTempDir("grasp-e2e-review-repo-");
    seedEvent(home, repo, "s1", shortDiffFiles());
    seedEvent(home, repo, "s2", shortDiffFiles());

    const result = await reviewPty(home, repo, [waitFor("2 questions pending across 2 sessions.")]);
    assert.equal(result.code, 0, `pty driver failed: ${result.stderr}`);
  }),

  scenario("review: diff renders and the answer field is immediately typeable, no warm-up keypress needed", async () => {
    const home = isolatedHome();
    const repo = mkTempDir("grasp-e2e-review-repo-");
    const eventId = seedEvent(home, repo, "s1", shortDiffFiles());

    const result = await reviewPty(home, repo, [
      waitFor("Concept question:"),
      waitFor("line a"),
      waitFor("line b"),
      sendText("the answer is a mutex"),
      sleepStep(0.3),
      sendText(Key.ENTER),
      waitFor("Instance question:"),
      sendText("because it needs mutual exclusion"),
      sleepStep(0.3),
      sendText(Key.ENTER),
    ]);
    assert.equal(result.code, 0, `pty driver failed: ${result.stderr}`);

    const db = openHomeDb(home);
    const row = getEventById(db, eventId);
    db.close();
    assert.equal(row?.answerConcept, "the answer is a mutex", "typed text must reach the answer field with no warm-up keypress");
    assert.equal(row?.answerInstance, "because it needs mutual exclusion");
  }),

  scenario("review: a genuinely long diff line wraps onto further rows instead of being cut off", async () => {
    const home = isolatedHome();
    const repo = mkTempDir("grasp-e2e-review-repo-");
    const cols = 120;
    const width = cols - 4; // matches src/reviewApp.tsx's diffContentWidth formula exactly
    const { files, marker } = longLineDiffFiles(width);
    seedEvent(home, repo, "s1", files, {}, null); // instance-only, so this diff is visible immediately

    const result = await reviewPty(home, repo, [waitFor("Instance question:"), waitFor(marker), sleepStep(0.2)], ["review"], { cols });
    assert.equal(result.code, 0, `pty driver failed: ${result.stderr}`);
    assert.ok(result.screen.includes(marker), "the tail of a long line must be fully visible somewhere on screen, not truncated");
  }),

  scenario("review: scroll hint absent on a diff that fits, present on one that overflows the viewport", async () => {
    const home = isolatedHome();
    const shortRepo = mkTempDir("grasp-e2e-review-repo-short-");
    seedEvent(home, shortRepo, "s-short", shortDiffFiles());

    const shortResult = await reviewPty(home, shortRepo, [waitFor("Concept question:"), sleepStep(0.4)]);
    assert.equal(shortResult.code, 0, `pty driver failed: ${shortResult.stderr}`);
    assert.ok(!shortResult.screen.includes("scroll diff"), "a diff that fits entirely on screen must not show the scroll hint");

    const longRepo = mkTempDir("grasp-e2e-review-repo-long-");
    seedEvent(home, longRepo, "s-long", longDiffFiles(80));
    const longResult = await reviewPty(home, longRepo, [waitFor("Concept question:"), waitFor("more lines below")]);
    assert.equal(longResult.code, 0, `pty driver failed: ${longResult.stderr}`);
    assert.ok(longResult.screen.includes("scroll diff"), "a diff that overflows the viewport must show the [↑/↓] scroll diff hint");
  }),

  scenario("review: real arrow-key scrolling moves through a long diff, both before and after typing an answer", async () => {
    const home = isolatedHome();
    const repo = mkTempDir("grasp-e2e-review-repo-");
    seedEvent(home, repo, "s1", longDiffFiles(60));

    const result = await reviewPty(home, repo, [
      waitFor("Concept question:"),
      waitFor("(29 more lines below"),
      sendText("xyzzy"),
      waitFor("xyzzy"),
      sendText(Key.DOWN),
      waitFor("(28 more lines below"),
      sendText(Key.DOWN),
      waitFor("(27 more lines below"),
      sendText(Key.UP),
      waitFor("(28 more lines below"),
    ]);
    assert.equal(result.code, 0, `arrow-key scroll never reached the expected offset: ${result.stderr}`);
  }),

  scenario("review: blank Enter is rejected only after a real submit attempt, never before; a real answer afterward still submits", async () => {
    const home = isolatedHome();
    const noAttemptRepo = mkTempDir("grasp-e2e-review-repo-noattempt-");
    seedEvent(home, noAttemptRepo, "s1", shortDiffFiles());
    const noAttempt = await reviewPty(home, noAttemptRepo, [waitFor("Concept question:"), waitFor("type your answer, Enter to submit"), sleepStep(0.6)]);
    assert.equal(noAttempt.code, 0, `pty driver failed: ${noAttempt.stderr}`);
    assert.ok(!noAttempt.screen.includes("isn't accepted"), "the blank-answer warning must never appear before any submit attempt");

    const repo = mkTempDir("grasp-e2e-review-repo-attempt-");
    const eventId = seedEvent(home, repo, "s2", shortDiffFiles());
    const result = await reviewPty(home, repo, [
      waitFor("Concept question:"),
      sendText(Key.ENTER), // blank submit attempt
      waitFor("A blank answer isn't accepted"),
      sleepStep(0.3),
      sendText("real answer now"),
      sleepStep(0.3),
      sendText(Key.ENTER),
      waitFor("Instance question:"),
      sendText("real instance answer"),
      sleepStep(0.3),
      sendText(Key.ENTER),
    ]);
    assert.equal(result.code, 0, `pty driver failed: ${result.stderr}`);
    const db = openHomeDb(home);
    const row = getEventById(db, eventId);
    db.close();
    assert.equal(row?.skipped, false, "a blank Enter must never count as a skip");
    assert.equal(row?.answerConcept, "real answer now");
  }),

  scenario("review: a real answer reveals its own sample answer before advancing to the next phase", async () => {
    const home = isolatedHome();
    const repo = mkTempDir("grasp-e2e-review-repo-");
    const eventId = seedEvent(home, repo, "s1", shortDiffFiles(), {
      sampleAnswerConcept: "A mutex is a mutual-exclusion lock.",
      sampleAnswerInstance: "Because only one goroutine may touch cache at a time.",
      conceptExplanation: "A mutex protects a shared resource so only one thread accesses it at once.",
    });

    const result = await reviewPty(home, repo, [
      waitFor("Concept question:"),
      sendText("the answer is a mutex"),
      sleepStep(0.3),
      sendText(Key.ENTER),
      waitFor("A mutex is a mutual-exclusion lock."),
      sendText(Key.ENTER),
      waitFor("Instance question:"),
      sendText("because it needs mutual exclusion"),
      sleepStep(0.3),
      sendText(Key.ENTER),
      waitFor("Because only one goroutine may touch cache at a time."),
      sendText(Key.ENTER),
    ]);
    assert.equal(result.code, 0, `pty driver failed: ${result.stderr}`);
    const db = openHomeDb(home);
    const row = getEventById(db, eventId);
    db.close();
    assert.equal(row?.skipped, false);
  }),

  scenario("review: Escape -> explanation -> retry -> Escape-again -> skip flow, with the hint text changing between attempts", async () => {
    const home = isolatedHome();
    const repo = mkTempDir("grasp-e2e-review-repo-");
    const eventId = seedEvent(home, repo, "s1", shortDiffFiles(), {
      sampleAnswerConcept: "A mutex is a mutual-exclusion lock.",
      sampleAnswerInstance: "Because only one goroutine may touch cache at a time.",
      conceptExplanation: "A mutex protects a shared resource so only one thread accesses it at once.",
    });

    const result = await reviewPty(home, repo, [
      waitFor("Concept question:"),
      waitFor("[Esc] stuck? see explanation"), // first-attempt hint wording
      sendText(Key.ESCAPE), // first Escape -> explanation, not an immediate skip
      waitFor("A mutex protects a shared resource so only one thread accesses it at once."),
      sendText(Key.ENTER), // continue -> back to the question, one retry
      sleepStep(0.3),
      waitFor("[Esc] skip"), // retry-attempt hint wording must have changed
      sendText(Key.ESCAPE), // second Escape -> the real, terminal decline
      waitFor("A mutex is a mutual-exclusion lock."), // sample answer still shown even though declined
      sendText(Key.ENTER),
      waitFor("Instance question:"),
      sendText(Key.ESCAPE), // first Escape on the instance phase -> explanation (same shared explanation text as the concept phase's own, above)
      // The instance phase's explain/retry-hint text is IDENTICAL to the
      // concept phase's own (same shared `conceptExplanation`/"[Esc] skip"
      // strings, already matched once above) — a plain waitFor would
      // false-positive on that stale, already-buffered occurrence and
      // return immediately without actually waiting for the new render,
      // silently turning the wait into a no-op racing the next `send`. See
      // DECISIONS.md's "PTY e2e harness: stale-text false positives in
      // wait_for" entry for why waitForFresh exists and is required here.
      waitForFresh("A mutex protects a shared resource so only one thread accesses it at once."),
      sendText(Key.ENTER), // continue -> back to the instance question, one retry
      waitForFresh("[Esc] skip"), // retry-attempt hint wording must have changed, for THIS (instance) phase
      sendText(Key.ESCAPE), // second Escape -> the real, terminal decline
      waitFor("Because only one goroutine may touch cache at a time."),
      sendText(Key.ENTER),
    ]);
    assert.equal(result.code, 0, `pty driver failed: ${result.stderr}`);

    const db = openHomeDb(home);
    const row = getEventById(db, eventId);
    const tags = getConceptTagsByEventId(db, eventId);
    db.close();
    assert.equal(row?.skipped, true, "declining the instance phase (the last phase) marks the whole event skipped");
    assert.equal(row?.answerConcept, null, "no real concept answer was ever given");
    assert.ok(tags.every((t) => !t.answered), "the concept tag must stay unanswered when declined on both attempts");
  }),

  scenario("review: Ctrl+C mid-question leaves the question genuinely pending, nothing lost", async () => {
    const home = isolatedHome();
    const repo = mkTempDir("grasp-e2e-review-repo-");
    const eventId = seedEvent(home, repo, "s1", shortDiffFiles());

    const result = await reviewPty(home, repo, [
      waitFor("Concept question:"),
      waitFor("[Ctrl+C] quit anytime"),
      sendText("partial answer that never gets submitted"),
      sleepStep(0.3),
      sendText(Key.CTRL_C),
      sleepStep(0.5),
    ]);
    // The pty driver's own contract only fails (exit 2) on a wait_for
    // timeout — Ctrl+C ending the process early is expected here, not a
    // driver failure.
    assert.equal(result.code, 0, `pty driver failed: ${result.stderr}`);

    const db = openHomeDb(home);
    const row = getEventById(db, eventId);
    db.close();
    assert.equal(row?.answerConcept, null, "Ctrl+C must never record a partial answer");
    assert.equal(row?.answerInstance, null, "the question must remain genuinely pending after Ctrl+C");
    assert.equal(row?.skipped, false, "Ctrl+C is not a skip either — it's simply unresolved");
  }),

  scenario("review: default scoping shows only the current repo's questions; --all shows every repo's; the 'pending elsewhere' message is correct", async () => {
    const home = isolatedHome();
    const repoA = mkTempDir("grasp-e2e-review-repoA-");
    const repoB = mkTempDir("grasp-e2e-review-repoB-");
    seedEvent(home, repoA, "s-a", shortDiffFiles(), {}, "REPO A CONCEPT MARKER");
    seedEvent(home, repoB, "s-b", shortDiffFiles(), {}, "REPO B CONCEPT MARKER");

    // Repo A's own review must show only its own question.
    const dumpA = path.join(mkTempDir("grasp-e2e-dump-"), "a.txt");
    const resultA = await reviewPty(home, repoA, [waitFor("REPO A CONCEPT MARKER"), sleepStep(0.3), { type: "snapshot", path: dumpA }]);
    assert.equal(resultA.code, 0, `pty driver failed: ${resultA.stderr}`);
    const screenA = fs.readFileSync(dumpA, "utf-8");
    assert.ok(!screenA.includes("REPO B CONCEPT MARKER"), "repo A's own review must never show repo B's pending question");

    // A repo with NOTHING pending, while another repo (same home) has one.
    const repoC = mkTempDir("grasp-e2e-review-repoC-");
    const resultC = await reviewPty(home, repoC, [waitFor("run `grasp review --all`")]);
    assert.equal(resultC.code, 0, `pty driver failed: ${resultC.stderr}`);
    assert.match(resultC.screen, /No pending questions for this repo\. \d+ questions? pending in other repos/);

    // --all shows both.
    const resultAll = await reviewPty(home, repoC, [waitFor("REPO A CONCEPT MARKER")], ["review", "--all"]);
    assert.equal(resultAll.code, 0, `pty driver failed: ${resultAll.stderr}`);
  }),

  scenario("review: cross-source hint points at `grasp scan` when scan questions are also pending for this repo", async () => {
    const home = isolatedHome();
    const repo = mkTempDir("grasp-e2e-review-repo-");
    seedEvent(home, repo, "s-diff", shortDiffFiles());
    const db = openHomeDb(home);
    insertEvent(
      db,
      {
        timestamp: new Date().toISOString(),
        repo,
        sessionId: "scan-e2e-session",
        diffHash: null,
        diffSummary: "example.ts",
        questionConcept: "concept q",
        questionInstance: "instance q",
        questionType: "both",
        generationSource: "e2e-seed",
        missReason: null,
        answerConcept: null,
        answerInstance: null,
        skipped: false,
        skipReason: null,
        costUsd: 0.001,
        diffFiles: null,
        source: "scan",
      }
    );
    db.close();

    const result = await reviewPty(home, repo, [waitFor("grasp scan"), sleepStep(0.2)]);
    assert.equal(result.code, 0, `expected the cross-source hint pointing at grasp scan: ${result.stderr}`);
  }),

  scenario("review: terminal resize mid-question reflows without crashing or hanging", async () => {
    const home = isolatedHome();
    const repo = mkTempDir("grasp-e2e-review-repo-");
    seedEvent(home, repo, "s1", longDiffFiles(80));

    const result = await reviewPty(
      home,
      repo,
      [
        waitFor("Concept question:"),
        waitFor("(terminal: 120x45)"),
        // No keystroke in between — the new size string must appear purely
        // from the resize-event-driven re-render (process.stdout's own
        // "resize" listener -> forceRender in useTerminalSize), not from
        // some unrelated re-render an interleaved keystroke would also
        // trigger. That's what makes this a genuine test of real resize
        // handling rather than something a coincidental re-render could
        // paper over.
        resizeStep(80, 24),
        waitFor("(terminal: 80x24)"),
        sleepStep(0.2),
        resizeStep(150, 50),
        waitFor("(terminal: 150x50)"),
      ],
      ["review"],
      { cols: 120, rows: 45 }
    );
    assert.equal(result.code, 0, `terminal resize must reflow cleanly, not crash or hang: ${result.stderr}`);
  }),
];
