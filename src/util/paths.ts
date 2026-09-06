/**
 * Path normalization. ALL path logic lives here, never inlined.  GOVERNED BY: §16.4
 *
 * STORE: question_files.file_path and scan_progress.file_path as POSIX-style,
 *        RELATIVE to project root ("src/auth/middleware.js").
 * STORE: projects.path as absolute, resolved, symlink-free.
 *
 * Normalize at EVERY boundary: watcher events, git output, user CLI args.
 * git emits POSIX-style repo-relative paths on ALL platforms including Windows —
 * the hard gate depends on both sides being normalized identically (§13.3).
 *
 * Comparisons: case-SENSITIVE on Linux, case-INSENSITIVE on macOS/Windows.
 *
 * DECISION: only the three helpers the generation stage actually needs are
 * implemented here (build order §23 puts everything else later). They live in
 * this file rather than inline in generation/ because §16.4 admits no exception:
 * one normalizer, used everywhere, is what makes the hard gate's path matching
 * correct on Windows. The absolute/symlink/relativize helpers arrive with the
 * stages that need them.
 */
import fs from "node:fs";
import path from "node:path";

/** Convert any separator style to POSIX and drop a redundant "./" prefix. */
export function toPosix(p: string): string {
  const posix = p.split(path.win32.sep).join(path.posix.sep);
  return posix.startsWith("./") ? posix.slice(2) : posix;
}

/**
 * True when the filesystem this process runs on treats paths case-insensitively.
 * Exported (and parameterized below) so tests can exercise both behaviors
 * without faking `process.platform`.
 */
export function isCaseInsensitiveFs(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "win32";
}

/** Compare two project-relative paths under the platform's case rules (§16.4). */
export function pathsEqual(a: string, b: string, caseInsensitive = isCaseInsensitiveFs()): boolean {
  const left = toPosix(a);
  const right = toPosix(b);
  return caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * The absolute, resolved, symlink-free form of a path — the shape
 * `projects.path` is stored in (§16.4). Falls back to a plain resolve when the
 * path does not exist yet, so callers can normalize a target before creating it.
 */
export function resolveProjectPath(target: string): string {
  const absolute = path.resolve(target);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Walk up looking for a `.git` directory (§6.1 step 1). Returns the repo root,
 * or null when the path is not inside a git repo.
 */
export function findGitRoot(start: string): string | null {
  let current = resolveProjectPath(start);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Project-relative, POSIX-style — the shape stored in question_files (§16.4). */
export function toProjectRelative(projectRoot: string, absolutePath: string): string {
  return toPosix(path.relative(resolveProjectPath(projectRoot), path.resolve(absolutePath)));
}
