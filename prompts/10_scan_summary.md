# Grasp — Prompt 10: a short summary after each `grasp scan` run

You're working in the Grasp CLI codebase (`grasp-cli`). Sixth and last of six prompts in this batch. Read `grasp-project-brief.md`, `BUILD_PLAN.md`, and `DECISIONS.md` fresh before starting, and read the current state of `src/scan.ts` (after Prompts 8 and 9) fully first — this prompt adds one more piece on top of the chunked, hash-aware walk those built.

**Branching:** you should already be on `feature/10-scan-summary`, branched off `feature/09-scan-rescan-hash`. If not, create it now off the current branch. Do not merge into `main` yourself.

## The problem

Requested addition, confirmed cheap and genuinely useful based on real testing: after a `grasp scan` run, print a short plain-language summary of what that run actually covered — a few sentences, not a deep report. This is a small, separate addition on top of the question-generation flow, not a replacement for it.

## Required behavior

- Track, during the walk, which chunks/files were actually read and processed *this run* (new content read from disk this invocation — not files confirmed unchanged via Prompt 9's hash check with no reprocessing, and not chunks that were already done before this run started). This should be straightforward to collect from the existing walk loop.
- If that list is empty at the end of the run (nothing new was actually read — e.g. a "nothing left to scan" early return, or a run where every touched file's hash check came back trivial/unchanged per Prompt 9), skip the summary entirely. No LLM call, no output for it.
- If the list is non-empty, build a new, small prompt (e.g. `buildScanSummaryPrompt` in `src/generation.ts`) containing the content actually processed this run, and make one additional call through the same subprocess mechanism already used for judge calls (`invokeClaudeJudge`/the `claude -p` invocation pattern) asking for a few sentences of plain-language summary — not a structured question/answer contract, just prose. Read `invokeClaudeJudge`/`parseClaudeEnvelope` first and reuse what applies (particularly cost extraction) rather than building a fully parallel path; a summary call still has a real dollar cost that should be captured and shown, even though it isn't a question.
  - If a lot was processed in one run, consider a reasonable cap on how much raw content goes into the summary prompt itself, to avoid an oversized prompt — use your judgment, document the number you land on.
- Print the summary as plain text after the run completes (and after the review UI, if any questions were also generated and presented this run — the summary is a closing note, not something that interrupts the interactive review flow).
- Print its cost on its own line, **explicitly separate** from the "$ spent generating comprehension questions" line already shown for real question generation — e.g. `"$0.00XX spent generating this summary."` Don't fold it into the tracked session cost total.
- **Do not** write anything about this to the `events` table or any other DB table — this is ephemeral, run-specific output, not part of Grasp's persisted question/answer history. It shouldn't affect `grasp export`, `grasp reset history`'s row counts, or any cap.

## Documentation

Add a short mention of this to `README.md`'s `grasp scan` section and `TESTING_GUIDE.md`.

## Verification

- `npm run build` and `npm test` must pass clean.
- Run `grasp scan` against a small multi-file fixture repo and confirm a summary prints once at the end, accurately describing what was actually walked this run (not the whole repo, not files from a previous run).
- Run `grasp scan` again with nothing new to process (everything already scanned, nothing edited) and confirm no summary attempt is made — no extra call, no cost line for it.
- Confirm the summary's cost is visibly separate from the question-generation cost line, and that neither `grasp export` nor `grasp reset history`'s reported counts are affected by summary calls.
- Use the existing mock-`claude` test fixture pattern (see `test/fixtures/mock-claude/claude` and how other generation tests drive it) to test this without a real network call.

## When you're done

Commit your work. This is the last prompt in the batch — do not create another branch. Give me a summary of all six branches created (`feature/05-help-cleanup` through `feature/10-scan-summary`), confirm each one's tests passed independently at the time it was completed, and stop there for review.
