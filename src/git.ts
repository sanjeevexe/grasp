import { execFileSync } from "child_process";

/**
 * git's well-known empty-tree object id — diffing against this is how you
 * get "everything currently tracked/staged" as a diff when a repo has no
 * commits yet (plain `git diff HEAD` errors out with no HEAD to resolve).
 */
export const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface GitCommandResult {
  stdout: string;
  status: number;
}

/**
 * Runs `git <args>` in `cwd` via execFile (no shell — args are passed as an
 * array, so repo paths/filenames with spaces or shell metacharacters can't
 * be misinterpreted). `acceptExitCodes` lets callers treat a specific
 * non-zero exit as data rather than failure (e.g. `git diff --no-index`
 * exits 1 when it finds differences). `extraEnv` merges on top of the
 * current process's env — used for `GIT_INDEX_FILE` when building a
 * scratch-index tree snapshot (see `writeWorktreeTree` in
 * gitDiffCapture.ts) without ever touching the repo's real index.
 */
export function runGit(
  cwd: string,
  args: string[],
  acceptExitCodes: number[] = [0],
  extraEnv?: Record<string, string>
): GitCommandResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 64,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      // Explicit, not the execFileSync default: Node's exec-family helpers
      // send a failing child's stderr straight to the PARENT's stderr by
      // default (only stdout is piped/captured for the return value) — the
      // same quirk documented in generation.ts's invokeClaudeJudge. Left at
      // the default here, an EXPECTED git failure this module deliberately
      // probes for and recovers from (e.g. `rev-parse --verify HEAD` in a
      // repo with no commits yet, see resolveBaseRef) printed git's raw
      // "fatal: ..." line to the user as if something had actually broken,
      // even though Grasp's own fallback made the call succeed. Piping
      // stderr instead means it's only ever available via the caught
      // error's `.stderr`, used below to build a real failure's message.
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (err: any) {
    const status = typeof err.status === "number" ? err.status : -1;
    if (acceptExitCodes.includes(status)) {
      return { stdout: (err.stdout ?? "").toString(), status };
    }
    const detail = (err.stderr || err.message || "").toString().trim();
    throw new Error(`Grasp: \`git ${args.join(" ")}\` in ${cwd} failed (exit ${status}): ${detail}`);
  }
}

export function isGitWorkTree(repoPath: string): boolean {
  try {
    const result = runGit(repoPath, ["rev-parse", "--is-inside-work-tree"]);
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * `HEAD` if the repo has at least one commit, otherwise the empty-tree
 * hash — so callers always have a valid base ref to diff against.
 */
export function resolveBaseRef(repoPath: string): string {
  try {
    runGit(repoPath, ["rev-parse", "--verify", "HEAD"]);
    return "HEAD";
  } catch {
    return EMPTY_TREE_HASH;
  }
}

/** Untracked files not excluded by .gitignore — one path per entry. */
export function listUntrackedFiles(repoPath: string): string[] {
  const result = runGit(repoPath, ["ls-files", "--others", "--exclude-standard"]);
  return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * Resolves the git repository root for `cwd`, so config lookup, checkpoint
 * keying, and hook installation behave the same whether Claude Code's `cwd`
 * for a session is the repo root or some subdirectory of it (e.g. `repo/src`).
 * Falls back to `cwd` itself if it isn't inside a git work tree at all —
 * callers already handle "not a git repo" as a degenerate case elsewhere, so
 * this never throws.
 */
export function resolveRepoRoot(cwd: string): string {
  try {
    const result = runGit(cwd, ["rev-parse", "--show-toplevel"]);
    const root = result.stdout.trim();
    return root.length > 0 ? root : cwd;
  } catch {
    return cwd;
  }
}

/**
 * True when a caught `runGit` error is specifically git reporting a missing
 * object ("fatal: bad object <sha>") — the shape of failure produced when a
 * previously-written but never-referenced tree (e.g. one of Grasp's own
 * checkpoint snapshots — see gitDiffCapture.ts's checkpoint module doc) has
 * since been reclaimed by `git gc`/`git prune`. Distinguished from every
 * other git failure so callers can self-heal (re-seed the checkpoint) rather
 * than treat this the same as a genuine, unexpected git error.
 */
export function isMissingGitObjectError(err: unknown): boolean {
  return err instanceof Error && /fatal: bad object/i.test(err.message);
}
