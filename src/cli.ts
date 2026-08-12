#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { ClaudeCodeAdapter, ClaudeCodeHookPayload, resolvePromptId } from "./adapters/claudeCodeAdapter";
import { GitDiffAdapter } from "./adapters/gitDiffCapture";
import { loadConfig } from "./config";
import { resolveRepoRoot } from "./git";
import { evaluateCapturedDiff } from "./filter";
import { runBatchGeneration } from "./generation";
import {
  getBlockingPendingQuestionsForSession,
  getConceptTagsByEventId,
  getEventById,
  getPendingQuestionsForSession,
  getSessionCostUsd,
  insertEvent,
  markEventAnswered,
  openStore,
  recordHookInvocation,
} from "./store";
import { runInit } from "./init";
import { runReview } from "./review";
import { runSetMode, runSetGate, runSetQuestionsCap } from "./set";
import { runResetConfig, runResetHistory } from "./reset";
import { ExportShape, printExportResult, runExportToFile } from "./export";

function readPackageVersion(): string {
  const pkgPath = path.join(__dirname, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  return pkg.version as string;
}

const HELP_TEXT = `grasp — comprehension questions about your AI coding agent's changes, answered on your own schedule in \`grasp review\` (with an optional hard gate on its next action)

Usage:
  grasp --version                Print the installed version
  grasp --help                   Show this help
  grasp init                     Install Grasp's Claude Code hooks into this repo (asks for confirmation)
  grasp review                   Work through pending comprehension questions for this repo, interactively
  grasp review --all             Same, but across every repo Grasp has ever touched
  grasp set mode --easy|--medium|--hard [--global]  Set concept-selection difficulty preference (repo-local, or --global)
  grasp set gate soft|hard [--global]               Set gateMode (repo-local, or --global)
  grasp set questions-cap <n> [--global]            Set questionsPerSessionCap (repo-local, or --global)
  grasp reset config [--global]  Reset config to defaults (deletes .grasp.json locally, or overwrites the global file)
  grasp reset history [--yes]    Irreversibly wipe all stored question/answer history (asks to confirm unless --yes)
  grasp export                   Export your Q&A history to CSV, for your own spreadsheet review
  grasp export --anki            Export concept questions as an Anki-importable Front/Back/Tags CSV
  grasp export --raw             Export every column of every events row, unfiltered
  grasp debug:seed               (dev) Insert one fake event + concept tag, for verifying the local store
  grasp debug:capture <repo>     (dev) Run git-diff capture against <repo> and print the resulting diff object
  grasp debug:answer <event-id>  (dev) Simulate answering an event's concept question (marks its concept tag(s) answered)
  grasp internal:hook            (internal) Claude Code hook entrypoint — reads a hook payload on stdin

v1 status: config loading, local storage, git-diff capture, Claude Code
hook-based capture, mechanical meaningful-change filtering, headless
judge+generate question generation, \`grasp review\` for answering questions
interactively (soft-nudge visibility + opt-in hard-gate), a session-wide
questions-per-session cap with coherent batch grouping/ordering in
\`grasp review\`, and a session-end cost summary + pending-question nudge
surfaced via \`Stop\`'s systemMessage. See README.md for the full picture.
\`grasp watch\` (persistent, auto-popping review) is not built.
`;

function printHelp(): void {
  process.stdout.write(HELP_TEXT);
}

/**
 * Every invocation ensures ~/.grasp/config.json and ~/.grasp/history.db
 * exist (creating them with defaults on first run) — not just debug:seed.
 * This is what makes "first run" in BUILD_PLAN.md's verification steps
 * true regardless of which command the user runs first.
 */
function ensureInitialized(repoRoot: string) {
  const loaded = loadConfig(repoRoot);
  const db = openStore();
  db.close();
  return loaded;
}

function runDebugSeed(): void {
  const repoRoot = resolveRepoRoot(process.cwd());
  const { config, globalConfigPath, repoConfigPath } = loadConfig(repoRoot);
  const db = openStore();

  const eventId = insertEvent(
    db,
    {
      timestamp: new Date().toISOString(),
      repo: repoRoot,
      sessionId: null,
      diffHash: "debug-seed-hash",
      diffSummary: "1 file changed, 4 insertions(+), 1 deletion(-)",
      questionConcept:
        "What's the difference between a mutex and a channel for coordinating goroutines?",
      questionInstance: "Given that, why did this change protect `cache` with a mutex?",
      questionType: "both",
      generationSource: "debug:seed",
      missReason: null,
      answerConcept: null,
      answerInstance: null,
      skipped: false,
      skipReason: null,
      costUsd: 0.0031,
      diffFiles: [
        {
          path: "cache.go",
          oldPath: null,
          status: "modified",
          insertions: 4,
          deletions: 1,
          hunks: [
            {
              header: "@@ -10,5 +10,8 @@ type Cache struct {",
              lines: [
                " type Cache struct {",
                "-  data map[string]string",
                "+  mu   sync.Mutex",
                "+  data map[string]string",
                " }",
              ],
            },
          ],
        },
      ],
    },
    [{ tag: "mutex-vs-channel", answered: false }]
  );

  const tags = getConceptTagsByEventId(db, eventId);

  process.stdout.write(
    [
      `Inserted debug event id=${eventId} into ${db.name}`,
      `Linked concept_tags rows: ${tags.map((t) => `id=${t.id} tag=${t.tag}`).join(", ")}`,
      `Config loaded from: ${globalConfigPath}${
        repoConfigPath ? ` (overridden by ${repoConfigPath})` : " (no repo override present)"
      }`,
      `gateMode=${config.gateMode} questionsPerSessionCap=${config.questionsPerSessionCap}`,
      "",
    ].join("\n")
  );

  db.close();
}

function runDebugAnswer(eventIdArg: string | undefined): void {
  const eventId = Number(eventIdArg);
  if (!eventIdArg || !Number.isInteger(eventId)) {
    process.stderr.write("Usage: grasp debug:answer <event-id>\n");
    process.exitCode = 1;
    return;
  }

  const db = openStore();
  try {
    const event = getEventById(db, eventId);
    if (!event) {
      process.stderr.write(`No event with id=${eventId} found in ${db.name}\n`);
      process.exitCode = 1;
      return;
    }

    const tags = markEventAnswered(db, eventId, {
      answerConcept: event.questionConcept ? "(debug:answer stub) understood" : null,
      answerInstance: event.questionInstance ? "(debug:answer stub) understood" : null,
    });

    process.stdout.write(
      [
        `Marked event id=${eventId} answered.`,
        tags.length > 0
          ? `concept_tags now answered: ${tags.join(", ")}`
          : "(this event had no linked concept_tags — nothing to mark)",
        "",
      ].join("\n")
    );
  } finally {
    db.close();
  }
}

function runDebugCapture(repoPathArg: string | undefined): void {
  if (!repoPathArg) {
    process.stderr.write("Usage: grasp debug:capture <repo-path>\n");
    process.exitCode = 1;
    return;
  }

  const adapter = new GitDiffAdapter(repoPathArg);
  const diff = adapter.checkForChanges();

  if (diff.files.length === 0) {
    process.stdout.write(`No changes detected in ${diff.repo}\n`);
    return;
  }

  const summaryLines = diff.files.map(
    (f) =>
      `  ${f.status.padEnd(8)} ${f.oldPath ? `${f.oldPath} -> ` : ""}${f.path}  (+${f.insertions}/-${f.deletions}, ${f.hunks.length} hunk${f.hunks.length === 1 ? "" : "s"})`
  );

  const { config } = loadConfig(diff.repo);
  const verdict = evaluateCapturedDiff(diff, config);
  const filterLines = verdict.passed
    ? [
        `PASSED — ${verdict.significantFiles.length} significant file(s), ${verdict.totalChangedLines} changed lines total (max single file: ${verdict.maxSingleFileChangedLines})`,
      ]
    : [`FILTERED — reason: ${verdict.reason}`];
  if (verdict.excludedFiles.length > 0) {
    filterLines.push(
      "  excluded:",
      ...verdict.excludedFiles.map((f) => `    ${f.path} (${f.reason})`)
    );
  }

  process.stdout.write(
    [
      `Captured diff for ${diff.repo} at ${diff.capturedAt}`,
      `${diff.files.length} file(s) changed:`,
      ...summaryLines,
      "",
      "--- Phase 4 filter verdict ---",
      ...filterLines,
      "",
      "--- full CapturedDiff object (JSON) ---",
      JSON.stringify(diff, null, 2),
      "",
    ].join("\n")
  );
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

/**
 * "There's still a pending question for this session" message, shared by
 * the PreToolUse deny reason and the Stop systemMessage nudge so the two
 * don't drift into inconsistent wording.
 */
function pendingQuestionsMessage(count: number): string {
  return `${count} question${count === 1 ? "" : "s"} waiting — run \`grasp review\` to answer ${count === 1 ? "it" : "them"}.`;
}

/**
 * Brief §3.3's "cumulative session spend visible to the user, not just
 * logged" — see DECISIONS.md's "session-end cost summary" entry for why
 * this lives on `Stop` (the only channel a hook has to say anything at
 * all) and why 4 decimal places (real per-call costs are sub-cent; 2
 * decimals would round most of them to "$0.00" and hide the exact signal
 * this exists to surface). Purely informational now that there's no
 * dollar-cost cap to enforce (see DECISIONS.md's "Remove costCapUsd" entry)
 * — spend transparency (brief §3.5) is the only remaining reason to show it.
 */
function costSummaryMessage(costUsd: number): string {
  return `$${costUsd.toFixed(4)} spent generating comprehension questions this session so far.`;
}

/**
 * Now that `cap_reached` can only ever mean the questions-per-session cap
 * (the dollar-cost cap is gone — see DECISIONS.md's "Remove costCapUsd and
 * the unknown-cost-halt mechanism" entry), the `Stop` message says so
 * plainly and points at the actual way out, rather than leaving the user to
 * infer it from a generic "N questions waiting" nudge.
 */
function questionCapMessage(cap: number): string {
  return `You've hit this session's question cap (${cap}) — start a new Claude Code session, or run \`grasp set questions-cap <n>\` to raise it.`;
}

/**
 * Claude Code hook entrypoint. Must NEVER throw, hang, or exit non-zero —
 * a hook that crashes would block the user's real Claude Code session
 * regardless of gateMode. Every failure mode below is caught and
 * swallowed rather than propagated. Hooks never render UI themselves (see
 * DECISIONS.md's TTY-access finding) — they only write state and, for
 * PreToolUse under hard-gate, emit the documented deny JSON; presentation
 * always happens in a separately-launched `grasp review`.
 */
async function runInternalHook(): Promise<void> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    return;
  }

  let payload: ClaudeCodeHookPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const sessionId = payload.session_id;
  const eventName = payload.hook_event_name;
  const cwd = payload.cwd;
  if (!sessionId || !eventName || !cwd) {
    return;
  }

  const promptId = resolvePromptId(payload);
  // Resolved once per firing, not per hook-event branch: Claude Code's own
  // `cwd` for a session is wherever the user happened to launch it from,
  // which is often a subdirectory of the actual repo (e.g. `cd src &&
  // claude`). Config overrides, checkpoints, and the hard-gate check all
  // need to key off the repo ROOT consistently, or a repo's `.grasp.json`
  // (gate mode, caps, ignore patterns) silently stops applying the moment
  // someone's session cwd isn't the exact repo root — see DECISIONS.md's
  // "Repo-root resolution" entry for the bug this fixes.
  const repoRoot = resolveRepoRoot(cwd);
  let hookOutput: Record<string, unknown> | null = null;

  try {
    const db = openStore();
    try {
      recordHookInvocation(db, { sessionId, promptId, eventName });
      const adapter = new ClaudeCodeAdapter(db, sessionId, promptId, repoRoot);
      adapter.ensureTurnStarted();
      // Unconditional on every firing, same as ensureTurnStarted above — a
      // cheap read that only does real work (building a tree snapshot) the
      // first time this session+repo is ever seen. Must run before any
      // PostToolUse capture so the checkpoint baseline reflects the state
      // BEFORE the first tool call, not after — see DECISIONS.md's
      // "Checkpoint-based incremental capture" entry.
      adapter.ensureCheckpointSeeded();

      if (eventName === "PostToolUse") {
        adapter.checkAndCapture();
      } else if (eventName === "Stop") {
        // Batched-at-Stop generation (see DECISIONS.md's "Batched-at-Stop
        // generation" entry): gathers everything captured-but-unresolved
        // for this (session, repo) since the last successful attempt and
        // runs at most one judge call covering all of it, before the
        // pending/cost/cap message below is built — so a question this
        // very attempt just produced (or a cap it just hit) is reflected
        // in the same message, not one turn late.
        const { config } = loadConfig(repoRoot);
        const batchOutcome = runBatchGeneration(db, { sessionId, repo: repoRoot, config });
        await adapter.onSessionComplete();
        // Visibility nudge — applies in BOTH gate modes, since it's the
        // only channel a hook actually has for reaching the user (the
        // narrowly-restricted terminalSequence field aside). See
        // DECISIONS.md's "gate-check scope" entry for why this is
        // session_id-scoped, matching the hard-gate check below. The cost
        // summary and question-cap notice are combined into the same
        // message when they apply — see DECISIONS.md's "session-end cost
        // summary" entry for why this is the one place it surfaces and why
        // these independently-gated pieces combine rather than firing as
        // separate messages.
        const pending = getPendingQuestionsForSession(db, sessionId);
        const spentSoFar = getSessionCostUsd(db, sessionId);
        const messageParts: string[] = [];
        if (pending.length > 0) messageParts.push(pendingQuestionsMessage(pending.length));
        if (spentSoFar > 0) messageParts.push(costSummaryMessage(spentSoFar));
        if (batchOutcome?.missReason === "cap_reached") {
          messageParts.push(questionCapMessage(config.questionsPerSessionCap));
        }
        if (messageParts.length > 0) {
          hookOutput = { systemMessage: messageParts.join(" ") };
        }
      } else if (eventName === "PreToolUse") {
        const { config } = loadConfig(repoRoot);
        if (config.gateMode === "hard") {
          // Deliberately the age-limited query, not getPendingQuestionsForSession
          // — see DECISIONS.md's "Stale pending question cutoff" entry for
          // why a resumed session shouldn't be blocked by work left over
          // from days ago, even though it's technically the same session_id.
          const pending = getBlockingPendingQuestionsForSession(db, sessionId);
          if (pending.length > 0) {
            hookOutput = {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: pendingQuestionsMessage(pending.length),
              },
            };
          }
        }
      }
    } finally {
      db.close();
    }
  } catch (err) {
    try {
      process.stderr.write(`grasp internal:hook: ${(err as Error).message}\n`);
    } catch {
      // even the error report must not throw
    }
    return;
  }

  if (hookOutput) {
    try {
      process.stdout.write(JSON.stringify(hookOutput));
    } catch {
      // never let a stdout write failure propagate either
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  // internal:hook must never let ensureInitialized's config validation
  // (which can throw on a malformed .grasp.json) escape to this function's
  // own top-level catch below, which sets exitCode = 1 — that would make
  // Claude Code show a hook-error notice on every firing until the config
  // is fixed, contradicting runInternalHook's own "never exit nonzero"
  // contract. runInternalHook() does its own initialization (openStore(),
  // loadConfig() where actually needed) inside its all-swallowing try/catch,
  // so it doesn't need ensureInitialized() run ahead of it. See
  // DECISIONS.md's "internal:hook must not run ensureInitialized" entry.
  if (command === "internal:hook") {
    await runInternalHook();
    return;
  }

  ensureInitialized(process.cwd());

  if (command === undefined || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-v") {
    process.stdout.write(`${readPackageVersion()}\n`);
    return;
  }

  if (command === "debug:seed") {
    runDebugSeed();
    return;
  }

  if (command === "debug:capture") {
    runDebugCapture(args[1]);
    return;
  }

  if (command === "debug:answer") {
    runDebugAnswer(args[1]);
    return;
  }

  if (command === "init") {
    // Same repo-root resolution as the hook path (see runInternalHook) —
    // running `grasp init` from a subdirectory should install hooks and
    // write `.grasp.json` at the actual repo root, matching where
    // ClaudeCodeAdapter/loadConfig look for them, not the exact directory
    // the command happened to be run from.
    await runInit(resolveRepoRoot(process.cwd()));
    return;
  }

  if (command === "review") {
    // Hand-rolled, matching this codebase's existing no-framework argument
    // handling (see DECISIONS.md's "No CLI argument-parsing framework"
    // entry) — a single boolean flag doesn't justify pulling one in.
    const all = args.slice(1).includes("--all");
    await runReview({ all });
    return;
  }

  if (command === "set") {
    // Same repo-root resolution every other repo-scoped command uses —
    // `grasp set ...` (no --global) writes to the actual repo root's
    // .grasp.json, not wherever the command happened to be invoked from.
    const repoRoot = resolveRepoRoot(process.cwd());
    const subcommand = args[1];
    const rest = args.slice(2);
    if (subcommand === "mode") {
      runSetMode(rest, { repoRoot });
      return;
    }
    if (subcommand === "gate") {
      runSetGate(rest, { repoRoot });
      return;
    }
    if (subcommand === "questions-cap") {
      runSetQuestionsCap(rest, { repoRoot });
      return;
    }
    process.stderr.write("Usage: grasp set mode|gate|questions-cap ...\n");
    process.exitCode = 1;
    return;
  }

  if (command === "reset") {
    const repoRoot = resolveRepoRoot(process.cwd());
    const subcommand = args[1];
    const rest = args.slice(2);
    if (subcommand === "config") {
      runResetConfig(rest, { repoRoot });
      return;
    }
    if (subcommand === "history") {
      await runResetHistory(rest, { openDb: () => openStore() });
      return;
    }
    process.stderr.write("Usage: grasp reset config|history ...\n");
    process.exitCode = 1;
    return;
  }

  if (command === "export") {
    const rest = args.slice(1);
    const wantsAnki = rest.includes("--anki");
    const wantsRaw = rest.includes("--raw");
    if (wantsAnki && wantsRaw) {
      process.stderr.write("Usage: grasp export [--anki | --raw] (pick at most one)\n");
      process.exitCode = 1;
      return;
    }
    const shape: ExportShape = wantsAnki ? "anki" : wantsRaw ? "raw" : "default";
    const db = openStore();
    try {
      const result = runExportToFile(db, shape);
      printExportResult(result);
    } finally {
      db.close();
    }
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n\n`);
  printHelp();
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exitCode = 1;
});
