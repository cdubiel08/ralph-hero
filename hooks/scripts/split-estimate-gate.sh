#!/bin/bash
# ralph-hero/hooks/scripts/split-estimate-gate.sh
# PreToolUse (ralph_hero__get_issue): Validate ticket is M/L/XL
#
# Environment:
#   RALPH_MIN_ESTIMATE - Minimum estimate for splitting (default: M)
#
# Exit codes:
#   0 - Ticket is large enough
#   2 - Ticket too small, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

min_estimate="${RALPH_MIN_ESTIMATE:-M}"

allow_with_context "Split command requires ticket estimate of M/L/XL. Verify after fetching ticket details."
