/**
 * Spawnable fixture (not itself a test): opens the shared DB + repo given on
 * argv and runs exactly one `ClaudeCodeAdapter.checkAndCapture()` call, then
 * prints how many files it saw in the diff it got back. Used by
 * test/checkpointRace.test.ts to launch several real OS processes racing the
 * SAME checkpoint transition at once — the actual shape of the "overlapping
 * hooks" bug an independent test pass found (several `PostToolUse` firings
 * for near-simultaneous tool calls all reading the same stale checkpoint
 * before any of them advanced it).
 */
import { openStore } from "../../src/store";
import { ClaudeCodeAdapter } from "../../src/adapters/claudeCodeAdapter";

const dbPath = process.argv[2];
const repoPath = process.argv[3];
const sessionId = process.argv[4];
const promptId = process.argv[5];

const db = openStore(dbPath);
try {
  const adapter = new ClaudeCodeAdapter(db, sessionId, promptId, repoPath);
  // Real cli.ts calls this unconditionally on every hook firing before
  // dispatching by event name (see runInternalHook) — cc_turns must exist
  // before insertCapturedDiff's FK reference to it.
  adapter.ensureTurnStarted();
  const diff = adapter.checkAndCapture();
  process.stdout.write(JSON.stringify({ fileCount: diff.files.length }) + "\n");
} catch (err) {
  process.stderr.write(`FAIL: ${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  db.close();
}
