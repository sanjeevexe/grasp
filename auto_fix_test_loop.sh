#!/usr/bin/env bash
#
# Unattended Claude Code <-> Codex fix/test loop for Grasp.
#
# Cycles: Claude Code fixes whatever CODEX_TEST_REPORT.md flagged, then Codex
# re-tests and rewrites the report, until Codex's report ends with
# "FINAL_VERDICT: PASS" or the iteration cap is hit. Notifies you (macOS
# notification + terminal bell) and stops either way -- never re-prompts you
# in between.
#
# BEFORE FIRST REAL RUN:
#   1. Run `claude --dangerously-skip-permissions` interactively (plain,
#      no -p) ONCE and accept the one-time warning dialog it shows. This is
#      required -- the headless -p mode used below cannot accept that dialog
#      itself, and without this one-time step every fix round will silently
#      have every edit/write/bash call denied (this happened on a real run
#      of this script -- 10 iterations, zero code changes, because of this).
#   2. Run `claude --help` and `codex exec --help` yourself once and confirm
#      the flag names below still match your installed versions. CLI flags
#      change between releases.
#   3. Make sure both `claude` and `codex` are authenticated in this shell
#      already (test with a trivial one-off command first).
#   4. Run this on a dedicated git branch -- Claude Code now has full,
#      unattended edit/write/bash access for the whole run.
#
# Usage:
#   MAX_ITERATIONS=10 ./auto_fix_test_loop.sh
#   CLAUDE_TIMEOUT_SECS=2700 CODEX_TIMEOUT_SECS=1800 ./auto_fix_test_loop.sh
#
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

MAX_ITERATIONS="${MAX_ITERATIONS:-10}"
CLAUDE_TIMEOUT_SECS="${CLAUDE_TIMEOUT_SECS:-1800}"   # 30 min per fix round
CODEX_TIMEOUT_SECS="${CODEX_TIMEOUT_SECS:-1800}"     # 30 min per test round
LOG_DIR="$PROJECT_DIR/loop_logs"
mkdir -p "$LOG_DIR"

FIX_PROMPT_TEMPLATE="$PROJECT_DIR/prompts/fix_prompt_template.txt"
TEST_PROMPT_TEMPLATE="$PROJECT_DIR/prompts/test_prompt_template.txt"
REPORT_FILE="$PROJECT_DIR/CODEX_TEST_REPORT.md"

RATE_LIMIT_PATTERN="rate limit|usage limit|quota exceeded|please try again later|too many requests"

notify() {
  local title="$1"
  local message="$2"
  osascript -e "display notification \"$message\" with title \"$title\" sound name \"Glass\"" 2>/dev/null || true
  printf '\a'
  echo ""
  echo ">>> $title -- $message"
}

check_rate_limit() {
  grep -qiE "$RATE_LIMIT_PATTERN" "$@" 2>/dev/null
}

# Portable timeout wrapper (macOS has no `timeout`/`gtimeout` by default).
# Usage: run_with_timeout <seconds> <command...>   -- redirect at the call site as usual.
run_with_timeout() {
  local timeout_secs="$1"; shift
  "$@" &
  local cmd_pid=$!
  (
    sleep "$timeout_secs"
    kill -TERM "$cmd_pid" 2>/dev/null
  ) &
  local watcher_pid=$!
  wait "$cmd_pid" 2>/dev/null
  local exit_code=$?
  kill "$watcher_pid" 2>/dev/null
  wait "$watcher_pid" 2>/dev/null
  return $exit_code
}

iteration=1
verdict="FAIL"

echo "Starting Grasp auto-fix/test loop. Max iterations: $MAX_ITERATIONS"
echo "Per-round timeouts: Claude ${CLAUDE_TIMEOUT_SECS}s, Codex ${CODEX_TIMEOUT_SECS}s"
echo "Logs will be written to: $LOG_DIR"
echo ""

while [ "$iteration" -le "$MAX_ITERATIONS" ]; do
  echo "=================================================="
  echo "Iteration $iteration / $MAX_ITERATIONS -- Claude Code fixing"
  echo "=================================================="

  FIX_PROMPT="$(cat "$FIX_PROMPT_TEMPLATE")"
  if [ -f "$REPORT_FILE" ]; then
    FIX_PROMPT="$FIX_PROMPT

