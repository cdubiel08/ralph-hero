#!/bin/bash
# Run the Ralph GitHub workflow loop until all queues are empty
#
# Usage: ./scripts/ralph-loop.sh [--triage-only|--split-only|--research-only|--plan-only|--review-only|--impl-only|--hygiene-only]
#        ./scripts/ralph-loop.sh [--val-only|--pr-only|--code-review-only|--merge-only]
#        ./scripts/ralph-loop.sh [--analyst-only|--builder-only|--integrator-only]
#        ./scripts/ralph-loop.sh --split=auto|skip --review=auto|skip|interactive --hygiene=auto|skip
#        ./scripts/ralph-loop.sh --budget=5.00 [--auto-merge]
#
# Runs: hygiene (optional) -> triage -> split (optional) -> research -> plan -> review (optional) -> implement
#    -> val -> pr -> code-review -> [merge] in sequence
# Repeats until no eligible tickets in any queue
#
# Review modes:
#   --review=auto        Opus critiques plan automatically (default)
#   --review=skip        Skip review phase
#   --review=interactive Human reviews via wizard
#
# Hygiene modes:
#   --hygiene=auto       Run hygiene before triage (default)
#   --hygiene=skip       Skip hygiene phase
#
# Auto-merge:
#   --auto-merge         Enable autonomous merge gate (RALPH_AUTO_MERGE=true).
#                        Without this flag, the merge phase is a no-op (issues
#                        end at "In Review" with a code-reviewed PR).

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
        my $secs = shift @ARGV;
        my $pid = fork // die "fork: $!";
        if ($pid == 0) { exec @ARGV; die "exec: $!" }
        $SIG{ALRM} = sub { kill "TERM", $pid; kill "KILL", $pid; exit 142 };
        alarm($secs);
        waitpid($pid, 0);
        exit($? >> 8);
    ' -- "$seconds" "$@"
    local rc=$?
    if [ "$rc" -eq 142 ]; then
        return 124
    fi
    return "$rc"
}

# Parse all arguments
MODE="all"
REVIEW_MODE="${RALPH_REVIEW_MODE:-auto}"
SPLIT_MODE="${RALPH_SPLIT_MODE:-auto}"
HYGIENE_MODE="${RALPH_HYGIENE_MODE:-auto}"
AUTO_MERGE="${RALPH_AUTO_MERGE:-false}"
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
        --budget=*)
            BUDGET="${arg#*=}"
            ;;
        --auto-merge)
            AUTO_MERGE="true"
            ;;
        --triage-only|--split-only|--research-only|--plan-only|--review-only|--impl-only|--hygiene-only)
            MODE="$arg"
            ;;
        --val-only|--pr-only|--code-review-only|--merge-only)
            MODE="$arg"
            ;;
        --analyst-only|--builder-only|--integrator-only)
            MODE="$arg"
            ;;
    esac
done
export RALPH_REVIEW_MODE="$REVIEW_MODE"
export RALPH_SPLIT_MODE="$SPLIT_MODE"
export RALPH_HYGIENE_MODE="$HYGIENE_MODE"
export RALPH_AUTO_MERGE="$AUTO_MERGE"
MAX_ITERATIONS="${MAX_ITERATIONS:-10}"
TIMEOUT="${TIMEOUT:-15m}"
BUDGET="${RALPH_BUDGET:-5.00}"

echo "=========================================="
echo "  RALPH GITHUB LOOP - Autonomous Mode"
echo "=========================================="
echo "Mode: $MODE"
echo "Hygiene mode: $HYGIENE_MODE"
echo "Split mode: $SPLIT_MODE"
echo "Review mode: $REVIEW_MODE"
echo "Auto-merge: $AUTO_MERGE"
echo "Max iterations: $MAX_ITERATIONS"
echo "Timeout per task: $TIMEOUT"
echo "Budget per task: \$${BUDGET}"
echo ""

run_claude() {
    local command="$1"
    local title="$2"

    echo ">>> Running: $command"
    echo ">>> Timeout: $TIMEOUT"
    echo ""

    # Run claude in print mode (non-interactive) with auto-accept permissions
    local output
    if output=$(portable_timeout "$TIMEOUT" claude -p "$command" --max-budget-usd "$BUDGET" --dangerously-skip-permissions 2>&1); then
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
    if echo "$output" | grep -qiE "Queue empty|Triage complete"; then
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
    if [ "$MODE" = "all" ] || [ "$MODE" = "--review-only" ] || [ "$MODE" = "--builder-only" ]; then
        if [ "$REVIEW_MODE" != "skip" ]; then
            echo "--- Review Phase (mode: $REVIEW_MODE) ---"
            if [ "$REVIEW_MODE" = "interactive" ]; then
                export RALPH_REVIEW_PLAN="interactive"
            else
                export RALPH_REVIEW_PLAN="auto"
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

    # Validation phase
    if [ "$MODE" = "all" ] || [ "$MODE" = "--val-only" ] || [ "$MODE" = "--integrator-only" ]; then
        echo "--- Integrator: Validation Phase ---"
        if run_claude "/ralph-hero:ralph-val" "val"; then
            work_done=true
        fi
    fi

    # PR phase
    if [ "$MODE" = "all" ] || [ "$MODE" = "--pr-only" ] || [ "$MODE" = "--integrator-only" ]; then
        echo "--- Integrator: PR Phase ---"
        if run_claude "/ralph-hero:ralph-pr" "pr"; then
            work_done=true
        fi
    fi

    # Code review phase
    if [ "$MODE" = "all" ] || [ "$MODE" = "--code-review-only" ] || [ "$MODE" = "--integrator-only" ]; then
        echo "--- Integrator: Code Review Phase ---"
        if run_claude "/ralph-hero:ralph-code-review" "code-review"; then
            work_done=true
        fi
    fi

    # Merge phase (gated by --auto-merge to remain safe-by-default)
    if [ "$MODE" = "all" ] || [ "$MODE" = "--merge-only" ] || [ "$MODE" = "--integrator-only" ]; then
        if [ "$AUTO_MERGE" = "true" ]; then
            echo "--- Integrator: Merge Phase (auto-merge enabled) ---"
            if run_claude "/ralph-hero:ralph-merge" "merge"; then
                work_done=true
            fi
        elif [ "$MODE" = "--merge-only" ]; then
            # Explicit warning so --merge-only is never silent
            echo ">>> --merge-only requires --auto-merge or auto-merge=true; skipping merge phase."
            echo "    To enable autonomous merging: just loop --merge-only --auto-merge"
            echo "    Or:                          RALPH_AUTO_MERGE=true just loop --merge-only"
        else
            echo "--- Integrator: Merge Phase: SKIPPED (auto-merge disabled) ---"
        fi
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
