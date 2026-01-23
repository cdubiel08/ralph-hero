#!/bin/bash
# Validate Linear configuration before Linear API operations
# Exit 0 = proceed, Exit 2 = block with message
#
# This hook runs before Linear update/create operations to ensure
# Ralph is properly configured before modifying tickets.

set -e

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

if [ ! -f "$PROJECT_ROOT/.ralph/config.json" ]; then
    echo "Ralph configuration required. Run /ralph:setup first." >&2
    exit 2  # Block the operation
fi

# Validate required Linear fields exist
if command -v jq &> /dev/null; then
    TEAM_ID=$(jq -r '.linear.teamId // empty' "$PROJECT_ROOT/.ralph/config.json" 2>/dev/null)
    if [ -z "$TEAM_ID" ]; then
        echo "Linear team ID missing from config. Run /ralph:setup --reconfigure" >&2
        exit 2
    fi

    TEAM_NAME=$(jq -r '.linear.teamName // empty' "$PROJECT_ROOT/.ralph/config.json" 2>/dev/null)
    if [ -z "$TEAM_NAME" ]; then
        echo "Linear team name missing from config. Run /ralph:setup --reconfigure" >&2
        exit 2
    fi
fi

exit 0  # Configuration valid, proceed
