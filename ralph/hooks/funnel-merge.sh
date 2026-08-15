#!/usr/bin/env bash
# funnel-merge — courtesy rail (PreToolUse on Bash): bare `gh pr merge` is
# redirected to the repo's merge gate (scripts/merge-pr.sh) WHEN the repo
# ships one. A repo without the gate keeps its own merge flow untouched —
# recommending a gate is `board readiness`'s job, never a hook's. Scope is
# the repo the command runs in: an explicit `-R/--repo` target is another
# repo's merge, outside this rail's jurisdiction (hooks are courtesy, never
# enforcement — the gate's own required checks are the wall). Successor to
# v1's merge-review-decision-gate.sh — the one hook pattern that ever held.
set -euo pipefail

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$CMD" ] || exit 0

# What is QUOTED is an argument, not a command being run (GH-1930): an issue
# body, a doc edit, or a commit message that mentions `gh pr merge` mutates
# nothing, and refusing it makes this rail unable to be written about. Strip
# quoted spans before matching; that can only under-redirect, which is the
# safe direction for a courtesy rail.
UNQUOTED=$(printf '%s' "$CMD" | sed -e "s/'[^']*'//g" -e 's/"[^"]*"//g')

if [[ "$UNQUOTED" == *"gh pr merge"* && "$CMD" != *"scripts/merge-pr.sh"* ]]; then
  case " $CMD" in *" -R "* | *" --repo "* | *" --repo="*) exit 0 ;; esac
  # gh also accepts -R with its value attached, no space (`-Rowner/repo`,
  # gh's own short-flag shorthand — GH-1684). Require a slash in the token
  # right after -R (the [HOST/]OWNER/REPO shape) so an unrelated `-R...`
  # substring elsewhere in the command (e.g. inside a --body string) can't
  # false-trip the bypass.
  ATTACHED_R_RE=' -R[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+'
  if [[ " $CMD" =~ $ATTACHED_R_RE ]]; then
    exit 0
  fi
  CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || CWD=""
  ROOT=$(git -C "${CWD:-$PWD}" rev-parse --show-toplevel 2>/dev/null) || ROOT=""
  if [ -n "$ROOT" ] && [ -f "$ROOT/scripts/merge-pr.sh" ]; then
    if [ -f "$ROOT/scripts/attest-pr.sh" ]; then
      printf 'This repo ships a merge gate: bash %q PR_NUMBER (attest first via bash %q).\n' \
        "$ROOT/scripts/merge-pr.sh" "$ROOT/scripts/attest-pr.sh" >&2
    else
      printf 'This repo ships a merge gate: bash %q PR_NUMBER.\n' \
        "$ROOT/scripts/merge-pr.sh" >&2
    fi
    exit 2
  fi
fi
exit 0
