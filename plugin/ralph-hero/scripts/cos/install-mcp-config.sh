#!/usr/bin/env bash
# install-mcp-config.sh — install the COS MCP config into ~/.config/mcp/mcp.json
#
# Reads mcp.json.example from the same directory, substitutes placeholders,
# and merges into ~/.config/mcp/mcp.json (creates the file if it doesn't exist).
#
# Placeholders substituted:
#   __PLUGIN_ROOT__        → absolute path to plugin/ralph-hero
#   __GH_OWNER__           → ${RALPH_GH_OWNER:-cdubiel08}
#   __GH_PROJECT_NUMBER__  → ${RALPH_GH_PROJECT_NUMBER:-3}
#
# Idempotent: running twice will not duplicate mcpServers entries.
# Requires: jq (for merge mode). Falls back to a clear error if jq is missing.
#
# Usage:
#   bash plugin/ralph-hero/scripts/cos/install-mcp-config.sh
#
# Environment:
#   RALPH_GH_OWNER           GitHub owner (default: cdubiel08)
#   RALPH_GH_PROJECT_NUMBER  GitHub project number (default: 3)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
EXAMPLE_FILE="${SCRIPT_DIR}/mcp.json.example"
TARGET_DIR="${HOME}/.config/mcp"
TARGET_FILE="${TARGET_DIR}/mcp.json"

# ---------------------------------------------------------------------------
# Resolve substitution values
# ---------------------------------------------------------------------------

# plugin/ralph-hero absolute path = two levels above scripts/cos/
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"

GH_OWNER="${RALPH_GH_OWNER:-cdubiel08}"
GH_PROJECT_NUMBER="${RALPH_GH_PROJECT_NUMBER:-3}"

echo "[install-mcp-config] Plugin root:      ${PLUGIN_ROOT}"
echo "[install-mcp-config] GitHub owner:     ${GH_OWNER}"
echo "[install-mcp-config] Project number:   ${GH_PROJECT_NUMBER}"
echo "[install-mcp-config] Target:           ${TARGET_FILE}"

# ---------------------------------------------------------------------------
# Check for jq (required for merge)
# ---------------------------------------------------------------------------
if ! command -v jq >/dev/null 2>&1; then
    cat >&2 <<EOF
[install-mcp-config] ERROR: jq is required but not found on PATH.

To install jq:
  brew install jq          (macOS)
  apt-get install jq       (Debian/Ubuntu)

Alternatively, manually merge the following into ~/.config/mcp/mcp.json:
  ${EXAMPLE_FILE}
EOF
    exit 1
fi

# ---------------------------------------------------------------------------
# Read and substitute example
# ---------------------------------------------------------------------------
SUBSTITUTED="$(
    sed \
        -e "s|__PLUGIN_ROOT__|${PLUGIN_ROOT}|g" \
        -e "s|__GH_OWNER__|${GH_OWNER}|g" \
        -e "s|__GH_PROJECT_NUMBER__|${GH_PROJECT_NUMBER}|g" \
        "${EXAMPLE_FILE}"
)"

# Validate the substituted JSON
if ! echo "$SUBSTITUTED" | jq . >/dev/null 2>&1; then
    echo "[install-mcp-config] ERROR: Substituted JSON is invalid — this is a bug." >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Create target directory if needed
# ---------------------------------------------------------------------------
mkdir -p "$TARGET_DIR"

# ---------------------------------------------------------------------------
# Merge or create
# ---------------------------------------------------------------------------
if [[ -f "$TARGET_FILE" ]]; then
    echo "[install-mcp-config] Existing ${TARGET_FILE} detected — merging..."

    # Validate existing file
    if ! jq . "$TARGET_FILE" >/dev/null 2>&1; then
        echo "[install-mcp-config] WARNING: Existing mcp.json is not valid JSON — backing up and replacing." >&2
        cp "$TARGET_FILE" "${TARGET_FILE}.bak.$(date +%Y%m%d%H%M%S)"
        echo "$SUBSTITUTED" | jq 'del(._comment)' > "$TARGET_FILE"
        echo "[install-mcp-config] Replaced (backup: ${TARGET_FILE}.bak.*)"
        exit 0
    fi

    # Extract incoming mcpServers from substituted example (strip _comment)
    INCOMING_SERVERS="$(echo "$SUBSTITUTED" | jq '.mcpServers')"

    # For each incoming server key, add/replace if not already present
    ADDED_KEYS=""
    SKIPPED_KEYS=""

    while IFS= read -r key; do
        # Check if this server key already exists in target
        if jq -e ".mcpServers | has(\"${key}\")" "$TARGET_FILE" >/dev/null 2>&1; then
            SKIPPED_KEYS="${SKIPPED_KEYS} ${key}"
        else
            # Add this server to the target file (idempotent)
            SERVER_DEF="$(echo "$INCOMING_SERVERS" | jq --arg k "$key" '.[$k]')"
            MERGED="$(jq --arg k "$key" --argjson v "$SERVER_DEF" \
                '.mcpServers[$k] = $v' "$TARGET_FILE")"
            echo "$MERGED" > "$TARGET_FILE"
            ADDED_KEYS="${ADDED_KEYS} ${key}"
        fi
    done < <(echo "$INCOMING_SERVERS" | jq -r 'keys[]')

    echo "[install-mcp-config] Servers added:  ${ADDED_KEYS:-none}"
    echo "[install-mcp-config] Servers skipped (already present): ${SKIPPED_KEYS:-none}"

else
    echo "[install-mcp-config] Creating new ${TARGET_FILE}..."
    # Write without the _comment key (internal to the example)
    echo "$SUBSTITUTED" | jq 'del(._comment)' > "$TARGET_FILE"
    echo "[install-mcp-config] Created."
fi

# ---------------------------------------------------------------------------
# Verify result
# ---------------------------------------------------------------------------
echo ""
echo "[install-mcp-config] Final mcpServers:"
jq '.mcpServers | keys' "$TARGET_FILE"

echo ""
echo "[install-mcp-config] Done. To verify:"
echo "  jq '.mcpServers | keys' ~/.config/mcp/mcp.json"
