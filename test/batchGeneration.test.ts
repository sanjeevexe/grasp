import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync, spawnSync } from "child_process";
import { ClaudeCodeAdapter } from "../src/adapters/claudeCodeAdapter";
import { loadConfig } from "../src/config";
import { resolveRepoRoot } from "../src/git";
import { runBatchGeneration } from "../src/generation";
import { getUnresolvedCapturedDiffs, insertCapturedDiff, insertEvent, openStore, upsertTurn } from "../src/store";
import { CLI_PATH, diffFile } from "./helpers";

/**
 * Regression coverage for the reliability rework: generation moved from
 * "once per PostToolUse firing" (competing for one shared per-session slot
 * on Claude Code's hard 45s hook-kill clock — the real, dogfooding-observed
 * bug this rework fixes) to "at most once per Stop firing, covering
 * everything captured-but-unresolved since the last successful attempt."
 * See DECISIONS.md's "Batched-at-Stop generation" entry for the full design
 * this exercises: `captured_diffs.resolved` tracking, retry-on-failure, and
 * the combined diffFiles/diffSummary/prompt shape for a real batch.
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

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepoWithCommit(): string {
  const repo = mkTempDir("grasp-test-batchgen-repo-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "app.ts"), "export function original() {\n  return 1;\n}\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  return repo;
}

function tempDbPath(): string {
  return path.join(mkTempDir("grasp-test-batchgen-db-"), "history.db");
}

// A comfortably-above-threshold edit — enough lines to clear the mechanical
// filter's minChangedLines floor and reach generation.
function writeMeaningfulEdit(repo: string, file: string, marker: string): void {
  fs.writeFileSync(
    path.join(repo, file),
    `export function original() {\n  return 1;\n}\n\nexport function ${marker}() {\n  return 2;\n}\n\nexport function ${marker}Extra() {\n  return 3;\n}\n`
  );
}

// --- PostToolUse no longer generates directly -------------------------------

test("checkAndCapture (PostToolUse): captures only — no events row is written, the diff sits unresolved", () => {
  const repo = initRepoWithCommit();
  const db = openStore(tempDbPath());
  const sessionId = "s-capture-only";
  const promptId = "p1";
  const adapter = new ClaudeCodeAdapter(db, sessionId, promptId, repo);
  adapter.ensureTurnStarted();
  adapter.ensureCheckpointSeeded();

  writeMeaningfulEdit(repo, "app.ts", "addedByAgent");
  const diff = adapter.checkAndCapture();
  assert.ok(diff.files.length > 0, "sanity check: a real diff was captured");

  const eventCount = (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
  assert.equal(eventCount, 0, "capturing a diff must never, by itself, write an events row anymore");

  const pending = getUnresolvedCapturedDiffs(db, sessionId, repo);
  assert.equal(pending.length, 1);
  assert.ok(pending[0].significantFiles && pending[0].significantFiles.length > 0, "significantFiles must be persisted at capture time");
  db.close();
});

// --- The actual bug fix: several rapid tool calls -> one combined question -

test("runBatchGeneration: several rapid captures in one turn produce ONE combined question at Stop, not one per tool call", () => {
  const repo = initRepoWithCommit();
  const db = openStore(tempDbPath());
  const sessionId = "s-batch";
  const promptId = "p1";
  const adapter = new ClaudeCodeAdapter(db, sessionId, promptId, repo);
  adapter.ensureTurnStarted();
  adapter.ensureCheckpointSeeded();

  // Three separate PostToolUse-style captures, matching a single turn that
  // made three tool calls close together — the exact shape that used to
  // compete for one shared generation slot and could time out.
  writeMeaningfulEdit(repo, "a.ts", "changeOne");
  adapter.checkAndCapture();
  writeMeaningfulEdit(repo, "b.ts", "changeTwo");
  adapter.checkAndCapture();
  writeMeaningfulEdit(repo, "c.ts", "changeThree");
  adapter.checkAndCapture();

  assert.equal(getUnresolvedCapturedDiffs(db, sessionId, repo).length, 3);

  const argvLogPath = path.join(mkTempDir("grasp-test-argv-"), "argv.json");
  const { config } = loadConfig(repo);
  withMockClaude(
    { GRASP_TEST_MOCK_MODE: "normal", GRASP_TEST_MOCK_COST: "0.001", GRASP_TEST_MOCK_ARGV_LOG: argvLogPath },
    () => {
      const outcome = runBatchGeneration(db, { sessionId, repo, config });
      assert.ok(outcome);
      assert.equal(outcome!.missReason, null);
    }
  );

  const questionEvents = (
    db.prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND question_type IS NOT NULL`).get(sessionId) as {
      n: number;
    }
  ).n;
  assert.equal(questionEvents, 1, "exactly one combined question event must be written, not one per captured diff");

  const row = db.prepare(`SELECT diff_files_json FROM events WHERE session_id = ? AND question_type IS NOT NULL`).get(sessionId) as any;
  const combinedFiles = JSON.parse(row.diff_files_json);
  assert.equal(combinedFiles.length, 3, "the stored diffFiles must be the union across all three captured diffs");

  const argv: string[] = JSON.parse(fs.readFileSync(argvLogPath, "utf-8"));
  const prompt = argv[argv.indexOf("-p") + 1];
  assert.match(prompt, /=== Change 1 of 3 ===/, "the batch prompt must label each covered diff separately");
  assert.match(prompt, /=== Change 3 of 3 ===/);

  assert.equal(getUnresolvedCapturedDiffs(db, sessionId, repo).length, 0, "every covered diff must be marked resolved");
  db.close();
});

test("runBatchGeneration: a single-diff batch's prompt is unchanged (no 'Change i of N' labeling)", () => {
  const repo = initRepoWithCommit();
  const db = openStore(tempDbPath());
  const sessionId = "s-single";
  const promptId = "p1";
  const adapter = new ClaudeCodeAdapter(db, sessionId, promptId, repo);
  adapter.ensureTurnStarted();
  adapter.ensureCheckpointSeeded();

  writeMeaningfulEdit(repo, "a.ts", "soleChange");
  adapter.checkAndCapture();

  const argvLogPath = path.join(mkTempDir("grasp-test-argv-"), "argv.json");
  const { config } = loadConfig(repo);
  withMockClaude(
    { GRASP_TEST_MOCK_MODE: "normal", GRASP_TEST_MOCK_COST: "0.001", GRASP_TEST_MOCK_ARGV_LOG: argvLogPath },
    () => {
      runBatchGeneration(db, { sessionId, repo, config });
    }
  );

  const argv: string[] = JSON.parse(fs.readFileSync(argvLogPath, "utf-8"));
  const prompt = argv[argv.indexOf("-p") + 1];
  assert.doesNotMatch(prompt, /=== Change/, "a batch of one diff must render exactly like the pre-batching single-diff prompt");
  db.close();
});

// --- Failed attempts leave diffs unresolved for retry -----------------------

test("runBatchGeneration: a failed attempt leaves its diffs unresolved; the next attempt retries them combined with anything new", () => {
  const repo = initRepoWithCommit();
  const db = openStore(tempDbPath());
  const sessionId = "s-retry";
  const promptId = "p1";
  const adapter = new ClaudeCodeAdapter(db, sessionId, promptId, repo);
  adapter.ensureTurnStarted();
  adapter.ensureCheckpointSeeded();
  const { config } = loadConfig(repo);

  writeMeaningfulEdit(repo, "a.ts", "firstChange");
  adapter.checkAndCapture();

  withMockClaude({ GRASP_TEST_MOCK_MODE: "error" }, () => {
    const outcome = runBatchGeneration(db, { sessionId, repo, config });
    assert.equal(outcome!.missReason, "error");
  });

  let pending = getUnresolvedCapturedDiffs(db, sessionId, repo);
  assert.equal(pending.length, 1, "a failed attempt must leave its diff unresolved, not lose it");

  // More work accumulates before the next opportunity — the retry batch
  // should combine BOTH the still-unresolved diff and this new one.
  writeMeaningfulEdit(repo, "b.ts", "secondChange");
  adapter.checkAndCapture();
  pending = getUnresolvedCapturedDiffs(db, sessionId, repo);
  assert.equal(pending.length, 2);

  withMockClaude({ GRASP_TEST_MOCK_MODE: "normal", GRASP_TEST_MOCK_COST: "0.001" }, () => {
    const outcome = runBatchGeneration(db, { sessionId, repo, config });
    assert.equal(outcome!.missReason, null, "the retry must succeed once the underlying failure is gone");
  });

  assert.equal(getUnresolvedCapturedDiffs(db, sessionId, repo).length, 0);
  const row = db.prepare(`SELECT diff_files_json FROM events WHERE session_id = ? AND question_type IS NOT NULL`).get(sessionId) as any;
  assert.equal(JSON.parse(row.diff_files_json).length, 2, "the retry's combined question must cover both the retried and the newly captured diff");
  db.close();
});

// --- Question cap: cap-hit resolves the batch AND produces the new message -

test("runBatchGeneration: hitting the question cap marks the batch resolved (never retried) with miss_reason cap_reached", () => {
  const repo = initRepoWithCommit();
  const db = openStore(tempDbPath());
  const sessionId = "s-cap";
  const promptId = "p1";
  const adapter = new ClaudeCodeAdapter(db, sessionId, promptId, repo);
  adapter.ensureTurnStarted();
  adapter.ensureCheckpointSeeded();

  fs.writeFileSync(path.join(repo, ".grasp.json"), JSON.stringify({ questionsPerSessionCap: 1 }), "utf-8");
  const { config } = loadConfig(repo);

  // Pre-seed one real question event for this session so the cap (1) is
  // already met before this batch attempt runs.
  insertEvent(db, {
    timestamp: new Date().toISOString(),
    repo,
    sessionId,
    diffHash: null,
    diffSummary: "seed",
    questionConcept: null,
    questionInstance: "seed instance question",
    questionType: "instance",
    generationSource: "test-seed",
    missReason: null,
    answerConcept: null,
    answerInstance: null,
    skipped: false,
    skipReason: null,
    costUsd: 0.001,
    diffFiles: null,
  });

  writeMeaningfulEdit(repo, "a.ts", "capBlockedChange");
  adapter.checkAndCapture();
  assert.equal(getUnresolvedCapturedDiffs(db, sessionId, repo).length, 1);

  // No mock claude on PATH at all here — proves the cap check blocks BEFORE
  // ever invoking claude, same as the pre-batching cap behavior.
  const outcome = runBatchGeneration(db, { sessionId, repo, config });
  assert.equal(outcome!.missReason, "cap_reached");

  assert.equal(
    getUnresolvedCapturedDiffs(db, sessionId, repo).length,
    0,
    "a genuine cap hit is a final verdict — the covered diff must be marked resolved, never retried"
  );
  db.close();
});

test("internal:hook Stop: hitting the question cap produces the specific cap message, combined with the pending-question nudge", () => {
  // resolveRepoRoot (git rev-parse --show-toplevel) can resolve symlinks —
  // on macOS a temp dir under /var is really /private/var — so every DB
  // write below must use the SAME resolved root the real internal:hook
  // process will compute internally, or runBatchGeneration's
  // (session_id, repo) scoped lookup silently finds nothing.
  const rawRepo = initRepoWithCommit();
  const repo = resolveRepoRoot(rawRepo);
  const home = mkTempDir("grasp-test-batchgen-home-");
  fs.writeFileSync(path.join(repo, ".grasp.json"), JSON.stringify({ questionsPerSessionCap: 1 }), "utf-8");

  const dbPath = path.join(home, ".grasp", "history.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sessionId = "s-cap-message";
  const promptId = "p1";

  const db = openStore(dbPath);
  upsertTurn(db, { sessionId, promptId, repo });
  // One prior real question already meets the cap (1).
  insertEvent(db, {
    timestamp: new Date().toISOString(),
    repo,
    sessionId,
    diffHash: null,
    diffSummary: "seed",
    questionConcept: null,
    questionInstance: "seed instance question",
    questionType: "instance",
    generationSource: "test-seed",
    missReason: null,
    answerConcept: null,
    answerInstance: null,
    skipped: false,
    skipReason: null,
    costUsd: 0.001,
    diffFiles: null,
  });
  // One unresolved, passed-filter captured diff waiting for the Stop batch.
  insertCapturedDiff(db, {
    sessionId,
    promptId,
    repo,
    capturedAt: new Date().toISOString(),
    diff: { repo, capturedAt: new Date().toISOString(), files: [diffFile({ path: "a.ts", insertions: 10, deletions: 1 })], rawDiffText: "", diffHash: null },
    filtered: false,
    filterReason: null,
    significantFiles: [diffFile({ path: "a.ts", insertions: 10, deletions: 1 })],
  });
  db.close();

  const payload = JSON.stringify({ session_id: sessionId, prompt_id: promptId, hook_event_name: "Stop", cwd: repo });
  const result = spawnSync(process.execPath, [CLI_PATH, "internal:hook"], {
    cwd: repo,
    env: { ...process.env, HOME: home, PATH: `${FIXTURE_CLAUDE_DIR}:${process.env.PATH}` },
    input: payload,
  });

  assert.equal(result.status, 0);
  const stdout = result.stdout.toString();
  assert.ok(stdout.length > 0, "a Stop firing with a pending question and a cap hit must produce a systemMessage");
  const output = JSON.parse(stdout);
  assert.match(
    output.systemMessage,
    /You've hit this session's question cap \(1\) — start a new Claude Code session, or run `grasp set questions-cap <n>` to raise it\./
  );
  assert.match(output.systemMessage, /question.*waiting.*grasp review/);
});

// --- Prompt 7: visible failure signal on Stop, for both error and timeout --

test("internal:hook Stop: a batch generation attempt that errors produces a visible failure message pointing at `grasp retry`", () => {
  const rawRepo = initRepoWithCommit();
  const repo = resolveRepoRoot(rawRepo);
  const home = mkTempDir("grasp-test-batchgen-home-");

  const dbPath = path.join(home, ".grasp", "history.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sessionId = "s-error-message";
  const promptId = "p1";

  const db = openStore(dbPath);
  upsertTurn(db, { sessionId, promptId, repo });
  insertCapturedDiff(db, {
    sessionId,
    promptId,
    repo,
    capturedAt: new Date().toISOString(),
    diff: {
      repo,
      capturedAt: new Date().toISOString(),
      files: [diffFile({ path: "a.ts", insertions: 10, deletions: 1 })],
      rawDiffText: "",
      diffHash: null,
    },
    filtered: false,
    filterReason: null,
    significantFiles: [diffFile({ path: "a.ts", insertions: 10, deletions: 1 })],
  });
  db.close();

  const payload = JSON.stringify({ session_id: sessionId, prompt_id: promptId, hook_event_name: "Stop", cwd: repo });
  const result = spawnSync(process.execPath, [CLI_PATH, "internal:hook"], {
    cwd: repo,
    env: { ...process.env, HOME: home, PATH: `${FIXTURE_CLAUDE_DIR}:${process.env.PATH}`, GRASP_TEST_MOCK_MODE: "error" },
    input: payload,
  });

  assert.equal(result.status, 0);
  const stdout = result.stdout.toString();
  assert.ok(stdout.length > 0, "an error'd attempt must still produce a visible systemMessage");
  const output = JSON.parse(stdout);
  assert.match(
    output.systemMessage,
    /A comprehension question failed to generate \(error\) — it'll retry automatically on this session's next turn, or run `grasp retry` now\./
  );

  // The diff must be left unresolved for retry — same invariant
  // runBatchGeneration's own error-path tests already cover, checked here
  // too since it's exactly what the new message promises the user.
  const db2 = openStore(dbPath);
  assert.equal(getUnresolvedCapturedDiffs(db2, sessionId, repo).length, 1);
  db2.close();
});

// A real GENERATION_TIMEOUT_MS-triggered timeout takes ~20s to force
// deliberately (the same reason test/scanGeneration.test.ts's own timeout
// test declines to force one) — too slow for this suite. The Stop-message
// code this test would otherwise cover treats "error" and "timeout"
// identically (`missReason === "error" || missReason === "timeout"`, same
// `generationFailureMessage` call, differing only in which string is
// substituted into it — see cli.ts), and "timeout" classification itself is
// already covered directly by isTimeoutError's own unit tests in
// generation.test.ts. The "error" test above proves the wiring; this note
// documents why "timeout" isn't separately forced end-to-end here.
