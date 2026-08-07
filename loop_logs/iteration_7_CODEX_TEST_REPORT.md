# Codex independent test report

## Summary

Grasp builds, runs, and passes all 110 automated tests. Most of the product also held up under independent command-line and interactive testing: incremental diff capture, mechanical filtering, generated-file deletion filtering, mock-Claude question generation, cross-project concept memory, session-wide cost and question caps, blank-answer rejection, deliberate skipping, soft and hard gates, repository-specific configuration, ordinary failures, timeouts, and the regressions reported in earlier rounds.

This run nevertheless found one release-blocking privacy and isolation bug, so the verdict is FAIL.

Grasp claims that its question-generation call has all tools disabled and sends no repository contents beyond the filtered diff. The code does not provide those guarantees. It invokes Claude with `--allowedTools ""`. In the installed Claude Code 2.1.223 CLI, `--allowedTools` controls which tools are automatically permitted; the separate `--tools ""` option is explicitly documented as the way to disable all built-in tools. Existing allow rules can also come from the user's settings. Grasp additionally does not use a mode that disables repository customizations, so the nested Claude process can load material such as `CLAUDE.md`, plugins, hooks, MCP configuration, and other normal Claude Code context from its working directory.

The mock invocation log proved the built code passes `--allowedTools ""` and does not pass `--tools ""`, `--safe-mode`, or another equivalent isolation option. A live authenticated model call was not available, so I could not make the model actually attempt a file read, but the installed CLI's own help and the current official Claude Code permission documentation are unambiguous about the flag meanings. The README's privacy promise is therefore false even if the tutor prompt normally gives the model no reason to explore.

### Test environment and isolation

- Tested commit `7cf8dad` on August 7, 2026, with Node `v26.5.1`, npm `11.17.0`, and Claude Code `2.1.223`.
- Grasp state and SQLite databases lived under `/private/tmp/grasp-codex-test.SI7yk6`; disposable Git repositories and mock executables lived under the project-local `.codex-test-scratch/` directory.
- Every Grasp command was run with a disposable `HOME`. The developer's real `~/.grasp/history.db` was neither read nor modified.
- The installed Claude CLI was also checked under the disposable home. It accepted Grasp's exact flags but reported that it was not logged in, so generation tests used the repository's established mock-`claude`-on-`PATH` pattern.
- All disposable homes, repositories, mock logs, and executables were removed after the report was written. Pre-existing untracked files under `loop_logs/` were left untouched.

## 1. Build, automated tests, packaging, and basic CLI — PASS

`npm install` completed successfully, `npm run build` compiled the project, and the built executable printed version `0.1.0` and coherent help. The first-run config and database were created only under the disposable home.

`npm test` rebuilt the real CLI first and passed all 110 tests with no failures. The suite now includes explicit regression tests for the prior generated-file deletion and negative-cost bugs, along with config validation, Git parsing, incremental checkpoints, concurrent capture, cap races, stale reservation ownership, init behavior, and hard-gate age handling.

`npm pack --dry-run --json` contained the executable CLI, runtime modules, README, license, and package metadata. The packaged CLI entry point had executable permissions, and `npm ls --all` found no missing required dependency.

A second clean `npm ci` attempt in an archived scratch copy could not reach `registry.npmjs.org` because this test environment blocks registry DNS. That clean-network reinstall could not be verified here; the required in-workspace `npm install` and build did succeed.

`grasp init`, run from a nested directory, wrote to the repository root, disclosed Claude usage and possible cost before writing, showed the same array-wrapped hook structure that appeared on disk, installed 45-second hooks, and was idempotent on a second run.

## 2. Diff capture and mechanical filtering — PASS

- Manual capture combined staged, unstaged, and untracked changes. Paths, statuses, hunks, and insertion/deletion counts matched Git.
- Hook capture used a session checkpoint. Repeating `PostToolUse` with no new work created no duplicate capture, question, call, or cost.
- A later capture contained only the change made since the prior checkpoint, not the session's older uncommitted work.
- Lockfiles, Grasp's settings, an unchanged generated-file header, a deleted generated file, whitespace-only line reflow, a one-line edit below the size floor, and a repository-specific ignored directory were filtered before generation.
- A normal logic change passed. A deliberately low per-file maximum filtered an oversized change.
- The same `src/ignored/` path passed in a second repository without the override, proving the ignore rule was repository-specific.
- The previous generated-file deletion bug is fixed in a real hook flow: deleting a tracked file headed `// Code generated by a tool. DO NOT EDIT.` recorded `filtered = 1`, reason `generated_file`, and invoked the mock zero times.

