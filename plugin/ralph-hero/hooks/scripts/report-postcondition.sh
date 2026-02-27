#!/usr/bin/env bash
# Postcondition for ralph-report: warn-only, permissive check.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"
read_input

if [[ "${RALPH_COMMAND:-}" != "report" ]]; then
  allow
fi

# Lightweight check — warn only, don't block
allow
