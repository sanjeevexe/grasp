import { spawnSync } from "child_process";
import { CLI_PATH } from "./env";

/**
 * Hand-constructed Claude Code hook payloads, piped into `grasp
 * internal:hook` on stdin — the same "simulated-hook-payload" methodology
 * BUILD_PLAN.md's own manual-verification steps use throughout, and that
 * the prior TEST_LOG.md retest pass used for the same documented reason:
 * Claude Code resolves a session's hook configuration from the project root
 * the session itself was launched in, so there is no way to make a real,
 * authenticated Claude Code session fire a hook against one of this
 * harness's own disposable scratch repos. Every diff these scenarios feed
 * through this path is 100% real (real file edits, real git tree
 * snapshots, real checkpoint/capture/filter/generation code) — only the
 * hook *trigger* itself is constructed here rather than coming from Claude
 * Code's own dispatcher. See `src/adapters/claudeCodeAdapter.ts`'s
 * `ClaudeCodeHookPayload` for the authoritative field shape this mirrors.
 */

export interface HookPayloadInput {
  sessionId: string;
  promptId?: string;
  cwd: string;
  hookEventName: "PreToolUse" | "PostToolUse" | "Stop";
  toolName?: string;
  toolInput?: unknown;
}

export function buildHookPayload(input: HookPayloadInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    session_id: input.sessionId,
    cwd: input.cwd,
    hook_event_name: input.hookEventName,
  };
  if (input.promptId) payload.prompt_id = input.promptId;
  if (input.toolName) payload.tool_name = input.toolName;
  if (input.toolInput !== undefined) payload.tool_input = input.toolInput;
  return payload;
}

export interface FireHookResult {
  status: number;
  stdout: string;
  stderr: string;
  /** Parsed `hookOutput` JSON, if `internal:hook` wrote anything to stdout — null on a quiet firing (the normal case when there's nothing to say). */
  output: Record<string, unknown> | null;
}

/**
 * Spawns the real `grasp internal:hook` binary (not a direct function call
 * into `src/cli.ts` — going through the actual compiled CLI entrypoint over
 * a real subprocess is what makes this an end-to-end check of the exact
 * path Claude Code itself would invoke) with `payload` piped in on stdin,
 * under the given isolated `HOME`.
 */
export function fireHook(payload: Record<string, unknown>, opts: { cwd: string; env: Record<string, string> }): FireHookResult {
  const result = spawnSync(process.execPath, [CLI_PATH, "internal:hook"], {
    cwd: opts.cwd,
    env: opts.env,
    input: JSON.stringify(payload),
    encoding: "utf-8",
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  let output: Record<string, unknown> | null = null;
  if (stdout.trim().length > 0) {
    try {
      output = JSON.parse(stdout);
    } catch {
      output = null;
    }
  }

  return { status: result.status ?? -1, stdout, stderr, output };
}

/** Convenience: fires PreToolUse for `sessionId`/`cwd`, returns the hook result. */
export function firePreToolUse(cwd: string, env: Record<string, string>, sessionId: string, promptId?: string): FireHookResult {
  return fireHook(buildHookPayload({ sessionId, promptId, cwd, hookEventName: "PreToolUse", toolName: "Bash", toolInput: { command: "echo hi" } }), { cwd, env });
}

/** Convenience: fires PostToolUse (the capture trigger) for `sessionId`/`cwd`. */
export function firePostToolUse(cwd: string, env: Record<string, string>, sessionId: string, promptId?: string): FireHookResult {
  return fireHook(buildHookPayload({ sessionId, promptId, cwd, hookEventName: "PostToolUse", toolName: "Edit" }), { cwd, env });
}

/** Convenience: fires Stop (the batched-generation trigger) for `sessionId`/`cwd`. */
export function fireStop(cwd: string, env: Record<string, string>, sessionId: string, promptId?: string): FireHookResult {
  return fireHook(buildHookPayload({ sessionId, promptId, cwd, hookEventName: "Stop" }), { cwd, env });
}

/**
 * A realistic single "turn": PreToolUse (seeds the pre-work checkpoint),
 * the caller's own file edit happens between these two calls, PostToolUse
 * (captures whatever changed), then Stop (batches everything captured-but-
 * unresolved into at most one generation attempt). Mirrors exactly what a
 * real Claude Code turn fires, in order — see `src/cli.ts`'s
 * `runInternalHook` for the authoritative event handling this exercises.
 */
export function fireFullTurn(
  cwd: string,
  env: Record<string, string>,
  sessionId: string,
  promptId: string,
  editFiles: () => void
): { pre: FireHookResult; post: FireHookResult; stop: FireHookResult } {
  const pre = firePreToolUse(cwd, env, sessionId, promptId);
  editFiles();
  const post = firePostToolUse(cwd, env, sessionId, promptId);
  const stop = fireStop(cwd, env, sessionId, promptId);
  return { pre, post, stop };
}
