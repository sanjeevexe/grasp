import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { getEventById, getPendingQuestions, insertEvent, openStore } from "../src/store";
import { mkTempDir, PtyStep, runPty as runPtyArgs } from "./helpers";

/**
 * Real-pseudo-terminal end-to-end tests for `grasp scan`'s live
 * presentation (§5) — same reason `grasp review` needs a real pty (see
 * reviewAppPty.test.ts's own header comment): ink's raw-mode input handling
 * doesn't behave the same way over `child_process.spawn`'s plain pipes.
 * Covers the genuinely new, scan-specific behavior this prompt requires:
 * standalone use against a real git repo, source isolation in both
 * directions (`grasp scan` never shows diff questions, `grasp review` never
 * shows scan questions), both cross-hints, and the "nothing left to scan"
 * message. Walk-level concerns (ordering, capping, resumability, the
 * mechanical skips) are already covered headlessly in scanWalk.test.ts —
 * this file is specifically about the parts that need a real terminal.
 */

const FIXTURE_CLAUDE_DIR = path.resolve(process.cwd(), "test/fixtures/mock-claude");

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** A real git repo with one small, real source file — enough for one real scan question. */
function initScanRepo(): string {
  const repo = fs.realpathSync(mkTempDir("grasp-test-scanpty-repo-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(
    path.join(repo, "example.ts"),
    "export function example() {\n  return 1;\n}\n\nexport function exampleExtra() {\n  return 2;\n}\n"
  );
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  return repo;
}

function scanHome(): string {
  return fs.realpathSync(mkTempDir("grasp-test-scanpty-home-"));
}

function runScanPty(
  steps: PtyStep[],
  env: Record<string, string>,
  cwd: string,
  args: string[] = ["scan"],
  dumpPath?: string
) {
  return runPtyArgs(args, steps, env, cwd, dumpPath);
}

function mockClaudeEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env,
    PATH: `${FIXTURE_CLAUDE_DIR}:${process.env.PATH}`,
    GRASP_TEST_MOCK_MODE: "normal",
    GRASP_TEST_MOCK_COST: "0.001",
    ...extra,
  } as Record<string, string>;
}

test(
  "grasp scan: standalone end-to-end — generates a real question from an existing file and records the answer",
  { timeout: 20_000 },
  async () => {
    const repo = initScanRepo();
    const home = scanHome();

    const result = await runScanPty(
      [
        { type: "wait_for", text: "Concept question:", timeout: 10 },
        { type: "send", text: "concept answer" },
        { type: "sleep", seconds: 0.3 },
        { type: "send", text: "\r" },
        // The mock's response includes a real sampleAnswerConcept, so a
        // reveal screen ("Press any key to continue") appears BEFORE the
        // instance question — same flow reviewAppPty.test.ts's own
        // sample-answer test already exercises for the diff side.
        { type: "wait_for", text: "Press any key to continue", timeout: 5 },
        { type: "send", text: "\r" },
        { type: "wait_for", text: "Instance question:", timeout: 5 },
        { type: "send", text: "instance answer" },
        { type: "sleep", seconds: 0.3 },
        { type: "send", text: "\r" },
        { type: "wait_for", text: "Press any key to continue", timeout: 5 },
        { type: "send", text: "\r" },
      ],
      mockClaudeEnv({ HOME: home }),
      repo
    );

    assert.equal(result.code, 0, `pty driver reported a failure: ${result.stderr}`);

    const dbPath = path.join(home, ".grasp", "history.db");
    const db = openStore(dbPath);
    const row = db.prepare(`SELECT * FROM events WHERE source = 'scan'`).get() as any;
    db.close();
    assert.ok(row, "a real scan-sourced event must have been recorded");
    assert.equal(row.diff_summary, "example.ts");
    assert.equal(row.answer_concept, "concept answer");
    assert.equal(row.answer_instance, "instance answer");
  }
);

