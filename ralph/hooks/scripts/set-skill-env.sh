#!/usr/bin/env bash
# ralph/hooks/scripts/set-skill-env.sh
# Sets RALPH_* env vars for a slim ralph plugin skill session.
# Called from SessionStart hooks in skill frontmatter.
#
# Usage: set-skill-env.sh KEY=VALUE [KEY=VALUE ...]
# Example: set-skill-env.sh RALPH_COMMAND=review RALPH_VALID_OUTPUT_STATES='In Review,Done'
#
# Writes `export KEY=VALUE` lines to $CLAUDE_ENV_FILE so the variables
# persist across all subsequent Bash tool invocations in the session AND
# propagate to hook subprocesses spawned by the harness (PreToolUse /
# PostToolUse / Stop). The CLAUDE_ENV_FILE mechanism is the only path
# that survives the per-call subshell isolation of the Bash tool — bare
# `export` in this script's own process is throwaway.
#
# The CLAUDE_ENV_FILE write is load-bearing: without it every hook that
# gates on RALPH_COMMAND (state-gate.sh scope args, plan-postcondition's
# mode branch, etc.) hits its scope guard
# `if [[ "${RALPH_COMMAND:-}" != "<verb>" ]]; then allow` and exits 0
# without ever running its validation.
#
# Exit codes:
#   0 — always (silent no-op when CLAUDE_ENV_FILE is unset, e.g. when
#       invoked outside a SessionStart context).

set -euo pipefail

if [[ -z "${CLAUDE_ENV_FILE:-}" ]]; then
  # Not in a SessionStart context (or harness doesn't provide
  # CLAUDE_ENV_FILE for this skill type). Nothing to persist.
  exit 0
fi

for arg in "$@"; do
  if [[ "$arg" == *=* ]]; then
    echo "export $arg" >> "$CLAUDE_ENV_FILE"
  fi
done

exit 0
