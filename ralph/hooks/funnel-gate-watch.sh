#!/usr/bin/env bash
# funnel-gate-watch — courtesy rail (PreToolUse on Bash): a *polling loop* over
# `gh pr checks` is redirected to scripts/pr-gate-watch.sh WHEN the repo ships
# one.
#
# Unlike the other funnels, this one redirects away from something that cannot
# work rather than merely something unsanctioned. On a repo running the GH-1589
# merge gate, `ralph-attestation` is published as pending and stays pending
# until scripts/attest-pr.sh runs, so
#   until ! gh pr checks PR | grep -q pending; do sleep 30; done
# never terminates — and its silence looks exactly like "CI still running".
# pr-gate-watch.sh classifies whose turn it is and exits when it is yours.
#
# One-shot `gh pr checks PR` is left alone: reading current state is fine, it
# is only the wait-for-quiescence loop that is broken. Scope is the repo the
# command runs in — an explicit -R/--repo target is another repo's PR, outside
# this rail's jurisdiction (hooks are courtesy, never enforcement).
#
# Registered for BOTH Bash and Monitor in hooks.json: an armed Monitor is the
# form this mistake actually takes (it fails silently for the whole session
# rather than returning), and both tools carry the command in
# .tool_input.command, so one script serves both.
set -euo pipefail

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$CMD" ] || exit 0

# `gh pr checks` as an actual COMMAND, not the string appearing anywhere. A
# substring test redirects `echo "gh pr checks"` inside an unrelated loop
# (CodeRabbit, PR #1764). Require a command boundary before `gh` — start of
# line, or after a separator/opener that can begin one.
# The boundary set is the shell contexts a command can START in: line start,
# a separator (; & |), a subshell/substitution opener, a negation (`until !
# gh ...` is the canonical form of the very loop this rail exists for), or a
# keyword. Anything else before `gh` — most importantly a quote, as in
# `echo "gh pr checks"` — is not a command position.
GH_CHECKS_RE='(^|[;&|(!]|`|\$\()[[:space:]]*(!?[[:space:]]*)(do|then|else|until|while|if)?[[:space:]]*(!?[[:space:]]*)gh[[:space:]]+pr[[:space:]]+checks([[:space:]]|$)'
if [[ ! " $CMD" =~ $GH_CHECKS_RE ]]; then
  exit 0
fi

# Already using the watcher (or invoking it by name) — nothing to redirect.
case "$CMD" in
  *pr-gate-watch.sh*) exit 0 ;;
esac

# Only poll loops. A bare `gh pr checks 1740` is a perfectly good thing to run,
# and so is one piped through grep/jq for a one-time read.
case "$CMD" in
  *until*| *while*| *"sleep "*) ;;
  *) exit 0 ;;
esac

# -R/--repo bypass, mirroring funnel-merge.sh — including gh's attached
# short-option form (`-Rowner/repo`, GH-1684). Require the [HOST/]OWNER/REPO
# slash shape so an unrelated `-R...` substring cannot false-trip the bypass.
#
# The bypass is as narrow as the trip: a bare ` -R ` or ` --repo ` anywhere in
# the command line let an UNRELATED flag (`grep --repo-mode`, another tool's
# -R) silence the rail on a loop that does target this repo (CodeRabbit,
# #1764). Each form now requires the owner/repo argument that makes it a gh
# repo selector.
SEP_R_RE='([[:space:]]|^)(-R|--repo)([[:space:]]+|=)[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+'
if [[ " $CMD" =~ $SEP_R_RE ]]; then
  exit 0
fi
ATTACHED_R_RE=' -R[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+'
if [[ " $CMD" =~ $ATTACHED_R_RE ]]; then
  exit 0
fi

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || CWD=""
ROOT=$(git -C "${CWD:-$PWD}" rev-parse --show-toplevel 2>/dev/null) || ROOT=""
if [ -n "$ROOT" ] && [ -f "$ROOT/scripts/pr-gate-watch.sh" ]; then
  printf 'A `gh pr checks` poll loop cannot terminate in this repo: the attestation status stays pending until scripts/attest-pr.sh runs, so the loop waits on you and its silence is indistinguishable from CI still running.\nUse the classifier instead: bash %q PR --watch\nIt prints one line per state change and exits when the next move is yours (attestation, a review nudge, a failure, or ready-to-merge).\n' \
    "$ROOT/scripts/pr-gate-watch.sh" >&2
  exit 2
fi
exit 0
