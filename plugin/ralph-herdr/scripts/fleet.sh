#!/usr/bin/env bash
# fleet.sh — per-run fleet state + FleetBrief plumbing for the ralph-herdr
# cockpit (Phase 3). Sourced, never run.
#
# THE RUN
#   One directory per fleet run, OUTSIDE any repo, next to the scope's ledger
#   (same scope/slug rules — ledger.sh owns the derivation):
#
#     ~/.ralph/<owner>/<repo>/runs/<run_id>/
#       fleet.json            arming state (below) — absent = never armed
#       briefs/<agent_ref>.json   C3 FleetBrief, written at spawn
#       reports/              RESERVED for C2 CompletionReports — the skills
#                             learn to write them in Phase 6; nothing reads
#                             this directory yet, it exists so briefs can
#                             carry a stable report_path from day one
#
#   run_id = UTC compact timestamp + 4 hex (20260811T031500Z-a3f2). The
#   "current run" is $RALPH_HERDR_RUN_ID — minted once by the entrypoint
#   (work-fleet.sh) and exported; the watcher never
#   needs it (it scans runs/*/fleet.json).
#
# ARMING (refill) — STAYS OPT-IN: the claim-TTL probe (design §3.1/§5) ran
# 2026-08-11 and returned NO-GO for default/unattended arming (probe doc §3)
#   Refill is OPT-IN PER RUN (work-fleet --refill / RALPH_HERDR_REFILL=1) and
#   self-limiting by construction: fleet.json carries an expires_at TTL
#   (default 120 min) and a max-total-spawns budget (default 8, counted
#   against every spawn ATTEMPT this run, initial spawns included — a failed
#   attempt wastes a unit rather than risking a runaway retry loop). Expiry
#   is checked at READ time (ralph_fleet_state) — no timers, no daemons; a
#   fleet nobody pokes simply never refills again. fleet.json shape:
#
#     {run_id, armed, k, refill, budget_left, expires_at, repo,
#      spawned: [issue...], inflight: [{issue, ts}...], created_at}
#
#   `armed` is written as ($refill == 1): a refill=0 arm is the audit-trail
#   record of a one-shot run and every refill consumer gates on `.armed`
#   alone. `inflight` tracks picks whose spawn has not finished yet (consume
#   records them, ralph_fleet_spawn_done clears them) — the refill capacity
#   check counts them, since a mid-spawn agent is invisible to `agent list`.
#
#   `repo` is recorded at arm time because the refill consumer is an event
#   hook with NO workspace cwd — it must re-discover the checkout the human
#   armed from. `spawned` is the race-closer: consuming a budget unit and
#   recording the picked issue is ONE atomic section under the ledger mutex,
#   so two concurrent hooks can never pick the same frontier item; it also
#   means a refill never re-picks an issue this run already spawned — a
#   crashed sibling is attention, not auto-respawn capacity. (A `filter`
#   field is reserved for future frontier filtering; nothing writes it yet.)
#
# LEDGER EVENT
#   Every refill spawn appends {ts, ev: "refill_spawn", run_id, agent_ref,
#   issue, budget_left} — an ANNOTATION next to the C7 spawn record
#   spawn_work_session already appended (the reducers in ledger.sh ignore
#   unknown ev values by construction, so this is additive).
#
# Requires naming.sh + ledger.sh sourced first (lib.sh and watch-event.sh
# both do; the removed spawn_issue_fleet needed lib.sh for
# agent_start_when_ready) and probes for it. All JSON through jq; writes are
# tmp+mv (atomic rename); bash 3.2 compatible. No top-level side effects,
# no set/shopt (callers own their shell options).
#
# Knobs:
#   RALPH_HERDR_RUN_ID          the current run (minted via ralph_run_id)
#   RALPH_HERDR_REFILL_TTL_MIN  arming TTL, minutes (default 120)
#   RALPH_HERDR_REFILL_BUDGET   max total spawns per run (default 8)
#   RALPH_HERDR_REPLY_TO        FleetBrief reply_to agent name (default
#                               s0-watch — the watcher is the one durable
#                               herdr-agent surface; cockpit panes are not
#                               agents, so briefs point replies at it)

