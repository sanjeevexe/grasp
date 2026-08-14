/**
 * Pure, file-content-agnostic chunk-splitting math shared by `scan.ts` (the
 * live walk) and `store.ts` (the pre-chunking `scan_progress` migration —
 * see DECISIONS.md's "grasp scan: chunking for large files" entry). Kept in
 * its own module, not exported from either of those two, specifically to
 * avoid a scan.ts <-> store.ts import cycle: `scan.ts` already imports from
 * `store.ts`, so `store.ts` importing chunk math back from `scan.ts` would
 * create one.
 */

/**
 * Maximum lines of source handed to one generation call. A file at or under
 * this size is just "one chunk" (chunk 0) — see DECISIONS.md's "grasp scan:
 * chunk size" entry for the reasoning behind 400.
 */
export const MAX_SCAN_CHUNK_LINES = 400;

/**
 * Splits raw file content into real lines, counted the way a human (or
 * `wc -l`/an editor) would: a trailing newline terminates the last real line
 * rather than introducing a phantom extra one. `String.split` on a newline
 * pattern doesn't do this on its own — `"a\nb\n".split(/\n/)` yields
 * `["a", "b", ""]`, an empty trailing element for the content AFTER the
 * final newline, which is not a line. Every place that used to compute a
 * file's lines via a raw `.split(/\r\n|\r|\n/)` should go through this
 * instead, so `MAX_SCAN_CEILING_LINES`/`MAX_SCAN_CHUNK_LINES`/
 * `MAX_SCAN_HASH_TRACKING_LINES` boundaries are checked against the file's
 * real line count. A genuinely empty (0-byte) file has 0 lines, not 1.
 */
export function splitFileLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split(/\r\n|\r|\n/);
  if (/\r\n$|\r$|\n$/.test(content)) lines.pop();
  return lines;
}

export interface FileChunk {
  chunkIndex: number;
  /** 1-indexed, inclusive — the chunk's first line in the FILE's own absolute numbering, not relative to the chunk. */
  startLine: number;
  lines: string[];
  /** True when this is the file's last chunk (its line count is naturally short of a full MAX_SCAN_CHUNK_LINES, or it's the only chunk) — see `scan_progress.is_final_chunk`. */
  isFinal: boolean;
}

/**
 * Splits a whole file's lines into sequential, mechanical, fixed-size
 * blocks from the top — no semantic boundary detection. A zero-line file
 * still gets exactly one (empty, final) chunk, matching "a file at or under
 * this size is just one chunk" for the degenerate case.
 */
export function splitFileIntoChunks(fileLines: string[]): FileChunk[] {
  const chunks: FileChunk[] = [];
  for (let start = 0; start < fileLines.length; start += MAX_SCAN_CHUNK_LINES) {
    const lines = fileLines.slice(start, start + MAX_SCAN_CHUNK_LINES);
    chunks.push({
      chunkIndex: chunks.length,
      startLine: start + 1,
      lines,
      isFinal: start + MAX_SCAN_CHUNK_LINES >= fileLines.length,
    });
  }
  if (chunks.length === 0) {
    chunks.push({ chunkIndex: 0, startLine: 1, lines: [], isFinal: true });
  }
  return chunks;
}

/** Same chunk count `splitFileIntoChunks` would produce, without materializing the chunks themselves — used by the `scan_progress` migration, which only needs a count, not content. */
export function countChunksForLineCount(lineCount: number): number {
  return Math.max(1, Math.ceil(lineCount / MAX_SCAN_CHUNK_LINES));
}
