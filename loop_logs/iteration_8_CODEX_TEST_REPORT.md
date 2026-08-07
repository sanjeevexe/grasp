# Codex independent test report

## Summary

Grasp builds, installs as a command, runs, and passes all 111 automated tests. Most of the product also held up in independent disposable-repository testing: incremental diff capture, mechanical filtering, generated-file handling, mock-Claude question generation, cross-project concept memory, ordinary session-wide cost and question caps, deliberate answer/skip behavior, blank-answer rejection, soft and hard gates, repository-specific configuration, model failures, and timeouts.

This run nevertheless found one release-blocking cost-cap bug, so the verdict is FAIL.

When a Claude call fails without a usable cost, Grasp records `cost_usd = NULL`. That row adds zero to the session total, and Grasp tries Claude again on the next meaningful diff. I reproduced three successive calls in one session with a `$0.001` cap; all three ran, all three were logged as errors with unknown cost, and none was cap-blocked. The question-count cap does not help because failed calls do not count as real question events.

There is also a more concrete version of the same bug: if `claude` prints a valid JSON error envelope containing `total_cost_usd` but exits nonzero, Node reports a process failure and Grasp discards the JSON in the error's stdout. A custom mock printed a `$0.001` cost and exited 1; Grasp stored the call as an error with a null cost. The installed real Claude CLI also uses the “JSON result plus exit 1” convention for its unauthenticated error, although that particular response correctly reported zero cost.

This means the documented cost cap is only reliable while every invocation exits successfully and reports a valid cost. For API-billed users, repeated failing or malformed responses can keep consuming unknown spend without ever reaching the configured cap. That exception is not disclosed in the README.

### Test environment and isolation

- Tested commit `19e483d` on August 7, 2026, with Node `v26.5.1`, npm `11.17.0`, and Claude Code `2.1.223`.
- All Grasp configuration and SQLite state lived under `/private/tmp/grasp-codex-test.FCwzbf`.
- Disposable Git repositories and mock executables lived under the project-local `.codex-test-scratch-run/` directory and were removed after the report was written.
- Every Grasp command used the disposable `HOME`. The developer's real `~/.grasp/history.db` was neither read nor modified.
- The real Claude CLI was present but unauthenticated under the disposable home, so question-generation tests used the repository's established mock-`claude`-on-`PATH` pattern.
- Pre-existing changes under `.codex-independent-test/` and `loop_logs/` were left untouched.

## 1. Build, automated tests, packaging, and basic CLI — PASS

`npm install` completed, `npm run build` compiled the project, and the built CLI printed version `0.1.0` and coherent help. A scratch-prefix `npm link` created a working `grasp` command without touching the developer's global npm installation.

`npm test` rebuilt the CLI and passed all 111 tests with no failures. The suite covers filters, config validation, Git parsing, incremental checkpoints, concurrent capture, cap races, reservation ownership, init behavior, stale hard gates, generated-file deletion, negative/missing cost, and the current Claude isolation flags.

`npm ls --all` found no missing required dependencies. `npm pack --dry-run --json` contained the executable CLI, runtime modules, README, license, and package metadata.

`grasp init`, run from a nested directory, wrote to the Git repository root, disclosed Claude usage and possible cost before writing, showed the same array-wrapped hook structure that appeared on disk, installed 45-second hooks, and was idempotent on a second run.

The workspace already had `node_modules`, so this was not a destructive from-empty reinstall. The installed native SQLite module loaded and worked throughout the test pass.

## 2. Diff capture and mechanical filtering — PASS

- Manual capture combined staged, unstaged, and untracked changes with correct paths, statuses, hunks, and line counts.
- Hook capture used a per-session checkpoint. Repeating `PostToolUse` with no new work created no duplicate capture, question, call, or cost.
- Later captures contained only the transition since the previous checkpoint, not the whole uncommitted working tree.
- Lockfiles, Grasp's own settings files, an existing generated file with an unchanged header, a repository-specific ignored directory, a formatting-only line reflow, and an isolated two-line edit were filtered before generation.
- A normal logic change passed and only its significant hunk reached the mock. The captured prompt did not contain the lockfile, generated file, Grasp settings, or ignored file.
- Automated tests covered upper size limits, generated-file deletion, renames, pruned checkpoint recovery, config-error rollback, and multi-process checkpoint races.

