import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { openStore, insertEvent, getEventById, getConceptTagsByEventId } from "../src/store";

/**
 * Real-pseudo-terminal regression tests for a dogfooding bug report found
 * after real (not simulated) daily use of `grasp review`: the answer field
 * required an extra, undocumented "wake up" Enter press before typing did
 * anything, and up/down arrow scrolling didn't work at all. Both turned out
 * to share one root cause — see DECISIONS.md's "grasp review: immediate
 * focus, working scroll, no premature blank warning" entry for the
 * diagnosis (ink's `useInput` re-subscribes its stdin listener whenever the
 * handler function reference changes, and the pre-fix code passed a fresh
 * inline handler on every render) and why a real pty is required to catch
 * this class of bug at all — `child_process.spawn`'s pipes are not a TTY,
 * so ink's raw-mode-dependent input handling behaves completely
 * differently (or not at all) than it does here.
 */

const CLI_PATH = path.resolve(process.cwd(), "dist/cli.js");
const PTY_DRIVER = path.resolve(process.cwd(), "test/fixtures/ptyDriver.py");

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface PtyStep {
  type: "wait_for" | "send" | "sleep";
  text?: string;
  seconds?: number;
  timeout?: number;
}

function runPty(
  steps: PtyStep[],
  env: Record<string, string>,
  cwd: string,
  dumpPath?: string
): Promise<{ code: number | null; stderr: string }> {
  const specPath = path.join(mkTempDir("grasp-test-ptyspec-"), "spec.json");
  fs.writeFileSync(
    specPath,
    JSON.stringify({
      cmd: ["node", CLI_PATH, "review"],
      cwd,
      env,
      cols: 120,
      rows: 45,
      final_wait_seconds: 1.0,
      steps,
      dump_path: dumpPath,
    })
  );
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [PTY_DRIVER, specPath], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

interface SeedExtras {
  sampleAnswerConcept?: string | null;
  sampleAnswerInstance?: string | null;
  conceptExplanation?: string | null;
}

/**
 * A `.grasp/history.db` under a fresh scratch $HOME, seeded with one pending
 * both-type question — same DAL calls `debug:seed` uses, not a stub. `extras`
 * left at its default (all three fields omitted/undefined) reproduces a
 * pre-migration "legacy" event exactly — `insertEvent`/`toEventRow` default
 * an omitted optional field to NULL, the real behavior a genuinely older row
 * would have, not a stand-in for it.
 */
function seedHome(
  diffFiles: Parameters<typeof insertEvent>[1]["diffFiles"],
  extras: SeedExtras = {}
): { home: string; dbPath: string; eventId: number } {
  const home = mkTempDir("grasp-test-pty-home-");
  const dbPath = path.join(home, ".grasp", "history.db");
  // openStore(dbPath) only ever mkdir's the DEFAULT GRASP_HOME (~/.grasp),
  // not the parent of whatever custom dbPath is passed in — so a scratch
  // path's directory has to exist before opening it here.
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openStore(dbPath);
  const eventId = insertEvent(
    db,
    {
      timestamp: new Date().toISOString(),
      repo: "/tmp/pty-test-repo",
      sessionId: null,
      diffHash: "pty-test-hash",
      diffSummary: "1 file changed",
      questionConcept: "What is the difference between a mutex and a channel?",
      questionInstance: "Given that, why did this change use a mutex?",
      questionType: "both",
      generationSource: "debug:seed",
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
    [{ tag: "mutex-vs-channel", answered: false }]
  );
  db.close();
  return { home, dbPath, eventId };
}

function shortDiff() {
  return [
    {
      path: "cache.go",
      oldPath: null,
      status: "modified" as const,
      insertions: 3,
      deletions: 0,
      hunks: [{ header: "@@ -1,0 +1,3 @@", lines: ["+line a", "+line b", "+line c"] }],
    },
  ];
}

function longDiff(lineCount: number) {
  const lines = Array.from({ length: lineCount }, (_, i) => `+  line number ${i} of a long function body`);
  return [
    {
      path: "long.go",
      oldPath: null,
      status: "modified" as const,
      insertions: lineCount,
      deletions: 0,
      hunks: [{ header: `@@ -1,0 +1,${lineCount} @@`, lines }],
    },
  ];
}

test(
  "grasp review: the answer field is immediately typeable the moment a question renders, no prior keypress needed",
  { timeout: 20_000 },
  async () => {
    const { home, dbPath, eventId } = seedHome(shortDiff());

    const result = await runPty(
      [
        { type: "wait_for", text: "Concept question:", timeout: 8 },
        // No prior "a"/Enter wake-up keypress — type straight away.
        { type: "send", text: "the answer is a mutex" },
        { type: "sleep", seconds: 0.3 },
        { type: "send", text: "\r" },
        { type: "wait_for", text: "Instance question:", timeout: 5 },
        { type: "send", text: "because it needs mutual exclusion" },
        { type: "sleep", seconds: 0.3 },
        { type: "send", text: "\r" },
      ],
      { ...process.env, HOME: home },
      home
    );

    assert.equal(result.code, 0, `pty driver reported a failure: ${result.stderr}`);

    const db = openStore(dbPath);
    const row = getEventById(db, eventId);
    db.close();
    assert.equal(row?.answerConcept, "the answer is a mutex", "typed text must have actually reached the answer field with no warm-up keypress");
    assert.equal(row?.answerInstance, "because it needs mutual exclusion");
  }
);

test(
  "grasp review: up/down arrow keys scroll the diff when there's more content than fits",
  { timeout: 20_000 },
  async () => {
    const { home } = seedHome(longDiff(60));

    // Each wait_for both proves the previous step actually rendered AND
    // paces the next send — a genuine regression (arrows doing nothing)
    // shows up as a timeout, not a race.
    //
    // Critically, this scrolls AFTER already typing into the answer field
    // first — not from a pristine, just-rendered screen. That distinction
    // is what actually catches the real regression: the pre-fix code only
    // ever scrolled while a separate "viewing" mode was active, and that
    // mode was never active once the user had started answering (matching
    // the dogfooding report's literal "scrolling does not work at all" —
    // since a real user types first, then tries to scroll back up to
    // re-read something).
    //
    // The typed text is sent as a single "paste"-style write (ink's own
    // useInput treats any >1-character `input` as one paste event — this
    // is documented ink behavior, not a workaround) and then explicitly
    // `wait_for`-confirmed on screen before the arrow key is sent. This
    // was required, not just tidy: raw OS pipe/pty writes do not preserve
    // message boundaries, so even separate `send` steps with deliberate
    // sleep delays between them were observed (via direct debug tracing
    // of the handler) to sometimes coalesce into a single 'data' read —
    // e.g. the tail of the typed text merging with the following arrow
    // key's escape sequence into one unrecognized chunk. Confirming the
    // typed text is actually rendered before sending the arrow key closes
    // that race by construction instead of guessing a delay is long enough.
    const result = await runPty(
      [
        { type: "wait_for", text: "Concept question:", timeout: 8 },
        { type: "wait_for", text: "(29 more lines below", timeout: 3 },
        { type: "send", text: "xyzzy" },
        { type: "wait_for", text: "xyzzy", timeout: 3 },
        { type: "send", text: "\x1b[B" }, // down
        { type: "wait_for", text: "(28 more lines below", timeout: 3 },
        { type: "send", text: "\x1b[B" },
        { type: "wait_for", text: "(27 more lines below", timeout: 3 },
        { type: "send", text: "\x1b[A" }, // up
        { type: "wait_for", text: "(28 more lines below", timeout: 3 },
      ],
      { ...process.env, HOME: home },
      home
    );

    assert.equal(result.code, 0, `pty driver reported a failure (arrow-key scroll never reached the expected offset): ${result.stderr}`);
  }
);

test(
  "grasp review: no premature 'blank answer' warning before the user has typed or attempted to submit anything",
  { timeout: 20_000 },
  async () => {
    const { home } = seedHome(shortDiff());
    const dumpPath = path.join(mkTempDir("grasp-test-ptydump-"), "capture.bin");

    const result = await runPty(
      [
        { type: "wait_for", text: "Concept question:", timeout: 8 },
        { type: "wait_for", text: "type your answer, Enter to submit", timeout: 3 },
        { type: "sleep", seconds: 0.6 },
      ],
      { ...process.env, HOME: home },
      home,
      dumpPath
    );

    assert.equal(result.code, 0, result.stderr);
    const captured = fs.readFileSync(dumpPath, "utf-8");
    assert.ok(
      !captured.includes("isn't accepted"),
      "the blank-answer warning must never render before the user has typed anything or attempted to submit"
    );
  }
);

test("grasp review: blank Enter is still rejected (warning shown), and typing afterward still submits correctly", { timeout: 20_000 }, async () => {
  const { home, dbPath, eventId } = seedHome(shortDiff());

  const result = await runPty(
    [
      { type: "wait_for", text: "Concept question:", timeout: 8 },
      { type: "send", text: "\r" }, // blank submit attempt
      { type: "wait_for", text: "A blank answer isn't accepted", timeout: 3 },
      { type: "sleep", seconds: 0.3 },
      { type: "send", text: "real answer now" },
      { type: "sleep", seconds: 0.3 },
      { type: "send", text: "\r" },
      { type: "wait_for", text: "Instance question:", timeout: 5 },
      { type: "send", text: "real instance answer" },
      { type: "sleep", seconds: 0.3 },
      { type: "send", text: "\r" },
    ],
    { ...process.env, HOME: home },
    home
  );

  assert.equal(result.code, 0, `pty driver reported a failure: ${result.stderr}`);

  const db = openStore(dbPath);
  const row = getEventById(db, eventId);
  db.close();
  assert.equal(row?.skipped, false, "a blank Enter must never count as a skip");
  assert.equal(row?.answerConcept, "real answer now");
  assert.equal(row?.answerInstance, "real instance answer");
});

/**
 * Regression tests for this session's third round of dogfooding-driven
 * work: sample answers + a concept explanation, shown to the user for
 * self-comparison after a real answer (never a comparison or judgment of
 * what they typed — see the guardrail in DECISIONS.md's "sample answers and
 * concept explanation" entry), and an explain-then-retry flow replacing the
 * old "why are you skipping?" free-text prompt on Escape.
 *
 * A repeated string (the shared explain-screen heading/footer, or the one
 * `conceptExplanation` text reused across both phases per design) can't
 * reliably discriminate a SECOND occurrence via `wait_for` — the pty
 * driver's buffer accumulates for the whole run and never resets, so a
 * `wait_for` on text already seen once passes immediately without actually
 * waiting for the second occurrence. Where a step needs to pace past one of
 * these repeated strings, a plain `sleep` is used instead (0.3-0.4s,
 * matching this file's own established pacing for simple, non-coalescing-
 * prone single control bytes — Escape/Enter are each one byte, unlike the
 * earlier multi-byte-arrow-after-bulk-text case that needed `wait_for`-based
 * synchronization to avoid OS-level coalescing). Wherever the text IS
 * unique in a given run (a sample answer's own content, "Instance
 * question:", which only appears once per run), `wait_for` is still used.
 */

test(
  "grasp review: a real concept answer shows its own sample answer before advancing to the instance phase",
  { timeout: 20_000 },
  async () => {
    const { home, dbPath, eventId } = seedHome(shortDiff(), {
      sampleAnswerConcept: "A mutex is a mutual-exclusion lock.",
      sampleAnswerInstance: "Because only one goroutine may touch cache at a time.",
      conceptExplanation: "A mutex protects a shared resource so only one thread accesses it at once.",
    });

    const result = await runPty(
      [
        { type: "wait_for", text: "Concept question:", timeout: 8 },
        { type: "send", text: "the answer is a mutex" },
        { type: "sleep", seconds: 0.3 },
        { type: "send", text: "\r" },
        // Sample answer shown BEFORE advancing — not the instance question yet.
        { type: "wait_for", text: "A mutex is a mutual-exclusion lock.", timeout: 3 },
        { type: "send", text: "\r" },
        { type: "wait_for", text: "Instance question:", timeout: 5 },
        { type: "send", text: "because it needs mutual exclusion" },
        { type: "sleep", seconds: 0.3 },
        { type: "send", text: "\r" },
        { type: "wait_for", text: "Because only one goroutine may touch cache at a time.", timeout: 3 },
        { type: "send", text: "\r" },
      ],
      { ...process.env, HOME: home },
      home
    );

    assert.equal(result.code, 0, `pty driver reported a failure: ${result.stderr}`);

    const db = openStore(dbPath);
    const row = getEventById(db, eventId);
    db.close();
    assert.equal(row?.answerConcept, "the answer is a mutex");
    assert.equal(row?.answerInstance, "because it needs mutual exclusion");
    assert.equal(row?.skipped, false);
  }
);

test(
  "grasp review: Escape shows the concept explanation, and a real answer on the one retry marks the concept learned and shows its sample answer",
  { timeout: 20_000 },
  async () => {
    const { home, dbPath, eventId } = seedHome(shortDiff(), {
      sampleAnswerConcept: "A mutex is a mutual-exclusion lock.",
      sampleAnswerInstance: "Because only one goroutine may touch cache at a time.",
      conceptExplanation: "A mutex protects a shared resource so only one thread accesses it at once.",
    });

    const result = await runPty(
      [
        { type: "wait_for", text: "Concept question:", timeout: 8 },
        { type: "send", text: "\x1b" }, // first Escape — explain, not an immediate skip
        { type: "wait_for", text: "A mutex protects a shared resource so only one thread accesses it at once.", timeout: 3 },
        { type: "send", text: "\r" }, // continue -> back to the concept question, one retry
        { type: "sleep", seconds: 0.3 },
        { type: "send", text: "retried real answer" },
        { type: "sleep", seconds: 0.3 },
        { type: "send", text: "\r" },
        { type: "wait_for", text: "A mutex is a mutual-exclusion lock.", timeout: 3 },
        { type: "send", text: "\r" },
        { type: "wait_for", text: "Instance question:", timeout: 5 },
        { type: "send", text: "instance answer text" },
        { type: "sleep", seconds: 0.3 },
        { type: "send", text: "\r" },
        { type: "wait_for", text: "Because only one goroutine may touch cache at a time.", timeout: 3 },
        { type: "send", text: "\r" },
      ],
      { ...process.env, HOME: home },
      home
    );

    assert.equal(result.code, 0, `pty driver reported a failure: ${result.stderr}`);

    const db = openStore(dbPath);
    const row = getEventById(db, eventId);
    const tags = getConceptTagsByEventId(db, eventId);
    db.close();
    assert.equal(row?.answerConcept, "retried real answer", "the retry's real answer must be recorded, not discarded");
    assert.equal(row?.answerInstance, "instance answer text");
    assert.equal(row?.skipped, false, "a real answer on the retry must never count as a skip");
    assert.ok(
      tags.some((t) => t.tag === "mutex-vs-channel" && t.answered),
      "the concept tag must flip to answered once the retry produces a real answer"
    );
  }
);

test(
  "grasp review: declining both attempts on a question shows its sample answer before moving on, without marking the concept learned",
  { timeout: 20_000 },
  async () => {
    const { home, dbPath, eventId } = seedHome(shortDiff(), {
      sampleAnswerConcept: "A mutex is a mutual-exclusion lock.",
      sampleAnswerInstance: "Because only one goroutine may touch cache at a time.",
      conceptExplanation: "A mutex protects a shared resource so only one thread accesses it at once.",
    });

    const result = await runPty(
      [
        { type: "wait_for", text: "Concept question:", timeout: 8 },
        { type: "send", text: "\x1b" }, // first decline -> explain
        { type: "sleep", seconds: 0.4 },
        { type: "send", text: "\r" }, // continue -> retry
        { type: "sleep", seconds: 0.4 },
        { type: "send", text: "\x1b" }, // decline again -> terminal for concept
        { type: "wait_for", text: "A mutex is a mutual-exclusion lock.", timeout: 3 },
        { type: "send", text: "\r" }, // continue -> instance
        { type: "wait_for", text: "Instance question:", timeout: 5 },
        { type: "send", text: "\x1b" }, // first decline -> explain
        { type: "sleep", seconds: 0.4 },
        { type: "send", text: "\r" }, // continue -> retry
        { type: "sleep", seconds: 0.4 },
        { type: "send", text: "\x1b" }, // decline again -> terminal for instance, closes the event
        { type: "wait_for", text: "Because only one goroutine may touch cache at a time.", timeout: 3 },
        { type: "send", text: "\r" },
      ],
      { ...process.env, HOME: home },
      home
    );

    assert.equal(result.code, 0, `pty driver reported a failure: ${result.stderr}`);

    const db = openStore(dbPath);
    const row = getEventById(db, eventId);
    const tags = getConceptTagsByEventId(db, eventId);
    db.close();
    assert.equal(row?.skipped, true, "declining the instance phase (always the last phase) marks the whole event skipped");
    assert.equal(row?.answerConcept, null, "no real answer was ever given for the concept question");
    assert.equal(row?.answerInstance, null);
    assert.ok(
      tags.every((t) => !t.answered),
      "the concept tag must stay unanswered when the concept question was declined on both attempts"
    );
  }
);

test(
  "grasp review: a legacy event with no sample answers or concept explanation reviews without error, with no broken reveal/explain screen",
  { timeout: 20_000 },
  async () => {
    // No sample-answer/explanation extras passed — this reproduces exactly
    // what a pre-migration row looks like (the three new columns genuinely
    // NULL, the same as `openStore`'s migration would leave an existing
    // row, not a stand-in for it).
    const { home, dbPath, eventId } = seedHome(shortDiff());
    const dumpPath = path.join(mkTempDir("grasp-test-ptydump-"), "capture.bin");

    const result = await runPty(
      [
        { type: "wait_for", text: "Concept question:", timeout: 8 },
        // Legacy fallback: no explanation to show, so Escape must behave
        // like the pre-this-feature immediate skip — no explain screen, no
        // retry offered.
        { type: "send", text: "\x1b" },
        { type: "wait_for", text: "Instance question:", timeout: 5 },
        // Same fallback for the instance phase — declining it must close
        // the event immediately, no explain/reveal screen.
        { type: "send", text: "\x1b" },
        { type: "sleep", seconds: 0.5 },
      ],
      { ...process.env, HOME: home },
      home,
      dumpPath
    );

    assert.equal(result.code, 0, `pty driver reported a failure: ${result.stderr}`);

    const captured = fs.readFileSync(dumpPath, "utf-8");
    assert.ok(!captured.includes("Stuck?"), "a legacy event with no explanation must never show the explain screen");
    assert.ok(!captured.includes("Sample answer"), "a legacy event with no sample answer must never show a reveal screen");

    const db = openStore(dbPath);
    const row = getEventById(db, eventId);
    db.close();
    assert.equal(row?.skipped, true);
    assert.equal(row?.answerConcept, null);
    assert.equal(row?.answerInstance, null);
  }
);
