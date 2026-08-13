# Grasp — Prompt 8: `grasp scan` chunking for large files

You're working in the Grasp CLI codebase (`grasp-cli`). Fourth of six prompts in this batch, and the largest so far — this one has real, genuine design surface. Read `grasp-project-brief.md`, `BUILD_PLAN.md`, and `DECISIONS.md` fresh before starting, and read `src/scan.ts` and the `grasp scan`-related sections of `src/store.ts`/`src/generation.ts` in full before changing anything — this prompt restructures core parts of how scan walks a repo.

**Branching:** you should already be on `feature/08-scan-chunking`, branched off `feature/07-retry-command`. If not, create it now off the current branch. Do not merge into `main` yourself.

## The problem

Found via real testing: `grasp scan` currently treats one whole file as one indivisible unit — at most one concept+instance pair per file, ever, and a file is permanently marked scanned the moment it's looked at once. This breaks down badly for any codebase where a large fraction of the real logic lives in one big file (a large `index.js`, a monolithic module, etc.) — that file gets exactly the same "one shot, forever" treatment as a five-line utility file, which doesn't proportionally reflect how much is actually in it. Separately, any file over `MAX_SCAN_FILE_LINES` (2000, hardcoded in `scan.ts`) is silently skipped entirely, with no visible signal to the user that it happened.

The fix: split large files into chunks, process one chunk at a time (one generation call, one possible concept+instance pair, per chunk), track resumability at the chunk level, and replace the old whole-file size skip with a much larger, purely defensive ceiling that now prints a clear, visible message when hit instead of skipping silently.

## 1. Chunking

- New constant, e.g. `MAX_SCAN_CHUNK_LINES` — the maximum number of lines of source handed to one generation call. Pick a reasonable default (a few hundred lines is a reasonable starting point — enough for a judge call to reason about something coherent, small enough to keep prompt size and cost sane) and log your choice and reasoning to `DECISIONS.md`. A file at or under this size is just "one chunk" (chunk 0, the whole file) — don't special-case small files separately from the chunking logic; it should generalize uniformly.
- Splitting is purely mechanical: sequential line-count blocks from the top of the file, **not** semantic (no function/class boundary detection). Keep this simple and deterministic.
- Each chunk gets its own generation call, using the same instance-excerpt-with-line-numbers approach already built for scan's judge prompt — scoped to just that chunk's lines, not the whole file. Same concept-tag memoization/suppression rules apply per chunk exactly as they already apply per file.
- **Important detail, easy to get subtly wrong:** the excerpt/cited-line-range validation (`computeValidatedExcerpt` in `generation.ts`) needs to clamp within the *chunk's* own line range, while the excerpt actually rendered to the user must still use the file's real, absolute line numbers (not chunk-relative ones) — a user reading the citation needs it to match what they'd see opening the real file. Trace this carefully; write a test that specifically checks a chunk other than the first one (e.g. chunk 2 of a file) produces an absolute, correct line citation, not an offset one.

## 2. Resumability at chunk granularity

- Redesign the scan progress tracking from `(repo, file_path)` to `(repo, file_path, chunk_index)` — following this codebase's established `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS` migration pattern (see `migrateSchema` in `src/store.ts` for the existing convention to follow).
- **Open design point — decide and log to `DECISIONS.md`:** how do existing, pre-chunking `scan_progress` rows (keyed only by `repo` + `file_path`, from before this change) get interpreted after migration? The correct interpretation is that a pre-existing row means "this file, as a whole, was already fully considered scanned" — a full-file question was already asked about it (or it was legitimately declined, or mechanically skipped) under the old one-shot-per-file model, so it should **not** be treated as merely "chunk 0 done, chunks 1+ still pending" after migration — that would incorrectly re-trigger partial rescanning of files that were already fully covered under the old model. Migrate each pre-existing row to mark *every* chunk of that file (given its *current* on-disk size, chunked under the new `MAX_SCAN_CHUNK_LINES`) as already done, so no stale reprocessing is triggered purely by this schema change.
- A file's walk is complete once every one of its chunks (given its current size) has a progress row. `grasp scan`'s "nothing left to scan" check needs to account for chunk-level completion, not just file-level.

## 3. Round-robin at chunk granularity

- Today's `orderFilesRoundRobin` interleaves whole files by top-level directory. Under chunking, a large multi-chunk file must **not** have all its chunks processed back-to-back the moment it comes up in rotation — that would let one big file consume an entire capped run's budget by itself, defeating the point of round-robin spreading in the first place.
- Restructure the walk so each pass through the round-robin file order processes **one chunk** (the next unprocessed one) per file, not all of a file's remaining chunks — i.e. multiple passes through the same file order, each pass advancing every file (that still has unprocessed chunks) by exactly one chunk, until the cap is hit or everything is done. `orderFilesRoundRobin` itself (the pure ordering function) likely doesn't need to change; what changes is how `runScanWalk` consumes that order.
- Write a test proving this: construct a fixture with one large multi-chunk file alongside several small single-chunk files, run a capped walk, and confirm the large file's chunks are genuinely interleaved with the other files/chunks in the processing order — not processed as one contiguous block before anything else gets a turn.

## 4. Oversized-file ceiling, now with a visible message

- Replace `MAX_SCAN_FILE_LINES` (2000) with a much larger, generous ceiling — this is now purely a last-resort defensive guard against pathological files (an accidentally-tracked minified bundle, a huge generated file that slipped past generated-file detection, etc.), not a normal operating limit, since chunking now handles arbitrarily large legitimate source files. Pick a reasonable value (tens of thousands of lines is a reasonable starting point) and log your reasoning.
- When a file exceeds this new ceiling, **print a clear, visible message during the walk** — e.g. `"Skipped <path> — N lines, over the M-line processing ceiling."` — this is the fix for a real ask: today's silent skip gives the user no idea anything happened. Still mark the file fully scanned (same permanence as the existing binary-file/ignore-pattern/generated-file skip categories) — don't retry it every run.

## Documentation

Update `README.md`'s `grasp scan` section and `TESTING_GUIDE.md` to describe chunking, the new ceiling and its visible message, and the corrected round-robin behavior at chunk granularity.

## Verification

- `npm run build` and `npm test` must pass clean.
- A real fixture file over the chunk threshold gets split into multiple real questions across scan runs (respecting the cap), each with a correct *absolute* line citation, not chunk-relative.
- The round-robin interleaving test described in §3.
- A migration test: seed a pre-chunking-shaped `scan_progress` row (or the older schema directly), open the store, confirm that file is now correctly marked fully done at every chunk (per its current size), not partially pending.
- A fixture file over the new oversized ceiling produces the visible skip message and is marked permanently scanned.
- Confirm `grasp reset history` still correctly clears whatever the new chunk-level table is called — check `clearHistory`/`getHistoryRowCounts` in `store.ts` and update them if the table name/shape changed.

## When you're done

Commit your work. Create the next branch, `feature/09-scan-rescan-hash`, off this one, and continue directly to Prompt 9 in this same session.
