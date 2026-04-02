#!/usr/bin/env bash
# ralph-hero/hooks/scripts/agent-phase-gate.sh
# PreToolUse (Write|Edit|Bash): Route to phase-specific hooks based on agent_type
#
# When running inside a per-phase agent (agent_type is set), delegate to the
# appropriate phase-specific hook. When RALPH_COMMAND is set (skill context),
# the skill's own hooks handle enforcement — skip entirely.
#
# Exit codes:
#   0 - Allowed (no agent_type, RALPH_COMMAND set, or no matching case)
#   delegates to child scripts for actual enforcement

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null
agent_type=$(get_agent_type)

# Skip when RALPH_COMMAND is set (skill handles its own hooks)
[[ -n "${RALPH_COMMAND:-}" ]] && { allow; exit 0; }

# Only apply phase gates when running inside a per-phase agent
[[ -z "$agent_type" ]] && { allow; exit 0; }

tool_name=$(get_tool_name)

case "$agent_type" in
  impl-agent)
    case "$tool_name" in
      Write|Edit) exec "$(dirname "$0")/impl-plan-required.sh" ;;
      Bash)       exec "$(dirname "$0")/impl-branch-gate.sh" ;;
    esac
    ;;
  research-agent|plan-agent|plan-epic-agent|triage-agent|split-agent|review-agent)
    case "$tool_name" in
      Bash) exec "$(dirname "$0")/branch-gate.sh" ;;
    esac
    ;;
esac

allow
