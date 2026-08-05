# Codex independent test report

## Summary

Grasp's main pieces are real and connected: it builds and installs, captures git diffs, applies the documented mechanical filters, invokes the expected `claude -p` command shape, stores questions and costs, presents questions in an interactive terminal, persists answers/skips, and enforces session-scoped hard gates and caps.

However, I would not call this v1 finished yet. Two bugs cut directly against the product's purpose:

1. Every `PostToolUse` hook captures the entire uncommitted diff since `HEAD`, with no checkpoint or duplicate detection. The same unchanged diff generated the same paid question twice on two consecutive simulated turns. It can also include work that existed before the agent acted.
2. `grasp review` accepts an empty answer. Pressing Enter without typing anything for both questions marked the event answered and marked its concept as learned globally.

There are also important reliability and documentation issues: concurrent CLI processes can fail with `database is locked`; `grasp init` can cause Grasp to ask about its own untracked `.claude/settings.local.json`; and the README's headline still implies that Grasp withholds agent output even though the implemented design is an on-demand review inbox.

In plain terms: the underlying pipeline basically works, but the current capture behavior can create repeated or misattributed questions, and the review screen can be bypassed without comprehension. I would fix those before relying on Grasp in daily work or publishing it as complete.

### Test environment

- `npm install`, `npm run build`, and `npm link` succeeded.
- `grasp --version` returned `0.1.0`.
- Node was `v26.5.1`; npm was `11.17.0`.
- There was no `claude` executable on `PATH`, so no authenticated real-Claude call or live Claude Code hook firing was possible. All generation calls used a controlled mock `claude` binary. Hook behavior was exercised by sending documented JSON payloads to `grasp internal:hook`.
- All Grasp commands used isolated scratch `HOME` directories and scratch git repositories. The developer's real `~/.grasp/history.db` was not read or modified.
- The repository contains no automated test suite, so this pass used end-to-end CLI, SQLite, and real pseudo-terminal checks.

## 1. Capture and filtering — PARTIAL

### What I tested

I created separate git repositories for a meaningful validation change, whitespace-only reformatting, a lockfile edit, a two-line replacement, an 801-line new file, and matching `generated/` changes in two repos. One of the latter repos had `"ignorePatterns": ["generated/"]`; the other did not. I tested both `grasp debug:capture` and simulated `PostToolUse` hook payloads.

### What worked

- Meaningful change: passed with `1 file changed (+6/-0)` and produced a stored question.
- Formatting-only change: `formatting_only`.
- `package-lock.json`: `baseline_ignore`.
- Tiny edit: `below_min_threshold`.
- 801-line file: `above_max_threshold`.
- Repo-local `generated/` rule: `user_ignore_pattern` in that repo; the identical path passed in the other repo.
- Filtered captures were retained in `captured_diffs` with their reason, while only passing captures reached generation.

### What is broken or risky

Capture does not identify what the last tool call changed. It runs `git diff HEAD` after every `PostToolUse` and treats the complete current working tree as new work. In a direct test, two hook firings for the same unchanged working tree created two captured rows, two identical question rows, and two separate `$0.003` costs. `events.diff_hash` was `NULL`, and there is no other deduplication key.

This has several user-visible consequences:

- A multi-tool Claude turn can repeatedly ask about the same diff and repeatedly spend usage on it.
- Pre-existing user changes can be attributed to Claude Code.
- A read-only tool firing can generate a question if meaningful uncommitted work is already present.
- A later small change is mixed together with every earlier uncommitted change rather than being captured as its own unit.

I also ran `grasp init` in a repo that did not already ignore `.claude/settings.local.json`. Grasp's newly-created settings file survived filtering as a 39-line significant change. The resulting capture contained both the real code and Grasp's own hook configuration. `.grasp.json` is baseline-ignored, but `.claude/settings.local.json` is not.

## 2. Question generation — PASS (SIMULATED)

### What I tested

The mock recorded the full invocation and returned a controlled Claude JSON envelope. The generated concept question asked why validation should happen before mutation; the instance question then applied that principle to the new `cache.set` ordering. I also generated the same concept in two different repos, answered it in repo A with `grasp debug:answer`, and generated again in repo B.

### What I found

