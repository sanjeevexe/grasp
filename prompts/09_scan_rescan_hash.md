# Grasp — Prompt 9: hash-based re-scan for edited files

You're working in the Grasp CLI codebase (`grasp-cli`). Fifth of six prompts in this batch. This one builds directly on Prompt 8 (chunking) — read that prompt's file (`prompts/08_scan_chunking.md`) and the resulting code in `src/scan.ts`/`src/store.ts` fully before starting, along with `grasp-project-brief.md`, `BUILD_PLAN.md`, and `DECISIONS.md`.

**Branching:** you should already be on `feature/09-scan-rescan-hash`, branched off `feature/08-scan-chunking`. If not, create it now off the current branch. Do not merge into `main` yourself.

## The problem

`grasp scan` currently never revisits a file once it's been scanned, permanently, even if the file's content changes later — the assumption being that any real edit would eventually get caught by Claude Code's own diff-capture path instead. That assumption breaks for anyone editing by hand, using another tool, or scanning a repo they're not actively coding in with an agent — a changed file just silently never gets asked about again.

## Required behavior

### Whole-file hash tracking, not per-chunk

Track a content hash **at the whole-file level**, not per chunk. This is a deliberate, discussed decision: chunk boundaries are position-based (line N to line N+M), so any edit near the top of a file shifts every later chunk's boundaries, making every later chunk falsely look "changed" even when its actual content didn't move — that would make hash tracking noisy and effectively useless on any file that gets touched often. Whole-file hashing avoids this entirely.

- A new table (e.g. `scan_file_hashes`: `repo TEXT, file_path TEXT, content_hash TEXT NOT NULL, content TEXT NOT NULL, last_scanned_at TEXT NOT NULL, PRIMARY KEY (repo, file_path)`) — separate from the chunk-level `scan_progress` table Prompt 8 introduced. Store enough of the previous content to diff against later (see below), not just the hash.
- Written/updated once a file has been fully processed under the chunked walk (Prompt 8), and also updated (without triggering reprocessing) whenever a hash check confirms a file changed only trivially (see below).

### On each walk: check hash before treating a file as "already scanned"

Before skipping a file that already has full chunk coverage (Prompt 8's "nothing left to do here" check), look it up in `scan_file_hashes`:

- **No row exists** — brand new file, not yet ever scanned. Proceed exactly as Prompt 8 already does.
- **Row exists, current on-disk hash matches** — genuinely unchanged. Skip, cheapest path, no further work.
- **Row exists, current on-disk hash differs** — something changed. Compute a real diff between the stored old content and the current on-disk content, and run that diff through the **same mechanical filter the live diff-capture path already uses** (`evaluateCapturedDiff` in `src/filter.ts` — its formatting-only and min/max-changed-lines checks). Recommended approach: use `git diff --no-index` against two temporary files (one holding the stored old content, one the current content) to get a real, correctly-formed diff — this reuses git's actual diff algorithm and the hunk-parsing code this codebase already has (see `src/adapters/gitDiffCapture.ts`) rather than writing a new text-diffing algorithm from scratch. Confirm this approach works cleanly after reading that file; adjust if there's a cleaner existing seam to hook into.
  - **Filter says trivial** (formatting-only, below the min-changed-lines threshold) — do not reprocess. Just update `scan_file_hashes`' stored hash and content to the current version, leave the file's chunk coverage as fully done.
  - **Filter says real, meaningful change** — delete all of that file's existing chunk-progress rows (from `scan_progress`), making every chunk of its *current* content eligible again, and update `scan_file_hashes` to the current hash/content immediately (not after the re-walk finishes — see the note below on why). The file re-enters the normal chunked walk from chunk 0, subject to the same round-robin/cap behavior as any other file with unprocessed chunks.

**Note on updating the hash at detection time, not after completion:** updating `scan_file_hashes` the moment a re-walk is triggered (rather than only after the file's re-walk fully finishes) means a further edit made *while* a multi-run re-walk is still in progress gets its own independent comparison against the latest known state, rather than being silently absorbed into whatever the first change already triggered. This is a deliberate simplification — it doesn't perfectly protect an in-progress catch-up from being interrupted by a second edit, but it keeps the model simple and always accurate about "what's the current known state," which matters more than perfectly sequencing overlapping edits mid-catch-up. State this explicitly in your `DECISIONS.md` entry rather than silently deciding it.

**Open design point — decide and log to `DECISIONS.md`:** should there be a separate, smaller practical limit on how much content `scan_file_hashes` bothers storing/diffing, distinct from Prompt 8's much larger processing ceiling? Storing full previous content for every scanned file up to that large ceiling could mean meaningful database bloat for a big repo. A reasonable, defensible option: cap what gets hash-tracked at a smaller size (falling back to "once scanned, always considered unchanged" for anything above that smaller size, same as today's behavior) rather than tracking full content all the way up to the much larger processing ceiling. Use your judgment; don't over-engineer this, but make a deliberate call and write it down.

## Documentation

Update `README.md`'s `grasp scan` "known limitations" language (it currently says scan *never* re-visits an edited file — that's no longer fully true) and `TESTING_GUIDE.md`.

## Verification

- `npm run build` and `npm test` must pass clean.
- Edit a previously-scanned file trivially (whitespace/comment only) — confirm no new question is generated, and the stored hash is silently updated.
- Edit a previously-scanned file meaningfully — confirm it re-enters the chunked walk from chunk 0 and produces a new real question (or a legitimate decline), and confirm this respects the same round-robin/cap behavior as any other file with pending chunks.
- Confirm a never-before-scanned file's first scan doesn't attempt to diff against nonexistent old content (no crash on the "no row exists" path).
- Confirm the diff-filter thresholds behave identically here to the live diff-capture path for an equivalent-sized change — reuse (not duplicate) the existing `evaluateCapturedDiff` test expectations as a reference point.
- Confirm `grasp reset history` clears `scan_file_hashes` too, alongside `scan_progress` and everything else — check `clearHistory`/`getHistoryRowCounts` in `store.ts`.

## When you're done

Commit your work. Create the next branch, `feature/10-scan-summary`, off this one, and continue directly to Prompt 10 in this same session.
