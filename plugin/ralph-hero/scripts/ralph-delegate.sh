#!/usr/bin/env bash
# ralph-delegate.sh — Single entry point for optional LLM delegation.
#
# Foundation for the LLM delegation epic (#965). Skills opt-in by invoking
# this script via Bash(). With RALPH_DELEGATE_ENABLED unset, the script
# returns 126 immediately and writes nothing to the audit log — so callers
# can rely on a bit-identical no-op when delegation is off.
#
# CLI:
#   ralph-delegate.sh \
#     --task <name> \
#     --prompt-file <path> \
#     [--system-file <path>] \
#     [--max-tokens N] \
#     [--temperature 0.0..1.0] \
#     [--health-check] \
#     [--dry-run] \
#     [--timeout N]
#
# Exit codes:
#   0   success — stdout is the model's completion
#   1   hard error (parse error, HTTP 4xx/5xx) — caller falls back
#   124 timeout (GNU timeout convention)
#   126 delegation disabled (silent skip, no audit log)
#   127 endpoint unreachable
#
# JSONL audit log line (one per attempt, except 126):
#   {"ts":"...","task":"<name>","model":"...","url":"...","ms":N,
#    "status":"ok|timeout|unreachable|parse_error|http_<code>|dry_run",
#    "bytes_in":N,"bytes_out":N,"caller":"<skill>"}
#
# References:
#   plugin/ralph-hero/scripts/resolve-env.sh:32     — ralph_resolve_env
#   plugin/ralph-hero/scripts/cli-dispatch.sh:21    — portable_timeout
#   plugin/ralph-hero/scripts/lib/openai-compat.sh  — F2 HTTP+JSON adapter (#1186)
#   plugin/ralph-knowledge/src/llm-client.ts        — TS reference client

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./resolve-env.sh
source "$SCRIPT_DIR/resolve-env.sh"
# shellcheck source=./cli-dispatch.sh
# cli-dispatch.sh defines portable_timeout at the top; sourcing is safe
# because no top-level code runs (it only defines functions).
source "$SCRIPT_DIR/cli-dispatch.sh"
# shellcheck source=./lib/openai-compat.sh
# F2 (#1186): the HTTP+JSON adapter lives here. Sourcing it defines
# openai_compat_post and runs no top-level code.
source "$SCRIPT_DIR/lib/openai-compat.sh"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
_usage() {
    cat <<'USAGE'
Usage: ralph-delegate.sh [options]

Options:
  --task <name>              Task name (used for per-task env overrides + audit log).
  --prompt-file <path>       File containing the user prompt.
  --system-file <path>       Optional file containing the system prompt.
  --max-tokens N             Max tokens in the completion (default: 1024).
  --temperature F            Sampling temperature 0.0..1.0 (default: 0.2).
  --health-check             GET <url>/v1/models with 2s timeout. Exits 0 if up, 127 otherwise.
  --dry-run                  Resolve env + print resolution tuple. No HTTP call. Logs status=dry_run.
  --timeout N                Per-call timeout in seconds (overrides RALPH_DELEGATE_TIMEOUT_SECONDS).
  --help                     Print this message and exit 0.

Env vars:
  RALPH_DELEGATE_ENABLED              Master opt-in. Unset/false/0 -> exit 126 immediately.
  RALPH_DELEGATE_TIMEOUT_SECONDS      Per-call timeout (default: 60).
  RALPH_DELEGATE_LOG_PATH             JSONL audit log (default: ~/.ralph-hero/delegate.log).
  RALPH_DELEGATE_<TASK_UPPER>_URL     Per-task endpoint override.
  RALPH_DELEGATE_<TASK_UPPER>_MODEL   Per-task model override.
  RALPH_LLM_URL                       Default endpoint (default: http://localhost:8000).
  RALPH_LLM_MODEL                     Default model (default: mlx-community/gemma-4-26b-a4b-it-mxfp8).

Exit codes:
  0 success | 1 hard error | 124 timeout | 126 disabled | 127 unreachable
USAGE
}

# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------
# macOS `date` doesn't grok %3N (BSD). Use python3 (already a hard dep for
# the bats fixture stub) so the wall-clock millisecond reading is portable.
_now_ms() {
    python3 -c 'import time;print(int(time.time()*1000))'
}

# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------
_resolve_caller() {
    local hook_input="${RALPH_HOOK_INPUT:-}"
    if [ -n "$hook_input" ]; then
        local c
        c=$(printf '%s' "$hook_input" | jq -r '.tool_input.caller_skill // empty' 2>/dev/null || true)
        if [ -n "$c" ]; then
            printf '%s' "$c"
            return 0
        fi
    fi
    printf 'unknown'
}

_audit_log() {
    # Args: status ms bytes_in bytes_out
    local status="$1" ms="$2" bytes_in="$3" bytes_out="$4"
    local ts caller
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    caller=$(_resolve_caller)
    mkdir -p "$(dirname "$LOG_PATH")"
    jq -nc \
        --arg ts "$ts" \
        --arg task "$TASK" \
        --arg model "$MODEL" \
        --arg url "$URL" \
        --argjson ms "$ms" \
        --arg status "$status" \
        --argjson bytes_in "$bytes_in" \
        --argjson bytes_out "$bytes_out" \
        --arg caller "$caller" \
        '{ts:$ts,task:$task,model:$model,url:$url,ms:$ms,status:$status,bytes_in:$bytes_in,bytes_out:$bytes_out,caller:$caller}' \
        >> "$LOG_PATH"
}

# ---------------------------------------------------------------------------
# Env resolution
# ---------------------------------------------------------------------------
_resolve() {
    # Resolve a var via ralph_resolve_env (shell -> repo settings -> ~/.claude),
    # echoing the fallback when nothing matches.
    local var="$1" fallback="${2:-}"
    local repo_root
    repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
    local val
    val=$(ralph_resolve_env "$var" "$repo_root" "$HOME" 2>/dev/null) && {
        printf '%s' "$val"
        return 0
    }
    printf '%s' "$fallback"
}

_resolve_task_var() {
    # Per-task overrides (RALPH_DELEGATE_<TASK_UPPER>_<SUFFIX>) take precedence
    # over the global fallback.
    local task="$1" suffix="$2" fallback="$3"
    local upper
    upper=$(printf '%s' "$task" | tr '[:lower:]-' '[:upper:]_')
    local override_var="RALPH_DELEGATE_${upper}_${suffix}"
    local repo_root
    repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
    local val
    val=$(ralph_resolve_env "$override_var" "$repo_root" "$HOME" 2>/dev/null) && {
        printf '%s' "$val"
        return 0
    }
    printf '%s' "$fallback"
}

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------
TASK=""
PROMPT_FILE=""
SYSTEM_FILE=""
MAX_TOKENS="1024"
TEMPERATURE="0.2"
HEALTH_CHECK="false"
DRY_RUN="false"
TIMEOUT_OVERRIDE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --task)         TASK="$2"; shift 2 ;;
        --prompt-file)  PROMPT_FILE="$2"; shift 2 ;;
        --system-file)  SYSTEM_FILE="$2"; shift 2 ;;
        --max-tokens)   MAX_TOKENS="$2"; shift 2 ;;
        --temperature)  TEMPERATURE="$2"; shift 2 ;;
        --health-check) HEALTH_CHECK="true"; shift ;;
        --dry-run)      DRY_RUN="true"; shift ;;
        --timeout)      TIMEOUT_OVERRIDE="$2"; shift 2 ;;
        --help|-h)      _usage; exit 0 ;;
        *) echo "ralph-delegate: unknown argument: $1" >&2; _usage >&2; exit 1 ;;
    esac
