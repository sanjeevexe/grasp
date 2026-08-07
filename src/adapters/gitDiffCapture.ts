import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isGitWorkTree, listUntrackedFiles, resolveBaseRef, runGit } from "../git";
import { AgentAdapter, CapturedDiff, DiffFile, DiffHunk, FileChangeStatus } from "./agentAdapter";

interface NameStatusEntry {
  status: FileChangeStatus;
  path: string;
  oldPath: string | null;
}

interface NumstatEntry {
  insertions: number;
  deletions: number;
}

const STATUS_LETTER_MAP: Record<string, FileChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  T: "modified", // file-type change (e.g. symlink <-> regular) — closest fit
};

/** Parses `git diff --name-status -M` output. */
function parseNameStatus(output: string): NameStatusEntry[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const fields = line.split("\t");
      const code = fields[0];
      if (code.startsWith("R")) {
        return { status: "renamed" as const, oldPath: fields[1], path: fields[2] };
      }
      const status = STATUS_LETTER_MAP[code[0]] ?? "modified";
      return { status, oldPath: null, path: fields[1] };
    });
}

/**
 * Resolves a `git diff --numstat` path field to the file's new/current
 * path. Git renders a rename two different ways depending on how much
 * prefix/suffix the old and new paths share:
 *   - No shared prefix/suffix: the full paths, e.g. "old/path.ts => new/path.ts".
 *   - A shared prefix/suffix: a compact brace form, e.g.
 *     "src/{old-name.ts => new-name.ts}" or "common/{old => new}/rest.ts" —
 *     git elides the unchanged parts and only spells out what differs
 *     inside `{...}`.
 * The naive `pathField.split(" => ")[1]` only handles the first form — on
 * the brace form it returns a fragment like "new-name.ts}" (trailing brace,
 * missing the "src/" prefix), which then fails to match the file's real
 * path from `--name-status` and silently drops its insertion/deletion
 * counts to 0. Found by an independent test pass: a genuinely edited
 * rename (not just moved) was recorded as +0/-0 and filtered out as if it
 * were empty. See DECISIONS.md's "Compact rename numstat parsing" entry.
 */
export function resolveNumstatNewPath(pathField: string): string {
  const braceMatch = pathField.match(/^(.*)\{.* => (.*)\}(.*)$/);
  if (braceMatch) {
    const [, prefix, newPart, suffix] = braceMatch;
    return `${prefix}${newPart}${suffix}`;
  }
  return pathField.includes(" => ") ? pathField.split(" => ")[1] : pathField;
}

/** Parses `git diff --numstat -M` output, keyed by the file's new/current path. */
function parseNumstat(output: string): Map<string, NumstatEntry> {
  const map = new Map<string, NumstatEntry>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [insRaw, delRaw, pathField] = trimmed.split("\t");
    // Binary files report "-" instead of a count.
    const insertions = insRaw === "-" ? 0 : Number(insRaw);
    const deletions = delRaw === "-" ? 0 : Number(delRaw);
    const newPath = resolveNumstatNewPath(pathField);
    map.set(newPath, { insertions, deletions });
  }
  return map;
}

/** Splits a multi-file `git diff` output into one raw chunk per file. */
function splitIntoFileDiffs(rawDiffText: string): string[] {
  if (!rawDiffText.trim()) return [];
  return rawDiffText
    .split(/(?=^diff --git )/m)
    .map((chunk) => chunk.replace(/\n$/, ""))
    .filter((chunk) => chunk.trim().length > 0);
}

/** Pulls the file path a diff chunk applies to, from its `+++`/`---` header lines. */
function extractPathFromChunk(chunk: string): string | null {
  const lines = chunk.split("\n");
  const plusLine = lines.find((l) => l.startsWith("+++ "));
  const minusLine = lines.find((l) => l.startsWith("--- "));
  const fromHeader = (line: string | undefined): string | null => {
    if (!line || line === "+++ /dev/null" || line === "--- /dev/null") return null;
    // "+++ b/path/to/file" / "--- a/path/to/file" — strip the 6-char prefix.
    return line.slice(6);
  };
  return fromHeader(plusLine) ?? fromHeader(minusLine);
}

