#!/usr/bin/env bash
# Sets RALPH_* environment variables for a skill session.
# Called from SessionStart hooks in skill frontmatter.
#
# Usage: set-skill-env.sh KEY=VALUE [KEY=VALUE ...]
# Example: set-skill-env.sh RALPH_COMMAND=impl RALPH_REQUIRES_PLAN=true
#
# Writes export statements to $CLAUDE_ENV_FILE so variables persist
# across all subsequent Bash tool invocations in the session.

set -euo pipefail

if [[ -z "${CLAUDE_ENV_FILE:-}" ]]; then
  # Not in a SessionStart context — CLAUDE_ENV_FILE not available
  exit 0
fi

for arg in "$@"; do
  if [[ "$arg" == *=* ]]; then
    echo "export $arg" >> "$CLAUDE_ENV_FILE"
  fi
done
