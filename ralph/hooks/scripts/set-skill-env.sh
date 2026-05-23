#!/usr/bin/env bash
# Sets RALPH_COMMAND env var for the new slim ralph plugin.
# Invoked at SessionStart; arg passed via the skill's SessionStart hook config (added in later plans).

set -euo pipefail

# Accept RALPH_COMMAND from args (later plans pass via "RALPH_COMMAND=verb" pattern)
for arg in "$@"; do
  case "$arg" in
    RALPH_COMMAND=*)
      export RALPH_COMMAND="${arg#RALPH_COMMAND=}"
      echo "RALPH_COMMAND=${RALPH_COMMAND}" >&2
      ;;
  esac
done

# If no command passed, leave unset (Plan 0 invokes with no skills loaded).
exit 0
