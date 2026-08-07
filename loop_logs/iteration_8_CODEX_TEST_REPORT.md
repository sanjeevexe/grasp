# Codex independent test report

## Summary

Grasp builds, starts, and works correctly in a normal sequential happy path. It captured staged, unstaged, and untracked changes; avoided repeating an unchanged edit; filtered several common kinds of noise; generated and stored mock questions; remembered an answered concept across repositories; enforced both configured limits across sequential turns in one Claude session; presented a readable review screen; rejected blank answers; saved real answers and deliberate skips; and made the basic soft/hard gate decisions correctly.

This run still found release-blocking defects. Most seriously, overlapping `PostToolUse` hooks can all claim the same edit and all make a paid Claude call. Eight simultaneous hooks created eight copies of one question, spent $0.016 despite a $0.003 cost limit, and exceeded a two-question limit without logging any cap miss. Repository overrides also disappear when Claude's `cwd` is a subdirectory, so hard mode and both safety limits can be bypassed. A valid JSON config with the wrong field type crashed the hook and permanently lost the edit it was processing.

Other real failures remain: edited renames in nested paths are counted as zero lines and discarded; obvious generated files and common formatter line wrapping reach paid generation; a brand-new concept can be presented without the required concept-first question; invalid concept tags are accepted; old pending work can block a resumed session despite the documentation saying different-day work will not block; and Git cleanup can delete Grasp's stored checkpoint and leave that session unable to capture later work.

I would not rely on this build for real work yet.

### Test environment and isolation

- Tested commit `7d09210` on August 5, 2026, with Node `v26.5.1` and npm `11.17.0`.
- Every Grasp command used a disposable home under `.codex_test_scratch/`; all repositories, mock Claude binaries, logs, npm cache, configs, and databases were disposable. The developer's real `~/.grasp/history.db` was never opened or inspected.
- The real Claude executable was present but reported `loggedIn: false` under the scratch home. Live model quality and a real authenticated Claude Code hook session could not be verified; generation was tested with the repository's established mock-binary-on-`PATH` pattern.
- The scratch tree was removed after testing. The `npm install` change to the stale lockfile was also restored. Pre-existing `loop_logs/` content was left untouched.

## 1. Build, automated tests, packaging, and basic CLI — PASS

`npm install` and `npm run build` succeeded. All 51 automated tests passed. The built CLI printed version `0.1.0`, displayed help, created its config and SQLite database only inside the scratch home, and exposed the documented schema. `npm pack --dry-run` succeeded when given an isolated npm cache and contained the expected package files.

The first package dry-run failed because the machine's normal npm cache was not writable. That was an environment permission problem, not a Grasp failure.

`grasp init` displayed the Claude usage/cost disclosure before writing, installed one 45-second hook for each required event, and did not duplicate hooks when run again.

One packaging inconsistency remains and is listed under additional bugs: the checked-in lockfile is stale, so the documented `npm install` changes a tracked field.

## 2. Diff capture and mechanical filtering — FAIL

### What worked

- Manual capture correctly included a staged edit, an unstaged edit, and an untracked file, with correct file status, line counts, and hunks.
- A meaningful six-line validation change became one question event with the correct summary.
- Repeating `PostToolUse` with no new work created no second capture, question, or charge.
- A later turn captured only its new three-addition/one-deletion edit. Grasp's `.grasp.json` and `.claude/settings.local.json` did not enter the generated-question prompt.
- A lockfile-only change produced `baseline_ignore`; an indentation/spacing-only edit produced `formatting_only`; a one-line replacement produced `below_min_threshold`; a repository `scripts/` rule produced `user_ignore_pattern`; and a deliberately lowered maximum produced `above_max_threshold`. None called Claude.

### What is broken

