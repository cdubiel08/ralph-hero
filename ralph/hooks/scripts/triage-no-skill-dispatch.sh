#!/bin/bash
# ralph/hooks/scripts/triage-no-skill-dispatch.sh
# PreToolUse:Skill — Block Skill() dispatch when RALPH_SUBCOMMAND=triage.
#
# Triage is self-contained: it assesses ONE Backlog issue and routes it via
# state transition. Downstream work happens when the next loop tick picks up
# the routed issue via the appropriate verb's --auto (e.g., /ralph:plan --auto
# picks up issues routed to "Ready for Plan"). Triage delegating into other
# verbs via Skill() would cascade scope, break loop discipline, and undermine
# the per-verb --auto contract.
#
# This hook does NOT block Agent() calls (triage legitimately uses sub-agents
# like codebase-locator for assessment) or MCP tool calls (triage's core work
# is get_issue / save_issue / add_dependency / create_comment). It is narrowly
# scoped to Skill dispatches only.
#
# Scope guard: passes through silently when RALPH_SUBCOMMAND != triage.
#
# Exit codes:
#   0 - Pass through (not in triage scope, or not a Skill call)
#   2 - Blocked: Skill() dispatch from within triage

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Scope: only fires when caretake --mode triage is active.
if [[ "${RALPH_SUBCOMMAND:-}" != "triage" ]]; then
  allow
fi

read_input > /dev/null

# We only block Skill tool calls. Agent() and MCP tools pass through.
tool_name=$(get_field '.tool_name')
if [[ "$tool_name" != "Skill" ]]; then
  allow
fi

cat >&2 <<'EOF'
═══════════════════════════════════════════════════════════════
 Triage Skill() dispatch blocked
═══════════════════════════════════════════════════════════════
caretake --mode triage is self-contained — it assesses ONE
issue and routes it via state transition. Downstream work
happens when the next loop tick picks up the routed issue via
the appropriate verb's --auto.

If you need to delegate work, route the issue (ROUTE-TO-...)
and let the loop handle it. If you genuinely need to invoke
another skill from triage, that's a design change — propose
it as a plan iteration, not a runtime override.
═══════════════════════════════════════════════════════════════
EOF
exit 2
