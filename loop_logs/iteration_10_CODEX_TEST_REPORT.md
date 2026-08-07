# Codex independent test report

## Summary

Grasp builds, runs, and has a solid basic sequential workflow. It captured staged, unstaged, and untracked changes; filtered simple lockfile, whitespace-only, size, and configured-ignore cases; invoked a mock Claude CLI with the promised restrictions; accumulated limits across turns in one session; displayed a readable review screen; rejected blank answers; saved real answers and deliberate skips; remembered an answered concept across repositories; and switched between soft and hard gate behavior.

This run still found multiple release-blocking defects, including regressions from the previous report. The most serious is that overlapping hooks can all claim the same edit and all make a paid Claude call. Eight simultaneous hooks produced eight copies of one question, spent $0.016 despite a $0.003 setting, and exceeded a two-question limit without logging any cap miss. Repository overrides also disappear when Claude's working directory is a subdirectory, so hard mode and both safety limits can be bypassed.

Other material failures remain: a valid JSON config with the wrong field type crashes the hook and permanently loses the edit; edited nested renames can be counted as zero lines and discarded; obvious generated files and common formatter wrapping reach paid generation; a brand-new concept can be accepted without the required concept-first question; invalid concept tags are stored; old pending work can block a resumed session despite the documentation; and Git cleanup can delete Grasp's checkpoint and leave that session unable to capture later work.

I would not rely on this build for real work yet.

### Test environment and isolation

- Tested commit `7d09210` on August 5, 2026, with Node `v26.5.1` and npm `11.17.0`.
- All substantive Grasp tests used disposable homes and repositories under `.codex_test_scratch/`. Mock binaries, logs, configs, Git objects, npm cache data, and SQLite databases were kept there.
- One early version/help command accidentally inherited the normal home. Grasp tried to initialize its normal database path and the workspace sandbox rejected it with `attempt to write a readonly database`; no write succeeded and no SQL query was run against that database. Every later Grasp invocation used an explicit scratch home.
- The installed real Claude executable reported `loggedIn: false` under the scratch home. Live model quality and a truly authenticated Claude Code hook session could not be verified. Generation was tested with the repository's established mock-`claude`-on-`PATH` pattern.
- The scratch tree was removed after testing. The `npm install` lockfile change was restored. Pre-existing `loop_logs/` content was left untouched.

## 1. Build, automated tests, packaging, and basic CLI — PASS

`npm install` and `npm run build` succeeded. All 51 automated tests passed. The built CLI printed version `0.1.0`, displayed help, created defaults and a database in the scratch home, and ran its commands. `npm pack --dry-run --json` succeeded with a scratch npm cache and listed the expected executable and supporting files.

`grasp init` clearly disclosed Claude usage and possible cost before writing, installed the three required 45-second hooks, and did not duplicate them on a second run.

One packaging inconsistency remains: the checked-in lockfile is stale. Running the documented `npm install` changes its root Node requirement from `>=18` to `>=22`. The test-created change was restored afterward.

## 2. Diff capture and mechanical filtering — FAIL

### What worked

- Manual capture included a staged new file, an unstaged edit, and an untracked new file, with correct paths, statuses, line counts, and hunks.
- A meaningful validation change produced one stored capture and one question. Repeating `PostToolUse` without another edit produced no duplicate in the normal sequential case.
- A lockfile-only edit was filtered as `baseline_ignore`.
- A whitespace-only reindent was filtered as `formatting_only`.
- A one-line replacement was filtered as below the minimum threshold.
- A configured `scripts/` ignore rule produced `user_ignore_pattern`, while the same kind of file in another repository was unaffected.
- A lowered per-file maximum correctly filtered a six-line file as above the maximum.
- Grasp's own `.grasp.json` and `.claude/settings.local.json` are in the built-in ignore list.

### What is broken

