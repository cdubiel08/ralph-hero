#!/usr/bin/env bash
# ralph/hooks/scripts/__tests__/split-hooks-plan-scope.test.sh
# GH-1605 — closes the F1 verification defect from
# thoughts/shared/reviews/2026-07-26-GH-1590-critique.md: the phase's other
# checks (grep counts, re-keyed fixtures that set their own env) all pass
# even when the split-* guards are never armed in plan context. This test
# drives each hook with the ENV the plan skill actually produces
# (RALPH_COMMAND=plan + RALPH_SUBCOMMAND=epic|epic-split, per
# ralph/skills/plan/SKILL.md Step 0 + ralph/skills/plan/decomposition.md
# § Atomic split's re-export), so it fails if either side of the arming
# drifts.
#
# Cases 1, 2, 5, and the static arming assertions are the ones that fail in
# the states the critique identified (guards dead / plan-of-plans regressed).
#
# Harness: named `run_case` (matching plan-research-required.test.sh's
# convention) rather than `run_hook`. No SBX/REPO/NOGIT filesystem sandboxes
# are set up here, unlike plan-research-required.test.sh — that harness's
# sandboxes exist specifically to exercise resolve_root_from_path's
# file_path-derived rooting (ralph/CLAUDE.md § Hooks). split-size-gate.sh /
# split-estimate-gate.sh / split-postcondition.sh do no file_path lookups at
# all (see each hook's own header) — they gate purely on
# RALPH_COMMAND/RALPH_SUBCOMMAND env plus the MCP tool_input/tool_response
# JSON payload — so there is no filesystem root to sandbox and no
# CLAUDE_PROJECT_DIR dependency to isolate. What IS shared with that harness
# is exit-code assertion via a `run_case` helper over crafted JSON on stdin
# with explicit env isolation.
#
# Exit-code capture avoids toggling `set +e`/`set -e` (ast-grep
# set-plus-e-error-masking-bash) — an `if`/`else` around the invocation
# captures $? without ever disabling errexit for the rest of the script.

set -uo pipefail

PASS=0
FAIL=0

# Locate repo root from this script's location (ralph/hooks/scripts/__tests__)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HOOKS_DIR="${REPO_ROOT}/ralph/hooks/scripts"
SIZE_GATE="${HOOKS_DIR}/split-size-gate.sh"
ESTIMATE_GATE="${HOOKS_DIR}/split-estimate-gate.sh"
POSTCONDITION="${HOOKS_DIR}/split-postcondition.sh"
PLAN_SKILL="${REPO_ROOT}/ralph/skills/plan/SKILL.md"
DECOMPOSITION="${REPO_ROOT}/ralph/skills/plan/decomposition.md"

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

for f in "$SIZE_GATE" "$ESTIMATE_GATE" "$POSTCONDITION"; do
  if [[ ! -f "$f" ]]; then
    echo "FATAL: hook not found at $f"
    exit 1
  fi
done

# run_case <desc> <expected_exit> <hook> <json> [ENV=val ...]
run_case() {
  local desc="$1" expected="$2" hook="$3" json="$4"; shift 4
  local actual
  # Clear EVERY hook-control variable these three gates read before applying the
  # per-case overrides in "$@". An inherited RALPH_FORCE_STOP=true flips Case 6
  # from block to allow (a false green); RALPH_VALID_SUB_ESTIMATES and
  # RALPH_MIN_ESTIMATE likewise re-tune the size/estimate gates. The developer
  # shell profile exports RALPH_* vars, so this is a live leak, not a theory.
  if env -u RALPH_COMMAND -u RALPH_SUBCOMMAND -u RALPH_TICKET_ID -u RALPH_SPLIT_COUNT \
    -u RALPH_FORCE_STOP -u RALPH_VALID_SUB_ESTIMATES -u RALPH_MIN_ESTIMATE \
    RALPH_HOOK_INPUT= "$@" bash "$hook" <<<"$json" >/dev/null 2>&1; then
    actual=0
  else
    actual=$?
  fi
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc (exit $actual)"
  else
    fail "$desc — expected exit $expected, got $actual"
  fi
}

