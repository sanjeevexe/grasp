# Codex independent test report

## Summary

Grasp builds and runs, and its normal one-hook-at-a-time path is substantial: incremental capture works, many mechanical exclusions work, question generation uses the intended Claude command, limits accumulate across turns, review is usable, and soft/hard gating behaves as designed.

This run still found release-blocking defects. The most serious new finding is a race when Claude Code finishes parallel tool calls. Twelve concurrent `PostToolUse` hooks for one change produced twelve identical captures and twelve paid questions. That bypassed both the default eight-question limit and a separately tested $0.05 cost limit. The same diff was sent and charged for repeatedly.

Several failures from the previous test round also remain:

1. A renamed file with real edits can be counted as zero changed lines and filtered out.
2. Common formatter line-wrapping and obvious generated files pass the filter despite the README saying they are excluded.
3. Repository-root config is ignored when Claude Code runs from a subdirectory; `grasp init` also writes to that subdirectory instead of the repository root.
4. A new concept can still be presented without the required concept-first question, and invalid concept tags are accepted.
5. Valid JSON with wrong setting types is not validated, and malformed config can make the internal hook exit nonzero before its graceful error handling starts.

These defects can miss real work, generate low-value questions, duplicate paid calls, bypass safety limits, or silently ignore repository settings. I would not rely on this version for real work yet.

### Test environment and isolation

- Node: `v26.5.1`; npm: `11.17.0`.
- `npm install`, `npm run build`, `grasp --version`, and `grasp --help` succeeded. Version output was `0.1.0`.
- The automated suite passed all 51 tests.
- The installed `claude` executable reported `loggedIn: false` under the isolated home, so generation used a controlled mock executable named `claude`, following the project’s established test pattern.
- The exact real generation command was accepted by the installed current Claude CLI at argument parsing, but it could not authenticate under the scratch home.
- Hook behavior was driven with documented hook JSON through `grasp internal:hook`. Current official Claude Code documentation confirms Grasp’s matcher, deny object, and `systemMessage` shapes, and also confirms that parallel tool calls can run `PostToolUse` hooks concurrently.
- All Grasp commands used `/private/tmp/grasp-codex-test.Eit9Ii` as the test root, with separate scratch homes and repositories underneath it. The developer’s real `~/.grasp/history.db` was not read or modified.

## 1. Build, install setup, automated tests, and basic CLI — PASS

`npm install` completed, TypeScript compiled, and the built command printed the expected version and help. A first isolated invocation created the documented default config and SQLite database under the scratch home.

`grasp init` showed the cost/usage disclosure before writing, installed one hook each for `PreToolUse`, `PostToolUse`, and `Stop`, used the documented 45-second outer timeout, and was idempotent when rerun from the repository root.

The 51 automated tests passed, including filter rules, config merging, sequential cost/question limits, malformed model responses, missing cost handling, and concurrent SQLite writers. The failures below are gaps that suite does not currently cover.

## 2. Diff capture and mechanical filtering — FAIL

### What worked

- Sequential checkpoint capture reported only new additions after the session baseline. Pre-existing uncommitted text appeared only as unchanged context, not as an added line.
- Repeating `PostToolUse` with no new change produced no second capture or model call in the sequential case.
- A later change produced a new tree-to-tree hash and one new capture.
- The scratch index did not alter the repository’s real staged/unstaged status.
- Gitignored files were not captured.
- `package-lock.json`, `.grasp.json`, and `.claude/settings.local.json` were excluded.
- One- and two-line trivial changes, configured maximum sizes, ordinary whitespace-only rewrites, and user ignore rules were covered by passing automated tests.

### What is broken

