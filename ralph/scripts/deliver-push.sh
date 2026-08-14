#!/usr/bin/env bash
# Push a deliver-lane branch under a pinned lease — the typed half of the
# work/deliver exclusion (GH-1917).
#
# Usage: ./ralph/scripts/deliver-push.sh --branch NAME --expect SHA
#                                        [--remote origin] [--dry-run]
#
# WHY THIS EXISTS
#
# The lanes spec admits (2026-08-07-loop-agent-lanes-spec.md:490-499) that
# work/deliver exclusion is "probabilistic, not typed": an interactive
# /ralph:work session never holds tick.pid, so if it idles longer than
# RALPH_SETTLE_MIN, deliver can rebase and push a branch that live session
# still considers its own.
#
# The two mitigations named there — the settle window and the pre-push
# quiescence re-check — read the SAME predicate: `board deliver-queue`'s
# quiescence input is the newest of state change, issue comment, and open-PR
# activity (board.ts:3697-3713). All three are REMOTE signals. A live session
# editing files locally emits none of them, so the pre-push re-check is not an
# independent second guard for this hazard; it is the settle-window predicate
# sampled twice. Two mitigations, one blind spot.
#
# Mutual exclusion needs an atomic operation with a winner and a loser.
# Projects V2 has no compare-and-swap (see CLAUDE.md), which is why the board
# claim cannot carry this — and why the claim is unavailable here anyway:
# transition() CLEARS the Claim field on In Progress -> In Review
# (board.ts:2108-2136) and read-back-throws if the clear did not stick.
#
# But the contested resource is not a board item. It is a git branch, and git
# ref updates ARE a real server-side CAS. That is the primitive this script
# uses. It is the same idea as the SHA-pinned merge (--match-head-commit) one
# level up: not a new concept in this fleet, only an unapplied one.
#
# WHAT IT DOES AND DOES NOT PROTECT
#
# Protects: work that was PUSHED. If a work session pushed after deliver read
# the branch head, the lease is refused by the server and deliver backs off.
# Silent clobber becomes a loud, typed refusal.
#
# Does NOT protect: a session holding UNPUSHED local commits. Its next push
# conflicts loudly — the "messy-but-recoverable" outcome the lanes spec
# already accepts, and which this script does not change.
#
# This is exclusion at the push instant, not a session-long lease. That is
# where the destructive write happens, so it is the load-bearing half; it is
# not full mutual exclusion and does not claim to be.
#
# WHY --expect IS MANDATORY (never bare --force-with-lease)
#
# Bare `--force-with-lease` compares against the local remote-tracking ref,
# which ANY background `git fetch` silently refreshes — defeating the lease
# while still looking safe. That would reintroduce the exact silent clobber
# this script exists to prevent, under a flag that reads as protection. So the
# expected SHA is always named explicitly and always comes from the caller.
#
# Output contract (loop-runners grep these):
#   DELIVER PUSH PASS — ...     — lease held, branch updated              [0]
#   DELIVER PUSH WARN — noop:.. — nothing to push; lease NOT exercised    [0]
#   DELIVER PUSH PENDING — ...  — lease REFUSED; a peer moved the branch  [75]
#   DELIVER PUSH FAIL — g: ...  — misuse or a non-lease error             [1]
#
# PENDING vs FAIL matters, same as merge-pr.sh. A refused lease is not an
# error: it is this script working. The correct response is to back off and
# exit at In Review so quiescence restarts — NOT to escalate to a human and
# NOT to retry with a bigger hammer. Exit 1 means stop and get a human; exit
# 75 means come back later.
#
# There is deliberately no --force. Any situation that seems to need one is a
# Human Needed escalation with this script's output quoted.

set -euo pipefail

usage() {
  echo "Usage: $0 --branch NAME --expect SHA [--remote origin] [--dry-run]" >&2
  exit 1
}