echo "=== split-hooks-plan-scope tests (GH-1605) ==="
echo ""

# --- Case 1: atomic guard armed — epic-split + M child -> blocked --------------
json_m_child='{"tool_input":{"parentNumber":100,"children":[{"title":"a","estimate":"M"}]}}'
run_case "1: epic-split + M child -> exit 2 (atomic guard armed)" 2 \
  "$SIZE_GATE" "$json_m_child" \
  RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split

# --- Case 2: plan-of-plans M children unregressed (F2) -------------------------
run_case "2: epic + M child -> exit 0 (plan-of-plans M children unregressed)" 0 \
  "$SIZE_GATE" "$json_m_child" \
  RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic

# --- Case 3: atomic path allows XS/S ---------------------------------------------
json_xs_s='{"tool_input":{"parentNumber":100,"children":[{"title":"a","estimate":"S"},{"title":"b","estimate":"XS"}]}}'
run_case "3: epic-split + S/XS children -> exit 0" 0 \
  "$SIZE_GATE" "$json_xs_s" \
  RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split

# --- Case 4: old key fully retired ------------------------------------------------
run_case "4: old caretake+split key -> exit 0 (fully retired)" 0 \
  "$SIZE_GATE" "$json_m_child" \
  RALPH_COMMAND=caretake RALPH_SUBCOMMAND=split

# --- Case 5: pure plan-of-plans session cannot be blocked by postcondition -----
json_stop='{"hook_event_name":"Stop","stop_hook_active":false}'
run_case "5: epic + RALPH_TICKET_ID set, no RALPH_SPLIT_COUNT -> exit 0" 0 \
  "$POSTCONDITION" "$json_stop" \
  RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic RALPH_TICKET_ID=GH-1

# --- Case 6: atomic postcondition blocks below the ≥2 threshold ----------------
run_case "6: epic-split + RALPH_SPLIT_COUNT=1 -> exit 2" 2 \
  "$POSTCONDITION" "$json_stop" \
  RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split RALPH_TICKET_ID=GH-1 RALPH_SPLIT_COUNT=1

# --- Case 7: atomic estimate gate blocks a too-small parent --------------------
json_get_issue_small=$(jq -n '{
  hook_event_name: "PostToolUse",
  tool_response: { content: [ { text: (({number:1,title:"tiny",estimate:"S"}) | tojson) } ] }
}')
run_case "7: epic-split + parent estimate S -> exit 2 (too small)" 2 \
  "$ESTIMATE_GATE" "$json_get_issue_small" \
  RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split

# --- Case 8: RALPH_FORCE_STOP escape hatch actually bypasses -------------------
# Case 6 above is the same input WITHOUT the hatch (exit 2). This pins the
# documented bypass: hook-utils.sh's warn() prints and exits 0, so the warning
# branch is terminal and never falls through to block(). If warn() is ever
# changed to return, or the branch is reordered below the block, this goes red.
run_case "8: epic-split + RALPH_SPLIT_COUNT=0 + RALPH_FORCE_STOP=true -> exit 0 (hatch honored)" 0 \
  "$POSTCONDITION" "$json_stop" \
  RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split RALPH_TICKET_ID=GH-1 \
  RALPH_SPLIT_COUNT=0 RALPH_FORCE_STOP=true

# --- Case 9: missing child estimate is NOT a free pass under epic-split -------
# The XS/S ceiling must not be bypassable by omitting `estimate`. Mirrors
# GH-1618's server-side rule (create_sub_issues refuses estimate-less children
# whenever maxChildEstimate is armed explicitly, which this path does).
json_missing_estimate='{"tool_input":{"parentNumber":100,"children":[{"title":"a"},{"title":"b","estimate":"XS"}]}}'
run_case "9: epic-split + child with no estimate -> exit 2" 2 \
  "$SIZE_GATE" "$json_missing_estimate" \
  RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split
