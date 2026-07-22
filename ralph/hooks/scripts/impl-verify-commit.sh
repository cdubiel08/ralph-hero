#!/bin/bash
# ralph-hero/hooks/scripts/impl-verify-commit.sh
# PostToolUse (Bash): Verify phase commit/push succeeded
#
# Exit codes:
#   0 - Git operation successful or not a git command
#   2 - Push rejected or pre-commit hook failed (blocks)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Slim-plugin scope: only activate for /ralph:impl.
if [[ "${RALPH_COMMAND:-}" != "impl" ]]; then
  allow
fi

read_input > /dev/null

command=$(get_field '.tool_input.command')
if [[ -z "$command" ]]; then
  allow
fi

if [[ "$command" != *"git commit"* ]] && [[ "$command" != *"git push"* ]]; then
  allow
fi

# PostToolUse on Bash exposes the result under tool_response.{stdout,stderr,exitCode}.
# Concatenate stdout + stderr so the pattern matches catch git output regardless of
# which stream the failure surfaces on (push rejections typically write to stderr).
tool_stdout=$(get_field '.tool_response.stdout')
tool_stderr=$(get_field '.tool_response.stderr')
tool_output="${tool_stdout}
${tool_stderr}"

if [[ "$tool_output" == *"nothing to commit"* ]]; then
  warn "Git commit had nothing to commit. Phase changes may not have been staged with 'git add'."
fi

if [[ "$tool_output" == *"rejected"* ]] || [[ "$tool_output" == *"failed to push"* ]]; then
  block "Git push was rejected

$tool_output

To fix: git pull --rebase origin [branch] && git push

Do not proceed to the next phase until push succeeds."
fi

if [[ "$tool_output" == *"pre-commit hook"* ]] && [[ "$tool_output" == *"failed"* ]]; then
  block "Pre-commit hook failed

$tool_output

Fix the issues reported by the pre-commit hook before continuing."
fi

# Best-effort observability side-channel: append a `phase_completed` activity
# event when the commit message follows the plan's `Phase [N] of [M]: #NNN`
# convention (plan-compliance.md §Staging Algorithm step 6). Never blocks —
# every failure path (no match, unwritable dir, append failure) degrades to
# a silent no-op and the hook still reaches `allow` below.
log_phase_completed_event() {
  local command="$1"
  local phase_n phase_m issue_num
  if [[ "$command" =~ Phase\ ([0-9]+)\ of\ ([0-9]+):\ \#([0-9]+) ]]; then
    phase_n="${BASH_REMATCH[1]}"
    phase_m="${BASH_REMATCH[2]}"
    issue_num="${BASH_REMATCH[3]}"
  else
    return 0
  fi

  local activity_root month_dir day_file ts
  activity_root="${RALPH_ACTIVITY_DIR:-$HOME/.ralph-hero/activity}"
  month_dir="$activity_root/$(date +%Y/%m)"
  day_file="$month_dir/$(date +%d).jsonl"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  mkdir -p "$month_dir" 2>/dev/null || return 0
  printf '{"ts":"%s","category":"work","kind":"phase_completed","target":{"issue":%s,"phase":%s,"totalPhases":%s}}\n' \
    "$ts" "$issue_num" "$phase_n" "$phase_m" >> "$day_file" 2>/dev/null || return 0
}

if [[ "$command" == *"git commit"* ]]; then
  log_phase_completed_event "$command" || true
fi

allow
