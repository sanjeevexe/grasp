# Grasp

**Grasp makes you explain what your AI coding agent just built — through short questions you actually have to answer, in your own terminal — because skimming a diff isn't the same as understanding it.**

When you delegate work to Claude Code, the gap between "the agent finished" and "I actually understand what it built" is where codebases quietly become unreadable to their own authors. Grasp watches your Claude Code session, and when a meaningful change lands, it generates one or two short questions about it — a general concept question, then a question that applies it to your actual diff. You work through them whenever you check in (`grasp review`), typing a real answer or explicitly skipping — in your own words, locally, in your terminal. Nothing is graded. The value is in being made to articulate it. By default Grasp only nudges you that questions are waiting; if you turn on hard-gate mode, it will also refuse Claude Code's next action in that session until you've engaged with what's pending — see [How it works](#how-it-works) for exactly what's on-demand versus enforced.

This is a v1 build. It's opinionated, it's Claude-Code-only for now, and it hasn't been used in anger for a full week yet — see [Status and limitations](#status-and-limitations) below before you rely on it.

---

## How it works

1. You run Claude Code on a real task in a repo where you've installed Grasp's hooks (`grasp init`).
2. When Claude Code makes a meaningful change (not a one-line formatting tweak, not a lockfile bump), Grasp captures *just what's new since it last looked* for that session (not your whole uncommitted working tree — checkpoint-based, so it won't re-ask about the same diff twice or blame the agent for work that predates its session) and — using Claude Code's own headless mode — generates a short concept question and an instance question about it.
3. Those questions sit in your local history until you run `grasp review`, at which point you answer or explicitly skip them, one at a time, in a small terminal UI.
4. By default, nothing blocks you — Grasp just nudges you (a one-line message after each turn: "N questions waiting — run `grasp review`"). If you turn on hard-gate mode, Grasp will refuse the next tool call in that session until you've answered or skipped.

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

This opens an interactive terminal view of every question you haven't answered or skipped yet, across every repo Grasp is watching (not just the one you're sitting in — a question is about something you learned, not about where you happened to be standing). Each question shows the diff it's about, then a concept question, then an instance question. The answer field is focused and ready to type in the moment a question appears — no extra keypress needed first. If the diff has more lines than fit on screen, use the up/down arrow keys to scroll it (works whether or not you've started typing, and while reading an explanation or sample answer too). Type your answer and press Enter — a blank Enter is rejected with a message, not treated as a skip.

