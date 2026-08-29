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
#           as "the session never self-reported", not as a state machine —
#           and never as the sole authority on whether the session did
#           anything (GH-2274: the board and the branch outrank it).
#   UNIT    the issue number parsed from the agent name (grammar B / legacy),
#           tokens.issue as the fallback
#   AGE     minutes since the ledger's spawn/discover record for the agent's
#           exact ref (tokens.root); `-` = no record, NEVER 0m
#   HEALTH  derived, one word:
#             dead-before-start  the unit's issue is OPEN, its branch carries
#                                no commits of its own, and the spawner's
#                                `spawned`/`briefed` token was never
#                                overwritten — the session died before its
#                                first self-report (the audit's
#                                encoded-but-unencoded discriminator: 2-3
#                                workers found dead by the USER, not by any
#                                surface)
#             finished           the unit's issue is CLOSED (Done/Canceled) —
#                                a feature unit that merged or an apply unit
#                                that closed on evidence, neither of which the
#                                token ever caught up to (GH-2274: a merged
#                                closing PR or a closed apply unit with zero
#                                commits by construction must never read as
#                                dead)
#             unverified         a `spawned`/`briefed` token sat idle and
#                                neither the board nor the branch could be
#                                read to say which of the two above applies —
#                                the third answer; never dead, never finished
#             blocked            needs a human (either half says blocked)
#             working|reporting  a live turn
#             stale-token        idle now, but either the last self-report
#                                says working/reporting (the token rotted
#                                forward) or the branch already carries real
#                                commits on a still-open issue while the token
#                                never advanced past spawn (the token rotted
#                                behind)
#             idle               between turns, honestly
#             unknown            herdr has no observation
#
# Read-only: one snapshot, one ledger read, zero mutations, and AT MOST ONE
# `board list --json` — only when the herd holds a candidate row (idle/done,
# token spawned/briefed, a unit to ask about) that dead-before-start would
# otherwise be derived for; an unreadable board read renders `unverified` for
# every such row rather than a false "finished" or a false "dead" (GH-2274 —
# failing toward the respawn footer is the defect this whole derivation
# exists to close). A failed snapshot is a DISTINCT failure (exit 3), never an
# empty table — "no agents" and "could not find out" must not read alike
# (transport.sh's founding rule). An empty scope prints its own honest line
# and exits 0.
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

# _fleet_status_branch_verdict WORKTREE — echo has_commits/no_commits/
# unverified for whether WORKTREE's HEAD carries commits beyond its
# merge-base with origin/main (read as the ref stands, no fetch — matching
# the rest of this plugin's convention). A top-level function, not inlined at
# its call site: bash 3.2 (what macOS ships, and what this plugin targets)
# misparses a `case` statement written directly inside a `$(...) | while … |
# …)` construct — the whole point of a candidate's verdict living in its own
# function is to keep that `case` out of the nested substitution.
_fleet_status_branch_verdict() {
  local wt="${1-}" base count
  [ -n "$wt" ] && [ -d "$wt" ] || {
    echo "unverified"
    return 0
  }
  base=$(git -C "$wt" merge-base HEAD origin/main 2>/dev/null) || {
    echo "unverified"
    return 0
  }
  count=$(git -C "$wt" rev-list --count "$base"..HEAD 2>/dev/null) || {
    echo "unverified"
    return 0
  }
  case "$count" in
    '' | *[!0-9]*) echo "unverified" ;;
    0) echo "no_commits" ;;
    *) echo "has_commits" ;;
  esac
}

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

