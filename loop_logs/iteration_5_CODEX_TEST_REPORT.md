# Codex independent test report

## Summary

Grasp builds, runs, and handles its normal sequential workflow reasonably well. It captures incremental edits, calls the expected headless Claude command, stores questions and costs, presents a readable review screen, rejects blank answers, saves deliberate answers and skips, and applies the basic soft and hard gate decisions.

This run still found release-blocking defects. Most seriously, overlapping `PostToolUse` hooks can all claim the same change and all make a paid Claude call. Twelve simultaneous hooks created twelve copies of one question. That exceeded the default eight-question limit; in a separate test with a $0.05 cost limit, Grasp spent $0.12. The two safety limits are therefore not reliable during realistic process overlap.

Other material failures remain: edited renames can be counted as zero lines and discarded; common formatter wrapping and an explicitly marked generated file reach paid generation; repository settings disappear when Claude runs from a subdirectory; invalid settings can crash the hook; a new concept can be presented without its required concept-first question; hard mode can block on an old question from a resumed session despite the documentation saying it only considers today's work; and Git cleanup can delete Grasp's checkpoint objects and leave capture stuck.

I would not rely on this build for real work yet.

### Test environment and isolation

- Tested commit `7d09210` with Node `v26.5.1` and npm `11.17.0`.
- Every Grasp command used an explicit scratch `HOME`; the developer's real `~/.grasp/history.db` was neither opened nor modified.
- Scratch state lived under `/private/tmp/grasp-codex-20260805.k6NhwX`; disposable repositories and mock binaries lived under `.codex-test-harness/`. Both were removed after testing.
- The real `claude` executable reported `loggedIn: false` under the scratch home. Generation tests therefore used a controlled mock `claude` binary following the repository's established test pattern.

## 1. Build, automated tests, and basic CLI — PASS

`npm install` and `npm run build` succeeded. All 51 automated tests passed twice, including once with the scratch home explicitly set. The built CLI printed version `0.1.0`, displayed help, created the documented scratch config/database, and produced the expected npm package contents in a dry run.

`grasp init` showed the cost/privacy disclosure before writing, installed one 45-second hook for each required event, and did not duplicate them on a second run.

One packaging defect is listed under additional risks: the checked-in lockfile is stale, so the documented `npm install` changes a tracked field.

## 2. Diff capture and mechanical filtering — FAIL

### What worked

- A normal validation edit was captured correctly as `app.ts +6/-0` and passed the filter.
- A second sequential hook with no new work produced no second capture or model call.
- A later edit in the same session was captured as a new checkpoint range rather than mixed with the earlier one.
- A lockfile and Grasp's own hook settings file were excluded by the built-in ignore list.
- A repository-specific `scripts/` ignore rule prevented both generation and a model call, while the same path in another repository generated normally.
- Automated tests passed for simple whitespace-only changes, minimum/maximum sizes, Git-ignored files, user ignore rules, and Grasp's own config files.

### What is broken

**Overlapping hooks duplicate one change.** Twelve simultaneous hooks produced twelve captures with one identical checkpoint range and twelve paid question events. Reading and advancing the checkpoint are separate operations, so every process can read the same old value before another process advances it.

**Edited renames lose their line counts.** Git reported a 61%-similar rename with six inserted lines. Grasp stored the old and new paths but recorded `+0/-0`, then discarded the change as below the minimum. Its statistics parser does not handle Git's compact rename path format.

**Common formatter wrapping passes as meaningful work.** Reformatting one function call from one line to several lines, with no behavior change, was recorded as `+8/-1` and passed. The detector only recognizes formatting where removed and added lines match one-for-one after whitespace normalization.

**Obvious generated code passes.** A file named `src/api.generated.ts` beginning `AUTO-GENERATED FILE. DO NOT EDIT.` was recorded as `+8/-0` and passed. Grasp has a fixed path list, not general generated-file detection, despite the broader README claim.

## 3. Question generation and concept memoization — FAIL

### What worked

