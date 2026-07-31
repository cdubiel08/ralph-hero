#!/bin/bash
# ralph/hooks/scripts/__tests__/hero-auto-tick-audience.test.sh
# Regression guard for GH-1479, retargeted in GH-1590.
#
# Asserts the AUTONOMOUS queue-read call site in the hero skill passes
# audience: "agent" — not the bare next_actions({}) human default that
# silently drops the XS/S estimate penalty and the Backlog/null-state
# triage fallback (directions.ts audiencePenalty + the agent-only
# scored.length === 0 branch).
#
# The tool behavior is already covered by mcp-server directions.test.ts;
# this guards the *consumer* so the call site cannot silently regress to
# the human default again (the #1159 regression GH-1479 fixed).
#
# GH-1606 folded the former public `--mode classify` into the internal
# `--tick` step of `--mode auto`; the autonomous queue read moved with it.
# This guard follows the call site, not the old mode name — the invariant
# under test is "the autonomous path reads with audience: agent", which is
# exactly as load-bearing after the fold as before it.
#
# GH-1590 additionally moved the tick procedure out of SKILL.md into the
# auto-tick.md sibling (SKILL.md is dispatch + skeleton only, per
# ralph/CLAUDE.md). This guard follows the call site there. SKILL.md is
# still checked for the bare-call regression, because its default-mode
# picker legitimately keeps next_actions({}) and must not be confused
# with the autonomous read.

set -euo pipefail

PASS=0
FAIL=0

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
SKILL_FILE="${REPO_ROOT}/ralph/skills/hero/SKILL.md"
TICK_FILE="${REPO_ROOT}/ralph/skills/hero/auto-tick.md"

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
  if grep -qF "$pattern" "$file"; then
    pass "$desc"
  else
    fail "$desc — pattern not found in $(basename "$file"): '$pattern'"
  fi
}

# The tick procedure lives in its own file now, so the "block" is simply
# that file. Keeping the indirection (rather than grepping TICK_FILE
# inline) means a future move back into a section only changes this one
# function.
auto_tick_block() {
  cat "$TICK_FILE"
}

echo "=== hero-auto-tick-audience regression guard (GH-1479, GH-1590) ==="
echo ""

# -----------------------------------------------------------------------
echo "--- Assertion 1: skill file exists ---"
if [[ -s "$SKILL_FILE" ]]; then
  pass "hero SKILL.md exists and is non-empty"
else
  fail "hero SKILL.md missing or empty: $SKILL_FILE"
fi
if [[ -s "$TICK_FILE" ]]; then
  pass "hero auto-tick.md exists and is non-empty"
else
  fail "hero auto-tick.md missing or empty: $TICK_FILE"
fi

# -----------------------------------------------------------------------
echo ""
echo "--- Assertion 2: autonomous call site passes audience: agent ---"
assert_file_contains "auto-tick.md contains next_actions({ audience: \"agent\" })" \
  "$TICK_FILE" 'next_actions({ audience: "agent" })'

# -----------------------------------------------------------------------
echo ""
echo "--- Assertion 3: the agent-audience call lives in auto-tick.md ---"
BLOCK="$(auto_tick_block)"
if [[ -z "$BLOCK" ]]; then
  fail "auto-tick.md is empty or unreadable: $TICK_FILE"
elif printf '%s\n' "$BLOCK" | grep -qF 'next_actions({ audience: "agent" })'; then
  pass "auto-tick.md reads the queue with audience: agent"
else
  fail "auto-tick.md does NOT request audience: agent (regressed to human default?)"
fi

# -----------------------------------------------------------------------
echo ""
echo "--- Assertion 4: the autonomous path has no bare next_actions({}) ---"
# Negative guard: the autonomous path must not be the human default.
# Scoped to auto-tick.md — SKILL.md's default-mode picker keeps the bare
# call legitimately, so a whole-file check would be wrong.
if printf '%s\n' "$BLOCK" | grep -qF 'next_actions({})'; then
  fail "auto-tick.md still has a bare next_actions({}) (human-default regression)"
else
  pass "auto-tick.md has no bare next_actions({})"
fi

# -----------------------------------------------------------------------
echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
