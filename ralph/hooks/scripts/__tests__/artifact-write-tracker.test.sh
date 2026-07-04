#!/usr/bin/env bash
# ralph/hooks/scripts/__tests__/artifact-write-tracker.test.sh
# Tests for the session-scoped artifact recorder (PostToolUse Write|Edit).
#
# Strategy: sandbox TMPDIR so ralph_session_dir lands in the test dir, feed
# crafted PostToolUse JSON on stdin, and assert list contents + exit codes.

set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$HOOK_DIR/artifact-write-tracker.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

SBX="$(mktemp -d)"
trap 'rm -rf "$SBX"' EXIT
mkdir -p "$SBX/tmp" "$SBX/proj"

# run_hook <session_id> <file_path>
run_hook() {
  local sid="$1" fp="$2"
  jq -n --arg sid "$sid" --arg fp "$fp" \
    '{session_id: $sid, tool_input: {file_path: $fp}}' \
    | env TMPDIR="$SBX/tmp" RALPH_HOOK_INPUT= CLAUDE_PROJECT_DIR="$SBX/proj" \
        bash "$HOOK" >/dev/null 2>&1
}

list_for() {
  echo "$SBX/tmp/ralph-session-$1/artifacts.list"
}

echo "=== artifact-write-tracker tests ==="
echo ""

# --- Records matching paths ----------------------------------------------------
run_hook s1 "/abs/thoughts/shared/research/2026-07-04-GH-1-x.md"
if grep -qxF "/abs/thoughts/shared/research/2026-07-04-GH-1-x.md" "$(list_for s1)" 2>/dev/null; then
  pass "records absolute research path"
else
  fail "records absolute research path"
fi

run_hook s1 "/abs/thoughts/shared/plans/2026-07-04-GH-2-p.md"
run_hook s1 "/abs/thoughts/shared/reviews/2026-07-04-GH-2-critique.md"
if [[ "$(wc -l < "$(list_for s1)" | xargs)" == "3" ]]; then
  pass "records plans and reviews paths too (3 total)"
else
  fail "records plans and reviews paths too — expected 3 lines, got $(wc -l < "$(list_for s1)" | xargs)"
fi

# --- Dedup -----------------------------------------------------------------------
run_hook s1 "/abs/thoughts/shared/research/2026-07-04-GH-1-x.md"
if [[ "$(wc -l < "$(list_for s1)" | xargs)" == "3" ]]; then
  pass "repeated write of same path dedups"
else
  fail "repeated write of same path dedups — got $(wc -l < "$(list_for s1)" | xargs) lines"
fi

# --- Relative path normalized to project root ------------------------------------
run_hook s1 "thoughts/shared/research/2026-07-04-GH-3-rel.md"
if grep -qxF "$SBX/proj/thoughts/shared/research/2026-07-04-GH-3-rel.md" "$(list_for s1)"; then
  pass "relative path normalized against CLAUDE_PROJECT_DIR"
else
  fail "relative path normalized against CLAUDE_PROJECT_DIR"
fi

# --- Ignores non-artifact paths ---------------------------------------------------
run_hook s1 "/abs/src/index.ts"
run_hook s1 "/abs/thoughts/shared/research/notes.txt"
run_hook s1 "/abs/thoughts/local/2026-07-04-x.md"
if [[ "$(wc -l < "$(list_for s1)" | xargs)" == "4" ]]; then
  pass "non-artifact paths (code, non-md, thoughts/local) ignored"
else
  fail "non-artifact paths ignored — got $(wc -l < "$(list_for s1)" | xargs) lines"
fi

# --- Session isolation -------------------------------------------------------------
run_hook s2 "/abs/thoughts/shared/research/2026-07-04-GH-9-other.md"
if [[ -f "$(list_for s2)" ]] && ! grep -q "GH-9" "$(list_for s1)"; then
  pass "different session_id writes to a different list"
else
  fail "different session_id writes to a different list"
fi

# --- Never blocks -------------------------------------------------------------------
if jq -n '{session_id: "s3", tool_input: {}}' \
    | env TMPDIR="$SBX/tmp" RALPH_HOOK_INPUT= CLAUDE_PROJECT_DIR="$SBX/proj" \
        bash "$HOOK" >/dev/null 2>&1; then
  pass "missing file_path exits 0"
else
  fail "missing file_path exits 0"
fi

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
