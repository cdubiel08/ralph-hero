#!/usr/bin/env bash
# cos-loop.sh — loop wrapper for cos.sh (mirrors /loop count-or-duration semantics)
#
# Usage:
#   cos-loop.sh [--keep-going] [--role <name>] <count-or-duration> <prompt>
#
# Arguments:
#   count-or-duration   Number of iterations (e.g. 10) OR wall-clock duration
#                       with s/m/h suffix (e.g. 30s, 10m, 1h).
#   prompt              Prompt string passed to cos.sh each iteration.
#
# Options:
#   --keep-going        Do not abort on non-zero exit from a single cos.sh
#                       iteration. Records the failed exit code to stderr and
#                       continues (default: fail-fast).
#   --role <name>       Role passed through to each cos.sh invocation.
#                       One of: default, smol, slow, plan.
#   --help, -h          Print this usage and exit 0.
#
# Environment:
#   RALPH_COS_DEBUG     Set to 1 to print per-iteration and summary diagnostics
#                       to stderr.
#
# Behavior:
#   - Count mode  (e.g. 10):   runs exactly N iterations sequentially.
#   - Duration mode (e.g. 30s): runs iterations until wall-clock elapsed >= N.
#     Each iteration runs to completion before the deadline is checked.
#   - Each cos.sh invocation writes its own JSONL row to
#     ~/.ralph-hero/cos/runs/YYYY-MM-DD.jsonl. cos-loop.sh does NOT write rows.
#   - SIGINT traps: prints interrupted summary and exits 130.
#
# Stable CLI surface: positional args + --role + --keep-going are a
# breaking-change boundary. Phase 6 depends on this contract.

set -euo pipefail

# ---------------------------------------------------------------------------
# Locate this script's directory robustly (works when symlinked)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
COS_SH="${SCRIPT_DIR}/cos.sh"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
_usage() {
    cat >&1 <<'EOF'
cos-loop.sh — loop wrapper for cos.sh

Usage:
  cos-loop.sh [--keep-going] [--role <name>] <count-or-duration> <prompt>
  cos-loop.sh --help

Arguments:
  count-or-duration   Iterations: pure number (e.g. 10)
                      OR duration with suffix (e.g. 30s, 10m, 1h)
  prompt              Prompt passed to each cos.sh invocation

Options:
  --keep-going        Continue even if a cos.sh iteration exits non-zero
  --role <name>       Role: default | smol | slow | plan
  --help, -h          Show this help and exit 0

Environment:
  RALPH_COS_DEBUG     Set to 1 for per-iteration debug output to stderr

Examples:
  cos-loop.sh 10 "Summarise today's open issues"       # 10 iterations
  cos-loop.sh 30s "Summarise today's open issues"      # 30 seconds wall-clock
  cos-loop.sh --keep-going 5 "..."                     # don't abort on non-zero
  cos-loop.sh --role plan 3 "Draft a sprint goal"      # passes --role through
EOF
}

# ---------------------------------------------------------------------------
# Guard: cos.sh must exist and be executable
# ---------------------------------------------------------------------------
_check_cos_sh() {
    if [[ ! -f "$COS_SH" ]]; then
        echo "cos-loop: cos.sh not found at ${COS_SH}" >&2
        exit 127
    fi
    if [[ ! -x "$COS_SH" ]]; then
        echo "cos-loop: cos.sh not executable at ${COS_SH}" >&2
        exit 127
    fi
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
KEEP_GOING=0
ROLE_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --help|-h)
            _usage
            exit 0
            ;;
        --keep-going)
            KEEP_GOING=1
            shift
            ;;
        --role)
            if [[ -z "${2:-}" ]]; then
                echo "cos-loop: --role requires a value" >&2
                exit 2
            fi
            ROLE_ARGS=("--role" "$2")
            shift 2
            ;;
        --)
            shift
            break
            ;;
        -*)
            echo "cos-loop: unknown flag: $1" >&2
            _usage >&2
            exit 2
            ;;
        *)
            break
            ;;
    esac
done

# Require exactly two positional args after flags
if [[ $# -lt 2 ]]; then
    echo "cos-loop: missing required arguments: <count-or-duration> and <prompt>" >&2
    _usage >&2
    exit 2
fi

COUNT_OR_DURATION="$1"
PROMPT="$2"

if [[ -z "$COUNT_OR_DURATION" ]]; then
    echo "cos-loop: count-or-duration cannot be empty" >&2
    exit 2
fi
if [[ -z "$PROMPT" ]]; then
    echo "cos-loop: prompt cannot be empty" >&2
    exit 2
fi

# ---------------------------------------------------------------------------
# Parse count-or-duration
# ---------------------------------------------------------------------------
MODE=""       # "count" or "duration"
COUNT=0       # iterations (count mode)
DEADLINE=0    # epoch seconds (duration mode)
DURATION_LABEL=""

if [[ "$COUNT_OR_DURATION" =~ ^([0-9]+)([smh])$ ]]; then
    # Duration mode
    MODE="duration"
    NUM="${BASH_REMATCH[1]}"
    SUFFIX="${BASH_REMATCH[2]}"
    NOW="$(date +%s)"
    case "$SUFFIX" in
        s) SECONDS_VAL="$NUM";;
        m) SECONDS_VAL=$(( NUM * 60 ));;
        h) SECONDS_VAL=$(( NUM * 3600 ));;
    esac
    DEADLINE=$(( NOW + SECONDS_VAL ))
    DURATION_LABEL="${COUNT_OR_DURATION}"
