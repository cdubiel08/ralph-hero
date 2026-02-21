#!/bin/bash
# Run the Ralph GitHub workflow loop until all queues are empty
#
# Usage: ./scripts/ralph-loop.sh [--triage-only|--split-only|--research-only|--plan-only|--review-only|--impl-only|--hygiene-only]
#        ./scripts/ralph-loop.sh [--analyst-only|--builder-only|--validator-only|--integrator-only]
#        ./scripts/ralph-loop.sh --split=auto|skip --review=auto|skip|interactive --hygiene=auto|skip
#
# Runs: hygiene (optional) -> triage -> split (optional) -> research -> plan -> review (optional) -> implement in sequence
# Repeats until no eligible tickets in any queue
#
# Review modes:
#   --review=skip        Skip review phase (default, backwards compatible)
#   --review=auto        Opus critiques plan automatically
#   --review=interactive Human reviews via wizard
#
# Hygiene modes:
#   --hygiene=auto       Run hygiene before triage (default)
#   --hygiene=skip       Skip hygiene phase

set -e

# Parse all arguments
MODE="all"
REVIEW_MODE="${RALPH_REVIEW_MODE:-skip}"
SPLIT_MODE="${RALPH_SPLIT_MODE:-auto}"
HYGIENE_MODE="${RALPH_HYGIENE_MODE:-auto}"
for arg in "$@"; do
    case "$arg" in
        --review=*)
            REVIEW_MODE="${arg#*=}"
            ;;
        --split=*)
            SPLIT_MODE="${arg#*=}"
            ;;
        --hygiene=*)
            HYGIENE_MODE="${arg#*=}"
            ;;
        --triage-only|--split-only|--research-only|--plan-only|--review-only|--impl-only|--hygiene-only)
            MODE="$arg"
            ;;
        --analyst-only|--builder-only|--validator-only|--integrator-only)
            MODE="$arg"
            ;;
    esac
done
export RALPH_REVIEW_MODE="$REVIEW_MODE"
export RALPH_SPLIT_MODE="$SPLIT_MODE"
export RALPH_HYGIENE_MODE="$HYGIENE_MODE"
MAX_ITERATIONS="${MAX_ITERATIONS:-10}"
TIMEOUT="${TIMEOUT:-15m}"

echo "=========================================="
echo "  RALPH GITHUB LOOP - Autonomous Mode"
echo "=========================================="
echo "Mode: $MODE"
echo "Hygiene mode: $HYGIENE_MODE"
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
    local output
    if output=$(timeout "$TIMEOUT" claude -p "$command" --dangerously-skip-permissions 2>&1); then
        echo "$output"
    else
        local exit_code=$?
        echo "$output"
        if [ $exit_code -eq 124 ]; then
            echo ">>> Task timed out after $TIMEOUT"
            echo "    Continuing to next phase. To increase: TIMEOUT=30m just loop"
        else
            echo ">>> Task exited with code $exit_code"
            echo "    Continuing to next phase. Check output above for details."
            echo "    To diagnose: just doctor"
        fi
    fi

    echo ""
    echo ">>> Completed: $command"
    echo ""

    # Return 1 if queue was empty (no work done)
    if echo "$output" | grep -qi "Queue empty"; then
        return 1
    fi
    return 0
}

iteration=0
while [ $iteration -lt $MAX_ITERATIONS ]; do
    iteration=$((iteration + 1))
    echo "=========================================="
    echo "  Iteration $iteration of $MAX_ITERATIONS"
    echo "=========================================="

    work_done=false

    # === ANALYST PHASE ===

    # Hygiene phase (before triage for clean board scanning)
    if [ "$MODE" = "all" ] || [ "$MODE" = "--hygiene-only" ] || [ "$MODE" = "--analyst-only" ]; then
        if [ "$HYGIENE_MODE" != "skip" ]; then
            echo "--- Analyst: Hygiene Phase (mode: $HYGIENE_MODE) ---"
            run_claude "/ralph-hero:ralph-hygiene" "hygiene"
            work_done=true
        else
            echo "--- Analyst: Hygiene Phase: SKIPPED (--hygiene=skip) ---"
        fi
    fi

    # Triage phase
    if [ "$MODE" = "all" ] || [ "$MODE" = "--triage-only" ] || [ "$MODE" = "--analyst-only" ]; then
        echo "--- Analyst: Triage Phase ---"
        if run_claude "/ralph-hero:ralph-triage" "triage"; then
            work_done=true
        fi
    fi

    # Split phase (after triage, before research)
    if [ "$MODE" = "all" ] || [ "$MODE" = "--split-only" ] || [ "$MODE" = "--analyst-only" ]; then
        if [ "$SPLIT_MODE" != "skip" ]; then
            echo "--- Analyst: Split Phase (mode: $SPLIT_MODE) ---"
            if run_claude "/ralph-hero:ralph-split" "split"; then
                work_done=true
            fi
        else
            echo "--- Analyst: Split Phase: SKIPPED (--split=skip) ---"
        fi
    fi

    # Research phase
    if [ "$MODE" = "all" ] || [ "$MODE" = "--research-only" ] || [ "$MODE" = "--analyst-only" ]; then
        echo "--- Analyst: Research Phase ---"
        if run_claude "/ralph-hero:ralph-research" "research"; then
            work_done=true
        fi
    fi

    # === BUILDER PHASE ===

    # Planning phase
    if [ "$MODE" = "all" ] || [ "$MODE" = "--plan-only" ] || [ "$MODE" = "--builder-only" ]; then
        echo "--- Builder: Planning Phase ---"
        if run_claude "/ralph-hero:ralph-plan" "plan"; then
            work_done=true
        fi
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
            if run_claude "/ralph-hero:ralph-review" "review"; then
                work_done=true
            fi
        else
            echo "--- Review Phase: SKIPPED (--review=skip) ---"
        fi
    fi

    # Implementation phase
    if [ "$MODE" = "all" ] || [ "$MODE" = "--impl-only" ] || [ "$MODE" = "--builder-only" ]; then
        echo "--- Builder: Implementation Phase ---"
        if run_claude "/ralph-hero:ralph-impl" "implement"; then
            work_done=true
        fi
    fi

    # === INTEGRATOR PHASE ===
    if [ "$MODE" = "all" ] || [ "$MODE" = "--integrator-only" ]; then
        echo "--- Integrator Phase (report only) ---"
        # Future: run_claude "/ralph-hero:ralph-integrate" "integrate"
    fi

    # Exit early if no work found in any queue
    if [ "$work_done" = "false" ]; then
        echo ">>> No work found in any queue. Stopping."
        break
    fi

    # Brief pause between iterations
    sleep 5
done

echo "=========================================="
echo "  Loop complete after $iteration iterations"
echo "=========================================="