Git filenames containing tabs, newlines, or unusual surrounding whitespace remain a documented, untested edge case because parsing is not NUL-delimited.

## 3. Question generation and concept memory — PASS, with live quality unverified

- The mock received one judge-and-generate call containing the significant diff and answered-concept list.
- The invocation used `--tools ""`, `--safe-mode`, `--setting-sources ""`, `--strict-mcp-config`, and `--max-turns 1`; it did not use the previously broken `--allowedTools ""` approach.
- The installed Claude 2.1.223 CLI accepted those exact flags before returning its unauthenticated error. Its help text confirms the isolation options exist.
- After `test-concept-1` was answered in repository A, the same concept tag generated in repository B became instance-only even though the mock returned both questions. Cross-project concept memory therefore works and is enforced by Grasp itself.
- Malformed tags, a new concept without its required concept question, negative cost, missing cost, model error envelopes, and “not worth asking” responses are covered by passing tests.
- The prompt explicitly treats diff contents as untrusted data rather than instructions.

The repository's mock returns placeholder text such as “concept question 1,” so it can prove structure and persistence but not real teaching quality. A live authenticated model was unavailable, so actual question usefulness could not be judged in this run.

## 4. Cost cap and question-count cap — FAIL

### What worked

- With a `$0.01` cap and `$0.006` mock calls across different turns sharing one `session_id`, two calls ran and stored `$0.012`; the third logged `cap_reached` without invoking Claude. This matches the documented one-call crossing behavior.
- With a two-event question cap across three turns in one session, two real question events were created and the third turn logged `cap_reached` without invoking Claude.
- Mock call counts proved cap-blocked turns never launched the generator.
- The automated multi-process tests passed, proving overlapping successful calls cannot multiply spend or questions past a session cap.

### What is broken

Unknown-cost failures do not protect the remaining session budget.

With `costCapUsd` set to `$0.001`, a mock returned otherwise-valid JSON but omitted `total_cost_usd` on three successive meaningful diffs. Grasp correctly rejected each question as an error, but each event stored `cost_usd = NULL`. Because the cap query sums known cost and treats null as zero, all three calls ran. The question cap stayed at zero because none produced a real question.

A separate mock printed a valid JSON error envelope with `total_cost_usd: 0.001` and then exited 1. Grasp discarded the available JSON cost because `execFileSync` throws on any nonzero exit, so the catch path recorded another null-cost error.

The safe behavior would be to parse a valid error envelope even on a nonzero exit and record any reported cost. When cost genuinely cannot be determined, Grasp must conservatively stop further generation for that session—or clearly state that the cost cap no longer applies. Continuing to make uncosted attempts silently defeats the cap's purpose as a safety rail.

## 5. `grasp review` answer, skip, and batch flow — PASS

- The real Ink interface was exercised in a pseudo-terminal. It displayed the repository, diff summary, colored diff, question type, and session-batch counts readably.
- Doing nothing for several seconds did not advance or dismiss a question.
- Blank and whitespace-only submissions were rejected. The event and concept tag remained unchanged until real answers were supplied.
- A completed concept-and-instance flow saved both answers and marked the linked concept learned only after the instance answer completed the event.
- Escape opened the optional skip-reason step. Waiting there did nothing; pressing Enter deliberately recorded a skip with no reason and did not mark the concept learned.
- Four pending events were grouped into two session batches with accurate positions.
- Piping into `grasp review` failed clearly with exit code 1 instead of hanging.

Mid-question terminal resizing was not independently exercised. The code listens for resize events and recomputes the visible diff area.

