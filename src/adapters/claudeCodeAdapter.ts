import Database from "better-sqlite3";
import { captureDiffBetweenTrees, emptyCapturedDiff, writeWorktreeTree } from "./gitDiffCapture";
import { AgentAdapter, CapturedDiff } from "./agentAdapter";
import { loadConfig } from "../config";
import { evaluateCapturedDiff } from "../filter";
import { runGeneration } from "../generation";
import {
  completeTurn,
  getCheckpointTree,
  insertCapturedDiff,
  setCheckpointTree,
  upsertTurn,
} from "../store";

/**
 * Fields Claude Code hooks send on stdin, as documented at
 * https://code.claude.com/docs/en/hooks (fetched live — this environment
 * had no way to run an authenticated live Claude Code session to observe
 * a real firing directly; see DECISIONS.md's "hook payload shape" entry
 * for exactly what was and wasn't possible to verify empirically).
 *
 * `session_id`/`cwd`/`hook_event_name` are documented as present on every
 * event and are treated as reliable. `prompt_id` is documented as "absent
 * until first user input" — plausible it's simply always present by the
 * time PreToolUse/PostToolUse/Stop can fire, but this wasn't independently
 * confirmed, so callers must not assume it's always set (see
 * `resolvePromptId` in this file for the defensive fallback).
 */
export interface ClaudeCodeHookPayload {
  session_id: string;
  prompt_id?: string;
  cwd: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  tool_output?: unknown;
  tool_response_time_ms?: number;
  last_assistant_message?: string;
  tool_use_count?: number;
  tool_error_count?: number;
  // Forward-compatible: hook payloads may carry fields this type doesn't
  // model yet (transcript_path, permission_mode, effort, agent_id, ...).
  [key: string]: unknown;
}

/**
 * Used when a payload's `prompt_id` is missing. Falling back to a single
 * fixed key (rather than e.g. inventing a random one per call) means an
 * uncertain/absent prompt_id degrades to "one turn per whole session_id" —
 * i.e. exactly the coarser behavior the original (pre-verification) Phase 1
 * assumption described — rather than silently fragmenting into many
 * untracked pseudo-turns.
 */
const FALLBACK_PROMPT_ID = "__no_prompt_id__";

export function resolvePromptId(payload: Pick<ClaudeCodeHookPayload, "prompt_id">): string {
  return payload.prompt_id && payload.prompt_id.length > 0 ? payload.prompt_id : FALLBACK_PROMPT_ID;
}