- Grasp invoked the expected single-call shape: `claude -p <prompt> --output-format json --allowedTools "" --max-turns 1`.
- The prompt contained only the significant hunks plus the global answered-tag list.
- The mock's two questions were stored in concept-then-instance order and formed a sensible teaching pair.
- After the concept was answered in repo A, repo B stored only the instance question, even though the mock deliberately returned another concept question. This proves the local database check enforces cross-repo memoization independently of model compliance.

The limitation is important: because no real authenticated Claude CLI existed, this test proves invocation, parsing, persistence, prompt contents, and memoization—not the quality or compatibility of a real current Claude response.

## 3. Cost cap and question cap — PASS

### What I tested

For cost, I set a per-repo `costCapUsd` of `$0.005`, made the mock report `$0.003` per call, and sent three passing turns under the same `session_id`. For question count, I set `questionsPerSessionCap` to `2` and sent three passing turns under another shared session.

### What I found

- Cost calls 1 and 2 ran and accumulated to `$0.006`; call 3 did not invoke the mock and logged `cap_reached`.
- The cost remained cumulative across different `prompt_id` values and even different scratch repos sharing the same `session_id`; it did not reset per turn.
- The question-cap test produced two real question events; the third did not invoke the mock and logged `cap_reached`.
- Mock invocation logs independently confirmed that only two subprocess calls happened in each three-turn test.

One naming caveat: the question cap counts question *events*, not displayed questions. An event of type `both` contains two prompts (concept and instance), so a cap of 8 can still leave up to 16 individual questions in `grasp review`. The README calls this a count of “real questions,” which is likely to surprise users.

## 4. `grasp review` — PARTIAL

### What I tested

I generated an interleaved batch in database order A1, B1, A2, then a gate-session question. I drove `grasp review` through a real pseudo-terminal, waited without input, answered questions, skipped one with Escape, and inspected `events` and `concept_tags` afterward.

### What worked

- The diff was readable: file/status summary, colored additions/deletions, hunk header, concept question, then instance question.
- Doing nothing for 2.5 seconds left the question in place; there is no automatic skip.
- The batch reordered A1 and A2 next to one another even though B1 was inserted between them. The header accurately showed overall and per-session position.
- Typed answers were stored in `answer_concept` and `answer_instance` exactly as entered.
- A real answer flipped the linked `concept_tags.answered` value to `1`.
- Escape did not immediately discard the event. It first opened an explicit optional skip-reason prompt, and only Enter completed the skip.

### What is broken

Empty answers are accepted as real answers. In an isolated direct PTY test I selected “answer,” typed nothing, and pressed Enter for both the concept and instance prompts. The final database row had `answer_concept = ''`, `answer_instance = ''`, `skipped = 0`, and its concept tag had `answered = 1`.

That bypass is easier than the deliberate skip path and causes the concept to be suppressed across every repo in the future. At minimum, blank/whitespace-only answers should be rejected or routed through the explicit skip flow.

The completion screen also disappeared immediately in my PTY run; the process cleared and exited without leaving the coded “All caught up” message visibly on screen. This is minor compared with the empty-answer bug, but it makes completion feel abrupt.

## 5. Gate modes — PASS (SIMULATED HOOKS)

### What I tested and found

- With repo config `gateMode: "hard"` and one real pending question, a simulated `PreToolUse` returned Claude Code's deny JSON with a message pointing to `grasp review`.
- After deliberately skipping that question in the TUI, the same session's next `PreToolUse` returned no deny output.
- With `gateMode: "soft"`, a real pending question never produced a deny response.
- A hard-gated pending question in session A did not block session B, including when session B used a different repo.
- A simulated `Stop` with pending work and spend produced the combined nudge and `$0.0030` cumulative cost message. A quiet zero-cost session produced no message.

This verifies Grasp's decision logic and output format, but not Claude Code's live interpretation of that JSON because no authenticated Claude session was available.

## 6. Failure handling — PARTIAL

### What I tested and found

- A mock that exited with status 7 caused no Grasp crash. The hook exited 0 and an event was logged with `miss_reason = 'error'`.
- A mock that never exited was terminated after about 19.98 seconds. The hook exited 0 and logged `miss_reason = 'timeout'`.
- Neither failure created a pending question, so neither could activate a gate.

The erroring child's stderr (`simulated claude failure`) leaked into the hook command's output. The database behavior is graceful, but the README says failures are quietly logged; in practice a user may see the underlying Claude error text in Claude Code's hook output. The subprocess should capture/suppress expected stderr or replace it with a short controlled notice.

