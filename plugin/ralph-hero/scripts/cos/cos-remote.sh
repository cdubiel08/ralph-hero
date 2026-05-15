#!/usr/bin/env bash
# cos-remote.sh — phone-friendly status summary via local LLM with 30-min cache
#
# Pulls pipeline state through the cos.sh wrapper (Phase 1) using the 'smol' model
# role (Qwen 3.5 7B), caches the result at ~/.ralph-hero/cos/cache/remote-status.json
# with a 30-minute TTL, and prints the summary to stdout.
#
# ZERO CLAUDE CODE: This script does not invoke 'claude' or 'claude-code'. All LLM
# calls go through cos.sh → pi → local mlx-openai-server.
#
# Usage:
#   cos-remote.sh [--help|-h] [--no-cache]
#
# Options:
#   --help, -h    Print this usage and exit 0
#   --no-cache    Bypass cache and force a fresh LLM call (useful for debugging)
#
# Cache:
#   Path: ~/.ralph-hero/cos/cache/remote-status.json
#   TTL:  1800 seconds (30 minutes)
#   Shape: {"timestamp":"<ISO-8601 UTC>","summary":"<text>","model":"<name>","prompt_hash":"<sha256>"}
#
# Environment:
#   RALPH_COS_DEBUG   Set to 1 to print cache and timing info to stderr

set -euo pipefail

# ---------------------------------------------------------------------------
# Locate this script's directory robustly (works when symlinked)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
CACHE_DIR="${HOME}/.ralph-hero/cos/cache"
CACHE_FILE="${CACHE_DIR}/remote-status.json"
CACHE_TTL=1800  # 30 minutes in seconds
SYSTEM_PROMPT_FILE="${PLUGIN_ROOT}/skills/cos/system-prompt.md"
COS_SCRIPT="${SCRIPT_DIR}/cos.sh"

# The status-pull prompt — inlined here so the prompt_hash is stable.
# This prompt instructs the smol model to call MCP read tools and emit
# a 2-3 sentence phone-friendly summary.
STATUS_PROMPT="You are a chief-of-staff assistant. Call pipeline_dashboard to get current project state, then call next_actions (limit=3) to see the top priorities, then call recent_activity (limit=10, compact=true) to see what changed recently. Synthesize a 2-3 sentence phone-friendly status summary: how many items are in flight, what is the top priority action, and whether anything is blocked or needs attention. Be terse — output is read on a phone."

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
_usage() {
    cat <<EOF
cos-remote — phone-friendly status summary via local LLM

Usage:
  cos-remote.sh [--help|-h] [--no-cache]

Options:
  --help, -h    Show this help and exit 0
  --no-cache    Bypass the 30-min cache and force a fresh LLM call

Cache:
  Path: ${CACHE_FILE}
  TTL:  30 minutes

Environment:
  RALPH_COS_DEBUG=1   Print cache hit/miss and timing info to stderr

EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
NO_CACHE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --help|-h)
            _usage
            exit 0
            ;;
        --no-cache)
            NO_CACHE=1
            shift
            ;;
        --)
            shift
            break
            ;;
        -*)
            echo "cos-remote: unknown flag: $1" >&2
            _usage >&2
            exit 2
            ;;
        *)
            echo "cos-remote: unexpected argument: $1" >&2
            _usage >&2
            exit 2
            ;;
    esac
done

# ---------------------------------------------------------------------------
# Ensure cache directory exists
# ---------------------------------------------------------------------------
mkdir -p "${CACHE_DIR}"

# ---------------------------------------------------------------------------
# Cache freshness check helper
# ---------------------------------------------------------------------------
_cache_is_fresh() {
    [[ -f "${CACHE_FILE}" ]] || return 1
    local now
    now=$(date +%s)
    local mtime
    if [[ "$(uname)" == "Darwin" ]]; then
        mtime=$(stat -f %m "${CACHE_FILE}" 2>/dev/null) || return 1
    else
        mtime=$(stat -c %Y "${CACHE_FILE}" 2>/dev/null) || return 1
    fi
    local age=$(( now - mtime ))
    if [[ "${RALPH_COS_DEBUG:-}" == "1" ]]; then
        echo "[cos-remote] cache age: ${age}s (TTL: ${CACHE_TTL}s)" >&2
    fi
    (( age < CACHE_TTL ))
}

