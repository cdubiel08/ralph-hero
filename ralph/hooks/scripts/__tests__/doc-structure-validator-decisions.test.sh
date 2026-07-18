#!/usr/bin/env bash
# ralph/hooks/scripts/__tests__/doc-structure-validator-decisions.test.sh
# Decisions-contract enforcement (GH-1544): every session-written plan doc
# must carry `## Design Decisions & Open Ambiguities` with EITHER >=1
# `#### Decision:` block OR the literal sentinel, on the fence-stripped
# body — for both the regular and plan-of-plans shapes.

set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$HOOK_DIR/doc-structure-validator.sh"
TODAY=$(date +%Y-%m-%d)

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

SBX="$(mktemp -d)"
trap 'rm -rf "$SBX"' EXIT
mkdir -p "$SBX/tmp" "$SBX/proj/thoughts/shared/plans"

record() {
  mkdir -p "$SBX/tmp/ralph-session-$1"
  echo "$2" >> "$SBX/tmp/ralph-session-$1/artifacts.list"
}

run_hook() {
  local json
  json=$(jq -n --arg sid "$1" '{session_id: $sid, stop_hook_active: false}')
  set +e
  printf '%s' "$json" \
    | env TMPDIR="$SBX/tmp" RALPH_HOOK_INPUT= CLAUDE_PROJECT_DIR="$SBX/proj" \
        bash "$HOOK" >/dev/null 2>&1
  local ec=$?
  set -e
  echo "$ec"
}

# run_case <session> <filename> <content> <expected> <desc>
run_case() {
  local sid="$1" fname="$2" content="$3" expected="$4" desc="$5"
  local doc="$SBX/proj/thoughts/shared/plans/${TODAY}-${fname}"
  printf '%s' "$content" > "$doc"
  record "$sid" "$doc"
  local ec
  ec=$(run_hook "$sid")
  if [[ "$ec" == "$expected" ]]; then
    pass "$desc (exit $ec)"
  else
    fail "$desc — expected exit $expected, got $ec"
  fi
}

PLAN_TAIL=$'\n\n## Phase 1: Do it\n\n#### Automated Verification\n\n- [ ] tests pass'
SECTION_SENTINEL=$'## Design Decisions & Open Ambiguities\n\nNone — no open design decisions.'
SECTION_BLOCK=$'## Design Decisions & Open Ambiguities\n\n#### Decision: park location\n\n- **Context**: where held plans wait\n- **Options**:\n  1. Plan in Review + comment *(agent recommendation)*\n  2. Human Needed\n- **Recommendation**: option 1\n- **Blocked without it**: Phase 2 review routing'
SECTION_FENCED=$'```markdown\n## Design Decisions & Open Ambiguities\n\nNone — no open design decisions.\n```'

POP_HEAD=$'---\ntype: plan-of-plans\n---\n\n## Feature Decomposition\n\n### Feature A\n\n## Feature Sequencing\n\nA first.'

echo "=== doc-structure-validator decisions-contract tests ==="
echo ""

# --- Regular plan shape --------------------------------------------------------
run_case d-missing "GH-1-missing.md" "# P${PLAN_TAIL}" 2 \
  "regular plan missing the decisions section blocks"
run_case d-sentinel "GH-2-sentinel.md" "# P

${SECTION_SENTINEL}${PLAN_TAIL}" 0 \
  "regular plan with sentinel passes"
run_case d-block "GH-3-block.md" "# P

${SECTION_BLOCK}${PLAN_TAIL}" 0 \
  "regular plan with a #### Decision: block and no sentinel passes"
run_case d-fenced "GH-4-fenced.md" "# P

${SECTION_FENCED}${PLAN_TAIL}" 2 \
  "section only inside a fenced example blocks (fence-strip respected)"
run_case d-empty "GH-5-empty.md" "# P

## Design Decisions & Open Ambiguities

Some prose but neither a Decision block nor the sentinel.${PLAN_TAIL}" 2 \
  "section present but with neither block nor sentinel blocks"

# --- Plan-of-plans shape -------------------------------------------------------
run_case d-pop-missing "GH-6-pop-missing.md" "${POP_HEAD}" 2 \
  "plan-of-plans missing the decisions section blocks"
run_case d-pop-sentinel "GH-7-pop-sentinel.md" "${POP_HEAD}

${SECTION_SENTINEL}" 0 \
  "plan-of-plans with sentinel passes"
run_case d-pop-block "GH-8-pop-block.md" "${POP_HEAD}

${SECTION_BLOCK}" 0 \
  "plan-of-plans with a #### Decision: block passes"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
