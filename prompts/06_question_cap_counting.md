# Grasp — Prompt 6: question caps count real questions, not event-rows

You're working in the Grasp CLI codebase (`grasp-cli`). Second of six prompts in this batch. Read `grasp-project-brief.md`, `BUILD_PLAN.md`, and `DECISIONS.md` fresh before starting.

**Branching:** you should already be on `feature/06-question-cap-counting`, branched off `feature/05-help-cleanup`, per that prompt's closing instructions. If not, create it now off the current branch. Do not merge into `main` yourself.

## The problem

`questionsPerSessionCap` and `scanQuestionsCap` both stop generation once a session has produced N `events` rows — but one event can carry ONE real question (instance-only, when the concept was already known) or TWO (a concept+instance "both" pair). This means a cap of 8 can silently let a session accumulate up to 16 actual questions to answer, which doesn't match what a "cap" should mean to someone trying to bound their own workload. This is a real, deliberate decision from well before this batch, not a recent bug — but it's being changed now on request.

Read `getSessionQuestionCount` in `src/store.ts` and every call site (`src/generation.ts`'s cap check inside `runGeneration`/`executeGenerationAttempt`, and `src/scan.ts`'s `runScanWalk` cap check) before changing anything.

## Required behavior

- Change `getSessionQuestionCount` to count real, individual questions, not event-rows: for every real (non-miss, `question_type IS NOT NULL`) event in the session, count `question_concept IS NOT NULL` as 1 and `question_instance IS NOT NULL` as 1 (so a "both" event contributes 2, an "instance"-only event contributes 1). This is the one function both the diff-side cap (`questionsPerSessionCap`) and the scan-side cap (`scanQuestionsCap`) already read — fixing it here fixes both automatically, since both already call this exact function. Confirm this is genuinely true by tracing both call sites before assuming it.
- Keep the existing "check before generating, not after" pattern: the cap check still happens *before* a judge call is attempted, comparing the current real-question count against the configured cap. A single attempt that pushes the count from, say, 7 to 9 (because it turned out to be a "both" pair) is accepted as a legitimate final state, not preemptively blocked or split — this is the same posture the cap already has today, just recalibrated to a finer unit. The cap can now overshoot by at most 1 extra question (the second half of one "both" pair), not by up to a whole event's worth as before.
- **Do not touch** `getPendingQuestions`, `pendingQuestionsMessage`, or any "N of M pending" batch-count messaging in `grasp review`/`grasp scan`. Those intentionally count *events* (coherent review units you work through one at a time), which is a different, still-correct concept from the cap's "how many individual questions has this session generated." Changing those wasn't requested and would be a separate, unrelated change — leave them exactly as they are.
- Log the boundary-condition choice above (check-before, accept-slight-overshoot) to `DECISIONS.md` — it's a small judgment call worth a quick record even though the direction was specified here, per this project's standing instruction (see `./CLAUDE.md`).

## Verification

- `npm run build` and `npm test` must pass clean.
- Find and update the existing test(s) covering the cap (e.g. `runGeneration: questions-per-session cap stops generation after N real questions` in `test/generation.test.ts`, and the scan-side equivalent in `test/scanWalk.test.ts`) to actually exercise the corrected semantics — a cap of, say, 3 should stop once 3 real *sub-questions* have been produced, which might mean anywhere from 2 to 3 events depending on the concept/instance mix, not simply "3 events, no matter what." Add a case that specifically constructs a mix of "both" and "instance"-only outcomes and confirms the count reflects sub-questions, not rows.
- Confirm both `grasp set questions-cap` and `grasp set scan-cap` still work end-to-end with the corrected counting (lower a cap to something small, confirm generation stops at the right real-question count, not the old row count).

## When you're done

Commit your work. Create the next branch, `feature/07-retry-command`, off this one, and continue directly to Prompt 7 in this same session.
