import * as fs from "fs";
import * as path from "path";
import * as React from "react";
import { randomUUID, createHash } from "crypto";
import { loadInk } from "./inkLoader";
import { listTrackedFiles, resolveRepoRoot } from "./git";
import { classifyIgnoreExclusion, evaluateCapturedDiff, isFileGenerated } from "./filter";
import { loadConfig } from "./config";
import { createReviewApp } from "./reviewApp";
import { groupForBatchPresentation } from "./review";
import { runScanFileGeneration } from "./generation";
import { diffFileContents } from "./adapters/gitDiffCapture";
import { CapturedDiff, DiffFile } from "./adapters/agentAdapter";
import { FileChunk, splitFileIntoChunks } from "./scanChunking";
import {
  deleteScanProgressForFile,
  getPendingQuestions,
  getScanCompletedFilePaths,
  getScanFileHash,
  getScannedChunkIndexes,
  getSessionCostUsd,
  getSessionQuestionCount,
  markChunkScanned,
  markConceptAnswered,
  markEventSkipped,
  markInstanceAnswered,
  openStore,
  upsertScanFileHash,
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
 *
 * Large files are split into sequential chunks (see `scanChunking.ts`) so a
 * big file gets proportionally more chances at a question rather than the
 * old "one shot, forever" per-file treatment — see DECISIONS.md's "grasp
 * scan: chunking for large files" entry for the full redesign this file
 * implements.
 */

/**
 * Purely defensive ceiling, replacing the old MAX_SCAN_FILE_LINES (2000) —
 * chunking now handles arbitrarily large legitimate source files, so this
 * only exists to refuse pathological cases (a vendored dump, a minified
 * bundle that slipped past .gitignore) rather than to bound normal chunking.
 * See DECISIONS.md's "grasp scan: chunking for large files" entry for why
 * 20,000.
 */
const MAX_SCAN_CEILING_LINES = 20_000;

/**
 * A separate, smaller practical limit on what `scan_file_hashes` bothers
 * storing/diffing — distinct from `MAX_SCAN_CEILING_LINES` above, which
 * governs whether a file gets CHUNKED at all. `scan_file_hashes` stores a
 * full second COPY of a file's content (see that table's own schema
 * comment for why: a hash alone can tell you something changed but not
 * what), so tracking every file up to the much larger chunking ceiling
 * would mean the database could end up holding a near-duplicate of a
 * large fraction of a big repo's entire source tree. Files over this limit
 * still get scanned/chunked completely normally — they just don't get
 * hash-based re-scan tracking, so once fully covered they keep the
 * original, permanent "never revisited" behavior chunking already had. See
 * DECISIONS.md's "grasp scan: hash-based re-scan" entry for the reasoning
 * behind 5,000.
 */
const MAX_SCAN_HASH_TRACKING_LINES = 5_000;

function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

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
 * testing. Unchanged by chunking (Prompt 8) — it still orders whole FILES;
 * `runScanWalk` below is what advances each file one CHUNK per pass through
 * this order. See DECISIONS.md's "grasp scan: file-walk source, ordering,
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

export interface OversizedSkip {
  filePath: string;
  lineCount: number;
}

/**
 * Per-file, per-run walk state — classified lazily, the first time a file
 * comes up in the round-robin order, so a file whose turn never comes (the
 * cap was hit first) is never even read off disk. `chunks: null` means the
 * file was mechanically resolved (ignored/generated/unreadable/binary/
 * oversized) rather than really chunked — it's already `done` the moment
 * it's classified, with a single chunk_index=0 progress row marking it.
 *
 * `done` and `stuckThisRun` are deliberately separate: `done` means the
 * file's walk is genuinely, permanently complete (DB-true — every chunk has
 * a progress row). `stuckThisRun` means one chunk's generation attempt
 * FAILED (error/timeout) this walk — that chunk is left unmarked for retry
 * on a later `grasp scan` run (matching the pre-chunking behavior a failed
 * whole-file attempt already had), and this file isn't reattempted again
 * within the SAME walk invocation (no immediate same-run retry loop), but
 * it is very much not `done`. Conflating the two would either retry a
 * failing chunk forever within one run, or — worse — advance past it to a
 * LATER chunk index whose own success would leave a gap in `scan_progress`
 * (chunk N missing, chunk N+1 present), breaking the "resume from the
 * smallest unscanned index" assumption `classifyFile` relies on.
 */
interface FileWalkState {
  chunks: FileChunk[] | null;
  totalFileLines: number;
  nextChunkCursor: number;
  done: boolean;
  stuckThisRun: boolean;
  /** The file's full current content, for hash-based re-scan tracking (see `MAX_SCAN_HASH_TRACKING_LINES`) — null for mechanically-skipped files (hash tracking only applies to files that actually go through chunked generation, see DECISIONS.md's "grasp scan: hash-based re-scan" entry). */
  wholeFileContent: string | null;
}

/**
 * Reads and mechanically classifies one file the first time the walk visits
 * it: ignore pattern / generated-file detection (no content read), then
 * unreadable / binary / over-the-defensive-ceiling (each requires reading
 * the file once). Any of these mechanically resolves the file in one step —
 * a single `chunk_index=0`, `is_final_chunk=1` progress row, matching the
 * same permanence every other skip category already had before chunking.
 * Otherwise splits the file into chunks (`scanChunking.ts`) and resumes
 * from whatever chunk index isn't already recorded for it (a partially
 * covered multi-chunk file from an earlier run).
 */
function classifyFile(
  db: ReturnType<typeof openStore>,
  repoRoot: string,
  config: ReturnType<typeof loadConfig>["config"],
  filePath: string,
  oversizedSkips: OversizedSkip[]
): FileWalkState {
  const markFullyDone = () => markChunkScanned(db, repoRoot, filePath, 0, true);

  const ignoreReason = classifyIgnoreExclusion(filePath, config);
  if (ignoreReason) {
    markFullyDone();
    return { chunks: null, totalFileLines: 0, nextChunkCursor: 0, done: true, stuckThisRun: false, wholeFileContent: null };
  }
  if (isFileGenerated(toWholeFileDiffFile(filePath), repoRoot)) {
    markFullyDone();
    return { chunks: null, totalFileLines: 0, nextChunkCursor: 0, done: true, stuckThisRun: false, wholeFileContent: null };
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(path.join(repoRoot, filePath));
  } catch {
    // Unreadable (permissions, a symlink to nowhere, deleted between the
    // walk listing and now) — nothing productive to retry here.
    markFullyDone();
    return { chunks: null, totalFileLines: 0, nextChunkCursor: 0, done: true, stuckThisRun: false, wholeFileContent: null };
  }

  if (looksBinary(buffer)) {
    markFullyDone();
    return { chunks: null, totalFileLines: 0, nextChunkCursor: 0, done: true, stuckThisRun: false, wholeFileContent: null };
  }

  const fileLines = buffer.toString("utf-8").split(/\r\n|\r|\n/);
  if (fileLines.length > MAX_SCAN_CEILING_LINES) {
    oversizedSkips.push({ filePath, lineCount: fileLines.length });
    markFullyDone();
    return { chunks: null, totalFileLines: 0, nextChunkCursor: 0, done: true, stuckThisRun: false, wholeFileContent: null };
  }

  const chunks = splitFileIntoChunks(fileLines);
  const alreadyScanned = getScannedChunkIndexes(db, repoRoot, filePath);
  let cursor = 0;
  while (cursor < chunks.length && alreadyScanned.has(cursor)) cursor++;

  return {
    chunks,
    totalFileLines: fileLines.length,
    nextChunkCursor: cursor,
    done: cursor >= chunks.length,
    stuckThisRun: false,
    wholeFileContent: buffer.toString("utf-8"),
  };
}

/**
 * Records the content/hash a file was just fully processed at — called the
 * moment a file's walk completes under the chunked walk (see the caller in
 * `runScanWalk`). A no-op for files over `MAX_SCAN_HASH_TRACKING_LINES` —
 * see that constant's own comment for why.
 */
function recordFileHashIfTrackable(
  db: ReturnType<typeof openStore>,
  repoRoot: string,
  filePath: string,
  content: string,
  totalFileLines: number
): void {
  if (totalFileLines > MAX_SCAN_HASH_TRACKING_LINES) return;
  upsertScanFileHash(db, repoRoot, filePath, computeContentHash(content), content);
}

/**
 * `grasp scan`'s hash-based re-scan check (Prompt 9) — called once per
 * already-fully-covered file, before it's filtered out of this run's
 * candidate list, to decide whether it needs to re-enter the walk. Whole-
 * file hashing, not per-chunk, DELIBERATELY: chunk boundaries are
 * position-based, so an edit near the top of a file shifts every later
 * chunk's boundaries, making unrelated later chunks falsely look "changed"
 * if compared chunk-by-chunk — see DECISIONS.md's "grasp scan: hash-based
 * re-scan" entry.
 *
 * Returns `true` when the file must re-enter the walk (a real, non-trivial
 * change was found and its stale chunk coverage was just cleared) —
 * `false` in every other case (no hash on record yet, unreadable, over the
 * hash-tracking size limit, unchanged, or a real-but-trivial change that
 * was absorbed by just updating the stored hash/content).
 *
 * Exported for direct testing, same rationale as `orderFilesRoundRobin`/
 * `runScanWalk` above — `runScan` itself needs a real TTY and isn't a
 * practical unit-test surface.
 */
export function checkForFileEdits(
  db: ReturnType<typeof openStore>,
  repoRoot: string,
  config: ReturnType<typeof loadConfig>["config"],
  filePath: string
): boolean {
  const stored = getScanFileHash(db, repoRoot, filePath);
  if (!stored) return false;

  let currentContent: string;
  try {
    currentContent = fs.readFileSync(path.join(repoRoot, filePath), "utf-8");
  } catch {
    // Deleted/unreadable since it was last scanned — nothing productive to
    // diff against; leave its existing coverage exactly as it is.
    return false;
  }

  const currentLineCount = currentContent.split(/\r\n|\r|\n/).length;
  if (currentLineCount > MAX_SCAN_HASH_TRACKING_LINES) return false;

  const currentHash = computeContentHash(currentContent);
  if (currentHash === stored.contentHash) return false;

  // Hash differs — compute a real diff and run it through the SAME
  // mechanical filter the live diff-capture path uses, per the task's own
  // explicit instruction, rather than inventing scan-specific thresholds.
  const { insertions, deletions, hunks } = diffFileContents(repoRoot, stored.content, currentContent);
  const syntheticDiff: CapturedDiff = {
    repo: repoRoot,
    capturedAt: new Date().toISOString(),
    files: [{ path: filePath, oldPath: null, status: "modified", insertions, deletions, hunks }],
    rawDiffText: "",
    diffHash: null,
  };
  const verdict = evaluateCapturedDiff(syntheticDiff, config);

  if (!verdict.passed) {
    // A real difference, but the filter judges it trivial (formatting-only,
    // now-ignored, now-generated, etc.) — absorb it without reprocessing.
    upsertScanFileHash(db, repoRoot, filePath, currentHash, currentContent);
    return false;
  }

  // A real, non-trivial change — clear stale chunk coverage and update the
  // stored hash/content IMMEDIATELY (not after the re-walk completes: see
  // DECISIONS.md's "grasp scan: hash-based re-scan" entry for why this
  // keeps the model simple and always accurate about current state, even
  // though it doesn't perfectly protect an in-progress catch-up from an
  // overlapping second edit). The file re-enters the walk from chunk 0 the
  // moment this returns, simply by no longer appearing in
  // getScanCompletedFilePaths.
  deleteScanProgressForFile(db, repoRoot, filePath);
  upsertScanFileHash(db, repoRoot, filePath, currentHash, currentContent);
  return true;
}

/**
 * Runs one real generation call scoped to exactly this chunk's lines — same
 * concept-tag memoization rules as every other call (global, per
 * `getAllAnsweredConceptTags`), just applied at chunk granularity instead
 * of whole-file. Marks the chunk scanned only on a genuine outcome (a real
 * question or a legitimate decline) — a failed/timed-out attempt leaves it
 * unmarked, retried on a later `grasp scan` run from this same chunk index.
 */
function processOneChunk(
  db: ReturnType<typeof openStore>,
  repoRoot: string,
  sessionId: string,
  config: ReturnType<typeof loadConfig>["config"],
  filePath: string,
  chunk: FileChunk,
  totalFileLines: number
): boolean {
  const outcome = runScanFileGeneration(db, {
    sessionId,
    repo: repoRoot,
    filePath,
    fileLines: chunk.lines,
    config,
    baseLineNumber: chunk.startLine,
    totalFileLines,
  });
  if (outcome.missReason === null) {
    markChunkScanned(db, repoRoot, filePath, chunk.chunkIndex, chunk.isFinal);
    return true;
  }
  return false;
}

function pluralQuestions(n: number): string {
  return `${n} question${n === 1 ? "" : "s"}`;
}

export interface ScanWalkResult {
  /** Real generation calls made this walk (one per chunk actually processed) — the unit `scanQuestionsCap`-style capping and Prompt 10's run summary both care about, distinct from `filesTouched` now that one file can span many chunks. */
  chunksProcessed: number;
  /** Distinct files with at least one chunk processed OR mechanically resolved this walk. */
  filesTouched: number;
  /** True if `scanQuestionsCap` stopped the walk before it reached the end of `orderedCandidates` — never true when `full` is passed. */
  capped: boolean;
  /** Files skipped for being over MAX_SCAN_CEILING_LINES this walk — `runScan` prints a visible message for each. */
  oversizedSkips: OversizedSkip[];
}

/**
 * The file-walk itself — capping, chunk-granularity round-robin, per-chunk
 * processing, resumability tracking — with no dependency on a terminal or
 * the review UI, so it's directly testable on its own. `runScan` below is a
 * thin wrapper that adds the interactive TTY requirement, upfront file
 * listing/ordering, and live presentation around this.
 *
 * `orderedCandidates` is the round-robin FILE order from
 * `orderFilesRoundRobin` — this function is what turns that into
 * chunk-granularity interleaving: each pass over the full order advances
 * every file that still has remaining chunks by exactly one chunk, and
 * files are classified (read, and either mechanically resolved or split
 * into chunks) lazily, the first time their turn comes up — never upfront
 * for the whole candidate list, so a file the cap never reaches is never
 * read at all. Repeats passes until the cap is hit (unless `full`) or no
 * pass makes any further progress (everything either mechanically resolved
 * or chunk-exhausted).
 */
export function runScanWalk(
  db: ReturnType<typeof openStore>,
  repoRoot: string,
  sessionId: string,
  config: ReturnType<typeof loadConfig>["config"],
  orderedCandidates: string[],
  full: boolean
): ScanWalkResult {
  const states = new Map<string, FileWalkState>();
  const oversizedSkips: OversizedSkip[] = [];
  const filesTouched = new Set<string>();
  let chunksProcessed = 0;

  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    for (const filePath of orderedCandidates) {
      if (!full && getSessionQuestionCount(db, sessionId) >= config.scanQuestionsCap) {
        return { chunksProcessed, filesTouched: filesTouched.size, capped: true, oversizedSkips };
      }

      let state = states.get(filePath);
      if (!state) {
        state = classifyFile(db, repoRoot, config, filePath, oversizedSkips);
        states.set(filePath, state);
        if (state.done) {
          filesTouched.add(filePath);
          continue;
        }
      }
      if (state.done || state.stuckThisRun) continue;

      const chunk = state.chunks![state.nextChunkCursor];
      const succeeded = processOneChunk(db, repoRoot, sessionId, config, filePath, chunk, state.totalFileLines);
      filesTouched.add(filePath);
      chunksProcessed++;
      if (succeeded) {
        state.nextChunkCursor++;
        if (state.nextChunkCursor >= state.chunks!.length) {
          state.done = true;
          // The file just became fully covered this run — record its
          // current whole-file content/hash for Prompt 9's re-scan check,
          // using the SAME content this run's own chunks were read from
          // (not a fresh re-read), so the stored snapshot is exactly what
          // was actually processed.
          if (state.wholeFileContent !== null) {
            recordFileHashIfTrackable(db, repoRoot, filePath, state.wholeFileContent, state.totalFileLines);
          }
        }
        madeProgress = true;
      } else {
        // Leave nextChunkCursor untouched (scan_progress wasn't updated
        // either) — a failed attempt is retried on a later `grasp scan`
        // run, not immediately within this same one. See FileWalkState's
        // own comment for why this must NOT advance the cursor.
        state.stuckThisRun = true;
      }
    }
  }

  return { chunksProcessed, filesTouched: filesTouched.size, capped: false, oversizedSkips };
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
  const completedSet = getScanCompletedFilePaths(db, repoRoot);
  // Prompt 9: a fully-covered file isn't necessarily still up to date —
  // before treating it as permanently skippable, check whether its content
  // has genuinely changed since it was last scanned. A file NOT in
  // completedSet is already a normal candidate regardless (never scanned,
  // or only partially chunked), so this only runs against already-complete
  // files, and only reopens the ones where a real edit is found.
  const candidates = allTracked.filter((f) => {
    if (!completedSet.has(f)) return true;
    return checkForFileEdits(db, repoRoot, config, f);
  });

  if (candidates.length === 0) {
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
      `Scanning up to ${config.scanQuestionsCap} question${config.scanQuestionsCap === 1 ? "" : "s"}' worth of files (${candidates.length} file${candidates.length === 1 ? "" : "s"} not yet fully covered)...\n`
    );
  }

  const sessionId = `scan-${randomUUID()}`;
  const ordered = orderFilesRoundRobin(candidates);
  const walkResult = runScanWalk(db, repoRoot, sessionId, config, ordered, Boolean(options.full));

  for (const skip of walkResult.oversizedSkips) {
    process.stdout.write(
      `Skipped ${skip.filePath} — ${skip.lineCount} lines, over the ${MAX_SCAN_CEILING_LINES}-line processing ceiling.\n`
    );
  }

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
