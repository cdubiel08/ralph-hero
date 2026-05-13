#!/usr/bin/env bash
# openai-compat.sh — Sourceable OpenAI-compat HTTP+JSON adapter.
#
# F2 of the LLM-delegation epic (#965, this issue is #1186). Extracted from the
# inlined HTTP+JSON block in ralph-delegate.sh (F1, #1185) so the adapter is:
#
#   1. Independently testable: bats tests in __tests__/openai-compat.bats exercise
#      this file directly without going through the wrapper's opt-in gate, env
#      resolution, or audit log.
#   2. Independently invokable: `bash openai-compat.sh --model X --url Y
#      --prompt-file Z` works as a standalone CLI (good for operator smoke
#      tests against gemma-lab / OpenRouter).
#   3. Replaceable by a Node helper later (e.g. openai-compat.mjs) without
#      touching ralph-delegate.sh or any skill code — the boundary is set up
#      so the wrapper only depends on the openai_compat_post function name,
#      its argument order, and its exit-code contract.
#
# WHAT THIS FILE OWNS
#   - Build the OpenAI-compat request body from (model, prompt, optional system).
#   - POST it to the endpoint with curl, wrapped in portable_timeout.
#   - Parse .choices[0].message.content via jq -er.
#   - Optionally validate the extracted content as JSON (--validate-json-output).
#   - Map curl/HTTP/jq failures into a 4-way exit-code contract: 0/1/124/127.
#
# WHAT THIS FILE DOES *NOT* OWN
#   - The RALPH_DELEGATE_ENABLED opt-in gate.    (lives in ralph-delegate.sh)
#   - Env resolution for RALPH_LLM_URL / MODEL.  (lives in ralph-delegate.sh)
#   - The JSONL audit log.                       (lives in ralph-delegate.sh)
#   - --task / --health-check / --dry-run flags. (lives in ralph-delegate.sh)
#   - Exit code 126 ("disabled").                (lives in ralph-delegate.sh)
#
# CLI (standalone — directly invokable):
#   openai-compat.sh \
#     --model <name> \
#     --url <base_url> \
#     --prompt-file <path> \
#     [--system-file <path>] \
#     [--max-tokens N]            (default 1024)
#     [--temperature F]           (default 0.2)
#     [--timeout N]               (default 60 seconds)
#     [--validate-json-output]
#
# Exit codes (both sourceable function and CLI):
#   0   success — content of completion is on stdout
#   1   hard error (HTTP 4xx/5xx, jq parse failure, or --validate-json-output failure)
#   124 timeout (GNU timeout convention)
#   127 endpoint unreachable
#
# The 126 ("disabled") code is reserved for the wrapper. Callers that want the
# opt-in gate go through ralph-delegate.sh; calls landing here always do HTTP.

set -euo pipefail

# ---------------------------------------------------------------------------
# Source portable_timeout from cli-dispatch.sh (sibling directory).
# cli-dispatch.sh defines functions only — sourcing it has no side effects.
# ---------------------------------------------------------------------------
_OAC_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../cli-dispatch.sh
source "$_OAC_SCRIPT_DIR/../cli-dispatch.sh"

# ---------------------------------------------------------------------------
# openai_compat_post — sourceable function form of the adapter.
#
# Arguments (positional, all required except system_file which may be ""):
#   $1 url               — base URL (no trailing /v1/chat/completions)
#   $2 model             — model name string
#   $3 prompt_file       — path to file containing the user prompt
#   $4 system_file       — path to optional system prompt file ("" if absent)
#   $5 max_tokens        — integer
#   $6 temperature       — float (0.0..1.0)
#   $7 timeout_seconds   — integer
#   $8 validate_json     — "true" or "false"
#
# Returns:
#   0   on success; writes the parsed completion content to stdout
#   1   on HTTP 4xx/5xx, jq parse failure, or JSON-output validation failure
#   124 on timeout
#   127 on network unreachable
#
# Side effects: none other than the HTTP call and stdout write.
# Does NOT write to any log file. Does NOT print errors to stderr (silent path
# to match F1's wrapper expectations).
# ---------------------------------------------------------------------------
openai_compat_post() {
    local url="$1"
    local model="$2"
    local prompt_file="$3"
    local system_file="${4:-}"
    local max_tokens="${5:-1024}"
    local temperature="${6:-0.2}"
    local timeout_seconds="${7:-60}"
    local validate_json="${8:-false}"

    if [ ! -f "$prompt_file" ]; then
        return 1
    fi

    local prompt_content
    prompt_content=$(cat "$prompt_file")

    # Build the OpenAI-compat request body. Matches F1 wrapper bit-for-bit:
    # with system file -> messages = [system, user]; without -> [user] only.
    local body
    if [ -n "$system_file" ] && [ -f "$system_file" ]; then
        local system_content
        system_content=$(cat "$system_file")
        body=$(jq -nc \
            --arg model "$model" \
            --arg sys "$system_content" \
            --arg user "$prompt_content" \
            --argjson max_tokens "$max_tokens" \
            --argjson temperature "$temperature" \
            '{model:$model, messages:[{role:"system",content:$sys},{role:"user",content:$user}], max_tokens:$max_tokens, temperature:$temperature}')
    else
        body=$(jq -nc \
            --arg model "$model" \
            --arg user "$prompt_content" \
            --argjson max_tokens "$max_tokens" \
            --argjson temperature "$temperature" \
            '{model:$model, messages:[{role:"user",content:$user}], max_tokens:$max_tokens, temperature:$temperature}')
    fi

    # tmpfiles for curl response body + http_code capture.
    local resp_body http_code_file
    resp_body=$(mktemp)
    http_code_file=$(mktemp)

    # Cleanup helper — manual call (no `trap EXIT` because trap would clobber
    # any trap the caller may have set, and the function may be sourced).
    _oac_cleanup() {
        rm -f "$resp_body" "$http_code_file" 2>/dev/null || true
    }

    # POST. Capture http_code via -w to stdout (we redirect curl stdout to
    # $http_code_file). Body lands in $resp_body via -o. Same flag set as F1.
    set +e
    portable_timeout "${timeout_seconds}s" \
        curl -sS -X POST \
            -H "Content-Type: application/json" \
            -d "$body" \
            -o "$resp_body" \
            -w "%{http_code}" \
            "${url%/}/v1/chat/completions" > "$http_code_file" 2>/dev/null
    local rc=$?
    set -e

    local http_code
    http_code=$(cat "$http_code_file" 2>/dev/null || echo "000")

    # Exit code mapping (matches F1 wrapper semantics exactly).
    # 124 — portable_timeout fired
    if [ "$rc" -eq 124 ]; then
        _oac_cleanup
        return 124
    fi

    # Anything else non-zero from curl is treated as network unreachable.
    if [ "$rc" -ne 0 ]; then
        _oac_cleanup
        return 127
    fi

    # HTTP 4xx/5xx is a hard error.
    if [ -z "$http_code" ] || [ "$http_code" -lt 200 ] || [ "$http_code" -ge 300 ]; then
        _oac_cleanup
        return 1
    fi

    # Parse .choices[0].message.content. `set -e` would normally abort the
    # function the moment `jq -er` exits non-zero inside $(); wrap in set +e.
    set +e
    local content
    content=$(jq -er '.choices[0].message.content' < "$resp_body" 2>/dev/null)
    local parse_rc=$?
    set -e
    if [ "$parse_rc" -ne 0 ]; then
        _oac_cleanup
        return 1
    fi

    # Optional JSON-output validation: pipe content through jq -e . — exit 1
    # if the model produced something that doesn't parse as JSON.
    if [ "$validate_json" = "true" ]; then
        set +e
        printf '%s' "$content" | jq -e . >/dev/null 2>&1
        local vjson_rc=$?
        set -e
        if [ "$vjson_rc" -ne 0 ]; then
            _oac_cleanup
            return 1
        fi
    fi

    printf '%s\n' "$content"
    _oac_cleanup
    return 0
}

