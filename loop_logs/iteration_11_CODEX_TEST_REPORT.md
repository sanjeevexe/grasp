# Codex Independent Test Report

## Summary — FAIL

Grasp built cleanly, started successfully, and passed all 124 automated tests. The major functional paths also worked in isolated scratch repositories: incremental diff capture avoided duplicates, mechanical filtering excluded the right files, mock question generation stored complete events, both caps accumulated across an entire multi-turn session, review rejected blank answers and saved deliberate answers/skips, hard and soft gates behaved differently, and failures timed out or degraded without crashing the hook.

The two functional bugs from the preceding test report are fixed. A real decrement-to-increment logic change now passes the filter, and long diff lines now wrap in `grasp review` instead of losing their hidden tails.

This run is still a FAIL because the documentation contains two real, misleading problems:

1. The only source-install sequence still says `git clone <this-repo>`. The project has no configured Git remote and is not published to npm, so a new user cannot follow the documented installation steps.
2. `DECISIONS.md` still says in several present-tense passages that `package.json` declares Node 18 support. The package, lockfile, and README correctly require Node 22. A contributor reading the decision record could reasonably choose or test the wrong runtime.

All successful Grasp commands used a disposable `HOME` and scratch Git repositories under `.codex-unattended-test/` in the project workspace. The developer's real `~/.grasp/history.db` was never read or modified. The scratch tree was removed after the report was written.

## 1. Install, build, packaging, and startup — PASS

- `npm install` completed successfully without changing tracked project files.
- `npm run build` completed successfully and produced an executable `dist/cli.js` with the expected Node shebang.
- The isolated CLI printed version `0.1.0` and coherent help text.
- First isolated startup created only the disposable `~/.grasp/config.json` and `~/.grasp/history.db`.
- `npm test` rebuilt first and passed all 124 tests with no failures, skips, or cancellations.
- `npm ls --depth=0` reported a complete dependency tree.
- `npm pack --dry-run` succeeded with an isolated npm cache and included the expected runtime files.
- Runtime versions were Node `v26.5.1` and npm `11.17.0`. The exact Node 22 floor was not independently exercised, although the declared requirement and dependency metadata agree on Node 22 or newer.

## 2. Diff capture and mechanical filtering — PASS

- A real hook-driven edit produced the correct file path, hunk, insertion/deletion counts, summary, and checkpoint range.
- Repeating `PostToolUse` without another edit produced no duplicate capture, event, or mock-Claude call.
- Later edits in the same session were captured incrementally rather than re-sending the entire uncommitted working tree.
- In one mixed real capture, the event sent to generation contained only `src/app.js`; `package-lock.json`, an unchanged-header generated file, a repository custom-ignore path, `.grasp.json`, and `.claude/settings.local.json` were excluded.
- A real JavaScript edit changing `--a`, `--b`, and `--c` to `++a`, `++b`, and `++c` correctly reported `+3/-3` and passed. This confirms the preceding report's `+++`/`---` hunk-line regression is fixed.
- The passing suite additionally covered formatting-only changes and formatter reflow, generated-file additions/regeneration/deletion, size floors and ceilings, renames, baseline and custom ignores, config-error rollback, concurrent checkpoint claims, and pruned-checkpoint recovery.

## 3. Question generation and concept memoization — PASS WITH LIVE-QUALITY LIMITATION

- The installed Claude Code CLI was version `2.1.223`, but under the disposable home `claude auth status` reported `loggedIn: false`. I therefore used the repository's established mock `claude` binary for successful generation.
- The real installed binary accepted Grasp's complete argument list and returned the expected unauthenticated JSON envelope rather than rejecting an option.
- A meaningful diff invoked the mock exactly once and saved concept and instance questions, the filtered diff, cost, summary, session identifier, and checkpoint hash.
- Grasp's invocation includes `--tools ""`, `--safe-mode`, `--setting-sources ""`, `--strict-mcp-config`, and `--max-turns 1`. The automated test inspects the literal argument list and rejects the old ineffective `--allowedTools` form.
- After answering `test-concept-1` in one repository, a later response using the same tag in another session/repository was stored as instance-only even though the mock supplied another concept question. Memoization is therefore enforced globally by Grasp rather than trusted to the model.
- Strict response handling for malformed JSON, invalid tags, missing concept questions, declined questions, and missing/negative cost passed the automated suite.

The mock proves control flow and storage, not whether real model-written questions are genuinely useful. That quality judgment could not be made without authenticated Claude access.

## 4. Cost cap and question-count cap — PASS

- With a one-question cap and a high cost cap, two meaningful diffs on different turns of the same `session_id` produced one real question followed by one `cap_reached` miss. The mock ran only once.
- With a `$0.001` cost cap and calls costing `$0.002`, the first call was allowed and crossed the cap by one call, while the next turn was blocked before invocation. This matches the documented pre-call check and one-call overshoot.
- A separate two-question / `$0.005` session accumulated two `$0.003` calls across different turns, reported `$0.0060`, and blocked the third diff without launching Claude.
- The passing multi-process tests confirm overlapping callers cannot independently spend the same remaining question or cost allowance.
- A `Stop` payload returned the exact cumulative spend at four decimal places and combined it with the pending-question count.
- An unknown-cost timeout halted later generation for that session rather than treating the failed call as free.

