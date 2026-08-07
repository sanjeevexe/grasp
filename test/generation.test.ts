import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildDiffSummary, isTimeoutError, parseJudgeResponse, runGeneration, GenerationParams } from "../src/generation";
import { openStore, getConceptTagGlobal } from "../src/store";
import { diffFile, testConfig } from "./helpers";

// --- parseJudgeResponse: the judge+generate response contract -------------

test("parseJudgeResponse: a well-formed worthAsking=true, both-questions response parses", () => {
  const raw = JSON.stringify({
    worthAsking: true,
    conceptTag: "mutex-vs-channel",
    questionConcept: "What is a mutex?",
    questionInstance: "Why did this diff use one?",
  });
  const parsed = parseJudgeResponse(raw);
  assert.deepEqual(parsed, {
    worthAsking: true,
    conceptTag: "mutex-vs-channel",
    questionConcept: "What is a mutex?",
    questionInstance: "Why did this diff use one?",
  });
});

test("parseJudgeResponse: worthAsking=true with a null questionConcept (already-known concept) parses", () => {
  const raw = JSON.stringify({
    worthAsking: true,
    conceptTag: "mutex-vs-channel",
    questionConcept: null,
    questionInstance: "Why did this diff use one?",
  });
  const parsed = parseJudgeResponse(raw);
  assert.equal(parsed?.questionConcept, null);
  assert.equal(parsed?.questionInstance, "Why did this diff use one?");
});

test("parseJudgeResponse: a well-formed worthAsking=false response parses", () => {
  const raw = JSON.stringify({ worthAsking: false, conceptTag: null, questionConcept: null, questionInstance: null });
  assert.deepEqual(parseJudgeResponse(raw), {
    worthAsking: false,
    conceptTag: null,
    questionConcept: null,
    questionInstance: null,
  });
});

test("parseJudgeResponse: strips a markdown code fence the model wasn't supposed to add", () => {
  const raw = "```json\n" + JSON.stringify({ worthAsking: false, conceptTag: null, questionConcept: null, questionInstance: null }) + "\n```";
  const parsed = parseJudgeResponse(raw);
  assert.equal(parsed?.worthAsking, false);
});

test("parseJudgeResponse: rejects invalid JSON", () => {
  assert.equal(parseJudgeResponse("not json at all"), null);
});

test("parseJudgeResponse: rejects worthAsking=true with a missing conceptTag", () => {
  const raw = JSON.stringify({ worthAsking: true, conceptTag: null, questionConcept: "x", questionInstance: "y" });
  assert.equal(parseJudgeResponse(raw), null);
});

test("parseJudgeResponse: rejects worthAsking=true with a missing questionInstance", () => {
  const raw = JSON.stringify({ worthAsking: true, conceptTag: "tag", questionConcept: "x", questionInstance: "" });
  assert.equal(parseJudgeResponse(raw), null);
});

test("parseJudgeResponse: rejects worthAsking=false with a non-null conceptTag (internally inconsistent)", () => {
  const raw = JSON.stringify({ worthAsking: false, conceptTag: "tag", questionConcept: null, questionInstance: null });
  assert.equal(parseJudgeResponse(raw), null);
});

test("parseJudgeResponse: rejects a response missing worthAsking entirely", () => {
  const raw = JSON.stringify({ conceptTag: "tag", questionConcept: "x", questionInstance: "y" });
  assert.equal(parseJudgeResponse(raw), null);
});

test("parseJudgeResponse: rejects a bare JSON array (not an object)", () => {
  assert.equal(parseJudgeResponse("[]"), null);
});

test("parseJudgeResponse: rejects a conceptTag that isn't kebab-case", () => {
  // Regression test: memoization is a plain string match against
  // previously-stored tags, so a differently-formatted tag for the same
  // concept (wrong case, spaces, punctuation) would silently defeat it.
  // Found by an independent test pass.
  const raw = JSON.stringify({
    worthAsking: true,
    conceptTag: "Not Kebab Case!",
    questionConcept: "x",
    questionInstance: "y",
  });
  assert.equal(parseJudgeResponse(raw), null);
});

test("parseJudgeResponse: accepts a multi-word kebab-case conceptTag", () => {
  const raw = JSON.stringify({
    worthAsking: true,
    conceptTag: "mutex-vs-channel-2",
    questionConcept: "x",
    questionInstance: "y",
  });
  assert.equal(parseJudgeResponse(raw)?.conceptTag, "mutex-vs-channel-2");
});

