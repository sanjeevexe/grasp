# Grasp

**Grasp makes you explain what your AI coding agent just built — through short questions you actually have to answer, in your own terminal — because skimming a diff isn't the same as understanding it.**

When you delegate work to Claude Code, the gap between "the agent finished" and "I actually understand what it built" is where codebases quietly become unreadable to their own authors. Grasp watches your Claude Code session, and when a meaningful change lands, it generates one or two short questions about it — a general concept question, then a question that applies it to your actual diff. You work through them whenever you check in (`grasp review`), typing a real answer or explicitly skipping — in your own words, locally, in your terminal. Nothing is graded. The value is in being made to articulate it. By default Grasp only nudges you that questions are waiting; if you turn on hard-gate mode, it will also refuse Claude Code's next action in that session until you've engaged with what's pending — see [How it works](#how-it-works) for exactly what's on-demand versus enforced.

Grasp also has a second, standalone mode — **`grasp scan`** — for the opposite direction: understanding code that was already there, not code an agent just changed. Same question machinery, no Claude Code session required. See [`grasp scan`: understanding existing code](#grasp-scan-understanding-existing-code).

This is a v1 build. It's opinionated, it's Claude-Code-only for now, and it hasn't been used in anger for a full week yet — see [Status and limitations](#status-and-limitations) below before you rely on it.

---

## How it works

1. You run Claude Code on a real task in a repo where you've installed Grasp's hooks (`grasp init`).
2. Every time Claude Code makes a meaningful change (not a one-line formatting tweak, not a lockfile bump), Grasp captures *just what's new since it last looked* for that session (not your whole uncommitted working tree — checkpoint-based, so it won't re-ask about the same diff twice or blame the agent for work that predates its session). Capturing is cheap and happens on the spot; generating a question about it is not, so Grasp doesn't do that per change.
3. Instead, once per conversational turn — when Claude Code finishes responding, not after every individual tool call — Grasp gathers everything captured-but-not-yet-asked-about since the last time it checked and, using Claude Code's own headless mode, makes one combined call covering all of it: a short concept question and an instance question about the batch as a whole (a turn that made one small edit still just gets one straightforward question; a turn that made several is asked about coherently, not once per edit). If that call fails or times out, nothing is lost — the same diffs are simply included in the next attempt.
4. Those questions sit in your local history until you run `grasp review`, at which point you answer or explicitly skip them, one at a time, in a small terminal UI.
5. By default, nothing blocks you — Grasp just nudges you (a one-line message after each turn: "N questions waiting — run `grasp review`"). If you turn on hard-gate mode, Grasp will refuse the next tool call in that session until you've answered or skipped.

Everything is stored locally in a plain SQLite database. Nothing is sent anywhere except to the LLM call that generates the questions themselves (see below).

## Install

Grasp isn't published to npm yet, and this repo doesn't have a public Git remote configured. For now, build and link it from source using the project folder you already have locally:

```bash
cd path/to/grasp
npm install
npm run build
npm link
```

`npm link` puts a `grasp` binary on your `PATH`. Once it's published, the intended install will just be:

```bash
npm install -g grasp-cli
```

(`grasp-cli` is the npm package name — `grasp` is already taken by an unrelated, dead package — but the installed command is `grasp`.)

**Requirements:** Node `>=22` (Grasp's own `engines` field, and also the floor its `better-sqlite3` dependency requires — `npm install` will fail on an older Node). Grasp generates questions by shelling out to your own `claude` CLI in headless mode (`claude -p ... --output-format json`), so you also need Claude Code installed and authenticated (subscription or API) for question generation to work at all. Everything else in Grasp — capture, filtering, storage, `grasp review` — works without it; only generation depends on it.

## Setting up a repo

Inside a git repo you want Grasp watching:

```bash
grasp init
```

This shows you a short summary of what it's about to add to `.claude/settings.local.json` (Grasp's hooks for `PreToolUse`, `PostToolUse`, and `Stop`) and asks for confirmation before writing anything — type `v` at the prompt to see the exact, literal JSON it will write, if you want to check the bytes yourself before trusting it. It's per-repo and local-only — it never touches `~/.claude/settings.json` (which would silently apply to every project) or a committed, shared settings file (which would silently opt in every teammate who clones the repo). Run it again in any other repo you want covered.

