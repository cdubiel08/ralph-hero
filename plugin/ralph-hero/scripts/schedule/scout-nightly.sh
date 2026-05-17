#!/usr/bin/env bash
# scout-nightly.sh — nightly Scout sweep via /schedule
#
# This script is the harness-executable body for the `scout-nightly` /schedule routine.
# It invokes /ralph-playwright:test-e2e against the latest deployed build URL and labels
# any findings as `scout-auto` so Director routes them to the Scout team.
#
# Registration (one-time, run by a human or caretaker after deploying):
#   /schedule create scout-nightly --cron "0 3 * * *" \
#     --script plugin/ralph-hero/scripts/schedule/scout-nightly.sh
#
# Confirm registration:
#   /schedule list
#
# Required environment:
#   RALPH_DEPLOYED_BUILD_URL — URL of the latest deployed build to test against.
#                              Defaults to http://localhost:3100 for local-only setups.
#
# Optional environment:
#   RALPH_SCOUT_LABEL        — Label applied to issues filed by this run.
#                              Defaults to scout-auto.
#
# Exit codes:
#   0   Script completed (stories ran; findings may or may not have been filed)
#   1   Prerequisites not met (claude not on PATH, or setup incomplete)
#
# NOTE: This script delegates to /ralph-playwright:test-e2e via `claude -p`. The skill
# itself handles story discovery, execution, reflection, and issue filing. This script
# only sets the target URL and label, then hands off.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DEPLOYED_BUILD_URL="${RALPH_DEPLOYED_BUILD_URL:-http://localhost:3100}"
SCOUT_LABEL="${RALPH_SCOUT_LABEL:-scout-auto}"

# ---------------------------------------------------------------------------
# Preflight: claude CLI required
# ---------------------------------------------------------------------------
if ! command -v claude >/dev/null 2>&1; then
  echo "[scout-nightly] ERROR: claude not found on PATH — install Claude Code CLI" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Run the nightly sweep
# ---------------------------------------------------------------------------
echo "[scout-nightly] Starting nightly Scout sweep"
echo "[scout-nightly] Target URL: ${DEPLOYED_BUILD_URL}"
echo "[scout-nightly] Issue label: ${SCOUT_LABEL}"
echo "[scout-nightly] $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo ""

# Invoke test-e2e via claude -p, passing the deployed URL and label as env vars.
# The skill reads playwright-stories/**/*.yaml, executes them against the target
# URL, and files any critical/high findings as GitHub issues with the given label.
export RALPH_DEPLOYED_BUILD_URL="${DEPLOYED_BUILD_URL}"
mkdir -p "${HOME}/.ralph-hero/schedule/"
claude -p "/ralph-playwright:test-e2e --label ${SCOUT_LABEL}" \
  2>&1 | tee -a "${HOME}/.ralph-hero/schedule/scout-nightly-$(date +%Y%m%d).log" || {
    echo "[scout-nightly] WARNING: test-e2e invocation exited non-zero — check log above" >&2
    # Non-fatal: schedule runner should not treat a test failure as a script failure.
    # The findings (if any) have already been filed by test-e2e before it exits.
  }

echo ""
echo "[scout-nightly] Sweep complete. Check GitHub issues for label '${SCOUT_LABEL}'."
