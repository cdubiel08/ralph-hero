#!/usr/bin/env bash
# outcome.sh — did the session FINISH, or was it KILLED? Sourced, never run.
#
# THE DEFECT THIS EXISTS FOR (GH-1907)
#   An Anthropic API outage killed two fleet sessions mid-turn on 2026-08-14.
#   Afterwards both read exactly like sessions that had delivered and exited:
#
#     w1863-reconcile-sweeps-every  done  1863  spawned
#     w1869-remove-multi-holder     done  1869  spawned
#
#   `agent_status: done` is a TURN boundary — an error ends a turn exactly as a
#   completion does — and the C8 `state` token was still `spawned`, because a
#   session that dies before it writes a token leaves no token. Both worktrees
#   held real uncommitted work. Had an orchestrator trusted `done`, it would
#   have retired two workspaces over finished-but-uncommitted code.
#
#   The invariant: a workspace must never be retired on a signal that a killed
#   session also produces.
#
# THE DISCIPLINE (copied, not invented — both templates already live here)
#   pr-gate-watch.sh withholds a verdict it cannot bind to one commit rather
#   than collapsing into the quiet reading; notify-watch.sh's GH-1878 latch
#   resolves an ambiguous read where it can and bounds it where it cannot. So
#   this file resolves what the evidence settles and NAMES the ambiguity
#   otherwise — it never answers "finished" on the absence of a signal.
#
# THE EVIDENCE, and why each piece is admissible
#   state token   Session-written. `reporting` is pushed by /ralph:work at
#                 close-out (the skill's cockpit contract), so it is present
#                 only if the session lived to close out. Its PRESENCE is
#                 evidence; its absence is not — which is the whole inversion.
#   worktree      A dirty checkout is positive evidence of unfinished work: a
#                 session that delivered has committed and pushed. This is the
#                 one signal a killed session produces and a finished one does
#                 not, so it is what turns "cannot tell" into "interrupted".
#
# THE THREE VERDICTS
#   finished       the session said so (state token `reporting`)
#   interrupted    it never said so AND its checkout holds uncommitted work
#   indeterminate  it never said so and nothing else distinguishes
#                  "finished without reporting" from "killed before it could
#                  report" — the honest refusal, and the reading a retiring
#                  caller must treat as "not safe to retire"
#
# There is deliberately no verdict meaning "safe to retire, I checked": only
# `finished` is a positive claim, and only a live session can make it.
#
# No top-level side effects, no set/shopt (callers own their shell options).
# bash 3.2 compatible.

# ralph_worktree_dirty CHECKOUT — does this checkout hold uncommitted work?
#
#   rc 0   dirty: tracked modifications or untracked files present
#   rc 1   clean
#   rc 2   unreadable — no path, not a git checkout, or git refused
#
# rc 2 is a THIRD outcome on purpose. Folding an unreadable checkout into
# "clean" would answer "no unfinished work here" off a question nobody asked,
# which is the same fail-open collapse the verdicts above exist to remove.
ralph_worktree_dirty() {
  local dir="${1-}" out
  [ -n "$dir" ] || return 2
  [ -d "$dir" ] || return 2
  git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 2
  out=$(git -C "$dir" status --porcelain 2>/dev/null) || return 2
  [ -n "$out" ] && return 0
  return 1
}

# ralph_session_outcome STATE_TOKEN CHECKOUT — the verdict for a session whose
# agent has reached a terminal herdr status. Prints one of finished /
# interrupted / indeterminate on stdout; always rc 0, because a verdict is an
# observation and every branch of it is a real answer.
#
# STATE_TOKEN is the pane's current C8 `state` token ('' when it has none).
# CHECKOUT is the session's worktree ('' when it could not be resolved — which
# lands in `indeterminate`, never in a terminal claim).
ralph_session_outcome() {
  local token="${1-}" checkout="${2-}" rc=0
  if [ "$token" = "reporting" ]; then
    printf 'finished\n'
    return 0
  fi
  ralph_worktree_dirty "$checkout" || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'interrupted\n'
  else
    printf 'indeterminate\n'
  fi
  return 0
}

# ralph_outcome_note VERDICT AGENT — the one-line explanation that goes beside
# the verdict in a log or a notification. An `indeterminate` line names WHICH
# two outcomes it cannot separate, rather than reporting the quiet one.
ralph_outcome_note() {
  case "${1-}" in
    finished)
      printf '%s closed out (state token `reporting`) — this is a real completion claim\n' "${2:-session}"
      ;;
    interrupted)
      printf '%s ended its turn without closing out and its worktree holds uncommitted work — treat as cut off mid-turn; do NOT retire the workspace\n' "${2:-session}"
      ;;
    *)
      printf '%s ended its turn without closing out; nothing here separates "finished but never reported" from "killed before it could report" — verdict withheld, do NOT retire the workspace on it\n' "${2:-session}"
      ;;
  esac
}
