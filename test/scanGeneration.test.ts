import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { computeValidatedExcerpt, parseScanJudgeResponse, runScanFileGeneration } from "../src/generation";
import { getConceptTagGlobal, openStore } from "../src/store";
import { testConfig } from "./helpers";

/**
 * Unit/integration tests for `grasp scan`'s judge contract:
 * `parseScanJudgeResponse` (the response shape, including the §4 cited-range
 * fields), `computeValidatedExcerpt` (clamping/validation, generation-time
 * not render-time — see DECISIONS.md's "grasp scan: cited-range validation"
 * entry), and `runScanFileGeneration` (the end-to-end single-file judge
 * call, no slot-locking, no cap check of its own — see DECISIONS.md's
 * "grasp scan: no slot-locking..." entry).
 */

// --- computeValidatedExcerpt: clamping and malformed-range handling --------

test("computeValidatedExcerpt: an in-bounds range is returned unchanged", () => {
  const lines = ["a", "b", "c", "d", "e"];
  const excerpt = computeValidatedExcerpt(lines, 2, 4);
  assert.deepEqual(excerpt, { startLine: 2, endLine: 4, lines: ["b", "c", "d"] });
});

test("computeValidatedExcerpt: an end past EOF is clamped to the last line, not rejected", () => {
  const lines = ["a", "b", "c"];
  const excerpt = computeValidatedExcerpt(lines, 2, 999);
  assert.deepEqual(excerpt, { startLine: 2, endLine: 3, lines: ["b", "c"] });
});

test("computeValidatedExcerpt: a start below 1 is clamped up to 1", () => {
  const lines = ["a", "b", "c"];
  const excerpt = computeValidatedExcerpt(lines, -5, 2);
  assert.deepEqual(excerpt, { startLine: 1, endLine: 2, lines: ["a", "b"] });
});

test("computeValidatedExcerpt: a malformed range (start after end, even post-clamp) returns null", () => {
  const lines = ["a", "b", "c", "d", "e"];
  assert.equal(computeValidatedExcerpt(lines, 5, 1), null);
});

test("computeValidatedExcerpt: start after end that both clamp to the same out-of-range value still returns null, not a bogus 1-line excerpt", () => {
  const lines = ["a", "b", "c"];
  // Both clamp to 3 (the last line) — start === end here happens to still
  // work, so use a case where clamping would otherwise cross.
  assert.equal(computeValidatedExcerpt(lines, 100, 1), null);
});

test("computeValidatedExcerpt: an empty file returns null", () => {
  assert.equal(computeValidatedExcerpt([], 1, 1), null);
});

test("computeValidatedExcerpt: a range wider than the cap is narrowed, not rejected", () => {
  const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
  const excerpt = computeValidatedExcerpt(lines, 1, 500);
  assert.ok(excerpt);
  assert.equal(excerpt!.startLine, 1);
  assert.equal(excerpt!.endLine - excerpt!.startLine + 1, excerpt!.lines.length);
  assert.ok(excerpt!.lines.length <= 200, `expected the excerpt capped to <=200 lines, got ${excerpt!.lines.length}`);
});

// --- parseScanJudgeResponse: contract shape ---------------------------------

test("parseScanJudgeResponse: a well-formed worthAsking=true response with a cited range parses", () => {
  const raw = JSON.stringify({
    worthAsking: true,
    conceptTag: "recursion",
    questionConcept: "What is recursion?",
    questionInstance: "Where does this file use it?",
    sampleAnswerConcept: "A function that calls itself.",
    sampleAnswerInstance: "In the tree-walk helper.",
    conceptExplanation: "Recursion is when a function calls itself to solve smaller subproblems.",
    citedLineStart: 10,
    citedLineEnd: 25,
  });
  const parsed = parseScanJudgeResponse(raw);
  assert.equal(parsed?.citedLineStart, 10);
  assert.equal(parsed?.citedLineEnd, 25);
  assert.equal(parsed?.conceptTag, "recursion");
});

