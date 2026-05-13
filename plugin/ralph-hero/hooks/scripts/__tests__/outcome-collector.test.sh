#!/usr/bin/env bash
# Tests for outcome-collector.sh
# Run: bash plugin/ralph-hero/hooks/scripts/__tests__/outcome-collector.test.sh
#
# Regression coverage for GH-1134 — `grep -c PATTERN FILE || echo 0` produced
# a two-line "0\n0" string that broke `jq --argjson` on plan-of-plans (no
# `## Phase ` headers) and research docs lacking `### Will Modify`/`### Will Read`
# sections. The hook should now exit 0 and emit no jq error for these inputs.

set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/outcome-collector.sh"
TEST_DIR="$(mktemp -d)"
trap "rm -rf $TEST_DIR" EXIT

# Isolate the knowledge DB so tests do not touch the user's real DB
export RALPH_KNOWLEDGE_DB="$TEST_DIR/knowledge.db"

PASS=0
FAIL=0

assert_eq() {
  local expected="$1"
  local actual="$2"
  local msg="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "  PASS: $msg"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $msg"
    echo "    expected: $expected"
    echo "    actual:   $actual"
  fi
}

assert_not_contains() {
  local needle="$1"
  local haystack="$2"
  local msg="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    FAIL=$((FAIL + 1))
    echo "  FAIL: $msg"
    echo "    found unexpected substring: $needle"
    echo "    in: $haystack"
  else
    PASS=$((PASS + 1))
    echo "  PASS: $msg"
  fi
}

echo "Testing $SCRIPT"
echo "Test dir: $TEST_DIR"

# Set up a fake thoughts tree under the temp dir (the hook only processes
# paths that match */thoughts/shared/plans/* or */thoughts/shared/research/*).
PLANS_DIR="$TEST_DIR/thoughts/shared/plans"
RESEARCH_DIR="$TEST_DIR/thoughts/shared/research"
mkdir -p "$PLANS_DIR" "$RESEARCH_DIR"

# ---------------------------------------------------------------------------
# Test case 1: plan-of-plans (no `## Phase ` headers) — GH-1134 repro
# ---------------------------------------------------------------------------
echo
echo "Test case 1: plan-of-plans with no '## Phase ' headers (GH-1134)"
POP="$PLANS_DIR/2026-05-07-GH-9999-pop-test.md"
cat > "$POP" <<'PLAN'
# Plan-of-plans with no phase headers, just workstreams
| Workstream | Issue |
|---|---|
| A | #1 |
PLAN

OUTPUT=$(echo "{\"tool_input\":{\"file_path\":\"$POP\"},\"tool_name\":\"Write\"}" \
  | "$SCRIPT" 2>&1)
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "plan-of-plans: exit 0"
assert_not_contains "invalid JSON text passed to --argjson" "$OUTPUT" \
  "plan-of-plans: no jq --argjson error"

# ---------------------------------------------------------------------------
# Test case 2: plan with `## Phase ` headers but no bullet lines
# ---------------------------------------------------------------------------
echo
echo "Test case 2: plan with '## Phase ' headers but no bullets"
PHASE_ONLY="$PLANS_DIR/2026-05-07-GH-9998-phase-only.md"
cat > "$PHASE_ONLY" <<'PLAN'
# Phases only, no bullets
## Phase 1: Setup
Some prose, no bullet lines.
## Phase 2: Implement
More prose.
PLAN

OUTPUT=$(echo "{\"tool_input\":{\"file_path\":\"$PHASE_ONLY\"},\"tool_name\":\"Write\"}" \
  | "$SCRIPT" 2>&1)
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "phase-only plan: exit 0"
assert_not_contains "invalid JSON text passed to --argjson" "$OUTPUT" \
  "phase-only plan: no jq --argjson error"

# ---------------------------------------------------------------------------
# Test case 3: real plan with phases and bullets (positive case)
# ---------------------------------------------------------------------------
echo
echo "Test case 3: real plan with phases and bullets"
REAL_PLAN="$PLANS_DIR/2026-05-07-GH-9997-real-plan.md"
cat > "$REAL_PLAN" <<'PLAN'
# Real plan

## Phase 1: Setup
- file/one.ts
- file/two.ts

## Phase 2: Implement
- file/three.ts
PLAN

OUTPUT=$(echo "{\"tool_input\":{\"file_path\":\"$REAL_PLAN\"},\"tool_name\":\"Write\"}" \
  | "$SCRIPT" 2>&1)
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "real plan: exit 0"
assert_not_contains "invalid JSON text passed to --argjson" "$OUTPUT" \
  "real plan: no jq --argjson error"

# ---------------------------------------------------------------------------
# Test case 4: research doc with no '### Will Modify' / '### Will Read' sections
# ---------------------------------------------------------------------------
echo
echo "Test case 4: research doc with no Will Modify/Will Read sections (GH-1134)"
RESEARCH_NO_SECTIONS="$RESEARCH_DIR/2026-05-07-GH-9996-research.md"
cat > "$RESEARCH_NO_SECTIONS" <<'RESEARCH'
# Research without standard sections
Some discovery prose with no Will Modify or Will Read headers.
RESEARCH

OUTPUT=$(echo "{\"tool_input\":{\"file_path\":\"$RESEARCH_NO_SECTIONS\"},\"tool_name\":\"Write\"}" \
  | "$SCRIPT" 2>&1)
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "research without sections: exit 0"
assert_not_contains "invalid JSON text passed to --argjson" "$OUTPUT" \
  "research without sections: no jq --argjson error"

# ---------------------------------------------------------------------------
# Test case 5: research doc with both sections (positive case)
# ---------------------------------------------------------------------------
echo
echo "Test case 5: research doc with Will Modify/Will Read sections"
RESEARCH_FULL="$RESEARCH_DIR/2026-05-07-GH-9995-research-full.md"
cat > "$RESEARCH_FULL" <<'RESEARCH'
# Research with file sections

### Will Modify
- `path/to/file-one.ts`
- `path/to/file-two.ts`

### Will Read
- `path/to/file-three.ts`
RESEARCH

OUTPUT=$(echo "{\"tool_input\":{\"file_path\":\"$RESEARCH_FULL\"},\"tool_name\":\"Write\"}" \
  | "$SCRIPT" 2>&1)
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "research with sections: exit 0"
assert_not_contains "invalid JSON text passed to --argjson" "$OUTPUT" \
  "research with sections: no jq --argjson error"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
