#!/bin/bash
# ralph/hooks/scripts/__tests__/impl-verify-commit.test.sh
# Tests for impl-verify-commit.sh, including the phase_completed activity
# event appended on successful phase commits (GH-1552 Phase 2).
#
# Strategy: invoke the hook with crafted PostToolUse:Bash JSON on stdin,
# pointing RALPH_ACTIVITY_DIR at a per-run temp dir, and assert both the
# exit code AND the resulting activity JSONL file contents via jq.

set -euo pipefail

HOOK="$(cd "$(dirname "$0")/.." && pwd)/impl-verify-commit.sh"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

ACTIVITY_ROOT="$(mktemp -d)"
trap 'rm -rf "$ACTIVITY_ROOT"' EXIT

TODAY_FILE="$ACTIVITY_ROOT/$(date +%Y/%m/%d).jsonl"

# run_case <desc> <expected_exit> <command> <stdout> <stderr> [ENV=val ...]
run_case() {
  local desc="$1" expected="$2" command="$3" stdout="$4" stderr="$5"; shift 5
  local json actual
  json=$(jq -n --arg cmd "$command" --arg out "$stdout" --arg err "$stderr" \
    '{tool_input: {command: $cmd}, tool_response: {stdout: $out, stderr: $err}}')
  set +e
  # -u first so the runner's own shell profile (which may export RALPH_*
  # vars — observed RALPH_REVIEW_PLAN on this machine, per
  # reference_shell_exports_ralph_env_vars) can't leak into these cases;
  # per-case overrides in "$@" re-set what's needed.
  env -u RALPH_COMMAND -u RALPH_REVIEW_PLAN -u RALPH_REVIEW_MODE \
    RALPH_ACTIVITY_DIR="$ACTIVITY_ROOT" "$@" bash "$HOOK" <<<"$json" >/dev/null 2>&1
  actual=$?
  set -e
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc (exit $actual)"
  else
    fail "$desc — expected exit $expected, got $actual"
  fi
}

echo "=== impl-verify-commit tests ==="
echo ""

# --- Scope guard --------------------------------------------------------------
rm -f "$TODAY_FILE"
run_case "RALPH_COMMAND unset (scope guard) allows even with matching commit message" 0 \
  'git commit -m "feat: x" -m "Phase 2 of 5: #1552 - Title"' "" ""
if [[ ! -f "$TODAY_FILE" ]]; then
  pass "scope guard: no file written"
else
  fail "scope guard: file unexpectedly written"
fi

# --- (a) Matching git commit, successful push writes one phase_completed line --
rm -f "$TODAY_FILE"
run_case "git commit with Phase N of M pattern allows" 0 \
  'git commit -m "feat: x" -m "Phase 2 of 5: #1552 - Title"' "commit abc" "" \
  RALPH_COMMAND=impl
if [[ -f "$TODAY_FILE" ]]; then
  lines=$(wc -l < "$TODAY_FILE" | tr -d ' ')
  if [[ "$lines" == "1" ]]; then
    pass "(a) exactly one line written"
  else
    fail "(a) expected 1 line, got $lines"
  fi
  kind=$(jq -r '.kind' "$TODAY_FILE")
  issue=$(jq -r '.target.issue' "$TODAY_FILE")
  phase=$(jq -r '.target.phase' "$TODAY_FILE")
  totalPhases=$(jq -r '.target.totalPhases' "$TODAY_FILE")
  category=$(jq -r '.category' "$TODAY_FILE")
  if [[ "$kind" == "phase_completed" && "$issue" == "1552" && "$phase" == "2" && "$totalPhases" == "5" && "$category" == "work" ]]; then
    pass "(a) file contents match expected shape"
  else
    fail "(a) unexpected contents: kind=$kind issue=$issue phase=$phase totalPhases=$totalPhases category=$category"
  fi
else
  fail "(a) expected activity file to be written, none found"
fi

# --- (b) git commit without Phase N of M pattern: no file written -------------
rm -f "$TODAY_FILE"
run_case "git commit without phase pattern allows" 0 \
  'git commit -m "feat: unrelated change"' "commit abc" "" \
  RALPH_COMMAND=impl
if [[ ! -f "$TODAY_FILE" ]]; then
  pass "(b) no file written for non-matching commit message"
else
  fail "(b) file unexpectedly written"
fi

# --- (c) git push only (no git commit substring): no file written -------------
rm -f "$TODAY_FILE"
run_case "git push only allows (existing behavior preserved)" 0 \
  'git push -u origin feature/GH-1552' "" "" \
  RALPH_COMMAND=impl
if [[ ! -f "$TODAY_FILE" ]]; then
  pass "(c) no file written for push-only command"
else
  fail "(c) file unexpectedly written"
fi

# --- (d) rejected push: exit 2 (existing block() behavior unchanged) ----------
rm -f "$TODAY_FILE"
run_case "rejected push blocks (existing behavior unchanged)" 2 \
  'git push -u origin feature/GH-1552' "" "! [rejected] feature/GH-1552 -> feature/GH-1552 (fetch first)" \
  RALPH_COMMAND=impl
if [[ ! -f "$TODAY_FILE" ]]; then
  pass "(d) no file written on rejected push"
else
  fail "(d) file unexpectedly written"
fi

# --- (e) nothing to commit: exit 0 (existing warn() behavior unchanged) -------
rm -f "$TODAY_FILE"
run_case "nothing to commit warns (existing behavior unchanged)" 0 \
  'git commit -m "Phase 2 of 5: #1552 - Title"' "" "nothing to commit, working tree clean" \
  RALPH_COMMAND=impl
if [[ ! -f "$TODAY_FILE" ]]; then
  pass "(e) no file written when nothing to commit"
else
  fail "(e) file unexpectedly written"
fi

# --- (f) RALPH_COMMAND unset already covered above; repeat for clarity with
#     phase-matching commit + successful tool_response ------------------------
rm -f "$TODAY_FILE"
run_case "(f) RALPH_COMMAND unset with matching commit message still allows, no file" 0 \
  'git commit -m "feat: x" -m "Phase 2 of 5: #1552 - Title"' "commit abc" ""
if [[ ! -f "$TODAY_FILE" ]]; then
  pass "(f) no file written when RALPH_COMMAND unset"
else
  fail "(f) file unexpectedly written"
fi

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
