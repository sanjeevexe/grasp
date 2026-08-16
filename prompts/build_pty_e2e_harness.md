# Grasp — build a permanent, reusable PTY-driven end-to-end test harness

You're working in the Grasp CLI codebase (`grasp-cli`). This is a **build task, not a one-off test pass** — the deliverable is a real, reusable tool that lives in this repo and can be run again after any future change, not a single report. Read `grasp-project-brief.md`, `BUILD_PLAN.md`, `DECISIONS.md`, `README.md`, and `TESTING_GUIDE.md` fresh before starting. Also read `TEST_LOG.md` on branch `test/full-retest` (`git show test/full-retest:TEST_LOG.md`) for the methodology and gaps the last testing pass already found — this harness exists specifically to close the interactive-TUI gap that pass explicitly couldn't cover (arrow-key scrolling, terminal resize mid-render, long-line wrapping), while also giving comprehensive, repeatable coverage of everything else.

**Branching:** create a new branch off current `main`, e.g. `feat/pty-e2e-harness`. Do not merge into `main` yourself.

## Why this exists

Grasp's own automated test suite (`npm test`) already covers unit-level logic thoroughly, and `test/reviewAppPty.test.ts`/`test/scanPty.test.ts` already prove real pseudo-terminal-driven testing works for parts of the interactive TUI. But there's no single, comprehensive, repeatable pass that drives Grasp's *entire* real interface — every command, every interaction, hard and soft gating, `grasp scan`'s full lifecycle — the way an actual human sitting at a terminal would, and reports what breaks without a human having to go looking for it first. That's what this builds.

## What to build

1. **A generalized, reusable PTY driver module** — extend/generalize the pattern already used in `test/reviewAppPty.test.ts`/`test/scanPty.test.ts` (and `test/fixtures/ptyDriver.py`, if that's still a separate mechanism — read it and decide whether to consolidate on one approach or keep both, your call, but don't maintain two incompatible pty-driving mechanisms without a reason). It needs to support, at minimum: spawning `grasp <command>` (or any process) in a real pty with a controllable size; sending arbitrary keystrokes, including special keys (arrows, Enter, Escape, Ctrl+C) and literal text; waiting for expected text to appear on screen with a timeout, failing clearly (not hanging forever) if it doesn't; reading the full current rendered screen content for assertions; resizing the pty mid-session; and closing cleanly (no hung processes left behind, ever, even on failure — audit this carefully, a leaked pty process is worse than a failed test).

