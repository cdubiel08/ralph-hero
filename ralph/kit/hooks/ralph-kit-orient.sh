#!/usr/bin/env bash
# ralph-kit-orient.sh — SessionStart orientation for a ralph-kit host repo
# (audit C3). ONE advisory line so a fresh session does not pay the measured
# 5-15-call discovery walk (GH-2074/GH-2075) to learn this repo ships the
# merge-gate family — or that it has a board configured and no gates at all
# (the repo that merged bare and stranded 8 completed issues).
#
# ADVISORY ONLY: prints to stdout (SessionStart context), always exits 0, and
# prints NOTHING when it cannot read the repo — an unreadable state must not
# manufacture an orientation line. No network, no gh.
#
# Canonical source: ralph/scripts/kit-src/ralph-kit-orient.sh (kit-sync.sh
# vendors it into ralph/kit/; install-gates.sh lands it in host repos at
# .claude/hooks/ralph-kit-orient.sh and prints the settings line to register
# it — this file never edits host settings itself).
set -u

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -n "$ROOT" ] || exit 0

board_configured=0
if [ -f "$ROOT/.ralph.json" ]; then
  board_configured=1
elif [ -f "$ROOT/.claude/settings.json" ] && command -v jq >/dev/null 2>&1 \
  && jq -e '.env.RALPH_GH_PROJECT_NUMBER' "$ROOT/.claude/settings.json" >/dev/null 2>&1; then
  board_configured=1
fi

if [ -f "$ROOT/scripts/merge-pr.sh" ] && [ -f "$ROOT/scripts/pr-gate-watch.sh" ]; then
  echo "this repo ships scripts/{pr-gate-watch,attest-pr,merge-pr}.sh — after any push: bash scripts/pr-gate-watch.sh <PR> --watch"
elif [ "$board_configured" = 1 ]; then
  echo "board configured, gates not installed — run install-gates.sh (from the ralph plugin) to install the merge-gate kit"
fi

exit 0
