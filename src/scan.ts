import * as fs from "fs";
import * as path from "path";
import * as React from "react";
import { randomUUID } from "crypto";
import { loadInk } from "./inkLoader";
import { listTrackedFiles, resolveRepoRoot } from "./git";
import { classifyIgnoreExclusion, isFileGenerated } from "./filter";
import { loadConfig } from "./config";
import { createReviewApp } from "./reviewApp";
import { groupForBatchPresentation } from "./review";
import { runScanFileGeneration } from "./generation";
import { DiffFile } from "./adapters/agentAdapter";
import {
  getPendingQuestions,
  getScannedFilePaths,
  getSessionCostUsd,
  getSessionQuestionCount,
  markConceptAnswered,
  markEventSkipped,
  markFileScanned,
  markInstanceAnswered,
  openStore,
} from "./store";

/**
 * `grasp scan` — reads through EXISTING, unfamiliar code and asks the same
 * concept/instance comprehension questions the diff side already asks about
 * AI-agent changes, but about code that was already there. A deliberate
 * extension beyond the original brief's scope (onboarding to existing code,
 * not comprehension of agent-made changes) — see DECISIONS.md's `grasp
 * scan` entries for the full design reasoning behind everything in this
 * file. Fully standalone: no Claude Code hook payload, no live session
 * required, and (via a fresh synthetic `session_id` per run) fully isolated
 * from any live session's own `questionsPerSessionCap`.
 */

/** Skip a file's content entirely past this many lines — there is no diffThresholds equivalent for scan (deliberately, per the task's own instruction); this is a separate, hardcoded, non-configurable safety guard. See DECISIONS.md's "grasp scan: file-walk source, ordering, capping, and resumability" entry. */
const MAX_SCAN_FILE_LINES = 2000;

/** How many bytes from the start of a file are sniffed for a NUL byte to decide "this is binary, not source code" — cheap and reliable enough for a defensive pre-generation guard, not a full content-type detector. */
const BINARY_SNIFF_BYTES = 8192;

function looksBinary(buffer: Buffer): boolean {
  const sniffLength = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < sniffLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Wraps a whole-file path in a hunk-less `DiffFile` so `isFileGenerated`
 * (filter.ts) can be reused directly rather than reimplemented — its
 * diff-hunk-walking half (`isFileGeneratedFromDiff`) is a guaranteed no-op
 * on an empty `hunks` array, so the combined check correctly reduces to
 * exactly the disk-header read (`isFileGeneratedOnDisk`) that makes sense
 * for a whole untouched file. See DECISIONS.md's "grasp scan: file-walk
 * source..." entry.
 */
function toWholeFileDiffFile(relPath: string): DiffFile {
  return { path: relPath, oldPath: null, status: "modified", insertions: 0, deletions: 0, hunks: [] };
}

/**
 * Groups `paths` by each path's top-level directory segment (the part
 * before the first `/`; a root-level file gets its own `"."` group), then
 * round-robin-interleaves across groups — one file from each group in turn,
 * cycling — rather than exhausting one folder before moving to the next.
 * Purely mechanical, no file I/O or judge calls, so a capped run's budget
 * naturally spreads across the repo instead of being able to land entirely
 * inside whichever directory happens to sort first. Exported for direct
 * testing. See DECISIONS.md's "grasp scan: file-walk source, ordering,
 * capping, and resumability" entry.
 */
export function orderFilesRoundRobin(paths: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const slash = p.indexOf("/");
    const key = slash === -1 ? "." : p.slice(0, slash);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }
  const groupKeys = Array.from(groups.keys()).sort();
  for (const key of groupKeys) groups.get(key)!.sort();

  const result: string[] = [];
  const cursors = new Map(groupKeys.map((k) => [k, 0]));
  let anyLeft = true;
  while (anyLeft) {
    anyLeft = false;
    for (const key of groupKeys) {
      const list = groups.get(key)!;
      const cursor = cursors.get(key)!;
      if (cursor < list.length) {
        result.push(list[cursor]);
        cursors.set(key, cursor + 1);
        anyLeft = true;
      }
    }
  }
  return result;
}

/**
 * Reads and mechanically evaluates one file, either calling
 * `runScanFileGeneration` or skipping it — and either way, decides whether
 * to mark the file scanned. A successful attempt (real question, legitimate
 * decline, or a mechanical skip with nothing to learn — ignored, generated,
 * binary, too large) marks the file scanned permanently. A failed judge
 * call (`error`/`timeout`) leaves it unscanned for retry on a later run,
 * the same "successful vs. failed attempt" distinction the diff side's
 * batched-at-Stop redesign already established.
 */
function processOneFile(
  db: ReturnType<typeof openStore>,
  repoRoot: string,
  sessionId: string,
  config: ReturnType<typeof loadConfig>["config"],
  filePath: string
): void {
  const ignoreReason = classifyIgnoreExclusion(filePath, config);
  if (ignoreReason) {
    markFileScanned(db, repoRoot, filePath);
    return;
  }
  if (isFileGenerated(toWholeFileDiffFile(filePath), repoRoot)) {
    markFileScanned(db, repoRoot, filePath);
    return;
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(path.join(repoRoot, filePath));
  } catch {
    // Unreadable (permissions, a symlink to nowhere, deleted between the
    // walk listing and now) — nothing productive to retry here.
    markFileScanned(db, repoRoot, filePath);
    return;
  }

  if (looksBinary(buffer)) {
    markFileScanned(db, repoRoot, filePath);
    return;
  }

  const fileLines = buffer.toString("utf-8").split(/\r\n|\r|\n/);
  if (fileLines.length > MAX_SCAN_FILE_LINES) {
    markFileScanned(db, repoRoot, filePath);
    return;
  }

  const outcome = runScanFileGeneration(db, { sessionId, repo: repoRoot, filePath, fileLines, config });
  if (outcome.missReason === null) {
    markFileScanned(db, repoRoot, filePath);
  }
  // missReason "error"/"timeout": deliberately left unscanned — retried on
  // a later `grasp scan` run, combined with whatever else is still unscanned.
}

