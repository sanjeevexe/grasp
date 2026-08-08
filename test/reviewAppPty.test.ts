import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { openStore, insertEvent, getEventById } from "../src/store";

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

/** A `.grasp/history.db` under a fresh scratch $HOME, seeded with one pending both-type question — same DAL calls `debug:seed` uses, not a stub. */
function seedHome(diffFiles: Parameters<typeof insertEvent>[1]["diffFiles"]): { home: string; dbPath: string; eventId: number } {
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
