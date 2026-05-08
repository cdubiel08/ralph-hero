#!/bin/bash
# ralph-hero/hooks/scripts/unblock-request-postcondition.sh
# Stop: Verify autonomous unblock posted a ## Unblock Request comment
#
# The ralph-unblock autonomous skill must either:
#   (a) post a ## Unblock Request comment and set RALPH_UNBLOCK_REQUEST_POSTED=1, OR
#   (b) declare an empty queue (no eligible issues / wrong-state arg) by setting
#       RALPH_UNBLOCK_QUEUE_EMPTY=1
#
# Anything else means the skill exited without doing real work — block.
#
# Environment:
#   RALPH_UNBLOCK_REQUEST_POSTED - "1" if a ## Unblock Request comment was posted
#   RALPH_UNBLOCK_QUEUE_EMPTY    - "1" if there were no eligible issues to process
#   RALPH_FORCE_STOP             - If "true", allow stop even if postconditions fail
#
# Exit codes:
#   0 - Postconditions met (or escape hatch active)
#   2 - Skill exited without posting a comment or declaring empty queue, block

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hook-utils.sh
source "$SCRIPT_DIR/hook-utils.sh"

read_input > /dev/null

# Escape hatch to prevent infinite loops
if [[ "${RALPH_FORCE_STOP:-}" == "true" ]]; then
  warn "RALPH_FORCE_STOP=true - bypassing unblock-request postcondition check"
fi

# Empty queue: no work to do, allow exit
if [[ "${RALPH_UNBLOCK_QUEUE_EMPTY:-0}" == "1" ]]; then
  echo "Unblock-request postcondition: queue empty, allowing exit"
  allow
fi

# Comment posted: real work done, allow exit
if [[ "${RALPH_UNBLOCK_REQUEST_POSTED:-0}" == "1" ]]; then
  echo "Unblock-request postcondition: ## Unblock Request comment posted"
  allow
fi

# Neither flag set — block
block "Unblock-request postcondition failed: no comment posted and no empty queue declared

Expected one of:
  RALPH_UNBLOCK_REQUEST_POSTED=1 (after posting ## Unblock Request comment)
  RALPH_UNBLOCK_QUEUE_EMPTY=1    (no eligible Human Needed issues to process)

Found: neither flag set.

The ralph-unblock skill must either post a ## Unblock Request comment on
a Human Needed issue or declare the queue empty before exiting.

If this is a false positive, re-run with RALPH_FORCE_STOP=true to bypass this check."