After you submit a real answer, Grasp shows a sample answer for that question before moving on — for your own comparison, never a grade or a correctness check (see [Status and limitations](#status-and-limitations)). If you're stuck, press Escape instead of typing: Grasp shows a short explanation of the underlying concept, then gives you one retry at the same question. From there, either type a real answer (recorded normally, sample answer shown, same as above) or press Escape again to genuinely decline — that's still a real keypress, never silent or automatic, and you'll still see the sample answer before moving on even if you declined. If several questions piled up from one long session, they're grouped so you work through one session's worth before moving to the next, with a running count so you can see how much is left.

## What gets sent where, and what it costs

Grasp reads your code and sends diffs to an LLM to generate questions. That's worth being direct about:

- **What's sent:** only the filtered, "significant" part of a diff — lockfiles, generated files, and formatting-only changes are filtered per-file, while the size floor (`diffThresholds.minChangedLines`) is a diff-level check: a whole diff is skipped only if *every* remaining file is under the floor, so once any one file clears it, its smaller companion files in that same diff are sent too, not filtered out individually — plus a list of programming concepts you've already answered questions about (so Grasp doesn't re-teach you the same thing). No full-repo access, and no file contents beyond that diff are ever sent to Claude — Grasp's generation call runs with `--tools ""` (disables all built-in tools, not just `--allowedTools ""`'s allow-list) and `--safe-mode --setting-sources "" --strict-mcp-config` (disables `CLAUDE.md`/skills/plugins/hooks/MCP-server loading and any pre-existing tool allow-rules from your own Claude Code settings), so the nested call has no tools to call and no repo customizations to load in the first place. (To catch a generated file whose header wasn't touched by the current diff, the filter does read up to 4KB off the start of each changed file on disk — that local check never leaves your machine or gets sent anywhere.)
- **Where it's sent:** to `claude -p`, i.e. your own already-configured Claude Code session. This is not a separate API key, not a hosted Grasp backend, and nothing goes to Grasp's maintainer — there is no telemetry, ever.
- **What it costs:** if you're on a Claude subscription, this spends your existing rate-limit headroom. If you're API-billed, it's real (small) dollars — each question-generation call is typically a fraction of a cent. Grasp tracks cumulative spend per Claude Code session and stops generating once a configurable cap is hit (default $0.25/session). You'll see a running total in the `Stop` message after a session that spent anything ("$0.0043 spent generating comprehension questions this session so far"). **If a call's real cost can't be determined at all** (a process failure or timeout with no usable output, or a well-formed response that's simply missing its own cost figure), Grasp does not treat that call as free — it conservatively halts further generation for that session entirely, since it can no longer verify the cap is being honored. That session's `Stop` message will still show whatever cost total *is* known, which may therefore undercount the session's true spend by that one uncosted call.
- **What's stored, and where:** everything Grasp logs — diffs, questions, sample answers, your own answers, costs — lives in a plain SQLite database at `~/.grasp/history.db`. It's not obfuscated; you can inspect it directly with `sqlite3 ~/.grasp/history.db ".schema"` or any SQLite browser. Nothing leaves your machine except the generation calls described above.

## Configuration

Grasp reads a global config at `~/.grasp/config.json` (created with defaults on first run), optionally overridden per-repo by a `.grasp.json` file in that repo's root. Repo-level values win on conflict; only the keys you actually set need to appear in `.grasp.json`. Both files are plain, strict JSON — no comments, no trailing commas; the example below is meant to be copied and have values changed, not copied verbatim with the annotations still in it.

```json
{
  "gateMode": "soft",
  "costCapUsd": 0.25,
  "ignorePatterns": [],
  "questionsPerSessionCap": 8,
  "diffThresholds": {
    "minChangedLines": 3,
    "maxTotalChangedLines": 1500,
    "maxSingleFileChangedLines": 800
  }
}
```

- **`gateMode`** — `"soft"` (nudge only) or `"hard"` (blocks the next tool call until you engage). See [Gate modes](#gate-modes).
- **`costCapUsd`** — stop generating for a session once cumulative spend hits this.
- **`ignorePatterns`** — extra paths/filenames to never generate questions about, beyond the built-in list. **Matching is plain, not glob**: a pattern ending in `/` matches that name as a directory segment anywhere in the path (e.g. `"scripts/"` matches `scripts/build.sh` and `packages/a/scripts/x.js`); any other pattern matches an exact basename or an exact full relative path (e.g. `"generated.ts"` matches both `generated.ts` and `src/generated.ts`, but not `generated.test.ts`). Wildcards like `*` or `**` are **not** supported and are matched literally, so `"generated/**"` will silently match nothing — use `"generated/"` instead.
- **`questionsPerSessionCap`** — stop generating once a session has produced this many real question **events**. This counts `events` rows, not individual displayed questions: a "both" event (concept + instance) is one toward this cap but shows as two questions in `grasp review`, so a cap of 8 can still leave you with up to 16 questions to actually answer.
- **`diffThresholds.minChangedLines`** — diffs smaller than this (in every file) are too trivial to ask about.
- **`diffThresholds.maxTotalChangedLines`** / **`maxSingleFileChangedLines`** — diffs bigger than this are skipped rather than crammed into one question.

A built-in baseline (lockfiles, `node_modules/`, `dist/`, `build/`, `.git/`, and Grasp's own `.grasp.json`/`.claude/settings.local.json`) is always excluded regardless of what you configure — `ignorePatterns` is for adding to that list, not replacing it.

### Gate modes

- **`soft` (default):** Grasp never blocks anything. You get a one-line reminder after each Claude Code turn if a question is still waiting, and that's it.
- **`hard`:** Grasp will deny the next tool call in a Claude Code session if that session has an unanswered question outstanding, until you answer or explicitly skip it via `grasp review`. This only reaches into the session that produced the question — it never blocks you over something left over from a different day or a different project. Turn this on deliberately; it's a real interruption, and the whole design philosophy here is "teach, don't punish" — soft is the safer default for exactly that reason.

## Data and privacy

- Everything is local-first. `~/.grasp/history.db` is the single source of truth, in plain SQLite.
- No telemetry, no analytics, nothing phoned home to Grasp's maintainer — ever.
- The only outbound calls Grasp makes are the `claude -p` generation calls described above, using your own existing Claude Code auth.

## Status and limitations

- **Claude Code only.** No Cursor, aider, or other agent support yet — the adapter interface is designed to allow it, but only one adapter is built.
- **On-demand review only.** `grasp review` is something you run yourself; there's no persistent "auto-pop the moment a question lands" mode (`grasp watch`) yet.
- **One generation path, no fallback.** If the headless `claude` call errors, times out, or hits your cost/question cap, Grasp skips that question and logs why — it does not fall back to a second generation system.
- **`cap_reached` doesn't say which cap.** When a miss is logged with `miss_reason: "cap_reached"`, the database doesn't record whether it was the cost cap or the question cap that actually fired for that row — both caps use the same value. It's *approximately* reconstructable by hand (compare that session's cumulative `cost_usd` against `costCapUsd`, and its real-question count against `questionsPerSessionCap`), but only using your *current* config values — Grasp doesn't snapshot which cap values were actually in force at the time a given row was logged, so if you've since changed `costCapUsd` or `questionsPerSessionCap`, older `cap_reached` rows may no longer line up cleanly against the numbers you're comparing them to today.
- **The cost cap is checked before each call, not enforced mid-call.** Grasp refuses to *start* a new generation call once cumulative spend already meets the cap — it can't know a call's real cost until that call finishes, so the one call that was already in flight when the cap was crossed can land slightly over it (e.g. a $0.25 cap plus one ~$0.002 call landing at $0.252). Generation calls for the same Claude Code session are serialized against each other (even if several hook firings overlap) specifically so this stays a single-call overshoot, not one that multiplies with however many hooks happened to fire at once.
- **A call whose cost genuinely can't be determined halts generation for that whole session, not just that one call.** Grasp does try to recover a reported cost even from a call that exits nonzero (Claude Code's own "print a JSON result, then exit 1" convention for some errors), but if no cost figure is recoverable at all, the session's true spend is no longer fully known — so rather than guess (and risk quietly exceeding your configured cap), Grasp stops generating any further questions for that session. That session keeps whatever pending/answered questions it already has; a later Claude Code session is unaffected.
- **No documented minimum Claude Code CLI version.** The isolation flags Grasp's generation call depends on (`--tools`, `--safe-mode`, `--setting-sources`, `--strict-mcp-config`) were verified against Claude Code 2.1.223. An older CLI that predates these flags would most likely make every generation call fail gracefully (per the graceful-skip behavior above) rather than crash, but this hasn't been verified against older CLI versions.
- **Generated-file and formatting-only detection are heuristics, not language-aware parsing.** Generated files are recognized by common self-declaring header markers (`DO NOT EDIT`, `@generated`, etc.) plus a small built-in path list — a generator that doesn't mark its own output either way won't be caught. Formatting-only detection is whitespace-based (reindentation, trailing whitespace, and a formatter's line-wrapping are all recognized), plus a narrow, deliberately-conservative check for a formatter wrapping a `return`/assignment/arrow-body expression in a redundant grouping-parenthesis pair to break it across lines (e.g. `return greet(name);` -> `return (\n  greet(name)\n);`) — it isn't a real parser, so it doesn't recognize every behavior-preserving rewrite a formatter or linter autofix might produce (e.g. reordered object keys, `if`/`else` restructuring), and in rare cases a change that only affects whitespace *inside* a token (e.g. spacing inside a string literal) could also be misclassified as formatting-only.
- **An invalid config makes `internal:hook` write a diagnostic to stderr, even though it always exits 0.** A malformed `.grasp.json`/`~/.grasp/config.json` never blocks or crashes a hook firing (see the point above and TESTING_GUIDE's graceful-degradation notes), but the underlying error is still written to the hook process's stderr rather than being fully silent, so it's debuggable. Whether Claude Code itself surfaces stderr from a hook that exited 0 to the user hasn't been verified against a live authenticated session.
- **Hard-gate blocking only applies to recent pending questions (last 24h).** A pending question older than that still shows up in `grasp review` and still counts toward the `Stop` nudge — it just won't actively deny a tool call in a resumed session, matching "never blocks you over something left over from a different day" even when a session is genuinely resumed after a long gap.
- **No answer grading.** Grasp never checks, scores, or judges whether your answer is *right* — your typed answer is never even shown back to any LLM call. After you answer (or genuinely decline, after the one retry described in [Using it](#using-it)), Grasp shows you a sample answer generated up front, alongside the questions themselves, purely for your own side-by-side comparison — the value is still in being made to articulate an answer at all (active recall), not in being scored.
- **A process kill at exactly the wrong moment can lose one question.** Capturing a diff and generating a question about it are two separate steps — the capture is committed to the database first, and the (slow, external) generation call runs afterward, outside that transaction, so a hook firing for an unrelated repo isn't stalled waiting on it. If the whole process is killed (or hits an unexpected database error) in the narrow window after a capture commits but before its generation call finishes and records a result, that one diff's question is lost with no automatic retry — normal Claude failures (errors, timeouts, cap-reached) are all caught and logged as misses, but a hard process kill in that specific gap isn't.
- **Checkpoint state can, rarely, self-heal by losing one diff.** The tree snapshots Grasp diffs against between hook firings are deliberately unreferenced ("dangling") git objects — cheap to create on every firing, but eligible for reclamation by `git gc`/`git prune` like any other dangling object. If one gets pruned, Grasp detects the missing object and re-seeds its checkpoint to the current state so capture keeps working going forward, but the one transition that pruned checkpoint would have diffed against is unrecoverable — that specific diff's question is silently skipped, not retried.
- **Git output parsing isn't NUL-delimited.** Diff/status parsing splits on git's normal line- and tab-delimited output (not `-z`), so a path containing a literal tab or newline, or unusual leading/trailing whitespace, is an unhandled edge case. Ordinary filenames, nested paths, spaces, and renames are all covered and tested; this only affects the rare filename that itself contains delimiter-like characters.

## License

[MIT](LICENSE).
