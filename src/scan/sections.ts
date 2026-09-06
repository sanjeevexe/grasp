/**
 * Section splitting for long files.  GOVERNED BY: §12.2
 *
 * Files over 400 lines split at TOP-LEVEL DECLARATION BOUNDARIES when the file
 * parses, falling back to a hard line split with 20 lines of overlap for
 * context. Never split mid-function when it is avoidable — a section that starts
 * halfway through a function produces a bad question.
 */
import { parse as parseJs } from "@babel/parser";
import path from "node:path";

export const MAX_SECTION_LINES = 400;
export const HARD_SPLIT_OVERLAP = 20;

export interface Section {
  index: number;
  total: number;
  startLine: number;
  endLine: number;
  content: string;
  /** False when the declaration-boundary split was unavailable (§12.2). */
  onBoundary: boolean;
}

/** 1-based line numbers of top-level declarations, or null when unparseable. */
export function topLevelBoundaries(source: string, filePath: string): number[] | null {
  const extension = path.extname(filePath).toLowerCase();
  if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return null;

  try {
    const ast = parseJs(source, {
      sourceType: "unambiguous",
      plugins: [".tsx", ".jsx"].includes(extension) ? ["typescript", "jsx"] : ["typescript"],
      // Same reasoning as the syntax check: a semantic complaint must not cost a
      // file its declaration boundaries and force a blind hard split.
      errorRecovery: true,
    });
    return ast.program.body
      .map((node) => node.loc?.start.line)
      .filter((line): line is number => typeof line === "number");
  } catch {
    // A minified or broken file has no usable boundaries.
    return null;
  }
}

function build(lines: string[], ranges: [number, number][], onBoundary: boolean): Section[] {
  return ranges.map(([start, end], index) => ({
    index,
    total: ranges.length,
    startLine: start,
    endLine: end,
    content: lines.slice(start - 1, end).join("\n"),
    onBoundary,
  }));
}

export function splitIntoSections(
  source: string,
  filePath: string,
  maxLines = MAX_SECTION_LINES,
): Section[] {
  const lines = source.split("\n");
  if (lines.length <= maxLines) {
    return [
      {
        index: 0,
        total: 1,
        startLine: 1,
        endLine: lines.length,
        content: source,
        onBoundary: true,
      },
    ];
  }

  const boundaries = topLevelBoundaries(source, filePath);

  if (boundaries && boundaries.length > 1) {
    // Grow a section declaration by declaration until adding the next one would
    // overshoot, so no section ever starts mid-declaration.
    const ranges: [number, number][] = [];
    let start = 1;
    for (let i = 0; i < boundaries.length; i++) {
      const next = boundaries[i + 1];
      const sectionEnd = next ? next - 1 : lines.length;
      if (sectionEnd - start + 1 >= maxLines || !next) {
        ranges.push([start, sectionEnd]);
        start = sectionEnd + 1;
      }
    }
    if (start <= lines.length) ranges.push([start, lines.length]);
    if (ranges.length > 1) return build(lines, ranges, true);
  }

  // §12.2 fallback: a hard split with overlap, for minified or unparseable files.
  const ranges: [number, number][] = [];
  let start = 1;
  while (start <= lines.length) {
    const end = Math.min(start + maxLines - 1, lines.length);
    ranges.push([start, end]);
    if (end === lines.length) break;
    start = end - HARD_SPLIT_OVERLAP + 1;
  }
  return build(lines, ranges, false);
}

export function describeSection(section: Section): string | null {
  if (section.total <= 1) return null;
  return `section ${section.index + 1} of ${section.total}, lines ${section.startLine}-${section.endLine}`;
}
