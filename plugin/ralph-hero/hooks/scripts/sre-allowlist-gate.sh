#!/bin/bash
# ralph-hero/hooks/scripts/sre-allowlist-gate.sh
#
# PreToolUse:Bash content filter for sre-fixit and log-reader agents.
#
# Problem: Both agents list `Bash` unrestricted in `tools:`. The `tools:` field
# is a tool-NAME allowlist (gates which tools are available), NOT a
# command-CONTENT filter. So the kubectl-only restriction for sre-fixit and
# the gcloud-read-only restriction for log-reader live only in markdown prose
# unless this hook enforces them at the runtime layer.
#
# This hook inspects `tool_input.command` for Bash calls inside the two
# restricted agents and exits 2 on any command that falls outside the
# approved set. All other agent_types pass through immediately (exit 0).
#
# Registered in: plugin/ralph-hero/hooks.json (plugin-level, PreToolUse:Bash)
# Pattern reference: plugin/ralph-hero/hooks/scripts/split-estimate-gate.sh
#
# Allowed sets (enforced here, not in prose):
#
#   sre-fixit:
#     kubectl scale deployment <name> --replicas=<N>
#     kubectl drain node <name> [flags]
#     kubectl rollout restart deployment/<name>
#     kubectl delete pod <name>
#     (No --force, no --cascade=foreground, no node-pool ops, no node deletion)
#
#   log-reader:
#     gcloud logging read '...' [--limit=N] [--project=P] [--format=json]
#     gcloud monitoring metrics list [--filter='...'] [--project=P]
#     (No gcloud write/mutate commands, no kubectl, no arbitrary shell)
#
# Exit codes:
#   0 - Allowed (any agent_type other than sre-fixit/log-reader, or permitted command)
#   2 - Blocked (sre-fixit or log-reader with a non-allowlisted command)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

agent_type=$(get_agent_type)

# --- Pass-through: not a restricted agent --------------------------------
if [[ "$agent_type" != "sre-fixit" && "$agent_type" != "log-reader" ]]; then
  allow
fi

command_text=$(get_field '.tool_input.command')

if [[ -z "$command_text" ]]; then
  # No command string (could be a script heredoc or empty call). Allow but warn.
  warn "sre-allowlist-gate.sh: empty command for agent_type='${agent_type}'; allowing."
fi

# =========================================================================
# sre-fixit: kubectl-only allowlist
# =========================================================================
if [[ "$agent_type" == "sre-fixit" ]]; then
  # Match the four permitted kubectl command shapes.
  # Each pattern is anchored to the start of the effective command (after optional
  # leading whitespace) so an embedded forbidden command on a second line still
  # triggers the block path.
  #
  # Allowed patterns (all require starting with 'kubectl'):
  #   kubectl scale deployment <name> --replicas=<N>
  #   kubectl drain node <name> [--ignore-daemonsets ...]  (no --force, no --cascade)
  #   kubectl rollout restart deployment/<name>
  #   kubectl delete pod <name>
  #
  # Forbidden: any non-kubectl command, kubectl delete deployment/node/service,
  #            kubectl create/apply/patch, gcloud, rm, curl, etc.

  # Strip leading whitespace for matching
  trimmed_cmd=$(echo "$command_text" | sed 's/^[[:space:]]*//')

  # Must start with "kubectl" — no other commands permitted.
  if ! echo "$trimmed_cmd" | grep -qE '^kubectl '; then
    block "BLOCKED: sre-allowlist-gate — sre-fixit agent may only run kubectl commands.

Agent:   sre-fixit
Command: ${command_text}

Enforcement: plugin/ralph-hero/hooks/scripts/sre-allowlist-gate.sh (PreToolUse:Bash)
Authority:   GH-1270 Feature-specific Constraint 13

Permitted kubectl shapes:
  kubectl scale deployment <name> --replicas=<N>
  kubectl drain node <name>
  kubectl rollout restart deployment/<name>
  kubectl delete pod <name>

Non-kubectl commands must be escalated to a human SRE."
  fi

  # Reject --force and --cascade=foreground in all forms.
  if echo "$command_text" | grep -qE '(--force\b|--cascade=foreground)'; then
    block "BLOCKED: sre-allowlist-gate — forbidden flags detected.