- **Overlapping hooks duplicate one edit.** Eight simultaneous hooks produced eight captures and eight paid questions for one change. Checkpoint reading and advancement are separate operations, so every process can read the same old checkpoint before another process advances it.
- **Edited nested-path renames lose their size.** Git reported `2/2 src/{rename-source-long.ts => rename-target-long.ts}`. Grasp stored the rename as `+0/-0` and filtered it as too small because its parser does not expand Git's compact brace-form rename path.
- **Obvious generated code is not recognized.** A six-line `src/api.generated.ts` beginning `AUTO-GENERATED FILE. DO NOT EDIT.` passed and caused a Claude call. The implementation has a small fixed path list, while the README broadly says generated files are excluded.
- **Common formatter wrapping is not recognized.** Reformatting one function call from one line to five lines passed as meaningful and caused a Claude call. The detector handles only cases where removed and added lines remain a one-for-one sequence after whitespace normalization.

## 3. Question generation and concept memoization — FAIL

### What worked

- Grasp invoked exactly one headless command with `-p`, JSON output, an empty allowed-tools setting, one turn, and a 20-second timeout.
- The prompt contained only the significant code diff and excluded Grasp's settings/config files.
- Mock responses produced concept and instance questions in the correct order and stored the exact filtered diff shown to the model.
- A model decline produced a costed event with a correct local diff summary but no pending question.
- After the `shared-concept` question was genuinely marked answered in repository A, a response using the same tag in repository B was forced to instance-only. Cross-repository memoization works.
- Error envelopes, malformed results, missing costs, and process failures were conservatively recorded as misses.

### What is broken or unverified

- A mock returned a never-before-answered `brand-new-concept` with no concept question. Grasp accepted it as a successful instance-only event. This violates the core teaching rule: instance-only is supposed to be allowed only after that concept has already been answered. Answering this event would also mark the concept globally learned without ever presenting its concept question.
- A response with concept tag `Not Kebab Case!` was accepted and stored. Inconsistent tag spelling can defeat memoization even though the response contract promises short kebab-case tags.
- Because there was no authenticated Claude CLI, this run could not judge the educational quality of real generated questions or perform a true live hook session.

## 4. Cost cap and question-count cap — FAIL

Sequential enforcement worked across a whole session rather than resetting per turn:

- With a two-event question limit, two different turns generated questions and the third turn logged `cap_reached` without calling Claude.
- With a $0.0015 limit and $0.001 mock calls, two different turns accumulated $0.002 and the third was stopped. Changing `prompt_id` did not reset the total.

Parallel enforcement is broken. With a two-question limit, a $0.003 cost limit, and eight hooks processing the same edit at once, Grasp recorded eight questions, no cap misses, and $0.016 total cost. SQLite's wait setting prevented database-lock errors, but it did not make checkpoint claiming, cap checking, the paid call, and event recording one protected operation.

Even sequentially, the cost limit is checked only before a call, so one final call can take the total above the configured amount. The README calls this a cap but does not explain that it may be exceeded by one full generation call.

## 5. `grasp review` answer and skip flow — PASS

The review UI was exercised in a real pseudo-terminal with a two-event batch.

- It clearly displayed repository, summary, colored diff, concept question, instance question, total pending count, and session grouping.
- Leaving the question alone did not dismiss it.
- Entering answer mode and submitting a blank value kept the event pending, showed a clear warning, left both answer fields null, and did not mark the concept answered.
- A real concept answer and instance answer were stored, and the linked concept became globally answered.
- Escape opened the optional skip-reason prompt. A second deliberate Enter completed the skip; skipped concepts were not marked answered.

## 6. Soft and hard gate modes — FAIL

The main gate logic worked when the hook's `cwd` was exactly the repository root:

- Soft mode emitted no denial with pending questions.
- Hard mode denied the same session, did not deny an unrelated session, and stopped denying immediately after answer/skip.
- `Stop` combined the correct pending count with `$0.0040` cumulative session spend, while a quiet session emitted no message.

However, hard mode was bypassed from a subdirectory. A root `.grasp.json` set `gateMode` to `hard`; the pending session was denied from the repository root but allowed from `repo/src`. Grasp loads config from the exact `cwd` and never resolves the Git root.

The README and testing guide also say work from a different day will not block. After changing pending-event timestamps to January 1, 2000, Grasp still denied the resumed session because its query checks only `session_id`, not age or day.

