#!/usr/bin/env bash
# run.sh — Daily snapshot runner for the Ralph trends pipeline.
#
# Invokes `ralph_hero__capture_snapshot` against the published MCP server
# and appends one row to ~/.ralph-hero/snapshots/<owner>/<projectNumber>.jsonl.
# Designed to be wired up via launchd (see launchd/com.ralph.snapshot.plist.template).
#
# Logs to ~/.ralph-hero/snapshots/run.log (rotated to last 1000 lines after each run,
# matching the dream-loop convention in scripts/dream/logrotate.sh).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=../resolve-env.sh
source "$SCRIPT_DIR/../resolve-env.sh"

LOG_DIR="${HOME}/.ralph-hero/snapshots"
LOG_FILE="${LOG_DIR}/run.log"
MAX_LINES=1000
MCP_VERSION="${RALPH_MCP_VERSION:-latest}"

mkdir -p "$LOG_DIR"

# Redirect both stdout and stderr to the run log (append).
exec >>"$LOG_FILE" 2>&1

echo "----- $(date -u +%Y-%m-%dT%H:%M:%SZ) snapshot run start -----"

# Bridge RALPH_GH_OWNER / RALPH_GH_PROJECT_NUMBER / token from settings files
# into the environment so the MCP server can pick them up.
ralph_bridge_env

if ! command -v mcp >/dev/null 2>&1; then
    echo "ERROR: mcptools (\`mcp\`) is not installed. Install via:"
    echo "  brew tap f/mcptools && brew install mcp"
    echo "  or: go install github.com/f/mcptools/cmd/mcptools@latest"
    exit 1
fi

# Invoke capture_snapshot with no params (defaults pick current project + 7d window).
# Match the run_quick pattern in cli-dispatch.sh.
status=0
mcp call "ralph_hero__capture_snapshot" --params "{}" \
    npx -y "ralph-hero-mcp-server@${MCP_VERSION}" \
    || status=$?

if [ "$status" -ne 0 ]; then
    echo "ERROR: capture_snapshot MCP call failed (exit $status)"
fi

# Logrotate the run log atomically (mirrors scripts/dream/logrotate.sh).
if [ -f "$LOG_FILE" ]; then
    tmp="${LOG_FILE}.rotate.$$"
    tail -n "$MAX_LINES" "$LOG_FILE" > "$tmp"
    mv "$tmp" "$LOG_FILE"
fi

echo "----- $(date -u +%Y-%m-%dT%H:%M:%SZ) snapshot run end (exit $status) -----"

exit "$status"