BRANCH=""
EXPECT=""
REMOTE="origin"
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --expect) EXPECT="${2:-}"; shift 2 ;;
    --remote) REMOTE="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --force|--force-with-lease)
      # Named explicitly so the refusal is legible rather than an "unknown
      # flag". The whole point of this script is that the lease is not optional.
      echo "DELIVER PUSH FAIL — args: $1 is not accepted; the lease is the gate" >&2
      exit 1
      ;;
    -h|--help) usage ;;
    *) echo "DELIVER PUSH FAIL — args: unknown argument '$1'" >&2; exit 1 ;;
  esac
done

fail() {
  echo "DELIVER PUSH FAIL — $1: $2" >&2
  exit 1
}

[[ -n "$BRANCH" ]] || fail args "--branch is required"
[[ -n "$EXPECT" ]] || fail args "--expect SHA is required (the head you rebased from)"
[[ -n "$REMOTE" ]] || fail args "--remote may not be empty"

# A full 40-hex object name only. An abbreviated sha would be compared
# literally by git and could never match, turning the lease into an
# always-refuse — a failure that looks like protection.
[[ "$EXPECT" =~ ^[0-9a-f]{40}$ ]] \
  || fail args "--expect must be a full 40-character sha, got '$EXPECT'"

git rev-parse --git-dir >/dev/null 2>&1 || fail repo "not inside a git repository"

# Never push a rebase over a repo's integration branch. Deliver only ever
# owns PR branches; if it is pointed at the default branch something upstream
# is wrong, and a lease would not make it right.
DEFAULT_BRANCH="$(git symbolic-ref --quiet --short "refs/remotes/$REMOTE/HEAD" 2>/dev/null | sed "s#^$REMOTE/##" || true)"
if [[ -n "$DEFAULT_BRANCH" && "$BRANCH" == "$DEFAULT_BRANCH" ]]; then
  fail branch "refusing to force-push the default branch ('$BRANCH')"
fi

PUSH_ARGS=(
  push
  "--force-with-lease=refs/heads/$BRANCH:$EXPECT"
  "$REMOTE"
  "HEAD:refs/heads/$BRANCH"
)
$DRY_RUN && PUSH_ARGS=(push --dry-run "${PUSH_ARGS[@]:1}")

# Capture rather than stream: the lease refusal must be classified, and a
# non-zero git exit alone cannot distinguish "peer moved the branch" from
# "auth failed". Both stdout and stderr, since git splits its reporting.
set +e
OUT="$(git "${PUSH_ARGS[@]}" 2>&1)"
RC=$?
set -e

if [[ $RC -eq 0 ]]; then
  # A push that changes nothing never reaches the ref update, so git exits 0
  # WITHOUT evaluating the lease — including when --expect names a sha the
  # remote is nowhere near. Nothing was overwritten, so this is not a failure;
  # but reporting it as "updated under lease" would assert a check that never
  # ran. Distinguish it, per the rule that a status may not conflate a benign
  # outcome with a verified one.
  if grep -qi "Everything up-to-date" <<<"$OUT"; then
    echo "DELIVER PUSH WARN — noop: nothing to push; $BRANCH already at HEAD. Lease NOT exercised (--expect $EXPECT unverified)."
    exit 0
  fi
  if $DRY_RUN; then
    echo "DELIVER PUSH PASS — dry-run: lease on $BRANCH would hold at $EXPECT"
  else
    echo "DELIVER PUSH PASS — $BRANCH updated under lease pinned to $EXPECT"
  fi
  exit 0
fi

# `stale info` is git's own wording for a refused lease. Match on that and on
# the rejection reason rather than on exit code, which is 1 for every failure.
if grep -qi "stale info\|rejected.*stale\|\[rejected\].*fetch first" <<<"$OUT"; then
  echo "$OUT" >&2
  echo "DELIVER PUSH PENDING — lease: $BRANCH moved since $EXPECT; a peer holds it. Back off, exit at In Review." >&2
  exit 75
fi

echo "$OUT" >&2
fail push "git push failed for a non-lease reason (see output above)"
