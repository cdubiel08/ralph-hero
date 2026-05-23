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

# Find a doc CREATED today by the autonomous research flow. The slim plugin
# scopes this hook tighter than the source ralph-hero copy (which scanned the
# last 60 min and could block on unrelated stale edits): we only validate a
# file whose name starts with today's YYYY-MM-DD prefix and was modified in the
# last 15 min (matching the autonomous flow's 15-minute budget).
today=$(date +%Y-%m-%d)
doc=$(find "$artifact_dir" -name "${today}-*.md" -type f -mmin -15 2>/dev/null | xargs -r ls -t 2>/dev/null | head -1)

if [[ -z "$doc" ]]; then
  allow
fi

errors=()

case "$command" in
  research)
    # Section names match ralph/skills/research/findings-format.md § Section order.
    grep -qiE "^## (Prior Work|Research Question)" "$doc" || errors+=("Missing: '## Prior Work' or '## Research Question' header")
    grep -qiE "^## (Summary|Detailed Findings)" "$doc" || errors+=("Missing: '## Summary' or '## Detailed Findings' header")
    grep -qiE "^## Files Affected" "$doc" || errors+=("Missing: '## Files Affected' header (required by --mode auto per findings-format.md)")
    grep -qE '`[^`]+`' "$doc" || errors+=("Missing: backtick-wrapped file paths (e.g., \`src/file.ts\`) — referenced findings should use code-spans")
    ;;
  plan)
    # Section names match ralph/skills/plan/plan-shapes.md § Section order.
    grep -qE "^## Phase [0-9]" "$doc" || errors+=("Missing: '## Phase N:' header pattern (e.g., '## Phase 1: ...')")
    grep -qE "^#### (Automated|Manual) Verification" "$doc" || errors+=("Missing: '#### Automated Verification' or '#### Manual Verification' subsections")
    grep -qE "^- \[ \]" "$doc" || errors+=("Missing: success-criteria checkboxes '- [ ] ...'")
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
