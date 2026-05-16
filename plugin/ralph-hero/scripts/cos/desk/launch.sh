#!/usr/bin/env bash
# launch.sh — cos desk launcher
#
# Verifies uv + .venv, then starts Streamlit on RALPH_COS_DESK_PORT (default 8502)
# bound to all interfaces so Tailscale can publish the port.
#
# Usage:
#   launch.sh [--help|-h]
#
# Environment:
#   RALPH_COS_DESK_PORT     Port (default: 8502). Override: RALPH_COS_DESK_PORT=8503 ralph cos desk
#   RALPH_COS_DESK_ADDRESS  Bind address (default: 0.0.0.0). Required for Tailscale serve.
#   RALPH_COS_DEBUG         Set to 1 to print launch info to stderr before exec.
#
# One-time setup:
#   cd plugin/ralph-hero/scripts/cos/desk && uv sync
#
# Tailscale publishing (after launch):
#   tailscale serve --bg --https 443 http://localhost:8502
#   # Dashboard reachable at https://<machine>.<tailnet>.ts.net/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------
_usage() {
    cat <<EOF
cos desk — Streamlit dashboard at localhost:8502 (six panels + chat)

Usage:
  launch.sh [--help|-h]

Environment:
  RALPH_COS_DESK_PORT     Override port (default: 8502)
                          Example: RALPH_COS_DESK_PORT=8503 ralph cos desk
  RALPH_COS_DESK_ADDRESS  Override bind address (default: 0.0.0.0)
  RALPH_COS_DEBUG         Set to 1 to print launch info to stderr

One-time setup:
  cd plugin/ralph-hero/scripts/cos/desk && uv sync

Tailscale publishing:
  tailscale serve --bg --https 443 http://localhost:\${RALPH_COS_DESK_PORT:-8502}
  # → https://<machine>.<tailnet>.ts.net/

Security model: Tailnet-only. The dashboard is read-only; the chat panel routes
through cos.sh → local LLM. Do not publish :8502 to the public internet.
EOF
}

for arg in "$@"; do
    case "$arg" in
        --help|-h)
            _usage
            exit 0
            ;;
    esac
done

# ---------------------------------------------------------------------------
# Preflight: uv
# ---------------------------------------------------------------------------
if ! command -v uv &>/dev/null; then
    echo "[cos-desk] ERROR: uv not found — install from https://docs.astral.sh/uv/" >&2
    exit 127
fi

# ---------------------------------------------------------------------------
# Preflight: .venv
# ---------------------------------------------------------------------------
if [[ ! -d "${SCRIPT_DIR}/.venv" ]]; then
    echo "[cos-desk] ERROR: .venv not found — run 'cd plugin/ralph-hero/scripts/cos/desk && uv sync'" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Port + address (env-overridable)
# ---------------------------------------------------------------------------
PORT="${RALPH_COS_DESK_PORT:-8502}"
ADDRESS="${RALPH_COS_DESK_ADDRESS:-0.0.0.0}"

# ---------------------------------------------------------------------------
# Debug banner
# ---------------------------------------------------------------------------
if [[ "${RALPH_COS_DEBUG:-}" == "1" ]]; then
    echo "[cos-desk] launching streamlit on ${ADDRESS}:${PORT}" >&2
fi

# ---------------------------------------------------------------------------
# Launch
# ---------------------------------------------------------------------------
exec uv run streamlit run "${SCRIPT_DIR}/app.py" \
    --server.port "${PORT}" \
    --server.address "${ADDRESS}" \
    --server.headless true
