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

# The quote-aware command reader every funnel shares (GH-2058). A courtesy rail
# that cannot read its own library must fail OPEN — never block a command
# because a file is missing (the direction hooks.json's CLAUDE_PLUGIN_ROOT
# guard already takes, GH-2045). Resolved beside THIS script rather than from
# CLAUDE_PLUGIN_ROOT: the library is an implementation detail of this file, so
# the copy that ships with it is the one that must be read.
CS_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/lib/cmdscan.sh"
[ -r "$CS_LIB" ] || exit 0
# shellcheck source=lib/cmdscan.sh
. "$CS_LIB" || exit 0

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$CMD" ] || exit 0

# What is QUOTED is an argument, not a command being run (GH-1930): an issue
# body, a doc edit, or a commit message that mentions `gh pr merge` mutates
# nothing, and refusing it makes this rail unable to be written about. Strip
# quoted spans before matching; that can only under-redirect, which is the
# safe direction for a courtesy rail.
#
# The stripper must see the WHOLE command, not a line at a time (GH-2057): a
# quoted span that spans newlines — which every real `--body "..."` is — had
# its opening and closing quotes land on different lines and matched nothing,
# so the span survived and any `gh pr merge` inside it was refused as though
# it were being run. Observed on GH-2057's own filing.
#
# The reading of shell quoting now lives in hooks/lib/cmdscan.sh, shared with
# the three sibling funnels (GH-2058) — the same fix had to be made in four
# places and was made in one, which is the drift GH-1843 already named.
UNQUOTED=$(cs_strip_quotes "$CMD")
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
