#!/usr/bin/env bash
# work-these.sh — cockpit pane: ask which issues, then hand them to work-fleet.
#
# The capability itself is work-fleet.sh's explicit issue list (GH-1780); this
# is only the surface for how a human expresses it in the cockpit, where there
# is no argv to type into. Empty input falls through to the ranked frontier —
# the same default `work-fleet` has always had, so this pane is a superset of
# that one, never a different policy. Every guard (billing, cap, frontier
# validation, dry run) lives downstream in work-fleet.sh; nothing is duplicated
# here, so the two surfaces cannot drift.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Ralph: work these issues"
echo "  space-separated issue numbers (e.g. 1778 1774), or empty for the ranked frontier."
printf 'issues: '
read -r line || line=""

# shellcheck disable=SC2086  # intentional word-splitting: one argv per issue
exec bash "$SCRIPT_DIR/work-fleet.sh" $line
