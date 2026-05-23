#!/bin/bash
# ralph/hooks/scripts/plan-tier-validator.sh
# PreToolUse:Write|Edit — sanity-check plan-doc shape when writing under
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
# Fire on PreToolUse:Write AND Edit, inspect the post-write/post-edit
# content for the two recognized shapes:
#   - `## Feature Decomposition` → plan-of-plans (epic shape)
#   - `## Phase 1:` (or any `## Phase N:`) → regular plan shape
#
# Code-fence aware: strip ```...``` fenced blocks before pattern matching
# so a plan-of-plans that documents the sibling shape via fenced examples
# (a common pattern — see ralph/skills/plan/plan-shapes.md) does NOT
# false-positive on the documentation.
#
# Edit support: when tool_input.content is absent (Edit shape), compose
# the post-edit content by applying new_string to the existing file.
# This catches the iterate-mode corruption vector (Edit that adds the
# wrong shape's section) that a Write-only matcher would miss.
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
# fixtures, README updates, etc.) are not in scope. Trailing slash in
# the glob is load-bearing — without it, plans-archive/, plans-old/,
# and plans.md would all trigger.
case "$file_path" in
  *thoughts/shared/plans/*) ;;
  *) allow ;;
esac

# Compose the content to inspect. Three shapes:
#   1. Write with tool_input.content → use content directly.
#   2. Edit with tool_input.new_string → apply to existing file (or use
#      new_string alone if file doesn't exist).
#   3. Neither (unexpected tool shape) → allow.

content=$(get_field '.tool_input.content' || true)

if [[ -z "$content" ]]; then
  # Edit-shape: compose post-edit content from old_string + new_string.
  new_string=$(get_field '.tool_input.new_string' || true)
  if [[ -n "$new_string" && -f "$file_path" ]]; then
    old_string=$(get_field '.tool_input.old_string' || true)
    if [[ -n "$old_string" ]]; then
      # Use python for safe string replacement (avoids shell-escape
      # nightmares with arbitrary content). Falls back to allow if
      # python is unavailable — Edit support is best-effort.
      if command -v python3 >/dev/null 2>&1; then
        content=$(python3 -c "
import sys
with open('$file_path', 'r') as f:
    src = f.read()
old = sys.stdin.read().split('---OLD-NEW-SEP---')[0]
new = sys.stdin.read().split('---OLD-NEW-SEP---')[1] if '---OLD-NEW-SEP---' in (old + new) else ''
print(src.replace(old, new))
" <<< "${old_string}---OLD-NEW-SEP---${new_string}" 2>/dev/null || true)
      fi
    fi
  fi

  if [[ -z "$content" ]]; then
    allow  # Nothing reliable to inspect.
  fi
fi

# Strip fenced code blocks (```...```) so a plan-of-plans documenting
# the sibling shape via inline examples doesn't false-positive. awk
# toggles a flag on each ``` line; lines inside a fence are skipped.
stripped=$(printf '%s\n' "$content" | awk '
  /^```/  { in_fence = !in_fence; next }
  !in_fence { print }
')

has_feature_decomp=false
has_phase_section=false

if printf '%s\n' "$stripped" | grep -qE '^## Feature Decomposition([[:space:]]|$)'; then
  has_feature_decomp=true
fi

if printf '%s\n' "$stripped" | grep -qE '^## Phase [0-9]+'; then
  has_phase_section=true
fi

# Both shapes in one doc (outside code fences) = corruption signal.
if [[ "$has_feature_decomp" == "true" && "$has_phase_section" == "true" ]]; then
  block "plan-tier-validator: plan doc has BOTH '## Feature Decomposition' AND '## Phase N:' sections (outside code fences).

File: $file_path

A plan-of-plans (epic shape) uses '## Feature Decomposition' to enumerate
child features. A regular plan uses '## Phase N:' sections for ordered
implementation work. Mixing both shapes in one doc (outside fenced code
blocks) is a corruption signal — usually a mistaken --mode epic
invocation against a regular-plan template, or vice versa.

Note: code-fence content (\`\`\`markdown ... \`\`\`) is excluded from
this check, so documenting the sibling shape via inline examples is fine.

Resolve by:
  1. Pick the intended tier (epic vs regular plan).
  2. Remove the sections that belong to the other tier (or move them
     inside code fences if they were illustrative examples).
  3. Re-run /ralph:plan with --mode epic for epics or default for regular plans.

See ralph/skills/plan/plan-shapes.md for both shape definitions."
fi

# Missing both shapes → warn (intermediate edit may be legitimate; user-
# facing prose, frontmatter-only commits, partial writes all benign).
if [[ "$has_feature_decomp" == "false" && "$has_phase_section" == "false" ]]; then
  echo "WARNING: plan-tier-validator: plan doc has neither '## Feature Decomposition' nor '## Phase N:' sections (excluding code fences). If this is an intermediate edit (frontmatter or prose tweak), ignore. Otherwise the plan may be missing its structural shape." >&2
fi

allow
