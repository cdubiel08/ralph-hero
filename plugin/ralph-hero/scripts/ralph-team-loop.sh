#!/bin/bash
# Run the Ralph GitHub team orchestrator
#
# Usage: ./scripts/ralph-team-loop.sh [ISSUE_NUMBER]
#
# Launches the team coordinator skill which spawns specialized workers
# for each pipeline phase (analyst, builder, validator, integrator).
#
# Arguments:
#   ISSUE_NUMBER  Optional GitHub issue number to process. If not provided,
#                 the team coordinator will scan for eligible work across
#                 all pipeline states.

set -e

ISSUE_NUMBER="${1:-}"
TIMEOUT="${TIMEOUT:-30m}"

echo "=========================================="
echo "  RALPH GITHUB TEAM - Multi-Agent Mode"
echo "=========================================="
if [ -n "$ISSUE_NUMBER" ]; then
    echo "Target issue: #$ISSUE_NUMBER"
else
    echo "Target: Auto-detect eligible work"
fi
echo "Timeout: $TIMEOUT"
echo ""

if [ -n "$ISSUE_NUMBER" ]; then
    COMMAND="/ralph-hero:ralph-team $ISSUE_NUMBER"
else
    COMMAND="/ralph-hero:ralph-team"
fi

echo ">>> Running: $COMMAND"
echo ">>> Timeout: $TIMEOUT"
echo ""

timeout "$TIMEOUT" claude -p "$COMMAND" --dangerously-skip-permissions 2>&1 || {
    exit_code=$?
    if [ $exit_code -eq 124 ]; then
        echo ">>> Team orchestrator timed out after $TIMEOUT"
    else
        echo ">>> Team orchestrator exited with code $exit_code"
    fi
}

echo ""
echo "=========================================="
echo "  Team orchestrator complete"
echo "=========================================="
