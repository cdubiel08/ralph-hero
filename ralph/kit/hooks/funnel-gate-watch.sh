#!/usr/bin/env bash
# funnel-gate-watch — courtesy rail (PreToolUse on Bash and Monitor): a POLLING
# LOOP over `gh pr checks` is pointed at the repo's gate classifier
# (scripts/pr-gate-watch.sh, GH-1763) when the repo ships one.
#
# The loop it catches cannot terminate in a repo that ships the merge gate:
# `ralph-attestation` is published PENDING by design and stays pending until
# `scripts/attest-pr.sh` runs, so
#   until ! gh pr checks PR | grep -q pending; do sleep 30; done
# waits on its own caller forever — and its silence is indistinguishable from
# CI still running. Registered for Monitor as well as Bash because an armed
# Monitor is the form the mistake actually takes: a Bash loop at least returns.
#
# ADVISORY ONLY — prints to stderr and exits 0, never 2 (GH-1845).
# CLAUDE.md: the hooks are courtesy redirects and are NEVER counted as
# enforcement; board.ts, state-guard.yml and the merge gate are the three
# enforcement layers. `hint-pr-linkage.sh` (GH-1717) is the precedent. This
# rail redirects a loop that is merely futile, not one that mutates anything,
# so blocking it would spend the strongest signal a hook has on the weakest
# case — and a false trip would strand a session with no way past it.
#
# Two match narrowings, both live defects found in review before the split:
#   * COMMAND POSITION, not substring. `*"gh pr checks"*` fires on
#     `while true; do echo "gh pr checks"; sleep 30; done` — a rail tripping on
#     a loop that never calls gh. `gh` must follow a line start, a separator,
#     a substitution opener, a negation, or a shell keyword. The negation case
#     is essential: `until ! gh pr checks ...` is the canonical form.
#   * The -R/--repo BYPASS must be as narrow as the trip. A bare ` -R `
#     anywhere lets an unrelated flag silence the rail on a loop that does
#     target this repo, so the owner/repo argument is required — including
#     gh's attached `-Rowner/repo` form.
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
# body or a doc describing this rail must not trip it. Stripping can only
# under-redirect, the safe direction for something that is never enforcement.
#
# But a command substitution INSIDE double quotes is execution, not an
# argument — `until [ -z "$(gh pr checks N)" ]` is exactly the loop this rail
# exists for, and stripping it wholesale is how the rail would go silent on its
# own canonical case. So a double-quoted span is stripped only when it contains
# no `$(` and no backtick; single quotes suppress substitution entirely and are
# always stripped.
#
# The stripper reads the WHOLE command, not a line at a time (GH-2058): the
# `sed` this replaced could not match a quoted span whose opening and closing
# quotes landed on different lines, which is every multi-line `--body`, so a
# body describing this loop kept its `gh pr checks` visible and drew the
# advisory. Same defect GH-2057 fixed in funnel-merge.sh, one file over.
UNQUOTED=$(cs_strip_quotes "$CMD" 1)

# Already using the classifier — nothing to redirect.
case "$UNQUOTED" in *pr-gate-watch.sh*) exit 0 ;; esac

# `gh pr checks` in COMMAND POSITION. Whitespace is normalised first so the
# separator alternation does not have to spell every spacing variant.
NORM=$(printf '%s' "$UNQUOTED" | tr '\n\t' '  ' | tr -s ' ')
GH_RE='(^|[;&|(`]|\$\(|!|[[:space:]](do|then|else|until|while|if))[[:space:]]*gh[[:space:]]+pr[[:space:]]+checks([[:space:]]|$)'
[[ " $NORM" =~ $GH_RE ]] || exit 0

# A POLL LOOP, not a single call. `gh pr checks PR` once is a legitimate read
# and is never in scope; the defect is waiting on it. Require both a loop
# keyword and a sleep — the canonical form has both, and demanding them
# together is what keeps a `for pr in ...; do gh pr checks $pr; done` sweep out.
[[ " $NORM" =~ [[:space:]](until|while|for)[[:space:]] ]] || exit 0
SLEEP_RE='(^|[;&|(`[:space:]])sleep[[:space:]]'
[[ " $NORM" =~ $SLEEP_RE ]] || exit 0

# Another repo's PR is outside this rail's jurisdiction. Every bypass form
# requires the [HOST/]OWNER/REPO argument, so an unrelated `--repo-mode`-ish
# flag cannot silence the rail on a loop that does target this repo.
REPO_RE='[[:space:]](-R|--repo)[[:space:]=]?[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+'
[[ " $CMD" =~ $REPO_RE ]] && exit 0

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || CWD=""
ROOT=$(git -C "${CWD:-$PWD}" rev-parse --show-toplevel 2>/dev/null) || ROOT=""
# A redirect must name a path the session can actually run.
[ -n "$ROOT" ] && [ -f "$ROOT/scripts/pr-gate-watch.sh" ] || exit 0

# Hand back a runnable line when the PR number is recoverable.
PR=""
TAIL="${NORM#* gh pr checks }"
for tok in $TAIL; do
  case "$tok" in [0-9]*) [[ "$tok" =~ ^[0-9]+$ ]] && PR="$tok" ;; esac
  [ -n "$PR" ] && break
  case "$tok" in -*) continue ;; *) break ;; esac
done

printf 'A `gh pr checks` poll loop cannot terminate here: `ralph-attestation` is published pending by design and stays pending until scripts/attest-pr.sh runs, so the loop waits on its own caller and its silence reads like CI still running.\n  bash %q %s --watch\nIt classifies whose turn it is and exits on the first terminal verdict (GATE-YOURS / GATE-FAIL / GATE-READY / GATE-DONE).\n' \
  "$ROOT/scripts/pr-gate-watch.sh" "${PR:-PR_NUMBER}" >&2

# Courtesy, never enforcement (GH-1845).
exit 0