- **Overlapping hooks duplicate one edit.** Eight simultaneous `PostToolUse` processes created eight captures and eight question events with the exact same diff hash. All eight called Claude. Checkpoint reading and advancement are separate operations, so each process can read the old checkpoint before another process advances it.
- **Edited nested renames can lose their size.** Git reported `2/2 src/{rename-source-verbose.ts => rename-target-verbose.ts}` and an `R057` rename. Grasp stored it as `+0/-0` and filtered it below the size threshold because its statistics parser does not expand Git's compact brace-form rename path.
- **Obvious generated code is not recognized.** A seven-line `src/api.generated.ts` beginning `AUTO-GENERATED FILE. DO NOT EDIT.` passed filtering. The implementation has only a small fixed path list, while the README broadly says generated files are excluded.
- **Common formatter wrapping is not recognized.** Reformatting `return input.trim();` onto two lines passed as meaningful. The detector only handles formatting where removed and added lines remain a one-for-one sequence after whitespace normalization.

## 3. Question generation and concept memoization — FAIL

### What worked

- Grasp invoked `claude` once with `-p`, JSON output, empty allowed tools, and one maximum turn. The prompt contained the significant diff and the answered-concept list.
- A normal mock response produced concept and instance questions in the right order.
- A model decline stored the local diff summary and cost without creating a pending question.
- After `validation-branching` was genuinely answered in repository A, a response using that tag in repository B was forced to instance-only. Cross-repository memoization works.
- Missing costs, error envelopes, malformed results, and process failures are recorded conservatively rather than accepted as free successful questions.

### What is broken or unverified

- A mock returned a never-before-answered `brand-new-concept` with no concept question. Grasp accepted it as a successful instance-only event. This breaks the core concept-first teaching rule and would allow the concept to be marked learned without ever presenting its general question.
- A response with concept tag `Not Kebab Case!` was accepted and stored even though the response contract requires a reusable kebab-case tag. Inconsistent spelling can defeat memoization.
- With no authenticated Claude CLI, this run could not judge whether real questions are educational, correctly paired, or consistently tagged.

## 4. Cost cap and question-count cap — FAIL

Sequential accumulation works across a whole Claude session rather than resetting per turn:

- With a two-event question limit, two different turns generated questions and the third logged `cap_reached` without calling Claude.
- With a $0.003 cost setting and $0.002 mock calls, costs accumulated across different `prompt_id` values. The third turn was stopped after the first two had spent $0.004.

There are two real failures:

- **Parallel enforcement is absent.** With a two-question limit and $0.003 cost setting, eight simultaneous hooks recorded eight real questions, no cap misses, and $0.016 total spend.
- **The cost setting is not a ceiling even sequentially.** Grasp checks only the amount already spent before starting another call. A $0.003 setting therefore allowed a second $0.002 call and ended at $0.004. The README calls this a cap without explaining that one full call can take the total over it.

## 5. `grasp review` answer and skip flow — PASS

The real Ink interface was exercised in pseudo-terminals, including a 15-question, six-session accumulated batch.

- It showed repository, local diff summary, colored additions/deletions, concept question, instance question, and accurate batch/session position.
- Doing nothing left the question on screen; there was no automatic skip.
- Submitting blank answer text kept the event pending. The database still had null answers and the concept remained unanswered.
- Real concept and instance answers were stored and marked the linked concept answered.
- Escape opened the optional skip-reason step. A second deliberate Enter completed the skip; the skipped concept was not marked answered.
- Both an answered hard-gated session and a skipped hard-gated session became unblocked immediately afterward.
- Running `grasp review` without an interactive terminal failed clearly instead of hanging.

## 6. Soft and hard gate modes — FAIL

The main root-directory behavior worked:

- Soft mode allowed the next tool call even with a pending question.
- Hard mode denied the session that owned the pending question and stopped denying immediately after answer or skip.
- `Stop` combined the pending count with the correct four-decimal cumulative cost message.

However, hard mode was bypassed from a subdirectory. A repository-root `.grasp.json` set hard mode; the same pending session was denied when `cwd` was the repository root but allowed when `cwd` was `repo/src`. Grasp loads configuration from the exact directory rather than resolving the Git root.

