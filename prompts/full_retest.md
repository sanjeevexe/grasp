# Grasp — full functional retest (log only, don't fix)

You're working in the Grasp CLI codebase (`grasp-cli`). This is a **testing pass, not an implementation prompt** — your job is to exercise as much of Grasp's real, end-to-end behavior as you can and write down everything that doesn't match what it's supposed to do. **Do not fix anything you find.** Log it, keep going, and let the review happen afterward with a human. Small, silent mistakes have been slipping through lately (a schema bug, a stale doc line, a missed diff) — this pass exists to surface more of them deliberately, in one place, rather than one at a time as they're stumbled into.

Read `grasp-project-brief.md`, `BUILD_PLAN.md`, `DECISIONS.md`, `README.md`, and `TESTING_GUIDE.md` fresh before starting, so you know what's actually supposed to happen before you go looking for cases where it doesn't. Confirm you're on an up-to-date `main` (this branch should already include the small-fixes, new-commands, reliability-rework, scan, and the six-prompt help/cap/retry/chunking/rescan/summary batch — if any of that looks missing, stop and say so before proceeding, don't test against a stale checkout).

## Setup — isolated from your and my real Grasp data

Everything in this pass must run against a throwaway `$HOME` and throwaway scratch repos — never your or my real `~/.grasp/history.db`.

1. `npm run build` first, so you're testing current code, not a stale `dist/`.
2. Create a temp directory to serve as `$HOME` for every `grasp` invocation in this pass (e.g. `export GRASP_TEST_HOME=$(mktemp -d)` and prefix every `grasp` call with `HOME="$GRASP_TEST_HOME"`). This isolates `~/.grasp/config.json`/`history.db`/exports completely.
3. Create one or more throwaway git scratch repos outside this codebase (e.g. under `/tmp`) to make real edits in and run `grasp init`/`grasp scan`/etc. against. Don't reuse or modify anything under `/Users/sanjeevvarma/Desktop/Grasp` itself for this, and don't touch `~/Desktop/grasp-test` either — that's the user's own manual-testing sandbox with its own accumulated state.
4. You (this Claude Code session) are the "AI agent" whose edits Grasp's hooks are meant to capture — when you edit files inside a `grasp init`'d scratch repo during this session, your own real `PostToolUse`/`Stop` hooks will fire for real, exactly like normal usage. Use this directly: don't simulate or fake hook payloads for anything you can trigger for real by just making the edit.

## What's in scope vs. out of scope for THIS pass

**In scope:** everything drivable through direct CLI invocation, your own real file edits, and database inspection (`sqlite3 "$GRASP_TEST_HOME/.grasp/history.db" "..."`) — which covers the large majority of real surface area, including everything that's actually broken in the past (schema/migration issues, wrong messages, wrong counts, missing captures, stale docs).

