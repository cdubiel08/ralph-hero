#!/bin/bash
# ralph/hooks/scripts/__tests__/triage-postcondition-palette.test.sh
# Tests for the triage-postcondition.sh terminal-token grep pattern.
#
# Strategy: test the grep alternation directly against sample transcript lines
# rather than invoking the full hook (which requires a JSONL transcript file
# and a live Stop hook environment). This exercises the exact regex at line ~48.

set -euo pipefail

PASS=0
FAIL=0

PATTERN='^TRIAGED (routed (→ )?.+|duplicate|canceled|needs-split|escalated|re-estimated|skipped|CLOSE-done|CLOSE-canceled|SPLIT|PROMOTE-research|PROMOTE-plan|WAIT-pr=.+|WAIT-upstream|WAIT-decision)|^Queue empty\.'

pass() {
  echo "  PASS: $1"
  ((PASS++)) || true
}

fail() {
  echo "  FAIL: $1"
  ((FAIL++)) || true
}

assert_matches() {
  local desc="$1"
  local line="$2"
  if echo "$line" | grep -qE "$PATTERN"; then
    pass "$desc"
  else
    fail "$desc — expected match, got no match for: '$line'"
  fi
}

assert_no_match() {
  local desc="$1"
  local line="$2"
  if echo "$line" | grep -qE "$PATTERN"; then
    fail "$desc — expected no match, but matched: '$line'"
  else
    pass "$desc"
  fi
}

echo "=== triage-postcondition palette tests ==="
echo ""
echo "--- Valid tokens (should match) ---"

assert_matches "TRIAGED routed → Research Needed" "TRIAGED routed → Research Needed"
assert_matches "TRIAGED routed → Ready for Plan" "TRIAGED routed → Ready for Plan"
assert_matches "TRIAGED routed → In Progress" "TRIAGED routed → In Progress"
assert_matches "TRIAGED duplicate" "TRIAGED duplicate"
assert_matches "TRIAGED canceled" "TRIAGED canceled"
assert_matches "TRIAGED needs-split" "TRIAGED needs-split"
assert_matches "TRIAGED escalated" "TRIAGED escalated"
assert_matches "TRIAGED re-estimated" "TRIAGED re-estimated"
assert_matches "TRIAGED skipped — branch feature/foo is not main" "TRIAGED skipped — branch feature/foo is not main"
assert_matches "Queue empty." "Queue empty."

echo ""
echo "--- 8 structured verdict tokens (#1417, should match) ---"

assert_matches "TRIAGED CLOSE-done" "TRIAGED CLOSE-done"
assert_matches "TRIAGED CLOSE-canceled" "TRIAGED CLOSE-canceled"
assert_matches "TRIAGED SPLIT" "TRIAGED SPLIT"
assert_matches "TRIAGED PROMOTE-research" "TRIAGED PROMOTE-research"
assert_matches "TRIAGED PROMOTE-plan" "TRIAGED PROMOTE-plan"
assert_matches "TRIAGED WAIT-pr=1338 (=NNN suffix kept)" "TRIAGED WAIT-pr=1338"
assert_matches "TRIAGED WAIT-upstream (suffix dropped)" "TRIAGED WAIT-upstream"
assert_matches "TRIAGED WAIT-decision" "TRIAGED WAIT-decision"

echo ""
echo "--- Retired/invalid tokens (should NOT match) ---"

assert_no_match "TRIAGED valid (retired)" "TRIAGED valid"
assert_no_match "KEEP (never a terminal token)" "KEEP"
assert_no_match "Unknown token TRIAGED unknown" "TRIAGED unknown"
assert_no_match "Bare TRIAGED with no verdict" "TRIAGED"
assert_no_match "TRIAGED WAIT-pr without =NNN suffix (must name the PR)" "TRIAGED WAIT-pr"
assert_matches "Queue empty. with trailing text still matches (starts with sentinel)" "Queue empty. some extra text"
assert_no_match "Lowercase queue empty." "queue empty."
assert_no_match "Prose description of routing (not the literal token)" "Issue was routed to Research Needed"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