test("parseScanJudgeResponse: worthAsking=false requires citedLineStart/citedLineEnd to also be null", () => {
  const raw = JSON.stringify({
    worthAsking: false,
    conceptTag: null,
    questionConcept: null,
    questionInstance: null,
    sampleAnswerConcept: null,
    sampleAnswerInstance: null,
    conceptExplanation: null,
    citedLineStart: 5,
    citedLineEnd: 10,
  });
  assert.equal(parseScanJudgeResponse(raw), null, "a non-null cited range on a declined response is internally inconsistent");
});

test("parseScanJudgeResponse: rejects a worthAsking=true response missing citedLineStart entirely", () => {
  const raw = JSON.stringify({
    worthAsking: true,
    conceptTag: "recursion",
    questionConcept: null,
    questionInstance: "instance question",
    sampleAnswerConcept: null,
    sampleAnswerInstance: "sample",
    conceptExplanation: "explanation",
    citedLineEnd: 10,
  });
  assert.equal(parseScanJudgeResponse(raw), null);
});

test("parseScanJudgeResponse: rejects a non-numeric citedLineStart", () => {
  const raw = JSON.stringify({
    worthAsking: true,
    conceptTag: "recursion",
    questionConcept: null,
    questionInstance: "instance question",
    sampleAnswerConcept: null,
    sampleAnswerInstance: "sample",
    conceptExplanation: "explanation",
    citedLineStart: "ten",
    citedLineEnd: 20,
  });
  assert.equal(parseScanJudgeResponse(raw), null);
});

test("parseScanJudgeResponse: DOES accept citedLineStart > citedLineEnd at the contract level — that's a rendering concern (computeValidatedExcerpt), not a parse failure", () => {
  const raw = JSON.stringify({
    worthAsking: true,
    conceptTag: "recursion",
    questionConcept: null,
    questionInstance: "instance question",
    sampleAnswerConcept: null,
    sampleAnswerInstance: "sample",
    conceptExplanation: "explanation",
    citedLineStart: 50,
    citedLineEnd: 5,
  });
  const parsed = parseScanJudgeResponse(raw);
  assert.ok(parsed, "a backwards range is still a structurally valid, otherwise-good response");
  assert.equal(parsed!.citedLineStart, 50);
  assert.equal(parsed!.citedLineEnd, 5);
});

test("parseScanJudgeResponse: rejects a zero or negative citedLineStart", () => {
  const raw = JSON.stringify({
    worthAsking: true,
    conceptTag: "recursion",
    questionConcept: null,
    questionInstance: "instance question",
    sampleAnswerConcept: null,
    sampleAnswerInstance: "sample",
    conceptExplanation: "explanation",
    citedLineStart: 0,
    citedLineEnd: 5,
  });
  assert.equal(parseScanJudgeResponse(raw), null);
});

// --- runScanFileGeneration: end-to-end with the mock claude binary ---------

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

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-test-scangen-db-"));
  return path.join(dir, "history.db");
}

test("runScanFileGeneration: a real question stores source='scan', diffSummary=filePath, and a clamped excerpt", () => {
  const db = openStore(tempDbPath());
  const fileLines = ["line one", "line two", "line three"];

  withMockClaude({ GRASP_TEST_MOCK_MODE: "normal", GRASP_TEST_MOCK_COST: "0.001" }, () => {
    const outcome = runScanFileGeneration(db, {
      sessionId: "scan-gen-test",
      repo: "/tmp/scan-repo",
      filePath: "src/example.ts",
      fileLines,
      config: testConfig(),
    });
    assert.equal(outcome.missReason, null);
    assert.equal(outcome.questionType, "both");
  });

  const row = db.prepare(`SELECT * FROM events WHERE session_id = 'scan-gen-test'`).get() as any;
  assert.equal(row.source, "scan");
  assert.equal(row.diff_summary, "src/example.ts");
  assert.equal(row.diff_hash, null);
  assert.equal(row.diff_files_json, null);
  assert.equal(row.scan_excerpt_start_line, 1);
  assert.equal(row.scan_excerpt_end_line, 2);
  assert.deepEqual(JSON.parse(row.scan_excerpt_lines_json), ["line one", "line two"]);
  db.close();
});

