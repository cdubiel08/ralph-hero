#!/usr/bin/env bash
# ralph/hooks/scripts/__tests__/state-gate.test.sh
# Tests for the consolidated JSON-driven state gate (replaces the per-verb
# research/plan/impl/pr/merge/triage/hero/pr-drain state-gate family).
#
# Allowlists come from ralph-state-machine.json valid_output_states +
# lock_state, unioned across the command keys passed as argv.

set -euo pipefail

HOOK="$(cd "$(dirname "$0")/.." && pwd)/state-gate.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# run_case <desc> <expected_exit> <ralph_command_env> <state_json_field=value...> -- <gate argv...>
# Simplified: run_case <desc> <expected> <RALPH_COMMAND> <RALPH_SUBCOMMAND> <workflowState|targetState:VALUE|-> <argv...>
run_case() {
  local desc="$1" expected="$2" cmd="$3" sub="$4" state_spec="$5"; shift 5
  local json actual
  if [[ "$state_spec" == "-" ]]; then
    json='{"tool_input":{"labels":["x"]}}'
  elif [[ "$state_spec" == targetState:* ]]; then
    json=$(jq -n --arg s "${state_spec#targetState:}" '{tool_input: {targetState: $s}}')
  else
    json=$(jq -n --arg s "$state_spec" '{tool_input: {workflowState: $s}}')
  fi
  set +e
  env RALPH_HOOK_INPUT= RALPH_COMMAND="$cmd" RALPH_SUBCOMMAND="$sub" \
    bash "$HOOK" "$@" <<<"$json" >/dev/null 2>&1
  actual=$?
  set -e
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc (exit $actual)"
  else
    fail "$desc — expected exit $expected, got $actual"
  fi
}

echo "=== state-gate tests ==="
echo ""

# --- Scope guards ----------------------------------------------------------------
run_case "out-of-scope RALPH_COMMAND allows anything" 0 impl "" "Nonsense State" plan plan
run_case "subcommand scope: wrong subcommand allows" 0 caretake hygiene "Nonsense State" caretake:triage triage
run_case "subcommand scope: right subcommand still validates" 2 caretake triage "Nonsense State" caretake:triage triage

# --- Basic validation --------------------------------------------------------------
run_case "impl: In Review allowed" 0 impl "" "In Review" impl impl pr
run_case "impl: Done blocked" 2 impl "" "Done" impl impl pr
run_case "review: Done allowed (merge key)" 0 review "" "Done" review merge code_review
run_case "review: In Review allowed (code_review key)" 0 review "" "In Review" review merge code_review
run_case "review: Backlog blocked" 2 review "" "Backlog" review merge code_review

# --- Union across keys (plan's five modes) ------------------------------------------
run_case "plan: Plan in Review allowed (plan key)" 0 plan "" "Plan in Review" plan plan plan_epic review
run_case "plan: Ready for Plan allowed (review key)" 0 plan "" "Ready for Plan" plan plan plan_epic review
run_case "plan: Plan in Progress allowed (lock state)" 0 plan "" "Plan in Progress" plan plan plan_epic review
run_case "plan: Done blocked (in no mode's set)" 2 plan "" "Done" plan plan plan_epic review

# --- Lock state from JSON -------------------------------------------------------------
run_case "research: Research in Progress allowed (lock_state)" 0 research "" "Research in Progress" research research
run_case "research: In Progress blocked" 2 research "" "In Progress" research research

# --- Semantic intents ------------------------------------------------------------------
run_case "semantic intent __LOCK__ passes through" 0 research "" "__LOCK__" research research
run_case "semantic intent __ESCALATE__ passes through" 0 review "" "__ESCALATE__" review merge code_review

# --- No state change ----------------------------------------------------------------------
run_case "label-only save_issue allows" 0 impl "" "-" impl impl pr

# --- targetState fallback (advance_issue) ---------------------------------------------------
run_case "hero: advance_issue targetState In Review allowed" 0 hero "" "targetState:In Review" hero hero
run_case "hero: advance_issue targetState Canceled blocked" 2 hero "" "targetState:Canceled" hero hero

# --- Hero orchestration union ------------------------------------------------------------------
run_case "hero: Done allowed (orchestration set)" 0 hero "" "Done" hero hero
run_case "pr-drain: Done allowed" 0 hero pr-drain "Done" hero:pr-drain pr_drain
run_case "pr-drain: Ready for Plan blocked" 2 hero pr-drain "Ready for Plan" hero:pr-drain pr_drain

# --- Triage (PostToolUse registration, incl. Backlog) --------------------------------------------
run_case "triage: Backlog allowed (no-action keep)" 0 caretake triage "Backlog" caretake:triage triage
run_case "triage: In Review blocked" 2 caretake triage "In Review" caretake:triage triage

# --- Misconfiguration fails open -------------------------------------------------------------------
run_case "unknown command key fails open (allow + stderr warning)" 0 impl "" "Anything" impl no_such_key

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