run_case "10: epic (plan-of-plans) + child with no estimate -> exit 0 (out of scope)" 0 \
  "$SIZE_GATE" "$json_missing_estimate" \
  RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic

echo ""

# --- Static arming assertion: BOTH sides of the contract, independently --------
# The split-* hooks require RALPH_SUBCOMMAND=epic-split (extracted from the
# hook's own guard literal below, anchored on REPO_ROOT so this test is
# runnable from any CWD). That value only exists at runtime because of TWO
# separate, independently-removable pieces of skill prose:
#   (a) ralph/skills/plan/SKILL.md Step 0 exports the base RALPH_SUBCOMMAND
#       (epic, iterate, review, ...) per --mode — this is the case arm that
#       ultimately makes epic-split's re-export meaningful (with no Step 0
#       export at all, "on top of" has nothing to layer onto).
#   (b) ralph/skills/plan/decomposition.md § Atomic split re-exports
#       RALPH_SUBCOMMAND=epic-split on top of the Step 0 value, immediately
#       before any get_issue/create_issue/create_sub_issues call.
# A single recursive grep across ralph/skills/plan/ (the prior version of
# this test) is satisfied by (b) alone and stays green even if (a) is
# deleted — assert them separately so either regression is caught.
required=$(sed -n 's/.*RALPH_SUBCOMMAND:-}" != "\([a-z-]*\)".*/\1/p' "$SIZE_GATE" | head -1)
if [[ -z "$required" ]]; then
  fail "extracted required RALPH_SUBCOMMAND value from split-size-gate.sh"
else
  pass "extracted required RALPH_SUBCOMMAND value from split-size-gate.sh: ${required}"

  # (a) Step 0 base case export in plan/SKILL.md — the epic-mode arm.
  if grep -qE 'export RALPH_SUBCOMMAND=epic\b' "$PLAN_SKILL"; then
    pass "plan/SKILL.md Step 0 still exports the base RALPH_SUBCOMMAND=epic case"
  else
    fail "plan/SKILL.md Step 0 no longer exports RALPH_SUBCOMMAND=epic (split guards have nothing to layer '${required}' onto)"
  fi

  # (a2) That export must be keyed on the PARSED mode, not on a prefix match
  # over $ARGUMENTS. `case "$ARGUMENTS" in --mode\ epic*)` only fires when
  # --mode is the FIRST token, so `--no-playwright --mode epic #123` fell
  # through to `default` and left these gates disarmed for a real epic run.
  if grep -qE '^case "\$MODE" in' "$PLAN_SKILL"; then
    pass "plan/SKILL.md Step 0 arms RALPH_SUBCOMMAND from the parsed \$MODE"
  else
    fail "plan/SKILL.md Step 0 no longer switches on \"\$MODE\" (prefix-matching \$ARGUMENTS disarms the split gates for non-leading --mode)"
  fi
  if grep -qE 'case "\$ARGUMENTS" in' "$PLAN_SKILL"; then
    fail "plan/SKILL.md Step 0 regressed to a \$ARGUMENTS prefix match for RALPH_SUBCOMMAND"
  else
    pass "plan/SKILL.md Step 0 has no \$ARGUMENTS prefix match for RALPH_SUBCOMMAND"
  fi

  # (b) The atomic-split re-export in decomposition.md — the arm the hooks
  # literally require. This is the check that goes red the moment the
  # export is removed from decomposition.md § Atomic split (the exact F1
  # regression state).
  if grep -qE "export RALPH_SUBCOMMAND=${required}\$" "$DECOMPOSITION"; then
    pass "decomposition.md § Atomic split still re-exports RALPH_SUBCOMMAND=${required}"
  else
    fail "split guards are not armed in plan context (no 'export RALPH_SUBCOMMAND=${required}' in ralph/skills/plan/decomposition.md)"
  fi
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
if [[ "$FAIL" -eq 0 ]]; then
  exit 0
else
  exit 1
fi
