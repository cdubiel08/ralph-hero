#!/usr/bin/env bash
# push-on-completion.sh — shared ntfy completion-push helper
#
# Feature H (GH-1275): iOS remote-control integration
# Plan: thoughts/shared/plans/2026-05-16-GH-1275-ios-remote-integration.md (Phase 2, Task 2.1)
#
# Reuses the ntfy pattern from cos Phase 3 (GH-1255):
#   - Topic: RALPH_COS_NTFY_TOPIC env var
#   - Body:  "$message ($url)" truncated to 117 chars + "..."
#   - Graceful degradation: missing ntfy binary or unset topic → warn + exit 0
#
# Usage (CLI form):
#   push-on-completion.sh "message" "url"
#
# Usage (sourced form — exposes push_on_completion function):
#   source push-on-completion.sh
#   push_on_completion "message" "url"
#
# Exit codes:
#   0  always (best-effort; the underlying operation already succeeded)

set -euo pipefail

# ---------------------------------------------------------------------------
# Core function — works whether sourced or exec'd
# ---------------------------------------------------------------------------
push_on_completion() {
    local message="${1:-}"
    local url="${2:-}"

    # Guard: topic must be set
    if [[ -z "${RALPH_COS_NTFY_TOPIC:-}" ]]; then
        echo "[push-on-completion] ntfy push skipped — RALPH_COS_NTFY_TOPIC not set" >&2
        return 0
    fi

    # Guard: ntfy binary must be on PATH
    if ! command -v ntfy >/dev/null 2>&1; then
        echo "[push-on-completion] ntfy not installed — push skipped" >&2
        return 0
    fi

    # Build body: "$message ($url)", truncated to 117 chars + "..." if needed
    local raw_body="${message} (${url})"
    local body
    if [[ ${#raw_body} -gt 117 ]]; then
        body="${raw_body:0:117}..."
    else
        body="$raw_body"
    fi

    if [[ "${RALPH_COS_DEBUG:-}" == "1" ]]; then
        echo "[push-on-completion] topic=${RALPH_COS_NTFY_TOPIC} body=${body}" >&2
    fi

    # Fire the push
    local rc=0
    ntfy publish "${RALPH_COS_NTFY_TOPIC}" "${body}" || rc=$?

    if [[ "${RALPH_COS_DEBUG:-}" == "1" ]]; then
        echo "[push-on-completion] ntfy exit_code=${rc}" >&2
    fi

    if [[ "$rc" -eq 0 ]]; then
        echo "[push-on-completion] ntfy push: ok" >&2
    else
        echo "[push-on-completion] ntfy push: failed (exit ${rc})" >&2
    fi

    # Always exit 0 — best-effort, the underlying operation already succeeded
    return 0
}

# ---------------------------------------------------------------------------
# CLI entrypoint — only runs when exec'd directly (not when sourced)
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    push_on_completion "${1:-}" "${2:-}"
fi
