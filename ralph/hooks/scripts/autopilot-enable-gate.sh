#!/bin/bash
# ralph-hero/hooks/scripts/autopilot-enable-gate.sh
# PreToolUse:Skill gate for /ralph-hero:autopilot.
#
# Refuses to dispatch the inner /loop /hero unless RALPH_AUTOPILOT_ENABLE=true.
# Deterministic — no LLM in the loop. Invisible on success.
#
# Why a hook (not a Step 0 LLM check):
# - The opt-in gate is a binary precondition; the LLM should never be the one
#   reading the env var and deciding whether to proceed.
# - Failure messages must be deterministic so users get the same instruction
#   every time, not a paraphrase.
#
# Exit codes:
#   0 - Allowed (env var is "true", or this Skill call is not an autonomous
#       hero dispatch — we pass through silently)
#   2 - Blocked (autonomous dispatch attempted but env var not set)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# ---- Scope: derived from the Skill PAYLOAD, not from a model-set env var ------
#
# The scope check used to key on RALPH_SUBCOMMAND ∈ {auto, tick}. That value is
# set by hero/SKILL.md Step 0 with a bare `export` inside a Bash tool call, which
# does NOT propagate to hook subprocesses — only the CLAUDE_ENV_FILE writes from
# set-skill-env.sh do (autopilot-director-postcheck.sh's header records the same
# finding, which is why it keys on RALPH_COMMAND plus the Skill payload). So
# RALPH_SUBCOMMAND is typically EMPTY here and the gate fell straight through to
# `exit 0`, launching unattended automation with RALPH_AUTOPILOT_ENABLE unset.
#
# Beyond the propagation bug it is the wrong kind of signal for a safeguard: the
# skill body the gate constrains is also what exports the variable, so an agent
# that skips Step 0 disarms its own gate. The tool input is harness-supplied and
# cannot be edited by the model, so scope comes from there:
#
#   Skill("loop", args="… /ralph:hero --tick …")            -> the --mode auto launch
#   Skill("ralph:hero", args="--mode auto|--auto|--tick")   -> a direct autonomous dispatch
#
# Env-derived scope is kept BELOW as an additive signal only (legacy
# RALPH_COMMAND=autopilot, plus RALPH_SUBCOMMAND when it does happen to
# propagate, which still covers the child dispatches of a running watcher). It
# can only ADD scope, never remove it.
skill_name=$(get_field '.tool_input.skill')
skill_bare="${skill_name##*:}"
skill_args=$(get_field '.tool_input.args')

# Token-boundary matching (same discipline as autopilot-director-postcheck.sh):
# `/ralph:hero --tickle` and prose quoting `--ticket-…` must not arm the gate.
loop_inner_re='/ralph:hero[[:space:]]+(--tick|--auto|--mode[[:space:]]+auto)([[:space:]]|$)'
hero_arg_re='(^|[[:space:]])(--tick|--auto|--mode[[:space:]]+auto)([[:space:]]|$)'

in_scope=0
if [[ "$skill_bare" == "loop" ]] \
   && printf '%s' "$skill_args" | grep -qE -- "$loop_inner_re"; then
  in_scope=1
elif [[ "$skill_bare" == "hero" ]] \
     && printf '%s' "$skill_args" | grep -qE -- "$hero_arg_re"; then
  in_scope=1
elif [[ "${RALPH_COMMAND:-}" == "autopilot" ]]; then
  in_scope=1
elif [[ "${RALPH_COMMAND:-}" == "hero" \
        && ( "${RALPH_SUBCOMMAND:-}" == "auto" || "${RALPH_SUBCOMMAND:-}" == "tick" ) ]]; then
  in_scope=1
fi

if [[ "$in_scope" -eq 0 ]]; then
  exit 0
fi

if [[ "${RALPH_AUTOPILOT_ENABLE:-false}" != "true" ]]; then
  cat >&2 <<'EOF'
═══════════════════════════════════════════════════════════════
 Autopilot is opt-in.

 Set RALPH_AUTOPILOT_ENABLE=true before invoking, e.g.:

   export RALPH_AUTOPILOT_ENABLE=true
   /ralph:hero --mode auto

 Unattended automation is opt-in by design.
═══════════════════════════════════════════════════════════════
EOF
  exit 2
fi

exit 0
