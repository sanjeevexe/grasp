# Grasp — Batch 2: six prompts, one continuous session

You're working in the Grasp CLI codebase (`grasp-cli`). This is a batch of six prompts, each targeting a real gap found through actual use of the tool. Run them **in order, in this same session, without stopping between them** unless you hit something you genuinely can't resolve — in that case, just stop and explain exactly where you are and what's blocking you. This is an interactive session, not unattended overnight automation, so there's no special status file to write — just say so directly.

**Before starting anything:** read `grasp-project-brief.md`, `BUILD_PLAN.md`, and `DECISIONS.md` fresh — they reflect current state and take precedence over anything below if they've changed since this was written.

**Branching contract, for every one of the six prompts below:** create a new branch off the branch you're currently on before starting that prompt's work (the first one branches off `main`; every one after that branches off the previous prompt's finished branch, so the six branches form a chain, each building on the last). At the end of each prompt: run `npm run build` and `npm test`, confirm both pass clean, commit your work with a clear message, then immediately create the next branch and continue to the next prompt. **Do not merge any of these branches into `main` yourself** — they're left as a chain for review, exactly like the four-prompt batch that preceded this one. If a prompt's own verification steps fail and you can't resolve it, stop on that branch, don't force a commit, and explain what's wrong.

**Decision logging:** several of these prompts have genuine open design points, explicitly called out as such below. Where called out, design the mechanism yourself after reading the relevant existing code, and log your choice and reasoning to `DECISIONS.md` before moving on — don't guess silently through these.

The six branches, in order: `feature/05-help-cleanup`, `feature/06-question-cap-counting`, `feature/07-retry-command`, `feature/08-scan-chunking`, `feature/09-scan-rescan-hash`, `feature/10-scan-summary`.

---

## Prompt 5 — hide dev-only commands from default help output

### The problem

Found via real testing: typing an unknown/mistyped command (`grasp revie`, etc.) prints `Unknown command: <x>` followed by the *entire* help text — including `debug:seed`, `debug:capture`, `debug:answer`, and `internal:hook`, which are dev-only/internal commands never meant for a real end user. `grasp --help` shows the identical text. Read `src/cli.ts`'s `HELP_TEXT` constant and the unknown-command handling fully before changing anything.

### Required behavior

- Split the help text into a public-facing version (real user commands only: `--version`, `--help`, `init`, `review`, `scan` and its flags, `set`, `reset`, `export` and its flags) and keep the dev/internal commands (`debug:seed`, `debug:capture`, `debug:answer`, `internal:hook`) out of anything printed by default.
- Both `grasp --help` and the unknown-command fallback should show the public version — dev commands aren't meant for end users at all at this point, not even on explicit `--help`. Don't add a hidden `--dev`/`--all` flag to surface them. They should still work perfectly fine when invoked directly by name — this is purely about what gets *printed*, not what's *runnable*.
- Keep the dev/internal commands documented somewhere a future maintainer can find them — a code comment directly above their dispatch handling in `cli.ts` is sufficient. Don't invent a new doc file.
- Read the rest of `HELP_TEXT` (the "v1 status" footer, etc.) and make sure nothing in the public version references or implies the dev commands.

### Verification

- `npm run build` and `npm test` pass clean.
- `grasp --help` no longer lists `debug:*`/`internal:hook`.
- `grasp somebadcommand` also shows the trimmed, public-only list.
- `grasp debug:seed` (and the other dev commands) still actually run correctly when invoked directly.
- Update `README.md` if it currently reproduces `HELP_TEXT` or references these commands anywhere a real user would read.

---

## Prompt 6 — question caps count real questions, not event-rows

### The problem

`questionsPerSessionCap` and `scanQuestionsCap` both stop generation once a session has produced N `events` rows — but one event can carry ONE real question (instance-only, when the concept was already known) or TWO (a concept+instance "both" pair). This means a cap of 8 can silently let a session accumulate up to 16 actual questions to answer. Read `getSessionQuestionCount` in `src/store.ts` and every call site (`src/generation.ts`'s cap check, and `src/scan.ts`'s `runScanWalk` cap check) before changing anything.

### Required behavior

- Change `getSessionQuestionCount` to count real, individual questions, not event-rows: for every real (non-miss, `question_type IS NOT NULL`) event in the session, count `question_concept IS NOT NULL` as 1 and `question_instance IS NOT NULL` as 1 (so a "both" event contributes 2, an "instance"-only event contributes 1). This is the one function both the diff-side cap and the scan-side cap already read — fixing it here fixes both automatically. Confirm this is genuinely true by tracing both call sites, don't just assume it.
- Keep the existing "check before generating, not after" pattern: the cap check still happens *before* a judge call is attempted. A single attempt that pushes the count from 7 to 9 (because it turned out to be a "both" pair) is accepted as a legitimate final state, not preemptively blocked or split. The cap can now overshoot by at most 1 extra question, not by up to a whole event's worth as before.
- **Do not touch** `getPendingQuestions`, `pendingQuestionsMessage`, or any "N of M pending" batch-count messaging in `grasp review`/`grasp scan`. Those intentionally count *events* (coherent review units), a separate, still-correct concept. Leave them exactly as they are.
- Log the boundary-condition choice above (check-before, accept-slight-overshoot) to `DECISIONS.md`.

### Verification

- `npm run build` and `npm test` pass clean.
- Update the existing cap test(s) (`test/generation.test.ts`, `test/scanWalk.test.ts`) to exercise the corrected semantics — construct a mix of "both" and "instance"-only outcomes and confirm the count reflects sub-questions, not rows.
- Confirm both `grasp set questions-cap` and `grasp set scan-cap` still work end-to-end with the corrected counting.

---

## Prompt 7 — `grasp retry` and visible generation-failure messaging

### The problem

Found via real testing: a `Stop`-triggered batch generation attempt that times out or errors produces **zero visible signal** to the user. Worse, the *only* way an unresolved diff gets retried today is another `Stop` firing in the exact same Claude Code session that captured it — there's no way to manually retry a diff whose session has already ended, so a diff can end up permanently stuck with no path back and no indication anything happened. Read `src/generation.ts`'s `runBatchGeneration`/`executeGenerationAttempt`/`getUnresolvedCapturedDiffs`, and `src/cli.ts`'s `Stop`-handling block fully before changing anything.

### Required behavior

**Visible failure messaging on `Stop`:** when the batch generation attempt for *this* `Stop` firing has `missReason` of `"error"` or `"timeout"`, add a line to the combined `Stop` message, e.g.:

> "A comprehension question failed to generate (timeout) — it'll retry automatically on this session's next turn, or run `grasp retry` now."

Combine with the existing pending/cost/cap lines the same way those already combine.

**`getUnresolvedCapturedDiffsForRepo`:** a new function in `src/store.ts` — same shape as the existing `getUnresolvedCapturedDiffs`, but scoped to `repo` only, across every `session_id`, since a manual command has no live session to scope itself to.

**`grasp retry` command:** a new, standalone CLI command (`src/cli.ts`, same dispatch pattern as `grasp scan`).

- Gather every unresolved captured diff for the current repo. If none, print a clear "nothing to retry" message and exit cleanly.
- If some exist, run **one** batch generation attempt covering all of them — reuse `executeGenerationAttempt` if its shape fits a repo-wide, cross-session gather; adapt if it doesn't.
- Use a fresh synthetic `session_id`, `retry-${randomUUID()}`, matching the precedent `grasp scan` already set (`scan-${randomUUID()}`).
- Mark covered diffs resolved only on a genuine outcome (question, decline, or cap hit) — never on `error`/`timeout`.
- Print a clear result message either way.

**Open design point — decide and log to `DECISIONS.md`:** should `grasp retry` respect `questionsPerSessionCap`? A fresh synthetic session starts at a real-question count of 0, so the cap can't realistically block a single invocation. Lean toward checking it anyway for consistency with every other generation path, rather than special-casing retry as cap-exempt — but make the call yourself and write down your reasoning.

### Documentation

Add `grasp retry` to the (now-trimmed) public help text, `README.md`, and `TESTING_GUIDE.md`.

### Verification

- `npm run build` and `npm test` pass clean.
- Simulate a timeout/error outcome and confirm the new `Stop` message line appears correctly for both `timeout` and `error`.
- Confirm `grasp retry` picks up a diff left unresolved by a *different, no-longer-live* session, not just the current one.
- Confirm `grasp retry` with nothing unresolved prints a clean message and exits without error.
- Confirm a failed `grasp retry` attempt leaves its diffs unresolved.

---

## Prompt 8 — `grasp scan` chunking for large files

This one has real, genuine design surface. Read `src/scan.ts` and the `grasp scan`-related sections of `src/store.ts`/`src/generation.ts` in full before changing anything — this restructures core parts of how scan walks a repo.

### The problem

Found via real testing: `grasp scan` treats one whole file as one indivisible unit — at most one concept+instance pair per file, ever, and a file is permanently marked scanned the moment it's looked at once. This breaks down badly for any codebase where a large fraction of the real logic lives in one big file — that file gets exactly the same "one shot, forever" treatment as a five-line utility file. Separately, any file over `MAX_SCAN_FILE_LINES` (2000, hardcoded in `scan.ts`) is silently skipped, with no visible signal to the user.

### 1. Chunking

- New constant, e.g. `MAX_SCAN_CHUNK_LINES` — the maximum lines of source handed to one generation call. Pick a reasonable default (a few hundred lines is a reasonable starting point) and log your choice to `DECISIONS.md`. A file at or under this size is just "one chunk" (chunk 0) — don't special-case small files separately.
- Splitting is purely mechanical: sequential line-count blocks from the top, **not** semantic boundary detection.
- Each chunk gets its own generation call, scoped to just that chunk's lines. Same concept-tag memoization rules apply per chunk exactly as per file today.
- **Easy to get subtly wrong:** `computeValidatedExcerpt`'s clamping needs to happen within the *chunk's* own line range, but the excerpt rendered to the user must use the file's real, absolute line numbers, not chunk-relative ones. Write a test specifically checking a chunk other than the first one produces a correct absolute citation.

### 2. Resumability at chunk granularity

- Redesign progress tracking from `(repo, file_path)` to `(repo, file_path, chunk_index)`, following this codebase's established migration pattern in `migrateSchema`.
- **Open design point — decide and log to `DECISIONS.md`:** existing pre-chunking `scan_progress` rows mean "this file was already fully scanned" under the old model — migrate each to mark *every* chunk of that file (given its current on-disk size) as already done, not just chunk 0, so the schema change doesn't trigger stale reprocessing of already-covered files.
- A file's walk is complete once every one of its current chunks has a progress row.

### 3. Round-robin at chunk granularity

- A large multi-chunk file must **not** have all its chunks processed back-to-back the moment it comes up in rotation — restructure the walk so each pass through the round-robin file order advances every file with remaining chunks by exactly one chunk, repeating in passes until the cap is hit or everything is done.
- Write a test with one large multi-chunk file alongside several small single-chunk files, confirming genuine interleaving in a capped walk, not one contiguous block.

### 4. Oversized-file ceiling, now with a visible message

- Replace `MAX_SCAN_FILE_LINES` (2000) with a much larger, purely defensive ceiling (tens of thousands of lines is a reasonable starting point) — log your reasoning. Chunking now handles arbitrarily large legitimate source files; this ceiling is only for pathological cases.
- When exceeded, **print a clear, visible message** — e.g. `"Skipped <path> — N lines, over the M-line processing ceiling."` Still mark fully scanned, same permanence as other skip categories.

### Documentation

Update `README.md`'s `grasp scan` section and `TESTING_GUIDE.md` for chunking, the new ceiling/message, and corrected round-robin behavior.

### Verification

- `npm run build` and `npm test` pass clean.
- A fixture file over the chunk threshold splits into multiple real questions across runs, each with a correct absolute line citation.
- The round-robin interleaving test from §3.
- A migration test for pre-chunking `scan_progress` rows becoming fully-done, not partially pending.
- A fixture file over the new ceiling produces the visible skip message and permanent skip.
- Confirm `grasp reset history` still correctly clears the (possibly renamed/reshaped) progress table.

---

## Prompt 9 — hash-based re-scan for edited files

Builds directly on Prompt 8. Read the resulting `src/scan.ts`/`src/store.ts` from that prompt fully before starting.

### The problem

`grasp scan` never revisits a file once scanned, permanently, even if its content changes later — this assumes any real edit eventually gets caught by Claude Code's own diff-capture path, which breaks for hand-edits, other tools, or scanning a repo you're not actively coding in with an agent.

### Required behavior

**Whole-file hash tracking, not per-chunk — deliberate, discussed decision.** Chunk boundaries are position-based, so an edit near the top of a file shifts every later chunk's boundaries, making unrelated later chunks falsely look "changed." Whole-file hashing avoids this.

- A new table, e.g. `scan_file_hashes`: `repo TEXT, file_path TEXT, content_hash TEXT NOT NULL, content TEXT NOT NULL, last_scanned_at TEXT NOT NULL, PRIMARY KEY (repo, file_path)` — separate from Prompt 8's chunk-level `scan_progress`. Store enough previous content to diff against later.
- Written once a file is fully processed under the chunked walk, and updated (without triggering reprocessing) when a hash check confirms only a trivial change.

**On each walk**, before skipping a file with full chunk coverage, check `scan_file_hashes`:

- No row — brand new, proceed as Prompt 8 already does.
- Row exists, hash matches — unchanged, skip.
- Row exists, hash differs — compute a real diff between stored old content and current content (recommended: `git diff --no-index` against two temp files, reusing this codebase's existing hunk-parsing rather than writing a new differ from scratch — confirm after reading `src/adapters/gitDiffCapture.ts`), and run it through the **same mechanical filter** the live diff-capture path uses (`evaluateCapturedDiff` in `src/filter.ts`).
  - Filter says trivial — don't reprocess, just update the stored hash/content.
  - Filter says real change — delete that file's existing chunk-progress rows, update `scan_file_hashes` to the current hash/content **immediately** (not after the re-walk completes — this keeps the model simple and always accurate about current state, even though it doesn't perfectly protect an in-progress catch-up from an overlapping second edit; state this explicitly in your `DECISIONS.md` entry rather than deciding it silently). The file re-enters the normal chunked walk from chunk 0.

**Open design point — decide and log to `DECISIONS.md`:** should there be a separate, smaller practical size limit on what `scan_file_hashes` bothers storing/diffing, distinct from Prompt 8's much larger processing ceiling, to avoid database bloat on very large repos? Use your judgment; don't over-engineer, but make a deliberate call and write it down.

### Documentation

Update README's `grasp scan` "known limitations" (it currently says scan *never* re-visits an edited file — no longer fully true) and `TESTING_GUIDE.md`.

### Verification

- `npm run build` and `npm test` pass clean.
- Trivial edit to a scanned file — no new question, hash silently updated.
- Meaningful edit — file re-enters the chunked walk from chunk 0, respecting round-robin/cap.
- A never-before-scanned file's first scan doesn't attempt to diff against nonexistent old content.
- Diff-filter thresholds behave identically to the live diff-capture path for equivalent changes.
- `grasp reset history` clears `scan_file_hashes` too.

---

## Prompt 10 — a short summary after each `grasp scan` run

Last prompt in the batch. Read the current state of `src/scan.ts` (after Prompts 8 and 9) fully first.

### The problem

Requested addition, confirmed cheap and genuinely useful: after a `grasp scan` run, print a short plain-language summary of what that run actually covered — a few sentences, not a deep report.

### Required behavior

- Track which chunks/files were actually read and processed *this run* (new content read this invocation — not files confirmed unchanged via Prompt 9's hash check, not chunks already done before this run started).
- If that list is empty (nothing new was read), skip the summary entirely — no call, no output.
- If non-empty, build a new prompt (e.g. `buildScanSummaryPrompt` in `src/generation.ts`) with the content processed this run, and make one additional call through the same subprocess mechanism already used for judge calls — plain prose back, not a structured contract. Reuse cost extraction from `parseClaudeEnvelope` rather than building a fully parallel path. Cap how much raw content goes into the prompt if a lot was processed this run — use your judgment, document the number.
- Print the summary as plain text after the run completes (after the interactive review UI, if any questions were also generated and presented — a closing note, not an interruption).
- Print its cost on its own line, **explicitly separate** from the "$ spent generating comprehension questions" line — don't fold it into the tracked session cost total.
- **Do not** persist anything about this to `events` or any other table — ephemeral, run-specific. Shouldn't affect `grasp export`, `grasp reset history`'s counts, or any cap.

### Documentation

Add a short mention to `README.md`'s `grasp scan` section and `TESTING_GUIDE.md`.

### Verification

- `npm run build` and `npm test` pass clean.
- A run against a small multi-file fixture produces a summary accurately describing what that run walked, not the whole repo or a previous run.
- A run with nothing new to process produces no summary attempt and no extra cost line.
- Summary cost is visibly separate from question-generation cost, and doesn't affect `grasp export`/`grasp reset history`.
- Use the existing mock-`claude` test fixture pattern (`test/fixtures/mock-claude/claude`) rather than a real network call.

---

## When the whole batch is done

This is the last prompt — don't create a seventh branch. Give me a summary of all six branches (`feature/05-help-cleanup` through `feature/10-scan-summary`), confirming each one's `npm run build`/`npm test` passed independently at the point it was completed, and stop there for review.
