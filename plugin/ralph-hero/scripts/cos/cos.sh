#!/usr/bin/env bash
# cos.sh — chief-of-staff wrapper for pi
#
# Resolves model roles via model-roles.sh, invokes pi in non-interactive mode
# against the local mlx-openai-server, and appends a JSONL run-log row.
#
# Usage:
#   cos.sh [--role <role>] [--append-system-prompt <file>] [--help|-h] <prompt>
#
# Options:
#   --role <name>              Model role to use. One of: default, smol, slow, plan.
#                              Overrides RALPH_COS_ROLE env var.
#   --append-system-prompt <f> Append the contents of <file> to pi's system prompt.
#                              Passed through to pi as --append-system-prompt.
#                              May be specified multiple times.
#   --help, -h                 Print this usage and exit 0.
#
# Environment:
#   RALPH_COS_ROLE              Role (default: "default")
#   RALPH_COS_MODEL_DEFAULT     Model for 'default' role (default: qwen3.5-27b)
#   RALPH_COS_MODEL_SMOL        Model for 'smol' role    (default: qwen3.5-7b)
#   RALPH_COS_MODEL_SLOW        Model for 'slow' role    (default: qwen3.5-27b)
#   RALPH_COS_MODEL_PLAN        Model for 'plan' role    (default: qwen3.5-27b)
#   RALPH_COS_TOOLS             Comma-separated pi tool allowlist
#                               (default: read,write,grep,find)
#   RALPH_COS_DEBUG             Set to 1 to print resolved model + tools to stderr
#
# Run log: ~/.ralph-hero/cos/runs/YYYY-MM-DD.jsonl (one row per invocation)
# Row shape: {"ts":"...","role":"...","prompt_hash":"...","model":"...","exit_code":0,"duration_ms":0}
#
# Stable CLI surface — treat positional prompt + --role + JSONL log shape as a
# breaking-change boundary. Phases 2–6 depend on this contract.

set -euo pipefail

# ---------------------------------------------------------------------------
# Locate this script's directory robustly (works when symlinked)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
_usage() {
    cat >&2 <<'EOF'
cos.sh — chief-of-staff wrapper for pi (local MLX model)

Usage:
  cos.sh [--role <role>] [--append-system-prompt <file>] <prompt>
  cos.sh --help

Options:
  --role <name>              Model role: default | smol | slow | plan  (default: default)
  --append-system-prompt <f> Append file contents to the system prompt (repeatable)
  --help, -h                 Show this help and exit 0

Model roles (env-overridable defaults):
  default   qwen3.5-27b  (RALPH_COS_MODEL_DEFAULT)
  smol      qwen3.5-7b   (RALPH_COS_MODEL_SMOL)
  slow      qwen3.5-27b  (RALPH_COS_MODEL_SLOW)
  plan      qwen3.5-27b  (RALPH_COS_MODEL_PLAN)

Run log: ~/.ralph-hero/cos/runs/YYYY-MM-DD.jsonl

Examples:
  cos.sh "Summarise today's open issues"
  cos.sh --role plan "Draft a sprint goal for next week"
  RALPH_COS_DEBUG=1 cos.sh --role smol "What files changed today?"
EOF
}

# ---------------------------------------------------------------------------
# Guard: pi must be on PATH
# ---------------------------------------------------------------------------
if ! command -v pi >/dev/null 2>&1; then
    echo "[cos] ERROR: pi not found — install @earendil-works/pi-coding-agent" >&2
    exit 127
fi

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
ROLE_OVERRIDE=""
APPEND_SYSTEM_PROMPT_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --help|-h)
            _usage
            exit 0
            ;;
        --role)
            if [[ -z "${2:-}" ]]; then
                echo "[cos] ERROR: --role requires a value" >&2
                exit 2
            fi
            ROLE_OVERRIDE="$2"
            shift 2
            ;;
        --append-system-prompt)
            if [[ -z "${2:-}" ]]; then
                echo "[cos] ERROR: --append-system-prompt requires a file path" >&2
                exit 2
            fi
            if [[ ! -f "$2" ]]; then
                echo "[cos] ERROR: --append-system-prompt file not found: $2" >&2
                exit 2
            fi
            APPEND_SYSTEM_PROMPT_ARGS+=("--append-system-prompt" "$2")
            shift 2
            ;;
        --)
            shift
            break
            ;;
        -*)
            echo "[cos] ERROR: Unknown flag: $1" >&2
            _usage
            exit 2
            ;;
        *)
            break
            ;;
    esac
