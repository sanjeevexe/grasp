# Grasp — Prompt 4 of 4: `grasp scan`

You're working in the Grasp CLI codebase (`grasp-cli`). This is the last of
four prompts run in sequence, each on its own git branch, merged into `main`
only after its own tests pass. Prompts 1–3 should already be merged into
`main` — branch off current `main`. Read `grasp-project-brief.md`,
`BUILD_PLAN.md`, and `DECISIONS.md` fresh before starting; they take
precedence over anything below if they've changed since this was written.

**Work directly on the current branch — do not create, rename, or switch to
a different git branch yourself.** The branch is already set up for you
before you start; committing anywhere else breaks the orchestration around
this run.

This is a genuinely new feature, not a fix — it extends what Grasp does
beyond the original brief's scope (the brief is about questions on AI-agent-
made *changes*; this is about onboarding to existing, unfamiliar code). That
expansion was a deliberate, discussed decision, not scope creep slipping in
unnoticed — note it as such if you touch anything brief-scope-related. This
prompt has more genuine open design points than the previous three combined.
Where called out below, **you must design the concrete mechanism yourself,
after reading the relevant existing code, and log your choice plus reasoning
to `DECISIONS.md` before implementing it** — don't guess silently through
these, and don't treat the absence of a fully-specified answer as permission
to skip the decision.

## What `grasp scan` is

A new, fully standalone command — `grasp scan` — that reads through an
existing codebase (not a diff) and asks the same kind of concept/instance
comprehension questions Grasp already asks about changes, but about code
that was already there. It reuses almost everything that already exists:
the `events`/`concept_tags` schema, the judge-call generation pattern, and
the entire `grasp review` TUI (question/answer/retry/sample-answer flow) —
this prompt is mostly about *feeding* that existing machinery from a new
source, not building parallel infrastructure.

## 1. Shared schema, new `source` field

Add a `source` column to `events` (`'diff' | 'scan'`, matching the existing
migration pattern already used for `cost_unknown`/`sample_answer_concept`/etc.
in `src/store.ts` — `ALTER TABLE ... ADD COLUMN ... DEFAULT 'diff'` so every
existing row is correctly and automatically backfilled). Scan-generated rows
use `source = 'scan'`; existing diff-generated rows are `'diff'` (the
default handles this for free on migration, no manual backfill needed).

Diff-specific fields (`diff_hash`, `diff_summary`, `diff_files_json`) don't
apply cleanly to a scan row — leave them null, or repurpose `diff_summary`
to describe what was scanned (e.g. the file path) — your call, but be
consistent and make sure `grasp review`'s and `grasp scan`'s own rendering
both handle a null `diffFiles` gracefully (a scan row shows the file excerpt
described in §4 instead, or nothing for a concept question, never a broken
diff view).

**Extend `grasp export`** (built in Prompt 2, already merged) to include
scan-sourced rows and add a `source` column to its output — this is the
right place for that extension now that `source` is real; don't leave
Prompt 2's export code unaware of scan rows.

**Concept-tag memoization (`concept_tags.answered`) stays global and shared
regardless of source, with no code changes needed to the memoization logic
itself** — a concept learned via a diff question must still be treated as
mastered during a scan, and vice versa. Do not scope
`getAllAnsweredConceptTags` or any memoization check by `source`. This is a
hard requirement, not a judgment call.

## 2. Fully standalone, decoupled from hooks and live sessions

`grasp scan` is a plain CLI command (`src/cli.ts`, same dispatch pattern as
`init`/`review` — `resolveRepoRoot(process.cwd())`, no hook payload
involved). It must work with no Claude Code session running at all, and must
not be disrupted by one running concurrently in the same repo.

Generate a synthetic identifier for each scan *run* (not a real Claude Code
`session_id` — nothing in a standalone invocation supplies one) and use it
as the `session_id` on every `events` row that run produces. Since
`getSessionQuestionCount`/`getSessionCostUsd`-style scoping is already keyed
strictly by `session_id`, this alone is what keeps a scan run's own cap
(see §3) fully isolated from any live Claude Code session's cap — no
additional guard logic should be needed for that isolation; if you find
yourself writing extra code specifically to "prevent scan from affecting the
session cap," that's a sign the identifiers aren't distinct enough, not a
sign you need more logic.

