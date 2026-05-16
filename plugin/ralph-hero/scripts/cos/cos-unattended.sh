#!/usr/bin/env bash
# cos-unattended.sh — dispatcher for scheduled unattended cos jobs
#
# Usage:
#   cos-unattended.sh --morning-brief   Run today's morning brief
#   cos-unattended.sh --help            Show this usage
#   cos-unattended.sh                   Show usage (exits 0)
#
# Manual trigger (preferred interface):
#   ralph cos unattended --morning-brief
#
# Each job flag delegates to its dedicated script in the same directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

_usage() {
    cat <<'EOF'
Usage: ralph cos unattended <job-flag>

Jobs:
  --morning-brief    Run today's morning brief (writes thoughts/shared/research/<date>-cos-morning-brief.md
                     and pushes ntfy notification if RALPH_COS_NTFY_TOPIC is configured)

Other unattended jobs (EOD digest, week review, self-improve) land in later phases (#1258).

Environment:
  RALPH_COS_NTFY_TOPIC     ntfy topic for push notifications (optional)
  RALPH_COS_THOUGHTS_DIR   Override for thoughts/ corpus root (optional)
  RALPH_COS_DEBUG          Set to 1 for verbose output (optional)
EOF
}

if [[ $# -eq 0 ]]; then
    _usage
    exit 0
fi

case "$1" in
    --help|-h)
        _usage
        exit 0
        ;;
    --morning-brief)
        exec "${SCRIPT_DIR}/morning-brief.sh"
        ;;
    *)
        echo "[unattended] unknown flag: $1" >&2
        echo "Run 'ralph cos unattended --help' for usage." >&2
        exit 2
        ;;
esac
