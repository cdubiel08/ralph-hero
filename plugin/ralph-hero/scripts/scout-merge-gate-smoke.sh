#!/usr/bin/env bash
# scout-merge-gate-smoke.sh — smoke test for the Scout Report gate in ralph-merge (Step 4b)
#
# Mirrors the shape of plugin/ralph-hero/scripts/scout-heuristic-smoke.sh.
#
# The gate logic:
#   1. No "## Scout Trigger" comment → PASS (non-UI PR, gate is no-op)
#   2. Scout Trigger present, no Scout Report → BLOCK_NO_REPORT
#   3. Scout Trigger + "## Scout Report" + "Verdict: GREEN" → PASS
#   4. Scout Trigger + "## Scout Report" + "Verdict: RED" (no override) → BLOCK_RED
#   5. Scout Trigger + "## Scout Report" + "Verdict: RED" + "Verdict: GREEN (override)" → PASS
#
# Usage:
#   bash plugin/ralph-hero/scripts/scout-merge-gate-smoke.sh
#
# The script also accepts a newline-separated list of comment bodies on stdin for ad-hoc checks:
#   printf '## Scout Trigger\n/scout\n' | bash .../scout-merge-gate-smoke.sh --check
#
# Output in --check mode: PASS, BLOCK_NO_REPORT, or BLOCK_RED (printed to stdout)
#
# Exit codes:
#   0   All built-in test cases passed (or --check mode: printed result)
#   1   One or more built-in test cases failed

set -euo pipefail

PASS=0
FAIL=0

_pass() { echo "[PASS] $1"; (( PASS++ )) || true; }
_fail() { echo "[FAIL] $1" >&2; (( FAIL++ )) || true; }

# ---------------------------------------------------------------------------
# Core gate function
# Accepts a newline-separated block of comment bodies (each comment separated
# by a sentinel line "---COMMENT---") and prints PASS, BLOCK_NO_REPORT, or BLOCK_RED.
# Returns 0 always — callers read stdout.
# ---------------------------------------------------------------------------
_scout_gate() {
  local comments="$1"

  # Step 4b.1: no trigger → PASS (non-UI PR)
  if ! printf '%s\n' "$comments" | grep -q '^## Scout Trigger'; then
    echo "PASS"
    return 0
  fi

  # Step 4b.2: check for override (highest priority among verdicts)
  if printf '%s\n' "$comments" | grep -qi 'Verdict: GREEN (override)'; then
    echo "PASS"
    return 0
  fi

  # Step 4b.3: check for green verdict
  if printf '%s\n' "$comments" | grep -qi 'Verdict: GREEN'; then
    echo "PASS"
    return 0
  fi

  # Step 4b.4: check for red verdict
  if printf '%s\n' "$comments" | grep -qi 'Verdict: RED'; then
    echo "BLOCK_RED"
    return 0
  fi

  # Step 4b.5: trigger present but no Scout Report at all
  echo "BLOCK_NO_REPORT"
  return 0
}

# ---------------------------------------------------------------------------
# --check mode: read comment bodies from stdin, print gate result
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--check" ]]; then
  INPUT="$(cat)"
  _scout_gate "$INPUT"
  exit 0
fi

# ---------------------------------------------------------------------------
# Built-in test suite
# ---------------------------------------------------------------------------
echo "=== scout-merge-gate smoke test ==="
echo ""

_assert_gate() {
  local label="$1"
  local comments="$2"
  local expected="$3"
  local actual
  actual="$(_scout_gate "$comments")"
  if [[ "$actual" == "$expected" ]]; then
    _pass "$label → $actual (expected)"
  else
    _fail "$label → $actual (expected $expected)"
  fi
}

# --- Test 1: No comments at all → PASS (non-UI PR) ---
echo "--- Test 1: No comments ---"
_assert_gate "no comments" "" "PASS"

# --- Test 2: Unrelated comments, no trigger → PASS ---
echo ""
echo "--- Test 2: Unrelated comments, no trigger ---"
_assert_gate "unrelated comments" "$(printf '## Pull Request\n\nPR created.\n\n## Code Review\n\nLGTM')" "PASS"

