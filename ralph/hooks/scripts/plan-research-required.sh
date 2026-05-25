#!/bin/bash
# ralph/hooks/scripts/plan-research-required.sh
# PreToolUse (Write): Block plan creation if no research doc — estimate-aware.
#
# This is the slim-only copy. It is intentionally AHEAD of the byte-identical
# plugin/ralph-hero/ twin: the estimate-threshold + human-override waiver paths
# below exist only here until the main plugin catches up.
#
# Allow-paths, in order:
#   1. Path not under /plans/                      -> allow
#   2. RALPH_REQUIRES_RESEARCH != "true"           -> allow (global off-switch)
#   3. No GH-NNNN token in the path                -> allow (no linked ticket)
#   4. A matching research doc exists              -> allow
#   5. Frontmatter carries research_waived: <text> -> allow (human override)
#   6. Frontmatter estimate is below the threshold -> allow (sub-threshold waiver)
# Otherwise -> block.
#
# Environment:
#   RALPH_REQUIRES_RESEARCH               - Global toggle (default: true)
#   RALPH_RESEARCH_REQUIRED_MIN_ESTIMATE  - Estimate at/above which research is
#                                           required (default: M). Estimates
#                                           strictly below it are waived:
#                                             XS -> waives nothing
#                                             S  -> waives XS
#                                             M  -> waives XS, S
#                                             L  -> waives XS, S, M
#                                             XL -> waives XS, S, M, L
#
# Exit codes:
#   0 - Research exists, not required, or waived
#   2 - Research missing, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null
file_path=$(get_field '.tool_input.file_path')

if [[ "$file_path" != *"/plans/"* ]]; then
  allow
fi

if [[ "${RALPH_REQUIRES_RESEARCH:-true}" != "true" ]]; then
  allow
fi

ticket_id=$(echo "$file_path" | grep -oE 'GH-[0-9]+' | head -1 || true)
if [[ -z "$ticket_id" ]]; then
  allow
fi

research_dir="$(get_project_root)/thoughts/shared/research"
research_doc=$(find_existing_artifact "$research_dir" "$ticket_id")

if [[ -n "$research_doc" ]]; then
  allow
fi

# No research doc. Parse the plan frontmatter from the Write content for the
# two new waiver paths. `|| true` keeps each pipeline alive under
# `set -euo pipefail` when grep finds no matching line (mirrors the convention
# in split-estimate-gate.sh).
content=$(get_field '.tool_input.content')
frontmatter=$(printf '%s\n' "$content" \
  | awk 'NR==1 && $0=="---"{f=1; next} f && $0=="---"{exit} f{print}')
estimate=$(printf '%s\n' "$frontmatter" | grep -iE '^estimate:' | head -1 \
  | sed -E 's/^[^:]*:[[:space:]]*//; s/[[:space:]]*$//' | tr -d '"'\''' || true)
waived_reason=$(printf '%s\n' "$frontmatter" | grep -iE '^research_waived:' | head -1 \
  | sed -E 's/^[^:]*:[[:space:]]*//; s/[[:space:]]*$//' || true)

# Human-override waiver.
if [[ -n "$waived_reason" && "$waived_reason" != "null" ]]; then
  allow_with_context "Research requirement waived (human override): $waived_reason"
fi

# Estimate-threshold waiver: waived set = estimates strictly below the threshold.
min_estimate="${RALPH_RESEARCH_REQUIRED_MIN_ESTIMATE:-M}"
case "$min_estimate" in
  XS) waived="" ;;
  S)  waived="XS" ;;
  M)  waived="XS,S" ;;
  L)  waived="XS,S,M" ;;
  XL) waived="XS,S,M,L" ;;
  *)  waived="XS,S" ;;
esac
if [[ -n "$estimate" ]] && validate_state "$estimate" "$waived"; then
  allow_with_context "Research waived: estimate=$estimate below threshold $min_estimate"
fi

block "Research required before planning

Ticket: $ticket_id
Expected: Research document in $research_dir
Found: None

This issue is at/above the research-required estimate threshold ($min_estimate)
and has no research document. Three ways forward:
  1. Run /ralph:research $ticket_id first (creates the research doc).
  2. Set the plan frontmatter estimate below $min_estimate if the work is
     genuinely sub-threshold (XS/S).
  3. Add 'research_waived: <reason>' to the plan frontmatter to record an
     explicit human override."