Scan runs as one sequential process working through files one at a time —
it does not need the multi-process slot-locking machinery
(`acquireGenerationSlot` etc.) that live hook-driven generation needs, since
there's no concurrent competition to guard against here. Don't reuse that
machinery for scan; it solves a problem scan doesn't have.

## 3. Walking the codebase, generating questions

Walk the repo's files, applying the **same** ignore-pattern and generated-
file-detection logic diff capture already uses (`classifyIgnoreExclusion`/
`isFileGenerated` in `src/filter.ts` — reuse these directly, don't
reimplement). `diffThresholds` does not apply here at all — it's a diff-size
concept with no scan equivalent; don't try to make it apply.

For each file (or small group — your call), run the same judge-call pattern
already established (`invokeClaudeJudge` etc. in `src/generation.ts`), fed
the file's content instead of a diff. You'll need a new prompt-building
function for this (the existing `buildJudgePrompt` is diff-shaped) — reuse
as much of the existing response contract (concept/instance question,
sample answers, concept explanation) as makes sense; see §4 for one
required addition to that contract specific to scan.

**Capping and ordering — design and log to `DECISIONS.md`:**
- Default cap is by **question count generated**, not file count. Pick a
  reasonable default (15 is a reasonable starting point discussed, but not a
  hard requirement — use your judgment and state your reasoning).
- `grasp scan --full` bypasses the cap entirely — print a clear warning
  before proceeding (something like "this will scan the entire codebase and
  could generate a large number of questions") rather than a hard
  confirmation gate; this isn't a destructive/irreversible action the way
  `grasp reset history` is.
- For the **default, capped** run: group files by top-level directory first,
  then interleave across groups (round-robin) rather than exhausting one
  folder before moving to the next — this is a purely mechanical ordering
  fix, no LLM reasoning involved, so a capped run doesn't accidentally spend
  its whole budget inside one folder while leaving an entire other part of
  the codebase untouched. This ordering doesn't matter for `--full` (nothing
  gets left out either way).
