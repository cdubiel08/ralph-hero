#!/bin/bash
# Run the Ralph GitHub workflow loop until all queues are empty
#
# Usage: ./scripts/ralph-loop.sh [--triage-only|--split-only|--research-only|--plan-only|--review-only|--impl-only]
#        ./scripts/ralph-loop.sh [--analyst-only|--builder-only|--validator-only|--integrator-only]
#        ./scripts/ralph-loop.sh --split=auto|skip --review=auto|skip|interactive
#
# Runs: triage -> split (optional) -> research -> plan -> review (optional) -> implement in sequence
# Repeats until no eligible tickets in any queue
#
# Review modes:
#   --review=skip        Skip review phase (default, backwards compatible)
#   --review=auto        Opus critiques plan automatically
#   --review=interactive Human reviews via wizard

set -e

# Parse all arguments
MODE="all"
REVIEW_MODE="${RALPH_REVIEW_MODE:-skip}"
SPLIT_MODE="${RALPH_SPLIT_MODE:-auto}"
for arg in "$@"; do
    case "$arg" in
        --review=*)
            REVIEW_MODE="${arg#*=}"
            ;;
        --split=*)
            SPLIT_MODE="${arg#*=}"
            ;;
        --triage-only|--split-only|--research-only|--plan-only|--review-only|--impl-only)
            MODE="$arg"
            ;;
        --analyst-only|--builder-only|--validator-only|--integrator-only)
            MODE="$arg"
            ;;
    esac
done
export RALPH_REVIEW_MODE="$REVIEW_MODE"
export RALPH_SPLIT_MODE="$SPLIT_MODE"
MAX_ITERATIONS="${MAX_ITERATIONS:-10}"
TIMEOUT="${TIMEOUT:-15m}"

echo "=========================================="
echo "  RALPH GITHUB LOOP - Autonomous Mode"
echo "=========================================="
echo "Mode: $MODE"
echo "Split mode: $SPLIT_MODE"
echo "Review mode: $REVIEW_MODE"
echo "Max iterations: $MAX_ITERATIONS"
echo "Timeout per task: $TIMEOUT"
echo ""

run_claude() {
    local command="$1"
    local title="$2"

    echo ">>> Running: $command"
    echo ">>> Timeout: $TIMEOUT"
    echo ""

    # Run claude in print mode (non-interactive) with auto-accept permissions
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

    work_done=false

    # === ANALYST PHASE ===

    # Triage phase
    if [ "$MODE" = "all" ] || [ "$MODE" = "--triage-only" ] || [ "$MODE" = "--analyst-only" ]; then
        echo "--- Analyst: Triage Phase ---"
        run_claude "/ralph-triage" "triage"
        work_done=true
    fi

    # Split phase (after triage, before research)
    if [ "$MODE" = "all" ] || [ "$MODE" = "--split-only" ] || [ "$MODE" = "--analyst-only" ]; then
        if [ "$SPLIT_MODE" != "skip" ]; then
            echo "--- Analyst: Split Phase (mode: $SPLIT_MODE) ---"
            run_claude "/ralph-split" "split"
            work_done=true
        else
            echo "--- Analyst: Split Phase: SKIPPED (--split=skip) ---"
        fi
    fi

    # Research phase
    if [ "$MODE" = "all" ] || [ "$MODE" = "--research-only" ] || [ "$MODE" = "--analyst-only" ]; then
        echo "--- Analyst: Research Phase ---"
        run_claude "/ralph-research" "research"
        work_done=true
    fi

    # === BUILDER PHASE ===

    # Planning phase
    if [ "$MODE" = "all" ] || [ "$MODE" = "--plan-only" ] || [ "$MODE" = "--builder-only" ]; then
        echo "--- Builder: Planning Phase ---"
        run_claude "/ralph-plan" "plan"
        work_done=true
    fi

    # Review phase (optional)
    if [ "$MODE" = "all" ] || [ "$MODE" = "--review-only" ] || [ "$MODE" = "--builder-only" ] || [ "$MODE" = "--validator-only" ]; then
        if [ "$REVIEW_MODE" != "skip" ]; then
            echo "--- Review Phase (mode: $REVIEW_MODE) ---"
            if [ "$REVIEW_MODE" = "interactive" ]; then
                export RALPH_INTERACTIVE="true"
            else
                export RALPH_INTERACTIVE="false"
            fi
            run_claude "/ralph-review" "review"
            work_done=true
        else
            echo "--- Review Phase: SKIPPED (--review=skip) ---"
        fi
    fi

    # Implementation phase
    if [ "$MODE" = "all" ] || [ "$MODE" = "--impl-only" ] || [ "$MODE" = "--builder-only" ]; then
        echo "--- Builder: Implementation Phase ---"
        run_claude "/ralph-impl" "implement"
        work_done=true
    fi

    # === INTEGRATOR PHASE ===
    if [ "$MODE" = "all" ] || [ "$MODE" = "--integrator-only" ]; then
        echo "--- Integrator Phase (report only) ---"
        # Future: run_claude "/ralph-integrate" "integrate"
    fi

    # Brief pause between iterations
    sleep 5
done

echo "=========================================="
echo "  Loop complete after $iteration iterations"
echo "=========================================="