elif [[ "$COUNT_OR_DURATION" =~ ^[0-9]+$ ]]; then
    # Count mode
    MODE="count"
    COUNT="$COUNT_OR_DURATION"
    if [[ "$COUNT" -eq 0 ]]; then
        echo "cos-loop: count must be > 0" >&2
        exit 2
    fi
else
    echo "cos-loop: invalid count-or-duration: ${COUNT_OR_DURATION}" >&2
    echo "  Expected a positive integer (count mode) or integer+suffix like 30s, 10m, 1h (duration mode)" >&2
    exit 2
fi

# ---------------------------------------------------------------------------
# Check cos.sh is present before starting the loop
# ---------------------------------------------------------------------------
_check_cos_sh

# ---------------------------------------------------------------------------
# Wall-clock helpers (bash 3.2 compatible)
# ---------------------------------------------------------------------------
_now_s() {
    date +%s
}

# ---------------------------------------------------------------------------
# SIGINT trap
# ---------------------------------------------------------------------------
COMPLETED_ITERATIONS=0
START_S="$(_now_s)"
_interrupted=0

_sigint_handler() {
    _interrupted=1
    ELAPSED=$(( $(_now_s) - START_S ))
    echo "" >&2
    echo "[cos-loop] interrupted after ${COMPLETED_ITERATIONS} iterations (elapsed=${ELAPSED}s)" >&2
    exit 130
}
trap '_sigint_handler' INT

# ---------------------------------------------------------------------------
# Loop
# ---------------------------------------------------------------------------
LAST_NONZERO_EXIT=0

if [[ "$MODE" == "count" ]]; then
    # Count mode
    for (( I=1; I<=COUNT; I++ )); do
        if [[ "$_interrupted" -eq 1 ]]; then
            break
        fi
        ELAPSED=$(( $(_now_s) - START_S ))
        if [[ "${RALPH_COS_DEBUG:-}" == "1" ]]; then
            echo "[cos-loop] iteration ${I} of ${COUNT} (elapsed=${ELAPSED}s)" >&2
        fi
        ITER_EXIT=0
        bash "$COS_SH" "${ROLE_ARGS[@]+"${ROLE_ARGS[@]}"}" "$PROMPT" || ITER_EXIT=$?
        if [[ $ITER_EXIT -ne 0 ]]; then
            if [[ "$KEEP_GOING" -eq 1 ]]; then
                echo "[cos-loop] iteration ${I} exited ${ITER_EXIT} (--keep-going: continuing)" >&2
                LAST_NONZERO_EXIT=$ITER_EXIT
            else
                echo "[cos-loop] iteration ${I} exited ${ITER_EXIT} (fail-fast: aborting)" >&2
                exit $ITER_EXIT
            fi
        fi
        COMPLETED_ITERATIONS=$I
    done
else
    # Duration mode
    I=0
    while true; do
        if [[ "$_interrupted" -eq 1 ]]; then
            break
        fi
        NOW_S="$(_now_s)"
        if [[ $NOW_S -ge $DEADLINE ]]; then
            break
        fi
        I=$(( I + 1 ))
        ELAPSED=$(( NOW_S - START_S ))
        if [[ "${RALPH_COS_DEBUG:-}" == "1" ]]; then
            echo "[cos-loop] iteration ${I} of ${DURATION_LABEL} deadline (elapsed=${ELAPSED}s)" >&2
        fi
        ITER_EXIT=0
        bash "$COS_SH" "${ROLE_ARGS[@]+"${ROLE_ARGS[@]}"}" "$PROMPT" || ITER_EXIT=$?
        if [[ $ITER_EXIT -ne 0 ]]; then
            if [[ "$KEEP_GOING" -eq 1 ]]; then
                echo "[cos-loop] iteration ${I} exited ${ITER_EXIT} (--keep-going: continuing)" >&2
                LAST_NONZERO_EXIT=$ITER_EXIT
            else
                echo "[cos-loop] iteration ${I} exited ${ITER_EXIT} (fail-fast: aborting)" >&2
                exit $ITER_EXIT
            fi
        fi
        COMPLETED_ITERATIONS=$I
    done
fi

# ---------------------------------------------------------------------------
# Final debug summary
# ---------------------------------------------------------------------------
FINAL_ELAPSED=$(( $(_now_s) - START_S ))
if [[ "${RALPH_COS_DEBUG:-}" == "1" ]]; then
    echo "[cos-loop] completed ${COMPLETED_ITERATIONS} iterations in ${FINAL_ELAPSED}s (mode=${MODE})" >&2
fi

# ---------------------------------------------------------------------------
# Exit
# ---------------------------------------------------------------------------
if [[ $LAST_NONZERO_EXIT -ne 0 ]]; then
    exit $LAST_NONZERO_EXIT
fi
exit 0
