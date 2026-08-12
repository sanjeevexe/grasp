#!/usr/bin/env bash
#
# Runs Grasp's four staged prompts (see 01_small_fixes.md .. 04_codebase_scan.md
# in this same folder) through Claude Code, one at a time, unattended.
#
# For each prompt: create a fresh branch off main, run Claude Code on that
# prompt with full tool access, independently verify (build + test) rather
# than trusting Claude Code's own self-report, merge into main only if that
# passes, then move to the next prompt off the now-updated main. Stops
# immediately and leaves everything as-is (no merge, no cleanup) the moment
# anything doesn't check out cleanly, so the branch is there to inspect in
# the morning either way.
#
# Usage (from the repo root):
#   caffeinate -s ./prompts/run_overnight.sh          # start from prompt 1
#   caffeinate -s ./prompts/run_overnight.sh 2         # resume from prompt 2
#
# `caffeinate -s` keeps the machine from sleeping for the duration; without
# it, the script itself behaves identically, your machine just might sleep
# mid-run on battery.
#
# The optional argument is a 1-based prompt number to START from — use this
# to resume after a prompt was already manually merged into main (e.g. after
# investigating a stop and confirming the branch was safe to merge by hand).
# It assumes everything before that number is already merged into main;
# it does not check this for you.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PROMPTS_DIR="$REPO_ROOT/prompts"
LOG_DIR="$REPO_ROOT/prompts/logs"
mkdir -p "$LOG_DIR"
RUN_LOG="$LOG_DIR/overnight-$(date +%Y%m%d-%H%M%S).log"

# Ordered: name -> branch suffix -> prompt file
PROMPT_NAMES=("small-fixes" "new-commands" "reliability-rework" "codebase-scan")
PROMPT_FILES=("01_small_fixes.md" "02_new_commands.md" "03_reliability_rework.md" "04_codebase_scan.md")

log() {
  echo "[$(date '+%H:%M:%S')] $*" | tee -a "$RUN_LOG"
}

fail_stop() {
  log "STOPPING: $*"
  log "Left on branch: $(git branch --show-current). Nothing further will run."
  exit 1
}

# --- one-time setup -----------------------------------------------------

# Never let the transient per-prompt status signal file get swept into a
# commit by an `add -A`-style step inside a prompt.
if ! grep -qxF ".grasp-prompt-status" .gitignore 2>/dev/null; then
  echo ".grasp-prompt-status" >> .gitignore
  git add .gitignore
  git commit -m "Ignore .grasp-prompt-status (overnight-run orchestration signal file)" >> "$RUN_LOG" 2>&1
fi

command -v claude >/dev/null 2>&1 || fail_stop "claude CLI not found on PATH."

START_AT="${1:-1}"
if ! [[ "$START_AT" =~ ^[1-4]$ ]]; then
  fail_stop "Argument must be a prompt number 1-4 (got: '$START_AT')."
fi
START_INDEX=$((START_AT - 1))

log "Starting overnight run from prompt $START_AT/4. Log: $RUN_LOG"

# --- main loop ------------------------------------------------------------