Git filenames containing tabs, newlines, or unusual leading/trailing whitespace remain an untested edge case because parsing still relies on line- and tab-delimited Git output. Ordinary names, nested paths, spaces, and renames are covered by the code and test suite.

## 3. Question generation, concept memory, and model isolation — FAIL

### What worked

- The mock received one judge-and-generate call containing the significant hunk and the answered-concept list, not the mechanically excluded files.
- The mock's concept question explained a general boundary-validation idea, and its instance question applied that idea directly to the new guard. The pair made sense in the intended order.
- A valid response stored the exact filtered diff, correct summary, checkpoint range, concept tag, questions, and reported cost.
- After answering `input-validation` in repository A, the same response in repository B became instance-only even though the mock still returned both questions. This proves Grasp enforces cross-project memory itself.
- A model decision that the diff was not worth asking about stored the locally computed diff summary and cost but created no pending question.
- The prompt labels diff text as untrusted data and asks the model not to follow instructions embedded in code.
- The installed real Claude executable accepted Grasp's `-p`, JSON output, allowed-tools, and max-turn flags before returning its unauthenticated response.

### What is broken

Grasp does not actually disable Claude's tools or isolate the nested Claude process from repository context.

The real invocation recorded by the mock was equivalent to:

```text
claude -p <prompt> --output-format json --allowedTools "" --max-turns 1
```

Claude Code 2.1.223 describes these options differently:

- `--allowedTools` adds tool permission allowances.
- `--tools ""` disables all built-in tools.
- Existing permissions may also come from user, project, local, or managed settings.
- Normal startup can load `CLAUDE.md`, skills, plugins, hooks, MCP servers, and other customizations; the CLI separately documents modes for turning those off.

Grasp passes none of the actual isolation options. A user who already allows `Read`, `Bash`, an MCP tool, or another tool can therefore make that tool available to the tutor call. Even if the model never calls one, normal Claude Code context loading can send repository instructions beyond the diff.

This directly contradicts README claims that there is “No full-repo access,” that “no file contents beyond that diff are ever sent,” and that Grasp “runs the generation call with all tool access disabled.” It also fails the build plan's required tool-access constraint. For a product whose own brief calls privacy “load-bearing,” this is release-blocking.

Actual model question quality, live authenticated hook behavior, and whether a real tutor call chooses to use an accidentally available tool could not be verified without authenticated Claude access. The lack of a guaranteed restriction is itself the bug; it does not depend on the model choosing to exploit it during this test.

## 4. Cost cap and question-count cap — PASS

- With a `$0.01` cap and `$0.006` mock calls across three different turns sharing one `session_id`, the first two calls ran and stored `$0.012`; the third logged `cap_reached` without invoking Claude. This matches the documented single-call crossing behavior.
- With a two-event question cap across three turns in one session, two calls generated real events and the third logged `cap_reached` without invoking Claude.
- Mock call logs proved cap-blocked turns never launched the generator.
- The automated six-process races passed, proving overlapping calls cannot multiply spend or questions past the session cap.
- A negative reported cost now becomes an `error` miss with `cost_usd = NULL`; the session total remains zero. This fixes the previous cap-integrity failure.
- Missing costs, malformed results, and model error envelopes are covered by passing integration tests and cannot become free successful questions.

The documented limitation remains: `cap_reached` does not record which cap fired, and old rows become hard to reconstruct after config changes. The one in-flight call that crosses a cost cap can also land slightly above it. Both limitations are stated clearly in the README.

## 5. `grasp review` answer, skip, and batch flow — PASS

- The real Ink interface was exercised in a pseudo-terminal. It displayed the repository, deterministic summary, colored diff, question type, and batch counts readably.
- Doing nothing for several seconds did not advance or dismiss the question.
- Blank and whitespace-only submissions were rejected for both concept and instance answers. The database remained unchanged until real answers were supplied.
- Real concept and instance answers were saved, and the linked concept was marked learned only after the complete answer flow.
- Escape opened the optional skip-reason step. The corrected footer now advertises only Enter there; pressing Enter with a blank reason recorded a deliberate skip and did not mark the concept learned.
- Five pending events were grouped into three session batches with accurate overall and per-session positions.
- Piping into `grasp review` failed clearly with exit code 1 instead of hanging.

