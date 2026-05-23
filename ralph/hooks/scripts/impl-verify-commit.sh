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

allow
