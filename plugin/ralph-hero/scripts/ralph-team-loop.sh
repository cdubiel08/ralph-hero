#!/bin/bash
# Run the Ralph GitHub team orchestrator
#
# Usage: ./scripts/ralph-team-loop.sh [ISSUE_NUMBER] [--budget=N]
#
# Launches the team coordinator skill which spawns specialized workers
# for each pipeline phase (analyst, builder, integrator).
#
# Arguments:
#   ISSUE_NUMBER  Optional GitHub issue number to process. If not provided,
#                 the team coordinator will scan for eligible work across
#                 all pipeline states.

set -e

# Portable timeout (mirrors cli-dispatch.sh — kept inline because this script runs standalone)
portable_timeout() {
    local duration="$1"; shift
    if command -v timeout &>/dev/null; then
        timeout "$duration" "$@"
        return $?
    fi
    local seconds
    if [[ "$duration" =~ ^([0-9]+)m$ ]]; then
        seconds=$(( ${BASH_REMATCH[1]} * 60 ))
    else
        seconds="$duration"
    fi
    perl -e '
        $SIG{ALRM} = sub { exit 142 };
        alarm(shift @ARGV);
        exec @ARGV or die "exec failed: $!";
    ' -- "$seconds" "$@"
    local rc=$?
    if [ "$rc" -eq 142 ]; then
        return 124
    fi
    return "$rc"
}

ISSUE_NUMBER=""
BUDGET="${RALPH_BUDGET:-10.00}"
for arg in "$@"; do
    case "$arg" in
        --budget=*)
            BUDGET="${arg#*=}"
            ;;
        *)
            if [ -z "$ISSUE_NUMBER" ]; then
                ISSUE_NUMBER="$arg"
            fi
            ;;
    esac
done
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
echo "Budget: \$${BUDGET}"
echo ""

if [ -n "$ISSUE_NUMBER" ]; then
    COMMAND="/ralph-hero:team $ISSUE_NUMBER"
else
    COMMAND="/ralph-hero:team"
fi

echo ">>> Running: $COMMAND"
echo ">>> Timeout: $TIMEOUT"
echo ""

portable_timeout "$TIMEOUT" claude -p "$COMMAND" --max-budget-usd "$BUDGET" --dangerously-skip-permissions 2>&1 || {
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
