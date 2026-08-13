# Grasp — Prompt 5: hide dev-only commands from default help output

You're working in the Grasp CLI codebase (`grasp-cli`). This is the first of six small-to-large prompts in this batch, each meant to land on its own git branch. Read `grasp-project-brief.md`, `BUILD_PLAN.md`, and `DECISIONS.md` fresh before starting — they reflect current state and take precedence over anything below if they've changed.

**Branching:** create a new branch off the current branch (`main`, unless you're told otherwise) before starting, e.g. `feature/05-help-cleanup`. Do not merge into `main` yourself — leave the branch for review.

## The problem

Found via real testing: typing an unknown/mistyped command (`grasp revie`, etc.) prints `Unknown command: <x>` followed by the *entire* help text — including `debug:seed`, `debug:capture`, `debug:answer`, and `internal:hook`, which are dev-only/internal commands never meant for a real end user. `grasp --help` shows the identical text. Read `src/cli.ts`'s `HELP_TEXT` constant and the unknown-command handling (`process.stderr.write(\`Unknown command: ${command}\n\n\`); printHelp();`) fully before changing anything.

## Required behavior

- Split the help text into a public-facing version (real user commands only: `--version`, `--help`, `init`, `review`, `scan` and its flags, `set`, `reset`, `export` and its flags) and keep the dev/internal commands (`debug:seed`, `debug:capture`, `debug:answer`, `internal:hook`) out of anything printed by default.
- Both `grasp --help` and the unknown-command fallback should show the public version — dev commands aren't meant for end users at all at this point, not even on explicit `--help`. Don't add a hidden `--dev`/`--all` flag to surface them; that's unnecessary surface area. They should still work perfectly fine when invoked directly by name — this is purely about what gets *printed*, not what's *runnable*.
- Keep the dev/internal commands documented somewhere a future maintainer (you, or me) can find them — a code comment directly above their dispatch handling in `cli.ts` is sufficient. Don't invent a new doc file for this.
- Read the rest of `HELP_TEXT` (the "v1 status" footer, etc.) and make sure nothing in the public version references or implies the dev commands.

## Verification

- `npm run build` and `npm test` must pass clean.
- Confirm `grasp --help` no longer lists `debug:*`/`internal:hook`.
- Confirm `grasp somebadcommand` also shows the trimmed, public-only list, not the full one.
- Confirm `grasp debug:seed` (and the other dev commands) still actually run correctly when invoked directly — this is a display-only change, not a functional one.
- Update `README.md` if it currently reproduces `HELP_TEXT` or references these commands anywhere a real user would read.

## When you're done

Commit your work with a clear message. Then create the next branch, `feature/06-question-cap-counting`, off this one, and continue directly to Prompt 6 in this same session — no need to stop or wait between prompts in this batch unless you hit something you genuinely can't resolve, in which case just stop and explain where you are.