`grasp init`'s confirmation step is also where Grasp states plainly, before anything is installed, that generating questions draws on your existing Claude plan/usage — see [What gets sent where, and what it costs](#what-gets-sent-where-and-what-it-costs).

## Using it

Just use Claude Code normally in that repo. Grasp works in the background — there's nothing to run per-task. When you're ready to work through what's accumulated:

```bash
grasp review
```

This opens an interactive terminal view of every question you haven't answered or skipped yet, scoped by default to the repo you're currently in — run `grasp review --all` to see the full, unfiltered batch across every repo Grasp is watching instead. If your current repo has nothing pending but other repos do, Grasp tells you so directly rather than just showing an empty "all caught up" screen. This only changes what a review batch *shows* — what counts as *known* stays global: a concept you've already demonstrated understanding of in one repo is never re-taught in another, no matter which repo you're reviewing from. Before the first question, a one-time banner tells you how many questions are pending and how many sessions they span, so you know what you're about to go through. Each question shows the diff it's about, then a concept question, then an instance question. The answer field is focused and ready to type in the moment a question appears — no extra keypress needed first. If the diff has more lines than fit on screen, use the up/down arrow keys to scroll it (works whether or not you've started typing, and while reading an explanation or sample answer too) — the on-screen hint only mentions scrolling when there's actually more diff than fits. Type your answer and press Enter — a blank Enter is rejected with a message, not treated as a skip. Ctrl+C is always safe to quit with — anything you haven't answered yet just stays pending, whether you're one question in or fifty.

After you submit a real answer, Grasp shows a sample answer for that question before moving on — for your own comparison, never a grade or a correctness check (see [Status and limitations](#status-and-limitations)). If you're stuck, press Escape instead of typing: Grasp shows a short explanation of the underlying concept, then gives you one retry at the same question. From there, either type a real answer (recorded normally, sample answer shown, same as above) or press Escape again to genuinely decline — that's still a real keypress, never silent or automatic, and you'll still see the sample answer before moving on even if you declined. If several questions piled up from one long session, they're grouped so you work through one session's worth before moving to the next, with a running count so you can see how much is left. `grasp review` only ever shows questions about AI-agent changes — if `grasp scan` (below) also has questions pending, `grasp review` tells you so on the last question of your batch, rather than mixing the two kinds together.

## `grasp scan`: understanding existing code

Everything above is about code an AI agent just changed. `grasp scan` is the other half: it reads through code that was **already there** — the parts of your codebase you never had to explain, because nothing ever made you. This is a deliberate extension beyond Grasp's original scope (comprehension of AI-agent changes) into general codebase onboarding — same question mechanism, a different source of what to ask about. It's fully standalone: no Claude Code session, no hooks, nothing running in the background. Just run it in a repo you want to understand better:

```bash
grasp scan
```

This walks your repo's tracked files (the same `.gitignore`-respecting, ignore-pattern-and-generated-file-aware filtering the diff side already uses), asks a concept-then-instance question about the files it judges worth asking about, and presents each one immediately in the same interactive review UI `grasp review` uses — answer or skip, same flow, same sample-answer-afterward, same Escape-for-a-hint-then-one-retry. The instance question shows the specific lines of the file it's actually about; the concept question, as always, stands on its own with no code shown. Nothing here touches your diff-question history or vice versa — `grasp scan` never shows a pending diff question, and `grasp review` never shows a pending scan question — but **what you've already demonstrated understanding of is shared**: a concept you've mastered via a real Claude Code diff is never re-asked during a scan, and a concept you master during a scan is never re-asked the next time an agent's diff touches it.

A `grasp scan` run stops once it's generated `scanQuestionsCap` real questions (default 15 — see [Configuration](#configuration)), so one run is a bounded, sit-down-and-do-it session, not an unbounded sweep of your whole codebase. It works through directories round-robin (a little from each top-level folder, cycling) rather than exhausting one folder before moving to the next, so a capped run always gives you a spread across the codebase instead of getting stuck entirely inside whichever folder happens to sort first. Every scan is resumable: Grasp remembers which files it's already looked at (permanently — an already-scanned file is never revisited, even if you edit it later; that's what the diff side is for), so running `grasp scan` again continues from where it left off rather than starting over. Once every tracked file has been scanned, Grasp tells you plainly that there's nothing left, with a pointer to `grasp reset history` if you want to start fresh (that command clears scan progress along with your question/answer history — see [Commands](#commands)).

```bash
grasp scan --full
```

Bypasses `scanQuestionsCap` entirely and walks every remaining unscanned file in one run. This isn't gated behind a confirmation prompt the way `grasp reset history` is — nothing about it is destructive or irreversible — but it does print a plain warning first, since it can mean a genuinely large number of real, billed/rate-limited generation calls: "this will scan the entire codebase and could generate a large number of questions."

## Commands

Day-to-day settings that used to require hand-editing `.grasp.json`/`~/.grasp/config.json` now have dedicated commands. All of them are hand-rolled argument parsing (no CLI framework) — same style as `grasp review --all` — and, like `.grasp.json` itself, default to the current repo unless you pass `--global`.

- **`grasp set mode --easy|--medium|--hard [--global]`** — sets `difficultyMode`, a soft preference for which concept Grasp picks when a diff (or, for `grasp scan`, a file) offers more than one reasonable candidate to ask about. It never changes how deeply a chosen concept's own question is written — see [Configuration](#configuration).
- **`grasp set gate soft|hard [--global]`** — sets `gateMode` (see [Gate modes](#gate-modes)). Replaces hand-editing the config file for this one setting. Only affects live, hook-driven Claude Code sessions — `grasp scan` isn't hook-driven, so gate mode has nothing to act on there.
- **`grasp set questions-cap <n> [--global]`** — sets `questionsPerSessionCap` (a positive integer). This is the cap for live, hook-driven Claude Code sessions specifically — unrelated to `grasp scan`'s own separate cap below.
- **`grasp set scan-cap <n> [--global]`** — sets `scanQuestionsCap` (a positive integer), `grasp scan`'s own independent cap, deliberately separate from `questions-cap` above (see [`grasp scan`](#grasp-scan-understanding-existing-code)).
- **`grasp reset config [--global]`** — resets settings back to defaults. `--global` overwrites `~/.grasp/config.json` with the built-in defaults. Without `--global`, it deletes the repo's `.grasp.json` if present (so the repo falls back fully to global config, same as a repo that never had an override) — it does not leave behind an empty override file.
- **`grasp reset history [--yes]`** — **irreversibly** wipes all stored question/answer history (the `events` and `concept_tags` tables) AND `grasp scan`'s own file-walk progress — this is the "start scanning from scratch" command. Asks for interactive `y/N` confirmation by default; pass `--yes` to skip the prompt for scripting.
- **`grasp export` / `grasp export --anki` / `grasp export --raw`** — exports everything currently in your local history to a CSV file under `~/.grasp/exports/` (timestamped, so repeated runs never overwrite each other). See [Exporting your data](#exporting-your-data) below for what each shape contains.

All four read-modify-write config commands (`set mode`/`set gate`/`set questions-cap`/`set scan-cap`) preserve any other keys already in the target file — setting one field never clobbers something you hand-edited into the same file.

Two config fields remain hand-edit-only, with no dedicated command: **`ignorePatterns`** and **`diffThresholds`**. Both take open-ended, multi-value or structured input (a list of arbitrary path patterns; three separate numeric thresholds) that doesn't reduce cleanly to a single flag the way a `soft`/`hard` enum or a single integer does — edit `.grasp.json`/`~/.grasp/config.json` directly for these, as described in [Configuration](#configuration).

## Exporting your data

`grasp export` writes a CSV of everything in your local `events` table to `~/.grasp/exports/`, in one of three shapes:

- **`grasp export` (default)** — one row per real question (not miss rows): concept tag(s), the concept and instance question text, your own concept and instance answers, the sample answers for both (for side-by-side comparison), timestamp, repo, and source (`diff` or `scan`). A skipped phase's answer column shows `(skipped)` rather than omitting the row — a skipped question is still meaningful information about what you never got around to.
- **`grasp export --anki`** — a `Front,Back,Tags` CSV shaped for Anki's plain CSV import (File > Import in Anki). Front is the concept question, Back is its sample answer, Tags is the concept tag(s) plus a `source:diff`/`source:scan` tag (space-separated, Anki's own convention — kept as a tag rather than a fourth column so the Front/Back/Tags mapping Anki expects doesn't change). Every concept-question occurrence is included, answered or skipped, with no deduplication by tag — asking about the same tag twice produces two cards on purpose.
- **`grasp export --raw`** — every column of every row in `events`, completely unfiltered — the escape hatch if you want everything, uncurated.

All three shapes include both diff- and scan-sourced rows together, distinguished by the `source` column/tag described above. Fields with embedded commas, quotes, or newlines (question/answer text routinely has all three) are quoted per standard CSV rules, so the files open cleanly in Excel/Numbers/Google Sheets as well as importing into Anki.

## Inspecting your history directly

Everything lives in a plain, uncompressed SQLite database at `~/.grasp/history.db` — `grasp export` is a convenience, not the only way to look at your data. A couple of starting points with the `sqlite3` CLI:

```bash
# Every question you've ever been asked, most recent first
sqlite3 ~/.grasp/history.db \
  "SELECT timestamp, repo, question_concept, question_instance FROM events WHERE question_type IS NOT NULL ORDER BY timestamp DESC LIMIT 20;"

# Which concept tags you've answered the most (a rough "what you already know well" list)
sqlite3 ~/.grasp/history.db \
  "SELECT tag, COUNT(*) AS times_asked, SUM(answered) AS times_answered FROM concept_tags GROUP BY tag ORDER BY times_asked DESC;"
```

`sqlite3 ~/.grasp/history.db ".schema"` prints the full table layout if you want to write your own queries beyond these.

## What gets sent where, and what it costs

Grasp reads your code and sends diffs to an LLM to generate questions. That's worth being direct about:

- **What's sent:** only the filtered, "significant" part of a diff (or, for a turn that made several meaningful changes, all of them together in one call, clearly labeled as separate changes) — lockfiles, generated files, and formatting-only changes are filtered per-file, while the size floor (`diffThresholds.minChangedLines`) is a diff-level check: a diff is skipped only if *every* remaining file is under the floor, so once any one file clears it, its smaller companion files in that same diff are sent too, not filtered out individually — plus a list of programming concepts you've already answered questions about (so Grasp doesn't re-teach you the same thing). No full-repo access, and no file contents beyond those diffs are ever sent to Claude — Grasp's generation call runs with `--tools ""` (disables all built-in tools, not just `--allowedTools ""`'s allow-list) and `--safe-mode --setting-sources "" --strict-mcp-config` (disables `CLAUDE.md`/skills/plugins/hooks/MCP-server loading and any pre-existing tool allow-rules from your own Claude Code settings), so the nested call has no tools to call and no repo customizations to load in the first place. (To catch a generated file whose header wasn't touched by the current diff, the filter does read up to 4KB off the start of each changed file on disk, at the moment it's captured — that local check never leaves your machine or gets sent anywhere.)
- **Where it's sent:** to `claude -p`, i.e. your own already-configured Claude Code session. This is not a separate API key, not a hosted Grasp backend, and nothing goes to Grasp's maintainer — there is no telemetry, ever.
- **What it costs:** if you're on a Claude subscription, this spends your existing rate-limit headroom. If you're API-billed, it's real (small) dollars — each question-generation call is typically a fraction of a cent, and Grasp makes at most one per Claude Code turn (see [How it works](#how-it-works)), not one per file changed. Grasp tracks cumulative spend per Claude Code session purely for your own visibility — you'll see a running total in the `Stop` message after a session that spent anything ("$0.0043 spent generating comprehension questions this session so far"). There's no dollar-cost ceiling to hit; `questionsPerSessionCap` (see [Configuration](#configuration)) is the one safety rail that bounds how much a session generates.
- **What's stored, and where:** everything Grasp logs — diffs, questions, sample answers, your own answers, costs — lives in a plain SQLite database at `~/.grasp/history.db`. It's not obfuscated; you can inspect it directly with `sqlite3 ~/.grasp/history.db ".schema"` or any SQLite browser. Nothing leaves your machine except the generation calls described above.

## Configuration

Grasp reads a global config at `~/.grasp/config.json` (created with defaults on first run), optionally overridden per-repo by a `.grasp.json` file in that repo's root. Repo-level values win on conflict; only the keys you actually set need to appear in `.grasp.json`. Both files are plain, strict JSON — no comments, no trailing commas; the example below is meant to be copied and have values changed, not copied verbatim with the annotations still in it. `gateMode`, `questionsPerSessionCap`, `scanQuestionsCap`, and `difficultyMode` can also be set with a dedicated command instead of hand-editing either file — see [Commands](#commands).

```json
{
  "gateMode": "soft",
  "ignorePatterns": [],
  "questionsPerSessionCap": 8,
  "diffThresholds": {
    "minChangedLines": 3,
    "maxTotalChangedLines": 1500,
    "maxSingleFileChangedLines": 800
  },
  "difficultyMode": "medium",
  "scanQuestionsCap": 15
}
```

- **`gateMode`** — `"soft"` (nudge only) or `"hard"` (blocks the next tool call until you engage). See [Gate modes](#gate-modes). Dedicated command: `grasp set gate soft|hard [--global]`. Only applies to live, hook-driven Claude Code sessions — `grasp scan` isn't hook-driven, so this has nothing to act on there.
- **`ignorePatterns`** — extra paths/filenames to never generate questions about, beyond the built-in list. Applies to both the diff side and `grasp scan`'s file walk. **Matching is plain, not glob**: a pattern ending in `/` matches that name as a directory segment anywhere in the path (e.g. `"scripts/"` matches `scripts/build.sh` and `packages/a/scripts/x.js`); any other pattern matches an exact basename or an exact full relative path (e.g. `"generated.ts"` matches both `generated.ts` and `src/generated.ts`, but not `generated.test.ts`). Wildcards like `*` or `**` are **not** supported and are matched literally, so `"generated/**"` will silently match nothing — use `"generated/"` instead. Hand-edit only — an open-ended list of patterns doesn't reduce cleanly to a single flag.
- **`questionsPerSessionCap`** — stop generating once a session has produced this many real question **events**, and the sole generation safety rail for live Claude Code sessions (there's no dollar-cost cap — see [What gets sent where, and what it costs](#what-gets-sent-where-and-what-it-costs)). This counts `events` rows, not individual displayed questions: a "both" event (concept + instance) is one toward this cap but shows as two questions in `grasp review`, so a cap of 8 can still leave you with up to 16 questions to actually answer — and since generation is batched once per turn (see [How it works](#how-it-works)), one event can also cover several diffs from the same turn, not just one. When the cap is hit, the `Stop` message says so plainly and points at how to raise it. Dedicated command: `grasp set questions-cap <n> [--global]`. Unrelated to `scanQuestionsCap` below — see [`grasp scan`](#grasp-scan-understanding-existing-code) for why the two must stay independent.
- **`scanQuestionsCap`** — `grasp scan`'s own independent question-count cap (default 15), separate from `questionsPerSessionCap`. `grasp scan --full` bypasses it entirely. Dedicated command: `grasp set scan-cap <n> [--global]`.
- **`diffThresholds.minChangedLines`** — diffs smaller than this (in every file) are too trivial to ask about. No equivalent applies to `grasp scan` — there's no diff to size.
- **`diffThresholds.maxTotalChangedLines`** / **`maxSingleFileChangedLines`** — diffs bigger than this are skipped rather than crammed into one question. `diffThresholds` as a whole is hand-edit only — three related numeric thresholds don't reduce cleanly to a single flag.
- **`difficultyMode`** — `"easy"`, `"medium"` (default), or `"hard"`. A soft preference for which concept Grasp's judge picks when a diff (or, for `grasp scan`, a file) genuinely offers more than one reasonable candidate to ask about — it never changes how deeply or rigorously a chosen concept's own question is written, and it never prevents a question from being generated (the judge can still pick whichever concept is actually offered if there's only one reasonable option). `"medium"` leaves generation behavior completely unchanged from Grasp's original default. Dedicated command: `grasp set mode --easy|--medium|--hard [--global]`.

A built-in baseline (lockfiles, `node_modules/`, `dist/`, `build/`, `.git/`, and Grasp's own `.grasp.json`/`.claude/settings.local.json`) is always excluded regardless of what you configure — `ignorePatterns` is for adding to that list, not replacing it.

### Gate modes

- **`soft` (default):** Grasp never blocks anything. You get a one-line reminder after each Claude Code turn if a question is still waiting, and that's it.
- **`hard`:** Grasp will deny the next tool call in a Claude Code session if that session has an unanswered question outstanding, until you answer or explicitly skip it via `grasp review`. This only reaches into the session that produced the question — it never blocks you over something left over from a different day or a different project. Turn this on deliberately; it's a real interruption, and the whole design philosophy here is "teach, don't punish" — soft is the safer default for exactly that reason.

## Data and privacy

- Everything is local-first. `~/.grasp/history.db` is the single source of truth, in plain SQLite.
- No telemetry, no analytics, nothing phoned home to Grasp's maintainer — ever.
- The only outbound calls Grasp makes are the `claude -p` generation calls described above, using your own existing Claude Code auth.

## Status and limitations

- **`grasp scan` is a deliberate extension beyond Grasp's original brief.** Everything else in this document is about comprehension of AI-agent changes; `grasp scan` is about onboarding to existing, unfamiliar code, which is a different (related) problem. It reuses the same storage, judge-call pattern, and review UI on purpose — see [`grasp scan`](#grasp-scan-understanding-existing-code) — but it's worth naming as a scope expansion, not something the original design already covered.
- **`grasp scan` only walks tracked files.** It reads `git ls-files` (respecting `.gitignore` for free) — untracked/uncommitted files aren't included. That's deliberate (scan is about existing, checked-in code; Grasp's diff side already covers your own in-progress work), but it means a file you've created and not yet committed won't show up until you do.
- **`grasp scan` never re-visits a file once scanned, even if you edit it later.** File-walk progress is permanent, with no content-hash or mtime tracking — the diff side is what covers a file's own later changes. Run `grasp reset history` if you genuinely want `grasp scan` to look at everything again from scratch.
- **Claude Code only.** No Cursor, aider, or other agent support yet — the adapter interface is designed to allow it, but only one adapter is built.
- **On-demand review only.** `grasp review` is something you run yourself; there's no persistent "auto-pop the moment a question lands" mode (`grasp watch`) yet. `grasp scan` is inherently on-demand too — there's no background scanning.
- **One generation path, no fallback.** If the headless `claude` call errors, times out, or hits your cost/question cap, Grasp skips that question and logs why — it does not fall back to a second generation system.
- **`cap_reached` can now only mean one thing.** `miss_reason: "cap_reached"` always means `questionsPerSessionCap` was hit — there's no second cap it could be ambiguous with anymore. The `Stop` message names the cap value directly when this happens, so you don't need to reconstruct anything from the database by hand.
- **A generation call that fails or times out isn't lost — it's retried, not silently dropped.** Generation happens at most once per Claude Code turn (`Stop`), covering everything meaningful captured since the last successful attempt. If that one call errors or times out, the diffs it would have covered simply stay pending and are included, combined with whatever else has since accumulated, in the next attempt — nothing needs to be re-edited or re-triggered by you.
- **No documented minimum Claude Code CLI version.** The isolation flags Grasp's generation call depends on (`--tools`, `--safe-mode`, `--setting-sources`, `--strict-mcp-config`) were verified against Claude Code 2.1.223. An older CLI that predates these flags would most likely make every generation call fail gracefully (per the graceful-skip behavior above) rather than crash, but this hasn't been verified against older CLI versions.
- **Generated-file and formatting-only detection are heuristics, not language-aware parsing.** Generated files are recognized by common self-declaring header markers (`DO NOT EDIT`, `@generated`, etc.) plus a small built-in path list — a generator that doesn't mark its own output either way won't be caught. Formatting-only detection is whitespace-based (reindentation, trailing whitespace, and a formatter's line-wrapping are all recognized), plus a narrow, deliberately-conservative check for a formatter wrapping a `return`/assignment/arrow-body expression in a redundant grouping-parenthesis pair to break it across lines (e.g. `return greet(name);` -> `return (\n  greet(name)\n);`) — it isn't a real parser, so it doesn't recognize every behavior-preserving rewrite a formatter or linter autofix might produce (e.g. reordered object keys, `if`/`else` restructuring), and in rare cases a change that only affects whitespace *inside* a token (e.g. spacing inside a string literal) could also be misclassified as formatting-only.
- **An invalid config makes `internal:hook` write a diagnostic to stderr, even though it always exits 0.** A malformed `.grasp.json`/`~/.grasp/config.json` never blocks or crashes a hook firing (see the point above and TESTING_GUIDE's graceful-degradation notes), but the underlying error is still written to the hook process's stderr rather than being fully silent, so it's debuggable. Whether Claude Code itself surfaces stderr from a hook that exited 0 to the user hasn't been verified against a live authenticated session.
- **Hard-gate blocking only applies to recent pending questions (last 24h).** A pending question older than that still shows up in `grasp review` and still counts toward the `Stop` nudge — it just won't actively deny a tool call in a resumed session, matching "never blocks you over something left over from a different day" even when a session is genuinely resumed after a long gap.
- **No answer grading.** Grasp never checks, scores, or judges whether your answer is *right* — your typed answer is never even shown back to any LLM call. After you answer (or genuinely decline, after the one retry described in [Using it](#using-it)), Grasp shows you a sample answer generated up front, alongside the questions themselves, purely for your own side-by-side comparison — the value is still in being made to articulate an answer at all (active recall), not in being scored.
- **A process kill at exactly the wrong moment can, rarely, produce a duplicate question rather than losing one.** Capturing a diff and generating a question about it are fully decoupled now — a capture is just a database row (`captured_diffs`), and a hard process kill any time before generation ever runs simply leaves it pending for the next `Stop` firing to pick up, same as an ordinary Claude failure. The one narrow remaining gap: a `Stop`-triggered batch attempt records its generated question first, then marks the diffs it covered as resolved as a separate follow-up step — a kill in that specific gap leaves those diffs marked unresolved even though a real question about them was already recorded, so a *future* batch could ask about the same underlying change again. Nothing is ever silently lost; the worst case is an occasional redundant question, not a missing one.
- **Checkpoint state can, rarely, self-heal by losing one diff.** The tree snapshots Grasp diffs against between hook firings are deliberately unreferenced ("dangling") git objects — cheap to create on every firing, but eligible for reclamation by `git gc`/`git prune` like any other dangling object. If one gets pruned, Grasp detects the missing object and re-seeds its checkpoint to the current state so capture keeps working going forward, but the one transition that pruned checkpoint would have diffed against is unrecoverable — that specific diff's question is silently skipped, not retried.
- **Git output parsing isn't NUL-delimited.** Diff/status parsing splits on git's normal line- and tab-delimited output (not `-z`), so a path containing a literal tab or newline, or unusual leading/trailing whitespace, is an unhandled edge case. Ordinary filenames, nested paths, spaces, and renames are all covered and tested; this only affects the rare filename that itself contains delimiter-like characters.

## License

[MIT](LICENSE).
