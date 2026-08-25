#!/usr/bin/env bash
# work-these.sh — cockpit pane: ask which issues, then hand them to work-fleet.
#
# The capability itself is work-fleet.sh's explicit issue list (GH-1780); this
# is only the surface for how a human expresses it in the cockpit, where there
# is no argv to type into. Args, when given, are forwarded straight to
# work-fleet.sh — the prompt exists for the no-argv cockpit case, not to
# discard an argv a caller already typed (GH-2152). An interactively-typed
# empty line falls through to the ranked frontier — the same default
# `work-fleet` has always had, so this pane is a superset of that one, never a
# different policy; EOF on a non-TTY stdin is NOT a human choosing that
# default, so it refuses instead. Every guard (billing, cap, frontier
# validation, dry run) lives downstream in work-fleet.sh; nothing is duplicated
# here, so the two surfaces cannot drift.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$#" -gt 0 ]; then
  exec bash "$SCRIPT_DIR/work-fleet.sh" "$@"
fi

if [ ! -t 0 ]; then
  echo "work-these.sh: no issues given and stdin is not a TTY — refusing to default to the frontier." >&2
  echo "  name the issues: work-fleet.sh [ISSUE...]  (or run work-these.sh interactively)" >&2
  exit 64
fi

echo "Ralph: work these issues"
echo "  space-separated issue numbers (e.g. 1778 1774), or empty for the ranked frontier."
printf 'issues: '
read -r line || line=""

# shellcheck disable=SC2086  # intentional word-splitting: one argv per issue
exec bash "$SCRIPT_DIR/work-fleet.sh" $line
