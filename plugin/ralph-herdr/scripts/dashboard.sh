#!/usr/bin/env bash
# dashboard.sh — read-only cockpit glance: live herd + board queues, on a poll.
#
# Board reads only (next / deliver-queue / tend-queue / list) through "$BOARD",
# plus one herdr agent-list read (ralph_agents_json). Doctor is deliberately
# NOT in the loop — a full invariant sweep is too heavy to run every cycle; it
# has its own action ("Ralph: board doctor"). Each section degrades alone: a
# failed read renders "(read failed)" for that section, never kills the loop.
#
# Knobs:
#   RALPH_HERDR_DASH_INTERVAL   seconds between refreshes (default 120)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

INTERVAL="${RALPH_HERDR_DASH_INTERVAL:-120}"
# A zero/garbage interval would turn the poll into a hot loop against the
# GitHub API — refuse it.
validate_pos_int RALPH_HERDR_DASH_INTERVAL "$INTERVAL"
REPO_NAME=$(basename "$REPO")

# Ctrl-C is the sanctioned way to close the dashboard pane — exit clean, not
# with a shell error.
trap 'exit 0' INT

# line TEXT — print TEXT truncated to the terminal width. ANSI escapes are
# invisible but count toward the cut, so callers pre-truncate long colored
# fields (titles) and keep color at line edges; this is the backstop.
line() {
  printf '%s\n' "${1:0:$COLS}"
}

# trunc TEXT MAX — echo TEXT clipped to MAX visible chars (bash 3.2 substring).
trunc() {
  local t="$1" max="$2"
  [ "$max" -lt 1 ] && max=1
  printf '%s' "${t:0:$max}"
}