## 7. Config — PASS, WITH VALIDATION RISK

### What I tested

I changed each documented setting globally, observed the behavior, then used a repo override with the opposite behavior.

### What I found

- `ignorePatterns`: a global `generated/` entry filtered a file; repo `ignorePatterns: []` made that identical file pass.
- `costCapUsd`: global `0` stopped generation; repo `0.005` allowed it.
- `questionsPerSessionCap`: global `0` stopped generation; repo `2` allowed it.
- `gateMode`: global `hard` denied a pending session; repo `soft` allowed that same session.

Repo values therefore do win in real behavior, not just in the merge function.

There is no schema or value validation. A typo such as `"gateMode": "hrad"`, a string in place of a number, a negative cap, or a non-array `ignorePatterns` value is accepted at load time and can silently disable or distort behavior. Parse errors are handled well, but valid JSON with invalid Grasp values is not.

Also, `ignorePatterns` does not support glob syntax. Only exact basenames/full paths and directory names ending in `/` work. The README does not explain this, so familiar-looking entries such as `"generated/**"` will silently match nothing.

## 8. Fresh-eyes code and docs review — FAIL (NOT RELEASE-READY)

The implementation is understandable and heavily commented, but the following inconsistencies are material:

- **The README's headline describes a product that is not implemented.** It says Grasp makes the developer explain a change “before it shows you the next thing” and that it closes the gap before moving on. In default soft mode, Claude Code's output is already visible, questions only appear when the user later runs `grasp review`, and nothing prevents moving on. Hard mode blocks a later tool call, not the prior agent output. The later limitations section is more accurate than the headline and package description.
- **Capture is not event-scoped despite the build plan's language.** The code has no before/after checkpoint and no diff hash. `diff_hash`, a documented data field, is `NULL` for all real generated events.
- **Question-cap wording and implementation differ.** It limits event rows, each of which may contain two displayed questions.
- **The declared Node support is wrong.** `package.json` says Node `>=18`, while installed `better-sqlite3@13.0.2` declares Node `>=22`. The decision log explicitly noticed this mismatch but left it unfixed.
- **The README's config example is `jsonc` with inline comments, but Grasp uses strict `JSON.parse`.** Copying the example verbatim into `config.json` will make every Grasp command fail until the comments are removed.
- **No LICENSE file is shipped.** `package.json` and README say MIT, but `npm pack --dry-run` included no license text.
- **No automated regression tests exist.** There is not even a `test` script, despite stateful cap, gate, parsing, migration, and TUI behavior that is easy to regress.

## Additional bugs, risks, and inconsistencies

1. **Concurrent processes can fail to open the database.** I launched seven independent CLI capture checks at once against the same scratch home. Six failed with `database is locked`; only one completed. Grasp uses WAL mode but sets no SQLite busy timeout and runs schema/index work on every `openStore()`. Multiple Claude sessions or overlapping hooks share the same global database, so this is a realistic failure mode.
2. **Generation blocks the hook synchronously.** Every passing `PostToolUse` waits for `claude -p` to finish, up to 20 seconds. Combined with whole-tree duplicate capture, this can repeatedly pause the agent during a multi-tool turn, not merely use otherwise-idle time after completion.
3. **Missing cost is treated as zero.** If a real Claude JSON envelope omits or changes `total_cost_usd`, Grasp records `$0` instead of treating the response as unmetered/error. Repeated calls could then bypass the cost cap.
4. **`cap_reached` cannot always be diagnosed after the fact.** The decision log says cost-cap and question-cap misses remain distinguishable by comparing totals. If both caps have been reached, that data does not reveal which check produced a particular row (the code happens to check cost first).
5. **Existing hook installs are not upgraded.** This is documented as a known limitation: `grasp init` checks only for the command string, so older timeout/config shapes remain until users manually remove and reinstall the entries.

### Recommended fix order

1. Add real per-tool checkpoints or stored snapshots and duplicate suppression; populate and use `diff_hash`.
2. Reject blank/whitespace-only answers and do not mark concept tags learned without meaningful text.
3. Baseline-ignore Grasp's own `.claude/settings.local.json` or automatically ensure it is gitignored.
4. Add SQLite busy handling and a concurrency regression test.
5. Correct the README/package pitch to describe on-demand review and next-tool gating accurately.
6. Align Node engine requirements, add config validation, document ignore-pattern syntax, add a real LICENSE file, and establish an automated test suite.
