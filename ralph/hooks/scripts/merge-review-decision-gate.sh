#!/bin/bash
# ralph/hooks/scripts/merge-review-decision-gate.sh
# PreToolUse:Bash — FUNNEL raw `gh pr merge` invocations to the verified
# merge path (scripts/merge-pr.sh).
#
# GH-1589 demotion (epic #1588): this hook no longer verifies anything
# itself. It used to fetch reviewDecision + carve-outs over the network
# (254 lines, Claude-Code-only — zero protection for any other harness).
# Truth enforcement now lives in layers every harness shares:
#   - scripts/merge-pr.sh      — client-side gates (review, CI, attestation,
#                                external review), plain bash + gh + jq
#   - validate-attestation.yml — server-side ralph-attestation commit status
# What remains HERE is shape enforcement only: inside /ralph:review, the
# merge must go through the script so those gates actually run. A bare
# `gh pr merge` would silently skip them.
#
# Scope:
#   - Active only when RALPH_COMMAND=review (same scope as before).
#   - Self-discriminates on tool_input.command — no-op for any Bash that
#     does not invoke `gh pr merge`.
#   - `scripts/merge-pr.sh` invocations pass through untouched — the script
#     self-gates; duplicating its checks here would just drift.
#
# Exit codes:
#   0 — allow (not a merge, out of scope, or the funnel path)
#   2 — block (bare `gh pr merge` inside a review session)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Slim-plugin scope: only activate inside /ralph:review.
if [[ "${RALPH_COMMAND:-}" != "review" ]]; then
  allow
fi

read_input > /dev/null

cmd=$(get_field '.tool_input.command')
if [[ -z "$cmd" ]]; then
  allow
fi

# The verified path passes through untouched.
if echo "$cmd" | grep -qE 'scripts/merge-pr\.sh'; then
  allow
fi

# Bare `gh pr merge` → funnel to the script.
if echo "$cmd" | grep -qE 'gh[[:space:]]+pr[[:space:]]+merge\b'; then
  block "merge-review-decision-gate: use the verified merge path, not bare \`gh pr merge\`.

Command: $cmd

Merge via:
  bash scripts/merge-pr.sh PR_NUMBER [WORKTREE_ID]

The script enforces the merge gates (CHANGES_REQUESTED block, CI checks
green, attestation valid + head_sha-bound, external review present) from
any shell — see ralph/skills/review/merge-gate.md. A documented escape
hatch exists: scripts/merge-pr.sh PR_NUMBER --force \"reason\" posts a
durable override comment before merging (GH-1589)."
fi

allow
