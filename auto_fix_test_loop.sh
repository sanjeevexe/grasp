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
#   1. Run `claude --help` and `codex exec --help` yourself once and confirm
#      the flag names below (--permission-mode, --sandbox) still match your
#      installed versions. CLI flags change between releases.
#   2. Make sure both `claude` and `codex` are authenticated in this shell
#      already (test with a trivial one-off command first).
#   3. Consider running this on a dedicated git branch so every iteration's
#      changes are easy to review/revert afterward.
#
# Usage:
#   MAX_ITERATIONS=10 ./auto_fix_test_loop.sh
#
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

MAX_ITERATIONS="${MAX_ITERATIONS:-10}"
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
  # Returns 0 (true) if any of the given files contain a rate-limit-looking message.
  grep -qiE "$RATE_LIMIT_PATTERN" "$@" 2>/dev/null
}

iteration=1
verdict="FAIL"

echo "Starting Grasp auto-fix/test loop. Max iterations: $MAX_ITERATIONS"
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

  claude -p "$FIX_PROMPT" \
    --output-format json \
    --permission-mode dontAsk \
    > "$LOG_DIR/iteration_${iteration}_claude_output.json" \
    2> "$LOG_DIR/iteration_${iteration}_claude_stderr.log"
  claude_exit=$?

  if check_rate_limit "$LOG_DIR/iteration_${iteration}_claude_stderr.log" "$LOG_DIR/iteration_${iteration}_claude_output.json"; then
    notify "Grasp auto-loop paused" "Claude Code looks rate-limited/out of usage at iteration $iteration. Resume later with the same command."
    exit 2
  fi
  if [ "$claude_exit" -ne 0 ]; then
    notify "Grasp auto-loop stopped" "Claude Code errored at iteration $iteration (exit $claude_exit). Check loop_logs/iteration_${iteration}_claude_stderr.log."
    exit 1
  fi

  echo "=================================================="
  echo "Iteration $iteration / $MAX_ITERATIONS -- Codex testing"
  echo "=================================================="

  TEST_PROMPT="$(cat "$TEST_PROMPT_TEMPLATE")"
  echo "$TEST_PROMPT" > "$LOG_DIR/iteration_${iteration}_test_prompt.txt"

  codex exec "$TEST_PROMPT" \
    --json \
    --sandbox workspace-write \
    > "$LOG_DIR/iteration_${iteration}_codex_output.jsonl" \
    2> "$LOG_DIR/iteration_${iteration}_codex_stderr.log"
  codex_exit=$?

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
