#!/usr/bin/env bash
# loop-continuation.test.sh — Verify heartbeat-vs-drain distinction in loop-wrapper.md manifest
# Usage: bash ralph/skills/shared/__tests__/loop-continuation.test.sh
# Exit 0 = all pass; exit 1 = at least one failure.
#
# Parses loop-wrapper.md § Continuation-rules manifest.
# Asserts:
#   heartbeat-mode rows do NOT list "Queue empty." as a terminal sentinel.
#   drain-mode rows DO list "Queue empty." as a terminal sentinel.
# Catches manifest drift if someone wires a new skill with the wrong continuation shape.

set -uo pipefail

PASS=0
FAIL=0

# Locate repo root from this script's location (ralph/skills/shared/__tests__)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LOOP_WRAPPER="${REPO_ROOT}/ralph/skills/shared/loop-wrapper.md"

ok()   { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; echo "      expected: $2"; echo "      got:      $3"; FAIL=$((FAIL + 1)); }

if [[ ! -f "$LOOP_WRAPPER" ]]; then
  echo "FATAL: loop-wrapper.md not found at ${LOOP_WRAPPER}"
  exit 1
fi

# Extract the manifest table: lines between ## Continuation-rules manifest and the next ---
# Table rows start with "| " (pipe-space)
manifest=$(awk '/^## Continuation-rules manifest/,/^---/' "$LOOP_WRAPPER" | grep '^|')

if [[ -z "$manifest" ]]; then
  echo "FATAL: No manifest table rows found in loop-wrapper.md § Continuation-rules manifest"
  exit 1
fi

# Helper: get the row for a given skill:mode key (exact match on first column)
get_row() {
  local key="$1"
  printf '%s\n' "$manifest" | grep "^| ${key} "
}

# Helper: check terminal-sentinel column (column 4) of a row for "Queue empty."
row_has_queue_empty() {
  local row="$1"
  # Table cols: | skill:mode | progress sentinels | terminal sentinels | delay buckets | notes |
  # Extract col 4 (terminal sentinels) by splitting on |
  local terminal_col
  terminal_col=$(printf '%s' "$row" | awk -F'|' '{print $4}')
  printf '%s' "$terminal_col" | grep -q 'Queue empty\.'
}

# ── Heartbeat modes: must NOT have Queue empty. as terminal sentinel ───────────

HEARTBEAT_MODES=(
  "caretake:hygiene"
  "caretake:watch"
  "caretake:all"
  "catch-up:report"
  "hero:watch"
)

for mode in "${HEARTBEAT_MODES[@]}"; do
  row=$(get_row "$mode")
  if [[ -z "$row" ]]; then
    fail "manifest row exists for ${mode}" "row present" "not found"
    continue
  fi
  if row_has_queue_empty "$row"; then
    fail "${mode} is heartbeat → no Queue empty. in terminal sentinels" \
      "Queue empty. NOT present" \
      "Queue empty. IS present in: $(printf '%s' "$row" | awk -F'|' '{print $4}')"
  else
    ok "${mode} (heartbeat) does not list Queue empty. as terminal sentinel"
  fi
done

# ── Drain modes: must have Queue empty. as terminal sentinel ──────────────────

DRAIN_MODES=(
  "research:auto"
  "plan:auto"
  "plan:review"
  "impl:auto"
  "impl:pr"
  "review:default"
  "review:val"
  "review:code"
  "review:merge"
  "caretake:triage"
  "caretake:unblock"
  "caretake:split"
  "caretake:default-event"
  "hero:auto"
)

for mode in "${DRAIN_MODES[@]}"; do
  row=$(get_row "$mode")
  if [[ -z "$row" ]]; then
    fail "manifest row exists for ${mode}" "row present" "not found"
    continue
  fi
  if row_has_queue_empty "$row"; then
    ok "${mode} (drain) lists Queue empty. as terminal sentinel"
  else
    fail "${mode} is drain → Queue empty. in terminal sentinels" \
      "Queue empty. present" \
      "not found in: $(printf '%s' "$row" | awk -F'|' '{print $4}')"
  fi
done

# ── Summary note from manifest ─────────────────────────────────────────────────
# Verify the explanatory note about heartbeat vs drain is present in the file.
if grep -q 'Heartbeat vs. drain continuation rule' "$LOOP_WRAPPER"; then
  ok "manifest contains heartbeat-vs-drain continuation rule summary"
else
  fail "heartbeat-vs-drain summary" "summary present" "not found in loop-wrapper.md"
fi

# ── summary ───────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
if [[ "$FAIL" -eq 0 ]]; then
  exit 0
else
  exit 1
fi
