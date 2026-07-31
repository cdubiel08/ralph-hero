#!/bin/bash
# ralph/hooks/scripts/state-gate.sh
# PreToolUse/PostToolUse (ralph_hero__save_issue / ralph_hero__advance_issue):
# generic workflow-state transition gate, driven by ralph-state-machine.json.
#
# Replaces the per-verb gate family (research/plan/impl/pr/merge/triage/hero/
# pr-drain state gates), which duplicated the state machine's
# valid_output_states as ten drifting bash literals. This gate reads them from
# the JSON, so ralph-state-machine.json is the single source of truth.
#
# Usage (skill frontmatter):
#   state-gate.sh <scope>[:<subcommand>] <command-key> [<command-key>...]
#
#   <scope>        RALPH_COMMAND value this gate is active for. Multi-mode
#                  sessions (e.g. /ralph:hero dispatching child verbs) keep
#                  earlier skills' hooks registered, so the env scope guard is
#                  still required on top of per-skill registration.
#   [:subcommand]  optional RALPH_SUBCOMMAND narrowing (e.g. caretake:triage).
#   <command-key>  one or more command keys in ralph-state-machine.json
#                  (short form "plan" resolves to "ralph_plan"). The allowlist
#                  is the UNION of the keys' valid_output_states plus their
#                  lock_states — multi-mode verbs pass one key per mode
#                  (e.g. "plan plan_epic review" for /ralph:plan's five modes).
#
# Semantic intents (__LOCK__, __COMPLETE__, __ESCALATE__, __CLOSE__,
# __CANCEL__) always pass through: the MCP save_issue tool resolves them to
# concrete states server-side.
#
# Exit codes:
#   0 - Allowed (out of scope, no state change, semantic intent, valid state,
#       or gate misconfiguration — fails open with a loud stderr warning)
#   2 - Blocked (target state not in the union allowlist)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"

scope="${1:?usage: state-gate.sh <scope>[:<subcommand>] <command-key>...}"
shift
if [[ $# -lt 1 ]]; then
  echo "state-gate.sh: at least one state-machine command key is required" >&2
  exit 0
fi

scope_cmd="${scope%%:*}"
scope_sub=""
[[ "$scope" == *:* ]] && scope_sub="${scope#*:}"

if [[ "${RALPH_COMMAND:-}" != "$scope_cmd" ]]; then
  allow
fi
if [[ -n "$scope_sub" && "${RALPH_SUBCOMMAND:-}" != "$scope_sub" ]]; then
  allow
fi

read_input > /dev/null

# save_issue uses `workflowState`; advance_issue uses `targetState`.
new_state=$(get_field '.tool_input.workflowState')
if [[ -z "$new_state" ]]; then
  new_state=$(get_field '.tool_input.targetState')
fi
if [[ -z "$new_state" ]]; then
  allow # Not a state update (label-only save, advance without target, ...)
fi

if is_semantic_intent "$new_state"; then
  allow_with_context "Semantic intent '$new_state' is resolved server-side; state-gate defers to MCP."
fi

state_machine="$SCRIPT_DIR/ralph-state-machine.json"
# Line 1: union of valid_output_states + lock_states; line 2: lock_states only.
gate_data=$(jq -r --arg keys "$*" '
  ($keys | split(" ") | map(if startswith("ralph_") then . else "ralph_" + . end)) as $ks
  | [ $ks[] as $k | .commands[$k] // {} ] as $cmds
  | ([ $cmds[] | (.lock_state // empty) ] | unique) as $locks
  | (([ $cmds[] | (.valid_output_states // [])[] ] + $locks) | unique) as $valid
  | ($valid | join(",")), ($locks | join(","))
' "$state_machine" 2>/dev/null || true)

valid_output=$(sed -n 1p <<<"$gate_data")
lock_states=$(sed -n 2p <<<"$gate_data")

if [[ -z "$valid_output" ]]; then
  # Unknown command keys or unreadable state machine: a registration bug, not
  # an agent error. Fail open so a misconfigured gate can't brick the skill,
  # but say so loudly.
  echo "WARNING: state-gate.sh found no valid_output_states for keys '$*' in $state_machine — allowing without validation." >&2
  allow
fi

if [[ -n "$lock_states" ]] && validate_state "$new_state" "$lock_states"; then
  allow_with_context "Acquiring lock state: $new_state. You now have exclusive ownership of this ticket."
fi

if ! validate_state "$new_state" "$valid_output"; then
  block "Invalid state transition

Command: ${RALPH_COMMAND:-$scope_cmd}
Attempted state: $new_state
Valid output states: $valid_output
Valid semantic intents: __LOCK__, __COMPLETE__, __ESCALATE__, __CLOSE__, __CANCEL__

This command can only transition to: $valid_output"
fi

allow
