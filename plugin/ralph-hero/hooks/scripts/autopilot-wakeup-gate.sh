#!/bin/bash
# ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh
# PreToolUse gate for ScheduleWakeup calls made by the autopilot skill.
#
# Validates ScheduleWakeup calls match autopilot semantics with TWO checks:
#   1. prompt regex: must start with "/ralph-hero:autopilot" (sufficient evidence
#      the call is autopilot-driven; this is the only required check).
#   2. cache-window anti-pattern: delaySeconds must NOT equal 300 (5-min cache
#      window — the documented anti-pattern). Other values are allowed; this is
#      a single-value blacklist, not an allowlist.
#
# Note: this gate intentionally does NOT check RALPH_COMMAND=autopilot env var.
# Per the R2 critique design choice in the parent plan (GH-1136 §Phase 4),
# `set-skill-env.sh` writes RALPH_COMMAND to $CLAUDE_ENV_FILE which is
# per-session and unverified across ScheduleWakeup re-fires. The prompt regex
# is the load-bearing check.
#
# Reference: plugin/ralph-hero/skills/autopilot/SKILL.md (Phase 4).
# Style reference: plugin/ralph-hero/hooks/scripts/split-estimate-gate.sh.
#
# Exit codes:
#   0 - Allowed (call is autopilot-shaped and not the 300s anti-pattern, or
#       tool is not ScheduleWakeup at all)
#   2 - Blocked (bad prompt or cache-window anti-pattern)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

tool=$(get_field '.tool_name')

# Defense-in-depth: the matcher should already filter, but pass through any
# non-ScheduleWakeup invocations cleanly.
if [[ "$tool" != "ScheduleWakeup" ]]; then
  exit 0
fi

delay=$(echo "$RALPH_HOOK_INPUT" | jq -r '.tool_input.delaySeconds // 0')
prompt=$(echo "$RALPH_HOOK_INPUT" | jq -r '.tool_input.prompt // ""')

# Check 1: prompt must re-invoke the autopilot skill.
if [[ ! "$prompt" =~ ^/ralph-hero:autopilot ]]; then
  echo "Autopilot ScheduleWakeup must re-invoke /ralph-hero:autopilot, got: $prompt" >&2
  exit 2
fi

# Check 2: cache-window anti-pattern. delaySeconds=300 lands exactly on the
# 5-minute prompt-cache boundary, where neither a warm cache hit nor a clean
# cache miss is reliable. Pick <=270 (warm) or >=1200 (committed) instead.
if [[ "$delay" == "300" ]]; then
  echo "delaySeconds=300 is the 5-min cache-window anti-pattern — pick <=270 or >=1200" >&2
  exit 2
fi

exit 0