// --- runGeneration: concept-first enforcement -----------------------------
//
// Regression coverage for a bug an independent test pass found: a mock
// response for a never-before-answered concept tag, with no concept
// question, used to be accepted as a successful instance-only event — that
// would let the concept get marked "answered" the moment the instance
// question was answered, without the concept question ever having been
// asked. Grasp must reject this deterministically rather than trust the
// model's self-report.

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-test-gen-db-"));
  return path.join(dir, "history.db");
}

function baseParams(overrides: Partial<GenerationParams> = {}): GenerationParams {
  return {
    sessionId: "test-session",
    repo: "/tmp/test-repo",
    significantFiles: [diffFile({ path: "a.ts", insertions: 10, deletions: 2 })],
    config: testConfig(),
    diffHash: null,
    ...overrides,
  };
}

test("runGeneration: a brand-new concept tag with no concept question is rejected as malformed, not accepted", () => {
  const db = openStore(tempDbPath());
  const params = baseParams();
  let outcome: ReturnType<typeof runGeneration> | undefined;

  withMockClaude({ GRASP_TEST_MOCK_MODE: "brand-new-concept-no-question" }, () => {
    outcome = runGeneration(db, params);
  });

  assert.equal(outcome!.missReason, "error", "must be recorded as a miss, never a silent instance-only success");
  assert.equal(outcome!.questionType, null);

  const row = db.prepare("SELECT question_type, cost_usd FROM events WHERE id = ?").get(outcome!.eventId) as any;
  assert.equal(row.question_type, null);
  assert.equal(row.cost_usd, 0.001, "the call still cost money and that cost must still be recorded");

  // The concept must NOT be memoized as taught — nothing should be
  // learnable about "brand-new-concept" from this rejected event.
  const tagRows = getConceptTagGlobal(db, "brand-new-concept", false);
  assert.equal(tagRows.length, 0);
  db.close();
});

test("runGeneration: the SAME response shape is accepted once the concept is already answered (no violation)", () => {
  const db = openStore(tempDbPath());
  // Pre-seed the concept tag as already answered via a prior event.
  db.exec(`
    INSERT INTO events (timestamp, repo, session_id, question_type, generation_source)
    VALUES ('2020-01-01T00:00:00.000Z', '/tmp/test-repo', 'prior-session', 'both', 'test-seed');
  `);
  const eventId = db.prepare(`SELECT id FROM events WHERE session_id = 'prior-session'`).get() as { id: number };
  db.prepare(`INSERT INTO concept_tags (event_id, tag, answered) VALUES (?, 'brand-new-concept', 1)`).run(eventId.id);

  const params = baseParams();
  let outcome: ReturnType<typeof runGeneration> | undefined;

  withMockClaude({ GRASP_TEST_MOCK_MODE: "brand-new-concept-no-question" }, () => {
    outcome = runGeneration(db, params);
  });

  assert.equal(outcome!.missReason, null);
  assert.equal(outcome!.questionType, "instance");
  db.close();
});

// --- isTimeoutError ---------------------------------------------------------

test("isTimeoutError: true for a caught execFileSync timeout error (code ETIMEDOUT)", () => {
  assert.equal(isTimeoutError({ code: "ETIMEDOUT", signal: "SIGTERM" }), true);
});

test("isTimeoutError: false for a plain nonzero-exit failure (no code)", () => {
  assert.equal(isTimeoutError({ status: 1, signal: null }), false);
});

test("isTimeoutError: false for a SIGTERM that isn't actually a timeout (code absent)", () => {
  // Empirically verified in this project (see DECISIONS.md's "Timeout
  // detection mechanism" entry): signal alone is not a safe enough signal,
  // code is what's actually checked.
  assert.equal(isTimeoutError({ signal: "SIGTERM" }), false);
});

test("isTimeoutError: false for non-object/null inputs", () => {
  assert.equal(isTimeoutError(null), false);
  assert.equal(isTimeoutError("some string"), false);
  assert.equal(isTimeoutError(undefined), false);
});

// --- buildDiffSummary --------------------------------------------------------

test("buildDiffSummary: single file, correct +/- counts and file list", () => {
  const summary = buildDiffSummary([diffFile({ path: "a.ts", insertions: 4, deletions: 1 })]);
  assert.equal(summary, "1 file changed (+4/-1): a.ts");
});

test("buildDiffSummary: multiple files, summed insertions/deletions, comma-joined list", () => {
  const summary = buildDiffSummary([
    diffFile({ path: "a.ts", insertions: 4, deletions: 1 }),
    diffFile({ path: "b.ts", insertions: 2, deletions: 3 }),
  ]);
  assert.equal(summary, "2 files changed (+6/-4): a.ts, b.ts");
});

test("buildDiffSummary: zero files", () => {
  assert.equal(buildDiffSummary([]), "0 files changed (+0/-0): ");
});