## 6. Soft and hard gate modes — PASS

- Soft mode emitted no denial while a recent same-session question was pending.
- `Stop` combined the correct pending count with the four-decimal cumulative cost message.
- A repository override changed hard-gate behavior even when the hook payload's working directory was a nested subdirectory.
- Hard mode emitted the documented `PreToolUse` denial JSON for two pending questions in the same session.
- A different session in the same repository was not blocked.
- Answering or skipping through `grasp review` immediately removed the denial.
- After a pending event's timestamp was moved to the year 2000, hard mode no longer blocked that resumed session, while `Stop` still nudged about the old pending question. This matches the documented 24-hour cutoff.

## 7. Error, timeout, and interrupted-session handling — PASS, except for cap accounting above

- A model error envelope produced an `error` miss, no pending question, and no hook crash.
- A mock delayed for 30 seconds was killed by Grasp's inner timeout, logged a `timeout` miss, exited before the installed 45-second hook ceiling, and created no phantom gate.
- Invalid repository configuration made foreground commands fail loudly with an actionable message, while `internal:hook` exited 0 and left the checkpoint retryable.
- The automated suite covers malformed output, missing executables/process failures, checkpoint rollback, reservation timeouts, and concurrent writers.

Failure classification is graceful, but failures with unknown or discarded cost can bypass the session cost cap as described in section 4.

## 8. Configuration loading and per-repository overrides — PASS

- The disposable global config was created with every documented default.
- Repository overrides changed cost cap, question cap, gate behavior, ignore behavior, and nested thresholds in real flows.
- Overrides resolved from nested working directories to the Git root.
- The same ignored path was excluded only in the repository that configured it.
- Arrays replace rather than concatenate, while nested objects merge by key, matching the documented rules.
- Invalid JSON, invalid values, unknown top-level keys, and unknown threshold keys are rejected with clear messages.

## 9. Fresh-eyes code and documentation review — FAIL

The source is generally readable and unusually well tested for a small CLI. The README is candid about on-demand review, cap overshoot, stale gates, generated/formatting heuristics, checkpoint pruning, the hard-kill window, unusual Git filenames, and the lack of full-week dogfooding.

Two misleading claims remain:

1. The README says Grasp tracks cumulative spend and stops generating once the configured cap is hit, but it does not disclose that unknown-cost failures are counted as zero and allow later calls. The nonzero-exit path can even discard a cost that was present in valid JSON stdout.
2. The README's outbound-data paragraph says “anything under a size floor” is excluded before generation. The actual rule is diff-level: if any remaining file clears the minimum, smaller companion files are also sent. A manual capture containing a 15-line logic change and a two-line new file passed both files as significant. The later configuration section more accurately says a diff is skipped only when every file is below the floor, so the two descriptions conflict.

Several source comments also still describe queue presentation “before final output” as future Phase 7/8 work, even though the implemented architecture deliberately replaced that design with on-demand `grasp review`. These stale comments do not affect runtime behavior but can mislead maintainers.

## Additional bugs and risks found

1. The cost cap has no conservative “budget unknown” state. Any spawn failure, timeout, invalid outer JSON, or missing-cost envelope records a null cost and leaves the session free to try again indefinitely.
2. A nonzero Claude exit can contain valid JSON and a reported cost, but the current catch path never inspects `error.stdout`.
3. The current isolation flags appear correct for Claude Code 2.1.223, but the README specifies no minimum Claude Code version. An older CLI that lacks these newer flags would make every generation call fail gracefully but produce no questions.
4. Simultaneous processes racing to initialize a completely absent SQLite database can still hit `SQLITE_BUSY` during the first WAL-mode switch. Normal `grasp init` creates the database before hooks run, so this mainly matters if the database is deleted while hooks are active.
5. Live authenticated Claude question quality, a genuine Claude Code hook firing, mid-question terminal resizing, and the brief's full-week human dogfooding criterion could not be verified in this unattended environment.

FINAL_VERDICT: FAIL