function pluralQuestions(n: number): string {
  return `${n} question${n === 1 ? "" : "s"}`;
}

export interface ScanWalkResult {
  filesWalked: number;
  /** True if `scanQuestionsCap` stopped the walk before it reached the end of `orderedUnscanned` — never true when `full` is passed. */
  capped: boolean;
}

/**
 * The file-walk itself — capping, per-file processing, resumability
 * tracking — with no dependency on a terminal or the review UI, so it's
 * directly testable on its own. `runScan` below is a thin wrapper that adds
 * the interactive TTY requirement, upfront file listing/ordering, and
 * live presentation around this.
 */
export function runScanWalk(
  db: ReturnType<typeof openStore>,
  repoRoot: string,
  sessionId: string,
  config: ReturnType<typeof loadConfig>["config"],
  orderedUnscanned: string[],
  full: boolean
): ScanWalkResult {
  let filesWalked = 0;
  for (const filePath of orderedUnscanned) {
    if (!full && getSessionQuestionCount(db, sessionId) >= config.scanQuestionsCap) {
      return { filesWalked, capped: true };
    }
    processOneFile(db, repoRoot, sessionId, config, filePath);
    filesWalked++;
  }
  return { filesWalked, capped: false };
}

/**
 * `grasp scan [--full]`. See this file's module doc comment and
 * DECISIONS.md's `grasp scan` entries for the full design.
 */
export async function runScan(options: { full?: boolean } = {}): Promise<void> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "grasp scan needs an interactive terminal (stdin is not a TTY) — run it directly in a terminal, not piped or scripted.\n"
    );
    process.exitCode = 1;
    return;
  }

  const repoRoot = resolveRepoRoot(process.cwd());
  const { config } = loadConfig(repoRoot);
  const db = openStore();

  const allTracked = listTrackedFiles(repoRoot);
  const scannedSet = getScannedFilePaths(db, repoRoot);
  const unscanned = allTracked.filter((f) => !scannedSet.has(f));

  if (unscanned.length === 0) {
    const pendingScan = getPendingQuestions(db, repoRoot, "scan");
    if (pendingScan.length === 0) {
      process.stdout.write(
        "Nothing left to scan — every tracked file in this repo has already been scanned. Run `grasp reset history` if you want to scan from scratch.\n"
      );
      db.close();
      return;
    }
    // Nothing NEW to walk, but there's a leftover pending batch from an
    // earlier interrupted run — skip straight to presenting it below.
  } else if (options.full) {
    process.stdout.write(
      "⚠ --full bypasses the question cap entirely — this will scan the whole remaining codebase and could generate a large number of questions (real LLM calls, same cost/rate-limit usage as any other generation). Proceeding...\n"
    );
  } else {
    process.stdout.write(
      `Scanning up to ${config.scanQuestionsCap} question${config.scanQuestionsCap === 1 ? "" : "s"}' worth of files (${unscanned.length} unscanned file${unscanned.length === 1 ? "" : "s"} remaining)...\n`
    );
  }

  const sessionId = `scan-${randomUUID()}`;
  const ordered = orderFilesRoundRobin(unscanned);
  runScanWalk(db, repoRoot, sessionId, config, ordered, Boolean(options.full));

  const spentSoFar = getSessionCostUsd(db, sessionId);
  if (spentSoFar > 0) {
    process.stdout.write(`$${spentSoFar.toFixed(4)} spent generating comprehension questions this scan.\n`);
  }

  const pending = getPendingQuestions(db, repoRoot, "scan");
  if (pending.length === 0) {
    process.stdout.write("No scan questions right now — you're caught up for what's been looked at so far.\n");
    db.close();
    return;
  }

  const items = groupForBatchPresentation(pending);

  // Cross-hint (§5): point at `grasp review` if it has unresolved diff
  // questions of its own for this repo — same pattern as review.ts's own
  // hint back at `grasp scan`.
  const diffPendingCount = getPendingQuestions(db, repoRoot, "diff").length;
  const crossSourceHint =
    diffPendingCount > 0
      ? `→ ${pluralQuestions(diffPendingCount)} from your Claude Code sessions also pending — run \`grasp review\` to continue.`
      : null;

  const { ink, TextInput } = await loadInk();
  const App = createReviewApp({ ink, TextInput });

  const instance = ink.render(
    React.createElement(App, {
      items,
      crossSourceHint,
      onResolved: (eventId: number, outcome: { conceptAnswer: string | null; instanceAnswer: string | null }) => {
        if (outcome.conceptAnswer !== null) {
          markConceptAnswered(db, eventId, outcome.conceptAnswer);
        }
        if (outcome.instanceAnswer !== null) {
          markInstanceAnswered(db, eventId, outcome.instanceAnswer);
        } else {
          markEventSkipped(db, eventId);
        }
      },
    })
  );

  await instance.waitUntilExit();
  db.close();
}
