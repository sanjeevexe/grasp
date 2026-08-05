/**
 * Capture-layer types shared by every adapter. Nothing here may reference
 * git, Claude Code, or any other agent/VCS-specific concept — that's what
 * keeps this interface reusable across the git-diff fallback (this phase)
 * and the Claude Code hooks adapter (Phase 3) without changing shape.
 */

export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffHunk {
  /** The `@@ -a,b +c,d @@` header line, verbatim. */
  header: string;
  /** Hunk body lines, verbatim, including their leading +/-/space markers. */
  lines: string[];
}

export interface DiffFile {
  path: string;
  /** Present only when status === "renamed". */
  oldPath: string | null;
  status: FileChangeStatus;
  insertions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface CapturedDiff {
  /** The repo root this diff was captured against. */
  repo: string;
  /** ISO 8601 timestamp of when capture ran. */
  capturedAt: string;
  files: DiffFile[];
  /** The full raw diff text, concatenated across all files in `files`. */
  rawDiffText: string;
  /**
   * A stable identifier for exactly this diff, when the adapter that
   * produced it can compute one — populated by `ClaudeCodeAdapter`'s
   * checkpoint-based capture as `<fromTreeSha>..<toTreeSha>` (see
   * `writeWorktreeTree`/`captureDiffBetweenTrees` in gitDiffCapture.ts and
   * DECISIONS.md's checkpoint-capture entry). Null for capture paths that
   * don't compute one (e.g. the plain HEAD-based `captureGitDiff` used by
   * `debug:capture`/`GitDiffAdapter`, which has no checkpoint concept).
   */
  diffHash: string | null;
}

/**
 * The capture-layer contract from brief §5.1. An adapter is notified of a
 * detected change or a completed session via these two methods; how it
 * detects either (polling git, listening to agent hooks) is entirely up to
 * the adapter and lives outside this interface.
 */
export interface AgentAdapter {
  /** Can this adapter's underlying agent generate questions itself (headless self-invocation)? */
  readonly supportsHeadlessSelfInvocation: boolean;
  /** Does this adapter's underlying agent self-report cost, making spend trackable/cappable? */
  readonly reportsCost: boolean;

  onChangeDetected(diff: CapturedDiff): void | Promise<void>;
  onSessionComplete(): void | Promise<void>;
}
