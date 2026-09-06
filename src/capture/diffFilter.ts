/**
 * The meaningful-diff filter.  GOVERNED BY: §7.5
 *
 * SUPPRESSES NOISE, DOES NOT JUDGE IMPORTANCE. A three-line function can matter
 * enormously, so the threshold stays low and the real "worth asking about?" call
 * belongs to the generation prompt (§9.2 step 1). When in doubt, pass it
 * through — a slightly weak question costs the user seconds; a filtered-out real
 * change costs them the understanding.
 */
import picomatch from "picomatch";
import type { FileDiff } from "./snapshot.js";

export interface DiffFilterSettings {
  minLines: number;
  ignorePatterns: string[];
}

export interface FilterOptions {
  /**
   * §12.2 — in scan mode the input is existing code, not a diff, so only
   * `ignorePatterns` applies. The other rules read `+`/`-` markers that raw code
   * does not have (every file would look "whitespace-only"), and the line-count
   * threshold is explicitly excluded there: coverage is the goal, and small
   * files may matter.
   */
  mode?: "live" | "scan";
}

export type RejectReason = "ignored" | "too_small" | "whitespace_only" | "import_reorder_only";

export interface FilterResult {
  kept: FileDiff[];
  rejected: { file: FileDiff; reason: RejectReason }[];
}

/** Changed lines from a unified diff, split by direction, markers stripped. */
function changedLines(diff: string): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  return { added, removed };
}

function normalizeWhitespace(lines: string[]): string {
  // Collapse runs of whitespace and drop blank lines: indentation changes, line
  // rewrapping, and CRLF/LF churn all normalize to the same string.
  return lines
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

export function isWhitespaceOnly(diff: string): boolean {
  const { added, removed } = changedLines(diff);
  return normalizeWhitespace(added) === normalizeWhitespace(removed);
}

const IMPORT_LINE = /^\s*(?:import\b|export\s+(?:\*|\{)|from\b|const\s+\{[^}]*\}\s*=\s*require\()/;

/**
 * An import block that was only reordered: the same set of lines, differently
 * arranged. Any non-import change alongside it, and the whole diff passes.
 */
export function isImportReorderOnly(diff: string): boolean {
  const { added, removed } = changedLines(diff);
  const meaningful = (lines: string[]) => lines.filter((line) => line.trim().length > 0);
  const addedLines = meaningful(added);
  const removedLines = meaningful(removed);
  if (addedLines.length === 0 || removedLines.length === 0) return false;
  if (!addedLines.every((line) => IMPORT_LINE.test(line))) return false;
  if (!removedLines.every((line) => IMPORT_LINE.test(line))) return false;

  const sortedAdded = [...addedLines.map((l) => l.trim())].sort();
  const sortedRemoved = [...removedLines.map((l) => l.trim())].sort();
  return (
    sortedAdded.length === sortedRemoved.length &&
    sortedAdded.every((l, i) => l === sortedRemoved[i])
  );
}

export function filterDiffs(
  files: FileDiff[],
  settings: DiffFilterSettings,
  options: FilterOptions = {},
): FilterResult {
  const isIgnored = picomatch(settings.ignorePatterns);
  const scanMode = options.mode === "scan";
  const kept: FileDiff[] = [];
  const rejected: { file: FileDiff; reason: RejectReason }[] = [];

  for (const file of files) {
    if (isIgnored(file.path)) {
      rejected.push({ file, reason: "ignored" });
      continue;
    }
    if (scanMode) {
      kept.push(file);
      continue;
    }
    if (isWhitespaceOnly(file.diff)) {
      rejected.push({ file, reason: "whitespace_only" });
      continue;
    }
    if (isImportReorderOnly(file.diff)) {
      rejected.push({ file, reason: "import_reorder_only" });
      continue;
    }
    // Net added/modified lines: a rename-heavy edit that adds 3 and removes 3 is
    // still 3 lines of new content to understand, so `added` is the measure.
    if (file.added < settings.minLines) {
      rejected.push({ file, reason: "too_small" });
      continue;
    }
    kept.push(file);
  }

  return { kept, rejected };
}
