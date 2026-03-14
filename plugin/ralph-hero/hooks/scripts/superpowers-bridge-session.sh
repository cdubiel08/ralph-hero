#!/bin/bash
# ralph-hero/hooks/scripts/superpowers-bridge-session.sh
# SessionStart: Detect superpowers plugin and inject integration context
#
# Checks if superpowers is installed by looking for its plugin cache.
# If found, injects additionalContext advising the agent to use
# ralph-hero artifact paths and frontmatter conventions.

set -euo pipefail

# Check if superpowers plugin is installed
SUPERPOWERS_DIR=""
for dir in "${HOME}/.claude/plugins/cache/claude-plugins-official/superpowers"/*/; do
  if [[ -d "$dir/skills" ]]; then
    SUPERPOWERS_DIR="$dir"
  fi
done

if [[ -z "$SUPERPOWERS_DIR" ]]; then
  # Superpowers not installed — nothing to bridge
  exit 0
fi

# Set env var for other hooks to detect bridge mode
if [[ -n "${CLAUDE_ENV_FILE:-}" ]]; then
  echo "export RALPH_SUPERPOWERS_BRIDGE=true" >> "$CLAUDE_ENV_FILE"
fi

CONTEXT="RALPH-HERO + SUPERPOWERS BRIDGE ACTIVE\\n\\nBoth ralph-hero and superpowers plugins are installed. When superpowers skills produce artifacts (specs, plans):\\n\\n- Superpowers default paths (docs/superpowers/) are fine for initial drafts\\n- For project management integration, also save to thoughts/shared/ with ralph-hero frontmatter\\n- A PostToolUse hook will provide specific path and frontmatter suggestions after each superpowers artifact write\\n- Use /ralph-hero:bridge-artifact <path> to migrate any superpowers artifact to ralph-hero format\\n\\nSuperpowers artifact mapping:\\n  docs/superpowers/specs/*  →  thoughts/shared/research/*\\n  docs/superpowers/plans/*  →  thoughts/shared/plans/*"

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "${CONTEXT}"
  }
}
EOF
exit 0
