#!/usr/bin/env bash
# ralph/hooks/scripts/__tests__/split-hooks-plan-scope.test.sh
# GH-1605 / GH-1603 — the split-* gates must be armed by facts the HOOKS can
# observe, never by a mode env var.
#
# History this test encodes:
#   * GH-1605 closed the F1 verification defect from
#     thoughts/shared/reviews/2026-07-26-GH-1590-critique.md by driving each
#     hook with RALPH_COMMAND=plan + RALPH_SUBCOMMAND=epic|epic-split.
#   * GH-1603 found that arming unsound: RALPH_SUBCOMMAND was set by a bare
#     `export` in skill prose, which never reaches a hook subprocess, so all
#     three gates were dead in production. The old "static arming assertion"
#     grepped for that `export` line in the prose and therefore stayed GREEN in
#     exactly the broken state. It is replaced below by BEHAVIORAL cases that
#     drive the hooks with the env production actually produces —
#     RALPH_COMMAND=plan and NOTHING ELSE — plus prose assertions that the dead
#     export has not come back.
#
# Harness: named `run_case` (matching plan-research-required.test.sh's
# convention). Every case gets its own `session_id` and its own TMPDIR-rooted
# sandbox: the hooks now exchange facts through a session-scoped ledger
# (hook-utils.sh split_ledger_*), so leaking one case's ledger into the next
# would produce false greens. No SBX/REPO/NOGIT git sandboxes are set up —
# unlike plan-research-required.test.sh, whose sandboxes exist specifically to
# exercise resolve_root_from_path's file_path-derived rooting (ralph/CLAUDE.md
# § Hooks). These three hooks do no file_path lookups; what they read is the
# MCP tool_input/tool_response JSON, the session artifact list, and the ledger,
# all of which this harness roots under $SBX.
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

SBX="$(mktemp -d)"
trap 'rm -rf "$SBX"' EXIT
mkdir -p "$SBX/tmp"

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

for f in "$SIZE_GATE" "$ESTIMATE_GATE" "$POSTCONDITION"; do
  if [[ ! -f "$f" ]]; then
    echo "FATAL: hook not found at $f"
    exit 1
  fi
done

# session_dir <session-id> — the directory hook-utils.sh::ralph_session_dir
# resolves to for that id under this harness's TMPDIR.
session_dir() { echo "$SBX/tmp/ralph-session-$1"; }

# seed_plan_of_plans <session-id> — record a thoughts/shared/plans/ write for
# that session, the way artifact-write-tracker.sh does at runtime. This is the
# signal that puts split-size-gate.sh on the plan-of-plans path.
seed_plan_of_plans() {
  local sid="$1" dir doc
  dir="$(session_dir "$sid")"
  mkdir -p "$dir" "$SBX/thoughts/shared/plans"
  doc="$SBX/thoughts/shared/plans/2026-07-27-epic-plan-of-plans.md"
  : > "$doc"
  printf '%s\n' "$doc" > "$dir/artifacts.list"
}

# seed_ledger <session-id> <key> <value>
seed_ledger() {
  local sid="$1" key="$2" value="$3" dir
  dir="$(session_dir "$sid")"
  mkdir -p "$dir"
  printf '%s\n' "$value" > "$dir/split-${key}"
}

