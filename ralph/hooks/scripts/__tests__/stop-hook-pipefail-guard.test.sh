#!/usr/bin/env bash
# ralph/hooks/scripts/__tests__/stop-hook-pipefail-guard.test.sh
#
# Regression: Stop hooks must never abort silently (rc=1, empty stderr) when
# the thoughts/shared/* artifact dirs are missing under the project root.
#
# Mechanism of the bug: `doc=$(find "$dir" … 2>/dev/null | head -1)` under
# `set -euo pipefail`. `find` on a missing dir exits 1 (stderr suppressed),
# pipefail propagates the 1 through `head`, the failing command substitution
# fails the assignment, and `set -e` kills the script with exit 1 and nothing
# on stderr. Skill-frontmatter Stop hooks stay registered for the rest of the
# session, so interactive /ralph:research + /ralph:plan sessions in any repo
# without the full thoughts/ layout hit this on EVERY Stop.
#
# hook-utils.sh's find_existing_artifact/find_fresh_artifact guard this with
# `|| true`; these tests pin the same contract onto the Stop hooks.
#
# Run: bash ralph/hooks/scripts/__tests__/stop-hook-pipefail-guard.test.sh

set -uo pipefail

HOOK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

STOP_JSON='{"hook_event_name":"Stop","stop_hook_active":false,"transcript_path":"/nonexistent/t.jsonl"}'
STDERR_FILE="$TEST_DIR/stderr.txt"

PASS=0
FAIL=0
assert_eq() {
  if [ "$1" = "$2" ]; then PASS=$((PASS+1)); echo "  PASS: $3";
  else FAIL=$((FAIL+1)); echo "  FAIL: $3"; echo "    expected: $1"; echo "    actual:   $2"; fi
}
assert_contains() {
  if grep -q "$1" "$2" 2>/dev/null; then PASS=$((PASS+1)); echo "  PASS: $3";
  else FAIL=$((FAIL+1)); echo "  FAIL: $3"; echo "    expected stderr to contain: $1"; fi
}

# run_hook <script> <project_dir>          (no ticket env)
run_hook() {
  printf '%s' "$STOP_JSON" \
    | env -u RALPH_TICKET_ID RALPH_COMMAND=plan RALPH_HOOK_INPUT= \
        CLAUDE_PROJECT_DIR="$2" bash "$HOOK_DIR/$1" >/dev/null 2>"$STDERR_FILE"
  echo $?
}

# run_hook_ticket <script> <project_dir> <ticket>
run_hook_ticket() {
  printf '%s' "$STOP_JSON" \
    | env RALPH_TICKET_ID="$3" RALPH_COMMAND=plan RALPH_HOOK_INPUT= \
        CLAUDE_PROJECT_DIR="$2" bash "$HOOK_DIR/$1" >/dev/null 2>"$STDERR_FILE"
  echo $?
}

echo "== interactive Stop (no ticket) in a project with NO thoughts/ layout =="
EMPTY_PROJ="$TEST_DIR/empty-proj"
mkdir -p "$EMPTY_PROJ"

ec=$(run_hook doc-structure-validator.sh "$EMPTY_PROJ")
assert_eq "0" "$ec" "doc-structure-validator exits 0 when all artifact dirs are missing"

ec=$(run_hook research-postcondition.sh "$EMPTY_PROJ")
assert_eq "0" "$ec" "research-postcondition exits 0 without RALPH_TICKET_ID"

ec=$(run_hook plan-postcondition.sh "$EMPTY_PROJ")
assert_eq "0" "$ec" "plan-postcondition exits 0 without RALPH_TICKET_ID"

echo
echo "== partial thoughts/ layout: only research dir exists, with a fresh valid doc =="
PARTIAL_PROJ="$TEST_DIR/partial-proj"
mkdir -p "$PARTIAL_PROJ/thoughts/shared/research"
TODAY=$(date +%Y-%m-%d)
cat > "$PARTIAL_PROJ/thoughts/shared/research/${TODAY}-test-topic.md" <<'EOF'
## Research Question

How does the thing work?

## Summary

It works via `src/thing.ts`.

## Files Affected

### Will Modify
- `src/thing.ts`

### Will Read (Dependencies)
- `src/other.ts`
EOF

# Must not die on the missing plans/ and reviews/ dirs before reaching the
# research dir, and the valid doc must pass structure validation.
ec=$(run_hook doc-structure-validator.sh "$PARTIAL_PROJ")
assert_eq "0" "$ec" "doc-structure-validator validates research doc despite missing plans/reviews dirs"

echo
echo "== auto flow (ticket set) with missing artifact dirs: block loudly, not crash silently =="
ec=$(run_hook_ticket research-postcondition.sh "$EMPTY_PROJ" "GH-1234")
assert_eq "2" "$ec" "research-postcondition blocks (rc=2) when ticket set but no doc/dir"
assert_contains "Research postcondition failed" "$STDERR_FILE" "research-postcondition block has an actionable stderr message"

ec=$(run_hook_ticket plan-postcondition.sh "$EMPTY_PROJ" "GH-1234")
assert_eq "2" "$ec" "plan-postcondition blocks (rc=2) when ticket set but no doc/dir"
assert_contains "Plan postcondition failed" "$STDERR_FILE" "plan-postcondition block has an actionable stderr message"

echo
echo "== find_existing_artifact (hook-utils) tolerates a missing artifact dir under set -euo pipefail =="
ec=$(bash -c '
  set -euo pipefail
  source "'"$HOOK_DIR"'/hook-utils.sh"
  result=$(find_existing_artifact "'"$EMPTY_PROJ"'/thoughts/shared/plans" "GH-1234")
  [[ -z "$result" ]]
' 2>"$STDERR_FILE"; echo $?)
assert_eq "0" "$ec" "find_existing_artifact returns empty (rc=0) on missing dir instead of aborting"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