test(
  "grasp scan never shows pre-existing diff-sourced pending questions",
  { timeout: 20_000 },
  async () => {
    const repo = initScanRepo();
    const home = scanHome();
    const dbPath = path.join(home, ".grasp", "history.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const db = openStore(dbPath);
    // A pre-existing diff-sourced pending question — must NEVER appear
    // during the scan run below.
    const diffEventId = insertEvent(db, {
      timestamp: new Date().toISOString(),
      repo,
      sessionId: "real-cc-session",
      diffHash: "abc",
      diffSummary: "1 file changed",
      questionConcept: "DIFF CONCEPT QUESTION MARKER",
      questionInstance: "DIFF INSTANCE QUESTION MARKER",
      questionType: "both",
      generationSource: "headless-claude-p",
      missReason: null,
      answerConcept: null,
      answerInstance: null,
      skipped: false,
      skipReason: null,
      costUsd: 0.001,
      diffFiles: [],
    });
    db.close();

    // The pty driver writes the raw captured screen bytes to `dumpPath`
    // (its own stdout is discarded by `runPty`'s spawn options, and its
    // stderr only ever carries wait_for TIMEOUT diagnostics — the dump file
    // is the only reliable way to assert text did NOT appear on screen).
    const dumpPath = path.join(mkTempDir("grasp-test-scanpty-dump-"), "dump.txt");
    const scanResult = await runScanPty(
      [
        { type: "wait_for", text: "Concept question:", timeout: 10 },
        { type: "sleep", seconds: 0.3 },
      ],
      mockClaudeEnv({ HOME: home }),
      repo,
      ["scan"],
      dumpPath
    );
    assert.equal(scanResult.code, 0, `pty driver reported a failure: ${scanResult.stderr}`);
    const screenContent = fs.readFileSync(dumpPath, "utf-8");
    assert.doesNotMatch(
      screenContent,
      /DIFF (CONCEPT|INSTANCE) QUESTION MARKER/,
      "grasp scan must never render a pre-existing diff-sourced pending question"
    );
    assert.match(screenContent, /example\.ts/, "sanity check: the scan run did render its own real question");

    // Confirm via the DB too: the diff question must still be completely
    // untouched (never resolved by the scan run above).
    const db2 = openStore(dbPath);
    const diffRow = getEventById(db2, diffEventId);
    const diffPending = getPendingQuestions(db2, repo, "diff");
    db2.close();
    assert.equal(diffRow?.answerConcept, null, "the diff question must be untouched by the scan run");
    assert.equal(diffRow?.answerInstance, null);
    assert.ok(diffPending.some((e) => e.id === diffEventId), "the diff question must still be the one and only diff-pending item");
  }
);

test(
  "grasp review never shows pre-existing scan-sourced pending questions",
  { timeout: 20_000 },
  async () => {
    const repo = initScanRepo();
    const home = scanHome();
    const dbPath = path.join(home, ".grasp", "history.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const db = openStore(dbPath);
    // A pre-existing scan-sourced pending question — must NEVER appear
    // during the `grasp review` run below.
    const scanEventId = insertEvent(
      db,
      {
        timestamp: new Date().toISOString(),
        repo,
        sessionId: "scan-abc123",
        diffHash: null,
        diffSummary: "example.ts",
        questionConcept: "SCAN CONCEPT QUESTION MARKER",
        questionInstance: "SCAN INSTANCE QUESTION MARKER",
        questionType: "both",
        generationSource: "headless-claude-p",
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
    // A real diff-sourced pending question too, so `grasp review` has
    // something to actually render (otherwise it'd print the plain
    // "caught up" message and exit before anything could leak).
    insertEvent(db, {
      timestamp: new Date().toISOString(),
      repo,
      sessionId: "real-cc-session",
      diffHash: "abc",
      diffSummary: "1 file changed",
      questionConcept: "diff concept q",
      questionInstance: "diff instance q",
      questionType: "both",
      generationSource: "headless-claude-p",
      missReason: null,
      answerConcept: null,
      answerInstance: null,
      skipped: false,
      skipReason: null,
      costUsd: 0.001,
      diffFiles: [],
    });
    db.close();

    const dumpPath = path.join(mkTempDir("grasp-test-scanpty-dump-"), "dump.txt");
    const reviewResult = await runScanPty(
      [
        { type: "wait_for", text: "Concept question:", timeout: 10 },
        { type: "sleep", seconds: 0.3 },
      ],
      mockClaudeEnv({ HOME: home }),
      repo,
      ["review"],
      dumpPath
    );
    assert.equal(reviewResult.code, 0, `pty driver reported a failure: ${reviewResult.stderr}`);
    const screenContent = fs.readFileSync(dumpPath, "utf-8");
    assert.doesNotMatch(
      screenContent,
      /SCAN (CONCEPT|INSTANCE) QUESTION MARKER/,
      "grasp review must never render a pre-existing scan-sourced pending question"
    );

    const db2 = openStore(dbPath);
    const scanRow = getEventById(db2, scanEventId);
    db2.close();
    assert.equal(scanRow?.answerConcept, null, "the scan question must be untouched by the review run");
  }
);

test(
  "grasp scan: cross-hint points at `grasp review` when diff questions are also pending",
  { timeout: 20_000 },
  async () => {
    const repo = initScanRepo();
    const home = scanHome();
    const dbPath = path.join(home, ".grasp", "history.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const db = openStore(dbPath);
    insertEvent(db, {
      timestamp: new Date().toISOString(),
      repo,
      sessionId: "real-cc-session",
      diffHash: "abc",
      diffSummary: "1 file changed",
      questionConcept: "concept q",
      questionInstance: "instance q",
      questionType: "both",
      generationSource: "headless-claude-p",
      missReason: null,
      answerConcept: null,
      answerInstance: null,
      skipped: false,
      skipReason: null,
      costUsd: 0.001,
      diffFiles: [],
    });
    db.close();

    const result = await runScanPty(
      [
        { type: "wait_for", text: "grasp review", timeout: 10 },
        { type: "sleep", seconds: 0.2 },
      ],
      mockClaudeEnv({ HOME: home }),
      repo
    );
    assert.equal(result.code, 0, `expected the cross-hint text to appear (pty stderr: ${result.stderr})`);
  }
);

test(
  "grasp review: cross-hint points at `grasp scan` when scan questions are also pending",
  { timeout: 20_000 },
  async () => {
    const repo = initScanRepo();
    const home = scanHome();
    const dbPath = path.join(home, ".grasp", "history.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const db = openStore(dbPath);
    insertEvent(
      db,
      {
        timestamp: new Date().toISOString(),
        repo,
        sessionId: "scan-abc123",
        diffHash: null,
        diffSummary: "example.ts",
        questionConcept: "concept q",
        questionInstance: "instance q",
        questionType: "both",
        generationSource: "headless-claude-p",
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
    // Also seed a real diff-sourced pending question, or `grasp review`
    // would have nothing to show at all and exit before rendering anything.
    insertEvent(db, {
      timestamp: new Date().toISOString(),
      repo,
      sessionId: "real-cc-session",
      diffHash: "abc",
      diffSummary: "1 file changed",
      questionConcept: "concept q",
      questionInstance: "instance q",
      questionType: "both",
      generationSource: "headless-claude-p",
      missReason: null,
      answerConcept: null,
      answerInstance: null,
      skipped: false,
      skipReason: null,
      costUsd: 0.001,
      diffFiles: [],
    });
    db.close();

    const result = await runScanPty(
      [
        { type: "wait_for", text: "grasp scan", timeout: 10 },
        { type: "sleep", seconds: 0.2 },
      ],
      mockClaudeEnv({ HOME: home }),
      repo,
      ["review"]
    );
    assert.equal(result.code, 0, `expected the cross-hint text to appear (pty stderr: ${result.stderr})`);
  }
);

test(
  "grasp scan: 'nothing left to scan' once every tracked file has already been scanned",
  { timeout: 20_000 },
  async () => {
    const repo = initScanRepo();
    const home = scanHome();
    const dbPath = path.join(home, ".grasp", "history.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = openStore(dbPath);
    db.prepare(`INSERT INTO scan_progress (repo, file_path, scanned_at) VALUES (?, ?, ?)`).run(
      repo,
      "example.ts",
      new Date().toISOString()
    );
    db.close();

    const result = await runScanPty(
      [{ type: "wait_for", text: "Nothing left to scan", timeout: 10 }],
      mockClaudeEnv({ HOME: home }),
      repo
    );
    assert.equal(result.code, 0, `expected the 'nothing left to scan' message (pty stderr: ${result.stderr})`);
  }
);

test(
  "grasp scan --full: proceeds with a warning, not a confirmation gate, and still completes a real question",
  { timeout: 20_000 },
  async () => {
    const repo = initScanRepo();
    const home = scanHome();

    const result = await runScanPty(
      [
        { type: "wait_for", text: "--full bypasses the question cap", timeout: 10 },
        { type: "wait_for", text: "Concept question:", timeout: 10 },
        { type: "send", text: "concept answer" },
        { type: "sleep", seconds: 0.3 },
        { type: "send", text: "\r" },
        { type: "wait_for", text: "Press any key to continue", timeout: 5 },
        { type: "send", text: "\r" },
        { type: "wait_for", text: "Instance question:", timeout: 5 },
        { type: "send", text: "instance answer" },
        { type: "sleep", seconds: 0.3 },
        { type: "send", text: "\r" },
        { type: "wait_for", text: "Press any key to continue", timeout: 5 },
        { type: "send", text: "\r" },
      ],
      mockClaudeEnv({ HOME: home }),
      repo,
      ["scan", "--full"]
    );
    assert.equal(result.code, 0, `pty driver reported a failure: ${result.stderr}`);
  }
);
