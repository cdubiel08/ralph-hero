#!/bin/bash
# Ralph Autonomous Development Loop
#
# Usage: ./scripts/ralph-loop.sh [--research-only|--plan-only|--impl-only|--triage-only]
#
# Runs: triage -> research -> plan -> implement in sequence
# Repeats until no eligible tickets in any queue

set -e

# Check configuration
if [ ! -f ".ralph/config.json" ]; then
    echo "Error: Ralph not configured. Run '/ralph:setup' first."
    exit 1
fi

MODE="${1:-all}"
MAX_ITERATIONS="${MAX_ITERATIONS:-10}"
TIMEOUT="${TIMEOUT:-15m}"

echo "=========================================="
echo "  RALPH AUTONOMOUS DEV LOOP"
echo "=========================================="
echo "Mode: $MODE"
echo "Max iterations: $MAX_ITERATIONS"
echo "Timeout per task: $TIMEOUT"
echo ""

run_claude() {
    local command="$1"

    echo ">>> Running: $command"
    echo ">>> Timeout: $TIMEOUT"
    echo ""

    # Run claude in print mode (non-interactive) with auto-accept permissions
    # -p runs in print mode without requiring TTY
    # --dangerously-skip-permissions auto-accepts all tool calls
    timeout "$TIMEOUT" claude -p "$command" --dangerously-skip-permissions 2>&1 || {
        local exit_code=$?
        if [ $exit_code -eq 124 ]; then
            echo ">>> Task timed out after $TIMEOUT"
        else
            echo ">>> Task exited with code $exit_code"
        fi
    }

    echo ""
    echo ">>> Completed: $command"
    echo ""
}

iteration=0
while [ $iteration -lt $MAX_ITERATIONS ]; do
    iteration=$((iteration + 1))
    echo "=========================================="
    echo "  Iteration $iteration of $MAX_ITERATIONS"
    echo "=========================================="

    # Triage phase
    if [ "$MODE" = "all" ] || [ "$MODE" = "--triage-only" ]; then
        echo "--- Triage Phase ---"
        run_claude "/ralph:triage"
    fi

    # Research phase
    if [ "$MODE" = "all" ] || [ "$MODE" = "--research-only" ]; then
        echo "--- Research Phase ---"
        run_claude "/ralph:research"
    fi

    # Planning phase
    if [ "$MODE" = "all" ] || [ "$MODE" = "--plan-only" ]; then
        echo "--- Planning Phase ---"
        run_claude "/ralph:plan"
    fi

    # Implementation phase
    if [ "$MODE" = "all" ] || [ "$MODE" = "--impl-only" ]; then
        echo "--- Implementation Phase ---"
        run_claude "/ralph:impl"
    fi

    # Brief pause between iterations
    sleep 5
done

echo "=========================================="
echo "  Loop complete after $iteration iterations"
echo "=========================================="