# run_case <desc> <expected_exit> <hook> <json> [ENV=val ...]
run_case() {
  local desc="$1" expected="$2" hook="$3" json="$4"; shift 4
  local actual
  # Clear EVERY hook-control variable these three gates read before applying the
  # per-case overrides in "$@". An inherited RALPH_FORCE_STOP=true flips the
  # one-child postcondition case from block to allow (a false green);
  # RALPH_VALID_SUB_ESTIMATES and RALPH_MIN_ESTIMATE likewise re-tune the
  # size/estimate gates. The developer shell profile exports RALPH_* vars, so
  # this is a live leak, not a theory.
  if env -u RALPH_COMMAND -u RALPH_SUBCOMMAND -u RALPH_TICKET_ID -u RALPH_SPLIT_COUNT \
    -u RALPH_FORCE_STOP -u RALPH_VALID_SUB_ESTIMATES -u RALPH_VALID_FEATURE_ESTIMATES \
    -u RALPH_MIN_ESTIMATE \
    TMPDIR="$SBX/tmp" RALPH_HOOK_INPUT= "$@" bash "$hook" <<<"$json" >/dev/null 2>&1; then
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

echo "=== split-hooks-plan-scope tests (GH-1605 / GH-1603) ==="
echo ""

# =============================================================================
# Group A — production arming: RALPH_COMMAND=plan and NOTHING else.
# These are the cases the pre-GH-1603 hooks fail. The plan skill sets
# RALPH_COMMAND at SessionStart via CLAUDE_ENV_FILE; no mode/subcommand value
# ever reaches a hook subprocess, so this env is what production really has.
# =============================================================================

json_m_child_prod='{"session_id":"prod-1","tool_input":{"parentNumber":100,"children":[{"title":"a","estimate":"M"}]}}'
run_case "A1: plan only (no RALPH_SUBCOMMAND) + M child -> exit 2 (atomic ceiling live)" 2 \
  "$SIZE_GATE" "$json_m_child_prod" RALPH_COMMAND=plan

json_xs_s_prod='{"session_id":"prod-2","tool_input":{"parentNumber":100,"children":[{"title":"a","estimate":"S"},{"title":"b","estimate":"XS"}]}}'
run_case "A2: plan only + XS/S children -> exit 0" 0 \
  "$SIZE_GATE" "$json_xs_s_prod" RALPH_COMMAND=plan

json_missing_prod='{"session_id":"prod-3","tool_input":{"parentNumber":100,"children":[{"title":"a"},{"title":"b","estimate":"XS"}]}}'
run_case "A3: plan only + child with no estimate -> exit 2 (omission is not a waiver)" 2 \
  "$SIZE_GATE" "$json_missing_prod" RALPH_COMMAND=plan

# Plan-of-plans is distinguished by ORDER, not by an env var: its doc is written
# BEFORE children are created (decomposition.md § Plan-of-plans path, Step 3 ->
# Step 4), and artifact-write-tracker.sh records that write against the session.
seed_plan_of_plans "pop-1"
json_m_child_pop='{"session_id":"pop-1","tool_input":{"parentNumber":100,"children":[{"title":"a","estimate":"M"}]}}'
run_case "A4: plan-of-plans doc already written + M child -> exit 0 (S/M ceiling)" 0 \
  "$SIZE_GATE" "$json_m_child_pop" RALPH_COMMAND=plan

seed_plan_of_plans "pop-2"
json_xl_child_pop='{"session_id":"pop-2","tool_input":{"parentNumber":100,"children":[{"title":"a","estimate":"XL"}]}}'
run_case "A5: plan-of-plans + XL child -> exit 2 (S/M ceiling still a ceiling)" 2 \
  "$SIZE_GATE" "$json_xl_child_pop" RALPH_COMMAND=plan

seed_plan_of_plans "pop-3"
json_missing_pop='{"session_id":"pop-3","tool_input":{"parentNumber":100,"children":[{"title":"a"},{"title":"b","estimate":"S"}]}}'
run_case "A6: plan-of-plans + child with no estimate -> exit 2 (explicit estimate on both paths)" 2 \
  "$SIZE_GATE" "$json_missing_pop" RALPH_COMMAND=plan

# The M/L/XL parent contract now enforces at the CREATE boundary, off the
# estimate the PostToolUse pass of split-estimate-gate.sh recorded.
seed_ledger "parent-small" "parent-100" "S"
json_small_parent='{"session_id":"parent-small","tool_input":{"parentNumber":100,"children":[{"title":"a","estimate":"XS"},{"title":"b","estimate":"XS"}]}}'
run_case "A7: recorded parent estimate S + atomic batch -> exit 2 (parent too small)" 2 \
  "$SIZE_GATE" "$json_small_parent" RALPH_COMMAND=plan

seed_ledger "parent-big" "parent-100" "L"
json_big_parent='{"session_id":"parent-big","tool_input":{"parentNumber":100,"children":[{"title":"a","estimate":"XS"},{"title":"b","estimate":"XS"}]}}'
run_case "A8: recorded parent estimate L + atomic batch -> exit 0" 0 \
  "$SIZE_GATE" "$json_big_parent" RALPH_COMMAND=plan

# Out of the plan verb entirely, nothing is enforced.
json_other_verb='{"session_id":"other-1","tool_input":{"parentNumber":100,"children":[{"title":"a","estimate":"XL"}]}}'
run_case "A9: RALPH_COMMAND=caretake -> exit 0 (out of scope)" 0 \
  "$SIZE_GATE" "$json_other_verb" RALPH_COMMAND=caretake
run_case "A10: no RALPH_COMMAND -> exit 0 (out of scope)" 0 \
  "$SIZE_GATE" "$json_other_verb"

# =============================================================================
# Group B — the postcondition arms off a recorded creation ATTEMPT, not an env
# var, and a missing count under an attempt blocks.
# =============================================================================

json_stop_noop='{"session_id":"stop-noop","hook_event_name":"Stop","stop_hook_active":false}'
run_case "B1: plan session with no permitted batch -> exit 0 (graceful no-op can STOP)" 0 \
  "$POSTCONDITION" "$json_stop_noop" RALPH_COMMAND=plan RALPH_TICKET_ID=GH-1

seed_ledger "stop-one" "attempted" "1"
seed_ledger "stop-one" "count" "1"
json_stop_one='{"session_id":"stop-one","hook_event_name":"Stop","stop_hook_active":false}'
run_case "B2: permitted atomic batch + count 1 -> exit 2" 2 \
  "$POSTCONDITION" "$json_stop_one" RALPH_COMMAND=plan

seed_ledger "stop-two" "attempted" "1"
seed_ledger "stop-two" "count" "2"
json_stop_two='{"session_id":"stop-two","hook_event_name":"Stop","stop_hook_active":false}'
run_case "B3: permitted atomic batch + count 2 -> exit 0" 0 \
  "$POSTCONDITION" "$json_stop_two" RALPH_COMMAND=plan

# GH-1603 F4: an armed scope with NO usable count is 'cannot verify', which is
# not 'verified'. The pre-fix hook returned 0 here whenever RALPH_TICKET_ID was
# also unset, so an unverifiable split walked straight through Stop.
seed_ledger "stop-nocount" "attempted" "1"
json_stop_nocount='{"session_id":"stop-nocount","hook_event_name":"Stop","stop_hook_active":false}'
run_case "B4: permitted atomic batch, no count, no RALPH_TICKET_ID -> exit 2 (cannot verify)" 2 \
  "$POSTCONDITION" "$json_stop_nocount" RALPH_COMMAND=plan

# GH-1603 F4 (second half): a non-numeric count must block, not abort with the
# non-blocking rc=1 that `[[ "$c" -ge 2 ]]` raises under `set -u`.
seed_ledger "stop-junk" "attempted" "1"
json_stop_junk='{"session_id":"stop-junk","hook_event_name":"Stop","stop_hook_active":false}'
run_case "B5: permitted atomic batch + non-numeric count -> exit 2 (not rc=1)" 2 \
  "$POSTCONDITION" "$json_stop_junk" RALPH_COMMAND=plan RALPH_SPLIT_COUNT=lots

seed_ledger "stop-hatch" "attempted" "1"
seed_ledger "stop-hatch" "count" "0"
json_stop_hatch='{"session_id":"stop-hatch","hook_event_name":"Stop","stop_hook_active":false}'
run_case "B6: RALPH_FORCE_STOP=true bypasses even an armed failing count -> exit 0" 0 \
  "$POSTCONDITION" "$json_stop_hatch" RALPH_COMMAND=plan RALPH_FORCE_STOP=true

run_case "B7: RALPH_COMMAND=caretake at Stop -> exit 0 (out of scope)" 0 \
  "$POSTCONDITION" "$json_stop_one" RALPH_COMMAND=caretake

# End-to-end pairs: what the size gate records is what the Stop gate reads.
# A BLOCKED batch must NOT arm the postcondition — otherwise an agent that
# correctly aborts with `SPLIT SKIPPED` is trapped at Stop by a count it can
# never produce.
run_case "B7a: blocked atomic batch (M child) -> exit 2 at the size gate" 2 \
  "$SIZE_GATE" '{"session_id":"e2e-blocked","tool_input":{"parentNumber":100,"children":[{"title":"a","estimate":"M"}]}}' \
  RALPH_COMMAND=plan
run_case "B7b: ...and Stop is then FREE (no attempt was permitted)" 0 \
  "$POSTCONDITION" '{"session_id":"e2e-blocked","hook_event_name":"Stop","stop_hook_active":false}' \
  RALPH_COMMAND=plan

# An ALLOWED batch does arm it, and with no recorded count Stop must block.
run_case "B7c: permitted atomic batch -> exit 0 at the size gate" 0 \
  "$SIZE_GATE" '{"session_id":"e2e-allowed","tool_input":{"parentNumber":100,"children":[{"title":"a","estimate":"XS"},{"title":"b","estimate":"S"}]}}' \
  RALPH_COMMAND=plan
run_case "B7d: ...and Stop then blocks with no created-count recorded" 2 \
  "$POSTCONDITION" '{"session_id":"e2e-allowed","hook_event_name":"Stop","stop_hook_active":false}' \
  RALPH_COMMAND=plan

# The single-child create_issue path is legitimately one child — it must not
# arm the ≥2 postcondition.
run_case "B7e: scalar create_issue (XS) -> exit 0 at the size gate" 0 \
  "$SIZE_GATE" '{"session_id":"e2e-scalar","tool_input":{"estimate":"XS"}}' RALPH_COMMAND=plan
run_case "B7f: ...and Stop is FREE (single-child path has no >=2 contract)" 0 \
  "$POSTCONDITION" '{"session_id":"e2e-scalar","hook_event_name":"Stop","stop_hook_active":false}' \
  RALPH_COMMAND=plan

# The size gate's PostToolUse pass is what records the count in the first place.
json_post_create=$(jq -n '{
  session_id: "post-count",
  hook_event_name: "PostToolUse",
  tool_response: { content: [ { text: (({
      parentNumber: 100,
      summary: { total: 3, created: 3 },
      children: [ {created: true}, {created: true}, {created: false} ]
    }) | tojson) } ] }
}')
run_case "B8: size gate PostToolUse records the created count -> exit 0" 0 \
  "$SIZE_GATE" "$json_post_create" RALPH_COMMAND=plan
if [[ "$(cat "$(session_dir post-count)/split-count" 2>/dev/null || echo MISSING)" == "2" ]]; then
  pass "B9: recorded count is the created:true tally (2), not summary.created (3)"
else
  fail "B9: expected recorded count 2, got $(cat "$(session_dir post-count)/split-count" 2>/dev/null || echo MISSING)"
fi

# =============================================================================
# Group C — the estimate gate: records always, enforces once armed, and never
# trusts .hook_event_name alone.
# =============================================================================

json_get_issue_small=$(jq -n '{
  session_id: "est-small",
  hook_event_name: "PostToolUse",
  tool_response: { content: [ { text: (({number:1,title:"tiny",estimate:"S"}) | tojson) } ] }
}')
run_case "C1: plan + parent estimate S, scope not yet armed -> exit 0 (records only)" 0 \
  "$ESTIMATE_GATE" "$json_get_issue_small" RALPH_COMMAND=plan
if [[ "$(cat "$(session_dir est-small)/split-parent-1" 2>/dev/null || echo MISSING)" == "S" ]]; then
  pass "C2: the S estimate was recorded in the ledger for the create-boundary check"
else
  fail "C2: expected recorded parent-1 estimate S, got $(cat "$(session_dir est-small)/split-parent-1" 2>/dev/null || echo MISSING)"
fi

seed_ledger "est-armed" "atomic" "1"
json_get_issue_small_armed=$(jq -n '{
  session_id: "est-armed",
  hook_event_name: "PostToolUse",
  tool_response: { content: [ { text: (({number:1,title:"tiny",estimate:"S"}) | tojson) } ] }
}')
run_case "C3: armed by ledger + parent estimate S -> exit 2 (too small)" 2 \
  "$ESTIMATE_GATE" "$json_get_issue_small_armed" RALPH_COMMAND=plan

# GH-1603 F3: the pre-fix hook read `.hook_event_name` and fell into the
# PreToolUse arm (allow_with_context, exit 0) whenever it was empty — so an
# S-estimate parent walked through the enforcement pass. Discrimination is on
# payload SHAPE: a `.tool_response` key means PostToolUse regardless of the
# event name, and ambiguity resolves to the enforcing side.
json_get_issue_no_event=$(jq -n '{
  session_id: "est-noevent",
  tool_response: { content: [ { text: (({number:1,title:"tiny",estimate:"S"}) | tojson) } ] }
}')
run_case "C4: armed + EMPTY hook_event_name + response payload -> exit 2 (shape wins)" 2 \
  "$ESTIMATE_GATE" "$json_get_issue_no_event" RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split

# Fail-closed family: once armed, an estimate the gate cannot read must block.
json_est_no_estimate=$(jq -n '{
  session_id: "est-no-estimate",
  hook_event_name: "PostToolUse",
  tool_response: { content: [ { text: (({number:2,title:"unestimated"}) | tojson) } ] }
}')
run_case "C5a: armed + parent with NO estimate -> exit 2 (fail closed)" 2 \
  "$ESTIMATE_GATE" "$json_est_no_estimate" RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split

json_est_null=$(jq -n '{
  session_id: "est-null",
  hook_event_name: "PostToolUse",
  tool_response: { content: [ { text: (({number:3,title:"null est",estimate:null}) | tojson) } ] }
}')
run_case "C5b: armed + parent estimate null -> exit 2 (fail closed)" 2 \
  "$ESTIMATE_GATE" "$json_est_null" RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split

json_est_malformed=$(jq -n '{
  session_id: "est-malformed",
  hook_event_name: "PostToolUse",
  tool_response: { content: [ { text: "<html>502 Bad Gateway</html>" } ] }
}')
run_case "C5c: armed + malformed (non-JSON) response -> exit 2 (fail closed)" 2 \
  "$ESTIMATE_GATE" "$json_est_malformed" RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split

json_est_empty=$(jq -n '{
  session_id: "est-empty",
  hook_event_name: "PostToolUse",
  tool_response: { content: [] }
}')
run_case "C5d: armed + empty tool_response -> exit 2 (fail closed)" 2 \
  "$ESTIMATE_GATE" "$json_est_empty" RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split

# Unarmed, the same unreadable payloads are a clean pass-through — the gate
# records what it can and gets out of the way.
json_unarmed_no_estimate=$(jq -n '{
  session_id: "est-unarmed",
  hook_event_name: "PostToolUse",
  tool_response: { content: [ { text: (({number:2,title:"unestimated"}) | tojson) } ] }
}')
run_case "C6: unarmed + parent with NO estimate -> exit 0" 0 \
  "$ESTIMATE_GATE" "$json_unarmed_no_estimate" RALPH_COMMAND=plan

json_get_issue_large=$(jq -n '{
  session_id: "est-large",
  hook_event_name: "PostToolUse",
  tool_response: { content: [ { text: (({number:4,title:"big",estimate:"L"}) | tojson) } ] }
}')
run_case "C7: armed + parent estimate L -> exit 0 (allowed)" 0 \
  "$ESTIMATE_GATE" "$json_get_issue_large" RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split

run_case "C8: RALPH_COMMAND=caretake -> exit 0 (out of scope, old split key retired)" 0 \
  "$ESTIMATE_GATE" "$json_get_issue_small" RALPH_COMMAND=caretake RALPH_SUBCOMMAND=split

# The legacy env signal is ADDITIVE — it may arm the tighter contract, and it
# must never DISARM one. `RALPH_SUBCOMMAND=epic` used to switch all three gates
# off; that is exactly the hole GH-1603 closed.
json_m_child_epic='{"session_id":"legacy-epic","tool_input":{"parentNumber":100,"children":[{"title":"a","estimate":"M"}]}}'
run_case "C9: stale RALPH_SUBCOMMAND=epic cannot disarm the atomic ceiling -> exit 2" 2 \
  "$SIZE_GATE" "$json_m_child_epic" RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic

echo ""

# =============================================================================
# Group D — prose assertions. These replace the pre-GH-1603 "static arming
# assertion", which grepped for the `export RALPH_SUBCOMMAND=epic-split` line
# and so certified the gates as armed in precisely the state where they were
# dead. They now assert the inverse: the dead mechanism must NOT come back, and
# the hooks must not early-exit on it.
# =============================================================================

if grep -qE 'export RALPH_SUBCOMMAND=' "$PLAN_SKILL" "$DECOMPOSITION"; then
  fail "plan skill prose re-introduced 'export RALPH_SUBCOMMAND=' (a bare Bash export never reaches a hook subprocess — the GH-1603 F1 defect)"
else
  pass "plan skill prose carries no 'export RALPH_SUBCOMMAND=' arming"
fi

if grep -qE 'export RALPH_SPLIT_COUNT=' "$PLAN_SKILL" "$DECOMPOSITION"; then
  fail "plan skill prose re-introduced 'export RALPH_SPLIT_COUNT=' (same dead channel; the count comes from the create_sub_issues response)"
else
  pass "plan skill prose carries no 'export RALPH_SPLIT_COUNT=' arming"
fi

# No split-* hook may make RALPH_SUBCOMMAND a REQUIRED scope guard again — i.e.
# an early `allow` when it is not epic-split. Additive reads (`== "epic-split"`
# to tighten) are fine; the `!=` early-exit is the dead shape.
for hook in "$SIZE_GATE" "$ESTIMATE_GATE" "$POSTCONDITION"; do
  if grep -qE '"\$\{RALPH_SUBCOMMAND:-\}" != ' "$hook"; then
    fail "$(basename "$hook") early-exits on RALPH_SUBCOMMAND again (dead scope guard)"
  else
    pass "$(basename "$hook") does not gate on RALPH_SUBCOMMAND propagating"
  fi
done

# plan/SKILL.md must still register both passes of the size gate — the
# PostToolUse pass is what records the created count the postcondition needs.
if grep -qE 'split-size-gate\.sh' "$PLAN_SKILL" \
   && [[ "$(grep -c 'split-size-gate\.sh' "$PLAN_SKILL")" -ge 2 ]]; then
  pass "plan/SKILL.md registers split-size-gate.sh on both PreToolUse and PostToolUse"
else
  fail "plan/SKILL.md no longer registers split-size-gate.sh twice (count recording lost)"
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
if [[ "$FAIL" -eq 0 ]]; then
  exit 0
else
  exit 1
fi