# Phase 1: per-row fields with NO health derivation yet — status, the
# self-report token, the parsed unit, and the worktree path every candidate's
# git check will need. Split out of the single pass below so the health
# derivation can be augmented with facts (board state, branch commits) that
# only bash/git can gather, without duplicating this parse a second time.
prepped=$(jq -c --argjson panes "$pane_tokens" --argjson spawns "$spawns" '
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
      | {agent: $a.name, pane: ($a.pane // ""), status: ($a.status // "unknown"),
         token: $token, unit: $unit, worktree: ($a.checkout // ""), age: $age})' <<<"$agents") || {
  echo "fleet-status: could not derive the table from the snapshot" >&2
  exit 1
}

# Candidates for the dead-before-start ambiguity: idle/done, a token that
# never advanced past spawn, and a unit to ask the board about. Everything
# else needs no board read and no git call.
candidates=$(jq -c '[.[] | select(
    (.status == "idle" or .status == "done")
    and (.token == "spawned" or .token == "briefed")
    and .unit != "")]' <<<"$prepped") || candidates="[]"

# Phase 2: for each candidate, ask what git alone cannot answer (GH-2274's
# root cause) — is the unit's issue still open? — via ONE `board list --json`
# for the whole batch, then only for units that ARE open, whether the branch
# already carries commits of its own (merge-base against origin/main, read as
# the ref stands — no fetch, matching the rest of this plugin's convention).
# augmented ends up [{agent, verdict}], verdict one of:
#   finished     issue not in the open set — closed, feature or apply
#   has_commits  issue open, branch has commits ahead of its merge-base
#   no_commits   issue open, branch has none — the true positive
#   unverified   the board read failed, or the branch could not be read
augmented="[]"
if [ "$(jq 'length' <<<"$candidates")" -gt 0 ]; then
  board_ok=1
  open_list=$("$BOARD" list --json 2>/dev/null) || board_ok=0
  open_units="[]"
  if [ "$board_ok" -eq 1 ]; then
    open_units=$(jq -c '[.items[]?.number]' <<<"$open_list" 2>/dev/null) || {
      board_ok=0
      open_units="[]"
    }
  fi

  augmented=$(jq -c '.[]' <<<"$candidates" | while IFS= read -r row; do
    c_agent=$(jq -r '.agent' <<<"$row")
    c_unit=$(jq -r '.unit' <<<"$row")
    c_wt=$(jq -r '.worktree' <<<"$row")
    if [ "$board_ok" -ne 1 ]; then
      jq -nc --arg a "$c_agent" '{agent: $a, verdict: "unverified"}'
      continue
    fi
    is_open=$(jq --argjson u "$c_unit" 'any(.[]?; . == $u)' <<<"$open_units" 2>/dev/null) || is_open="false"
    if [ "$is_open" != "true" ]; then
      jq -nc --arg a "$c_agent" '{agent: $a, verdict: "finished"}'
      continue
    fi
    verdict=$(_fleet_status_branch_verdict "$c_wt")
    jq -nc --arg a "$c_agent" --arg v "$verdict" '{agent: $a, verdict: $v}'
  done | jq -cs .) || augmented="[]"
fi

rows=$(jq -c --argjson aug "$augmented" '
  ($aug | map({key: .agent, value: .verdict}) | from_entries) as $augmap
  | map(
      . as $r
      | ($augmap[$r.agent] // "") as $v
      | (if ($r.status == "blocked" or $r.token == "blocked") then "blocked"
         elif ($r.status == "idle" or $r.status == "done") then
           (if ($r.token == "spawned" or $r.token == "briefed") then
              (if $r.unit == "" then "dead-before-start"
               elif $v == "finished" then "finished"
               elif $v == "has_commits" then "stale-token"
               elif $v == "no_commits" then "dead-before-start"
               else "unverified" end)
            elif ($r.token == "working" or $r.token == "reporting") then "stale-token"
            else "idle" end)
         elif $r.status == "working" then (if $r.token == "reporting" then "reporting" else "working" end)
         else "unknown" end) as $health
      | {agent: $r.agent, pane: $r.pane, status: $r.status,
         token: (if $r.token == "" then null else $r.token end),
         unit: (if $r.unit == "" then null else ($r.unit | tonumber) end),
         worktree: (if $r.worktree == "" then null else $r.worktree end),
         age: $r.age, health: $health})' <<<"$prepped") || {
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
