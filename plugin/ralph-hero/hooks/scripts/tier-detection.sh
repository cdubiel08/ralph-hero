#!/bin/bash
# ralph-hero/hooks/scripts/tier-detection.sh
# Utility: determines issue tier from estimate, children, and plan reference.
# Sourced by other hooks — NOT a standalone hook.
#
# Usage:
#   source "$(dirname "$0")/tier-detection.sh"
#   tier=$(detect_tier "$estimate" "$has_children" "$has_plan_reference")
#
# Returns one of: epic, feature, atomic, standalone

detect_tier() {
  local estimate="${1:-}"
  local has_children="${2:-false}"
  local has_plan_reference="${3:-false}"

  # Parent-planned atomic: has a ## Plan Reference comment
  if [[ "$has_plan_reference" == "true" ]]; then
    echo "atomic"
    return
  fi

  # Has children: tier depends on estimate size
  if [[ "$has_children" == "true" ]]; then
    case "$estimate" in
      L|XL) echo "epic" ;;
      *)    echo "feature" ;;
    esac
    return
  fi

  # No children, no plan reference: standalone
  echo "standalone"
}