# ---------------------------------------------------------------------------
# CLI entrypoint — only fires when this file is executed directly, not when
# sourced. The guard at the bottom of the file selects between the two.
# ---------------------------------------------------------------------------
_oac_usage() {
    cat <<'USAGE'
Usage: openai-compat.sh [options]

Options:
  --model <name>             Model name. Required.
  --url <base_url>           Base URL of the OpenAI-compat endpoint. Required.
  --prompt-file <path>       File containing the user prompt. Required.
  --system-file <path>       Optional system prompt file.
  --max-tokens N             Max tokens in the completion (default: 1024).
  --temperature F            Sampling temperature 0.0..1.0 (default: 0.2).
  --timeout N                Per-call timeout in seconds (default: 60).
  --validate-json-output     Run `jq -e .` on the extracted content;
                             return 1 if the content is not valid JSON.
  --help, -h                 Print this message and exit 0.

Exit codes:
  0   success — model completion on stdout
  1   hard error (HTTP 4xx/5xx, parse failure, or JSON-output validation failure)
  124 timeout
  127 endpoint unreachable

Notes:
  - This adapter does NOT consult RALPH_DELEGATE_ENABLED. It always makes
    an HTTP call when invoked. The opt-in gate lives in ralph-delegate.sh.
  - This adapter does NOT write an audit log. The wrapper handles that.
USAGE
}

_oac_cli_main() {
    local model="" url="" prompt_file="" system_file=""
    local max_tokens="1024" temperature="0.2" timeout_seconds="60"
    local validate_json="false"

    while [ $# -gt 0 ]; do
        case "$1" in
            --model)                 model="$2"; shift 2 ;;
            --url)                   url="$2"; shift 2 ;;
            --prompt-file)           prompt_file="$2"; shift 2 ;;
            --system-file)           system_file="$2"; shift 2 ;;
            --max-tokens)            max_tokens="$2"; shift 2 ;;
            --temperature)           temperature="$2"; shift 2 ;;
            --timeout)               timeout_seconds="$2"; shift 2 ;;
            --validate-json-output)  validate_json="true"; shift ;;
            --help|-h)               _oac_usage; exit 0 ;;
            *) echo "openai-compat: unknown argument: $1" >&2; _oac_usage >&2; exit 1 ;;
        esac
    done

    if [ -z "$model" ] || [ -z "$url" ] || [ -z "$prompt_file" ]; then
        echo "openai-compat: --model, --url, and --prompt-file are required" >&2
        _oac_usage >&2
        exit 1
    fi

    set +e
    openai_compat_post \
        "$url" "$model" "$prompt_file" "$system_file" \
        "$max_tokens" "$temperature" "$timeout_seconds" "$validate_json"
    local rc=$?
    set -e
    exit "$rc"
}

# ---------------------------------------------------------------------------
# Source vs. exec guard. When this file is invoked directly (bash openai-compat.sh ...)
# BASH_SOURCE[0] equals $0 and we run the CLI entrypoint. When sourced from
# ralph-delegate.sh, the function definitions above are loaded but no code runs.
# ---------------------------------------------------------------------------
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    _oac_cli_main "$@"
fi
