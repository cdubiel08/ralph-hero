#!/bin/bash
# ralph-hero/hooks/scripts/doc-structure-validator.sh
# Stop: Validate required sections in documents created during the skill session
#
# Exit codes:
#   0 - Structure valid or no recent document found
#   2 - Missing required sections, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

command="${RALPH_COMMAND:-}"
if [[ -z "$command" ]]; then
  allow
fi

project_root="$(get_project_root)"

case "$command" in
  research)
    artifact_dir="$project_root/thoughts/shared/research"
    ;;
  plan)
    artifact_dir="$project_root/thoughts/shared/plans"
    ;;
  review)
    artifact_dir="$project_root/thoughts/shared/reviews"
    ;;
  *)
    allow
    ;;
esac

# Find most recently modified markdown file in artifact dir (within last 60 min)
doc=$(find "$artifact_dir" -name "*.md" -type f -mmin -60 2>/dev/null | xargs -r ls -t 2>/dev/null | head -1)

if [[ -z "$doc" ]]; then
  allow
fi

errors=()

case "$command" in
  research)
    grep -qi "problem\|overview" "$doc" || errors+=("Missing: Problem statement (section with 'problem' or 'overview')")
    grep -qi "analysis\|current state" "$doc" || errors+=("Missing: Analysis (section with 'analysis' or 'current state')")
    grep -qi "discover\|finding" "$doc" || errors+=("Missing: Discoveries (section with 'discover' or 'finding')")
    grep -qi "approach" "$doc" || errors+=("Missing: Approaches (section with 'approach')")
    grep -qi "risk" "$doc" || errors+=("Missing: Risks (section with 'risk')")
    grep -qi "next step\|recommendation" "$doc" || errors+=("Missing: Next steps (section with 'next step' or 'recommendation')")
    ;;
  plan)
    grep -qE "^## Phase [0-9]" "$doc" || errors+=("Missing: ## Phase N: header pattern (e.g., '## Phase 1: ...')")
    grep -qE "^\- \[ \] (Automated|Manual):" "$doc" || errors+=("Missing: Success criteria format '- [ ] Automated:' or '- [ ] Manual:'")
    ;;
  review)
    grep -qE "APPROVED|NEEDS_ITERATION" "$doc" || errors+=("Missing: Verdict (APPROVED or NEEDS_ITERATION)")
    ;;
esac

if [[ ${#errors[@]} -gt 0 ]]; then
  error_list=$(printf '%s\n' "${errors[@]}")
  block "Document structure validation failed

Document: $doc

Missing required sections:
$error_list

Fix the document to include all required sections before the skill can complete."
fi

echo "Document structure validated: $doc"
allow
