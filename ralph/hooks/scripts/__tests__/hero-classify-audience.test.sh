#!/bin/bash
# ralph/hooks/scripts/__tests__/hero-classify-audience.test.sh
# Regression guard for GH-1479.
#
# Asserts the AUTONOMOUS queue-read call site in the hero skill passes
# audience: "agent" — not the bare next_actions({}) human default that
# silently drops the XS/S estimate penalty and the Backlog/null-state
# triage fallback (directions.ts audiencePenalty + the agent-only
# scored.length === 0 branch).
#
# The tool behavior is already covered by mcp-server directions.test.ts;
# this guards the *consumer* (hero --mode classify, the engine of
# --mode auto) so the call site cannot silently regress to the human
# default again (the #1159 regression this issue fixes).
#
# Strategy: grep structural invariants over ralph/skills/hero/SKILL.md.
# The default-mode picker call site legitimately keeps next_actions({})
# (it feeds an interactive AskUserQuestion), so the negative assertion is
# SCOPED to the "## --mode classify" section rather than the whole file.

set -euo pipefail

PASS=0
FAIL=0

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
SKILL_FILE="${REPO_ROOT}/ralph/skills/hero/SKILL.md"

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

# Extract the body of the "## --mode classify" section (lines after the
# header, up to but not including the next "## " heading).
classify_block() {
  awk '
    /^## --mode classify/ { f=1; next }
    /^## / { f=0 }
    f
  ' "$SKILL_FILE"
}

echo "=== hero-classify-audience regression guard (GH-1479) ==="
echo ""

# -----------------------------------------------------------------------
echo "--- Assertion 1: skill file exists ---"
if [[ -s "$SKILL_FILE" ]]; then
  pass "hero SKILL.md exists and is non-empty"
else
  fail "hero SKILL.md missing or empty: $SKILL_FILE"
fi

# -----------------------------------------------------------------------
echo ""
echo "--- Assertion 2: autonomous call site passes audience: agent ---"
assert_file_contains "SKILL.md contains next_actions({ audience: \"agent\" })" \
  "$SKILL_FILE" 'next_actions({ audience: "agent" })'

# -----------------------------------------------------------------------
echo ""
echo "--- Assertion 3: the agent-audience call lives in the --mode classify section ---"
BLOCK="$(classify_block)"
if printf '%s\n' "$BLOCK" | grep -qF 'next_actions({ audience: "agent" })'; then
  pass "--mode classify section reads the queue with audience: agent"
else
  fail "--mode classify section does NOT request audience: agent (regressed to human default?)"
fi

# -----------------------------------------------------------------------
echo ""
echo "--- Assertion 4: --mode classify section has no bare next_actions({}) ---"
# Negative guard: the autonomous path must not be the human default.
# Scoped to the classify block — the default-mode picker keeps the bare
# call legitimately, so a whole-file check would be wrong.
if printf '%s\n' "$BLOCK" | grep -qF 'next_actions({})'; then
  fail "--mode classify section still has a bare next_actions({}) (human-default regression)"
else
  pass "--mode classify section has no bare next_actions({})"
fi

# -----------------------------------------------------------------------
echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
