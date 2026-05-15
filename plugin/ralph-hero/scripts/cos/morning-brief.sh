#!/usr/bin/env bash
# morning-brief.sh — unattended cos morning brief with ntfy push
#
# Writes today's situational brief to thoughts/shared/research/YYYY-MM-DD-cos-morning-brief.md
# then pushes a one-line summary to a private ntfy topic (if configured).
#
# Usage:
#   morning-brief.sh [--help|-h]
#
# Environment:
#   RALPH_COS_NTFY_TOPIC     ntfy topic name. If unset, push is skipped (script exits 0).
#   RALPH_COS_THOUGHTS_DIR   Override for the thoughts/ corpus root.
#                            Default: resolves to ../../../../../../thoughts relative to PLUGIN_ROOT
#                            (i.e. ~/projects/thoughts when the plugin lives in ralph-hero/).
#   RALPH_COS_DEBUG          Set to 1 to print resolved paths and summary to stderr before pushing.
#
# Exit codes:
#   0   Brief written (push may or may not have fired — see stderr for push status)
#   1   cos.sh failed or brief file was not created after the run
#   2   Usage error

set -euo pipefail

# ---------------------------------------------------------------------------
# Locate this script's directory robustly (works when symlinked)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# ---------------------------------------------------------------------------
# Derived paths
# ---------------------------------------------------------------------------
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
COS_SH="${SCRIPT_DIR}/cos.sh"
PROMPT_TEMPLATE="${PLUGIN_ROOT}/skills/cos/prompts/morning-brief.md"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
_usage() {
    cat <<'EOF'
morning-brief.sh — unattended cos morning brief with ntfy push

Usage:
  morning-brief.sh [--help|-h]

Writes today's situational brief to:
  thoughts/shared/research/YYYY-MM-DD-cos-morning-brief.md

Then pushes a one-line summary via ntfy (if RALPH_COS_NTFY_TOPIC is set and ntfy is on PATH).

Environment:
  RALPH_COS_NTFY_TOPIC     ntfy topic. Unset = skip push (script still exits 0).
  RALPH_COS_THOUGHTS_DIR   Override for the thoughts/ corpus root directory.
  RALPH_COS_DEBUG          Set to 1 for verbose stderr output.

Manual trigger:
  ralph cos unattended --morning-brief
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing (minimal — this script takes no flags beyond --help)
# ---------------------------------------------------------------------------
for arg in "$@"; do
    case "$arg" in
        --help|-h)
            _usage
            exit 0
            ;;
        *)
            echo "[morning-brief] ERROR: Unknown flag: $arg" >&2
            _usage >&2
            exit 2
            ;;
    esac
done

# ---------------------------------------------------------------------------
# Guard: cos.sh must exist
# ---------------------------------------------------------------------------
if [[ ! -f "$COS_SH" ]]; then
    echo "[morning-brief] ERROR: cos.sh not found at: $COS_SH" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Guard: prompt template must exist
# ---------------------------------------------------------------------------
if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
    echo "[morning-brief] ERROR: prompt template not found at: $PROMPT_TEMPLATE" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Resolve the thoughts/ corpus root
# ---------------------------------------------------------------------------
if [[ -n "${RALPH_COS_THOUGHTS_DIR:-}" ]]; then
    THOUGHTS_DIR="${RALPH_COS_THOUGHTS_DIR}"
else
    # Default: PLUGIN_ROOT is plugin/ralph-hero/ inside the repo.
    # Repo root is two levels up. thoughts/ sibling is one level above repo root.
    # Layout: ~/projects/ralph-hero/plugin/ralph-hero/ → ~/projects/ralph-hero/ → ~/projects/
    # thoughts/ lives at ~/projects/thoughts (sibling of ralph-hero/).
    REPO_ROOT="$(cd "${PLUGIN_ROOT}/../.." && pwd -P)"
    THOUGHTS_DIR="${REPO_ROOT}/../thoughts"
    # Canonicalize (resolve the ../ step)
    THOUGHTS_DIR="$(cd "${THOUGHTS_DIR}" 2>/dev/null && pwd -P)" \
        || THOUGHTS_DIR="${REPO_ROOT}/../thoughts"
fi

# ---------------------------------------------------------------------------
# Compute date and output path
# ---------------------------------------------------------------------------
DATE="$(date +%F)"
OUT_PATH="${THOUGHTS_DIR}/shared/research/${DATE}-cos-morning-brief.md"

# ---------------------------------------------------------------------------
# Ensure the output directory exists
# ---------------------------------------------------------------------------
mkdir -p "$(dirname "$OUT_PATH")"