- Grasp invoked exactly `claude -p <prompt> --output-format json --allowedTools "" --max-turns 1`.
- The prompt contained the significant application diff and the user's answered concept tags. Tool access was disabled.
- A controlled concept question followed by its related instance question and was stored in the intended order.
- After `validation-before-mutation` was answered in repository A, a later response using that tag in repository B was forced to instance-only. Cross-repository memoization works.
- Error envelopes, malformed output, and missing cost values are covered by passing automated tests and do not become successful questions.

### What is broken or unverified

For a never-before-answered `brand-new-concept`, the mock returned no concept question and one instance question. Grasp accepted it as a successful instance-only event. This violates the core teaching rule: instance-only is valid only after that concept has already been answered.

Grasp also accepted `Not Kebab Case!` as a concept tag even though its model contract requires a short kebab-case tag. Inconsistent tags can defeat memoization, and arbitrary tag text is inserted into later prompts.

Because no authenticated Claude CLI was available, this run verified the command, prompt, response parsing, storage, and memoization logic but could not judge the quality or current live-Claude compatibility of generated questions.

## 4. Cost cap and question-count cap — FAIL

### Sequential behavior passed

- With a one-event question limit, turn 1 generated one event and turn 2 under the same `session_id` logged `cap_reached` without calling Claude.
- With a $0.01 cost limit, turn 1 recorded $0.01 and turn 2 under the same `session_id` logged `cap_reached` without calling Claude.
- Changing `prompt_id` did not reset either total. Both limits accumulate across the whole session during sequential use.

### Parallel behavior is broken

- With the default eight-event limit, twelve simultaneous hooks produced twelve real question events and no cap misses.
- With `costCapUsd: 0.05`, `questionsPerSessionCap: 100`, and a mock cost of $0.01 per call, twelve simultaneous hooks recorded $0.12 and no cap misses.

Each process checks old totals before its peers record their calls. SQLite's lock waiting prevents database-write errors, but it does not make checkpoint claiming, limit checks, model invocation, and event insertion one protected operation.

## 5. `grasp review` answer, blank-answer, and skip flow — PASS

The review interface was exercised in a real pseudo-terminal.

- It displayed the repository, stored summary, colored diff, concept question, and instance question clearly.
- Leaving it idle for five seconds did nothing; no question auto-dismissed.
- Pressing Enter on an empty answer kept the question visible, showed a clear warning, left both answer fields null, and did not mark the concept answered.
- Real concept and instance answers were saved, and the linked concept became answered.
- Escape opened the optional skip-reason prompt. The event remained pending until a second deliberate Enter completed the skip, and skipping did not mark the concept answered.
- Non-interactive use failed with a clear explanation instead of attempting a broken terminal interface.

## 6. Soft and hard gate modes — FAIL

The core decisions worked in simulated hook calls:

- Soft mode allowed a tool call while that session had a pending question.
- Hard mode emitted the expected Claude Code deny object for the session with pending work.
- A different session was not blocked.
- Answering the pending question immediately removed the denial.
- A `Stop` hook combined the correct pending count with the correct `$0.0100` session spend.

However, the documented age boundary is not implemented. After changing a pending event's timestamp to a prior day and simulating the same Claude session being resumed, hard mode still denied the tool call. The testing guide says hard mode only blocks on today's unanswered questions, and the README says it will not block over something left from a different day. The database query checks only `session_id`, not age.

These were simulated hook payloads because an authenticated live Claude Code session was unavailable.

## 7. Failure, timeout, and interrupted-session handling — FAIL

### Generation failures worked

- A mock process exiting with status 7 logged `error`, created no pending question, and left the Grasp hook exit status at zero.
- A hung process was killed after 20 seconds, logged `timeout`, created no pending question, and left the hook exit status at zero.
- A session that never received `Stop` did not leave a waiting process or prevent a separate later session from working.

### Failure handling is still not consistently quiet or safe

The raw child-process message `controlled claude failure` appeared on hook stderr instead of being replaced with a short Grasp message.