while :; do
  # Read everything before clearing so a slow board call never leaves a blank
  # screen. A failed read shows as such — an empty queue and a failed query
  # are different facts.
  herd_lines=$(ralph_agents_json 2>/dev/null) || herd_lines="__FAIL__"
  next_json=$("$BOARD" next --json 2>/dev/null) || next_json=""
  deliver_json=$("$BOARD" deliver-queue --json 2>/dev/null) || deliver_json=""
  tend_json=$("$BOARD" tend-queue --json 2>/dev/null) || tend_json=""
  hn_json=$("$BOARD" list --state "Human Needed" --json 2>/dev/null) || hn_json=""

  COLS=$(tput cols 2>/dev/null || echo 100)
  case "$COLS" in ''|*[!0-9]*|0) COLS=100 ;; esac

  # clear needs terminfo; degrade to the raw ANSI sequence (harmless when
  # redirected) rather than letting set -e kill the loop on a TERM-less env.
  clear 2>/dev/null || printf '\033[H\033[2J'
  line "${C_BOLD}ralph herd — $REPO_NAME — $(date -u +%FT%TZ)${C_RST}"
  echo

  # ── HERD — the board+herdr merged view: every live ralph agent ──────────
  line "${C_BOLD}HERD${C_RST}"
  if [ "$herd_lines" = "__FAIL__" ]; then
    line "  (read failed)"
  elif [ -z "$herd_lines" ]; then
    line "  ${C_DIM}(no live agents)${C_RST}"
  else
    while IFS= read -r agent; do
      [ -z "$agent" ] && continue
      a_name=$(jq -r '.name // "?"' <<<"$agent" 2>/dev/null) || a_name="?"
      a_status=$(jq -r '.status // "unknown"' <<<"$agent" 2>/dev/null) || a_status="unknown"
      a_pane=$(jq -r '.pane // "-"' <<<"$agent" 2>/dev/null) || a_pane="-"
      line "  $(state_glyph "$a_status") $a_name  ${C_DIM}$a_status · pane $a_pane${C_RST}"
    done <<<"$herd_lines"
  fi
  echo

  # ── WORK — board next queue ─────────────────────────────────────────────
  if [ -n "$next_json" ]; then
    depth=$(jq -r '.queue | length' <<<"$next_json" 2>/dev/null) || depth="?"
    line "${C_BOLD}WORK${C_RST}  ${C_DIM}queue $depth${C_RST}"
    n=$(jq -r '.next.number // empty' <<<"$next_json" 2>/dev/null) || n=""
    if [ -n "$n" ]; then
      title=$(jq -r '.next.title // ""' <<<"$next_json")
      est=$(jq -r '.next.estimate // "-"' <<<"$next_json")
      prio=$(jq -r '.next.priority // "-"' <<<"$next_json")
      parent=$(jq -r 'if .next.hasParent then (.next.parentNumber // empty) else empty end' <<<"$next_json")
      via=""
      [ -n "$parent" ] && via=" ${C_DIM}via #$parent${C_RST}"
      title=$(trunc "$title" $((COLS - 25)))
      line "  ▸ #$n [$est] [$prio] $title$via"
      # Up to 4 more ranked rows, dim-indented (.queue[0] == .next).
      more=$(jq -r '.queue[1:5][] | "    #\(.number) [\(.estimate // "-")] \(.title)"' <<<"$next_json" 2>/dev/null) || more=""
      if [ -n "$more" ]; then
        while IFS= read -r row; do
          line "${C_DIM}$(trunc "$row" $((COLS - 8)))${C_RST}"
        done <<<"$more"
      fi
    else
      line "  ${C_DIM}queue empty${C_RST}"
    fi
  else
    line "${C_BOLD}WORK${C_RST}  (read failed)"
  fi
  echo

  # ── DELIVER — In Review items with actionable PR signal ─────────────────
  if [ -n "$deliver_json" ]; then
    dq=$(jq -r '.queue | length' <<<"$deliver_json" 2>/dev/null) || dq="?"
    line "${C_BOLD}DELIVER${C_RST}  ${C_DIM}queue $dq${C_RST}"
    dn=$(jq -r '.next.number // empty' <<<"$deliver_json" 2>/dev/null) || dn=""
    if [ -n "$dn" ]; then
      dpr=$(jq -r '.next.pr // empty' <<<"$deliver_json")
      dreason=$(jq -r '.next.reason // "-"' <<<"$deliver_json")
      dtitle=$(jq -r '.next.title // ""' <<<"$deliver_json")
      dtitle=$(trunc "$dtitle" $((COLS - 30)))
      line "  ▸ #$dn${dpr:+ pr#$dpr} [$dreason] $dtitle"
    else
      line "  ${C_DIM}queue empty${C_RST}"
    fi
  else
    line "${C_BOLD}DELIVER${C_RST}  (read failed)"
  fi
  echo

  # ── TEND — hygiene backlog, top categories ──────────────────────────────
  if [ -n "$tend_json" ]; then
    tq=$(jq -r '.queue | length' <<<"$tend_json" 2>/dev/null) || tq="?"
    cats=$(jq -r '
      .queue | group_by(.category) | map({c: .[0].category, n: length})
      | sort_by(-.n) | .[0:3] | map("\(.c) \(.n)") | join(" · ")
    ' <<<"$tend_json" 2>/dev/null) || cats=""
    line "${C_BOLD}TEND${C_RST}  ${C_DIM}queue $tq${cats:+ — $cats}${C_RST}"
  else
    line "${C_BOLD}TEND${C_RST}  (read failed)"
  fi
  echo

  # ── HUMAN — items waiting on a person ───────────────────────────────────
  if [ -n "$hn_json" ]; then
    hn_count=$(jq -r '.items | length' <<<"$hn_json" 2>/dev/null) || hn_count=""
    case "$hn_count" in
      '' | *[!0-9]*) line "${C_BOLD}HUMAN${C_RST}  (read failed)" ;;
      0) line "${C_BOLD}HUMAN${C_RST}  ${C_DIM}0${C_RST}" ;;
      *)
        line "${C_BOLD}HUMAN${C_RST}  $hn_count"
        while IFS= read -r row; do
          line "  ${C_RED}$(trunc "$row" $((COLS - 4)))${C_RST}"
        done < <(jq -r '.items[] | "#\(.number) \(.title // "")"' <<<"$hn_json" 2>/dev/null)
        ;;
    esac
  else
    line "${C_BOLD}HUMAN${C_RST}  (read failed)"
  fi

  echo
  line "${C_DIM}refresh ${INTERVAL}s · doctor is its own action · Ctrl-C to close${C_RST}"
  sleep "$INTERVAL"
done