# ralph_run_id — mint a fresh run id: UTC compact timestamp + 4 hex chars
# (cheap cksum hash of time+pid+RANDOM, same recipe as ralph_agent_ref).
ralph_run_id() {
  local sum
  sum=$(printf '%s' "$(date +%s)$$$RANDOM" | cksum | awk '{print $1}')
  printf '%s-%04x\n' "$(date -u +%Y%m%dT%H%M%SZ)" "$((sum % 65536))"
}

# ralph_run_dir RUN_ID [REPO_ROOT] — print the run directory, creating it
# (plus briefs/ and reports/). Scope resolution is ralph_ledger_path's —
# $RALPH_HERDR_LEDGER override included, so tests point everything at a
# fixture dir with one env var. The default root is $REPO (lib.sh's repo,
# same scope the spawn path ledgers under), falling back to $PWD when
# fleet.sh is sourced without lib.sh.
ralph_run_dir() {
  local id="${1-}" ledger dir
  if [ -z "$id" ]; then
    echo "ralph_run_dir: run id required" >&2
    return 1
  fi
  ledger=$(ralph_ledger_path "${2:-${REPO:-$PWD}}") || return 1
  dir="$(dirname "$ledger")/runs/$id"
  mkdir -p "$dir/briefs" "$dir/reports" || return 1
  printf '%s\n' "$dir"
}

# _ralph_fleet_expiry MIN — ISO UTC timestamp MIN minutes from now (negative
# MIN = in the past; the inflight staleness cutoff uses that). BSD date
# takes -r EPOCH (macOS), GNU takes -d @EPOCH — try both; ISO UTC strings
# compare lexicographically, so readers never parse dates at all.
_ralph_fleet_expiry() {
  local epoch
  epoch=$(($(date +%s) + $1 * 60))
  date -u -r "$epoch" +%FT%TZ 2>/dev/null || date -u -d "@$epoch" +%FT%TZ
}

# _ralph_fleet_scope_ledger FLEET_FILE — the scope ledger file a fleet.json
# belongs to (…/<owner>/<repo>/runs/<id>/fleet.json → …/<owner>/<repo>/
# ledger.jsonl). Deterministic from the path alone — the refill hook and the
# cockpit must serialize on the SAME mutex regardless of env.
_ralph_fleet_scope_ledger() {
  printf '%s/ledger.jsonl\n' "$(dirname "$(dirname "$(dirname "$1")")")"
}