## 7. Failure, timeout, and interrupted-session handling — FAIL

### What worked

- A mock Claude error returned hook exit code 0, logged `miss_reason: error`, recorded the known cost, and created no pending question.
- A process-level Claude failure returned hook exit code 0 and logged `error` with unknown cost.
- A hanging Claude process was killed after about 20.1 seconds, returned hook exit code 0, logged `miss_reason: timeout`, and created no pending question.
- A session that never received `Stop` did not hang or prevent later sessions from operating.

### What is broken

A syntactically valid config containing `"ignorePatterns": "scripts/"` caused `config.ignorePatterns.some is not a function`. The production hook exited 1 with a stack trace. Worse, Grasp advanced its checkpoint before the asynchronous change handler failed. After the config was fixed, retrying captured only the config-file correction as an ignored diff; the original code edit produced no capture row and no event row and was permanently lost.

This contradicts the code and documentation's graceful-failure promise. Config values need schema validation before use, and the change handler must be awaited or caught before committing the checkpoint.

The process-error test also printed the mock child process's raw stderr even though Grasp otherwise degraded successfully. In a real hook transcript that may be noisier than the promised quiet failure behavior.

## 8. Configuration loading and per-repository overrides — FAIL

### What worked

- The global file was created with the documented defaults.
- Root-level repository overrides changed question limits, cost limits, ignore rules, thresholds, and gate mode when commands ran from that exact directory.
- Nested objects merged by key, arrays replaced rather than concatenated, and one repository's ignore rule did not leak into another.
- Invalid JSON was rejected with a clear error and was not overwritten.

### What is broken

- Root settings vanish from subdirectories. The hard-gate reproduction above proves the issue; the same flaw also makes repository cost limits, question limits, thresholds, and ignore rules disappear.
- `grasp init` uses the exact current directory instead of discovering the Git root. When run from `repo/src`, it proposed writing `repo/src/.claude/settings.local.json`, despite the README describing repository-root setup.
- Valid JSON values are not checked for correct types, allowed values, or sensible ranges. Wrong types can crash the hook and lose work; misspelled gate modes and negative limits are silently accepted.

## 9. Fresh-eyes code and documentation review — FAIL

The code is generally readable, and the README is direct about local storage, Claude usage, manual review, no grading, and the lack of a fallback generator. Material claims are still false or incomplete:

- “Won't re-ask about the same diff twice” and both advertised caps are false when hooks overlap.
- “Formatting-only changes” and “generated files” are described as excluded without explaining the narrow implementations that let common examples through.
- Repository configuration and setup are described as rooted at the repository, but production code uses the exact current directory.
- Concept-first teaching is requested from the model but not enforced by Grasp.
- Failure handling is described as graceful, but a wrong config type can terminate the hook and silently lose the captured edit.
- The README/testing guide's different-day hard-gate claim is not implemented.
- The cost limit is presented as a ceiling without disclosing that a final call can overshoot it.

## Additional bugs and risks found

1. **Git cleanup can break capture permanently for a session.** Grasp stores checkpoints as unreferenced Git tree objects. After `git prune --expire now` removed a checkpoint representing pre-existing uncommitted work, two later hook attempts both failed with `fatal: bad object`; no new capture or event was recorded.
2. **The checked-in lockfile is out of sync with `package.json`.** Running the documented `npm install` changed the root package's Node engine metadata from `>=18` to `>=22`. The test-created change was restored afterward.
3. **Automated coverage misses the release-blocking cases.** All 51 tests pass, but there are no tests for concurrent checkpoint/cap claiming, compact rename statistics, generated-file recognition, formatter wrapping, repository-root discovery, config schema validation, concept-first enforcement, invalid concept tags, old-question age, or checkpoint recovery.
4. **Live integration and week-long use remain unverified.** No authenticated Claude Code CLI was available, and an unattended run cannot satisfy the brief's requirement that a person keep Grasp enabled during normal work for a week.

FINAL_VERDICT: FAIL