# ---------------------------------------------------------------------------
# Cache hit path
# ---------------------------------------------------------------------------
if [[ "${NO_CACHE}" -eq 0 ]] && _cache_is_fresh; then
    if [[ "${RALPH_COS_DEBUG:-}" == "1" ]]; then
        echo "[cos-remote] cache HIT — reading ${CACHE_FILE}" >&2
    fi
    summary=$(jq -r '.summary' "${CACHE_FILE}" 2>/dev/null) || {
        echo "cos-remote: cache file corrupt, falling through to fresh call" >&2
        summary=""
    }
    if [[ -n "${summary}" ]]; then
        echo "${summary}"
        exit 0
    fi
fi

# ---------------------------------------------------------------------------
# Cache miss path — invoke cos.sh with the smol role
# ---------------------------------------------------------------------------
if [[ "${RALPH_COS_DEBUG:-}" == "1" ]]; then
    echo "[cos-remote] cache MISS — invoking cos.sh --role smol" >&2
fi

if [[ ! -x "${COS_SCRIPT}" ]]; then
    echo "cos-remote: cos.sh not found or not executable at ${COS_SCRIPT}" >&2
    exit 1
fi

if [[ ! -f "${SYSTEM_PROMPT_FILE}" ]]; then
    echo "cos-remote: system prompt not found at ${SYSTEM_PROMPT_FILE}" >&2
    exit 1
fi

# Capture cos.sh stdout; propagate non-zero exit without updating cache
LLM_OUTPUT=""
EXIT_CODE=0
LLM_OUTPUT=$("${COS_SCRIPT}" \
    --role smol \
    --append-system-prompt "${SYSTEM_PROMPT_FILE}" \
    "${STATUS_PROMPT}") || EXIT_CODE=$?

if [[ "${EXIT_CODE}" -ne 0 ]]; then
    echo "cos-remote: upstream cos.sh failed (exit ${EXIT_CODE}) — cache not updated" >&2
    exit "${EXIT_CODE}"
fi

# ---------------------------------------------------------------------------
# Compute cache payload fields
# ---------------------------------------------------------------------------
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PROMPT_HASH="$(printf '%s' "${STATUS_PROMPT}" | shasum -a 256 | cut -d' ' -f1)"

# Extract model from the most recent JSONL run-log row written by cos.sh
RUN_LOG="${HOME}/.ralph-hero/cos/runs/$(date +%Y-%m-%d).jsonl"
MODEL_FIELD=""
if [[ -f "${RUN_LOG}" ]]; then
    MODEL_FIELD=$(tail -1 "${RUN_LOG}" | jq -r '.model // ""' 2>/dev/null || true)
fi

# ---------------------------------------------------------------------------
# Atomic cache write: write to tmp then mv -f
# ---------------------------------------------------------------------------
TMP_FILE="$(mktemp "${CACHE_DIR}/.remote-status.XXXXXX.json")"
# Escape the summary for JSON (jq handles all edge cases)
jq -n \
    --arg timestamp "${TIMESTAMP}" \
    --arg summary "${LLM_OUTPUT}" \
    --arg model "${MODEL_FIELD}" \
    --arg prompt_hash "${PROMPT_HASH}" \
    '{"timestamp":$timestamp,"summary":$summary,"model":$model,"prompt_hash":$prompt_hash}' \
    > "${TMP_FILE}"
mv -f "${TMP_FILE}" "${CACHE_FILE}"

if [[ "${RALPH_COS_DEBUG:-}" == "1" ]]; then
    echo "[cos-remote] cache written to ${CACHE_FILE}" >&2
fi

# ---------------------------------------------------------------------------
# Print summary to stdout
# ---------------------------------------------------------------------------
echo "${LLM_OUTPUT}"