**Out of scope, log as `NEEDS-HUMAN` instead of testing it yourself:** anything requiring live keypress-by-keypress interaction with the `grasp review`/`grasp scan` ink TUI (typing an answer, pressing Escape/retry, arrow-key scrolling, Ctrl+C mid-review). You don't have a real TTY to drive that interactively via Bash. Don't attempt to fake this with pty tricks beyond what already exists — if you want partial coverage here, you may reuse (read-only, as a reference, don't modify) the existing pty test harness pattern in `test/reviewAppPty.test.ts`/`test/scanPty.test.ts` to write a small throwaway driver script, but if that feels like real engineering effort, just log the item as `NEEDS-HUMAN` and move on — `TESTING_GUIDE.md` §3 already covers this ground for the manual pass. Don't spend a long time on this trade-off; default to logging it as needing a human.

## Log file

Create `TEST_LOG.md` at the repo root (new file). One entry per issue found, in this shape:

```
## [SEVERITY] Short title

**Area:** e.g. "grasp scan / chunking" or "grasp export / anki shape"
**Steps to reproduce:** exact commands/edits, in order
**Expected:** what should have happened, per the brief/README/TESTING_GUIDE/DECISIONS.md
**Actual:** what actually happened — exact output, exact DB query result, whatever's concrete
**Notes:** anything relevant you noticed while investigating (don't fix it, but a "this looks like it's in X function" pointer is fine if it's already obvious from what you saw)
```

Severity: `BUG` (behavior contradicts documented/intended behavior), `DOC` (behavior is fine, but README/TESTING_GUIDE/help text says something inaccurate), or `NEEDS-HUMAN` (out of scope per above, needs the manual TTY pass). If you finish the whole pass and found nothing, say so plainly in the log rather than leaving it empty with no record the pass happened.

Work through every section below in order. Don't stop when you find something — log it and continue; the whole point is maximum coverage in one pass, not stopping at the first thing that's wrong.

## 1. Install and help surface

- `grasp --version` prints something real.
- `grasp --help` lists exactly the public commands (`init`, `review`, `scan` + `--full`, `retry`, `set` + its subcommands, `reset` + its subcommands, `export` + its flags) and does **not** list `debug:seed`/`debug:capture`/`debug:answer`/`internal:hook`.
- `grasp somebadcommand` shows the same trimmed list, not an error dump, not the full dev list.
- `grasp debug:seed` still runs correctly despite being hidden from help.
- `grasp init` in a fresh scratch repo: confirm the pre-write summary/consent message appears, confirm `.claude/settings.local.json` gets Grasp's hook entries, confirm running `grasp init` again doesn't duplicate them.

## 2. Real diff capture, filtering, and the reliability rework

Working inside a `grasp init`'d scratch repo, as yourself editing files:

- A trivial one-line edit (fix a typo) — confirm no question gets generated (check `events`/`captured_diffs` directly).
- A genuinely meaningful edit (add a real function) — confirm it's captured and a `Stop` message appears mentioning a pending question.
- Several real edits across multiple files in one turn (no back-and-forth in between) — confirm exactly ONE combined question results, not one per file/tool call.
- An edit to a generated-looking file (a header comment declaring it generated) — confirm it's ignored.
- A formatting-only edit (reindent, wrap in parens, no logic change) — confirm it's ignored.
- A path matching a repo's `ignorePatterns` — confirm it's ignored, and confirm the same ignore rule does NOT apply in a different scratch repo without that setting.

## 3. Caps — question counting

- `grasp set questions-cap 3` in a scratch repo. Drive enough real edits/turns to produce more than 3 raw sub-questions worth of content. Confirm generation actually stops based on real question count (concept+instance pairs counted individually, per the recent fix), not event-row count — verify directly against `events`/`getSessionQuestionCount`-equivalent math via SQL, don't just eyeball the `Stop` message.
- Confirm the cap message names the cap value correctly when hit.
- Repeat the same real-question-counting check for `grasp set scan-cap` against `grasp scan` (see §5 below for the scan setup).

## 4. `grasp retry` and failure visibility

This one's hard to force a real timeout for — don't try to engineer an artificial failure through risky means. Instead:

- Confirm `grasp retry` in a scratch repo with nothing unresolved prints a clean "nothing to retry" message and exits without error.
- If you can find or construct a legitimate way to leave a diff genuinely unresolved (check `test/retry.test.ts`/`test/generation.test.ts` for how the existing test suite simulates a timeout/error outcome — the same mock-`claude` mechanism should work for a real CLI invocation too if you point `PATH` at it), confirm `grasp retry` picks it up and resolves it, and confirm the `Stop` message's failure line appears correctly worded for both `error` and `timeout`. If this isn't practical without real engineering effort, log it as `NEEDS-HUMAN` rather than forcing something fragile.

## 5. `grasp scan` — chunking, hash-based re-scan, and the summary

- Standalone: run `grasp scan` in a scratch repo with no live Claude Code session state (should still just work).
- Construct a file well over the chunk size (~400 lines — check `MAX_SCAN_CHUNK_LINES` in `src/scanChunking.ts` for the exact current value) with multiple real, distinct sections. Run `grasp scan` with a small cap, confirm it produces more than one question from that single file across scan runs (not the old one-shot-per-file behavior), and confirm each instance question's cited line range is correct against the REAL file (i.e. the numbers shown actually match what's on that line in the file, especially for a chunk that isn't the first one — this is the easiest thing to get subtly wrong).
- Alongside that large file, put a few small files in different top-level directories. Run a capped scan and confirm coverage spreads across directories/chunks rather than exhausting the large file first.
- Construct a file over `MAX_SCAN_CEILING_LINES` (~20,000 lines — check `src/scan.ts` for the exact current value; a trivially repeated line is fine, it doesn't need to be real code) and confirm scan skips it with a **visible** message, not silently.
- Fully scan a small file, then hand-edit it (as yourself, a plain file write, not through a captured diff) with a real, meaningful change. Run `grasp scan` again and confirm it's picked back up and produces a fresh question. Then do the same with a purely trivial edit (whitespace only) and confirm it does NOT trigger a new question, just a silent hash update — check `scan_file_hashes` directly to confirm.
- Confirm a `grasp scan` run that actually processed new content prints a short plain-language summary at the end, with its own cost line kept visibly separate from the question-generation cost line. Confirm a run that finds nothing new to do produces no summary and no extra cost line.
- Confirm `grasp reset history` clears `scan_progress`, `scan_file_hashes`, and everything else it's supposed to (check `events`/`concept_tags` counts too) — run it with `--yes` so it doesn't hang waiting on input.

## 6. `grasp set` / `grasp reset` / `grasp export`

- Each `grasp set ...` subcommand (`mode`, `gate`, `questions-cap`, `scan-cap`), both local and `--global`, writes the right key without clobbering other keys already in the target config file (hand-edit an unrelated key into the file first, then run the `set` command, then confirm the unrelated key survived).
- `grasp reset config` (local) deletes `.grasp.json` rather than leaving an empty one; `--global` overwrites to defaults.
- `grasp export`, `--anki`, and `--raw` each produce a real, correctly-quoted CSV under `$GRASP_TEST_HOME/.grasp/exports/`, and scan-sourced rows show up correctly (a `source` column in default/raw, a `source:scan` tag in the anki shape).

## 7. Cross-cutting checks

- Concept-tag memoization is genuinely shared: master a concept via a live diff question, confirm a later `grasp scan` over a file that would otherwise raise the same concept correctly asks instance-only. Then the reverse (master via scan, confirm a later live diff skips re-teaching it).
- `grasp review`/`grasp scan` never show each other's pending questions (check via `getPendingQuestions`-equivalent SQL against the `source` column, since you can't drive the interactive cross-hint yourself — see the out-of-scope note above).
- Pick 3–4 concrete claims out of `README.md` (e.g. specific message wording, specific default values like `scanQuestionsCap`'s default, specific behavior descriptions) and confirm each one against the actual current code/behavior, not just against what the doc says. Log any mismatch as `DOC`.

## When you're done

Commit `TEST_LOG.md` on a new branch, `test/full-retest`, off the current `main` — this pass makes no code changes, so this should be the only file in the commit. Don't merge it. Give me a short summary: how many issues logged at each severity, and whether the pass completed in full or you had to stop partway (and why, if so).
