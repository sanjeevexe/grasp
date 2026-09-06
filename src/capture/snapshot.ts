/**
 * The content checkpoint and diffing.  GOVERNED BY: §5.5, §8.3
 *
 * COMPLETELY INDEPENDENT OF GIT (§5.5): it must work in a repo with no commits,
 * no remote, and a dirty tree. Grasp keeps its own copy of the last-captured
 * content of every tracked file under
 * `~/.grasp/snapshots/<sha256(projectPath).slice(0,16)>/`.
 *
 * THE CHECKPOINT ADVANCES IF AND ONLY IF the batch reached a terminal state:
 * questions persisted, or explicitly filtered as not-worth-asking (§8.3). Never
 * on API failure, rate-limit deferral, malformed output, or crash. That single
 * rule is what makes "no silent data loss" true, so `advance` is a separate call
 * the pipeline must make deliberately — never a side effect of diffing.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { graspSnapshotRoot } from "../util/home.js";
import { toPosix } from "../util/paths.js";

/** §5.5 — one directory per project, keyed by a hash of its absolute path. */
export function snapshotDirFor(projectPath: string): string {
  const key = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  return path.join(graspSnapshotRoot(), key);
}

function snapshotPathFor(projectPath: string, relativePath: string): string {
  // The snapshot mirrors the project's relative paths, so a file's history is
  // findable by hand when something looks wrong.
  return path.join(snapshotDirFor(projectPath), relativePath);
}

export function readSnapshot(projectPath: string, relativePath: string): string | null {
  try {
    return fs.readFileSync(snapshotPathFor(projectPath, relativePath), "utf8");
  } catch {
    // No snapshot yet: the file is new to Grasp.
    return null;
  }
}

/**
 * Write one file's current content into the checkpoint. Call this ONLY when
 * §8.3's terminal-state condition holds.
 */
export function advanceSnapshot(projectPath: string, relativePath: string, content: string): void {
  const target = snapshotPathFor(projectPath, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

export function removeSnapshot(projectPath: string, relativePath: string): void {
  fs.rmSync(snapshotPathFor(projectPath, relativePath), { force: true });
}

export interface FileDiff {
  /** POSIX-style, project-relative (§16.4). */
  path: string;
  /** Standard unified diff with 3 lines of context — what models read best. */
  diff: string;
  /** Current on-disk content, held so the checkpoint can advance later. */
  content: string;
  added: number;
  removed: number;
  isNew: boolean;
}

/**
 * §5.5 — a standard unified diff with ~3 lines of context. Hand-rolling this was
 * an option; `diff` produces the exact format models are trained on.
 */
export function diffAgainstSnapshot(
  projectPath: string,
  relativePath: string,
  currentContent: string,
): FileDiff | null {
  const previous = readSnapshot(projectPath, relativePath);
  if (previous === currentContent) return null;

  const posix = toPosix(relativePath);
  const patch = createTwoFilesPatch(
    `a/${posix}`,
    `b/${posix}`,
    previous ?? "",
    currentContent,
    undefined,
    undefined,
    { context: 3 },
  );

  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }

  return {
    path: posix,
    diff: patch,
    content: currentContent,
    added,
    removed,
    isNew: previous === null,
  };
}

/** Stable identity for a diff, so the same change never asks twice (§19 dedup). */
export function hashDiff(diff: string): string {
  return createHash("sha256").update(diff).digest("hex");
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * §6.1 step 4 — populate the checkpoint at init so the first captured diff is a
 * real change rather than "entire codebase added".
 */
export function populateSnapshot(
  projectPath: string,
  files: { relativePath: string; content: string }[],
): void {
  for (const file of files) advanceSnapshot(projectPath, file.relativePath, file.content);
}

export function clearSnapshots(projectPath: string): void {
  fs.rmSync(snapshotDirFor(projectPath), { recursive: true, force: true });
}
