/**
 * Pre-commit hook install/remove/chain and the staged check.
 * GOVERNED BY: §13.1, §13.2, §13.3, §13.4
 *
 * The git-commit trigger was explicitly REJECTED as a capture mechanism (§13.1).
 * It is used only here, as an enforcement lever.
 *
 * The hook body invokes `grasp __precommit` rather than inlining logic, so hook
 * behavior updates with the package instead of going stale in every repo the
 * user ever ran `grasp init` in (§13.2).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { findQuestionsForFiles, type QuestionRow } from "../storage/models/questions.js";
import { isExpired } from "../review/queue.js";
import { pathsEqual, toPosix } from "../util/paths.js";

/** §13.2 — how Grasp recognizes its own hook and never clobbers a foreign one. */
export const HOOK_MARKER = "# grasp-managed-hook v1";
export const FOREIGN_HOOK_SUFFIX = ".pre-grasp";

export function hookPath(repoRoot: string): string {
  return path.join(repoRoot, ".git", "hooks", "pre-commit");
}

export function foreignHookPath(repoRoot: string): string {
  return `${hookPath(repoRoot)}${FOREIGN_HOOK_SUFFIX}`;
}

/**
 * §13.2 — the chained foreign hook runs FIRST and its non-zero exit
 * short-circuits: the foreign hook wins, and Grasp only runs if it passed.
 */
export function renderHook(hasForeign: boolean): string {
  const chain = hasForeign
    ? `
# A hook already existed here; it runs first and its failure wins.
if [ -x "$0${FOREIGN_HOOK_SUFFIX}" ]; then
  "$0${FOREIGN_HOOK_SUFFIX}" "$@" || exit $?
fi
`
    : "";
  return `#!/bin/sh
${HOOK_MARKER}
${chain}
exec grasp __precommit
`;
}

export function isGraspHook(contents: string): boolean {
  return contents.includes(HOOK_MARKER);
}

export interface InstallHookResult {
  installed: boolean;
  chainedForeign: boolean;
  alreadyInstalled: boolean;
}

export function installHook(repoRoot: string): InstallHookResult {
  const target = hookPath(repoRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  let chainedForeign = fs.existsSync(foreignHookPath(repoRoot));

  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, "utf8");
    // §13.2 — recognize our own and do not double-install.
    if (isGraspHook(existing)) {
      return { installed: true, chainedForeign, alreadyInstalled: true };
    }
    // A foreign hook is preserved, never clobbered.
    fs.renameSync(target, foreignHookPath(repoRoot));
    chainedForeign = true;
  }

  fs.writeFileSync(target, renderHook(chainedForeign), { mode: 0o755 });
  fs.chmodSync(target, 0o755);
  return { installed: true, chainedForeign, alreadyInstalled: false };
}

/** §13.2 — delete Grasp's hook and restore the original exactly. */
export function removeHook(repoRoot: string): { removed: boolean; restoredForeign: boolean } {
  const target = hookPath(repoRoot);
  let removed = false;

  if (fs.existsSync(target)) {
    // Never delete a hook that is not ours.
    if (!isGraspHook(fs.readFileSync(target, "utf8"))) {
      return { removed: false, restoredForeign: false };
    }
    fs.rmSync(target, { force: true });
    removed = true;
  }

  const foreign = foreignHookPath(repoRoot);
  if (fs.existsSync(foreign)) {
    fs.renameSync(foreign, target);
    fs.chmodSync(target, 0o755);
    return { removed, restoredForeign: true };
  }
  return { removed, restoredForeign: false };
}

export type GitRunner = (repoRoot: string, args: string[]) => Promise<string>;

/** §7.4 — execFile with an argv array. */
export const defaultGitRunner: GitRunner = (repoRoot, args) =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd: repoRoot, timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        resolve(error ? "" : String(stdout));
      },
    );
  });

/**
 * §13.3 — git emits POSIX-style, repo-relative paths on ALL platforms including
 * Windows, so both sides normalize through util/paths.ts.
 */
export async function stagedFiles(
  repoRoot: string,
  run: GitRunner = defaultGitRunner,
): Promise<string[]> {
  const output = await run(repoRoot, ["diff", "--staged", "--name-only"]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => toPosix(line));
}

export interface BlockingQuestion {
  question: QuestionRow;
  files: string[];
}

export interface GateCheckOptions {
  staleDays: number | null;
  now?: Date;
}

/**
 * The questions that block THIS commit: pending, non-expired, and attached to a
 * file actually staged (§13.3). A stale question about an unrelated file from
 * three weeks ago must not block an unrelated commit.
 */
export function questionsBlockingCommit(
  db: DatabaseSync,
  projectId: number,
  staged: string[],
  options: GateCheckOptions,
): BlockingQuestion[] {
  if (staged.length === 0) return [];
  const now = options.now ?? new Date();

  const candidates = findQuestionsForFiles(db, projectId, staged);
  return (
    candidates
      // §14.3 — expired questions are excluded from the gate entirely.
      .filter((question) => !isExpired(question, options.staleDays, now))
      .map((question) => {
        const attached = db
          .prepare("SELECT file_path FROM question_files WHERE question_id = ?")
          .all(question.id)
          .map((row) => (row as { file_path: string }).file_path);
        return {
          question,
          // Only the staged ones, matched under the platform's case rules (§16.4).
          files: attached.filter((file) => staged.some((s) => pathsEqual(s, file))),
        };
      })
      .filter((entry) => entry.files.length > 0)
  );
}

const TRUNCATE_AT = 60;

/** §13.4 — name what is blocking, one next action, `--no-verify` stated neutrally. */
export function renderBlockedMessage(blocking: BlockingQuestion[]): string {
  const lines = [
    "Grasp: commit blocked (hard gate)",
    "",
    `${blocking.length} unanswered comprehension question${blocking.length === 1 ? "" : "s"} on files in this commit:`,
  ];

  for (const entry of blocking) {
    const file = entry.files[0];
    if (entry.question.type === "synthesis") {
      // Synthesis checkpoints read differently from ordinary questions.
      lines.push(`  • ${file} — synthesis checkpoint: ${entry.question.concept_tag ?? "unknown"}`);
    } else {
      const text = entry.question.question_text.replace(/\s+/g, " ").trim();
      const truncated = text.length > TRUNCATE_AT ? `${text.slice(0, TRUNCATE_AT)}...` : text;
      lines.push(`  • ${file} — "${truncated}"`);
    }
  }

  lines.push(
    "",
    "Run `grasp review` to answer them, then commit again.",
    // Stated plainly, without shame framing. Grasp does not detect, log, count,
    // or defeat the bypass (§13.4).
    "To skip Grasp for this commit: git commit --no-verify",
    "",
  );
  return lines.join("\n");
}