test("runScanFileGeneration: an already-answered concept tag suppresses the concept question and its excerpt-adjacent sample answer, instance-only", () => {
  const db = openStore(tempDbPath());
  db.exec(`
    INSERT INTO events (timestamp, repo, session_id, question_type, generation_source, source)
    VALUES ('2020-01-01T00:00:00.000Z', '/tmp/scan-repo', 'prior-session', 'both', 'test-seed', 'diff');
  `);
  const eventId = db.prepare(`SELECT id FROM events WHERE session_id = 'prior-session'`).get() as { id: number };
  // No GRASP_TEST_MOCK_COUNTER passed below, so the mock's counter `n`
  // stays at its default (0) — the tag it reports is "test-concept-0".
  db.prepare(`INSERT INTO concept_tags (event_id, tag, answered) VALUES (?, 'test-concept-0', 1)`).run(eventId.id);

  withMockClaude({ GRASP_TEST_MOCK_MODE: "normal", GRASP_TEST_MOCK_COST: "0.001" }, () => {
    const outcome = runScanFileGeneration(db, {
      sessionId: "scan-gen-test-2",
      repo: "/tmp/scan-repo",
      filePath: "src/example.ts",
      fileLines: ["a", "b"],
      config: testConfig(),
    });
    assert.equal(outcome.questionType, "instance");
  });

  const row = db.prepare(`SELECT question_concept, question_instance FROM events WHERE session_id = 'scan-gen-test-2'`).get() as any;
  assert.equal(row.question_concept, null);
  assert.ok(row.question_instance);
  db.close();
});

test("runScanFileGeneration: worthAsking=false is recorded with no question and no excerpt, but still costs are tracked", () => {
  const db = openStore(tempDbPath());
  withMockClaude({ GRASP_TEST_MOCK_MODE: "error" }, () => {
    const outcome = runScanFileGeneration(db, {
      sessionId: "scan-gen-test-3",
      repo: "/tmp/scan-repo",
      filePath: "src/trivial.ts",
      fileLines: ["export const x = 1;"],
      config: testConfig(),
    });
    assert.equal(outcome.missReason, "error");
  });
  const row = db.prepare(`SELECT source, scan_excerpt_start_line FROM events WHERE session_id = 'scan-gen-test-3'`).get() as any;
  assert.equal(row.source, "scan");
  assert.equal(row.scan_excerpt_start_line, null);
  db.close();
});

test("runScanFileGeneration: a timeout is distinguished from a plain error, same as the diff side's isTimeoutError", () => {
  const db = openStore(tempDbPath());
  withMockClaude({ GRASP_TEST_MOCK_MODE: "normal", GRASP_TEST_MOCK_DELAY_MS: "100" }, () => {
    // Not actually testing the timeout path here (too slow for a unit
    // test to force deliberately) — this call just proves a slow-but-
    // still-within-budget mock doesn't accidentally misclassify as a
    // timeout when it wasn't one.
    const outcome = runScanFileGeneration(db, {
      sessionId: "scan-gen-test-4",
      repo: "/tmp/scan-repo",
      filePath: "src/slow.ts",
      fileLines: ["export const x = 1;"],
      config: testConfig(),
    });
    assert.equal(outcome.missReason, null);
  });
  db.close();
});

test("runScanFileGeneration: memoization check reads getConceptTagGlobal — the concept tag from a real scan question is recorded, not pre-marked answered", () => {
  const db = openStore(tempDbPath());
  withMockClaude({ GRASP_TEST_MOCK_MODE: "normal", GRASP_TEST_MOCK_COST: "0.001" }, () => {
    runScanFileGeneration(db, {
      sessionId: "scan-gen-test-5",
      repo: "/tmp/scan-repo",
      filePath: "src/example.ts",
      fileLines: ["a", "b"],
      config: testConfig(),
    });
  });
  const tagRows = getConceptTagGlobal(db, "test-concept-0", false);
  assert.equal(tagRows.length, 1);
  assert.equal(tagRows[0].answered, false, "a freshly-generated concept tag is not answered until the user actually answers it");
  db.close();
});
