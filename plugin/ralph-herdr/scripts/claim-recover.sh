#!/usr/bin/env bash
# claim-recover.sh — release the board claim of a worker whose pane outlived
# it. Sourced by reconcile.sh (never run); needs sanitize.sh, transport.sh and
# ledger.sh sourced first.
#
# WHY THIS EXISTS (GH-1809)
#   A herdr server restart kills the process inside every pane in ~100ms, then
#   restores the pane — same id, same cwd, fresh shell. The board claim is a
#   plain file-and-field pair that knows nothing about any of it, so the issue
#   sits In Progress behind a restored-but-idle pane until RALPH_LOCK_TTL_MIN
#   (120 min) expires. Measured, twice:
#   thoughts/shared/research/2026-08-11-claim-ttl-pane-persistence-probe.md and
#   .../2026-08-13-agent-pane-resume-probe.md.
#
# WHY NOT JUST LOOK FOR THE PROCESS
#   Because `resume_agents_on_restore` (default ON) types `claude --resume
#   <session-id>` into the restored pane. When that succeeds the pane holds a
#   live harness process that is a TRANSCRIPT AT A PROMPT, not a worker — a
#   process-presence check would call it alive and the claim would stall for
#   the full TTL anyway. So the primary signal is the pane's SHELL pid, which
#   changes whenever the pane was rebuilt no matter what was relaunched into
#   it (observed 3/3 restarts). Process presence is only the secondary leg,
#   for a worker that died inside a shell that survived.
#
# THE VERDICTS
#   alive           a harness process is running in a pane that was never rebuilt
#   restart_killed  the pane was rebuilt — recorded shell pid != current
#   crashed         same shell, no harness process — it died in place
#   unknown         we could not find out — releases NOTHING, ever
#
# A RECORDED SHELL PID IS THE TICKET TO A BOARD WRITE. No recorded pid, no
# release — not even when the pane is plainly empty, and not when herdr answers
# `pane_not_found`. That looks over-cautious until you see how this pass can be
# aimed at the wrong server: herdr runs the [[startup]] hook for EVERY server
# that starts, including a scratch one from an isolated session, and reconcile
# then walks the real ~/.ralph ledgers while asking a herdr that has never
# heard of any of these panes. Observed live on 2026-08-13: an isolated probe
# server's startup hook made phase A mark all five running workers `lost`.
# Against such a server every real pane is `pane_not_found` and every pane is
# empty — so any verdict resting on absence would have released five live
# workers' claims at once.
#
# Requiring the pid closes that door by construction: a foreign server would
# have to report the same opaque pane id AND the same shell pid, which means it
# is the same pane on the same machine. Absence is never evidence here; only a
# positive, matching reading is.
#
# The cost is real and bounded: records written before GH-1809 carry no pid, so
# their claims still wait out the TTL. That is the honest limit, and it is the
# right side to be wrong on — the other side yanks a claim out from under a
# working agent.

# ralph_worker_verdict PANE RECORDED_SHELL_PID HARNESS — print one verdict.
# Always rc 0: the verdict IS the answer, including "unknown".
ralph_worker_verdict() {
  local pane="${1-}" recorded="${2-}" harness="${3-}" out rc=0 now_shell fg
  [ -n "$harness" ] || harness=claude
  # No pane, or no shell pid recorded for it, and there is nothing to compare
  # against — the pass has no way to tell this pane from a stranger's.
  if [ -z "$pane" ] || [ -z "$recorded" ]; then
    echo unknown
    return 0
  fi
  out=$(ralph_herdr_call pane_process_info pane process-info --pane "$pane" 2>/dev/null) || rc=$?
  if [ "$rc" -ne 0 ]; then
    # Deliberately NOT special-cased: `pane_not_found` reads like a definite
    # answer ("no pane, no worker") and is the single most dangerous verdict
    # in this file, because it is also what a correct server says about a
    # pane belonging to a different server. Absence proves nothing here.
    echo unknown
    return 0
  fi
  now_shell=$(printf '%s' "$out" | jq -r '.process_info.shell_pid // empty' 2>/dev/null) || now_shell=""
  case "$now_shell" in
    '' | *[!0-9]*)
      echo unknown
      return 0
      ;;
  esac
  # Leg 1 first, and it OUTRANKS process presence: a rebuilt pane means this
  # worker is gone even when something is running in the new one.
  if [ "$recorded" != "$now_shell" ]; then
    echo restart_killed
    return 0
  fi
  # argv0, never .name: herdr reports a claude process's `name` as its VERSION
  # string ("2.1.229"), so a name match finds no harness where one is plainly
  # running — and would report `crashed` for every live worker on the board.
  fg=$(printf '%s' "$out" | jq -r --arg h "$harness" \
    '[.process_info.foreground_processes[]? | select(.argv0 == $h)] | length' 2>/dev/null) || fg=""
  case "$fg" in
    '' | *[!0-9]*)
      echo unknown
      return 0
      ;;
  esac
  if [ "$fg" -gt 0 ]; then
    echo alive
  else
    echo crashed
  fi
  return 0
}