/**
 * Adapts one Claude Code turn (session_id + prompt_id) to the Phase 2
 * AgentAdapter interface. A turn, not a whole interactive CLI session, is
 * this adapter's unit of work — see DECISIONS.md's "Stop fires per turn,
 * not per session" entry for why that's the correct binding for
 * onSessionComplete's "present before final output" semantics despite the
 * name.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly supportsHeadlessSelfInvocation = true;
  readonly reportsCost = true;

  constructor(
    private readonly db: Database.Database,
    private readonly sessionId: string,
    private readonly promptId: string,
    private readonly repoPath: string
  ) {}

  /**
   * Checkpoint-based incremental capture: diffs the current working tree
   * against this session+repo's last recorded checkpoint (not always
   * HEAD), so a `PostToolUse` firing only ever surfaces what's genuinely
   * new since the *previous* firing — never the same unchanged diff twice,
   * and never pre-existing uncommitted work that predates this session.
   * See DECISIONS.md's "Checkpoint-based incremental capture" entry for
   * the full design (this fixes a real bug: every firing used to re-diff
   * the whole working tree against HEAD, so two firings with no new work
   * between them generated and paid for the same question twice).
   *
   * `ensureCheckpointSeeded()` is expected to have already run earlier in
   * this same hook invocation (see cli.ts's `runInternalHook`), so a
   * checkpoint should already exist by the time this is called — the
   * defensive re-seed below only matters if that invariant is ever broken.
   */
  checkAndCapture(): CapturedDiff {
    const currentTree = writeWorktreeTree(this.repoPath);
    const previousTree = getCheckpointTree(this.db, this.sessionId, this.repoPath);

    if (previousTree === null || previousTree === currentTree) {
      // Either the very first observation of this session+repo (nothing
      // "new" to report yet — this current state IS the baseline) or
      // nothing has changed since the last capture. Either way: advance
      // the checkpoint to the current state and report no diff.
      setCheckpointTree(this.db, this.sessionId, this.repoPath, currentTree);
      return emptyCapturedDiff(this.repoPath);
    }

    const diffHash = `${previousTree}..${currentTree}`;
    const diff = captureDiffBetweenTrees(this.repoPath, previousTree, currentTree, diffHash);
    setCheckpointTree(this.db, this.sessionId, this.repoPath, currentTree);

    if (diff.files.length > 0) {
      void this.onChangeDetected(diff);
    }
    return diff;
  }

  /**
   * Establishes this session+repo's checkpoint baseline on the FIRST hook
   * firing Grasp observes for it (of any event type — see cli.ts, which
   * calls this unconditionally before dispatching by event name, the same
   * place `ensureTurnStarted` already runs on every firing). Seeding here
   * rather than lazily inside `checkAndCapture` matters: `checkAndCapture`
   * only runs on `PostToolUse`, i.e. *after* a tool call already ran, so
   * seeding there would silently bake that first tool call's own changes
   * into the "already seen" baseline and never surface them. Seeding as
   * early as possible (typically the session's first `PreToolUse`, which
   * fires before any tool runs) is what makes the baseline genuinely
   * pre-agent-work. A cheap read (does a checkpoint already exist?) short-
   * circuits every firing after the first, so this costs real work
   * (building a tree snapshot) exactly once per session+repo.
   */
  ensureCheckpointSeeded(): void {
    if (getCheckpointTree(this.db, this.sessionId, this.repoPath) !== null) return;
    const tree = writeWorktreeTree(this.repoPath);
    setCheckpointTree(this.db, this.sessionId, this.repoPath, tree);
  }

  async onChangeDetected(diff: CapturedDiff): Promise<void> {
    // Persisting to captured_diffs IS part of this phase's job: a hook
    // firing is a background process with no attached terminal, so the
    // SQLite store (not stdout) is the only way this capture is observable
    // at all — unlike Phase 2's debug:capture, which had a human watching
    // a terminal. Every capture is run through Phase 4's mechanical filter
    // before being recorded — see DECISIONS.md's "Filtered-diff recording"
    // entry: a filtered-out diff still gets a row here (filtered=1,
    // filter_reason=<why>), it just never reaches generation.
    const { config } = loadConfig(this.repoPath);
    const verdict = evaluateCapturedDiff(diff, config);

    insertCapturedDiff(this.db, {
      sessionId: this.sessionId,
      promptId: this.promptId,
      repo: diff.repo,
      capturedAt: diff.capturedAt,
      diff,
      filtered: !verdict.passed,
      filterReason: verdict.reason,
    });

    // A passed diff goes straight into Phase 5's judge+generate call. The
    // cost cap is session-wide (see DECISIONS.md's "Resolving Phase 3's
    // flagged consequence" entry), so `runGeneration` sums cost across
    // this session_id, not just this turn, before deciding whether to
    // invoke `claude -p` at all.
    if (verdict.passed) {
      runGeneration(this.db, {
        sessionId: this.sessionId,
        repo: diff.repo,
        significantFiles: verdict.significantFiles,
        config,
        diffHash: diff.diffHash,
      });
    }
  }

  /**
   * Marks this turn complete. Idempotent: if some other invocation already
   * completed this exact (sessionId, promptId) turn, this safely does
   * nothing rather than re-running completion side effects. Flushing a
   * queue and presenting before final output is Phase 7/8 — this phase
   * only proves the "exactly once per turn" boundary is real and
   * detectable.
   */
  async onSessionComplete(): Promise<void> {
    completeTurn(this.db, { sessionId: this.sessionId, promptId: this.promptId });
  }

  /** Ensures the underlying cc_turns row exists, independent of which hook calls it first. */
  ensureTurnStarted(): void {
    upsertTurn(this.db, { sessionId: this.sessionId, promptId: this.promptId, repo: this.repoPath });
  }
}
