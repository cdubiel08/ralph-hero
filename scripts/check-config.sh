#!/bin/bash
# Check Ralph configuration on session start
# Exit 0 = OK, output hints to stderr for context
#
# This hook runs on SessionStart to inform users of Ralph's configuration status.
# It does not block - just provides context.

set -e

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

if [ -f "$PROJECT_ROOT/.ralph/config.json" ]; then
    # Configuration exists - provide context
    if command -v jq &> /dev/null; then
        TEAM_NAME=$(jq -r '.linear.teamName // "Unknown"' "$PROJECT_ROOT/.ralph/config.json" 2>/dev/null || echo "Unknown")
        echo "Ralph Hero configured for team: $TEAM_NAME" >&2
    else
        echo "Ralph Hero configured (install jq for details)" >&2
    fi
    exit 0
else
    # Not configured - inform user
    echo "Ralph Hero not configured. Run /ralph:setup to begin." >&2
    exit 0  # Don't block, just inform
fi
