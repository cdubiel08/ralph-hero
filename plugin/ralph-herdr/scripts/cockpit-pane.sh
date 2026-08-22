#!/usr/bin/env bash
# cockpit-pane.sh — the one definition of "which pane is this board's cockpit".
# Sourced, never run.
#
# GH-2074 measured the cost of not having it: `open the cockpit` from an agent
# pane took ~1 min and 7 tool calls AND opened a SECOND cockpit while one was
# already live. focus-or-open existed only for clicked links (link-open.sh);
# the action path had no way to ask the question, because herdr exposes
# `plugin pane focus <pane_id>` but no way to LIST a plugin's panes — the
# snapshot's pane objects carry no plugin or entrypoint field (probed against
# herdr 0.8.0: `herdr plugin pane` has open/focus/close and nothing else).
# So the answer has to be recorded by the cockpit itself.
#
# The record is written by cockpit-launch.sh — the pane, before it execs a
# rung — so it covers ALL FOUR rungs of the ladder. The Go TUI's heartbeat
# (marks.go, D6d) answers a different question ("is a cockpit alive?") for a
# different reader (herdr-setup.sh's check) and cannot answer this one: it
# carries no pane id, and rungs 3 and 4 never write it.
#
# Liveness is TWO independent facts, because either alone lies:
#
#   pid alive       a pane can outlive the process inside it (herdr fires
#                   pane.exited and leaves the pane), so a live pane is not
#                   evidence of a live cockpit
#   pane in the     a pid can be reused after the pane is gone, so a live pid
#   live snapshot   is not evidence of a live cockpit either
#
# Scoped per BOARD (~/.ralph/<owner>/<repo>/cockpit.pane.json, beside the
# ledger), not one global path: a single file would let a cockpit opened for
# repo B overwrite repo A's record, and A's next open would duplicate — the
# exact defect this file exists to remove.
#
# The stamp rests on HERDR_PANE_ID being exported into a PLUGIN pane, not only
# an agent pane — inferred from doctor-orphans.sh (GH-1888) and then MEASURED
# 2026-08-22 against herdr 0.8.0 with a throwaway linked plugin: the recorded
# id matched the pane id herdr itself returned from `plugin pane open`, a
# second invoke answered plugin_pane_focused on that same pane, and closing it
# made the next invoke open a fresh one. `herdr pane current` is deliberately
# NOT a fallback when the variable is absent: probed the same day, it answers
# with the FOCUSED pane instead, which would record the wrong pane as the
# cockpit — a silent wrong answer where an absent one is honest.
#
# Every unreadable path answers "no live cockpit", which OPENS one. That is
# the fail-open direction on purpose and it matches the launcher ladder's own
# contract: a degraded read costs a duplicate pane, while a refusal costs the
# cockpit itself. The record is decoration over an idempotence convenience —
# nothing gates on it.
#
# No top-level side effects. bash 3.2 compatible.

# _ralph_cockpit_record_file REPO_ROOT — print the record path (creating its
# directory). rc 1 when no board scope is resolvable — callers probe.
# $RALPH_HERDR_COCKPIT_PANE_FILE wins outright (tests).
_ralph_cockpit_record_file() {
  local root="${1:-$PWD}" scope owner repo dir
  if [ -n "${RALPH_HERDR_COCKPIT_PANE_FILE:-}" ]; then
    dir=$(dirname "$RALPH_HERDR_COCKPIT_PANE_FILE")
    mkdir -p "$dir" 2>/dev/null || return 1
    printf '%s\n' "$RALPH_HERDR_COCKPIT_PANE_FILE"
    return 0
  fi
  # Same fallback as ralph_ledger_path: the scope files live at the repo root,
  # and a pane's cwd may be a subdirectory of it.
  if [ ! -f "$root/.ralph.json" ] && [ ! -f "$root/.claude/settings.json" ]; then
    root=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null) || root="${1:-$PWD}"
  fi
  scope=$(_ralph_ledger_scope "$root" 2>/dev/null) || return 1
  owner=$(_ralph_ledger_slug "${scope%% *}")
  repo=$(_ralph_ledger_slug "${scope#* }")
  dir="${RALPH_HERDR_LEDGER_ROOT:-$HOME/.ralph}/$owner/$repo"
  mkdir -p "$dir" 2>/dev/null || return 1
  printf '%s\n' "$dir/cockpit.pane.json"
}

# ralph_cockpit_pane_stamp REPO_ROOT PANE_ID PID — record this pane as the
# board's cockpit. Best-effort by contract: ALWAYS rc 0, and every failure is
# silent-but-for-a-stderr-note. A cockpit must never fail to start because a
# convenience record could not be written.
ralph_cockpit_pane_stamp() {
  local root="${1:-$PWD}" pane="${2-}" pid="${3-}" file
  if [ -z "$pane" ]; then
    echo "cockpit: no HERDR_PANE_ID — a later open cannot focus this pane and will open another" >&2
    return 0
  fi
  case "$pid" in '' | *[!0-9]*) pid=$$ ;; esac
  file=$(_ralph_cockpit_record_file "$root") || {
    echo "cockpit: no board scope at $root — not recording this pane" >&2
    return 0
  }
  printf '{"pane":"%s","pid":%s,"at":"%s","repo":"%s"}\n' \
    "$pane" "$pid" "$(date -u +%FT%TZ)" "$root" >"$file" 2>/dev/null ||
    echo "cockpit: could not write $file — a later open will not find this pane" >&2
  return 0
}

# ralph_cockpit_live_pane REPO_ROOT — print the pane id of this board's LIVE
# cockpit on rc 0; rc 1 (with no output) for every other answer, including
# every failed read. Needs transport.sh sourced for ralph_herdr_snapshot.
ralph_cockpit_live_pane() {
  local root="${1:-$PWD}" file pane pid snapshot
  file=$(_ralph_cockpit_record_file "$root") || return 1
  [ -r "$file" ] || return 1
  pane=$(jq -r '.pane // empty' "$file" 2>/dev/null) || return 1
  pid=$(jq -r '.pid // empty' "$file" 2>/dev/null) || return 1
  [ -n "$pane" ] || return 1
  case "$pid" in '' | *[!0-9]*) return 1 ;; esac
  # Fact 1: the process is still there.
  kill -0 "$pid" 2>/dev/null || return 1
  # Fact 2: so is the pane. A validated snapshot only — ralph_herdr_snapshot
  # refuses a partial one, and "panes is missing" must never read as "the pane
  # is gone" (that direction would close nothing but would open a duplicate
  # every time the server hiccuped).
  snapshot=$(ralph_herdr_snapshot 2>/dev/null) || return 1
  printf '%s' "$snapshot" |
    jq -e --arg p "$pane" '[.panes[]? | select(.pane_id == $p)] | length > 0' >/dev/null 2>&1 || return 1
  printf '%s\n' "$pane"
}
