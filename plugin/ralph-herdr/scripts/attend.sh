#!/usr/bin/env bash
# attend.sh — jump to the first blocked ralph agent and carry its question.
#
# No loop, no pane needed — safe to bind to a key. Reads the live agent list,
# picks the highest-priority blocked ralph agent, focuses its pane, then reads
# that pane's tail and puts the last non-empty lines INTO the notification —
# the question travels with the toast, so the human sees what is being asked
# without switching context. The focus is the one deliberate exception to
# --no-focus discipline: attending IS the human clicking "take me there".
# When nothing is blocked it says so and exits 0. Read-only apart from focus
# + notification; never writes board state, never prompts or kills an agent.
#
# Ordering among blocked agents:
#   1. issue sessions first — legacy gh-N and grammar-B w-lane — before every
#      other lane (r/o/d/i/t, the issue-0 infra and lane-pass agents,
#      legacy ralph-deliver/tend);
#   2. within a group, oldest blocked-since first, read from this scope's
#      ledger state records (the state-token timestamp trail watch-event.sh
#      appends). The longest-waiting question gets attended first. An
#      unreadable ledger — or an agent it never met — falls back to agent-
#      list order, AFTER the timestamped ones. Ordering is chrome over a
#      read: a ledger failure never costs the focus verb.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

blocked=$(ralph_agents_json | jq -c 'select(.status == "blocked")')

if [ -z "$blocked" ]; then
  notify herd "ralph: herd calm" "nothing blocked"
  exit 0
fi

# Ledger is optional chrome here (see header). Resolved from $REPO — the
# action cd'd to the workspace repo, same scope board.ts reads.
ledger=$(ralph_ledger_path "$REPO" 2>/dev/null) || ledger=""

# One sortable line per blocked agent: GROUP <tab> TS <tab> IDX <tab> NAME.
# GROUP 0 = issue sessions (gh-N parses as lane w), 1 = everything else.
# TS is the ts of the agent's most recent transition INTO blocked (the
# current block's start); "9999" sorts the ts-less after the timestamped,
# and the zero-padded list index keeps them in agent-list order. ISO-8601
# sorts lexically, so one plain `sort` orders the whole thing.
target=$(
  i=0
  while IFS= read -r a; do
    [ -n "$a" ] || continue
    i=$((i + 1))
    name=$(jq -r '.name' <<<"$a")
    # No `case` in this block: bash 3.2 cannot parse case patterns inside
    # the enclosing $( ) command substitution.
    group=1
    if parsed=$(ralph_agent_parse "$name" 2>/dev/null) && [ "${parsed%% *}" = "w" ]; then
      group=0
    fi
    ts=""
    # Name -> open ref FIRST, then an exact-ref join (GH-1776). Matching the
    # name part of every record instead would read a dead generation's blocked
    # timestamps as this agent's: names are deterministic, so a respawn after a
    # crash recycles one, and the stale ts is always the older one — it would
    # win the sort and send the human to the wrong pane first. No open ref (an
    # agent the ledger never met, or an unreadable ledger) leaves ts empty,
    # which is the documented fallback to agent-list order.
    ref=$(ralph_ledger_open_ref "$name" "$REPO" 2>/dev/null) || ref=""
    if [ -n "$ref" ] && [ -n "$ledger" ] && [ -s "$ledger" ]; then
      ts=$(jq -rs --arg ref "$ref" '
        [ .[]
          | select((.agent_ref // "") == $ref)
          | select((.ev == "state" and ((.agent_status // .state // "") == "blocked"))
                   or (((try .tokens.state catch null) // "") == "blocked"))
          | .ts // empty ]
        | last // empty' <"$ledger" 2>/dev/null) || ts=""
    fi
    printf '%s\t%s\t%03d\t%s\n' "$group" "${ts:-9999}" "$i" "$name"
  done <<<"$blocked" | sort | head -n 1 | cut -f4
)

if [ -z "$target" ]; then
  notify herd "ralph: herd calm" "nothing blocked"
  exit 0
fi

"$HERDR" agent focus "$target" >/dev/null

# Title carries the issue number when the name resolves to one (never the
# reserved infra issue 0 — s0-watch's "0" is a lane marker, not an issue).
title="ralph: attending $target"
if parsed=$(ralph_agent_parse "$target" 2>/dev/null); then
  # shellcheck disable=SC2086  # intentional: parse output is space-separated
  set -- $parsed
  [ "$2" != "0" ] && title="ralph: attending $target (#$2)"
fi

# The question, best-effort: last 3 non-empty tail lines, flattened to one
# line and truncated to the 240-char toast budget. A failed read (or an
# all-blank tail) degrades to the old fixed body — chrome, never the verb.
tail_txt=$("$HERDR" agent read "$target" --source recent-unwrapped --lines 25 2>/dev/null) || tail_txt=""
body=""
if [ -n "$tail_txt" ]; then
  body=$(printf '%s\n' "$tail_txt" | awk 'NF' | tail -n 3 |
    tr '\r\n' '  ' | sed -e 's/[[:space:]]\{1,\}/ /g' -e 's/^ //' -e 's/ $//')
fi
# L12's no-secret gate (contracts.ts SECRET_RE), mirrored onto this chrome
# channel: a pane tail is likelier than a typed payload to hold an echoed
# credential (`env | grep ANTHROPIC`, a pasted gh auth token, a cat'd .env
# right before the block), and the toast persists in the notification DB and
# on the lock screen. A match degrades to the fixed body below — degradation
# loses chrome, never the verb.
if printf '%s' "$body" | LC_ALL=C grep -Eq 'sk-ant-|ANTHROPIC_API_KEY[[:space:]]*=|ghp_[A-Za-z0-9]'; then
  body=""
fi
[ -n "$body" ] || body="attending $target — pane focused"
# ASCII "..." on purpose: ${#} and ${:offset:length} count bytes under C
# locales and characters under UTF-8 — a multibyte ellipsis would overshoot
# the 240 budget by 2 in the byte-counting case. The budget itself is
# enforced in the locale's unit: under UTF-8 a multibyte tail may exceed
# 240 BYTES while passing this check — accepted, since the toast layer
# clips and byte-slicing here could split a UTF-8 sequence mid-character.
if [ "${#body}" -gt 240 ]; then
  body="${body:0:237}..."
fi

notify "$target" "$title" "$body"
