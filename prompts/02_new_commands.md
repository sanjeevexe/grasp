# Grasp — Prompt 2 of 4: `grasp set`, `grasp reset`, `grasp export`

You're working in the Grasp CLI codebase (`grasp-cli`). This is the second of
four prompts run in sequence, each on its own git branch, merged into `main`
only after its own tests pass. Prompt 1 (small UI/wording fixes to `grasp
review`) should already be merged into `main` before this one starts — branch
off the current `main`. Read `grasp-project-brief.md`, `BUILD_PLAN.md`, and
`DECISIONS.md` fresh before starting; they reflect current state and take
precedence over anything below if they've changed.

This prompt adds three new command families: `grasp set` (day-to-day
settings, replacing manual config-file edits for the fields users actually
touch often), `grasp reset` (undo experimentation, start over), and `grasp
export` (get your own data out in a few useful shapes). None of this touches
generation logic or the review UI — it's new CLI surface plus config/store
plumbing.

Follow this codebase's existing convention of hand-rolled argument parsing
(see `src/cli.ts`'s existing `--all` handling on `review`, and DECISIONS.md's
"No CLI argument-parsing framework" entry) — don't introduce a CLI framework
dependency for this.

## Background you need

`src/config.ts` currently has `DEFAULT_CONFIG`, `KNOWN_TOP_LEVEL_KEYS`,
`validateConfigOverride`, `ensureGlobalConfigFile` (reads-or-creates
`~/.grasp/config.json`), and `loadConfig` (merges global + an optional
repo-level `.grasp.json`). There is currently no code path that *writes* a
single setting into an existing config file while preserving whatever else is
already in it — you'll need to add that (read the existing file if present,
parse it as a plain object, set/overwrite just the one key you're changing,
re-validate the whole result through `validateConfigOverride`, write it back)
for both the global and repo-scoped cases. Do not silently drop unrelated
keys a user has already hand-edited into either file.

