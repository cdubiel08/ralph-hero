#!/usr/bin/env bash
# run.sh — Daily autonomous unblock runner.
#
# Invokes the `ralph-hero:ralph-unblock` skill via `claude -p`. The skill
# picks the oldest Human Needed issue without a fresh `## Unblock Request`
# comment and posts blocking questions for the human to answer later via the
# interactive `/ralph-hero:unblock` skill. Designed to be wired up via
# launchd (see launchd/com.ralph.unblock.plist.template).
#
# Logs to ~/.ralph-hero/unblock/run.log (rotated to last 1000 lines after
# each run, matching the snapshot/dream-loop convention).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=../resolve-env.sh
source "$SCRIPT_DIR/../resolve-env.sh"

LOG_DIR="${HOME}/.ralph-hero/unblock"
LOG_FILE="${LOG_DIR}/run.log"
MAX_LINES=1000

mkdir -p "$LOG_DIR"

# Redirect both stdout and stderr to the run log (append).
exec >>"$LOG_FILE" 2>&1

echo "----- $(date -u +%Y-%m-%dT%H:%M:%SZ) unblock run start -----"

# Bridge RALPH_GH_OWNER / RALPH_GH_PROJECT_NUMBER / token from settings files
# into the environment so the MCP server can pick them up.
ralph_bridge_env

if ! command -v claude >/dev/null 2>&1; then
    echo "ERROR: claude CLI is not installed. Install via:"
    echo "  https://docs.claude.com/en/docs/claude-code"
    exit 1
fi

# Run the autonomous unblock skill once. The skill picks the oldest Human
# Needed issue without a fresh `## Unblock Request` comment and posts
# blocking questions.
status=0
claude -p "Run the ralph-hero:ralph-unblock skill once. Pick the oldest Human Needed issue without a fresh ## Unblock Request comment. Post the blocking questions and exit." \
    || status=$?

if [ "$status" -ne 0 ]; then
    echo "ERROR: ralph-unblock skill failed (exit $status)"
fi

# Logrotate the run log atomically (mirrors scripts/snapshot/run.sh).
if [ -f "$LOG_FILE" ]; then
    tmp="${LOG_FILE}.rotate.$$"
    tail -n "$MAX_LINES" "$LOG_FILE" > "$tmp"
    mv "$tmp" "$LOG_FILE"
fi

echo "----- $(date -u +%Y-%m-%dT%H:%M:%SZ) unblock run end (exit $status) -----"

exit "$status"
