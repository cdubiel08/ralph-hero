#!/usr/bin/env bash
# doctor.sh — run the invariant sweep in a popup and hold it open.
#
# Read-only from here: no --fix, no --strict — the popup is for looking.
# The exit code is shown rather than swallowed; a nonzero doctor must not
# close the popup before the human has read why.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

rc=0
"$BOARD" doctor || rc=$?

printf '\n(doctor exit %s) press Enter to close ' "$rc"
read -r _ || true
