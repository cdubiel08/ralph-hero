#!/bin/bash
# ralph/hooks/scripts/__tests__/caretake-watch-blockers.test.sh
# Doc-structure assertions for the watch-blockers mode.
#
# Strategy: assert structural invariants over the skill surface files using grep,
# confirming the mode exists with the correct shape, token, and wiring — the same
# coverage model used by triage-postcondition-palette.test.sh and the CI
# doc-consistency check (#1458). watch-blockers has no runtime Stop hook (parity
# with watch-pr/watch-upstream), so doc-structure is the correct coverage target.

set -euo pipefail

PASS=0
FAIL=0

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
MODE_FILE="${REPO_ROOT}/ralph/skills/caretake/modes/watch-blockers.md"
TOKENS_FILE="${REPO_ROOT}/ralph/skills/caretake/outcome-tokens.md"
SKILL_FILE="${REPO_ROOT}/ralph/skills/caretake/SKILL.md"
TRIAGE_FILE="${REPO_ROOT}/ralph/skills/caretake/modes/triage.md"

pass() {
  echo "  PASS: $1"
  ((PASS++)) || true
}

fail() {
  echo "  FAIL: $1"
  ((FAIL++)) || true
}

assert_file_contains() {
  local desc="$1"
  local file="$2"
  local pattern="$3"
  if grep -q "$pattern" "$file"; then
    pass "$desc"
  else
    fail "$desc — pattern not found in $(basename "$file"): '$pattern'"
  fi
}

assert_file_count_ge() {
  local desc="$1"
  local file="$2"
  local pattern="$3"
  local min="$4"
  local count
  count=$(grep -c "$pattern" "$file" || true)
  if [[ "$count" -ge "$min" ]]; then
    pass "$desc (count=$count)"
  else
    fail "$desc — expected ≥$min matches, got $count in $(basename "$file") for pattern: '$pattern'"
  fi
}

assert_file_exists_nonempty() {
  local desc="$1"
  local file="$2"
  if [[ -s "$file" ]]; then
    pass "$desc"
  else
    fail "$desc — file missing or empty: $file"
  fi
}

echo "=== caretake-watch-blockers doc-structure tests ==="
echo ""

# -----------------------------------------------------------------------
echo "--- Assertion 1: Mode file exists and is non-empty ---"
assert_file_exists_nonempty "watch-blockers.md exists and is non-empty" "$MODE_FILE"

# -----------------------------------------------------------------------
echo ""
echo "--- Assertion 2: Mirrors watch-upstream shape (required headings + subcommand export) ---"
assert_file_contains "§Step 1: Verify branch heading present" "$MODE_FILE" "§Step 1: Verify branch"
assert_file_contains "§Step 2 heading present" "$MODE_FILE" "§Step 2"
assert_file_contains "§Step 5 heading present" "$MODE_FILE" "§Step 5"
assert_file_contains "§Constraints heading present" "$MODE_FILE" "§Constraints"
assert_file_contains "export RALPH_SUBCOMMAND=watch-blockers" "$MODE_FILE" "export RALPH_SUBCOMMAND=watch-blockers"
assert_file_contains "No Stop hook note present (parity)" "$MODE_FILE" "No .Stop. hook"

# -----------------------------------------------------------------------
echo ""
echo "--- Assertion 3: Advance behavior documented ---"
assert_file_contains "remove_dependency call present" "$MODE_FILE" "remove_dependency"
assert_file_contains "## Unblocked comment name present" "$MODE_FILE" "## Unblocked"
assert_file_contains "Default advance target Ready for Plan present" "$MODE_FILE" "Ready for Plan"
assert_file_contains "OPEN-blocker leave-untouched branch present" "$MODE_FILE" "leave untouched"
assert_file_contains "blockedNumber param (not blockedByNumber)" "$MODE_FILE" "blockedNumber"
# Confirm the non-existent blockedByNumber param is NOT used as a call argument
# (The mode doc may mention it in a "Do NOT use" warning — that is acceptable)
if grep -qE "remove_dependency\([^)]*blockedByNumber[^)]*\)" "$MODE_FILE" 2>/dev/null; then
  fail "remove_dependency must NOT use blockedByNumber param (wrong schema)"
