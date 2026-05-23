#!/bin/bash
# ralph/hooks/scripts/unblock-request-postcondition.sh
# Stop: Verify /ralph:caretake --mode unblock --question (autonomous variant)
# either posted a ## Unblock Request comment or declared an empty queue.
#
# Scope: ONLY the autonomous sub-mode. The interactive variant has its own
# terminal-token expectation (UNBLOCK RESOLVED / UNBLOCK ESCALATED) — not
# checked here. Other caretake modes pass through.
#
# Environment:
#   RALPH_UNBLOCK_REQUEST_POSTED - "1" if a ## Unblock Request comment was posted
#   RALPH_UNBLOCK_QUEUE_EMPTY    - "1" if there were no eligible issues
#   RALPH_FORCE_STOP             - If "true", allow stop even if postconditions fail
#
# Exit codes:
#   0 - Postconditions met (or out of scope, or escape hatch active)
#   2 - Skill exited without posting a comment or declaring empty queue

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

if [[ "${RALPH_COMMAND:-}" != "caretake" ]]; then
  allow
fi
if [[ "${RALPH_SUBCOMMAND:-}" != "unblock" ]]; then
  allow
fi
# Only enforce on autonomous variant. Interactive sub-mode has different
# terminal-token semantics that we do not gate here.
if [[ "${RALPH_SUBCOMMAND_VARIANT:-interactive}" != "autonomous" ]]; then
  allow
fi

read_input > /dev/null
check_stop_hook_active

if [[ "${RALPH_FORCE_STOP:-}" == "true" ]]; then
  warn "RALPH_FORCE_STOP=true - bypassing unblock-request postcondition check"
fi

if [[ "${RALPH_UNBLOCK_QUEUE_EMPTY:-0}" == "1" ]]; then
  echo "Unblock-request postcondition: queue empty, allowing exit"
  allow
fi

if [[ "${RALPH_UNBLOCK_REQUEST_POSTED:-0}" == "1" ]]; then
  echo "Unblock-request postcondition: ## Unblock Request comment posted"
  allow
fi

block "Unblock-request postcondition failed: no comment posted and no empty queue declared

Expected one of:
  RALPH_UNBLOCK_REQUEST_POSTED=1 (after posting ## Unblock Request comment)
  RALPH_UNBLOCK_QUEUE_EMPTY=1    (no eligible Human Needed issues to process)

Found: neither flag set.

The /ralph:caretake --mode unblock --question body must either post a
## Unblock Request comment on a Human Needed issue or declare the queue
empty before exiting.

If this is a false positive, re-run with RALPH_FORCE_STOP=true to bypass."
