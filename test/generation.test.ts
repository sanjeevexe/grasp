import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDiffSummary, isTimeoutError, parseJudgeResponse } from "../src/generation";
import { diffFile } from "./helpers";

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