2. **A comprehensive scenario suite**, organized into logical files/modules under a new `test/e2e/` directory (or wherever fits this codebase's existing conventions best — check how `test/` is currently organized before deciding), covering the areas below. Each scenario should be independent (its own throwaway scratch repo/DB state, cleaned up after) so one failure doesn't cascade into unrelated failures elsewhere in the run.

3. **A runner script** invocable as its own `npm` script (e.g. `npm run test:e2e`) — separate from `npm test`, since this is slower (real pty spawns, real timing) and not meant to run on every routine build. It should run every scenario, **never stop on a failure** — catch it, log it, move to the next scenario, so one run surfaces as many real issues as possible — and print a summary at the end (pass/fail count, where the log is).

## Isolation — this must never touch real data

Same requirement as the last testing pass: every scenario runs against an isolated `$HOME`/`GRASP_HOME` (a fresh temp directory) and throwaway scratch git repos, never the real `~/.grasp/history.db` or `~/Desktop/grasp-test`. Real Claude Code hook firing doesn't work for a non-interactive test process either (same limitation the last pass documented) — construct hook payloads by hand and pipe them into `grasp internal:hook`, matching the pattern `BUILD_PLAN.md` already documents and `TEST_LOG.md` already used. Real `claude -p` generation needs auth that won't exist in an isolated environment — default to the existing mock-`claude` fixture pattern (`test/fixtures/mock-claude/claude`) for determinism and zero cost, but structure the harness so a real, unmocked run is *possible* later (an env var or flag choosing mock vs. real `claude` on `PATH`) without being required for a normal run.

## Coverage — be genuinely comprehensive

Drive every interaction through the real pty (real keystrokes, real rendered screen assertions) wherever the surface is interactive; use direct CLI invocation + database inspection for anything that isn't. Specifically:

**`grasp init`** — the pre-write consent prompt, the `v`/`y`/`N` flow (including viewing the literal JSON before deciding), confirming no duplication on a second run.

**`grasp review`** — the one-time starting banner (multi-question and singular-batch wording), diff rendering, immediate-typeability, long-line wrapping, **the scroll hint and actual arrow-key (↑/↓) scrolling behavior — both when there's more content than fits and when there isn't (hint must be absent in the latter case) — this is one of the specific gaps the last pass couldn't cover; get real coverage here**, blank-answer rejection before vs. after an attempted submit, sample-answer reveal, the Escape → explanation → retry → Escape-again → skip flow (confirm the hint text changes between first and retry attempts), Ctrl+C safety (unanswered questions stay pending), default repo-scoping vs. `--all`, and the cross-source hint pointing at `grasp scan` when applicable.

**`grasp scan`** — standalone operation, the batch-then-present model, chunking across a large file (multiple runs producing multiple real questions, correct absolute line citations for non-first chunks), round-robin spread across directories, the oversized-ceiling skip with its visible message, hash-based re-scan (a meaningful hand-edit re-triggers a question, a trivial one doesn't), the post-run summary (present only when something new was processed, cost kept separate), `--full`'s warning-not-gate behavior, the cross-source hint pointing at `grasp review`, and the "nothing left to scan" message.

**Hard/soft gate** — soft never blocks; hard denies the next tool call via a real `PreToolUse` payload when a real pending question exists, and unblocks immediately once it's answered or skipped via `grasp review`; confirm the gate only ever considers *today's* pending questions for *that specific session*, not stale ones from elsewhere.

**`grasp retry`** — nothing-to-retry, a genuine constructed timeout/error outcome resolved on retry, cross-session pickup (a diff from a session that's no longer "live").

**`grasp set`/`grasp reset`/`grasp export`** — every subcommand, local and `--global`, config-file preservation of unrelated keys, `reset history`'s interactive `y`/`N` confirmation driven for real via pty (not just the `--yes` bypass), and all three export shapes producing valid, correctly-quoted CSVs.

**Terminal resize** — mid-question, resize the pty and confirm the TUI reflows without breaking, garbling, or crashing. This is the other specific gap the last pass flagged — get real coverage here too.

**Cross-cutting** — bidirectional concept-tag memoization (live diff ↔ scan, in both directions), `--help`/unknown-command output trimmed correctly, the caps counting real questions (not event-rows) under live pty-driven generation, not just unit-level.

**A basic, deliberately shallow question-quality check** — for any real question generated during this run, confirm it's structurally sane: non-empty, no leftover template placeholders or obviously broken text, the concept question shows no code, the instance question's cited excerpt actually exists in the real file at the stated lines. **Do not** attempt to judge whether a question is pedagogically good, well-targeted, or genuinely useful — that's explicitly out of scope for this harness and stays a human (the user's own) judgment call, per `TESTING_GUIDE.md` §2. If you're ever unsure whether a check belongs here, err toward "structural sanity only."

If something in this list turns out to be genuinely impractical to script via pty after a real attempt (not a default fallback — only after you've tried), log it as `NEEDS-HUMAN` in the same log format below and move on, the same escape valve the last pass used, but the bar here should be higher than last time since closing this exact gap is this harness's whole purpose.

## Logging

Every run produces a timestamped log file (e.g. `test/e2e/logs/run-<timestamp>.md`, gitignored except maybe a `.gitkeep` — don't commit a pile of log files, check how this codebase already handles similar generated/log output like `prompts/logs/` and follow that convention). Same entry format the last pass established:

```
## [SEVERITY] Short title

**Area:** ...
**Steps to reproduce:** ...
**Expected:** ...
**Actual:** ...
**Notes:** ...
```

Severity: `BUG`, `DOC`, or `NEEDS-HUMAN`. Also log a clean pass explicitly (which scenarios ran and passed) — don't leave a run's success record implicit.

## Verification

- `npm run build` and `npm test` (the existing fast suite) must still pass clean — this harness is additive, it shouldn't break anything existing.
- Actually run `npm run test:e2e` yourself as part of this task, for real, and let it produce a genuine log — don't just write the harness and assume it works. Fix any bugs in the *harness itself* you find while doing this (a broken test is not the same class of thing as a bug in Grasp — harness bugs are yours to fix now; real Grasp bugs the harness finds go in the log, not fixed here, same as the last pass's instructions).
- Confirm the harness never leaves stray processes, temp directories, or pty sessions running after it finishes, pass or fail.
- Confirm it never touches the real `~/.grasp` or `~/Desktop/grasp-test`.

## When you're done

Commit the harness (code + docs, not the generated log output) with a clear message. Include the actual log file from your real verification run so I can see what it found. Stop there for review — don't merge into `main`.