A malformed repository config made a realistically launched `grasp internal:hook` exit 1 before the hook's protective handler began. A syntactically valid config with `"ignorePatterns": "scripts/"` produced an uncaught `TypeError` and exited 1. The latter happens because `checkAndCapture()` starts its asynchronous change handler without awaiting it, so a rejection escapes the surrounding `try/catch`. In hard mode, a configuration failure also fails open because no denial can be emitted.

## 8. Configuration loading and per-repository overrides — FAIL

### What worked

- The global file was created with the documented defaults.
- Repository-root settings changed actual cap, gate, and filtering behavior when the hook's working directory was exactly the repository root.
- Nested objects merge by key and arrays replace the global array, as documented and covered by tests.
- Invalid JSON produced a clear path-specific message and was not overwritten.

### What is broken

**Root settings vanish in subdirectories.** A root `.grasp.json` set hard mode, both limits to zero, and ignored `sub/`. With the hook running from `repo/sub`, Grasp still generated and charged for a question about `sub/app.ts`, and stored the repository as the subdirectory. Normal work launched below the root can therefore bypass gate, cost, question, and ignore preferences.

**`grasp init` installs in the wrong directory from a subdirectory.** Running it from `repo/sub` created `repo/sub/.claude/settings.local.json` and called that directory the repository, rather than finding the Git root.

**Types, values, and ranges are not validated.** Grasp accepted `gateMode: "hrad"`, negative cost/question limits, and a string in place of `ignorePatterns`. The string later crashed capture. Invalid settings should be rejected once, with the file path and bad field named, before any hook runs.

## 9. Fresh-eyes code and documentation review — FAIL

The code is generally readable and the README is unusually direct about Claude usage, local storage, manual review, no grading, and plain non-glob ignore matching. Several material claims remain false or incomplete:

- “Captures just what's new” and “won't re-ask about the same diff twice” are false when hooks overlap.
- The documented cost and question limits are not enforced when hooks overlap.
- “Formatting-only changes” and “generated files” are described as excluded without explaining the narrow implementations that allow common examples through.
- Repository setup and overrides are described as repository-root features, but the code uses the exact current directory.
- The concept-first teaching contract and kebab-case concept tags are requested from the model but not enforced by Grasp.
- The README and testing guide say old questions from another day will not hard-block work, but the query has no date condition.
- Failure handling is described as quietly logging a miss, but invalid configuration can crash the hook and raw child stderr is shown.
- Config is described as strict JSON, but only JSON syntax is checked; allowed values, field types, and numeric ranges are not.
- `DECISIONS.md` still contains multiple statements that Node 18 is the package floor even though `package.json` now requires Node 22.

## Additional bugs and risks found

1. **Checkpoint objects can be removed by Git cleanup.** Grasp stores checkpoints as unreferenced Git tree objects. In a disposable repository, `git prune --expire now` deleted the checkpoint still named in Grasp's database. The next hook failed with `fatal: bad object`, recorded no new capture, and left that session stuck on the missing checkpoint. Normal Git cleanup usually has a grace period, so this is not an every-session failure, but Grasp relies on objects Git is allowed to delete.
2. **The concurrency race spans the entire paid pipeline.** Fixing only SQLite lock waits will not prevent duplicate capture or overspend. The operation needs a serialized claim before the model call, with recovery if the claiming process dies.
3. **The checked-in `package-lock.json` is out of sync with `package.json`.** Running the documented `npm install` changed the root package's Node engine metadata from `>=18` to `>=22`, dirtying the tracked lockfile. That test-created change was restored afterward.
4. **Automated coverage misses the release-blocking cases.** All 51 tests pass, but there are no regression tests for concurrent checkpoint/cap claiming, edited rename statistics, formatter wrapping, repository-root discovery, config schema validation, concept-first enforcement, concept-tag validation, old-question gate age, or checkpoint survival/recovery.
5. **Live integration and week-long use remain unverified.** No authenticated Claude Code CLI was available, and an unattended test cannot satisfy the brief's requirement that a real person keep Grasp enabled during normal work for a week.

FINAL_VERDICT: FAIL