`src/store.ts` has the `events` and `concept_tags` tables (`concept_tags` has
`event_id REFERENCES events(id)`, it is a **separate table**, not a column on
`events` — don't forget it when clearing history).

## 1. `grasp set mode --easy/--medium/--hard [--global]`

New config field, e.g. `difficultyMode: "easy" | "medium" | "hard"` (pick a
name consistent with the rest of `GraspConfig`'s naming), defaulting to
`"medium"`. Add it to `GraspConfig`, `DEFAULT_CONFIG`, `KNOWN_TOP_LEVEL_KEYS`,
and `validateConfigOverride` (enum check, same pattern as `gateMode`).

This setting is a **soft preference for which concept gets selected** when a
diff offers more than one reasonable candidate concept to ask about — it does
not change how deeply/rigorously a chosen concept's own question is written
(that's a different, deliberately-rejected idea — see `FUTURE_IDEAS.md` item
2 — don't build that here). `"medium"` must leave the judge prompt's existing
behavior completely unchanged (it's the current, already-shipped default).
`"easy"`/`"hard"` should add a short additional instruction to the judge
prompt (`buildJudgePrompt` in `src/generation.ts`) nudging concept selection
toward more foundational/more advanced concepts respectively, phrased as a
preference the judge can still override if the diff only really offers one
reasonable concept either way — never a hard filter that could make an
otherwise-good diff produce no question at all.

`grasp set mode --easy` (no `--global`) writes to the current repo's
`.grasp.json`; `--global` writes to `~/.grasp/config.json`. Print a short
confirmation of what was set and where.

## 2. `grasp set gate soft/hard [--global]`

Same local/global pattern as above, but for the existing `gateMode` field —
this command replaces having to hand-edit the config file for this one
setting (which `TESTING_GUIDE.md` currently tells people to do). No new
config field needed, no generation-prompt changes — this is purely a
convenience wrapper around setting `gateMode` through the same read-modify-
write config path as #1.

## 3. `grasp set questions-cap <n> [--global]`

Same pattern again, for the existing `questionsPerSessionCap` field. Validate
`n` is a positive integer before writing (reuse/match the same validation
`validateConfigOverride` already applies to this field). This is the cap for
live, hook-driven Claude Code sessions — it is **not** related to whatever
cap Prompt 4 (`grasp scan`) will introduce for scan runs; don't try to
anticipate or wire anything scan-related here, that command doesn't exist
yet.

## 4. `grasp reset config [--global]`

Resets settings back to defaults. For `--global`, overwrite
`~/.grasp/config.json` with `DEFAULT_CONFIG` (same shape
`ensureGlobalConfigFile` already writes on first run). For the local
(non-`--global`) case, the right behavior is almost certainly to **delete**
`.grasp.json` entirely if it exists (an empty override file left behind is
just confusing clutter — the repo should simply fall back fully to global
config, same as a repo that never had an override at all) — but this has more
than one reasonable answer, so use your judgment, and **log your choice and
reasoning to `DECISIONS.md`** per this project's standing instruction (see
`./CLAUDE.md`) before moving on. Print a clear confirmation either way.

## 5. `grasp reset history`

Wipes stored question/answer history — **irreversible**. Must clear both the
`events` table and the `concept_tags` table (they're separate; clearing only
one leaves the other stale and inconsistent). Requires explicit confirmation
before doing anything: an interactive `y/N` prompt by default, plus a `--yes`
flag that skips the prompt (for scripting/automation — this matters, since
this exact command may itself be invoked non-interactively during this
overnight run's own verification steps; make sure `--yes` genuinely bypasses
any TTY-read so it can't hang waiting for input that will never come). Print
a clear confirmation of what was deleted (row counts from both tables are a
good, honest touch) once done.

## 6. `grasp export` (default), `grasp export --anki`, `grasp export --raw`

Three shapes, all written as CSV to `~/.grasp/exports/` (create the directory
if it doesn't exist), filename should include a timestamp so repeated runs
don't clobber each other. After writing, print the full path to the file and
a short, plain-language next-step hint (for `--anki`: mention importing it
into Anki via CSV import; for the default and `--raw` shapes: just confirm
where it landed, no Anki-specific hint). Make sure CSV fields with embedded
commas/newlines/quotes are properly quoted/escaped — question and answer text
will routinely contain all three.

None of the three shapes should try to filter or label rows by source
(diff vs. scan) — that distinction doesn't exist in the schema yet (Prompt 4
introduces it). Export everything currently in the `events` table that's
applicable to each shape below, full stop.

**Default (no flag)** — one row per real question (i.e. rows that actually
have a question, not miss rows), meant for the user's own review in a
spreadsheet: concept tag(s), the concept question text, the instance question
text, the user's own concept answer, the user's own instance answer, the
sample answers for both (for side-by-side comparison), timestamp, repo. For a
row where a phase was skipped rather than answered, leave that phase's answer
column blank (or a clear marker like `(skipped)`) rather than omitting the
row entirely — a skipped question is still meaningful information about what
you never got around to.

**`--anki`** — front/back/tags only, shaped for Anki's plain CSV import (a
`Front`, `Back`, `Tags` header row is the safe, well-supported shape — no
need to reproduce Anki's more elaborate note-type format). Include every
concept-question occurrence, answered or skipped, with no deduplication by
tag — a tag asked about more than once produces more than one row, and this
is intentional (see DECISIONS.md if one already exists on export dedup
reasoning; if not, this paragraph is the reasoning — don't dedupe). Front =
the concept question text, Back = the sample concept answer, Tags = the
concept tag(s) for that row (space-separated, Anki's own tag convention).

**`--raw`** — every column of every row in `events`, unfiltered, one CSV row
per database row. This is the escape hatch for anyone who wants everything;
don't curate it.

## Documentation

Update `README.md` to document all six new commands (`grasp set mode/gate/
questions-cap`, `grasp reset config/history`, `grasp export` and its two
flags), and to note which config fields now have a dedicated command
(`gateMode`, `questionsPerSessionCap`, the new difficulty-mode field) versus
which remain hand-edit-only (`ignorePatterns`, `diffThresholds` — explain
briefly why: more open-ended values that don't reduce cleanly to a flag).
Also add a short section showing how to inspect `~/.grasp/history.db`
directly via `sqlite3` for anyone who wants to look at the raw data without
exporting — a couple of concrete example queries is enough. Update
`TESTING_GUIDE.md` to reflect that `gateMode`/`questionsPerSessionCap` can
now be set via command instead of hand-editing the config file (the existing
checklist items that say "edit `~/.grasp/config.json`" should be updated
accordingly, not left describing the old, more manual path exclusively).

## Verification

- Run `npm run build` and `npm test` — both must pass clean.
- Exercise each new command at least once against a real local
  `~/.grasp/history.db` (or a temp one, matching how the existing test suite
  isolates from a real user's `~/.grasp` — see `config.ts`'s test-only
  `globalConfigPath`/`graspHome` injection points and follow the same
  pattern for any new store functions you add) to confirm the read-modify-
  write config path actually preserves unrelated existing keys, and that
  `grasp reset history` genuinely empties both tables.
- Confirm `grasp export`'s three shapes each produce a valid, correctly-
  quoted CSV you can actually open.

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

Do not attempt increasingly risky workarounds on your own — this is running
unattended overnight, so a clear, honest `BLOCKED` status is the correct
outcome if you're genuinely stuck.
