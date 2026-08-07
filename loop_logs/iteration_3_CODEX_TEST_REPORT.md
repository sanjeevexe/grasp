# Codex independent test report

## Summary

Grasp installs, builds, and runs, and several important paths work well. Incremental capture works when hooks arrive one at a time, the intended Claude command is used, limits accumulate across turns in a normal sequential session, `grasp review` rejects blank answers, and both gate modes behave as designed.

This run still found release-blocking defects. The most serious is unchanged from the previous report: simultaneous `PostToolUse` hooks can all capture the same change and all generate a paid question. Twelve concurrent hooks produced twelve identical questions. That exceeded the default eight-question limit; with a separate $0.05 cost limit, the same test spent $0.12. The safety limits therefore do not reliably limit real sessions.

Other previous failures also remain: edited renames can be counted as zero lines and discarded; common formatter wrapping and obvious generated files pass the filter; repository settings are ignored from subdirectories; new concepts can be shown without the required concept-first question; malformed or wrong-type config can crash the hook; and concept-tag format is not validated. A new destructive scratch test also proved that Git cleanup can delete Grasp's checkpoint objects and make later capture fail.

I would not rely on this build for real work yet.

### Test environment and isolation

- Node `v26.5.1`; npm `11.17.0`.
- `npm install`, `npm run build`, and all 51 automated tests succeeded. The built CLI reported version `0.1.0` and displayed help correctly under an isolated home.
- The installed real `claude` executable accepted Grasp's exact flags but reported `loggedIn: false`, so question generation used a controlled mock `claude` executable following the project's established test pattern.
- Behavioral tests used `/private/tmp/grasp-codex-test.hVFCsn` for scratch homes and `.codex-scratch-20260805/` for disposable repositories. Both were removed after testing.
- One isolation mistake occurred immediately after the build: a bare `node dist/cli.js --version` ran before the scratch `HOME` wrapper was applied. Because every Grasp command initializes storage, it attempted to open the real home database and failed with `attempt to write a readonly database`. The sandbox prevented modification, and I never queried the real database, but I cannot honestly guarantee that SQLite did not read database metadata while attempting to open it. Every subsequent command used an explicit scratch home.

## 1. Build, automated tests, and basic CLI — PASS

`npm install` completed, TypeScript compiled, and the built program printed its version and help. First use under a scratch home created the documented `config.json` and inspectable SQLite database with the expected tables.

All 51 automated tests passed. They cover ordinary filtering, config merging, sequential cap math, response parsing, missing-cost handling, and concurrent database writers. The failures below are behavioral gaps not covered by that suite.

`grasp init` displayed the cost and privacy disclosure before writing, installed one hook each for `PreToolUse`, `PostToolUse`, and `Stop`, used a 45-second outer timeout, and did not duplicate entries when rerun.

## 2. Diff capture and mechanical filtering — FAIL

### What worked

- A normal edit was captured as `src/app.ts +4/-3`, with the correct hunk and a reproducible checkpoint range.
- A second sequential hook with no new work created no capture and made no model call.
- A later edit was captured incrementally rather than mixed with earlier work.
- A configured ignore rule excluded its matching path.
- A one-line replacement was filtered as below the minimum size.
- Grasp's own `.grasp.json` and `.claude/settings.local.json` files, lockfiles, ordinary whitespace-only changes, maximum sizes, and Git-ignored files are covered by passing automated tests.

### What is broken

**Parallel hooks duplicate the same work.** Twelve simultaneous `PostToolUse` processes for one change created twelve captures with the same checkpoint range and twelve paid questions. Checkpoint read and update are separate operations, so every process can read the same old checkpoint before any one advances it.

**Edited renames still lose their statistics.** Git reported an 82%-similar rename with `+2/-1`. Grasp recorded the correct old/new paths and hunk but stored `+0/-0`, then filtered the change as below the minimum. Its parser does not expand Git's compact `src/{old-name.ts => new-name.ts}` statistics path back to `src/new-name.ts`.

**Common formatter output still passes.** Rewrapping one function call from one line to five lines, without changing its tokens, was stored as `+5/-1`, passed the filter, and triggered generation. The detector only handles formatting where added and removed lines remain one-for-one.