done

# ---------------------------------------------------------------------------
# Disabled gate — first check after arg parsing. NO log line written.
# ---------------------------------------------------------------------------
ENABLED_VAL=$(_resolve "RALPH_DELEGATE_ENABLED" "")
case "$(printf '%s' "$ENABLED_VAL" | tr '[:upper:]' '[:lower:]')" in
    true|1|yes|on) ;;
    *) exit 126 ;;
esac

# ---------------------------------------------------------------------------
# Resolve env + defaults
# ---------------------------------------------------------------------------
TASK="${TASK:-default}"
URL=$(_resolve_task_var "$TASK" "URL" "$(_resolve RALPH_LLM_URL http://localhost:8000)")
MODEL=$(_resolve_task_var "$TASK" "MODEL" "$(_resolve RALPH_LLM_MODEL mlx-community/gemma-4-26b-a4b-it-mxfp8)")
TIMEOUT_SECONDS="${TIMEOUT_OVERRIDE:-$(_resolve RALPH_DELEGATE_TIMEOUT_SECONDS 60)}"
LOG_PATH=$(_resolve RALPH_DELEGATE_LOG_PATH "$HOME/.ralph-hero/delegate.log")
# Expand leading tilde just in case settings.json stored "~/..."
case "$LOG_PATH" in
    "~/"*) LOG_PATH="$HOME/${LOG_PATH#~/}" ;;