for i in "${!PROMPT_NAMES[@]}"; do
  if [ "$i" -lt "$START_INDEX" ]; then
    continue
  fi
  NAME="${PROMPT_NAMES[$i]}"
  FILE="${PROMPT_FILES[$i]}"
  BRANCH="feature/$(printf '%02d' $((i+1)))-$NAME"
  PROMPT_PATH="$PROMPTS_DIR/$FILE"

  log "=== Prompt $((i+1))/4: $NAME ==="

  [ -f "$PROMPT_PATH" ] || fail_stop "Prompt file missing: $PROMPT_PATH"

  git checkout main >> "$RUN_LOG" 2>&1 || fail_stop "Could not checkout main before starting $NAME."
  git status --porcelain | grep -q . && fail_stop "main has uncommitted changes — refusing to start on a dirty tree."

  git checkout -b "$BRANCH" >> "$RUN_LOG" 2>&1 || fail_stop "Could not create branch $BRANCH (does it already exist from a prior run?)."

  rm -f .grasp-prompt-status

  log "Running Claude Code on $FILE (branch $BRANCH)..."
  # --dangerously-skip-permissions: required for genuinely unattended
  # operation (no one present to approve file/bash actions). Confirm this
  # is the correct flag name for your installed Claude Code version before
  # relying on it — verify with `claude --help` first if you haven't run an
  # unattended session like this recently.
  claude -p "$(cat "$PROMPT_PATH")" \
    --dangerously-skip-permissions \
    >> "$RUN_LOG" 2>&1
  CLAUDE_EXIT=$?

  if [ $CLAUDE_EXIT -ne 0 ]; then
    fail_stop "$NAME: claude exited non-zero ($CLAUDE_EXIT) — check $RUN_LOG. This may mean a usage limit was hit; check the log for that specifically before assuming a crash."
  fi

  if [ ! -f .grasp-prompt-status ]; then
    fail_stop "$NAME: no .grasp-prompt-status file was written — Claude Code did not follow the completion contract. Check $RUN_LOG and the branch's working tree by hand."
  fi

  STATUS_CONTENT="$(cat .grasp-prompt-status)"
  if [[ "$STATUS_CONTENT" == BLOCKED:* ]]; then
    fail_stop "$NAME reported: $STATUS_CONTENT"
  fi
  if [[ "$STATUS_CONTENT" != "DONE" ]]; then
    fail_stop "$NAME: .grasp-prompt-status had unexpected content: '$STATUS_CONTENT'"
  fi

  log "$NAME: Claude Code reported DONE. Running independent verification (build + test)..."

  rm -f .grasp-prompt-status

  npm run build >> "$RUN_LOG" 2>&1 || fail_stop "$NAME: npm run build failed after Claude Code reported DONE. Branch $BRANCH left unmerged for inspection."

  # A known set of PTY-driven tests (reviewAppPty.test.js) are confirmed
  # pre-existing-flaky on this machine, independent of any prompt's changes
  # (verified 2026-08-12: identical failures reproduced on unmodified main).
  # Retry the test suite up to 2 extra times before treating a failure as
  # real — genuine regressions fail consistently across retries; timing
  # flakiness usually doesn't. This does not weaken the gate: it still stops
  # the run if failures persist across all attempts.
  TEST_ATTEMPTS=3
  TEST_OK=0
  for attempt in $(seq 1 $TEST_ATTEMPTS); do
    if npm test >> "$RUN_LOG" 2>&1; then
      TEST_OK=1
      break
    fi
    log "$NAME: npm test failed (attempt $attempt/$TEST_ATTEMPTS) — retrying in case this is known PTY-test flakiness, not a real regression."
  done
  [ $TEST_OK -eq 1 ] || fail_stop "$NAME: npm test failed $TEST_ATTEMPTS times in a row after Claude Code reported DONE — treating as a real failure, not flakiness. Branch $BRANCH left unmerged for inspection."

  log "$NAME: build + test passed independently. Merging into main..."

  git add -A >> "$RUN_LOG" 2>&1
  git status --porcelain | grep -q . && git commit -m "Cleanup after $NAME verification" >> "$RUN_LOG" 2>&1

  git checkout main >> "$RUN_LOG" 2>&1 || fail_stop "$NAME: could not check out main to merge."
  git merge --no-ff "$BRANCH" -m "Merge $BRANCH: $NAME" >> "$RUN_LOG" 2>&1 || fail_stop "$NAME: merge into main failed — branch $BRANCH left as-is for manual resolution."

  log "$NAME: merged into main cleanly."
done

log "All four prompts completed and merged into main. Nothing left to run."
log "Review the log at $RUN_LOG and the commit history on main before considering this final."
