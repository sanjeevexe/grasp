import Database from "better-sqlite3";
import { captureDiffBetweenTrees, emptyCapturedDiff, writeWorktreeTree } from "./gitDiffCapture";
import { AgentAdapter, CapturedDiff } from "./agentAdapter";
import { isMissingGitObjectError } from "../git";
import { loadConfig } from "../config";
import { evaluateCapturedDiff, FilterResult } from "../filter";
import { GraspConfig } from "../types";
import {
  completeTurn,
  getCheckpointTree,
  insertCapturedDiff,
  insertCheckpointTreeIfAbsent,
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
 * `onSessionComplete`, despite the interface's original name implying a
 * whole session. As built, `onSessionComplete` just marks the turn done;
 * it does not flush or present a queue — the project moved to on-demand
 * `grasp review` instead of gating on completion (see
 * grasp-project-brief.md's status note and README's architecture section).
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
   * the full design.
   *
   * The claim (read previous checkpoint, decide whether there's a real
   * transition, record the capture, advance the checkpoint) all happens
   * inside one `BEGIN IMMEDIATE` transaction — see `claimTransition` below
   * and DECISIONS.md's "Atomic checkpoint claiming" entry. This closes two
   * real bugs found by an independent test pass: (1) overlapping hook
   * processes (e.g. several `PostToolUse` firings for near-simultaneous
   * tool calls) used to each read the same stale checkpoint before any of
   * them advanced it, so all of them captured the identical diff; (2) a
   * config error thrown while loading/filtering used to surface *after*
   * the checkpoint had already been advanced (and, being thrown from an
   * un-awaited async call, as an unhandled rejection that could kill the
   * hook process outright), so the diff that triggered it was silently
   * lost forever. Now the checkpoint only advances if the capture was
   * durably recorded — an error rolls the whole transaction back, leaving
   * the checkpoint exactly where it was so the same diff is retried on the
   * next firing.
   *
   * As of the reliability rework (see DECISIONS.md's "Batched-at-Stop
   * generation" entry), this method ONLY captures — it no longer calls
   * `runGeneration` itself. `PostToolUse` fires once per tool call, and a
   * single Claude Code turn routinely makes several tool calls in quick
   * succession; generating immediately here meant every one of those calls
   * competed for the same one-at-a-time per-session generation slot on a
   * hard clock it didn't control, and a call queued behind an earlier one
   * could run out of runway and time out through no fault of its own.
   * Generation now happens once per `Stop` firing (once per turn, not once
   * per tool call), covering everything captured-but-unresolved for this
   * (session, repo) in one batched attempt — see `runBatchGeneration` in
   * generation.ts and its call site in cli.ts's `runInternalHook`.
   *
   * `ensureCheckpointSeeded()` is expected to have already run earlier in
   * this same hook invocation (see cli.ts's `runInternalHook`), so a
   * checkpoint should already exist by the time this is called — the
   * defensive re-seed below only matters if that invariant is ever broken.
   */
  checkAndCapture(): CapturedDiff {
    const currentTree = writeWorktreeTree(this.repoPath);
    const claim = this.claimTransition(currentTree);

    if (!claim.claimed) {
      return emptyCapturedDiff(this.repoPath);
    }

    return claim.diff;
  }

  /**
   * The atomic claim itself. `BEGIN IMMEDIATE` acquires SQLite's write lock
   * up front (rather than lazily on first write, as a plain/deferred
   * transaction would), so a second process racing this one genuinely
   * blocks until the first commits — not merely "blocks on its own first
   * write after having already read stale state," which is what let
   * duplicate hook processes slip through before. `busy_timeout` (store.ts)
   * governs how long a blocked process waits for the lock.
   */
  private claimTransition(
    currentTree: string
  ):
    | { claimed: true; diff: CapturedDiff; verdict: FilterResult; config: GraspConfig }
    | { claimed: false } {
    const run = this.db.transaction(() => {
      const previousTree = getCheckpointTree(this.db, this.sessionId, this.repoPath);

      if (previousTree === null) {
        // First observation of this session+repo inside a transaction
        // (ensureCheckpointSeeded should already have handled this — see
        // its own doc comment — this is the defensive fallback). Nothing
        // "new" to report; this current state IS the baseline.
        insertCheckpointTreeIfAbsent(this.db, this.sessionId, this.repoPath, currentTree);
        return { claimed: false as const };
      }

      if (previousTree === currentTree) {
        // Nothing changed since the last capture — including the case
        // where another process already claimed and advanced to exactly
        // this state (the scenario that used to duplicate work).
        return { claimed: false as const };
      }

      const diffHash = `${previousTree}..${currentTree}`;
      let diff: CapturedDiff;
      try {
        diff = captureDiffBetweenTrees(this.repoPath, previousTree, currentTree, diffHash);
      } catch (err) {
        if (isMissingGitObjectError(err)) {
          // The stored checkpoint tree object no longer exists — e.g. `git
          // gc`/`git prune` reclaimed it, since Grasp's checkpoints are
          // deliberately unreferenced dangling trees (see
          // gitDiffCapture.ts's checkpoint module doc). The prior state is
          // genuinely gone at the git level; there's no diff to recover.
          // Re-seed to the current state so capture self-heals on the NEXT
          // firing instead of failing forever — see DECISIONS.md's
          // "checkpoint object pruned" entry.
          setCheckpointTree(this.db, this.sessionId, this.repoPath, currentTree);
          return { claimed: false as const };
        }
        throw err;
      }

      // Persisting to captured_diffs IS part of this phase's job: a hook
      // firing is a background process with no attached terminal, so the
      // SQLite store (not stdout) is the only way this capture is
      // observable at all. Every capture is run through Phase 4's
      // mechanical filter before being recorded — see DECISIONS.md's
      // "Filtered-diff recording" entry: a filtered-out diff still gets a
      // row here (filtered=1, filter_reason=<why>), it just never reaches
      // generation. `loadConfig` can throw (missing/invalid config) — that
      // throw propagates out of this whole transaction and rolls it back,
      // per this method's own doc comment above.
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
        // Persisted now (not recomputed later) so the eventual batched-at-
        // Stop generation attempt uses exactly what the filter saw at
        // capture time — see store.ts's captured_diffs schema comment.
        significantFiles: verdict.passed ? verdict.significantFiles : null,
      });

      // Advance the checkpoint LAST, only once the capture is durably
      // recorded — see this method's doc comment for why ordering here is
      // load-bearing, not incidental.
      setCheckpointTree(this.db, this.sessionId, this.repoPath, currentTree);

      return { claimed: true as const, diff, verdict, config };
    });

    return run.immediate();
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
   *
   * `insertCheckpointTreeIfAbsent` (not the unconditional upsert
   * `setCheckpointTree`) is used for the actual write: if another process
   * raced this one and already seeded (or even already advanced past
   * seeding) between the read above and this write, an unconditional
   * upsert here could clobber real progress back to a stale snapshot. An
   * `INSERT OR IGNORE` can't do that — it only ever writes when no row
   * exists yet.
   */
  ensureCheckpointSeeded(): void {
    if (getCheckpointTree(this.db, this.sessionId, this.repoPath) !== null) return;
    const tree = writeWorktreeTree(this.repoPath);
    insertCheckpointTreeIfAbsent(this.db, this.sessionId, this.repoPath, tree);
  }

  /**
   * Interface-conformance entry point for `AgentAdapter.onChangeDetected` —
   * standalone equivalent of what `checkAndCapture`'s transaction does
   * internally, for any future caller that already has a diff in hand and
   * isn't going through the checkpoint-claim path itself (nothing in this
   * codebase currently calls this directly; `checkAndCapture` is
   * self-contained precisely so it doesn't need to). Capture-only, matching
   * `checkAndCapture` — see that method's doc comment for why generation no
   * longer happens here either: it's batched at `Stop` via
   * `runBatchGeneration`, not triggered per capture.
   */
  async onChangeDetected(diff: CapturedDiff): Promise<void> {
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
      significantFiles: verdict.passed ? verdict.significantFiles : null,
    });
  }

  /**
   * Marks this turn complete. Idempotent: if some other invocation already
   * completed this exact (sessionId, promptId) turn, this safely does
   * nothing rather than re-running completion side effects. Does not flush
   * or present any queue — the as-built architecture surfaces questions via
   * on-demand `grasp review` (see README) rather than gating on turn/session
   * completion, so this only needs to prove the "exactly once per turn"
   * boundary is real and detectable; the `Stop` hook's own nudge message is
   * handled separately in `src/cli.ts`.
   */
  async onSessionComplete(): Promise<void> {
    completeTurn(this.db, { sessionId: this.sessionId, promptId: this.promptId });
  }

  /** Ensures the underlying cc_turns row exists, independent of which hook calls it first. */
  ensureTurnStarted(): void {
    upsertTurn(this.db, { sessionId: this.sessionId, promptId: this.promptId, repo: this.repoPath });
  }
}