# ralph_board_cli REPO_ROOT — print the board CLI path for a checkout.
# Mirrors lib.sh's resolution order (override > vendored > newest installed
# plugin copy) but takes the root as an argument: reconcile has no single
# repository of its own, it walks every ledger under the ledger root.
# rc 1 (quietly) when nothing is found — the caller reports it in context.
ralph_board_cli() {
  local root="${1-}" cand
  if [ -n "${RALPH_HERDR_BOARD:-}" ]; then
    [ -x "$RALPH_HERDR_BOARD" ] || return 1
    printf '%s\n' "$RALPH_HERDR_BOARD"
    return 0
  fi
  if [ -n "$root" ] && [ -x "$root/ralph/scripts/board" ]; then
    printf '%s\n' "$root/ralph/scripts/board"
    return 0
  fi
  # Registry first, cache glob as last resort (GH-1865) — mirrors lib.sh's
  # installed_board_cli_tagged(); this file stays standalone by design, so the
  # two are duplicated deliberately and change together.
  local reg
  reg="${RALPH_INSTALLED_PLUGINS_FILE:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json}"
  if [ -r "$reg" ] && command -v jq >/dev/null 2>&1; then
    cand=$(jq -r '
        (.plugins // {}) | to_entries[]
        | select((.key | split("@")[0]) == "ralph")
        | .value[]? | select(.installPath != null)
        | ((.version // "0") + "\t" + .installPath + "/scripts/board")' "$reg" 2>/dev/null |
      while IFS=$'\t' read -r v p; do [ -x "$p" ] && printf '%s\t%s\n' "$v" "$p"; done |
      sort -V -k1,1 | tail -1 | cut -f2-)
    if [ -n "$cand" ] && [ -x "$cand" ]; then printf '%s\n' "$cand"; return 0; fi
  fi
  # shellcheck disable=SC2012  # glob over versioned plugin dirs is the point
  cand=$(ls "$HOME"/.claude/plugins/cache/*/ralph/*/scripts/board 2>/dev/null |
    awk -F/ '{ print $(NF-2) "\t" $0 }' | sort -V -k1,1 | tail -1 | cut -f2-)
  [ -n "$cand" ] && [ -x "$cand" ] || return 1
  printf '%s\n' "$cand"
}

# ralph_claim_release REPO_ROOT ISSUE REF REASON — release ISSUE's claim when
# it is still held and still In Progress. Prints one outcome word:
#   released | not-in-progress | not-claimed | refused | no-board | error
# Always rc 0 — the outcome is the answer, and nothing here may abort a
# reconcile pass.
#
# The state and claim are re-read from the board immediately before the write,
# never from any cached view: this whole path exists because a worker died
# without telling anyone, and it must not act on a picture that is equally
# stale. A worker that got its PR up before dying is In Review, not In
# Progress, and is left exactly alone.
#
# There is deliberately NO holder comparison here. board.ts's own guardHolder
# refuses a release by a non-member (and permits one once the claim is stale),
# which is the authority; re-deriving `user@host` in bash to pre-judge it would
# only add a second, subtly different opinion that could silently disable the
# whole path when the two strings disagree. So the gate is RUN, and a refusal
# is reported as one.
ralph_claim_release() {
  local root="${1-}" issue="${2-}" ref="${3-}" reason="${4-}" board view state claim out
  case "$issue" in
    '' | *[!0-9]*)
      echo error
      return 0
      ;;
  esac
  board=$(ralph_board_cli "$root") || {
    echo no-board
    return 0
  }
  view=$(cd "$root" 2>/dev/null && "$board" get "$issue" --json 2>/dev/null) || {
    echo error
    return 0
  }
  state=$(printf '%s' "$view" | jq -r '.state // empty' 2>/dev/null) || state=""
  claim=$(printf '%s' "$view" | jq -r '.claim.holders // [] | length' 2>/dev/null) || claim=0
  if [ "$state" != "In Progress" ]; then
    echo not-in-progress
    return 0
  fi
  case "$claim" in
    '' | *[!0-9]* | 0)
      echo not-claimed
      return 0
      ;;
  esac
  out=$(cd "$root" 2>/dev/null && "$board" release "$issue" \
    -m "ralph-herdr reconcile: the worker holding this claim is gone ($reason; agent $ref). Its herdr pane no longer runs it, so the claim was released rather than left to expire at TTL. Nothing about the work itself is asserted — re-claim it to continue." 2>&1) || {
    echo "refused${out:+: $(printf '%s' "$out" | tr '\n' ' ' | ralph_sanitize)}"
    return 0
  }
  echo released
  return 0
}