## 5. `grasp review` answer and skip flow — PASS

- In a real pseudo-terminal, questions were grouped by session with correct overall and per-session counts.
- The stored diff, concept question, and instance question appeared in the intended order.
- Submitting an empty concept answer kept the same question open and displayed a clear rejection message. A concurrent database query confirmed no answer, skip, or concept mastery was recorded.
- Nonblank concept and instance answers were stored, and the linked concept tag was marked answered.
- Escape deliberately entered the optional skip-reason step; submitting a blank reason marked the event skipped with a null reason.
- A skipped question stopped hard-gate blocking immediately.
- At an 80-column terminal, a long changed line wrapped onto the next visual row without an ellipsis or missing characters. This confirms the previous report's permanent-truncation bug is fixed.

Actual terminal resizing was not independently exercised because the available pseudo-terminal controller cannot change dimensions after launch. The resize and rewrap calculations are covered by the passing tests and were reviewed in source.

## 6. Gate modes — PASS

- In `soft` mode, `PreToolUse` emitted no denial even while that session had a pending question.
- Changing only the repository override to `hard` made the same session return the documented `permissionDecision: "deny"` JSON with a clear `grasp review` instruction.
- A different session was not blocked by another session's pending work.
- After the producing session's question was deliberately skipped, hard mode allowed it immediately.
- The automated suite confirms questions older than 24 hours remain visible in review/nudges but no longer actively block.
- The emitted decision and `systemMessage` fields match the current official Claude Code hook contract.

No authenticated live Claude session was available to observe the denial and nudge rendered inside Claude Code itself.

## 7. Failure and timeout handling — PASS

- A mock error envelope produced one `error` miss, kept its reported `$0.001` cost, created no question, and exited the hook successfully.
- A mock delayed beyond the real 20-second subprocess limit was killed at 20 seconds and recorded a `timeout` miss with unknown cost; the hook did not crash.
- A second meaningful edit in that timed-out session produced `cap_reached` without invoking Claude again, preserving the conservative unknown-cost rule.
- The passing suite also covers malformed output, nonzero-exit envelope recovery, negative/missing cost, reservation ownership and staleness, SQLite write contention, invalid-hook-config error swallowing, checkpoint rollback, and pruned-checkpoint recovery.

## 8. Configuration and per-repository overrides — PASS

- The isolated global config was created with all documented defaults.
- Three repositories used different gate, cost-cap, question-cap, ignore, and nested-threshold overrides while the global file remained unchanged.
- The observed gate and cap behavior proves the overrides affected the real hook path rather than merely parsing successfully.
- Running `grasp init` from a nested directory resolved to the Git root, showed the usage/cost disclosure before confirmation, wrote the expected array-shaped hook JSON at the root, and made no duplicate changes on the second run.
- The passing suite rejects malformed JSON, wrong types/ranges, invalid gate modes, and unknown keys with clear errors.
- The documented array behavior is accurate: a repository `ignorePatterns` array replaces the global array rather than being added to it.

## 9. Fresh-eyes code and documentation review — FAIL

The implementation and primary README descriptions now agree on checkpoint capture, manual review, session-wide caps, unknown-cost shutdown, 24-hour hard-gate freshness, generated/formatting heuristics, and Claude isolation flags. Current official Claude Code documentation also confirms `prompt_id`, the `PreToolUse` denial shape, and top-level `systemMessage` behavior.

Two documentation defects remain:

1. README's only current install path starts with the literal command `git clone <this-repo>`. There is no Git remote configured and the package is not published. The instructions therefore cannot take a new user from the README to a working installation. This was already reported in the preceding round and remains unresolved.
2. `DECISIONS.md` says `package.json` is “left at `>=18`,” calls Node 18 the currently declared floor, and later again refers to the `engines.node: >=18` commitment. The actual package and README require Node 22. A historical decision log can preserve old reasoning, but these present-tense claims are not marked as superseded and directly contradict the project today.

Under the required grading rule, either misleading documentation item is enough to prevent a PASS even though the exercised program behavior was sound.

## Additional bugs and risks found

- No additional functional code bug was reproduced in this pass.
- Real authenticated question quality, actual in-Claude hook presentation, actual terminal resizing, performance in a large monorepo, and the project's full-week human dogfooding criterion could not be verified in this unattended environment.
- The mock intentionally emits placeholder questions. It proves Grasp's enforcement and persistence logic but cannot prove that a real model will choose stable concept tags or consistently produce a useful concept-to-instance teaching sequence.

FINAL_VERDICT: FAIL
