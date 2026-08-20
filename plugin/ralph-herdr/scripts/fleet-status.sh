#!/usr/bin/env bash
# fleet-status.sh — one-shot fleet table: every live ralph agent in THIS
# repository's scope, with the derived health a human otherwise assembles from
# `herdr agent list` + a hand-written python reshape (measured: 54 invocations
# of one such reshape in a single session — 2026-08-19 audit, D5).
#
#   fleet-status.sh [--json]
#
# Columns: AGENT PANE STATUS TOKEN UNIT WORKTREE AGE HEALTH
#
#   STATUS  herdr's own agent_status — the live observation
#   TOKEN   the pane's C8 `state` token — the session's last SELF-report.
#           Decoration by contract (tokens.sh: "Nothing may ever gate on
#           them"); it is read here only to say what the session last claimed,
#           and the one derivation that uses it (dead-before-start) treats it
#           as "the session never self-reported", not as a state machine.
#   UNIT    the issue number parsed from the agent name (grammar B / legacy),
#           tokens.issue as the fallback
#   AGE     minutes since the ledger's spawn/discover record for the agent's
#           exact ref (tokens.root); `-` = no record, NEVER 0m
#   HEALTH  derived, one word:
#             dead-before-start  agent_status idle/done while the spawner's
#                                `spawned` token was never overwritten — the
#                                session died before its first self-report
#                                (the audit's encoded-but-unencoded
#                                discriminator: 2-3 workers found dead by the
#                                USER, not by any surface)
#             blocked            needs a human (either half says blocked)
#             working|reporting  a live turn
#             stale-token        idle now, but the last self-report says
#                                working/reporting — the token rotted
#             idle               between turns, honestly
#             unknown            herdr has no observation
#
# Read-only: one snapshot, one ledger read, zero board calls, zero mutations.
# A failed snapshot is a DISTINCT failure (exit 3), never an empty table —
# "no agents" and "could not find out" must not read alike (transport.sh's
# founding rule). An empty scope prints its own honest line and exits 0.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

JSON=""
for arg in "$@"; do
  case "$arg" in
    --json) JSON=1 ;;
    -h | --help)
      sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument '$arg' (accepts --json, --help)" ;;
  esac
done

snap=$(ralph_herdr_snapshot) || {
  rc=$?
  echo "fleet-status: could not read the herd (transport rc $rc) — an unreadable herd is not an empty one" >&2
  exit 3
}

# This repository's ralph-named agents, from the one snapshot already in hand.
agents=$(ralph_scoped_agents "$snap" "$REPO" |
  jq -c --arg re "$RALPH_NAME_RE" 'select((.name // "") | test($re))' |
  jq -cs .) || agents="[]"
[ -n "$agents" ] || agents="[]"

if [ "$(jq 'length' <<<"$agents")" -eq 0 ]; then
  if [ -n "$JSON" ]; then echo "[]"; else
    echo "no live ralph agents in this repository's scope ($REPO)"
  fi
  exit 0
fi

# Pane tokens (branch/root/issue/state) ride in the same snapshot.
pane_tokens=$(jq -c '[(.panes // [])[] | {pane_id: .pane_id, tokens: (.tokens // {})}]' <<<"$snap" 2>/dev/null) || pane_tokens="[]"

# Spawn instants from the ledger, keyed on the exact agent_ref. An unreadable
# or absent ledger yields no ages — a dash, never a zero.
ledger_file=$(ralph_ledger_path "$REPO" 2>/dev/null) || ledger_file=""
spawns="[]"
if [ -n "$ledger_file" ] && [ -s "$ledger_file" ]; then
  spawns=$(jq -cs '[.[] | select(.ev == "spawn" or .ev == "discover")
    | {ref: (.agent_ref // ""), ts: (.ts // "")}]' <"$ledger_file" 2>/dev/null) || spawns="[]"
fi

rows=$(jq -c --argjson panes "$pane_tokens" --argjson spawns "$spawns" '
  ($panes | map({key: .pane_id, value: .tokens}) | from_entries) as $ptok
  | ($spawns | map(select(.ref != "" and .ts != "")) | map({key: .ref, value: .ts}) | from_entries) as $sp
  | map(
      . as $a
      | ($ptok[$a.pane // ""] // {}) as $t
      | (($a.state_token // $t.state // "") | tostring) as $token
      | (($a.name | capture("^(?:gh-|[a-z])(?<n>[0-9]+)").n // ($t.issue // "")) | tostring) as $unit
      | (($t.root // "") | tostring) as $root
      | ($sp[$root] // "") as $spawned
      | (if $spawned != "" then
           (try (((now - ($spawned | fromdateiso8601)) / 60) | floor | tostring + "m") catch "-")
         else "-" end) as $age
      | (if ($a.status == "blocked" or $token == "blocked") then "blocked"
         elif ($a.status == "idle" or $a.status == "done") and ($token == "spawned" or $token == "briefed")
           then "dead-before-start"
         elif ($a.status == "idle" or $a.status == "done") and ($token == "working" or $token == "reporting")
           then "stale-token"
         elif $a.status == "working" then (if $token == "reporting" then "reporting" else "working" end)
         elif ($a.status == "idle" or $a.status == "done") then "idle"
         else "unknown" end) as $health
      | {agent: $a.name, pane: ($a.pane // ""), status: ($a.status // "unknown"),
         token: (if $token == "" then null else $token end),
         unit: (if $unit == "" then null else ($unit | tonumber) end),
         worktree: ($a.checkout // null), age: $age, health: $health})' <<<"$agents") || {
  echo "fleet-status: could not derive the table from the snapshot" >&2
  exit 1
}

if [ -n "$JSON" ]; then
  printf '%s\n' "$rows"
  exit 0
fi

{
  printf 'AGENT\tPANE\tSTATUS\tTOKEN\tUNIT\tWORKTREE\tAGE\tHEALTH\n'
  jq -r '.[] | [.agent, .pane, .status, (.token // "-"),
    (if .unit == null then "-" else "#\(.unit)" end),
    (.worktree // "-"), .age, .health] | @tsv' <<<"$rows"
} | if command -v column >/dev/null 2>&1; then column -t -s "$(printf '\t')"; else cat; fi

# dead-before-start earns a footer with the remedy — a row nobody reads is the
# failure this table exists to close.
dead=$(jq -r '[.[] | select(.health == "dead-before-start")] | length' <<<"$rows")
if [ "$dead" -gt 0 ]; then
  echo
  echo "$dead session(s) died before starting (idle with an unoverwritten 'spawned' token) —"
  echo "respawn: bash $SCRIPT_DIR/work-fleet.sh <unit>; the pane is reusable evidence, read it first: herdr agent read <agent> --lines 60"
fi
exit 0