The README and testing guide also say old work from a different day will not block. After pending timestamps were changed to January 1, 2000, hard mode still denied the resumed session because the query checks only `session_id`, not date or age.

## 7. Failure, timeout, and interrupted-session handling — FAIL

### What worked

- A child-process failure returned a logged `error` miss and did not create a pending question.
- A Claude error envelope logged `error` and preserved its known $0.007 cost.
- A hanging mock was terminated after about 20 seconds, returned normally, and logged `timeout` with no pending question.
- Multiple sessions that never received `Stop` did not hang the database or prevent later sessions from operating.

### What is broken

A syntactically valid config containing `"ignorePatterns": "scripts/"` caused `config.ignorePatterns.some is not a function`. In the real repository working directory, the hook exited 1 with a stack trace. Worse, Grasp had already advanced its checkpoint before the asynchronous change handler failed. After the config was fixed, retrying captured only the config correction as an ignored diff; the code change had no capture row or event row and was permanently lost.

This contradicts the promise that hooks never crash and failures degrade gracefully. Config values need schema validation, and checkpoint advancement must not commit an edit before filtering/generation has either succeeded or been safely logged.

The process-failure case also printed the mock child's raw stderr. That is less graceful than the documented quiet failure behavior, though the hook itself continued.

## 8. Configuration loading and per-repository overrides — FAIL

### What worked

- The scratch global file was created with the documented defaults.
- Root-level repository overrides changed gates, limits, thresholds, and ignore behavior.
- Nested objects merged by key, arrays replaced rather than concatenated, and one repository's ignore rule did not affect another repository.
- Invalid JSON is rejected clearly and is not overwritten.

### What is broken

- Repository settings vanish from subdirectories. This bypasses hard mode and likewise bypasses repository cost limits, question limits, thresholds, and ignore rules.
- `grasp init` uses the exact current directory. Running it from `repo/src` wrote `repo/src/.claude/settings.local.json` instead of the repository-root file described by the README.
- Valid JSON values are not checked for correct types, allowed choices, or sensible ranges. Wrong types can crash a hook and lose work; an invalid mode such as `"hadr"` is silently treated like soft mode.

## 9. Fresh-eyes code and documentation review — FAIL

The code is generally readable, and the documentation is direct about local storage, Claude usage, manual review, no answer grading, and the single generation path. Several material claims are still false or incomplete:

- “Won't re-ask about the same diff twice” and both advertised safety limits are false when hooks overlap.
- “Generated files” and “formatting-only changes” are described as excluded without explaining the narrow implementations that let common examples through.
- Repository configuration and setup are described as repository-root behavior, but production code uses the exact `cwd`.
- Concept-first teaching is requested from the model but is not enforced by Grasp.
- Failure handling is described as graceful, but a wrong config type can terminate the hook and silently lose the edit.
- The different-day hard-gate claim is not implemented.
- The cost limit is presented as a cap without disclosing that a final call can overshoot it.

## Additional bugs and risks found

1. **Git cleanup can break capture permanently for a session.** Grasp stores checkpoints as unreferenced Git tree objects. After `git prune --expire now` removed a checkpoint representing pre-existing uncommitted work, two later hook attempts both failed with `fatal: bad object`; no capture or event was recorded.
2. **The checked-in lockfile is out of sync with `package.json`.** The documented install changes its root Node engine from `>=18` to `>=22`.
3. **Automated coverage misses the release-blocking cases.** All 51 tests pass, but there are no tests for concurrent checkpoint/cap claiming, compact rename statistics, generated-file recognition, formatter wrapping, repository-root discovery, config schema validation, concept-first enforcement, invalid concept tags, old-question age, or checkpoint recovery.
4. **Live integration and week-long use remain unverified.** No authenticated Claude Code CLI was available, and an unattended test cannot satisfy the brief's requirement that a person keep Grasp enabled during normal work for a week.

FINAL_VERDICT: FAIL
