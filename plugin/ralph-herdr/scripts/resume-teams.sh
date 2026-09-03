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

# An absent or readable empty ledger is a known empty candidate set. A present
# object that cannot be opened is unknown evidence even when its size is zero;
# reject non-regular objects before any read can block.
if [ ! -e "$ledger" ] && [ ! -L "$ledger" ]; then
  echo "resume teams: none recorded"
  exit 0
fi
[ -f "$ledger" ] && { : <"$ledger"; } 2>/dev/null || {
  echo "resume-teams: ledger is unreadable — launching nothing" >&2
  exit 1
}
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
    | {epic: $m.epic, ev: .ev, checkout: (.checkout // ""), ref: $ref}
  ]
  | group_by(.epic)
  | map({
      epic: .[0].epic,
      checkouts: ([.[].checkout | select(length > 0)] | unique),
      # Historical reconciliation discoveries carry no checkout. They may
      # corroborate one checkout-bearing record, but can never supply a path
      # themselves. A checkout-less spawn remains contradictory evidence.
      missingCheckout: any(.[]; .ev == "spawn" and .checkout == ""),
      # The most-recently-appended spawn/discover ref for this epic (group_by
      # is a stable sort, so "last" keeps file order within the group) — the
      # one live generation the GH-2357 stand-down check below reads. Epochs
      # are per-spawn, so an OLDER epoch here would answer for a lead this
      # session already replaced.
      newestRef: (last.ref)
    })
  | .[]' "$ledger") || {
  echo "resume-teams: ledger is unreadable — launching nothing" >&2
  exit 1
}

if [ -z "$candidates" ]; then
  echo "resume teams: none recorded"
  exit 0
fi

# checkout_repo_identity CHECKOUT — print the physical Git common directory.
# A source checkout and each of its linked worktrees have different toplevels
# but one common directory, so this is the local repository identity Git itself
# provides. Separate clones remain distinct even when they point at the same
# remote, which keeps the resume boundary fail-closed.
checkout_repo_identity() {
  local checkout="$1" common
  [ -n "$checkout" ] || return 1
  common=$(git -C "$checkout" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  [ -d "$common" ] || return 1
  (cd "$common" && pwd -P)
}

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
repo_identity=$(checkout_repo_identity "$REPO" 2>/dev/null) || repo_identity=""

while IFS= read -r candidate; do
  [ -n "$candidate" ] || continue
  epic=$(jq -r '.epic' <<<"$candidate")
  missing=$(jq -r '.missingCheckout' <<<"$candidate")
  checkout_count=$(jq -r '.checkouts | length' <<<"$candidate")

  # GH-2357: an operator can park a live lead on purpose (work-team.sh EPIC
  # --stand-down) without the epic being complete — treated as closed here,
  # same as work-team's own rc-4 case, never resumed. Checked before every
  # other candidate rule: a deliberately parked team has nothing to say
  # about checkout ambiguity, and re-arming it is a human's call
  # (work-team.sh EPIC), not this pass's.
  newest_ref=$(jq -r '.newestRef // empty' <<<"$candidate")
  if [ -n "$newest_ref" ]; then
    stand_reason=$(RALPH_HERDR_LEDGER="$ledger" _ralph_ledger_latest '.reason' "$newest_ref" 2>/dev/null) || stand_reason=""
    if [ "$(ralph_ledger_reason_canon "$stand_reason")" = "stood-down" ]; then
      echo "resume team GH-$epic: skipped — stood down by operator (work-team.sh $epic re-arms it)"
      continue
    fi
  fi

  # Liveness may excuse only the absence of checkout on a legacy discovery.
  # It must never hide a checkout-less spawn.
  if [ "$missing" = "true" ]; then
    echo "resume team GH-$epic: skipped — contradictory checkout evidence"
    overall=1
    continue
  fi

  checkout=""
  checkout_mismatch=0
  if [ "$checkout_count" -gt 0 ]; then
    # Compare repository identity, not raw toplevel strings. Reconciliation
    # can prove a linked worktree while the original spawn proves Herdr's
    # source checkout; both are legitimate evidence when their Git common dir
    # is the same. Every explicit path must resolve and match the repository
    # from which this resume pass was invoked.
    while IFS= read -r recorded_checkout; do
      [ -n "$recorded_checkout" ] || continue
      recorded_identity=$(checkout_repo_identity "$recorded_checkout" 2>/dev/null) || recorded_identity=""
      if [ -z "$repo_identity" ] || [ -z "$recorded_identity" ] || [ "$recorded_identity" != "$repo_identity" ]; then
        checkout_mismatch=1
        break
      fi
    done <<EOF
$(jq -r '.checkouts[]' <<<"$candidate")
EOF
    if [ "$checkout_mismatch" -eq 1 ]; then
      if [ "$checkout_count" -gt 1 ]; then
        echo "resume team GH-$epic: skipped — contradictory checkout evidence"
      else
        echo "resume team GH-$epic: skipped — checkout does not match this repository"
      fi
      overall=1
      continue
    fi

    # The current checkout is now proven to be the same local repository as
    # every durable path. work-team resolves Herdr's source checkout itself,
    # so execution does not depend on the ledger's lexicographic path order.
    checkout="$REPO"
  fi

  # A scoped live lead cannot be duplicated and needs no restart path. This is
  # the narrow compatibility lane for legacy discover-only records.
  if jq -s -e --arg prefix "o$epic-" \
    'any(.[]; ((.name // "") | startswith($prefix)))' <<<"$herd" >/dev/null 2>&1; then
    echo "resume team GH-$epic: already live"
    continue
  fi

  if [ "$checkout_count" -eq 0 ]; then
    echo "resume team GH-$epic: skipped — contradictory checkout evidence"
    overall=1
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