done

PROMPT="${1:-}"
if [[ -z "$PROMPT" ]]; then
    echo "[cos] ERROR: No prompt provided." >&2
    _usage
    exit 2
fi

# ---------------------------------------------------------------------------
# Apply role override and resolve model
# ---------------------------------------------------------------------------
if [[ -n "$ROLE_OVERRIDE" ]]; then
    export RALPH_COS_ROLE="$ROLE_OVERRIDE"
fi

# Source the model-roles helper (sets and exports COS_MODEL)
# shellcheck source=model-roles.sh
source "${SCRIPT_DIR}/model-roles.sh"
cos_resolve_model

# The resolved role (for JSONL log)
RESOLVED_ROLE="${RALPH_COS_ROLE:-default}"

# ---------------------------------------------------------------------------
# Tool allowlist
# ---------------------------------------------------------------------------
COS_TOOLS="${RALPH_COS_TOOLS:-read,write,grep,find}"

# ---------------------------------------------------------------------------
# Debug output
# ---------------------------------------------------------------------------
if [[ "${RALPH_COS_DEBUG:-}" == "1" ]]; then
    echo "[cos] role=${RESOLVED_ROLE} model=${COS_MODEL} tools=${COS_TOOLS} append_system_prompt_files=${#APPEND_SYSTEM_PROMPT_ARGS[@]}" >&2
fi

# ---------------------------------------------------------------------------
# Compute run metadata before exec
# ---------------------------------------------------------------------------
RUN_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PROMPT_HASH="$(printf '%s' "$PROMPT" | shasum -a 256 | cut -d' ' -f1)"
RUN_DATE="$(date +%Y-%m-%d)"

# ---------------------------------------------------------------------------
# Ensure log directories exist
# ---------------------------------------------------------------------------
RUNS_DIR="${HOME}/.ralph-hero/cos/runs"
LOGS_DIR="${HOME}/.ralph-hero/cos/logs"
mkdir -p "$RUNS_DIR" "$LOGS_DIR"

RUN_LOG="${RUNS_DIR}/${RUN_DATE}.jsonl"

# ---------------------------------------------------------------------------
# Duration measurement
# ---------------------------------------------------------------------------
if [[ -n "${EPOCHREALTIME:-}" ]] || (( BASH_VERSINFO[0] >= 5 )); then
    # bash 5+: EPOCHREALTIME gives sub-second precision
    _start_ms() { printf '%.0f' "$(echo "${EPOCHREALTIME} * 1000" | bc 2>/dev/null || date +%s%3N)"; }
else
    # Fallback: date +%s (second precision; duration_ms will be a multiple of 1000)
    _start_ms() {
        echo "[cos] WARNING: bash < 5 detected — duration_ms has second precision only" >&2
        printf '%s000' "$(date +%s)"
    }
fi

START_MS="$(_start_ms)"

# ---------------------------------------------------------------------------
# Invoke pi
# ---------------------------------------------------------------------------
EXIT_CODE=0
pi \
    --no-session \
    --no-context-files \
    --provider mlx-local \
    --model "$COS_MODEL" \
    --tools "$COS_TOOLS" \
    "${APPEND_SYSTEM_PROMPT_ARGS[@]+"${APPEND_SYSTEM_PROMPT_ARGS[@]}"}" \
    -p "$PROMPT" \
    || EXIT_CODE=$?

# ---------------------------------------------------------------------------
# Compute duration
# ---------------------------------------------------------------------------
END_MS="$(_start_ms)"
DURATION_MS=$(( END_MS - START_MS ))

# ---------------------------------------------------------------------------
# Append JSONL run log row (no external deps — printf-formatted JSON)
# ---------------------------------------------------------------------------
printf '{"ts":"%s","role":"%s","prompt_hash":"%s","model":"%s","exit_code":%d,"duration_ms":%d}\n' \
    "$RUN_TS" \
    "$RESOLVED_ROLE" \
    "$PROMPT_HASH" \
    "$COS_MODEL" \
    "$EXIT_CODE" \
    "$DURATION_MS" \
    >> "$RUN_LOG"

# ---------------------------------------------------------------------------
# Exit with pi's exit code
# ---------------------------------------------------------------------------
exit "$EXIT_CODE"
