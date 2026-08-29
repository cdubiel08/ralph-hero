#!/usr/bin/env bash
# resume-teams.sh — resume only teams proven by this session's durable lead
# records. The ledger is the closed candidate set; the board is deliberately
# absent from inference so an empty/default ranking answer can never select a
# team to launch.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

if [ "$#" -ne 0 ]; then
  echo "usage: resume-teams.sh" >&2
  exit 64
fi

ledger=$(ralph_ledger_path "$REPO") || {
  echo "resume-teams: ledger is unreadable — launching nothing" >&2
  exit 1
}

# An absent or empty ledger is a known empty candidate set. Stop before the
# herd read: there is no liveness question until durable evidence names a
# prior team.
if [ ! -s "$ledger" ]; then
  echo "resume teams: none recorded"
  exit 0
fi

session=$(ralph_session_key)
candidates=$(jq -cs --arg session "$session" '
  [ .[]
    | select(.session == $session)
    | select(.ev == "spawn" or .ev == "discover")
    | select((.lineage.role // .tokens.role // "") == "orchestrator")
    | (.agent_ref // "") as $ref
    | ($ref | capture("^o(?<epic>[0-9]+)-[a-z0-9-]+#[0-9a-f]+$")?) as $m
    | select($m != null)
    | {epic: $m.epic, checkout: (.checkout // "")}
  ]
  | group_by(.epic)
  | map({
      epic: .[0].epic,
      checkouts: ([.[].checkout | select(length > 0)] | unique),
      missingCheckout: any(.[]; .checkout == "")
    })
  | .[]' "$ledger") || {
  echo "resume-teams: ledger is unreadable — launching nothing" >&2
  exit 1
}

if [ -z "$candidates" ]; then
  echo "resume teams: none recorded"
  exit 0
fi

# One fresh snapshot is shared by every candidate. An unknown herd is never an
# empty herd: fail before the first delegation so a transient read cannot
# double any standing lead.
herd=$(ralph_agents_json 2>/dev/null) || {
  echo "resume-teams: herd is unreadable — launching nothing" >&2
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    epic=$(jq -r '.epic' <<<"$candidate")
    echo "resume team GH-$epic: skipped — herd is unreadable"
  done <<<"$candidates"
  exit 3
}

team_sh="${RALPH_HERDR_WORK_TEAM:-$SCRIPT_DIR/work-team.sh}"
overall=0

while IFS= read -r candidate; do
  [ -n "$candidate" ] || continue
  epic=$(jq -r '.epic' <<<"$candidate")
  missing=$(jq -r '.missingCheckout' <<<"$candidate")
  checkout_count=$(jq -r '.checkouts | length' <<<"$candidate")

  if [ "$missing" = "true" ] || [ "$checkout_count" -ne 1 ]; then
    echo "resume team GH-$epic: skipped — contradictory checkout evidence"
    overall=1
    continue
  fi

  checkout=$(jq -r '.checkouts[0]' <<<"$candidate")
  checkout_root=$(git -C "$checkout" rev-parse --show-toplevel 2>/dev/null) || checkout_root=""
  repo_root=$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null) || repo_root=""
  if [ -z "$checkout_root" ] || [ -z "$repo_root" ] || [ "$checkout_root" != "$repo_root" ]; then
    echo "resume team GH-$epic: skipped — checkout does not match this repository"
    overall=1
    continue
  fi

  if jq -s -e --arg prefix "o$epic-" \
    'any(.[]; ((.name // "") | startswith($prefix)))' <<<"$herd" >/dev/null 2>&1; then
    echo "resume team GH-$epic: already live"
    continue
  fi

  rc=0
  (cd "$checkout" && RALPH_HERDR_INVOKED_BY=scheduler \
    bash "$team_sh" "$epic" --lead-only </dev/null >/dev/null 2>&1) || rc=$?
  case "$rc" in
    0) echo "resume team GH-$epic: resumed" ;;
    4) echo "resume team GH-$epic: complete — no restart needed" ;;
    *)
      echo "resume team GH-$epic: failed (rc $rc)"
      overall=1
      ;;
  esac
done <<<"$candidates"

exit "$overall"