Agent:   sre-fixit
Command: ${command_text}
Reason:  --force and --cascade=foreground are explicitly forbidden by Constraint 13.

Remove the forbidden flag and retry. If the operation genuinely requires --force,
a human SRE must evaluate and execute it manually."
  fi

  # Check the command matches one of the four allowed shapes exactly.
  # A command is allowed if it matches ONE of:
  #   kubectl scale deployment ...
  #   kubectl drain node ...
  #   kubectl rollout restart ...
  #   kubectl delete pod ...
  if echo "$trimmed_cmd" | grep -qE '^kubectl (scale deployment |drain node |rollout restart |delete pod )'; then
    allow
  fi

  # It's a kubectl command but doesn't match any allowed shape.
  block "BLOCKED: sre-allowlist-gate — kubectl command not in allowlist.

Agent:   sre-fixit
Command: ${command_text}

The following kubectl operations are NOT allowlisted:
  kubectl delete deployment / node / service / namespace / ...
  kubectl create / apply / patch / edit
  kubectl exec / cp / port-forward
  kubectl cordon / uncordon (use drain instead for node isolation)
  gcloud container node-pools / gcloud projects / gcloud compute

Enforcement: plugin/ralph-hero/hooks/scripts/sre-allowlist-gate.sh (PreToolUse:Bash)
Authority:   GH-1270 Feature-specific Constraint 13

Invoke the refusal protocol: post an escalation comment and move the issue to
Human Needed rather than attempting the operation."
fi

# =========================================================================
# log-reader: gcloud read-only allowlist
# =========================================================================
if [[ "$agent_type" == "log-reader" ]]; then
  # Strip leading whitespace for matching
  trimmed_cmd=$(echo "$command_text" | sed 's/^[[:space:]]*//')

  # Permitted shapes (all must start with 'gcloud'):
  #   gcloud logging read '...' [--limit=N] [--project=P] [--format=json]
  #   gcloud monitoring metrics list [--filter='...'] [--project=P]
  #
  # Forbidden: any non-gcloud command, gcloud write/mutate subcommands,
  #            kubectl, rm, curl, python, etc.

  # Must start with "gcloud" — no other commands permitted.
  if ! echo "$trimmed_cmd" | grep -qE '^gcloud '; then
    block "BLOCKED: sre-allowlist-gate — log-reader agent may only run gcloud read commands.

Agent:   log-reader
Command: ${command_text}

Enforcement: plugin/ralph-hero/hooks/scripts/sre-allowlist-gate.sh (PreToolUse:Bash)
Authority:   GH-1270 Feature-specific Constraint 14 / log-reader read-only contract

Permitted command shapes:
  gcloud logging read '<filter>' [--limit=N] [--project=P] [--format=json]
  gcloud monitoring metrics list [--filter='...'] [--project=P]

Return findings under ## Findings. Do not attempt write or remediation actions."
  fi

  # Allowed gcloud subcommand groups: 'logging read' and 'monitoring metrics list'.
  # Reject all other gcloud subcommands (including gcloud projects, gcloud compute,
  # gcloud container, gcloud logging write/delete, gcloud monitoring policies, etc.)
  if echo "$trimmed_cmd" | grep -qE '^gcloud logging read\b'; then
    allow
  fi

  if echo "$trimmed_cmd" | grep -qE '^gcloud monitoring metrics list\b'; then
    allow
  fi

  # gcloud command but not an allowed read subcommand.
  block "BLOCKED: sre-allowlist-gate — gcloud subcommand not in log-reader allowlist.

Agent:   log-reader
Command: ${command_text}

Only the following gcloud read operations are permitted:
  gcloud logging read '...'            — query log entries
  gcloud monitoring metrics list ...   — list available metric types

Rejected subcommands include (but are not limited to):
  gcloud logging write / delete
  gcloud monitoring policies create / update / delete
  gcloud projects / gcloud compute / gcloud container
  gcloud iam / gcloud storage

Enforcement: plugin/ralph-hero/hooks/scripts/sre-allowlist-gate.sh (PreToolUse:Bash)
Authority:   GH-1270 Feature-specific Constraint 14 / log-reader read-only contract"
fi