/** Extracts `@@ ... @@` hunks (header + body lines) from one file's diff chunk. */
function extractHunks(chunkOrDiffText: string): DiffHunk[] {
  const lines = chunkOrDiffText.split("\n");
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current) hunks.push(current);
      current = { header: line, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

function countInsertions(hunks: DiffHunk[]): number {
  return hunks.reduce(
    (sum, h) => sum + h.lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
    0
  );
}

/**
 * The same file-level diff parsing logic (name-status for status/rename,
 * numstat for insertion/deletion counts, raw diff text hand-split into
 * hunks by file), shared by `captureGitDiff` (single ref, HEAD-vs-worktree)
 * and `captureDiffBetweenTrees` (two tree-ish args) below — `git diff`'s
 * output format is identical either way, so this is one parser, not two.
 */
function diffFilesBetween(
  repoPath: string,
  fromArg: string,
  toArg: string | null
): { files: DiffFile[]; rawDiffText: string } {
  const refArgs = toArg !== null ? [fromArg, toArg] : [fromArg];
  const nameStatusOut = runGit(repoPath, ["diff", "--no-color", "-M", "--name-status", ...refArgs]).stdout;
  const numstatOut = runGit(repoPath, ["diff", "--no-color", "-M", "--numstat", ...refArgs]).stdout;
  const rawDiffText = runGit(repoPath, ["diff", "--no-color", "-M", ...refArgs]).stdout.replace(/\n$/, "");

  const statuses = parseNameStatus(nameStatusOut);
  const stats = parseNumstat(numstatOut);
  const chunks = splitIntoFileDiffs(rawDiffText);

  const files: DiffFile[] = statuses.map((entry) => {
    const stat = stats.get(entry.path) ?? { insertions: 0, deletions: 0 };
    const chunk = chunks.find((c) => {
      const chunkPath = extractPathFromChunk(c);
      return chunkPath === entry.path || (entry.oldPath !== null && chunkPath === entry.oldPath);
    });
    return {
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      insertions: stat.insertions,
      deletions: stat.deletions,
      hunks: chunk ? extractHunks(chunk) : [],
    };
  });

  return { files, rawDiffText };
}

/**
 * Captures the working-tree diff for a repo: everything changed since the
 * last commit (staged + unstaged, via `git diff HEAD`) plus untracked files
 * not excluded by .gitignore. Read-only — never touches the index.
 *
 * See DECISIONS.md's "Git-diff capture: comparison mechanism" entry for why
 * HEAD (not the index, not a stored snapshot) is the comparison base for
 * this function specifically — it's the right base for a manual, one-shot
 * "show me everything uncommitted right now" inspection command
 * (`debug:capture`/`GitDiffAdapter`). `ClaudeCodeAdapter`'s hook-driven
 * capture uses `captureDiffBetweenTrees` instead — see that function's own
 * doc comment for why HEAD is the wrong base there.
 */
export function captureGitDiff(repoPath: string): CapturedDiff {
  const absoluteRepoPath = path.resolve(repoPath);

  if (!isGitWorkTree(absoluteRepoPath)) {
    throw new Error(`Grasp: ${absoluteRepoPath} is not inside a git working tree.`);
  }

  const baseRef = resolveBaseRef(absoluteRepoPath);
  const { files: trackedFiles, rawDiffText: rawTrackedDiff } = diffFilesBetween(
    absoluteRepoPath,
    baseRef,
    null
  );

  const untrackedRawChunks: string[] = [];
  const untrackedFiles: DiffFile[] = listUntrackedFiles(absoluteRepoPath).map((filePath) => {
    // git diff --no-index exits 1 when it finds differences (expected, not an error).
    const diffText = runGit(
      absoluteRepoPath,
      ["diff", "--no-color", "--no-index", "--", "/dev/null", filePath],
      [0, 1]
    ).stdout;
    const trimmedDiffText = diffText.replace(/\n$/, "");
    untrackedRawChunks.push(trimmedDiffText);
    const hunks = extractHunks(trimmedDiffText);
    return {
      path: filePath,
      oldPath: null,
      status: "added",
      insertions: countInsertions(hunks),
      deletions: 0,
      hunks,
    };
  });

  const files = [...trackedFiles, ...untrackedFiles];
  const rawDiffText = [rawTrackedDiff.replace(/\n$/, ""), ...untrackedRawChunks]
    .filter((chunk) => chunk.length > 0)
    .join("\n");

  return {
    repo: absoluteRepoPath,
    capturedAt: new Date().toISOString(),
    files,
    rawDiffText,
    // No checkpoint concept on this path (see the module doc comment above
    // writeWorktreeTree/captureDiffBetweenTrees) — always HEAD-vs-worktree,
    // so there are no two endpoints to name a hash after.
    diffHash: null,
  };
}

// --- Checkpoint-based incremental capture (ClaudeCodeAdapter only) --------
//
// `captureGitDiff` above always diffs HEAD-vs-worktree — correct for a
// manual, one-shot inspection command (`debug:capture`/`GitDiffAdapter`,
// "show me everything uncommitted right now"), but wrong for a hook-driven
// capture that fires after every tool call: re-diffing the whole working
// tree every time re-surfaces the same accumulated changes on every firing
// with no new work in between, and can attribute uncommitted changes that
// predate the agent's turn entirely to the agent. See DECISIONS.md's
// "Checkpoint-based incremental capture" entry for the full design
// rationale and the alternatives that were considered and rejected.
//
// The mechanism: snapshot the exact current working tree (tracked +
// untracked, respecting .gitignore) as a real git tree object, using a
// throwaway index file (via `GIT_INDEX_FILE`) that's never wired up as the
// repo's real index — so this never stages anything a real `git status`/
// `git commit` would see. Two such snapshots taken at different times can
// then be diffed against EACH OTHER with the exact same `git diff`
// invocations already used above (tree-ish vs tree-ish behaves identically
// to ref vs ref for --name-status/--numstat/raw output), which is what
// makes an untracked file correctly show as "modified" rather than
// "deleted" between two checkpoints — a plain `git diff <tree>` against the
// live worktree does NOT do this correctly for untracked paths, since it's
// actually a tree-vs-INDEX comparison under the hood and the real index
// never has untracked entries at all (verified empirically before choosing
// this design — a tree-vs-worktree "single ref" diff for a tree containing
// an untracked file's prior snapshot showed it as *deleted*, not modified,
// even when the file was present and unchanged on disk).

/**
 * Builds a git tree object representing the exact current state of the
 * working tree (every tracked file's current content, plus every untracked
 * file not excluded by .gitignore) and returns its SHA. Never touches the
 * repo's real index — `GIT_INDEX_FILE` points `read-tree`/`add`/`write-tree`
 * at a throwaway file for the duration of this call, deleted afterward.
 */
export function writeWorktreeTree(repoPath: string): string {
  const absoluteRepoPath = path.resolve(repoPath);
  const seedRef = resolveBaseRef(absoluteRepoPath);
  const scratchIndexPath = path.join(
    os.tmpdir(),
    `grasp-idx-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
  );
  try {
    const env = { GIT_INDEX_FILE: scratchIndexPath };
    runGit(absoluteRepoPath, ["read-tree", seedRef], [0], env);
    runGit(absoluteRepoPath, ["add", "-A"], [0], env);
    const { stdout } = runGit(absoluteRepoPath, ["write-tree"], [0], env);
    return stdout.trim();
  } finally {
    fs.rmSync(scratchIndexPath, { force: true });
  }
}

/**
 * Diffs two `writeWorktreeTree` snapshots against each other (via the same
 * `diffFilesBetween` parser defined above `captureGitDiff`) — the actual
 * incremental-capture primitive `ClaudeCodeAdapter.checkAndCapture` uses.
 * `diffHash` is the caller's job to compute (conventionally
 * `${fromTree}..${toTree}`, git's own range-diff notation — a real,
 * reproducible identifier a developer could hand back to `git diff`
 * themselves) since this function only knows the two tree SHAs, not what
 * convention the caller wants recorded.
 */
export function captureDiffBetweenTrees(
  repoPath: string,
  fromTree: string,
  toTree: string,
  diffHash: string
): CapturedDiff {
  const absoluteRepoPath = path.resolve(repoPath);
  const { files, rawDiffText } = diffFilesBetween(absoluteRepoPath, fromTree, toTree);
  return {
    repo: absoluteRepoPath,
    capturedAt: new Date().toISOString(),
    files,
    rawDiffText,
    diffHash,
  };
}

/** A capture with no changes — used both when a checkpoint is freshly seeded (nothing "new" yet by definition) and when two consecutive checkpoints are identical (nothing changed since the last capture). */
export function emptyCapturedDiff(repoPath: string): CapturedDiff {
  return {
    repo: path.resolve(repoPath),
    capturedAt: new Date().toISOString(),
    files: [],
    rawDiffText: "",
    diffHash: null,
  };
}

/**
 * Adapter-shaped wrapper around `captureGitDiff`. Agent-agnostic: works
 * against any git repo regardless of which coding agent (if any) produced
 * the changes, which is why it reports no headless generation capability
 * and no cost self-reporting of its own — those are properties of a
 * specific coding agent's CLI, not of git itself.
 */
export class GitDiffAdapter implements AgentAdapter {
  readonly supportsHeadlessSelfInvocation = false;
  readonly reportsCost = false;

  constructor(private readonly repoPath: string) {}

  /**
   * Captures the current diff and, if non-empty, notifies via
   * onChangeDetected. This is the shape a future poll loop would call on
   * an interval; nothing calls it on a timer yet in Phase 2. Returns the
   * diff (including empty results) so callers like the debug CLI can
   * inspect it directly without depending on the notification path.
   */
  checkForChanges(): CapturedDiff {
    const diff = captureGitDiff(this.repoPath);
    if (diff.files.length > 0) {
      void this.onChangeDetected(diff);
    }
    return diff;
  }

  async onChangeDetected(_diff: CapturedDiff): Promise<void> {
    // Phase 4's mechanical filter (src/filter.ts) exists and is wired into
    // ClaudeCodeAdapter, which already has a DB handle and a session/turn
    // to record against. GitDiffAdapter has neither (it's a manual/poll
    // capture with no hook-driven session concept), so there's nowhere
    // meaningful to persist a filter verdict yet — see DECISIONS.md's
    // "Filter wiring scope" entry. Forwarding a passed diff into real
    // question generation is still Phase 5 regardless.
  }

  async onSessionComplete(): Promise<void> {
    // Flushing the queue and presenting before final output is Phase 7/8.
  }
}
