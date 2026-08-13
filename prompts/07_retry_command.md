# Grasp — Prompt 7: `grasp retry` and visible generation-failure messaging

You're working in the Grasp CLI codebase (`grasp-cli`). Third of six prompts in this batch. Read `grasp-project-brief.md`, `BUILD_PLAN.md`, and `DECISIONS.md` fresh before starting.

**Branching:** you should already be on `feature/07-retry-command`, branched off `feature/06-question-cap-counting`. If not, create it now off the current branch. Do not merge into `main` yourself.

## The problem

Found via real testing: a `Stop`-triggered batch generation attempt that times out or errors produces **zero visible signal** to the user — the `Stop` message only ever mentions pending count, cost, or the question cap, never a failure. Worse, the *only* way an unresolved diff gets retried today is another `Stop` firing in the exact same Claude Code session that captured it (per the batched-at-Stop design from the reliability rework) — there's no way to manually retry a diff whose session has already ended. A diff can end up permanently stuck with no path back, and the user has no idea it happened.

Read `src/generation.ts`'s `runBatchGeneration`/`executeGenerationAttempt`/`getUnresolvedCapturedDiffs`, and `src/cli.ts`'s `Stop`-handling block (`pendingQuestionsMessage`/`costSummaryMessage`/`questionCapMessage` and where `runBatchGeneration`'s outcome is used) fully before changing anything.

## Required behavior

### 1. Visible failure messaging on `Stop`

When the batch generation attempt for *this* `Stop` firing has `missReason` of `"error"` or `"timeout"`, add a line to the combined `Stop` message (same `messageParts` array `pendingQuestionsMessage`/`costSummaryMessage`/`questionCapMessage` already combine into), something like:

> "A comprehension question failed to generate (timeout) — it'll retry automatically on this session's next turn, or run `grasp retry` now."

Word it clearly for a non-technical reader; distinguish `"timeout"` vs `"error"` in the message if it reads naturally, but don't over-engineer the wording. This combines with the existing pending/cost/cap lines the same way those already combine with each other.

### 2. `getUnresolvedCapturedDiffsForRepo`

A new function in `src/store.ts`: same `WHERE session_id = ? AND repo = ? AND filtered = 0 AND resolved = 0` shape as the existing `getUnresolvedCapturedDiffs`, but scoped to **`repo` only** — across every `session_id`, not just one. This is deliberately broader than the automatic retry-on-next-Stop path, because a manual command has no live session to scope itself to, and the whole point is reaching diffs whose original session is long gone.

### 3. `grasp retry` command

A new, standalone CLI command (`src/cli.ts`, same dispatch pattern as `grasp scan` — `resolveRepoRoot(process.cwd())`, no hook payload, works with no live Claude Code session).

- Gather every unresolved captured diff for the current repo via the function above.
- If there are none, print a clear "nothing to retry" message and exit — don't error, don't hang.
- If there are some, run **one** batch generation attempt covering all of them — reuse `executeGenerationAttempt` (the shared core already built for the batched-at-Stop rework) if its shape fits a repo-wide, cross-session gather; adapt if it doesn't, but don't duplicate its logic wholesale.
- The resulting event needs a `session_id`. Use a fresh synthetic identifier, `retry-${randomUUID()}`, matching the existing precedent `grasp scan` already set for exactly this situation (a manually-invoked command with no live session identity) — see `runScan`'s `scan-${randomUUID()}` in `src/scan.ts`.
- Mark covered diffs resolved only on a genuine outcome (a real question, a legitimate decline, or a cap hit) — never on `error`/`timeout`, so a failed retry attempt leaves its diffs eligible for a *later* retry, exactly like every other resolved-tracking path in this codebase already works.
- Print a clear result message: how many questions were generated (point at `grasp review`), or that nothing was worth asking, or that the attempt itself failed (in which case say so plainly and suggest running `grasp retry` again).

**Open design point — decide and log to `DECISIONS.md`:** should `grasp retry`'s own generation respect `questionsPerSessionCap`? A synthetic `retry-<uuid>` session starts with a real-question count of 0 (per Prompt 6's corrected counting), so in practice the cap can't realistically block a single retry invocation unless someone runs `grasp retry` repeatedly in quick succession. I'd lean toward: yes, still check the cap using that same synthetic session's own accumulated count, for consistency with every other generation path in this codebase rather than special-casing retry to be cap-exempt — but this is a real judgment call, not dictated. Make the call, and write down your reasoning either way.

## Documentation

Add `grasp retry` to the (now-trimmed, per Prompt 5) public help text, `README.md`'s command list, and `TESTING_GUIDE.md`.

## Verification

- `npm run build` and `npm test` must pass clean.
- Simulate a timeout/error outcome (the test suite already has a pattern for forcing this — check `test/generation.test.ts` for how existing timeout/error tests are constructed) and confirm the new `Stop` message line appears, worded correctly for both `timeout` and `error`.
- Confirm `grasp retry` picks up a genuinely unresolved diff left behind by a *different, no-longer-live* `session_id` (not just the current one) and successfully resolves it.
- Confirm `grasp retry` with nothing unresolved prints a clean message and exits without error.
- Confirm a failed `grasp retry` attempt leaves its diffs unresolved (eligible for a subsequent `grasp retry` or a future live-session `Stop` for whichever original session captured them, if it's somehow still active).

## When you're done

Commit your work. Create the next branch, `feature/08-scan-chunking`, off this one, and continue directly to Prompt 8 in this same session.
