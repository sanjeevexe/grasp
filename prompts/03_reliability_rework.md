# Grasp — Prompt 3 of 4: generation reliability rework

You're working in the Grasp CLI codebase (`grasp-cli`). This is the third of
four prompts run in sequence, each on its own git branch, merged into `main`
only after its own tests pass. Prompts 1 and 2 should already be merged into
`main` — branch off current `main`. Read `grasp-project-brief.md`,
`BUILD_PLAN.md`, and `DECISIONS.md` fresh before starting; they take
precedence over anything below if they've changed since this was written.

**Work directly on the current branch — do not create, rename, or switch to
a different git branch yourself.** The branch is already set up for you
before you start; committing anywhere else breaks the orchestration around
this run.

**This is the highest-risk prompt of the four** — it changes the core
generation architecture that's actively relied on for real, current
dogfooding. Take your time, reason carefully about the existing code before
changing it, and lean on the mandatory `DECISIONS.md` logging below rather
than guessing silently through the genuinely open design points.

## Why this exists (real bug, not speculative)

A real dogfooding session found two compounding problems, confirmed directly
against `~/.grasp/history.db` rows, not hypothesized:

1. **Multiple hooks compete for one shared per-session generation slot, on a
   hard clock they don't control.** `checkAndCapture()` in
   `src/adapters/claudeCodeAdapter.ts` currently calls `runGeneration`
   immediately on every single `PostToolUse` firing — i.e. once per tool
   call, not once per turn. When Claude Code fires several tool calls close
   together (extremely common — a single turn making two or three edits is
   the norm, not the exception), each one competes for the same one-at-a-
   time generation slot (`acquireGenerationSlot` in `src/generation.ts`),
   all bounded by Claude Code's own hard 45-second hook-kill ceiling
   (`HOOK_TIMEOUT_MS`). A later call queued behind an earlier one can run out
   of runway and time out — not because the API was slow, but purely because
   it was waiting its turn.

2. **A single timeout permanently and silently blocks the rest of that
   session.** `hasUnknownCostFailure` (`src/store.ts`) halts ALL further
   generation for a session, forever, the moment any one call's true cost
   becomes unknowable (a timeout kill with no recoverable cost envelope).
   Every subsequent diff in that session — including the most significant
   one — gets silently recorded as `miss_reason: "cap_reached"`, identical
   to and indistinguishable from an actual cap hit, even though neither real
   cap was anywhere close to being met.

This prompt fixes both, by removing the dollar-cost cap entirely (making the
whole "unknown cost" problem moot) and by moving generation from "once per
tool call" to "once per turn, batched, retried if it fails" — which removes
the multi-call queuing that caused the timeout in the first place.

## 1. Remove `costCapUsd` and the unknown-cost-halt mechanism entirely

- Remove `costCapUsd` from `GraspConfig`, `DEFAULT_CONFIG`,
  `KNOWN_TOP_LEVEL_KEYS`, and its validation block in
  `validateConfigOverride` (`src/config.ts`).
- Remove the `spentSoFar >= config.costCapUsd` check in `runGeneration`
  (`src/generation.ts`).
- Remove `hasUnknownCostFailure` (`src/store.ts`) and its call site in
  `runGeneration`.
- `questionsPerSessionCap` becomes the sole safety rail — no code change
  needed to that check itself, it already exists and already works
  correctly on its own.
- **Judgment call:** decide whether to keep `cost_usd`/`cost_unknown` on the
  `events` table and `EventRecord` purely as informational/audit metadata
  (no functional role anymore — nothing gates on them), or remove them as
  dead weight now that nothing reads them for enforcement. Either is
  defensible; **log your choice and reasoning to `DECISIONS.md`** before
  moving on. If you keep them, make sure nothing in `grasp export` (Prompt 2,
  already merged) or elsewhere is left referencing a cap that no longer
  exists.
- Any existing repo/global `.grasp.json`/`config.json` files containing a
  `costCapUsd` key will now fail `validateConfigOverride`'s "unknown key"
  check — this is correct/intended (same posture as any other now-removed
  key), but make sure the error message a user would see is still clear
  about what changed, not just "unknown key."

## 2. Move generation from per-tool-call to batched-at-Stop, with retry

Read `src/adapters/claudeCodeAdapter.ts` and the `captured_diffs`/`cc_turns`
schema in `src/store.ts` fully before changing anything — the mechanism
below needs to build on what's actually there, not a guess at it.

**Required behavior, non-negotiable:**
- `PostToolUse` keeps doing exactly what it does today for capture: diff,
  mechanically filter, record into `captured_diffs` (via
  `insertCapturedDiff`), advance the checkpoint. It must **no longer** call
  `runGeneration` itself.
- At `Stop`, before (or as part of) the existing `onSessionComplete()` /
  pending-message logic, gather every `captured_diffs` row for that
  `session_id` that passed the mechanical filter (`filtered = 0`) and has
  not yet been resolved by a generation attempt (see below — you'll need a
  new way to track this; `captured_diffs` currently has no such column).
  Run **at most one** judge-call attempt per `Stop` firing, covering
  everything gathered, not one attempt per underlying diff.
