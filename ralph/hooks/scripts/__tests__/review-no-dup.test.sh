#!/bin/bash
# ralph/hooks/scripts/__tests__/review-no-dup.test.sh
# Tests for the duplicate-critique gate, including GH-1564's path-derived
# rooting migration (resolve_root_from_path instead of get_project_root).
#
# Strategy: invoke the hook with crafted PreToolUse:Write JSON on stdin inside
# sandboxes (CLAUDE_PROJECT_DIR override) so rooting resolves deterministically,
# and assert exit codes:
#   0 = allowed (early-allow or no duplicate found)
#   2 = blocked (duplicate critique exists)

set -euo pipefail

HOOK="$(cd "$(dirname "$0")/.." && pwd)/review-no-dup.sh"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# Sandbox project root (CLAUDE_PROJECT_DIR stand-in).
SBX="$(mktemp -d)"
# Distinct repo tree for the path-derived rooting repro.
REPO="$(mktemp -d)"
# Tree with NO .git ancestor, to exercise the env fallback.
NOGIT="$(mktemp -d)"
trap 'rm -rf "$SBX" "$REPO" "$NOGIT"' EXIT

mkdir -p "$SBX/thoughts/shared/reviews" "$SBX/src"
# Stray critique under SBX for GH-9 — deliberately present so the workspace-root
# repro case would false-block if it (wrongly) rooted off CLAUDE_PROJECT_DIR
# instead of the target file's own repo.
touch "$SBX/thoughts/shared/reviews/2026-05-24-GH-9-critique.md"
# Fixture critique under SBX for GH-1 — used by the fallback-preserved case.
touch "$SBX/thoughts/shared/reviews/2026-05-24-GH-1-critique.md"

mkdir -p "$REPO/.git" "$REPO/thoughts/shared/reviews"
mkdir -p "$NOGIT/thoughts/shared/reviews"

# run_case <desc> <expected_exit> <file_path>
run_case() {
  local desc="$1" expected="$2" fp="$3"
  local json actual
  json=$(jq -n --arg fp "$fp" '{tool_input: {file_path: $fp}}')
  set +e
  CLAUDE_PROJECT_DIR="$SBX" bash "$HOOK" <<<"$json" >/dev/null 2>&1
  actual=$?
  set -e
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc (exit $actual)"
  else
    fail "$desc — expected exit $expected, got $actual"
  fi
}

echo "=== review-no-dup gate tests ==="
echo ""

# --- Early-allow paths ---------------------------------------------------------
run_case "non-reviews/ path allows" 0 \
  "$SBX/src/notes.md"
# NOTE: a "reviews/ path with no GH token" case is intentionally not covered
# here. The hook's ticket_id regex extraction (line ~20, `grep -oE 'GH-[0-9]+'`
# with no `|| true`) crashes under set -euo pipefail when grep finds no match —
# a pre-existing bug unrelated to this migration's root-resolution scope. Same
# class as impl-plan-required.sh's CWD-grep fallback bug; filed as a follow-up.

# --- Path-derived rooting (GH-1564) ---------------------------------------------
# Workspace-root repro: CLAUDE_PROJECT_DIR points at $SBX, which has a STRAY
# GH-9 critique — a wrongly-CWD-rooted hook would false-block here. The target
# file lives in $REPO (empty reviews/), so the correctly-rooted hook allows.
run_case "target file's repo root wins over CLAUDE_PROJECT_DIR (workspace-root repro, no false-block)" 0 \
  "$REPO/thoughts/shared/reviews/2026-07-19-GH-9-critique.md"

# Companion true-duplicate case: same $REPO, but a matching critique already
# exists there. Proves the search genuinely happens against the file's own
# repo (not just always-allow).
touch "$REPO/thoughts/shared/reviews/2026-05-24-GH-10-critique.md"
run_case "duplicate within the file's own repo still blocks" 2 \
  "$REPO/thoughts/shared/reviews/2026-07-19-GH-10-critique.md"

# Fallback-preserved control: target file has no .git ancestor anywhere on its
# path; the GH-1 critique DOES exist under $SBX (CLAUDE_PROJECT_DIR) — the walk
# exhausts and falls back to get_project_root(), preserving old behavior.
run_case "no .git ancestor + existing critique under CLAUDE_PROJECT_DIR blocks (fallback-preserved)" 2 \
  "$NOGIT/thoughts/shared/reviews/2026-07-19-GH-1-critique.md"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
