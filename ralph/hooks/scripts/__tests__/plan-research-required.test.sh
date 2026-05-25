#!/bin/bash
# ralph/hooks/scripts/__tests__/plan-research-required.test.sh
# Tests for the estimate-aware plan-research-required.sh gate.
#
# Strategy: invoke the hook with crafted PreToolUse:Write JSON on stdin inside a
# TMPDIR sandbox (CLAUDE_PROJECT_DIR override) so get_project_root /
# find_existing_artifact resolve deterministically, and assert exit codes:
#   0 = allowed (early-allow, waiver, or research-exists)
#   2 = blocked (research required)

set -euo pipefail

HOOK="$(cd "$(dirname "$0")/.." && pwd)/plan-research-required.sh"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# Sandbox project root. research/ stays empty except for the one fixture below.
SBX="$(mktemp -d)"
trap 'rm -rf "$SBX"' EXIT
mkdir -p "$SBX/thoughts/shared/research" "$SBX/thoughts/shared/plans" "$SBX/src"
# Fixture research doc — matches ticket GH-1 only.
touch "$SBX/thoughts/shared/research/2026-05-24-GH-1-research.md"

# run_case <desc> <expected_exit> <file_path> <content> [ENV=val ...]
run_case() {
  local desc="$1" expected="$2" fp="$3" content="$4"; shift 4
  local json actual
  json=$(jq -n --arg fp "$fp" --arg c "$content" \
    '{tool_input: {file_path: $fp, content: $c}}')
  set +e
  CLAUDE_PROJECT_DIR="$SBX" env "$@" bash "$HOOK" <<<"$json" >/dev/null 2>&1
  actual=$?
  set -e
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc (exit $actual)"
  else
    fail "$desc — expected exit $expected, got $actual"
  fi
}

PLANS="$SBX/thoughts/shared/plans"

echo "=== plan-research-required gate tests ==="
echo ""

# --- Early-allow paths ---------------------------------------------------------
run_case "non-/plans/ path allows" 0 \
  "$SBX/src/notes.md" $'---\nestimate: M\n---'
run_case "/plans/ path with no GH token allows" 0 \
  "$PLANS/2026-05-24-adhoc.md" $'---\nestimate: M\n---'
run_case "research doc exists allows (even at M)" 0 \
  "$PLANS/2026-05-24-GH-1-x.md" $'---\nestimate: M\n---'
run_case "RALPH_REQUIRES_RESEARCH=false allows" 0 \
  "$PLANS/2026-05-24-GH-2-x.md" $'---\nestimate: M\n---' RALPH_REQUIRES_RESEARCH=false

# --- Estimate-threshold waiver (default threshold M) ---------------------------
run_case "estimate S below default M allows" 0 \
  "$PLANS/2026-05-24-GH-2-x.md" $'---\nestimate: S\n---'
run_case "estimate M at default threshold blocks" 2 \
  "$PLANS/2026-05-24-GH-2-x.md" $'---\nestimate: M\n---'

# --- Human-override waiver -----------------------------------------------------
run_case "research_waived present allows (even at M)" 0 \
  "$PLANS/2026-05-24-GH-2-x.md" $'---\nestimate: M\nresearch_waived: human-approved\n---'

# --- Threshold override --------------------------------------------------------
run_case "MIN=S + estimate S blocks (threshold raised)" 2 \
  "$PLANS/2026-05-24-GH-2-x.md" $'---\nestimate: S\n---' RALPH_RESEARCH_REQUIRED_MIN_ESTIMATE=S
run_case "MIN=S + estimate XS allows" 0 \
  "$PLANS/2026-05-24-GH-2-x.md" $'---\nestimate: XS\n---' RALPH_RESEARCH_REQUIRED_MIN_ESTIMATE=S

# --- Safe-default block --------------------------------------------------------
run_case "no estimate + no waiver + no research blocks" 2 \
  "$PLANS/2026-05-24-GH-2-x.md" $'---\ndate: 2026-05-24\ntype: plan\n---'

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