- A successful attempt — produces a real question, OR the judge legitimately
  decides nothing's worth asking, OR the question cap is genuinely hit —
  must mark every diff it covered as resolved. They must never be
  reconsidered again.
- A failed/timed-out attempt must leave every diff it covered unresolved, so
  a later opportunity retries them (combined with whatever's newly
  accumulated by then) instead of losing them permanently.
- The resulting single `events` row for a batch should represent the union
  of what it covered — concatenate the covered diffs' significant files into
  one combined `diffFiles` array and a combined `diffSummary` string. Note
  that `grasp review`'s existing rendering (`flattenDiffFiles` in
  `src/reviewApp.tsx`) already just iterates over a `DiffFile[]` — a batch of
  several diffs' files is not fundamentally different from what it already
  renders today, no UI change should be needed for this specifically.
  `buildJudgePrompt`/`formatDiffForPrompt` (`src/generation.ts`) will need to
  present multiple diffs as clearly separated sections in the prompt (e.g.
  labeled "Change 1 of N", "Change 2 of N") so the judge can reason about
  them as one coherent batch and still produce its existing single
  concept+instance question-pair contract — the response contract itself
  should not need to change.

**Open design points — there is more than one reasonable way to build the
"resolved" tracking and the "what happens if a session ends with unresolved
diffs still pending" case. Design this yourself, reading the existing schema
first, and log the concrete mechanism plus your reasoning to `DECISIONS.md`
before implementing.** At minimum, your design must answer, and your
`DECISIONS.md` entry must state:
- Exactly how a `captured_diffs` row's resolved/unresolved status is tracked
  (a new column is the likely answer, but decide its exact shape).
- What happens to diffs still unresolved when a session simply ends with no
  further `Stop` firing for it (this is expected to happen sometimes — a
  session that never gets another turn has no further opportunity to retry
  under a strict "only at Stop, only for that session" reading). A reasonable
  minimum bar: retry on the very next hook firing for that specific
  session if one occurs; permanently-abandoned sessions' unresolved diffs
  staying unresolved forever is an acceptable, documented edge case (nothing
  is corrupted or lost from the user's perspective — `grasp review` simply
  never had anything to show for that diff, same as if it had been filtered
  out) — but state clearly whether this is what you built, or something
  more robust.
- How this interacts with `acquireGenerationSlot`'s existing per-session
  serialization — a single batched attempt still needs the same one-at-a-
  time-per-session protection it has today (relevant now for
  `questionsPerSessionCap`'s own race-safety, not cost), so don't remove
  that mechanism, just confirm/adjust how it composes with the new batching.

## 3. A specific message when the question cap is actually hit

Now that `cap_reached` can only ever mean the question cap (cost cap is
gone), the `Stop` hook's message-building in `src/cli.ts` (see
`pendingQuestionsMessage`/`costSummaryMessage` and where they're combined in
`runInternalHook`) should say so plainly when it happens: something like
"You've hit this session's question cap (N) — start a new Claude Code
session, or run `grasp set questions-cap <n>` to raise it." (that command
exists — it shipped in Prompt 2, already merged). Combine this with the
existing pending/spend message parts the same way those already combine with
each other, don't replace them.

## Documentation

Update `README.md` and `TESTING_GUIDE.md` everywhere they currently describe
`costCapUsd`, cost-cap testing steps (`TESTING_GUIDE.md`'s "Lower the cost
cap way down..." checklist item no longer applies and should be removed or
replaced), or generation happening per-tool-call rather than batched-at-Stop.
The "Known limitations" section of `TESTING_GUIDE.md` mentioning
`cap_reached` ambiguity between the two caps should be corrected or removed
now that there's only one cap.

## Verification

This prompt changes the most load-bearing part of the tool — verify more
thoroughly than usual, not just "tests pass":
- `npm run build` and `npm test` must pass clean.
- Specifically exercise: a single tool call producing one question (still
  works as before); multiple rapid tool calls in one turn producing one
  combined batched question at `Stop` (the actual bug fix — confirm this no
  longer produces the multi-call queuing/timeout pattern); a simulated
  generation failure leaving diffs unresolved and confirm they're picked up
  on a later firing rather than lost; the question cap being hit and
  producing the new specific message.
- Confirm nothing still references `costCapUsd` anywhere (config files,
  README, TESTING_GUIDE, code comments describing the old behavior as
  current).

## When you're done

Commit your work with a clear, descriptive message. Then write a file named
`.grasp-prompt-status` at the repo root containing exactly one line:

```
DONE
```

If you hit something you genuinely cannot resolve, stop, leave the repo as
it is, and write `.grasp-prompt-status` containing:

```
BLOCKED: <one clear sentence on what you were doing and exactly what stopped you>
```

Given how central this change is, if you find yourself genuinely unsure
whether a design choice is safe rather than just "one of several reasonable
options," prefer stopping and writing a clear `BLOCKED` status over guessing
— this is running unattended overnight with no one to ask.