else
  pass "remove_dependency does not use non-existent blockedByNumber param as an argument"
fi

# -----------------------------------------------------------------------
echo ""
echo "--- Assertion 4: Reads the #1472 convention (dual detection signal) ---"
assert_file_contains "list_dependencies (edge signal) present" "$MODE_FILE" "list_dependencies"
assert_file_contains "## Escalation body signal present" "$MODE_FILE" "## Escalation"
assert_file_contains "Blocked by # phrasing present" "$MODE_FILE" "Blocked by #"
assert_file_contains "closes / Move to phrasing present" "$MODE_FILE" "Move to"

# -----------------------------------------------------------------------
echo ""
echo "--- Assertion 5: Terminal tokens present in mode file, outcome-tokens.md, and SKILL.md ---"
assert_file_contains "WATCH-BLOCKERS token in mode file" "$MODE_FILE" "WATCH-BLOCKERS"
assert_file_contains "WATCH-BLOCKERS token in outcome-tokens.md" "$TOKENS_FILE" "WATCH-BLOCKERS"
assert_file_contains "WATCH-BLOCKERS token in SKILL.md" "$SKILL_FILE" "WATCH-BLOCKERS"

# All three token variants present in mode file
assert_file_contains "WATCH-BLOCKERS summary token (n advanced, m still blocked)" "$MODE_FILE" "WATCH-BLOCKERS.*advanced.*still blocked"
assert_file_contains "WATCH-BLOCKERS IDLE token" "$MODE_FILE" "WATCH-BLOCKERS IDLE"
assert_file_contains "WATCH-BLOCKERS SKIPPED token" "$MODE_FILE" "WATCH-BLOCKERS SKIPPED"

# -----------------------------------------------------------------------
echo ""
echo "--- Assertion 6: Heartbeat wiring in SKILL.md ---"
assert_file_contains "--mode watch-blockers in fan-out dispatch" "$SKILL_FILE" 'mode watch-blockers'
assert_file_contains "6 total (fan-out child count updated)" "$SKILL_FILE" "6 total"
assert_file_contains "modes/watch-blockers.md in mode-bodies list" "$SKILL_FILE" "modes/watch-blockers.md"
assert_file_count_ge "watch-blockers appears ≥5 times in SKILL.md (frontmatter ×2, table, fan-out, mode-bodies, token-ref)" \
  "$SKILL_FILE" "watch-blockers" 5

# -----------------------------------------------------------------------
echo ""
echo "--- Assertion 7: Token registry in outcome-tokens.md ---"
assert_file_contains "## Watch-Blockers terminal tokens heading" "$TOKENS_FILE" "## Watch-Blockers terminal tokens"
assert_file_count_ge "WATCH-BLOCKERS appears ≥3 times in outcome-tokens.md" "$TOKENS_FILE" "WATCH-BLOCKERS" 3
assert_file_contains "no Stop postcondition hook (parity) note in outcome-tokens.md" "$TOKENS_FILE" \
  "watch-blockers has no .Stop. postcondition hook"

# -----------------------------------------------------------------------
echo ""
echo "--- Assertion 8: triage.md cross-ref updated to live (not future) ---"
assert_file_contains "triage.md names watch-blockers as the live consumer" "$TRIAGE_FILE" \
  "caretake --mode watch-blockers"
# Confirm the old "Gap C ... future" language is gone
if grep -q "no watcher yet" "$TRIAGE_FILE" 2>/dev/null; then
  fail "triage.md still has stale 'no watcher yet' language — should be updated to live"
else
  pass "triage.md no longer has stale 'no watcher yet' language"
fi

# -----------------------------------------------------------------------
echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
