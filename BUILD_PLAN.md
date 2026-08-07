# Grasp — v1 Build Plan

Stack: Node/TypeScript, `ink` for the TUI (see [DECISIONS.md](DECISIONS.md) for reasoning). Target: `npm install -g grasp-cli`, binary aliased to `grasp`.

Each phase below is independently runnable and manually verifiable — you should be able to stop after any phase, exercise it by hand, and see real behavior, not just green tests. Phases build strictly on the ones before them. Nothing from the brief's Section 4 deferred table (heuristics fallback, BYOK, presence-adaptive delivery, longitudinal dashboard, answer grading, spaced repetition, prediction mechanic, multi-agent review, browser extension/desktop app) appears in any phase — all of it is out of scope for this plan.

---

## Phase 1 — Scaffolding, config loading, and local data store

**Delivers:**
- `grasp` binary installable via `npm link` (standing in for `npm install -g` during dev), responds to `grasp --version` / `grasp --help`.
- Config file loader implementing the two-tier JSON scheme from [DECISIONS.md](DECISIONS.md#2026-08-04--config-file-format-and-location): global defaults at `~/.grasp/config.json` (created on first run), optionally deep-merged with a per-repo `.grasp.json` whose values win on conflict. Schema covers the four required settings with their decided defaults — gate mode (`soft`), cost cap (`0.25`), ignore patterns (`[]` beyond the built-in lockfile/generated-file list), questions-per-session cap (`8`) — plus the diff-size thresholds from Phase 4 (min 3 lines, max 1500 total / 800 per file) — even though most of these aren't read by anything yet.
- SQLite store at the documented path (e.g. `~/.grasp/history.db`), created on first run, implementing the schema decided in [DECISIONS.md](DECISIONS.md#2026-08-04--sqlite-schema-specifics): an `events` table (timestamp, repo, diff_hash, diff_summary, question_concept, question_instance, question_type, generation_source, miss_reason nullable, answer_concept nullable, answer_instance nullable, skipped, skip_reason nullable, cost_usd nullable) plus a separate `concept_tags` join table (event_id, tag, answered) indexed on `tag`.
- A minimal data-access layer: insert an event row, query events, and query `concept_tags` globally across all repos for a given tag (memoization lookup is user-scoped, not repo-scoped — see Phase 5).

**Implements:** brief §3.5 (local-first, inspectable data), the "installs and runs with a single command" and "config file" success criteria.

**Manual verification:**
1. `npm link && grasp --version` prints a version.
2. First run creates `~/.grasp/` with `config.json` and `history.db`; deleting and re-running recreates them with the decided defaults (gate: soft, cost cap: 0.25, questions-per-session cap: 8).
3. Drop a `.grasp.json` in a scratch repo overriding one setting (e.g. an ignore pattern) and confirm the loaded config for that repo reflects the override while `~/.grasp/config.json` elsewhere is untouched.
4. `sqlite3 ~/.grasp/history.db ".schema"` shows `events` and `concept_tags` as two separate tables, matching the decided schema — confirm it's plain and inspectable, not obfuscated.
5. Write a tiny throwaway script (or a `grasp debug:seed` dev command) that inserts one fake event row plus a linked `concept_tags` row, then confirm both are visible via `sqlite3 ~/.grasp/history.db "select * from events;"` / `"select * from concept_tags;"`.

---

## Phase 2 — Diff capture core (adapter interface + git-diff capture)

**Delivers:**
- The `AgentAdapter` interface from brief §5.1 (`onChangeDetected`, `onSessionComplete`, `supportsHeadlessSelfInvocation`, `reportsCost`), with types but no Claude-Code-specific wiring yet.
- A minimal git-diff-based capture implementation: given a repo path, poll/compare working-tree state and produce a diff object (files touched, hunks, diff text).

**Implements:** brief §5.1's adapter abstraction and its agent-agnostic fallback capture path.

**Why this phase before the Claude Code adapter:** the git-diff path is the simplest possible producer of a real diff object, with no hooks, no subprocess orchestration, and no Claude-Code-specific plumbing in the way. Building and testing the capture core against it first means Phase 3 only has to prove that Claude Code's hooks can *trigger* the same pipeline — not debug the pipeline itself at the same time. This is a build-sequencing choice, not new scope: git-diff capture is already described in §5.1 as part of the technical approach, not the deferred table.

**Manual verification:**
1. In a scratch git repo, make a real edit (add a function, change a few lines), run the capture function by hand (dev CLI command, e.g. `grasp debug:capture <repo-path>`), and confirm it returns a correct diff object matching `git diff`.
2. Confirm untouched repos produce no diff / a clearly-empty result.
3. Confirm the adapter interface compiles/typechecks with only the git-diff implementation satisfying it — no Claude-Code-specific leakage into the interface.

---

## Phase 3 — Claude Code adapter (hooks-based capture)

**Corrected capture mechanism (see [DECISIONS.md](DECISIONS.md#2026-08-05--codex-fix-pass-checkpoint-based-incremental-capture-git-tree-vs-tree-diffing)):** this section originally described `ClaudeCodeAdapter` feeding diffs "into the same capture pipeline proven in Phase 2" — i.e. `captureGitDiff`, always diffing the working tree against `HEAD`. That turned out to be a real bug, found in an independent post-Phase-9 test pass: re-diffing the whole tree against `HEAD` on every `PostToolUse` firing meant two firings with no new work in between produced (and got charged for) the same question twice, and could attribute uncommitted work that predated the agent's session to the agent. `ClaudeCodeAdapter.checkAndCapture()` now uses a separate, checkpoint-based capture path (`captureDiffBetweenTrees`/`writeWorktreeTree` in `src/adapters/gitDiffCapture.ts`) that diffs against a per-session-and-repo checkpoint advanced after every capture, not against `HEAD` — the actual "diff between checkpoints" mechanism brief §5.1 describes, which this phase's original scope note (below) explicitly deferred as unsolvable before hooks existed to define checkpoint boundaries. `captureGitDiff`/`GitDiffAdapter` (Phase 2, `debug:capture`) are unchanged and still HEAD-based — correct for a manual, one-shot "show me everything uncommitted right now" command with no session to checkpoint against.

**Delivers:**
- A `ClaudeCodeAdapter` implementing the Phase 2 interface, wired to Claude Code's `PreToolUse`, `PostToolUse`, and `Stop` hooks (per brief §5.1) so real Claude Code sessions feed diffs into Grasp's capture/filter/generate pipeline — via the checkpoint-based mechanism described above, not literally reusing Phase 2's `captureGitDiff` function.
- Documentation/setup step for wiring the hooks into a user's Claude Code config (this is itself part of "install," since hooks must be registered for Grasp to see anything).

**Implements:** brief §5.1 (Claude Code as the sole day-one adapter), the "detects Claude Code activity and captures meaningful diffs" success criterion.

**Manual verification:**
1. Configure the hooks in a real Claude Code session against a scratch repo, run an actual Claude Code task that edits a file, and confirm Grasp's capture pipeline receives a diff that matches what Claude Code actually changed.
2. Kill/interrupt a Claude Code session mid-task and confirm Grasp doesn't crash or hang waiting on a hook that never fires.
3. Confirm `onSessionComplete` fires once, at session end, not once per tool call.

---

## Phase 4 — Meaningful-change filtering (mechanical pre-filter only)

**Delivers:**
- Purely mechanical filtering logic applied to captured diffs before they're eligible for question generation: skip lockfiles/generated files/formatting-only changes/gitignored paths, skip diffs under 3 changed lines in a single file, skip diffs over 1500 total changed lines or 800 in any single file (both thresholds read from the Phase 1 config schema), respect user-configured ignore patterns.
- No semantic "is this an interesting kind of change" logic here — per [DECISIONS.md](DECISIONS.md#2026-08-04--flagged-pattern-filtering-autherror-handlingcontrol-flow-priority), the brief's §5.2 preference for hunks touching auth/error-handling/control-flow patterns is deliberately *not* built as a separate detector in this phase. That judgment is folded entirely into the Phase 5 judge call, which already reads the full diff.

**Implements:** brief §5.2's mechanical filtering (lockfiles, generated files, size thresholds, ignore patterns, per-session question cap groundwork). The "worth asking about" judgment referenced elsewhere in §5.2 is explicitly deferred to Phase 5, not implemented here.

**Manual verification:**
1. Make a formatting-only change (e.g. run a formatter over a file with no logic change) and confirm it's filtered out.
2. Edit a lockfile (`package-lock.json`) and confirm it never reaches the filter's "meaningful" output.
3. Make a 1-2 line edit and confirm it's filtered by the minimum threshold; make a diff exceeding 1500 total lines (or 800 in one file) and confirm it's filtered by the maximum; confirm a normal-sized real change (e.g. 20-40 lines) passes through untouched.
4. Add a custom ignore pattern to the config file, touch a matching path, and confirm it's now skipped.
5. Confirm a diff touching something semantically interesting (e.g. an auth check) but under the size floor is still filtered out here — proving the size filter runs independently of content, with no pattern-based override living in this phase.

---

## Phase 5 — Headless question generation

**Delivers:**
- The single-call judge+generate path from brief §3.3: given a filtered diff plus the user's concept-tag history (from the Phase 1 data layer), shell out to `claude -p "<prompt>" --output-format json --tools "" --safe-mode --setting-sources "" --strict-mcp-config --max-turns 1` and parse the response into zero, one, or two questions (concept + instance, or instance alone if the concept tag was already answered — brief §3.2's memoization check). Isolation flags corrected 2026-08-07: `--allowedTools ""` only extends the tool allow-list and does not disable Claude's built-in tools or repo-context loading — see [DECISIONS.md](DECISIONS.md#2026-08-07--generation-call-toolcontext-isolation-flags).
- Memoization lookup queries `concept_tags` **globally across all repos for the current user**, not scoped to the current repo (per [DECISIONS.md](DECISIONS.md#2026-08-04--sqlite-schema-specifics)) — a concept answered on one project counts as taught everywhere.
- A mechanically generated `diff_summary` (file list + insertion/deletion counts, computed locally, no model call — per [DECISIONS.md](DECISIONS.md#2026-08-04--diff-summary-generation)) attached to the event row alongside whatever the judge call produces.
- Cost tracking: parse `total_cost_usd` from the JSON response, accumulate **session-wide** — summed across every turn (`prompt_id`) sharing the same Claude Code `session_id`, not reset per turn — enforce the $0.25 default cap (configurable) by refusing further generation calls once hit. See [DECISIONS.md](DECISIONS.md#2026-08-04--resolving-phase-3s-flagged-consequence-cap-accounting-keys-off-session_id-alone-not-session_id-prompt_id) for why: `Stop` (Phase 3) fires once per turn, not once per whole interactive sitting, so a per-turn cap would barely constrain a long multi-turn session at all. `onSessionComplete`/`Stop` remains the per-turn *presentation* trigger (unchanged, see Phase 8) — only the spend-accounting boundary is session-wide.

**Implements:** brief §3.2 (concept + instance design, per-user memoization) and §3.3 (generation path, cost capping) in full for the success path.

**Manual verification:**
1. Run a real filtered diff through generation and confirm you get back a concept question followed by an instance question that clearly builds on it (read them yourself — do they actually make sense together on this diff?).
2. Answer a concept question in repo A, log it, then trigger a second diff touching the same concept tag **in a different scratch repo B**; confirm the second round asks only the instance question, not the concept question again — proving memoization is global, not per-repo.
3. Set the cost cap artificially low (e.g. $0.01), run several generation calls, and confirm generation stops being invoked once the $0.25 default (or the artificially lowered test value) is crossed — check the logged cumulative cost in the DB matches what `claude -p` actually reported.
4. Confirm the tool-access constraint holds: the model cannot read files, run commands, or edit anything during a generation call (only the diff text passed in the prompt is visible to it).
5. Confirm `diff_summary` is populated correctly (right file list, right +/- counts) even on a diff where the judge call declines to generate any question — proving the summary doesn't depend on or wait for the LLM call.

---

## Phase 6 — Graceful degradation and miss logging

**Delivers:**
- Error/timeout handling around the Phase 5 subprocess call: a hung or erroring `claude -p` invocation is caught, the question is skipped (not blocked on), and a miss row is logged with reason (`error` / `timeout` / `cap_reached`) per brief §3.5.
- A defensive timeout on the subprocess call itself.

**Implements:** brief §3.3's "on failure — skip gracefully, never block on nothing," and the corresponding success criterion.

**Manual verification:**
1. Temporarily point the generation call at a broken command (or kill network/auth) and confirm Grasp continues normally — no crash, no hang, no gate on a nonexistent question — and a miss row with reason `error` appears in the DB.
2. Simulate a slow/hanging call (e.g. a sleep script standing in for `claude`) and confirm the timeout fires and logs reason `timeout`.
3. Re-run the Phase 5 cost-cap test and confirm the cap-blocked case logs reason `cap_reached`, distinct from `error`/`timeout`.

---

## Phase 7 — `grasp review` (interactive TUI, soft nudge, skip friction, hard gate)

**Corrected architecture (see [DECISIONS.md](DECISIONS.md#2026-08-05--claude-code-hooks-do-not-provide-interactive-tty-access--phase-7-as-originally-scoped-is-not-buildable)):** this phase was originally scoped to render the TUI directly from inside a hook subprocess (most likely `Stop`). That's not buildable — Claude Code hooks run "without a controlling terminal," can't open `/dev/tty`, and cannot prompt interactively (confirmed against official docs, cross-checked against a second source). Presentation instead lives in **`grasp review`**, a real, user-launched CLI command — the one place in the codebase with genuine terminal access, and where `ink` is actually used for the first time. Hooks are reduced to pure DB writers/checkers: they never render UI, they only write state (already true since Phase 3) and, for hard-gate, block via the hook's own documented exit-code/JSON decision mechanism — not by hosting any interactive surface themselves.

**Delivers:**
- `grasp review`: queries the store for pending (unanswered, unskipped, real-question) events, renders each with its stored diff summary and hunk content (reused from Phase 4/5's already-captured data — no re-fetch from git) and its question(s) — concept then instance, brief §3.2's teaching order — in a scrollable, diff-colored view.
- Free-text answer input, written back to `answer_concept`/`answer_instance`, with the corresponding `concept_tags` row(s) flipped to `answered = true` on a real answer (not just `debug:answer`'s stub).
- Skip requires an explicit, deliberate keypress (not a silent timeout) — same requirement as originally scoped, just implemented in `review`'s own real terminal instead of inside a hook. Optional, itself-skippable "why are you skipping?" prompt.
- Soft-nudge mode (default): hooks never deny anything; the only visibility mechanism is a `Stop`-hook `systemMessage` ("N question(s) waiting — run `grasp review`") — the one channel a hook actually has for reaching the user, per the TTY finding.
- Hard-gate mode (opt-in via config, now wired): `PreToolUse` checks for a real pending question for the current `session_id` and denies the next tool call (via the documented `permissionDecision: "deny"` JSON output) until `grasp review` records an answer or explicit skip — this is what "blocks the next command" concretely means now that presentation and gating live in different processes.
- **Not this phase:** `grasp watch` (a persistent, auto-popping variant of `review`) — explicitly deferred; see DECISIONS.md's scoping entry. `review` is on-demand only.

**Implements:** brief §3.1 and §3.4 in full; the "soft-nudge gate works; hard-gate configurable; skip requires a keypress" and "TUI is readable and doesn't feel broken" success criteria — under the corrected architecture.

**Manual verification:**
1. Generate a real question, run `grasp review`, confirm it renders legibly (readable diff formatting, correct concept-then-instance question order, no layout breakage), answer it, and confirm both the `events` row and the relevant `concept_tags` row are updated correctly in the DB.
2. Confirm skipping in `grasp review` requires a deliberate keypress — attempt to do nothing and confirm no auto-skip; confirm only an explicit key dismisses it.
3. Set `gateMode: "hard"`, simulate a `PreToolUse` firing (same simulated-hook-payload approach used since Phase 3, given no authenticated live session is available) while a real pending question exists, and confirm it's denied with a message pointing at `grasp review`; answer the question via `review`, re-fire `PreToolUse`, confirm it's now allowed.
4. Repeat with `gateMode: "soft"` and confirm `PreToolUse` never blocks.
5. Fire a `Stop` event with a pending question outstanding and confirm its `systemMessage` reflects the correct count, in both gate modes.
6. Resize the terminal mid-question in `grasp review` and confirm the TUI doesn't break or garble.

---

## Phase 8 — Session question cap and coherent batch presentation

**Corrected scope (see [DECISIONS.md](DECISIONS.md#2026-08-05--phase-8-reinterpreted-under-the-review-based-architecture)):** this section originally described accumulating a queue during one turn and presenting it, synchronously, "before the agent's final output" — written under the same in-hook-TUI assumption Phase 7 found unbuildable (hooks have no controlling terminal, so nothing can pop up mid-turn from inside one). There is no such synchronous moment anymore: presentation only ever happens when the user runs `grasp review`, on their own schedule, exactly like every other pending question since Phase 7. Under the corrected architecture, "batching" from brief §5.3 means two narrower, still-real things: (a) a session-wide cap that stops question generation from producing an unbounded backlog during one long run, and (b) `grasp review` presenting a real accumulated batch — several pending questions, possibly from more than one session — in an order that reads coherently rather than as an arbitrary list. The underlying goal (§5.3: a long run should produce proportionally more content, but not an unanswerable pile) is already served by two things: Phase 5's concept+instance pairing already scales content per meaningful diff (up to 2 questions each, not fixed at one), and this phase's cap bounds the total so the pile stays answerable.

**Delivers:**
- Questions-per-session cap: `runGeneration` (`src/generation.ts`) now counts real (non-miss, `question_type IS NOT NULL`) `events` rows for the current `session_id` (via `getSessionQuestionCount`, `src/store.ts`) before generating, alongside the existing cost-cap check, and skips generation entirely — never invokes `claude -p` — once that count meets or exceeds `questionsPerSessionCap` (default 8, already in the Phase 1 config schema). Same "never invoke, just record a miss" pattern the cost cap already uses, and the same `miss_reason: "cap_reached"` value — see [DECISIONS.md](DECISIONS.md#2026-08-05--questions-per-session-cap-miss-reason-reuse-cap_reached-not-a-new-value) for why this reuses the existing value rather than adding a fourth. Session-wide, not per-turn — the same accounting boundary Phase 5's cost cap already uses (per [DECISIONS.md](DECISIONS.md#2026-08-04--resolving-phase-3s-flagged-consequence-cap-accounting-keys-off-session_id-alone-not-session_id-prompt_id)) — a per-turn cap would allow a fresh batch of questions on every single turn of a long multi-turn session, which defeats the cap's purpose exactly as a per-turn cost cap would.
- `grasp review` batch grouping/ordering: pending questions are grouped by `session_id` so questions from the same session stay adjacent rather than interleaved with other sessions' questions, sessions ordered by their own earliest pending question, oldest-first within each session — plus a visible "N of M pending" count and, when a session has more than one pending question (or more than one session is in the batch), a "session X of Y (question A of B for this session)" context line, so working through a real accumulated batch reads as a coherent set. See [DECISIONS.md](DECISIONS.md#2026-08-05--grasp-review-batch-groupingordering-by-session-not-a-flat-timestamp-list) for the exact rule.

**Implements:** brief §5.3's underlying goal (content scales with change, backlog stays bounded) and the "cap questions per session" part of §5.2 — both reinterpreted for the `review`-based architecture, not the original synchronous-queue mechanism.

**Not this phase:** `grasp watch` (still out of scope, per Phase 7's decision — no new reason to revisit it here).

**Manual verification:**
1. Simulate a long session with multiple meaningful diffs (the same simulated-hook-payload approach used since Phase 3) generating more questions than the configured cap; confirm generation stops being invoked once the cap is hit, and the resulting miss rows are recorded with `miss_reason: "cap_reached"`.
2. Confirm the cost cap and question-count cap remain independently distinguishable after the fact — for a given `cap_reached` miss row, you can tell which cap actually stopped it by comparing the session's cumulative cost against `costCapUsd` and its real-question count against `questionsPerSessionCap` as of that point in the session.
3. Generate a real batch of several questions across more than one simulated turn within one session (and a separate session too, for a multi-session batch), run `grasp review`, and confirm they're grouped/ordered coherently with an accurate count summary — read it yourself and judge whether it actually feels like a sensible batch to work through.
4. Confirm answering/skipping still works correctly within the reordered batch — no regression from Phase 7 — verified against the DB directly.

---

## Phase 9 — Config completeness, cost visibility, and end-to-end integration pass

**Corrected scope (see [DECISIONS.md](DECISIONS.md#2026-08-05--session-end-cost-summary-surfaces-on-stops-systemmessage-combined-with-the-pending-question-nudge-4-decimal-formatting) and the first-run-message entry below it):** this section's original two visibility deliverables — "session-end cost summary" and "first-run transparency message" — were written before Phase 7's TTY finding (hooks have no controlling terminal) and before Phase 8's `review`-based redefinition of what "the pipeline" actually looks like. Neither deliverable changes in substance, but both needed a real answer to "where does this actually appear" now that nothing can pop up interactively from inside a hook: the cost summary surfaces on `Stop`'s `systemMessage` (the same, only channel Phase 7/8 already established for the pending-question nudge — combined into one message when both apply), and the first-run message stays exactly where it already lived since Phase 3 — `grasp init`'s pre-write confirmation, the one command with real terminal access that's also a hard prerequisite for generation ever running at all. Verification step 2 below is also corrected: the old "capture → filter → generate → queue → present → answer/skip → log" wording described the original synchronous in-hook design Phase 7/8 already found unbuildable and rewrote; the actual pipeline has no "queue → present" step — it's "capture → filter → generate (checked against both caps) → log → `grasp review`, on the user's own schedule → answer/skip → log."

**Delivers:**
- Audit pass confirming all four required config settings (gate mode, cost cap, ignore patterns, questions-per-session cap) are actually read from the config file end-to-end, with sane defaults and a documented file format — tested by actually changing each one and observing real behavior change, not by reading the code and assuming it's wired. This pass caught and fixed one real gap: Grasp's own per-repo `.grasp.json`, being an untracked file in the repo, was swept into git-diff capture and could itself become the "significant file" a question got generated about — fixed by adding `.grasp.json` to the baseline ignore list (see [DECISIONS.md](DECISIONS.md#2026-08-05--config-completeness-audit-one-real-gap-found-and-fixed-graspjson-not-baseline-ignored)).
- Session-end cost summary: `Stop`'s `systemMessage` now includes cumulative session spend (`getSessionCostUsd`) whenever it's nonzero, combined with the existing pending-question nudge into one message when both apply.
- First-run transparency message (brief §3.3's requirement): confirmed to already live in `grasp init`'s pre-write confirmation, shown before the hooks that make generation possible are ever written — no relocation needed, just verified the reasoning actually holds.
- README covering install, what gets sent where, and what it costs (groundwork for brief §7's launch docs, not the full launch pass itself).

**Implements:** the remaining success criteria as a whole — this phase is where all prior phases get proven to work together in one real session rather than in isolation.

**Manual verification:**
1. Fresh install on a clean machine/user account (or a clean `$HOME` sandbox): confirm the first-run message about cost/data transparency appears in `grasp init`'s confirmation step, before any hook is written and therefore before any question could possibly be generated.
2. Run one full simulated session end-to-end against the fully wired system: capture → filter → generate (checked against both the cost cap and the questions-per-session cap) → log → `grasp review` → answer/skip → log, and confirm the `Stop`-surfaced cost summary matches the actual sum of `cost_usd` across that session's `events` rows.
3. Change each of the four config settings one at a time in a scratch repo and confirm each one visibly changes real behavior (ignore patterns exclude a path from ever reaching generation, cost cap stops generation, questions-per-session cap stops generation after N real questions, gate mode switches `PreToolUse` between denying and always allowing).
4. Read the README as if new to the project and confirm someone could actually install and understand Grasp from it alone, with no context assumed from this build process.
5. This is also the natural point to start the brief's own success criterion: use it for real, daily, for a week, and watch whether you turn it off.

---

## Sequencing rationale (summary)

Capture (Phase 2–3) has to exist before there's anything to filter (Phase 4) or generate questions about (Phase 5). Generation has to work on the happy path (Phase 5) before its failure modes are worth handling (Phase 6) — testing graceful degradation is much easier once you know what the success case looks like. The TUI (Phase 7) needs real questions to render before it's worth building against. Session capping and batch presentation (Phase 8) is a bound-and-organize layer on top of a working single-question flow, not a prerequisite for one. Config/cost-visibility/integration (Phase 9) is deliberately last because it's an audit-and-glue phase, not new capability — every setting it wires already has a phase-specific test proving the underlying behavior works.
