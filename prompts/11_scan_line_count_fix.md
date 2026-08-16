# Grasp — Prompt 11: fix `grasp scan`'s off-by-one line count

You're working in the Grasp CLI codebase (`grasp-cli`). This fixes a real bug found in `TEST_LOG.md` (branch `test/full-retest`) — read that log's `[BUG]` entry in full before starting, it already has the root cause, exact repro, and every affected call site.

**Branching:** create a new branch off current `main`, e.g. `fix/scan-line-count`. Do not merge into `main` yourself.

## The bug

`src/scan.ts:227` computes a file's line count as `buffer.toString("utf-8").split(/\r\n|\r|\n/).length`. Splitting on a newline pattern produces one extra, empty trailing element whenever the content itself ends in a newline — true of essentially every well-formed text file. A 3-real-line file ending in `\n` reports `length === 4`, not 3. This isn't just cosmetic: it shifts `MAX_SCAN_CEILING_LINES`, `MAX_SCAN_CHUNK_LINES` (via `splitFileIntoChunks`), and `MAX_SCAN_HASH_TRACKING_LINES` boundaries by one, and can produce a spurious near-empty final chunk (a wasted judge call on a phantom blank "line") for any file whose real line count is an exact multiple of `MAX_SCAN_CHUNK_LINES`.

The identical pattern also appears at `src/scan.ts:304` (`checkForFileEdits`'s `currentLineCount` check against `MAX_SCAN_HASH_TRACKING_LINES`) — fix both consistently, ideally by factoring the correct line-counting logic into one shared place (`src/scanChunking.ts` is the designated pure-math module already shared between `scan.ts` and `store.ts` — a `splitFileLines(content: string): string[]` helper there, used everywhere a file's lines are currently computed via the raw `.split(...)` pattern, is a reasonable approach, but use your judgment).

## Required behavior

- Correct line counting: a file with N real, newline-terminated lines should report N, not N+1. A file whose last line is NOT newline-terminated should still report the correct count (don't break that case while fixing this one). Decide the right behavior for a genuinely empty file (0 bytes) — this is a real edge case worth a moment's thought, not necessarily a `DECISIONS.md` entry, but get it right: 0 lines is almost certainly correct, not 1.
- Check `splitFileIntoChunks` (`src/scanChunking.ts`) and `computeValidatedExcerpt`/`formatFileForScanPrompt` (`src/generation.ts`) for any place that assumes the old (buggy) line count and might need adjustment now that counts are correct — trace this rather than assuming only the two call sites named above are affected.
- Update the existing test in `test/scanWalk.test.ts` that currently documents and asserts the *buggy* +1 behavior (`"linesFile appends a trailing newline, so split() reports one extra empty final line"`) to assert the corrected count instead.
- Add a regression test proving: a constructed file with exactly `MAX_SCAN_CHUNK_LINES` real lines (a chunk-boundary edge case) does NOT produce a spurious extra near-empty final chunk after this fix.

## Documentation

Fix `README.md` line 169's stale `questionsPerSessionCap` description — see `TEST_LOG.md`'s `[DOC]` entry for the exact current (wrong) text and what actually happens now. It should describe real per-question counting (a "both" event contributes 2 toward the cap, an instance-only event contributes 1 — matching `DECISIONS.md`'s 2026-08-13 "Question caps count real questions, not event-rows" entry), not the old row-counting behavior. Check whether `scanQuestionsCap`'s own README description nearby has the same staleness and fix it too if so.

## Verification

- `npm run build` and `npm test` must pass clean.
- Construct a real file with a known exact line count (e.g. exactly `MAX_SCAN_CEILING_LINES` real lines, exactly at the boundary) and confirm `grasp scan`'s oversized-skip message (if triggered) reports the correct count, not count+1.
- Confirm the chunk-boundary regression test above passes.
- Confirm `README.md`'s cap description now matches actual behavior (spot check against the same live cap-boundary test methodology `TEST_LOG.md` used, if convenient — not required to reconstruct the whole pass, just don't leave the doc fix unverified against real behavior).

## When you're done

Commit your work with a clear message referencing the `TEST_LOG.md` entry this fixes. Stop there for review — don't merge into `main`.
