# Overnight prompt run — how to use this folder

Four prompts, meant to run in order, each as its own git branch merged into
`main` only after it passes independently-run build + test checks:

1. `01_small_fixes.md` — small UI/wording fixes to `grasp review`.
2. `02_new_commands.md` — `grasp set`, `grasp reset`, `grasp export`.
3. `03_reliability_rework.md` — the generation-reliability architecture fix (highest risk of the four).
4. `04_codebase_scan.md` — the `grasp scan` feature (biggest, most novel).

## Before you run this

- `main` must be clean (no uncommitted changes) and should already reflect
  everything currently merged — the script refuses to start on a dirty tree.
- Confirm `claude --help` still shows `--dangerously-skip-permissions` (or
  whatever the current unattended-approval flag is called) for your
  installed Claude Code version — the script relies on it to run without a
  human present to approve file/bash actions. Update `run_overnight.sh` if
  the flag name has changed.
- Make the script executable once: `chmod +x prompts/run_overnight.sh`.

## Running it

From the repo root:

```
caffeinate -s ./prompts/run_overnight.sh
```

`caffeinate -s` just keeps the machine awake for the duration — the script
works the same without it, your machine could just fall asleep mid-run.

## What happens if something goes wrong

The script stops immediately, on whichever branch it was working on, the
moment anything doesn't check out — a build/test failure, Claude Code
reporting `BLOCKED`, a merge conflict, anything. It does not attempt to
clean up, revert, or retry on its own. Everything up to that point is
already safely merged into `main`; the in-progress branch is left exactly
as it was for you to look at in the morning.

Check, in this order:
1. The latest file in `prompts/logs/` — full output from every step.
2. `.grasp-prompt-status` on the stopped branch, if it exists — Claude
   Code's own account of what happened.
3. `git log`/`git diff main` on the stopped branch, to see what was actually
   changed before it stopped.

If a run stopped because of an actual usage limit rather than a real
problem, you can just re-run the script once you have capacity again — it
starts fresh from `main`'s current state, so anything already merged won't
be redone. If a branch was left behind from a stopped run, delete it first
(`git branch -D feature/0N-...`) so the script's own "create the branch"
step doesn't collide with it.
