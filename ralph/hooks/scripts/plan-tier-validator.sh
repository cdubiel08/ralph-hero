#!/bin/bash
# ralph/hooks/scripts/plan-tier-validator.sh
# PreToolUse:Write — sanity-check plan-doc shape when writing under
# thoughts/shared/plans/.
#
# Closes GH-1380. The source-plugin design used `RALPH_COMMAND=plan_epic`
# at SessionStart to set `RALPH_PLAN_TYPE=plan-of-plans`, then this
# validator gated `save_issue` on the env var. The slim plugin collapses
# to a single `RALPH_COMMAND=plan` with `--mode epic` as a body-level
# flag — so SessionStart can never know which tier is being authored.
# The env-driven validator therefore silently no-opped on every run.
#
# Slim redesign: self-discriminate from the plan-doc shape being written.
# Fire on PreToolUse:Write, inspect tool_input.content (or the file_path
# if content isn't carried in the input), check for the two recognized
# shapes:
#   - `## Feature Decomposition` → plan-of-plans (epic shape)
#   - `## Phase 1:` (or any `## Phase N:`) → regular plan shape
#
# Warn (not block) on missing both — the doc may be a legitimate partial
# write (intermediate edit). Block only on the unambiguous corruption
# signal of BOTH shapes present in the same doc.
#
# Exit codes:
#   0 - shape OK or hook not applicable
#   2 - both plan-of-plans AND regular plan shapes in one doc (corruption)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Only activate inside /ralph:plan.
if [[ "${RALPH_COMMAND:-}" != "plan" ]]; then
  allow
fi

read_input > /dev/null

file_path=$(get_field '.tool_input.file_path')
if [[ -z "$file_path" ]]; then
  allow
fi

# Only inspect files under thoughts/shared/plans/. Other Writes (test
# fixtures, README updates, etc.) are not in scope.
case "$file_path" in
  *thoughts/shared/plans/*) ;;
  *) allow ;;
esac

# Read the content being written. PreToolUse on Write carries it in
# tool_input.content. Append `|| true` so a missing field under pipefail
# doesn't crash the hook.
content=$(get_field '.tool_input.content' || true)
if [[ -z "$content" ]]; then
  # Some Edits may not provide full content (e.g. Edit with old_string/
  # new_string instead of Write). Read the existing file if present —
  # the gate then validates the post-edit state on next Write.
  if [[ -f "$file_path" ]]; then
    content=$(cat "$file_path" 2>/dev/null || true)
  fi
  if [[ -z "$content" ]]; then
    allow  # Nothing to inspect, let the write proceed.
  fi
fi

has_feature_decomp=false
has_phase_section=false

if echo "$content" | grep -qE '^## Feature Decomposition\b'; then
  has_feature_decomp=true
fi

if echo "$content" | grep -qE '^## Phase [0-9]+'; then
  has_phase_section=true
fi

# Both shapes in one doc = corruption signal.
if [[ "$has_feature_decomp" == "true" && "$has_phase_section" == "true" ]]; then
  block "plan-tier-validator: plan doc has BOTH '## Feature Decomposition' AND '## Phase N:' sections.

File: $file_path

A plan-of-plans (epic shape) uses '## Feature Decomposition' to enumerate
child features. A regular plan uses '## Phase N:' sections for ordered
implementation work. Mixing both shapes in one doc is a corruption
signal — usually a mistaken --mode epic invocation against a regular-
plan template, or vice versa.

Resolve by:
  1. Pick the intended tier (epic vs regular plan).
  2. Remove the sections that belong to the other tier.
  3. Re-run /ralph:plan with --mode epic for epics or default for regular plans.

See ralph/skills/plan/plan-shapes.md for both shape definitions."
fi

# Missing both shapes → warn (intermediate edit may be legitimate; user-
# facing prose, frontmatter-only commits, partial writes all benign).
if [[ "$has_feature_decomp" == "false" && "$has_phase_section" == "false" ]]; then
  echo "WARNING: plan-tier-validator: plan doc has neither '## Feature Decomposition' nor '## Phase N:' sections. If this is an intermediate edit (frontmatter or prose tweak), ignore. Otherwise the plan may be missing its structural shape." >&2
fi

allow