- **Resumability:** track which files have already been scanned (a new
  table is the likely answer — design its shape yourself: at minimum needs
  repo + file path; decide whether to also track a content hash/mtime to
  detect edited files, or keep it simple and treat "already scanned" as
  permanent regardless of later edits — either is defensible, log your
  choice and reasoning). A second `grasp scan` run must continue from
  unscanned files, not restart from the beginning. When a run (or `--full`)
  finds nothing left unscanned, print a plain message saying so (same tone
  as `grasp review`'s existing "pending elsewhere" message) with a pointer
  to `grasp reset history` if the user wants to start over — which means
  **`grasp reset history` (built in Prompt 2) must be extended to also clear
  whatever new scan-progress table you introduce here**, not just
  `events`/`concept_tags`, or "start over" won't actually work.

## 4. Showing the relevant code for instance questions

For a scan-sourced **instance** question, the response contract needs one
new piece: which lines of the file the question is actually about. Feed the
file to the judge with line numbers attached, and have the response include
a cited line range as a new structured field (extend the response contract
similarly to how `sampleAnswerConcept`/`conceptExplanation` were added in an
earlier phase — see `JudgeResponse`/`parseJudgeResponse` in
`src/generation.ts` for the existing pattern to follow). **Concept**
questions show no excerpt at all — consistent with the existing concept/
instance philosophy (concept questions are already meant to stand apart from
your specific code).

The cited range is a model self-report, not verified structural data the
way a diff hunk is — validate it defensively before rendering: clamp the
range to the file's actual line count if it's out of bounds, and show no
excerpt at all (same as a concept question) if the range is malformed
(e.g. start after end) rather than rendering garbage or crashing. This is a
cheap, purely mechanical check — a few lines, not a design decision.

## 5. Live presentation, not a silent queue — and a separate cap command

Running `grasp scan` should behave like its own interactive session,
generating and presenting each question immediately via the same review UI
(`src/reviewApp.tsx`/`createReviewApp`) already used by `grasp review` —
answer it, move to the next, same answer/retry/sample-answer flow. It must
**not** show pre-existing diff-sourced pending questions during a scan run,
and `grasp review` must **not** show scan-sourced questions — each command
filters strictly by its own `source` value. (The underlying storage stays
shared per §1 — this is purely about what each command's own query surfaces
in the moment, not a second database.)

Because scan needs its own independent cap (§3), it needs its own config
field and command, separate from the existing `questionsPerSessionCap` /
`grasp set questions-cap` (which governs live Claude Code sessions and must
not be touched by this). Add a new `GraspConfig` field (e.g.
`scanQuestionsCap`, following the same naming/validation/`DEFAULT_CONFIG`/
`KNOWN_TOP_LEVEL_KEYS` pattern as the existing fields) and a new command,
`grasp set scan-cap <n> [--global]`, matching the local/global pattern
`grasp set questions-cap` already established in Prompt 2. Since this is
just another `GraspConfig` field, `grasp reset config` (Prompt 2) covers it
for free — confirm this is actually true rather than assuming it.

**Cross-hints:** on the last question of a `grasp review` batch, if there
are unresolved scan-sourced questions left over from an interrupted or
still-in-progress scan, show a one-line hint pointing at `grasp scan` to
continue — and symmetrically, on the last question of a `grasp scan` run, a
one-line hint pointing at `grasp review` if there are unresolved diff-sourced
questions. Only show either hint when the relevant count is actually greater
than zero; show nothing otherwise. This reuses the same query pattern as the
existing repo-scoping "pending elsewhere" message, just filtered by `source`
instead of `repo`.

Ctrl+C safety and the persistent keybinding hint row (built in Prompt 1)
apply here for free, since scan reuses the same UI component — confirm this
is genuinely inherited rather than assuming it without checking.

## 6. Compatibility with everything else already built

Confirm each of these explicitly (don't just assume):
- `grasp set mode` (difficulty, Prompt 2) affects scan's concept selection
  too, since scan's generation should read the same config resolution path
  as diff generation.
- `grasp set gate` and the Prompt 3 batching/retry rework do **not** apply
  to scan and need no changes — scan isn't hook-driven, so neither
  mechanism has anything to act on here. Confirm this is actually true of
  what you built, don't just assert it.
- `ignorePatterns` and generated-file detection apply to scan's file walk
  (§3, already required above).

## Documentation

Add a new section to `README.md` covering `grasp scan`, `grasp scan --full`,
and `grasp set scan-cap`, written at the same plain-language level as the
rest of the README. Update `TESTING_GUIDE.md` with a checklist section for
scan (standalone use, resumability across two runs, the cap and `--full`,
the cross-hints, the "nothing left to scan" message).

## Verification

- `npm run build` and `npm test` must pass clean.
- Exercise scan end-to-end against a real small multi-directory test
  fixture: a capped run that stops partway through, confirm directory
  spreading actually produced coverage across more than one top-level
  folder; a second run that resumes and doesn't re-ask about already-
  covered files; `--full` covering everything; the "nothing left to scan"
  message; both cross-hints; that `grasp reset history` clears scan
  progress too.
- Confirm a concept mastered via a live diff question is correctly skipped
  during a scan, and vice versa — this is the one hard, non-negotiable
  requirement in this whole prompt, verify it directly rather than assuming
  the shared-table design makes it automatic.

## When you're done

Commit your work with a clear, descriptive message. Then write a file named
`.grasp-prompt-status` at the repo root containing exactly one line:

```
DONE
```

If you hit something you genuinely cannot resolve, stop, leave the repo as
it is, and write `.grasp-prompt-status` containing:

```
BLOCKED: <one clear sentence on what you were doing and exactly what stopped you>
```

This prompt has more open design surface than the previous three — prefer
stopping with a clear `BLOCKED` status over guessing through a design point
that isn't actually addressed above, especially anything touching the
shared-memoization requirement in §1. This is running unattended overnight
with no one to ask.
