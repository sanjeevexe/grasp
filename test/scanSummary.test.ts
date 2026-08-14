import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { runScanSummary, ScanSummaryChunk } from "../src/generation";
import { openStore, getSessionCostUsd } from "../src/store";
import { mkTempDir, PtyStep, runPty as runPtyArgs } from "./helpers";

/**
 * `grasp scan`'s post-run summary (Prompt 10). Headless tests exercise
 * `runScanSummary`/`buildScanSummaryPrompt` directly (no interactive UI
 * involved in that call at all); the pty tests at the bottom exercise the
 * real end-to-end `grasp scan` flow — summary printed after the review UI
 * closes, its cost kept visibly separate, and no summary attempt at all
 * when nothing new was read this run. See DECISIONS.md's "grasp scan: run
 * summary" entry for the design this verifies.
 */

const FIXTURE_CLAUDE_DIR = path.resolve(process.cwd(), "test/fixtures/mock-claude");

function withMockClaude(env: Record<string, string>, fn: () => void): void {
  const originalPath = process.env.PATH;
  const originalEnv: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) originalEnv[key] = process.env[key];
  process.env.PATH = `${FIXTURE_CLAUDE_DIR}:${originalPath}`;
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    process.env.PATH = originalPath;
    for (const key of Object.keys(env)) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
}

function chunk(filePath: string, startLine: number, lineCount: number): ScanSummaryChunk {
  return {
    filePath,
    startLine,
    lines: Array.from({ length: lineCount }, (_, i) => `line ${startLine + i} of ${filePath}`),
  };
}

// --- runScanSummary: the headless contract ----------------------------------

test("runScanSummary: returns the model's plain prose text and its cost on success", () => {
  let outcome: ReturnType<typeof runScanSummary>;
  withMockClaude({ GRASP_TEST_SUMMARY_TEXT: "This run covered the auth module and a config file.", GRASP_TEST_SUMMARY_COST: "0.0012" }, () => {
    outcome = runScanSummary([chunk("src/auth.ts", 1, 20)]);
  });
  assert.equal(outcome!.summary, "This run covered the auth module and a config file.");
  assert.equal(outcome!.costUsd, 0.0012);
});

test("runScanSummary: an error envelope returns a null summary but still reports whatever cost was included", () => {
  let outcome: ReturnType<typeof runScanSummary>;
  withMockClaude({ GRASP_TEST_SUMMARY_MODE: "error" }, () => {
    outcome = runScanSummary([chunk("src/auth.ts", 1, 20)]);
  });
  assert.equal(outcome!.summary, null);
  assert.equal(outcome!.costUsd, 0.0005);
});

test("runScanSummary: a blank response text is treated as no summary, not an empty string", () => {
  let outcome: ReturnType<typeof runScanSummary>;
  withMockClaude({ GRASP_TEST_SUMMARY_TEXT: "   " }, () => {
    outcome = runScanSummary([chunk("src/auth.ts", 1, 20)]);
  });
  assert.equal(outcome!.summary, null);
});

test("buildScanSummaryPrompt (via runScanSummary): includes every chunk's file path, absolute line range, and content when under the cap", () => {
  const logPath = path.join(mkTempDir("grasp-test-summary-log-"), "log.txt");
  withMockClaude({ GRASP_TEST_SUMMARY_LOG: logPath }, () => {
    runScanSummary([chunk("src/a.ts", 1, 5), chunk("src/b.ts", 401, 10)]);
  });
  const prompt = fs.readFileSync(logPath, "utf-8");
  assert.match(prompt, /File: src\/a\.ts \(lines 1-5\)/);
  assert.match(prompt, /line 1 of src\/a\.ts/);
  assert.match(prompt, /File: src\/b\.ts \(lines 401-410\)/);
  assert.match(prompt, /line 401 of src\/b\.ts/);
});

test("buildScanSummaryPrompt (via runScanSummary): caps total raw content lines, naming (not including content for) chunks past the cap", () => {
  const logPath = path.join(mkTempDir("grasp-test-summary-log-"), "log.txt");
  // MAX_SCAN_SUMMARY_CONTENT_LINES is 3000 — one 2900-line chunk fits
  // entirely; a second, smaller chunk right after it would push the total
  // over 3000, so it must be named but not included in full.
  withMockClaude({ GRASP_TEST_SUMMARY_LOG: logPath }, () => {
    runScanSummary([chunk("src/big.ts", 1, 2900), chunk("src/overflow.ts", 1, 200)]);
  });
  const prompt = fs.readFileSync(logPath, "utf-8");
  assert.match(prompt, /File: src\/big\.ts \(lines 1-2900\)/);
  assert.match(prompt, /line 1 of src\/big\.ts/, "the first, under-the-cap chunk's content must be included in full");
  assert.doesNotMatch(prompt, /line 1 of src\/overflow\.ts/, "the over-the-cap chunk's own content must NOT be included");
  assert.match(
    prompt,
    /src\/overflow\.ts \(lines 1-200\)/,
    "the over-the-cap chunk must still be NAMED (file path + line range) even without its content"
  );
});

// --- End-to-end: printed after the review UI, cost kept separate -----------

