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

project_root="$(get_project_root)"
today=$(date +%Y-%m-%d)

# Slim plugin: discriminate validator branch by file PATH, not RALPH_COMMAND
# env. The slim ralph multi-mode verbs (e.g., /ralph:plan in --mode review)
# can't reliably flip RALPH_COMMAND mid-session because Bash-tool exports don't
# propagate to hook subprocesses. Path-based discrimination is robust: a doc
# under thoughts/shared/plans/ is a plan doc regardless of the active mode.
#
# Scan all three artifact dirs for a today-prefixed doc modified in the last
# 15 min. Pick the branch by which dir the doc lives in. If multiple dirs have
# fresh docs, the most-recently-modified wins.

doc=""
command=""
for candidate_dir in "thoughts/shared/plans" "thoughts/shared/reviews" "thoughts/shared/research"; do
  found=$(find "$project_root/$candidate_dir" -name "${today}-*.md" -type f -mmin -15 2>/dev/null | xargs -r ls -t 2>/dev/null | head -1)
  if [[ -n "$found" ]]; then
    # Pick the freshest across dirs.
    if [[ -z "$doc" ]] || [[ "$found" -nt "$doc" ]]; then
      doc="$found"
      case "$candidate_dir" in
        thoughts/shared/plans)    command="plan"    ;;
        thoughts/shared/reviews)  command="review"  ;;
        thoughts/shared/research) command="research" ;;
      esac
    fi
  fi
done

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