**Parallel hooks duplicate the same change.** The [current Claude Code hook reference](https://code.claude.com/docs/en/hooks) says `PostToolUse` hooks can run concurrently for parallel tool calls. I launched twelve hook processes together after one four-line change. All twelve captured the exact same tree range and all twelve created events. This reproduced three times. The checkpoint update is not claimed atomically, so every process can read the same old checkpoint before any process advances it.

**Edited renames still lose their line counts.** Git reported `R073 src/old-name.ts src/new-name.ts` and `2 2 src/{old-name.ts => new-name.ts}`. Grasp recorded the rename and its hunk but reported `+0/-0`, then filtered it as below the three-line minimum. The numstat parser does not expand Git’s compact brace-style rename path back to the new filename.

**Common formatting-only changes still pass.** Rewriting one call from one line onto five lines was counted as six changed lines and passed as meaningful. Grasp only recognizes formatting when removed and added lines match one-for-one after whitespace normalization. Normal formatter line wrapping changes the number of lines, so the broad documentation claim is not met.

**Obvious generated files still pass.** A six-line `src/api.generated.ts` beginning with `AUTO-GENERATED FILE. DO NOT EDIT.` passed as significant. Grasp excludes a fixed set of lockfiles/directories but has no general generated-file rule.

## 3. Question generation and concept memoization — FAIL

### What worked

- Grasp invoked one process with the intended arguments: `claude -p <prompt> --output-format json --allowedTools "" --max-turns 1`.
- The prompt contained only post-filter files, their diff hunks, and the global list of answered concept tags.
- A controlled concept question followed by an instance question was stored in the intended order and formed a sensible pair.
- After `validation-boundaries` was answered in repository A, a response using that tag in repository B became instance-only even though the mock supplied another concept question. Cross-repository memoization is therefore enforced by Grasp, not merely requested from the model.
- A model decline created no pending question but preserved its reported cost.
- Error envelopes, malformed output, missing cost, and process failures never became questions.

### What is broken

For a brand-new `brand-new-concept` tag, the mock returned `questionConcept: null` plus an instance question. Grasp accepted it as a successful instance-only event. This violates the project’s core concept-first rule: instance-only is valid only after that concept was previously answered.

The parser also accepted `Not Kebab Case!` even though the generation contract requires short kebab-case tags. Different capitalization or punctuation for the same idea can therefore defeat memoization and cause repeated teaching.

Because no authenticated Claude CLI was available, this run verified command compatibility, prompt contents, parsing, storage, and memoization, but could not judge the quality of questions from the current real Claude service.

## 4. Cost cap and question-count cap — FAIL

### Sequential behavior passed

- With a one-question limit, turn 1 generated one event and turn 2 under the same `session_id` did not invoke Claude; it logged `cap_reached`.
- With a $0.015 cost limit and mock cost of $0.01 per call, turns 1 and 2 ran, reaching $0.02; turn 3 did not invoke Claude and logged `cap_reached`.
- Changing `prompt_id` did not reset either total. Both limits accumulate across the whole `session_id`, as required.

### Parallel behavior is broken

The same race described in the capture section bypasses both checks because every hook process reads the session totals before any peer writes its event.

- With the default eight-question limit, twelve simultaneous hooks produced twelve real questions, no cap misses, and twelve identical diff hashes.
- With `costCapUsd: 0.05`, `questionsPerSessionCap: 100`, and $0.01 per mock call, twelve simultaneous hooks produced $0.12 of recorded spend with no cap misses.

Even without concurrency, the cost setting is a “stop after already-recorded spend reaches the value” limit, so one final call can cross it. That is understandable because the next cost is unknown, and the README mostly reflects it. The much larger parallel bypass is not an unavoidable version of that tradeoff; it is a race.

## 5. `grasp review` answer, blank-answer, skip, and batch flow — PASS

The review UI was exercised in a real pseudo-terminal.

- It showed the repository, stored summary, colored diff, and concept question before the instance question.
- Leaving it idle for several seconds did nothing; questions never auto-dismissed.
- Pressing Enter on an empty answer left the UI on the same question, displayed the validation message, and left `answer_concept`, `answer_instance`, `skipped`, and concept mastery unchanged in SQLite.
- Real concept and instance answers were saved, the event left the pending queue, and its linked concept tag was marked answered.
- Escape opened the optional skip-reason prompt. A second deliberate Enter was required to finish a reasonless skip, which was stored as `skipped = 1`.
- A three-session queue displayed a clear overall count and session count, and rendered the correct stored diff/question for the first item.
- Running `grasp review` without a terminal failed clearly instead of trying to render broken interactive output.

## 6. Soft and hard gate modes — PASS (SIMULATED HOOKS)

- Soft mode emitted no deny decision for a session with a pending question.
- Hard mode returned the currently documented `PreToolUse` deny object for the session that produced the pending question.
- A different session was not blocked by that question.
- Answering the question immediately removed the hard gate.
- A `Stop` event with one pending question and $0.01 spend emitted one combined message with the correct count and `$0.0100` cumulative spend.

This proves Grasp’s decision logic and emitted JSON against the current documented schema. It does not replace a live authenticated Claude Code session. Invalid/malformed config can disable this behavior; that is covered in Sections 7 and 8.

## 7. Failure and timeout handling — FAIL

### Generation failures worked

- A mock exiting with status 7 logged `error`, created no question, and left the hook successful.
- A Claude-style `is_error: true` envelope logged `error` and kept its reported $0.002 cost.
- Invalid outer JSON and malformed inner result logged `error` without crashing.
- Missing `total_cost_usd` was treated as an unknown-cost error, not a free success.
- A hanging process was killed after about 20.1 seconds and logged `timeout`.
- None of those misses created a pending question or activated hard gate.

### Hook startup failure is not graceful

With malformed global config, `grasp internal:hook` exited with status 1 before entering `runInternalHook`’s catch-all protection. This happens because every CLI command calls `ensureInitialized()` before command dispatch. Current Claude Code behavior treats status 1 as non-blocking, so the tool call proceeds, but it displays a hook error and Grasp performs no capture or hard-gate check. That contradicts the code’s own promise that the internal hook must never exit nonzero and means malformed config fails open in hard mode.

## 8. Config loading and repository overrides — FAIL

### What worked

- The global config was created with documented defaults.
- Repository values overrode global values when Grasp ran from the exact repository-root directory.
- Nested threshold objects merged key by key, while arrays replaced the global array, matching the decision log.
- Malformed JSON produced a clear error naming the file and was not overwritten.

### What is broken

**Repository-root settings disappear from subdirectories.** A root `.grasp.json` set cost and question limits to zero and ignored `app.ts`. With hook `cwd` set to the repository’s `sub/` directory, Grasp still called the mock, generated a question about `sub/app.ts`, and stored the repository as the subdirectory. This can bypass cost, gate, filtering, and question-limit preferences during ordinary work from a nested directory.

**`grasp init` has the same root-resolution problem.** Running it from `packages/app/` created `packages/app/.claude/settings.local.json` even though the repository already had its real root hook file. The command described the nested directory as “this repo.” A user who later starts Claude Code at the repository root may not use the nested install they thought covered the repository.

**Setting types and ranges are not validated.** Valid JSON containing `"ignorePatterns": "scripts/"` loaded, then crashed capture with `config.ignorePatterns.some is not a function`. Invalid gate names, negative limits, and wrong numeric types are likewise accepted by the merge layer rather than rejected with an actionable config error.

## 9. Fresh-eyes code and documentation review — FAIL

The code is generally readable and unusually well commented. The README is also honest about on-demand review, no answer grading, shared `cap_reached` values, plain ignore matching, and Claude usage/cost. Material inconsistencies remain:

- “Captures just what’s new since it last looked” is false when `PostToolUse` hooks overlap; the same change can be captured many times.
- The documented question and cost limits are not enforced under that documented Claude concurrency behavior.
- “Formatting-only” and “generated files” are presented as excluded without disclosing the narrow implementations that let common examples through.
- Per-repository config and setup are described as repository-root features, but the implementation uses exact `cwd` without resolving the git root.
- The prompt contract requires concept-first behavior for new tags and kebab-case tag format, but the parser accepts both violations.
- Failure documentation says a failed generation quietly logs a miss. That is true once generation starts, but malformed/wrong-type config can prevent the hook from reaching that protected path at all.

## Additional bugs and risks found

1. **Concurrent checkpoint/cap race is the highest-priority defect.** The checkpoint read/update, cap checks, model call, and event insert are not one serialized operation. SQLite’s busy timeout prevents lock errors but does not prevent logically duplicated work.
2. **Checkpoint snapshots leave unreachable Git objects.** A normal two-capture test left multiple unreachable blob and tree objects visible through `git fsck`. Git may eventually prune them, but long use can add repository object-store churn, and pruning a still-referenced Grasp checkpoint could make later diffs fail. This behavior and its cleanup implications are not explained to users.
3. **Edited rename statistics are still lost.** Real `+2/-2` work becomes `+0/-0`, directly causing a false “too small” result.
4. **Concept-tag format is not enforced.** Model spelling variation can undermine global memoization.
5. **Hard gate can fail open on config problems.** Malformed config exits status 1 before the hook’s protective catch; wrong-type config is caught later but silently skips the gate/capture operation.
6. **The unauthenticated environment leaves one release check open.** The mock and current documentation verify Grasp’s side of the interface, but an authenticated end-to-end Claude Code session is still needed before release.

FINAL_VERDICT: FAIL