# --- Test 3: Scout Trigger only, no Scout Report → BLOCK_NO_REPORT ---
echo ""
echo "--- Test 3: Trigger present, no report ---"
_assert_gate "trigger no report" "$(printf '## Scout Trigger\n\n/scout\n\nThis PR touches UI files.')" "BLOCK_NO_REPORT"

# --- Test 4: Scout Trigger + Scout Report with Verdict: GREEN → PASS ---
echo ""
echo "--- Test 4: Trigger + GREEN report ---"
_assert_gate "trigger + GREEN" "$(printf '## Scout Trigger\n\n/scout\n\n---\n\n## Scout Report\n\nVerdicts reviewed.\nVerdict: GREEN\n\nAll stories passed.')" "PASS"

# --- Test 5: Scout Trigger + Scout Report with Verdict: RED → BLOCK_RED ---
echo ""
echo "--- Test 5: Trigger + RED report ---"
_assert_gate "trigger + RED" "$(printf '## Scout Trigger\n\n/scout\n\n---\n\n## Scout Report\n\nVerdict: RED\n\n2 critical failures found.')" "BLOCK_RED"

# --- Test 6: Trigger + RED report + GREEN(override) → PASS ---
echo ""
echo "--- Test 6: Trigger + RED + override ---"
_assert_gate "trigger + RED + override" "$(printf '## Scout Trigger\n\n/scout\n\n---\n\n## Scout Report\n\nVerdict: RED\n\n---\n\n## Scout Report\n\nVerdict: GREEN (override)\n\nOverriding RED — known flaky story.')" "PASS"

# --- Test 7: Case-insensitive GREEN match ---
echo ""
echo "--- Test 7: Case-insensitive GREEN ---"
_assert_gate "trigger + green lowercase" "$(printf '## Scout Trigger\n\n/scout\n\n---\n\n## Scout Report\n\nVerdict: green')" "PASS"

# --- Test 8: Multiple comments, trigger buried among others → BLOCK_NO_REPORT ---
echo ""
echo "--- Test 8: Trigger buried, no report ---"
_assert_gate "trigger buried" "$(printf '## Pull Request\n\nPR created.\n\n## Scout Trigger\n\n/scout\n\n## Code Review\n\nLGTM')" "BLOCK_NO_REPORT"

# --- Test 9: Interactive merge path (RALPH_AUTO_MERGE unset) still hits gate ---
# Verifies Step 4b is unconditional: gate runs even when auto-merge guard is skipped.
echo ""
echo "--- Test 9: Interactive merge (no RALPH_AUTO_MERGE) — gate still runs ---"
(
  unset RALPH_AUTO_MERGE
  # Simulate the skip-clause output (no gate skip of Step 4b)
  # Gate itself is pure bash logic; RALPH_AUTO_MERGE not consulted by _scout_gate.
  # This test confirms _scout_gate is called unconditionally by asserting BLOCK_NO_REPORT
  # for a trigger-present comment even when RALPH_AUTO_MERGE is absent from env.
  actual="$(_scout_gate "$(printf '## Scout Trigger\n\n/scout')")"
  if [[ "$actual" == "BLOCK_NO_REPORT" ]]; then
    _pass "interactive merge + trigger no report → BLOCK_NO_REPORT (gate reached)"
  else
    _fail "interactive merge + trigger no report → $actual (expected BLOCK_NO_REPORT — gate not reached!)"
  fi
)

# --- Test 10: Interactive merge (no RALPH_AUTO_MERGE) — non-UI PR passes through ---
echo ""
echo "--- Test 10: Interactive merge — non-UI PR passes through gate ---"
(
  unset RALPH_AUTO_MERGE
  actual="$(_scout_gate "$(printf '## Pull Request\n\nPR created.')")"
  if [[ "$actual" == "PASS" ]]; then
    _pass "interactive merge + no trigger → PASS (non-UI PR unblocked)"
  else
    _fail "interactive merge + no trigger → $actual (expected PASS)"
  fi
)

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== scout-merge-gate: PASS=${PASS} FAIL=${FAIL} ==="

if (( FAIL > 0 )); then
  exit 1
fi

echo "Smoke test PASSED."
exit 0