# ---------------------------------------------------------------------------
# Debug output
# ---------------------------------------------------------------------------
if [[ "${RALPH_COS_DEBUG:-}" == "1" ]]; then
    echo "[morning-brief] DATE=${DATE}" >&2
    echo "[morning-brief] OUT_PATH=${OUT_PATH}" >&2
    echo "[morning-brief] RALPH_COS_NTFY_TOPIC=${RALPH_COS_NTFY_TOPIC:-<unset>}" >&2
    echo "[morning-brief] PROMPT_TEMPLATE=${PROMPT_TEMPLATE}" >&2
fi

# ---------------------------------------------------------------------------
# Substitute placeholders in the prompt template
# ---------------------------------------------------------------------------
RENDERED_PROMPT="$(sed \
    -e "s|{{DATE}}|${DATE}|g" \
    -e "s|{{OUT_PATH}}|${OUT_PATH}|g" \
    "$PROMPT_TEMPLATE")"

# ---------------------------------------------------------------------------
# Create a temp file to capture cos.sh stdout (for SUMMARY extraction)
# ---------------------------------------------------------------------------
TMP_STDOUT="$(mktemp /tmp/morning-brief-stdout.XXXXXX)"
trap 'rm -f "$TMP_STDOUT"' EXIT

# ---------------------------------------------------------------------------
# Invoke cos.sh
# ---------------------------------------------------------------------------
echo "[morning-brief] Starting cos.sh --role default ..." >&2

COS_EXIT=0
"${COS_SH}" --role default "$RENDERED_PROMPT" 2>&1 | tee "$TMP_STDOUT" || COS_EXIT=${PIPESTATUS[0]}

if [[ "$COS_EXIT" -ne 0 ]]; then
    echo "[morning-brief] ERROR: cos.sh exited with code ${COS_EXIT}" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Assert the brief file was created and is non-empty
# ---------------------------------------------------------------------------
if [[ ! -s "$OUT_PATH" ]]; then
    echo "[morning-brief] ERROR: brief file not created or empty: ${OUT_PATH}" >&2
    exit 1
fi

echo "[morning-brief] Brief written to: ${OUT_PATH}" >&2

# ---------------------------------------------------------------------------
# Extract the SUMMARY line from cos.sh stdout
# ---------------------------------------------------------------------------
SUMMARY="$(grep '^SUMMARY:' "$TMP_STDOUT" | tail -1 | sed 's/^SUMMARY:[[:space:]]*//')"

if [[ -z "$SUMMARY" ]]; then
    echo "[morning-brief] WARNING: No SUMMARY: line found in cos.sh output — falling back to first content line" >&2
    # Fall back to the first non-frontmatter, non-empty line of the brief file
    SUMMARY="$(awk '
        /^---$/ { if (++fence == 2) { in_body=1; next } next }
        in_body && NF > 0 { print; exit }
    ' "$OUT_PATH")"
    if [[ -z "$SUMMARY" ]]; then
        SUMMARY="Morning brief written for ${DATE}"
    fi
fi

# Truncate to 120 chars
if [[ "${#SUMMARY}" -gt 120 ]]; then
    echo "[morning-brief] WARNING: SUMMARY exceeds 120 chars (${#SUMMARY}) — truncating" >&2
    SUMMARY="${SUMMARY:0:117}..."
fi

if [[ "${RALPH_COS_DEBUG:-}" == "1" ]]; then
    echo "[morning-brief] SUMMARY=${SUMMARY}" >&2
fi

# ---------------------------------------------------------------------------
# ntfy push
# ---------------------------------------------------------------------------
if command -v ntfy >/dev/null 2>&1; then
    if [[ -n "${RALPH_COS_NTFY_TOPIC:-}" ]]; then
        PUSH_MSG="${SUMMARY} (${OUT_PATH})"
        NTFY_EXIT=0
        ntfy publish "${RALPH_COS_NTFY_TOPIC}" "${PUSH_MSG}" || NTFY_EXIT=$?
        if [[ "$NTFY_EXIT" -eq 0 ]]; then
            echo "[morning-brief] ntfy push: ok" >&2
        else
            echo "[morning-brief] ntfy push: failed (exit ${NTFY_EXIT})" >&2
        fi
    else
        echo "[morning-brief] ntfy push skipped — RALPH_COS_NTFY_TOPIC not set" >&2
    fi
else
    echo "[morning-brief] ntfy not installed — push skipped" >&2
fi

exit 0