--- Latest CODEX_TEST_REPORT.md (fix what this flags) ---
$(cat "$REPORT_FILE")"
  fi
  echo "$FIX_PROMPT" > "$LOG_DIR/iteration_${iteration}_fix_prompt.txt"

  run_with_timeout "$CLAUDE_TIMEOUT_SECS" \
    claude -p "$FIX_PROMPT" \
    --output-format json \
    --dangerously-skip-permissions \
    > "$LOG_DIR/iteration_${iteration}_claude_output.json" \
    2> "$LOG_DIR/iteration_${iteration}_claude_stderr.log"
  claude_exit=$?

  if [ "$claude_exit" -eq 143 ] || [ "$claude_exit" -eq 124 ]; then
    notify "Grasp auto-loop stopped" "Claude Code timed out after ${CLAUDE_TIMEOUT_SECS}s at iteration $iteration -- possibly stuck on the one-time permissions dialog. Check loop_logs/iteration_${iteration}_claude_stderr.log, and confirm you've run 'claude --dangerously-skip-permissions' interactively once to accept it."
    exit 3
  fi
  if check_rate_limit "$LOG_DIR/iteration_${iteration}_claude_stderr.log" "$LOG_DIR/iteration_${iteration}_claude_output.json"; then
    notify "Grasp auto-loop paused" "Claude Code looks rate-limited/out of usage at iteration $iteration. Resume later with the same command."
    exit 2
  fi
  if [ "$claude_exit" -ne 0 ]; then
    notify "Grasp auto-loop stopped" "Claude Code errored at iteration $iteration (exit $claude_exit). Check loop_logs/iteration_${iteration}_claude_stderr.log."
    exit 1
  fi

  # Commit whatever Claude Code changed this round, if anything -- gives you
  # real per-iteration history instead of one big diff at the end, and
  # guarantees Codex's next test pass actually sees this round's changes
  # regardless of how it isolates its own testing.
  git add -A
  if ! git diff --cached --quiet; then
    git commit -q -m "Auto-fix loop: iteration $iteration" || true
    echo "Committed iteration $iteration's changes."
  else
    echo "No file changes from Claude Code this iteration."
  fi

  echo "=================================================="
  echo "Iteration $iteration / $MAX_ITERATIONS -- Codex testing"
  echo "=================================================="

  TEST_PROMPT="$(cat "$TEST_PROMPT_TEMPLATE")"
  echo "$TEST_PROMPT" > "$LOG_DIR/iteration_${iteration}_test_prompt.txt"

  run_with_timeout "$CODEX_TIMEOUT_SECS" \
    codex exec "$TEST_PROMPT" \
    --json \
    --sandbox workspace-write \
    > "$LOG_DIR/iteration_${iteration}_codex_output.jsonl" \
    2> "$LOG_DIR/iteration_${iteration}_codex_stderr.log"
  codex_exit=$?

  if [ "$codex_exit" -eq 143 ] || [ "$codex_exit" -eq 124 ]; then
    notify "Grasp auto-loop stopped" "Codex timed out after ${CODEX_TIMEOUT_SECS}s at iteration $iteration. Check loop_logs/iteration_${iteration}_codex_stderr.log."
    exit 3
  fi
  if check_rate_limit "$LOG_DIR/iteration_${iteration}_codex_stderr.log" "$LOG_DIR/iteration_${iteration}_codex_output.jsonl"; then
    notify "Grasp auto-loop paused" "Codex looks rate-limited/out of usage at iteration $iteration. Resume later with the same command."
    exit 2
  fi
  if [ "$codex_exit" -ne 0 ]; then
    notify "Grasp auto-loop stopped" "Codex errored at iteration $iteration (exit $codex_exit). Check loop_logs/iteration_${iteration}_codex_stderr.log."
    exit 1
  fi

  # Keep a per-iteration snapshot of the report so you can see how it evolved.
  cp "$REPORT_FILE" "$LOG_DIR/iteration_${iteration}_CODEX_TEST_REPORT.md" 2>/dev/null || true

  # Commit Codex's own report update too, so the branch's history shows the
  # full fix -> test -> fix -> test cycle, not just the fix half.
  git add -A
  if ! git diff --cached --quiet; then
    git commit -q -m "Auto-fix loop: iteration $iteration test report" || true
  fi

  if grep -q "FINAL_VERDICT: PASS" "$REPORT_FILE" 2>/dev/null; then
    verdict="PASS"
    break
  fi

  iteration=$((iteration + 1))
done

echo ""
if [ "$verdict" = "PASS" ]; then
  notify "Grasp auto-loop finished" "All Codex checks passed after $iteration iteration(s). Ready for your manual testing pass."
else
  notify "Grasp auto-loop stopped" "Hit the $MAX_ITERATIONS-iteration cap without a clean pass. Review loop_logs/ and CODEX_TEST_REPORT.md."
fi