The unattended terminal harness does not expose a reliable resize operation, so resizing during a live question remains unverified. The code does listen for terminal resize events and recomputes its visible diff area.

## 6. Soft and hard gate modes — PASS

- Soft mode produced no denial while a recent question was pending.
- `Stop` combined the correct pending count with the four-decimal cumulative cost message.
- A hard-mode repository override loaded correctly even when the hook payload's working directory was a nested subdirectory.
- Hard mode returned the current documented `PreToolUse` denial JSON for a pending question in the same session.
- A different session in the same hard-mode repository was not blocked.
- Explicitly skipping through `grasp review` immediately removed the same-session denial.
- Passing automated tests confirm a pending question older than 24 hours remains visible to review and the Stop nudge but does not block a resumed session.

Current official Claude Code hook documentation still matches Grasp's hook nesting, wildcard matcher, timeout units, `systemMessage`, and `hookSpecificOutput.permissionDecision: "deny"` structure.

## 7. Error, timeout, and interrupted-session handling — PASS

- A mock executable that printed an error and exited nonzero produced an `error` miss, no pending question, no leaked child-process error text, and exit code 0 from the internal hook.
- A mock that slept for 30 seconds was killed by Grasp's inner timeout, logged a `timeout` miss, returned before the installed 45-second outer hook limit, and created no phantom gate.
- A realistic invalid repository key (`gateMod`) made a foreground command fail loudly with a clear correction, while `internal:hook` swallowed the failure and exited 0 as intended.
- Capture and generation state remained usable after interrupted review and ordinary hook failures.

The README's documented narrow hard-kill window remains: a process killed after a capture commits but before generation records an event can lose that one question without retrying.

## 8. Configuration loading and per-repository overrides — PASS

- The disposable global config was created with every documented default.
- Repository overrides changed cost cap, question cap, gate behavior, ignore behavior, and nested size thresholds in real flows.
- Overrides resolved from nested working directories to the Git root.
- The same custom ignore path was excluded in one repository and allowed in another.
- Arrays replace rather than concatenate, while nested objects merge by key, matching the project's stated merge rules.
- Invalid JSON, invalid values, unknown top-level keys, and unknown threshold keys are rejected with actionable messages.

## 9. Fresh-eyes code and documentation review — FAIL

The source is generally readable, carefully commented, and unusually well covered for a small CLI. The README is candid about on-demand review, cap overshoot, stale gates, checkpoint pruning, the hard-kill window, Node 22, and the lack of full-week dogfooding. Previous documentation failures about Node requirements, the local 4 KB generated-header read, and the skip-reason Escape hint are fixed.

One important inconsistency remains and is new to this report: the README's outbound-data and tool-isolation claims do not match either the code or the current Claude CLI. The build plan repeats the obsolete `--allowedTools ""` assumption. The current CLI offers a distinct `--tools ""` disable switch, and also loads repository customizations unless separately restricted. These are security and privacy promises, not stylistic documentation details.

The original `grasp-project-brief.md` also still labels the project “ready for v1 build” and describes answers appearing before the agent's full output, while the implemented and documented architecture is on-demand review after output. `BUILD_PLAN.md` and the README explain the corrected architecture, so this is less serious than the privacy bug, but the brief should be marked as historical or updated to avoid confusing contributors.

## Additional bugs and risks found

1. Because the nested `claude -p` call is not isolated from project settings, it may load Grasp's own project hooks again. With tools truly disabled this would mostly create harmless inner-session bookkeeping; with accidentally available tools it also increases the risk of recursive capture/generation behavior.
2. Simultaneous processes racing to initialize a completely absent SQLite database can still hit `SQLITE_BUSY` while switching the new file into WAL mode. Normal setup creates the database before hooks are installed, so this mainly matters if a user deletes the database while hooks are already active.
3. Git parsing is not NUL-delimited. Filenames containing tabs, newlines, or unusual surrounding whitespace remain a likely edge case.
4. Live authenticated Claude question quality, a genuine Claude Code hook firing, mid-question terminal resizing, a clean registry-backed reinstall, and the brief's full-week human dogfooding criterion could not be verified in this unattended environment.

FINAL_VERDICT: FAIL