**Obvious generated files still pass.** A seven-line `src/api.generated.ts` beginning `AUTO-GENERATED FILE. DO NOT EDIT.` passed and triggered generation. The implementation has a fixed path list, not a general generated-file check.

## 3. Question generation and concept memoization — FAIL

### What worked

- Grasp invoked exactly one process with `claude -p <prompt> --output-format json --allowedTools "" --max-turns 1`.
- The prompt contained the filtered diff and globally answered concept tags. The model had no tool access.
- A controlled concept question followed by an instance question was stored and presented in the intended teaching order.
- After `brand-new-concept` was answered in one repository, a later response with that tag in another repository was forced to instance-only even though the mock supplied another concept question. Global memoization works.
- A model decline created no pending question but retained its reported $0.007 cost.
- Process errors, malformed output, error envelopes, and missing cost never became questions.

### What is broken

For a never-before-answered `brand-new-concept`, the mock returned no concept question and one instance question. Grasp accepted it as a successful instance-only event. This violates the project's core rule that a new concept must be taught first; instance-only is valid only after that concept was answered previously.

The parser also accepted `Not Kebab Case!` as a concept tag even though the response contract requires short kebab-case tags. Spelling and punctuation differences can defeat memoization, and arbitrary tag text is later inserted directly into future prompts.

Because no authenticated Claude CLI was available, this run verified Grasp's command, prompt, parsing, persistence, and memoization behavior, but could not judge question quality from the current live Claude service.

## 4. Cost cap and question-count cap — FAIL

### Sequential behavior passed

- With a one-question limit, turn 1 generated one question and turn 2 under the same `session_id` logged `cap_reached` without invoking Claude.
- With a $0.01 limit, turn 1 recorded $0.01 and turn 2 under the same `session_id` logged `cap_reached` without invoking Claude.
- Changing `prompt_id` did not reset either total. Both limits accumulate across the whole Claude session, as required.

### Parallel behavior is broken

- With the default eight-question limit, twelve simultaneous hooks produced twelve real question events, twelve identical diff hashes, and no cap misses.
- With `costCapUsd: 0.05`, `questionsPerSessionCap: 100`, and a mock cost of $0.01 per call, twelve simultaneous hooks recorded $0.12 and no cap misses.

Every process checks old totals before its peers record their calls. SQLite's lock wait prevents database-write errors, but it does not make the checkpoint and limit decisions atomic.

As documented, a normal sequential cost limit is checked before a call, so one final call may cross the configured amount because its cost is not known in advance. That bounded behavior is understandable; the much larger parallel bypass is not.

## 5. `grasp review` answer, blank-answer, skip, and batch flow — PASS

The review interface was exercised in a real pseudo-terminal.

- It displayed the repository, stored summary, colored diff, concept question, and instance question clearly.
- Leaving it idle did nothing; questions never auto-dismissed.
- Pressing Enter on an empty answer kept the same question visible, showed the warning, left both answers null, left `skipped = 0`, and did not mark the concept answered.
- Real concept and instance answers were saved, the event left the queue, and its concept tag became answered.
- Escape opened the optional skip-reason prompt. Until a second deliberate Enter, the database still showed the event as pending. That Enter stored a reasonless skip without marking the concept answered.
- A 33-question, eight-session queue showed accurate overall and per-session counts and kept the first session's questions together.
- Non-interactive `grasp review` failed clearly instead of rendering broken terminal output.

## 6. Soft and hard gate modes — PASS (SIMULATED HOOKS)

- Soft mode emitted no denial for a session with a pending question.
- Hard mode emitted the expected `PreToolUse` deny object for that same session.
- An unrelated session was not blocked.
- Answering the pending question immediately removed the denial.
- A `Stop` hook with four pending questions and $0.04 spend emitted one combined message with the correct count and `$0.0400` total. A quiet session emitted no message.

This verifies Grasp's decision logic and JSON output through simulated hooks. It does not replace a live authenticated Claude Code session. Configuration failures can still disable or crash this path, as described below.

## 7. Failure, timeout, and interrupted-session handling — FAIL

