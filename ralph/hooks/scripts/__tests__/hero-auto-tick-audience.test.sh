#!/bin/bash
# ralph/hooks/scripts/__tests__/hero-auto-tick-audience.test.sh
# Regression guard for GH-1479 (re-anchored for GH-1606).
#
# Asserts the AUTONOMOUS queue-read call site in the hero skill passes
# audience: "agent" — not the bare next_actions({}) human default that
# silently drops the XS/S estimate penalty and the Backlog/null-state
# triage fallback (directions.ts audiencePenalty + the agent-only
# scored.length === 0 branch).
#
# The tool behavior is already covered by mcp-server directions.test.ts;
# this guards the *consumer* (the hero auto tick, the engine of
# --mode auto) so the call site cannot silently regress to the human
# default again (the #1159 regression this issue fixes).
#
# Strategy: grep structural invariants over the hero skill's Auto tick
# content. The default-mode picker call site legitimately keeps
# next_actions({}) (it feeds an interactive AskUserQuestion), so the
# negative assertion is SCOPED to the "## Auto tick" section rather than
# the whole surface.
# GH-1606 folded the former director-only classify mode into the internal
# `--tick` step of `--mode auto`; the section heading moved from the old
# classify mode heading to
# "## Auto tick (internal — dispatched only by --mode auto's loop wrapper)".
# GH-1603 address-mode pass moved "## --mode auto" + "## Auto tick" out of
# SKILL.md into the sibling ralph/skills/hero/auto-tick.md (SKILL.md was
# over the ~200-line dispatch-and-skeleton convention in ralph/CLAUDE.md) —
# the Auto tick section, and this test's target file, now live there.
#
# HARNESS NOTE (deliberate, do not "fix"): this file uses NO SBX/REPO/NOGIT
# sandbox and no run_case, because it invokes no hook. It makes structural
# grep assertions over live skill markdown — it never executes a *.sh gate,
# never feeds JSON on stdin, and never exercises resolve_root_from_path. The
# plan-research-required.test.sh harness exists specifically for hooks that
# resolve artifacts from tool_input.file_path, which is what ralph/CLAUDE.md
# scopes that convention to. Same category, and same precedent, as
# caretake-watch.test.sh (whose identical migration request was rejected on
# this PR for exactly this reason) and scripts/check-doc-rosters.sh. A sandbox
# here would add a temp dir and a copy step that nothing in the test reads.

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

# Extract the body of the "## Auto tick ..." section (lines after the
# header, up to but not including the next "## " heading). The start
# pattern is anchored to the literal heading prefix so a future sibling
# heading cannot prefix-match and fold its body into the block (which
# would latently false-pass assertions 3/4).
tick_block() {
  awk '
    /^## Auto tick \(internal/ { f=1; next }
    /^## / { f=0 }
    f
  ' "$TICK_FILE"
}

echo "=== hero-auto-tick-audience regression guard (GH-1479 / re-anchored GH-1606) ==="
echo ""

# -----------------------------------------------------------------------
echo "--- Assertion 1: skill file + auto-tick sibling exist ---"
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
echo "--- Assertion 3: the agent-audience call lives in the Auto tick section ---"
BLOCK="$(tick_block)"
if printf '%s\n' "$BLOCK" | grep -qF 'next_actions({ audience: "agent" })'; then
  pass "Auto tick section reads the queue with audience: agent"
else
  fail "Auto tick section does NOT request audience: agent (regressed to human default?)"
fi

# -----------------------------------------------------------------------
echo ""
echo "--- Assertion 4: Auto tick section has no bare next_actions({}) ---"
# Negative guard: the autonomous path must not be the human default.
# Scoped to the tick block — the default-mode picker keeps the bare
# call legitimately, so a whole-file check would be wrong.
if printf '%s\n' "$BLOCK" | grep -qF 'next_actions({})'; then
  fail "Auto tick section still has a bare next_actions({}) (human-default regression)"
else
  pass "Auto tick section has no bare next_actions({})"
fi

# -----------------------------------------------------------------------
echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