# ralph_fleet_arm K REFILL [ISSUE...] — write the current run's fleet.json.
# K is the concurrency target (live w-agents the refill loop tops up to);
# REFILL is 0|1. A refill=0 arm records the run for the audit trail with
# `armed: false` — every refill consumer gates on `.armed`, so writing the
# gate down disarmed IS the one-shot guarantee (no reader ever has to
# remember to check `.refill` separately). Trailing ISSUE numbers are the
# run's initial spawns: they seed `spawned` and are pre-charged against the
# budget (max TOTAL spawns per run). rc 1 on bad arguments or an unwritable
# dir. Leading-zero numbers are refused everywhere (bash arithmetic would
# read them as octal — validate_pos_int's rule, restated for sourcing order).
ralph_fleet_arm() {
  local k="${1-}" refill="${2-}" id="${RALPH_HERDR_RUN_ID:-}"
  local dir file tmp ttl budget left expires repo n
  case "$k" in '' | *[!0-9]* | 0 | 0*) echo "ralph_fleet_arm: k must be a positive integer (got '$k')" >&2; return 1 ;; esac
  case "$refill" in 0 | 1) : ;; *) echo "ralph_fleet_arm: refill must be 0 or 1 (got '$refill')" >&2; return 1 ;; esac
  if [ -z "$id" ]; then
    echo "ralph_fleet_arm: RALPH_HERDR_RUN_ID is not set — mint one with ralph_run_id" >&2
    return 1
  fi
  shift 2
  for n in "$@"; do
    case "$n" in '' | *[!0-9]*) echo "ralph_fleet_arm: bad issue number '$n'" >&2; return 1 ;; esac
  done
  ttl="${RALPH_HERDR_REFILL_TTL_MIN:-120}"
  budget="${RALPH_HERDR_REFILL_BUDGET:-8}"
  case "$ttl" in '' | *[!0-9]* | 0 | 0*) echo "ralph_fleet_arm: RALPH_HERDR_REFILL_TTL_MIN must be a positive integer, no leading zeros (got '$ttl')" >&2; return 1 ;; esac
  case "$budget" in '' | *[!0-9]* | 0 | 0*) echo "ralph_fleet_arm: RALPH_HERDR_REFILL_BUDGET must be a positive integer, no leading zeros (got '$budget')" >&2; return 1 ;; esac
  left=$((budget - $#))
  [ "$left" -ge 0 ] || left=0
  dir=$(ralph_run_dir "$id") || return 1
  file="$dir/fleet.json"
  tmp="$file.tmp.$$"
  expires=$(_ralph_fleet_expiry "$ttl") || return 1
  repo="${REPO:-$PWD}"
  jq -nc \
    --arg id "$id" --arg expires "$expires" --arg repo "$repo" \
    --arg now "$(date -u +%FT%TZ)" \
    --argjson k "$k" --argjson refill "$refill" --argjson left "$left" \
    --args '
    {run_id: $id, armed: ($refill == 1), k: $k, refill: ($refill == 1),
     budget_left: $left, expires_at: $expires, repo: $repo,
     spawned: ($ARGS.positional | map(tonumber)), created_at: $now}' \
    -- "$@" >"$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$file" || { rm -f "$tmp"; return 1; }
  printf '%s\n' "$file"
}

# ralph_fleet_state [FLEET_FILE] — read + validate a fleet.json (default: the
# current run's). Prints the state with `.expired` computed and `.armed`
# FORCED false when expired — expiry is enforced at read time, never by a
# timer, so every consumer sees a lapsed arming as disarmed no matter what
# the file says. rc 1 (with a stderr note) on a missing or shape-invalid file.
ralph_fleet_state() {
  local file="${1-}" out
  if [ -z "$file" ]; then
    if [ -z "${RALPH_HERDR_RUN_ID:-}" ]; then
      echo "ralph_fleet_state: no fleet file given and RALPH_HERDR_RUN_ID unset" >&2
      return 1
    fi
    file="$(ralph_run_dir "$RALPH_HERDR_RUN_ID")/fleet.json" || return 1
  fi
  if [ ! -f "$file" ]; then
    echo "ralph_fleet_state: no fleet.json at $file (run never armed)" >&2
    return 1
  fi
  out=$(jq -ec --arg now "$(date -u +%FT%TZ)" '
    select((.run_id? // "") != ""
      and ((.k? | type) == "number")
      and ((.budget_left? | type) == "number")
      and ((.expires_at? // "") != ""))
    | .expired = (.expires_at <= $now)
    | .armed = ((.armed == true) and (.expired | not))' \
    "$file" 2>/dev/null) || {
    echo "ralph_fleet_state: $file is not a valid fleet state" >&2
    return 1
  }
  printf '%s\n' "$out"
}

# ralph_fleet_disarm [FLEET_FILE] [REASON] — set armed=false. Idempotent and
# quiet: a missing file is rc 0 (nothing was armed). Board state stays
# authoritative throughout — disarming only stops REFILLS; live sessions and
# their claims are untouched.
ralph_fleet_disarm() {
  local file="${1-}" reason="${2-}" tmp
  if [ -z "$file" ]; then
    [ -n "${RALPH_HERDR_RUN_ID:-}" ] || return 0
    file="$(ralph_run_dir "$RALPH_HERDR_RUN_ID")/fleet.json" || return 1
  fi
  [ -f "$file" ] || return 0
  tmp="$file.tmp.$$"
  jq -c --arg now "$(date -u +%FT%TZ)" --arg why "$reason" '
    .armed = false | .disarmed_at = $now
    | (if $why == "" then . else .disarm_reason = $why end)' \
    "$file" >"$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$file" || { rm -f "$tmp"; return 1; }
  return 0
}

# ralph_fleet_consume_budget FLEET_FILE ISSUE — atomically claim one refill
# slot for ISSUE: under the scope's ledger mutex (ralph_ledger_lock — the
# SAME lock the event hooks serialize on; when the caller already holds it,
# detected via _RALPH_LEDGER_LOCK_HELD, no re-lock — the mutex is not
# reentrant), re-read the state and refuse unless armed, unexpired,
# budget_left > 0, and ISSUE not already in `spawned`; then decrement the
# budget and record ISSUE in BOTH `spawned` and `inflight` in one rename.
# The inflight entry ({issue, ts}) makes the not-yet-visible spawn count
# toward refill capacity until ralph_fleet_spawn_done clears it. Prints the
# new budget_left on rc 0; rc 1 refused (reason on stderr).
ralph_fleet_consume_budget() {
  local file="${1-}" issue="${2-}" ledger held="" state left tmp rc=0
  case "$issue" in '' | *[!0-9]*) echo "ralph_fleet_consume_budget: bad issue '$issue'" >&2; return 1 ;; esac
  [ -f "$file" ] || { echo "ralph_fleet_consume_budget: no fleet file $file" >&2; return 1; }
  ledger=$(_ralph_fleet_scope_ledger "$file")
  # Held-lock detection is IDENTITY-checked: only the SCOPE'S OWN lock counts.
  # A caller holding some other ledger's mutex has no exclusion over this
  # fleet file — skipping the lock then would reopen the double-spend race
  # this section exists to close.
  [ "$_RALPH_LEDGER_LOCK_HELD" = "$(dirname "$ledger")/.ledger.lock" ] && held=1
  [ -n "$held" ] || ralph_ledger_lock "$ledger"
  state=$(ralph_fleet_state "$file") || rc=1
  if [ "$rc" -eq 0 ]; then
    left=$(jq -r --argjson n "$issue" '
      if .armed != true then "refused: not armed (or expired)"
      elif .budget_left <= 0 then "refused: budget exhausted"
      elif ((.spawned // []) | index($n)) != null then "refused: issue already spawned this run"
      else (.budget_left - 1 | tostring) end' <<<"$state")
    case "$left" in
      refused:*)
        echo "ralph_fleet_consume_budget: $left (issue $issue)" >&2
        rc=1
        ;;
      *)
        tmp="$file.tmp.$$"
        if jq -c --argjson n "$issue" --arg now "$(date -u +%FT%TZ)" \
          '.budget_left -= 1 | .spawned = ((.spawned // []) + [$n])
           | .inflight = ((.inflight // []) + [{issue: $n, ts: $now}])' \
          "$file" >"$tmp" 2>/dev/null && mv "$tmp" "$file"; then
          printf '%s\n' "$left"
        else
          rm -f "$tmp"
          echo "ralph_fleet_consume_budget: could not rewrite $file" >&2
          rc=1
        fi
        ;;
    esac
  fi
  [ -n "$held" ] || ralph_ledger_unlock "$ledger"
  return "$rc"
}

# ralph_fleet_spawn_done FLEET_FILE ISSUE — the spawn attempt for ISSUE has
# finished (any outcome): drop its `inflight` entry, under the same scope
# mutex (same held-lock identity rule as consume). The budget stays spent
# and `spawned` keeps the pick — this only stops the finished attempt from
# counting as capacity-in-flight. Always rc 0 for the caller's convenience
# (a leftover entry merely under-fills until its 10-min staleness cutoff);
# a bad ISSUE or missing file is a quiet no-op.
ralph_fleet_spawn_done() {
  local file="${1-}" issue="${2-}" ledger held="" tmp
  case "$issue" in '' | *[!0-9]*) return 0 ;; esac
  [ -f "$file" ] || return 0
  ledger=$(_ralph_fleet_scope_ledger "$file")
  [ "$_RALPH_LEDGER_LOCK_HELD" = "$(dirname "$ledger")/.ledger.lock" ] && held=1
  [ -n "$held" ] || ralph_ledger_lock "$ledger"
  tmp="$file.tmp.$$"
  if jq -c --argjson n "$issue" \
    '.inflight = [(.inflight // [])[] | select(.issue != $n)]' \
    "$file" >"$tmp" 2>/dev/null && mv "$tmp" "$file"; then
    :
  else
    rm -f "$tmp"
    echo "ralph_fleet_spawn_done: could not rewrite $file (inflight entry for $issue remains until its cutoff)" >&2
  fi
  [ -n "$held" ] || ralph_ledger_unlock "$ledger"
  return 0
}

# ralph_brief_write AGENT_REF ISSUE [BRANCH] [REPLY_TO] — write the C3
# FleetBrief for a spawn into the current run's briefs/ dir and print its
# path. Fields per FleetBriefSchema (contracts.ts): role is the ref's lane
# (only w has a skill mapping today — anything else is refused), the skill
# invocation is exactly what the pane was prompted with, reply_to points at
# a durable herdr agent (default s0-watch — see the header), report_path is
# where Phase-6 skills will drop the C2 CompletionReport, and constraints
# pin the branch (default: the board CLI's grammar for the issue, legacy
# feature/GH-N when it cannot be reached; shared-claim siblings pass the
# SHARED branch), base origin/main, no_force always.
#
# When a board CLI is resolvable ($BOARD from lib.sh) the brief is validated
# via `board contract validate ralph.fleet_brief` — warn-not-die: a missing
# CLI or a failed validation costs a warning, never the spawn (briefs are
# observations; the board stays authoritative).
ralph_brief_write() {
  local ref="${1-}" issue="${2-}" branch="${3-}" reply="${4-}"
  local id="${RALPH_HERDR_RUN_ID:-}" parsed lane dir file out
  case "$issue" in '' | *[!0-9]*) echo "ralph_brief_write: bad issue '$issue'" >&2; return 1 ;; esac
  if [ -z "$id" ]; then
    echo "ralph_brief_write: RALPH_HERDR_RUN_ID is not set" >&2
    return 1
  fi
  parsed=$(ralph_agent_parse "${ref%%#*}") || {
    echo "ralph_brief_write: unparseable agent ref '$ref'" >&2
    return 1
  }
  lane="${parsed%% *}"
  if [ "$lane" != "w" ]; then
    echo "ralph_brief_write: lane '$lane' has no skill mapping — only w-lane briefs exist today" >&2
    return 1
  fi
  # The default is derived, not formatted (GH-1858): spawn callers pass the
  # branch they actually cut, and a shared-claim sibling passes the SHARED
  # one, so this only fires for a brief written outside a spawn. A board CLI
  # that cannot name the issue leaves the legacy shape — it still resolves
  # everywhere, and a brief is an observation that must not cost the spawn.
  [ -n "$branch" ] || branch=$(ralph_branch_for_issue "$issue" 2>/dev/null) ||
    branch="feature/GH-$issue"
  [ -n "$reply" ] || reply="${RALPH_HERDR_REPLY_TO:-s0-watch}"
  dir=$(ralph_run_dir "$id") || return 1
  file="$dir/briefs/$ref.json"
  jq -nc \
    --argjson issue "$issue" --arg skill "/ralph:work $issue" \
    --arg reply "$reply" --arg report "$dir/reports/$ref.json" \
    --arg branch "$branch" '
    {contract: "ralph.fleet_brief", contract_version: 1,
     issue: $issue, role: "w", skill_invocation: $skill,
     reply_to: {kind: "herdr_agent", name: $reply},
     report_path: $report,
     constraints: {branch: $branch, base: "origin/main", no_force: true}}' \
    >"$file" || return 1
  if [ -n "${BOARD:-}" ] && [ -x "$BOARD" ]; then
    out=$("$BOARD" contract validate ralph.fleet_brief "$file" 2>&1) ||
      echo "ralph_brief_write: brief failed contract validation (kept anyway): $out" >&2
  else
    echo "ralph_brief_write: no board CLI resolvable — brief written unvalidated" >&2
  fi
  printf '%s\n' "$file"
}

# ralph_fleet_frontier_json — the fleet's candidate source, normalized to the
# `board next --json` envelope ({next, queue: [...], blocked: [...]}). The
# blocked section rides along so a caller validating an EXPLICIT issue list can
# tell "blocked by #N" from "not eligible" without a second board read; its
# per-item shape is whichever verb answered (frontier: blockers_open; next:
# openBlockers), so consumers read both keys. Probes ONCE per call
# for a `board frontier --json` verb (dependency-aware Ready∧blockers-merged
# frontier — may not exist yet); absent or unparseable, falls back to the
# ranked `next` queue, whose eligibility filter is already dependency-aware
# (unclaimed Backlog, no open blockers, truncation fails closed — rankNext in
# board.ts). Requires $BOARD (lib.sh).
ralph_fleet_frontier_json() {
  local out
  if out=$("$BOARD" frontier --json 2>/dev/null) && [ -n "$out" ]; then
    jq -c '
      if type == "array" then {next: (.[0] // null), queue: ., blocked: []}
      elif (.queue? // null) != null then {next: (.next? // .queue[0] // null), queue: .queue, blocked: (.blocked? // [])}
      elif (.frontier? // null) != null then {next: (.frontier[0] // null), queue: .frontier, blocked: (.blocked? // [])}
      else {next: null, queue: [], blocked: []} end' <<<"$out" 2>/dev/null && return 0
  fi
  "$BOARD" next --json
}
# spawn_issue_fleet — REMOVED (GH-1774). Hard refusal with a migration path.
#
# This was a shared-CHECKOUT fleet: K sibling /ralph:work sessions on one
# issue, one worktree, one branch, joined to a multi-holder Claim v2. The claim
# protocol was the safe part. The filesystem was not.
#
# Siblings shared a working tree, which means they shared the index, the
# checked-out branch, every uncommitted file, and each other's cleanup. Two
# agents editing one worktree race on `git add`, stage each other's half-
# finished edits into one commit, check out over each other's work, and
# reconcile into a branch no one of them intended. No amount of claim-holder
# bookkeeping makes concurrent writes to one checkout safe, because the claim
# is coordinating access to the ISSUE while the damage happens to the TREE.
#
# It is removed rather than fixed because there is nothing here to fix: making
# it safe means giving each sibling its own checkout, and a sibling with its
# own checkout is just a separate worker on a separate issue — which the normal
# spawn path already does, with the board's one-holder claim protecting it.
#
# The replacement is decomposition: split the work into real board issues with
# dependency edges, and let work-fleet spawn one worker per issue in its own
# worktree. That is more parallelism than this ever safely delivered, and the
# board can actually see it.
#
# Readers and doctor checks may still RECOGNIZE existing Claim v2 values in
# order to report and clean state that was already written. Nothing creates
# them any more.
spawn_issue_fleet() {
  local issue="${1:-<issue>}"
  echo "spawn_issue_fleet: removed in GH-1774 — shared-checkout fleets put several agents in ONE git worktree, where they race on the index, the branch, and each other's uncommitted files. The claim protocol never protected the tree." >&2
  echo "Instead: decompose GH-$issue into separate board issues (board create + board dep), then run work-fleet — one worker per issue, each in its own worktree, each holding its own claim." >&2
  return 1
}