### Generation failures worked

- A mock process exiting with status 7 logged `error`, created no pending question, and left the hook exit status at zero.
- A hung process was killed after 20 seconds, logged `timeout`, created no question, and left the hook exit status at zero.
- Existing automated tests also passed for error envelopes, malformed model results, and missing `total_cost_usd`.
- Sessions that never received `Stop` did not leave a waiting process or prevent later sessions from working.

### Configuration failures are not graceful

A malformed global config caused `grasp internal:hook` to exit 1 before its catch-all hook protection started. A syntactically valid config with `"ignorePatterns": "scripts/"` caused an uncaught `TypeError` and also exited 1.

The wrong-type crash exposes a broader code problem: `checkAndCapture()` starts the async `onChangeDetected()` with `void` instead of awaiting it. A rejected promise escapes the surrounding `try/catch`, so some capture, filter, config, generation, or storage failures can crash the hook despite the code comment promising it will never exit nonzero. Hard mode then fails open because no gate decision is emitted.

## 8. Config loading and per-repository overrides — FAIL

### What worked

- The global file was created with documented defaults.
- A repository-root `.grasp.json` overrode global behavior when the hook's `cwd` was exactly the root.
- Nested threshold objects merge by key and arrays replace the global array, as specified and tested.
- Malformed JSON produced a clear error and was not overwritten.

### What is broken

**Root settings vanish in subdirectories.** A root `.grasp.json` set both limits to zero and ignored `sub/`. With hook `cwd` set to `repo/sub`, Grasp still generated a question about `sub/nested.ts` and stored the repository as the subdirectory. Ordinary work launched from a nested folder can therefore bypass filtering, cost, question, and gate preferences.

**`grasp init` installs in the wrong place from a subdirectory.** Running it from `repo/sub` created `repo/sub/.claude/settings.local.json` even though the real repository already had its root hook file. The command called the subdirectory “this repo,” matching neither Git's root nor the README's claim.

**Types and ranges are not validated.** Grasp accepted an invalid gate name, negative limits, a string `ignorePatterns`, string thresholds, and null thresholds. The string list later crashed capture. Invalid settings should be rejected once, with a clear path and field name, before hooks run.

## 9. Fresh-eyes code and documentation review — FAIL

The code is readable and well commented, and the README is unusually honest about manual review, no grading, Claude usage, plain ignore matching, and shared `cap_reached` values. Material claims remain false or incomplete:

- “Captures just what's new” and “won't re-ask about the same diff twice” are false when hooks overlap.
- The documented question and cost limits are not enforced under concurrent hooks.
- “Formatting-only changes” and “generated files” are described as excluded without disclosing the narrow implementations that let common examples through.
- Per-repository config and setup are described as repository-root features, but the code uses the exact current directory.
- The documented concept-first contract and kebab-case tags are not enforced.
- Failure documentation says generation problems quietly log a miss, but config failures can exit the hook nonzero before or outside the protected path.
- Config is described as strict JSON, but only JSON syntax is checked; field types, allowed values, and ranges are not.

## Additional bugs and risks found

1. **Checkpoint objects are unprotected Git objects.** A short run created dozens of unreachable tree/blob objects. In the disposable repository, `git prune --expire now` deleted the tree SHA stored in Grasp's database; the next hook failed with `fatal: bad object` and captured nothing. Normal Git cleanup uses an age grace period, so this is not an every-session failure, but the design both adds object-store churn and relies on objects Git is allowed to delete.
2. **The concurrent race spans the whole safety pipeline.** Checkpoint read/update, cap checks, model invocation, capture insert, and event insert are not one serialized claim. Fixing only SQLite lock waits cannot prevent duplicate work or excess spend.
3. **Edited rename statistics remain a direct false-negative.** Git's real `+2/-1` change became `+0/-0`, causing a meaningful change to be discarded.
4. **Concept-tag validation is missing.** Besides repeated teaching, arbitrary tags can pollute the future answered-tag prompt.
5. **Authenticated end-to-end Claude Code remains unverified.** The installed CLI accepted the command shape but had no usable authentication in the scratch home.

FINAL_VERDICT: FAIL
