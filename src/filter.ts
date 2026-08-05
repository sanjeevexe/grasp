import { CapturedDiff, DiffFile, DiffHunk } from "./adapters/agentAdapter";
import { BASELINE_IGNORE_PATTERNS } from "./ignoreBaseline";
import { GraspConfig } from "./types";

/**
 * Purely mechanical pre-filtering (brief §5.2's mechanical half only — no
 * semantic "is this interesting" judgment lives here; see DECISIONS.md's
 * "Flagged-pattern filtering" entry from Phase 4's planning and the
 * formatting-only/filtered-diff-recording entries added in this phase).
 */

export type FilterReason =
  | "baseline_ignore"
  | "user_ignore_pattern"
  | "formatting_only"
  | "below_min_threshold"
  | "above_max_threshold";

export type FileExclusionReason = "baseline_ignore" | "user_ignore_pattern" | "formatting_only";

export interface ExcludedFile {
  path: string;
  reason: FileExclusionReason;
}

export interface FilterResult {
  passed: boolean;
  reason: FilterReason | null;
  /**
   * Files that survived exclusion — what a future Phase 5 should actually
   * operate on. Empty whenever `passed` is false.
   */
  significantFiles: DiffFile[];
  excludedFiles: ExcludedFile[];
  totalChangedLines: number;
  maxSingleFileChangedLines: number;
}

// --- Ignore-pattern matching -------------------------------------------

/**
 * A pattern ending in "/" matches a directory anywhere in the path (e.g.
 * "node_modules/" matches "packages/a/node_modules/x.js"). Anything else
 * matches by exact basename or exact full relative path (e.g.
 * "package-lock.json" matches both "package-lock.json" and
 * "packages/a/package-lock.json"). No glob syntax — see DECISIONS.md's
 * "Ignore-pattern matching syntax" entry for why.
 */
export function matchesIgnorePattern(filePath: string, pattern: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (pattern.endsWith("/")) {
    const dirName = pattern.slice(0, -1);
    const dirSegments = normalizedPath.split("/").slice(0, -1);
    return dirSegments.includes(dirName);
  }
  const basename = normalizedPath.split("/").pop() ?? normalizedPath;
  return basename === pattern || normalizedPath === pattern;
}

function classifyIgnoreExclusion(filePath: string, config: GraspConfig): FileExclusionReason | null {
  if (BASELINE_IGNORE_PATTERNS.some((p) => matchesIgnorePattern(filePath, p))) {
    return "baseline_ignore";
  }
  if (config.ignorePatterns.some((p) => matchesIgnorePattern(filePath, p))) {
    return "user_ignore_pattern";
  }
  return null;
}

// --- Formatting-only detection ------------------------------------------

/**
 * Collapses insignificant whitespace: trims the line and collapses any run
 * of internal whitespace to a single space. Reindentation, trailing
 * whitespace, and tabs-vs-spaces all normalize identically; anything that
 * changes actual tokens does not.
 */
function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

/** A hunk's removed lines (with their `-` prefix stripped), normalized, in order. */
function normalizedRemovedLines(hunk: DiffHunk): string[] {
  return hunk.lines
    .filter((l) => l.startsWith("-") && !l.startsWith("---"))
    .map((l) => normalizeLine(l.slice(1)));
}

/** A hunk's added lines (with their `+` prefix stripped), normalized, in order. */
function normalizedAddedLines(hunk: DiffHunk): string[] {
  return hunk.lines
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => normalizeLine(l.slice(1)));
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * A hunk is formatting-only if its normalized removed-line sequence exactly
 * equals its normalized added-line sequence (same content, same order —
 * order matters so a real reordering of statements is never mistaken for
 * formatting). A hunk with no removed/added lines at all (shouldn't happen
 * in practice, but) counts as formatting-only vacuously.
 */
function isHunkFormattingOnly(hunk: DiffHunk): boolean {
  return arraysEqual(normalizedRemovedLines(hunk), normalizedAddedLines(hunk));
}

/** A file is formatting-only only if every one of its hunks is. */
export function isFileFormattingOnly(file: DiffFile): boolean {
  if (file.hunks.length === 0) return false;
  return file.hunks.every(isHunkFormattingOnly);
}

// --- Main filter ----------------------------------------------------------

function pickEmptyReason(excludedFiles: ExcludedFile[]): FilterReason {
  // Priority: a user-specified pattern is the most intentional signal, then
  // the baseline list, then formatting-only (the most inferred of the
  // three). Only matters when a multi-file diff is emptied by a mix of
  // reasons — none of Phase 4's own verification scenarios hit this, but
  // the order needs to be defined rather than left to iteration order.
  if (excludedFiles.some((f) => f.reason === "user_ignore_pattern")) return "user_ignore_pattern";
  if (excludedFiles.some((f) => f.reason === "baseline_ignore")) return "baseline_ignore";
  return "formatting_only";
}

/**
 * Applies Phase 4's mechanical filter to a captured diff. Two file-level
 * exclusion passes run first (ignore patterns, then formatting-only),
 * producing a "significant files" set; size thresholds are then evaluated
 * against ONLY that remaining set — so a file excluded by either pass
 * doesn't count toward or against the size thresholds. See DECISIONS.md's
 * "Diff-size thresholds: per-file exclusion, not whole-diff" entry.
 */
export function evaluateCapturedDiff(diff: CapturedDiff, config: GraspConfig): FilterResult {
  const excludedFiles: ExcludedFile[] = [];
  const significantFiles: DiffFile[] = [];

  for (const file of diff.files) {
    const ignoreReason = classifyIgnoreExclusion(file.path, config);
    if (ignoreReason) {
      excludedFiles.push({ path: file.path, reason: ignoreReason });
      continue;
    }
    if (isFileFormattingOnly(file)) {
      excludedFiles.push({ path: file.path, reason: "formatting_only" });
      continue;
    }
    significantFiles.push(file);
  }

  if (significantFiles.length === 0) {
    return {
      passed: false,
      reason: pickEmptyReason(excludedFiles),
      significantFiles: [],
      excludedFiles,
      totalChangedLines: 0,
      maxSingleFileChangedLines: 0,
    };
  }

  const fileSizes = significantFiles.map((f) => f.insertions + f.deletions);
  const totalChangedLines = fileSizes.reduce((sum, n) => sum + n, 0);
  const maxSingleFileChangedLines = Math.max(...fileSizes);

  const { minChangedLines, maxTotalChangedLines, maxSingleFileChangedLines: maxSingleFileCap } =
    config.diffThresholds;

  if (totalChangedLines > maxTotalChangedLines || maxSingleFileChangedLines > maxSingleFileCap) {
    return {
      passed: false,
      reason: "above_max_threshold",
      significantFiles: [],
      excludedFiles,
      totalChangedLines,
      maxSingleFileChangedLines,
    };
  }

  const anyFileClearsMinimum = fileSizes.some((size) => size >= minChangedLines);
  if (!anyFileClearsMinimum) {
    return {
      passed: false,
      reason: "below_min_threshold",
      significantFiles: [],
      excludedFiles,
      totalChangedLines,
      maxSingleFileChangedLines,
    };
  }

  return {
    passed: true,
    reason: null,
    significantFiles,
    excludedFiles,
    totalChangedLines,
    maxSingleFileChangedLines,
  };
}