function scanRepo(files: Record<string, string>): string {
  const repo = fs.realpathSync(mkTempDir("grasp-test-scansummary-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repo });
  return repo;
}

function scanHome(): string {
  return fs.realpathSync(mkTempDir("grasp-test-scansummary-home-"));
}

function runScanPty(steps: PtyStep[], env: Record<string, string>, cwd: string) {
  return runPtyArgs(["scan"], steps, env, cwd);
}

function mockClaudeEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env,
    PATH: `${FIXTURE_CLAUDE_DIR}:${process.env.PATH}`,
    GRASP_TEST_MOCK_MODE: "normal",
    GRASP_TEST_MOCK_COST: "0.001",
    GRASP_TEST_SUMMARY_TEXT: "This run covered example.ts and helper.ts.",
    GRASP_TEST_SUMMARY_COST: "0.0009",
    ...extra,
  } as Record<string, string>;
}

/** Answers a concept-then-instance question, including the sample-answer reveal screens, via the same steps scanPty.test.ts's own end-to-end test uses. */
function answerOneQuestion(): PtyStep[] {
  return [
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
  ];
}

test(
  "grasp scan: the summary is printed after the review UI closes, and its cost is a separate line from the question-generation cost",
  { timeout: 20_000 },
  async () => {
    const repo = scanRepo({
      "example.ts": "export function example() {\n  return 1;\n}\n\nexport function exampleExtra() {\n  return 2;\n}\n",
    });
    const home = scanHome();

    const result = await runScanPty(
      [...answerOneQuestion(), { type: "wait_for", text: "spent generating this run's summary", timeout: 10 }],
      mockClaudeEnv({ HOME: home }),
      repo
    );

    assert.equal(result.code, 0, `pty driver reported a failure: ${result.stderr}`);
  }
);

test(
  "grasp scan: a run against a small multi-file fixture produces a summary describing only what THAT run walked, not the whole repo",
  { timeout: 20_000 },
  async () => {
    const repo = scanRepo({
      "a/one.ts": "export function one() {\n  return 1;\n}\n",
      "b/two.ts": "export function two() {\n  return 2;\n}\n",
    });
    const home = scanHome();
    const summaryLogPath = path.join(mkTempDir("grasp-test-summary-e2e-log-"), "log.txt");

    // Cap of 4 real questions — the mock's "normal" mode always returns a
    // "both" pair (2 sub-questions per chunk, per DECISIONS.md's "question
    // caps count real questions, not event-rows" entry), so covering both
    // files' one chunk each needs a cap of at least 4, not 2.
    fs.writeFileSync(path.join(repo, ".grasp.json"), JSON.stringify({ scanQuestionsCap: 4 }), "utf-8");

    const result = await runScanPty(
      [
        ...answerOneQuestion(),
        ...answerOneQuestion(),
        { type: "wait_for", text: "spent generating this run's summary", timeout: 10 },
      ],
      mockClaudeEnv({ HOME: home, GRASP_TEST_SUMMARY_LOG: summaryLogPath }),
      repo
    );
    assert.equal(result.code, 0, `pty driver reported a failure: ${result.stderr}`);

    const prompt = fs.readFileSync(summaryLogPath, "utf-8");
    assert.match(prompt, /File: a\/one\.ts/);
    assert.match(prompt, /File: b\/two\.ts/);
  }
);

test(
  "grasp scan: a second run with nothing new to process produces no summary attempt and no extra cost line",
  { timeout: 20_000 },
  async () => {
    const repo = scanRepo({ "example.ts": "export function example() {\n  return 1;\n}\n" });
    const home = scanHome();
    const secondRunSummaryLog = path.join(mkTempDir("grasp-test-summary-second-run-log-"), "log.txt");

    // Run 1: fully scan and answer the file's one question.
    const run1 = await runScanPty(
      [...answerOneQuestion(), { type: "wait_for", text: "spent generating this run's summary", timeout: 10 }],
      mockClaudeEnv({ HOME: home }),
      repo
    );
    assert.equal(run1.code, 0, `run 1 pty driver reported a failure: ${run1.stderr}`);

    // Run 2: nothing left to scan, no edits since run 1 — must reach the
    // "nothing left" message quickly, with no summary call attempted at all.
    const run2 = await runScanPty(
      [{ type: "wait_for", text: "Nothing left to scan", timeout: 10 }],
      mockClaudeEnv({ HOME: home, GRASP_TEST_SUMMARY_LOG: secondRunSummaryLog }),
      repo
    );
    assert.equal(run2.code, 0, `run 2 pty driver reported a failure: ${run2.stderr}`);
    assert.ok(!fs.existsSync(secondRunSummaryLog), "no summary call should have been made on a run with nothing new to process");
  }
);

test(
  "grasp scan: summary cost is never folded into the tracked session cost total (getSessionCostUsd)",
  { timeout: 20_000 },
  async () => {
    const repo = scanRepo({ "example.ts": "export function example() {\n  return 1;\n}\n" });
    const home = scanHome();

    const result = await runScanPty(
      [
        ...answerOneQuestion(),
        { type: "wait_for", text: "spent generating comprehension questions this scan", timeout: 10 },
        { type: "wait_for", text: "spent generating this run's summary", timeout: 10 },
      ],
      mockClaudeEnv({ HOME: home, GRASP_TEST_MOCK_COST: "0.0021", GRASP_TEST_SUMMARY_COST: "0.0055" }),
      repo
    );
    assert.equal(result.code, 0, `pty driver reported a failure: ${result.stderr}`);

    const dbPath = path.join(home, ".grasp", "history.db");
    const db = openStore(dbPath);
    const row = db.prepare(`SELECT session_id FROM events WHERE source = 'scan'`).get() as { session_id: string };
    const trackedCost = getSessionCostUsd(db, row.session_id);
    db.close();
    assert.equal(trackedCost, 0.0021, "the tracked session cost must reflect only the question-generation call, never the summary call's 0.0055");
  }
);
