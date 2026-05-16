#!/usr/bin/env bash
# cos-desk.sh — dispatcher for the cos desk Streamlit dashboard (Phase 5)
# Delegates to desk/launch.sh. Docs: README.md § Desk mode

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

_usage() {
    cat <<EOF
cos desk — Streamlit desktop command surface at :8502

Usage:  ralph cos desk [--help|-h]
Port:   default 8502 (override: RALPH_COS_DESK_PORT=8503 ralph cos desk)
Install: cd plugin/ralph-hero/scripts/cos/desk && uv sync
Tailscale: tailscale serve --bg --https 443 http://localhost:\${RALPH_COS_DESK_PORT:-8502}
Docs:   plugin/ralph-hero/scripts/cos/README.md
EOF
}

for arg in "$@"; do
    case "$arg" in
        --help|-h) _usage; exit 0 ;;
    esac
done

LAUNCHER="${SCRIPT_DIR}/desk/launch.sh"
if [[ ! -f "$LAUNCHER" ]]; then
    echo "[cos-desk] ERROR: desk/launch.sh not found at ${LAUNCHER}" >&2
    exit 127
fi
if [[ ! -x "$LAUNCHER" ]]; then
    echo "[cos-desk] ERROR: desk/launch.sh is not executable at ${LAUNCHER}" >&2
    exit 127
fi

exec "${LAUNCHER}" "$@"