esac

# ---------------------------------------------------------------------------
# --health-check
# ---------------------------------------------------------------------------
if [ "$HEALTH_CHECK" = "true" ]; then
    t0=$(_now_ms)
    set +e
    http_code=$(curl -sS -o /dev/null --max-time 2 -w "%{http_code}" "${URL%/}/v1/models" 2>/dev/null)
    rc=$?
    set -e
    t1=$(_now_ms)
    ms=$(( t1 - t0 ))
    if [ "$rc" -eq 0 ] && [ "$http_code" = "200" ]; then
        _audit_log "ok" "$ms" 0 0
        exit 0
    fi
    _audit_log "unreachable" "$ms" 0 0
    exit 127
fi

# ---------------------------------------------------------------------------
# --dry-run
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" = "true" ]; then
    prompt_bytes=0
    if [ -n "$PROMPT_FILE" ] && [ -f "$PROMPT_FILE" ]; then
        prompt_bytes=$(wc -c < "$PROMPT_FILE" | tr -d ' ')
    fi
    echo "task=$TASK model=$MODEL url=$URL prompt_bytes=$prompt_bytes"
    _audit_log "dry_run" 0 "$prompt_bytes" 0
    exit 0
fi

# ---------------------------------------------------------------------------
# Main path — delegate to the F2 OpenAI-compat adapter (#1186).
#
# The adapter (plugin/ralph-hero/scripts/lib/openai-compat.sh) owns the HTTP
# call, body construction, jq parsing, and exit-code mapping. The wrapper
# retains: opt-in gate, env resolution, audit log, and the --task /
# --health-check / --dry-run flags.
#
# Note on bytes_out fidelity:
#   F1 used `wc -c` on the raw response body. The adapter prints the parsed
#   content (not the raw response). To preserve the audit-log shape without
#   over-coupling the adapter, we use `wc -c` of the captured content for
#   status=ok and log 0 for non-ok cases. This is a small fidelity loss vs
#   F1 (non-ok bytes_out is now 0 rather than the raw HTTP body byte count).
#   Deliberate, called out in the F2 plan; revisit if telemetry needs it.
# ---------------------------------------------------------------------------
if [ -z "$PROMPT_FILE" ] || [ ! -f "$PROMPT_FILE" ]; then
    echo "ralph-delegate: --prompt-file is required and must exist" >&2
    exit 1
fi

prompt_bytes=$(wc -c < "$PROMPT_FILE" | tr -d ' ')

t0=$(_now_ms)
set +e
content=$(openai_compat_post \
    "$URL" \
    "$MODEL" \
    "$PROMPT_FILE" \
    "${SYSTEM_FILE:-}" \
    "$MAX_TOKENS" \
    "$TEMPERATURE" \
    "$TIMEOUT_SECONDS" \
    "false" 2>/dev/null)
rc=$?
set -e
t1=$(_now_ms)
ms=$(( t1 - t0 ))

# Translate adapter exit code -> F1 contract + audit-log status string.
case "$rc" in
    0)
        # bytes_out = byte count of the extracted content (see note above).
        bytes_out=$(printf '%s' "$content" | wc -c | tr -d ' ')
        _audit_log "ok" "$ms" "$prompt_bytes" "$bytes_out"
        printf '%s\n' "$content"
        exit 0
        ;;
    124)
        _audit_log "timeout" "$ms" "$prompt_bytes" 0
        exit 124
        ;;
    127)
        _audit_log "unreachable" "$ms" "$prompt_bytes" 0
        exit 127
        ;;
    *)
        # Adapter returned 1 (HTTP 4xx/5xx or jq parse error). Map to
        # parse_error to match F1's audit-log shape for malformed responses.
        _audit_log "parse_error" "$ms" "$prompt_bytes" 0
        exit 1
        ;;
esac
