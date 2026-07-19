#!/bin/bash
# ralph/hooks/scripts/__tests__/impl-plan-required.test.sh
# Tests for the plan-required gate, including GH-1564's path-derived rooting
# migration (resolve_root_from_path instead of get_project_root).
#
# Strategy: invoke the hook with crafted PreToolUse:Write JSON on stdin inside
# sandboxes (CLAUDE_PROJECT_DIR override, plus RALPH_COMMAND/RALPH_TICKET_ID as
# the hook itself requires) so rooting resolves deterministically, and assert
# exit codes:
#   0 = allowed (early-allow, not required, or plan doc found)
#   2 = blocked (plan required, none found)

set -euo pipefail

HOOK="$(cd "$(dirname "$0")/.." && pwd)/impl-plan-required.sh"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# Sandbox project root (CLAUDE_PROJECT_DIR stand-in). No .git marker here on
# purpose for most cases below — SBX plays the "unrelated workspace root" role.
SBX="$(mktemp -d)"
# Distinct repo tree for the path-derived rooting repro.
REPO="$(mktemp -d)"
# Tree with NO .git ancestor, to exercise the env fallback.
NOGIT="$(mktemp -d)"
trap 'rm -rf "$SBX" "$REPO" "$NOGIT"' EXIT

mkdir -p "$SBX/thoughts/shared/plans" "$SBX/src"
# Fixture plan doc under SBX — matches ticket GH-1 only (fallback-preserved case).
touch "$SBX/thoughts/shared/plans/2026-05-24-GH-1-plan.md"

mkdir -p "$REPO/.git" "$REPO/thoughts/shared/plans" "$REPO/src"
# Fixture plan doc under REPO — matches ticket GH-9 only.
touch "$REPO/thoughts/shared/plans/2026-07-19-GH-9-plan.md"

mkdir -p "$NOGIT/src"

# run_case <desc> <expected_exit> <file_path> [ENV=val ...]
#
# Runs from $NOGIT as CWD (a plain mktemp path with no "GH-NNN" substring) so
# the hook's CWD-grep ticket_id fallback (used when RALPH_TICKET_ID is unset)
# can't accidentally pick up an ID leaked from wherever this test file itself
# happens to be checked out (e.g. a worktree path literally named GH-<n>).
run_case() {
  local desc="$1" expected="$2" fp="$3"; shift 3
  local json actual
  json=$(jq -n --arg fp "$fp" '{tool_input: {file_path: $fp}}')
  set +e
  (cd "$NOGIT" && CLAUDE_PROJECT_DIR="$SBX" env "$@" bash "$HOOK") <<<"$json" >/dev/null 2>&1
  actual=$?
  set -e
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc (exit $actual)"
  else
    fail "$desc — expected exit $expected, got $actual"
  fi
}

echo "=== impl-plan-required gate tests ==="
echo ""

# --- Early-allow paths ---------------------------------------------------------
run_case "RALPH_COMMAND != impl allows (other verbs don't gate)" 0 \
  "$REPO/src/foo.ts" RALPH_COMMAND=plan RALPH_TICKET_ID=GH-9
run_case "/thoughts/ path allows (non-code file)" 0 \
  "$REPO/thoughts/shared/plans/notes.md" RALPH_COMMAND=impl RALPH_TICKET_ID=GH-9
run_case "/docs/ path allows (non-code file)" 0 \
  "$REPO/docs/readme.md" RALPH_COMMAND=impl RALPH_TICKET_ID=GH-9
run_case "RALPH_REQUIRES_PLAN=false allows" 0 \
  "$REPO/src/foo.ts" RALPH_COMMAND=impl RALPH_TICKET_ID=GH-9 RALPH_REQUIRES_PLAN=false
# NOTE: a "no ticket_id resolvable anywhere" case is intentionally not covered
# here. The hook's CWD-grep fallback (line ~36) crashes under set -euo
# pipefail when grep finds no match in CWD — a pre-existing bug unrelated to
# this migration's root-resolution scope. Filed as a follow-up; see GH-1564.

# --- Path-derived rooting (GH-1564) ---------------------------------------------
# Workspace-root repro: CLAUDE_PROJECT_DIR points at $SBX (unrelated, no GH-9
# plan there), but the target file lives in $REPO which has the GH-9 plan doc.
# The hook must root off the file path, not the session env — expect allow.
run_case "target file's repo root wins over CLAUDE_PROJECT_DIR (workspace-root repro)" 0 \
  "$REPO/src/foo.ts" RALPH_COMMAND=impl RALPH_TICKET_ID=GH-9

# Fallback-preserved control: target file has no .git ancestor anywhere on its
# path; the GH-1 plan doc DOES exist under $SBX (CLAUDE_PROJECT_DIR) — the walk
# exhausts and falls back to get_project_root(), preserving old behavior.
run_case "no .git ancestor + doc under CLAUDE_PROJECT_DIR allows (fallback-preserved)" 0 \
  "$NOGIT/src/foo.ts" RALPH_COMMAND=impl RALPH_TICKET_ID=GH-1

# Fallback negative control: same NOGIT file_path, ticket with no matching plan
# doc anywhere — must still block via the CLAUDE_PROJECT_DIR fallback root.
run_case "no .git ancestor + no matching plan blocks (fallback negative control)" 2 \
  "$NOGIT/src/foo.ts" RALPH_COMMAND=impl RALPH_TICKET_ID=GH-404

# --- Plan Reference path (GH-1564 Check 4, also path-derived) -------------------
# No direct/group/stream plan doc for GH-405 anywhere, but RALPH_PLAN_REFERENCE
# points at a blob URL whose local_path resolves under $REPO's own tree. The
# check must also root off the target file's own repo, not CLAUDE_PROJECT_DIR.
touch "$REPO/thoughts/shared/plans/2026-07-19-GH-405-referenced-plan.md"
run_case "Plan Reference existence check roots off file's own repo" 0 \
  "$REPO/src/foo.ts" RALPH_COMMAND=impl RALPH_TICKET_ID=GH-405 \
  RALPH_PLAN_REFERENCE="https://github.com/o/r/blob/main/thoughts/shared/plans/2026-07-19-GH-405-referenced-plan.md"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
