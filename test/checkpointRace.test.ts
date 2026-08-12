import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { spawn } from "child_process";
import Database from "better-sqlite3";
import { openStore } from "../src/store";
import { ClaudeCodeAdapter } from "../src/adapters/claudeCodeAdapter";
import { loadConfig } from "../src/config";
import { runBatchGeneration } from "../src/generation";

/**
 * Regression test for the "overlapping hooks duplicate one edit" bug an
 * independent test pass found: eight simultaneous `PostToolUse` firings for
 * the same checkpoint transition each read the same stale checkpoint before
 * any of them advanced it, so all eight captured the identical diff. (The
 * original report also found this meant "all eight paid to generate a
 * question about it" — that's no longer possible even in principle, since
 * `checkAndCapture` doesn't call generation at all anymore; see
 * DECISIONS.md's "Batched-at-Stop generation" entry. This test now checks
 * capture-uniqueness directly via `checkAndCapture`, then separately
 * simulates the single `Stop`-triggered batch attempt that would follow in
 * real usage and confirms IT produces exactly one question, not one per
 * racing process.) Reproduces the bug shape for real — several separate OS
 * processes racing one real git repo + one shared SQLite file — not a
 * single-process simulation, matching the style already established in
 * test/concurrency.test.ts.
 */

const WORKER_COUNT = 8;
const FIXTURE_PATH = path.resolve(process.cwd(), "test-dist/test/fixtures/checkpointRaceWorker.js");
const FIXTURE_CLAUDE_DIR = path.resolve(process.cwd(), "test/fixtures/mock-claude");

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepoWithCommit(): string {
  const repo = mkTempDir("grasp-test-race-repo-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "app.ts"), "export function original() {\n  return 1;\n}\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  return repo;
}

function runWorker(
  dbPath: string,
  repoPath: string,
  sessionId: string,
  promptId: string,
  env: Record<string, string>
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE_PATH, dbPath, repoPath, sessionId, promptId], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test(
  "checkAndCapture: N processes racing the same checkpoint transition capture and pay for it exactly once",
  { timeout: 30_000 },
  async () => {
    assert.ok(
      fs.existsSync(FIXTURE_PATH),
      `compiled fixture not found at ${FIXTURE_PATH} — run \`npm test\` (which builds test-dist first)`
    );

    const repo = initRepoWithCommit();
    const dbDir = mkTempDir("grasp-test-race-db-");
    const dbPath = path.join(dbDir, "history.db");
    const sessionId = "race-session";
    const promptId = "race-prompt";

    // Seed the baseline BEFORE the edit, exactly like a real PreToolUse
    // firing would (see ClaudeCodeAdapter.ensureCheckpointSeeded's own doc
    // comment for why seeding must happen before the tool call that
    // introduces the change being captured).
    const seedDb = openStore(dbPath);
    new ClaudeCodeAdapter(seedDb, sessionId, promptId, repo).ensureCheckpointSeeded();
    seedDb.close();

    // A real, meaningful, above-threshold edit — enough lines that it would
    // pass Phase 4's mechanical filter and reach generation.
    fs.writeFileSync(
      path.join(repo, "app.ts"),
      "export function original() {\n  return 1;\n}\n\nexport function addedByAgent() {\n  return 2;\n}\n"
    );

    const counterPath = path.join(dbDir, "mock-claude-counter.txt");
    const env = {
      PATH: `${FIXTURE_CLAUDE_DIR}:${process.env.PATH}`,
      GRASP_TEST_MOCK_MODE: "normal",
      GRASP_TEST_MOCK_COST: "0.001",
      GRASP_TEST_MOCK_COUNTER: counterPath,
    };

    // Launched without awaiting between them, so all WORKER_COUNT processes
    // race the exact same checkpoint transition, matching the "eight
    // simultaneous hooks" shape the original bug report reproduced.
    const results = await Promise.all(
      Array.from({ length: WORKER_COUNT }, () => runWorker(dbPath, repo, sessionId, promptId, env))
    );

    const failures = results.filter((r) => r.code !== 0);
    if (failures.length > 0) {
      assert.fail(`${failures.length}/${WORKER_COUNT} worker processes failed:\n` + failures.map((f) => f.stderr.trim()).join("\n"));
    }

    // Exactly one worker should have seen the real diff (2 new lines);
    // every other worker must have seen an empty diff (already claimed).
    const nonEmpty = results.filter((r) => JSON.parse(r.stdout.trim()).fileCount > 0);
    assert.equal(
      nonEmpty.length,
      1,
      `expected exactly 1 worker to claim the transition and see a non-empty diff, got ${nonEmpty.length}`
    );

    const captureCheckDb = new Database(dbPath, { readonly: true });
    const capturedRows = captureCheckDb
      .prepare(`SELECT COUNT(*) AS n FROM captured_diffs WHERE session_id = ? AND filtered = 0`)
      .get(sessionId) as { n: number };
    captureCheckDb.close();
    assert.equal(capturedRows.n, 1, "the diff must be captured exactly once, not once per racing process");

    // Real usage never calls generation from PostToolUse/checkAndCapture
    // anymore — it's batched at the next `Stop` firing (see this file's own
    // header comment). Simulate exactly that single Stop-triggered attempt
    // here, in this process, against the same shared DB the racing workers
    // just wrote to. Unlike the workers above (spawned with their own `env`
    // object), this call shells out to `claude` using THIS process's own
    // `process.env`, so the mock claude PATH/mode must be set here directly.
    const originalPath = process.env.PATH;
    process.env.PATH = `${FIXTURE_CLAUDE_DIR}:${originalPath}`;
    process.env.GRASP_TEST_MOCK_MODE = "normal";
    process.env.GRASP_TEST_MOCK_COST = "0.001";
    process.env.GRASP_TEST_MOCK_COUNTER = path.join(dbDir, "mock-claude-counter-stop.txt");
    try {
      const genDb = openStore(dbPath);
      const { config } = loadConfig(repo);
      runBatchGeneration(genDb, { sessionId, repo, config });
      genDb.close();
    } finally {
      process.env.PATH = originalPath;
      delete process.env.GRASP_TEST_MOCK_MODE;
      delete process.env.GRASP_TEST_MOCK_COST;
      delete process.env.GRASP_TEST_MOCK_COUNTER;
    }

    const db = new Database(dbPath, { readonly: true });
    const eventRows = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND question_type IS NOT NULL`)
      .get(sessionId) as { n: number };
    const totalCost = db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM events WHERE session_id = ?`)
      .get(sessionId) as { total: number };
    db.close();

    assert.equal(eventRows.n, 1, "exactly one real question must be generated by the single batch attempt");
    assert.ok(
      totalCost.total < 0.002,
      `expected roughly one call's worth of spend (~0.001), got ${totalCost.total} — duplicate claude calls would multiply this`
    );
  }
);
