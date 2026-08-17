import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

/**
 * Isolation helpers shared by every e2e scenario. The one hard rule this
 * whole harness exists under (same as the prior manual retest pass, and
 * before that BUILD_PLAN.md's own verification steps): NOTHING here may
 * ever touch the real `~/.grasp` or `~/Desktop/grasp-test`. Every scenario
 * gets its own throwaway `$HOME` (so `os.homedir()`-derived paths in
 * src/paths.ts resolve somewhere disposable) and its own throwaway scratch
 * git repo(s), never shared across scenarios and never cleaned up into a
 * shared location.
 */

export const CLI_PATH = path.resolve(process.cwd(), "dist/cli.js");
export const MOCK_CLAUDE_DIR = path.resolve(process.cwd(), "test/fixtures/mock-claude");

const SCRATCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-e2e-"));

/** Every directory this harness has created this run, for the final cleanup audit. */
const createdDirs: string[] = [];

/**
 * Always realpath'd before returning — matching the existing pty test
 * suite's own established convention (see reviewAppPty.test.ts's `seedHome`
 * comment): on macOS, `os.tmpdir()` runs through a `/var` ->
 * `/private/var` symlink, and a real child process's own `process.cwd()`/
 * `os.homedir()` resolve through that symlink after spawning — an
 * un-resolved path stored anywhere that gets compared against what a
 * spawned `grasp` process itself resolves (repo scoping via
 * `resolveRepoRoot`, `os.homedir()`-derived paths, etc.) would silently
 * mismatch. Applying this once, here, means every caller — not just
 * `isolatedHome`/`initScratchRepo` below, but any scenario that mints a
 * scratch directory directly for use as a `repo` or `cwd` — gets it for
 * free, rather than needing to remember to realpath at each call site.
 */
export function mkTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH_ROOT, prefix)));
  createdDirs.push(dir);
  return dir;
}

/** A fresh, isolated `$HOME` for one scenario. */
export function isolatedHome(prefix = "grasp-e2e-home-"): string {
  return mkTempDir(prefix);
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** A fresh scratch git repo with user.name/email configured, ready for commits. */
export function initScratchRepo(prefix = "grasp-e2e-repo-"): string {
  const repo = mkTempDir(prefix);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "e2e@example.com"]);
  git(repo, ["config", "user.name", "Grasp E2E"]);
  return repo;
}

export function gitAdd(repo: string, ...paths: string[]): void {
  git(repo, ["add", ...(paths.length > 0 ? paths : ["-A"])]);
}

export function gitCommit(repo: string, message: string): void {
  git(repo, ["commit", "-q", "-m", message]);
}

export function writeFile(repo: string, relPath: string, content: string): void {
  const full = path.join(repo, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
}

/** Writes, `git add`s, and commits one file in a single step — the common case. */
export function commitFile(repo: string, relPath: string, content: string, message = `add ${relPath}`): void {
  writeFile(repo, relPath, content);
  gitAdd(repo, relPath);
  gitCommit(repo, message);
}

/**
 * `mode: "mock"` (the default for every scenario in a normal harness run)
 * prepends `test/fixtures/mock-claude` to PATH so `claude -p ...` resolves
 * to the deterministic, free, zero-network fixture already used throughout
 * this codebase's own test suite. `mode: "real"` leaves PATH untouched, so
 * whatever real `claude` binary is actually installed gets used instead —
 * this requires real auth and spends real cost/rate-limit headroom, so it
 * is never the default; it exists purely so a future run CAN opt into real,
 * unmocked generation via `GRASP_E2E_CLAUDE_MODE=real` without the harness
 * needing any code changes to support it (see the task brief's explicit
 * ask for this, and DECISIONS.md's "PTY e2e harness: mock vs. real claude"
 * entry for the reasoning).
 */
export type ClaudeMode = "mock" | "real";

export function claudeMode(): ClaudeMode {
  return process.env.GRASP_E2E_CLAUDE_MODE === "real" ? "real" : "mock";
}

export interface MockClaudeOptions {
  mode?: "normal" | "error" | "bad-json-result" | "brand-new-concept-no-question" | "invalid-tag-format" | "missing-cost" | "negative-cost";
  cost?: string;
  counterPath?: string;
  conceptTag?: string;
  delayMs?: number;
  argvLogPath?: string;
}

/**
 * Builds an env object for spawning `grasp` with the mock (or real,
 * per `claudeMode()`) `claude` on PATH. Every scenario that needs
 * generation to happen goes through this rather than touching
 * `process.env`/PATH directly, so isolation (HOME) and the mock/real
 * switch stay in one place.
 */
export function graspEnv(home: string, mock: MockClaudeOptions = {}, extra: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    // Forces chalk (used directly by ink and by ink-text-input's placeholder
    // rendering) to its plain, no-ANSI level regardless of what the HOST
    // terminal's own color-support detection would otherwise decide — see
    // DECISIONS.md's "PTY e2e harness: forcing color off for every scenario"
    // entry. This repo's chalk version (5.x) reads FORCE_COLOR, not
    // NO_COLOR (verified: its vendored supports-color detection has no
    // NO_COLOR handling at all) — set both anyway so a future chalk
    // upgrade or any other dependency that DOES honor NO_COLOR stays
    // covered too, but FORCE_COLOR=0 is the one actually load-bearing here.
    // Placed after the `...process.env` spread so it always wins over
    // whatever the outer shell happens to have set (including an inherited
    // FORCE_COLOR=1, which is exactly the condition that made this bug
    // reproduce here at all).
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };

  if (claudeMode() === "mock") {
    base.PATH = `${MOCK_CLAUDE_DIR}:${process.env.PATH}`;
    base.GRASP_TEST_MOCK_MODE = mock.mode ?? "normal";
    if (mock.cost) base.GRASP_TEST_MOCK_COST = mock.cost;
    if (mock.counterPath) base.GRASP_TEST_MOCK_COUNTER = mock.counterPath;
    if (mock.conceptTag) base.GRASP_TEST_MOCK_CONCEPT_TAG = mock.conceptTag;
    if (mock.delayMs) base.GRASP_TEST_MOCK_DELAY_MS = String(mock.delayMs);
    if (mock.argvLogPath) base.GRASP_TEST_MOCK_ARGV_LOG = mock.argvLogPath;
  }

  return { ...base, ...extra };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Recursively removes every scratch directory this process created, best-
 * effort (a locked/still-open sqlite file on some platforms can transiently
 * fail an rm — logged, not fatal, since these all live under the OS temp
 * dir and will be reaped on next reboot regardless). Called once at the
 * very end of the whole run (see runner.ts) — NOT after each scenario,
 * since several scenarios intentionally inspect a previous scenario's own
 * temp DB file path for debugging when a run fails; a single end-of-run
 * sweep is simpler to reason about and still guarantees nothing durable is
 * left behind.
 */
export function cleanupAllScratch(): { removed: number; failed: string[] } {
  let removed = 0;
  const failed: string[] = [];
  try {
    fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true, maxRetries: 3 });
    removed = createdDirs.length;
  } catch (err) {
    failed.push(`${SCRATCH_ROOT}: ${(err as Error).message}`);
  }
  return { removed, failed };
}

export function scratchRoot(): string {
  return SCRATCH_ROOT;
}
