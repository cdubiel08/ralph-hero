#!/usr/bin/env bash
# Append one line per /ralph:hero -> child-verb dispatch to the activity log,
# scoped to Skill() dispatches issued under RALPH_COMMAND=hero. The activity
# log is consumed by /ralph:catch-up.
#
# Exit codes:
#   0 - Always (observer; never blocks)

set -euo pipefail

source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Scope guard — no-op outside /ralph:hero
[[ "${RALPH_COMMAND:-}" == "hero" ]] || exit 0

skill_name=$(get_field '.tool_input.skill')
[[ -z "$skill_name" ]] && exit 0

# Only log dispatches to child verbs and well-known orchestration helpers.
case "${skill_name##*:}" in
  research|plan|impl|review|caretake|loop|code-review)
    ;;
  hero)
    # Sub-mode dispatches (auto → classify, etc.) are interesting too
    ;;
  *)
    exit 0
    ;;
esac

today=$(date +%Y/%m/%d)
log_dir="${RALPH_ACTIVITY_DIR:-$HOME/.ralph-hero/activity}/$today"
mkdir -p "$log_dir" 2>/dev/null || exit 0

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sub="${RALPH_SUBCOMMAND:-default}"
printf '{"ts":"%s","category":"work","kind":"hero-dispatch","subcommand":"%s","target":"%s"}\n' \
  "$ts" "$sub" "$skill_name" >> "$log_dir/$(date +%H).jsonl" 2>/dev/null || true

exit 0
