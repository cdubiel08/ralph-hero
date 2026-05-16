#!/usr/bin/env bash
# install-schedules.sh — Register the three Caretaker heartbeat schedules.
#
# Usage:
#   bash plugin/ralph-hero/scripts/caretake/install-schedules.sh
#
# Creates (or skips if already present) three /schedule entries:
#   caretake-hourly-hygiene  — hourly board-hygiene pass
#   caretake-daily-report    — daily status-report post
#   caretake-weekly-trends   — weekly trends sparkline
#
# Cron expressions are overridable via env vars:
#   RALPH_CARETAKE_HYGIENE_CRON   (default: "0 * * * *")
#   RALPH_CARETAKE_REPORT_CRON    (default: "0 9 * * *")
#   RALPH_CARETAKE_TRENDS_CRON    (default: "0 9 * * 1")
#
# Idempotent: re-running does not create duplicate schedules.
# The script prints one summary line per schedule (registered or skipped).
#
# Prerequisite: Claude Code must be running and the /schedule skill must be
# available. This script invokes `claude -p` headless to create each schedule.
# If `claude` is not on $PATH, the script prints the manual commands and exits 0.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Cron expressions (env-overridable)
HYGIENE_CRON="${RALPH_CARETAKE_HYGIENE_CRON:-0 * * * *}"
REPORT_CRON="${RALPH_CARETAKE_REPORT_CRON:-0 9 * * *}"
TRENDS_CRON="${RALPH_CARETAKE_TRENDS_CRON:-0 9 * * 1}"

SKILL_PREFIX="/ralph-hero:caretake"

# ---------------------------------------------------------------------------
# Helper: check if `claude` CLI is available
# ---------------------------------------------------------------------------
has_claude() {
    command -v claude >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Helper: create one schedule via `claude -p` headless, or print manual cmd
# ---------------------------------------------------------------------------
# Args: <name> <cron> <mode>
register_schedule() {
    local name="$1"
    local cron="$2"
    local mode="$3"
    local prompt="$SKILL_PREFIX --mode $mode"

    if has_claude; then
        # Use the /schedule skill to create the entry. The skill is idempotent
        # when given a stable name — it skips creation if a schedule with the
        # same name already exists.
        local output claude_exit
        claude_exit=0
        output=$(claude -p "$(cat <<PROMPT
/schedule create --name "$name" --cron "$cron" --prompt "$prompt"
PROMPT
        )" 2>&1) || claude_exit=$?

        if [ "$claude_exit" -ne 0 ]; then
            printf "[install-schedules] FAILED %s: claude -p exited %d\n" "$name" "$claude_exit"
            printf "    output: %s\n" "$output" | head -10
            return 1
        fi

        if echo "$output" | grep -qi "already exists\|skipped\|duplicate"; then
            echo "  SKIPPED  $name (already registered)"
        else
            echo "  REGISTERED $name  cron=\"$cron\"  prompt=\"$prompt\""
        fi
    else
        # claude CLI not available — print the manual command for copy-paste
        echo "  MANUAL   $name"
        echo "           claude -p \"/schedule create --name \\\"$name\\\" --cron \\\"$cron\\\" --prompt \\\"$prompt\\\"\""
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
echo "Caretaker heartbeat schedule installer"
echo "Plugin root: $PLUGIN_ROOT"
echo ""

if ! has_claude; then
    echo "NOTE: 'claude' CLI not found on PATH. Run the commands below manually:"
    echo "      (Install: https://claude.ai/download)"
    echo ""
fi

register_schedule "caretake-hourly-hygiene" "$HYGIENE_CRON" "hygiene"
register_schedule "caretake-daily-report"   "$REPORT_CRON"  "report"
register_schedule "caretake-weekly-trends"  "$TRENDS_CRON"  "trends"

echo ""
echo "Done. Verify with: claude -p '/schedule list'"
