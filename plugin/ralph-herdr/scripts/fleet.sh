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
#   (work-fleet.sh / work-issue-fleet.sh) and exported; the watcher never
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
# both do); spawn_issue_fleet additionally needs lib.sh (spawn_work_session,
# agent_start_when_ready) and probes for it. All JSON through jq; writes are
# tmp+mv (atomic rename); bash 3.2 compatible. No top-level side effects,
# no set/shopt (callers own their shell options).
#
# Knobs:
#   RALPH_HERDR_RUN_ID          the current run (minted via ralph_run_id)
#   RALPH_HERDR_REFILL_TTL_MIN  arming TTL, minutes (default 120)
#   RALPH_HERDR_REFILL_BUDGET   max total spawns per run (default 8)
#   RALPH_HERDR_JOIN_WAIT_SEC   how long spawn_issue_fleet waits for the
#                               issue to reach In Progress before joining
#                               siblings to the claim (default 180; 0 = one
#                               immediate check)
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
# pin the branch (default feature/GH-N; shared-claim siblings pass the
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
  [ -n "$branch" ] || branch="feature/GH-$issue"
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
# `board next --json` envelope ({next, queue: [...]}). Probes ONCE per call
# for a `board frontier --json` verb (dependency-aware Ready∧blockers-merged
# frontier — may not exist yet); absent or unparseable, falls back to the
# ranked `next` queue, whose eligibility filter is already dependency-aware
# (unclaimed Backlog, no open blockers, truncation fails closed — rankNext in
# board.ts). Requires $BOARD (lib.sh).
ralph_fleet_frontier_json() {
  local out
  if out=$("$BOARD" frontier --json 2>/dev/null) && [ -n "$out" ]; then
    jq -c '
      if type == "array" then {next: (.[0] // null), queue: .}
      elif (.queue? // null) != null then {next: (.next? // .queue[0] // null), queue: .queue}
      elif (.frontier? // null) != null then {next: (.frontier[0] // null), queue: .frontier}
      else {next: null, queue: []} end' <<<"$out" 2>/dev/null && return 0
  fi
  "$BOARD" next --json
}

# _ralph_fleet_wait_in_progress ISSUE — bounded poll for ISSUE reaching In
# Progress. `board claim join` is for In Progress items only (no --force, by
# design), and a fresh fleet's issue is still Backlog until sibling 1's
# session boots and /ralph:work claims it — so the join pass waits here
# first. Polls `board claim show --json` every 5s until
# RALPH_HERDR_JOIN_WAIT_SEC (default 180; 0 = one immediate check) elapses.
# rc 0 once In Progress; rc 1 on timeout or a bad knob (callers warn with
# the manual join commands, never die). Requires $BOARD (lib.sh).
_ralph_fleet_wait_in_progress() {
  local issue="$1" wait="${RALPH_HERDR_JOIN_WAIT_SEC:-180}" deadline st
  case "$wait" in
    '' | *[!0-9]* | 0[0-9]*)
      echo "_ralph_fleet_wait_in_progress: RALPH_HERDR_JOIN_WAIT_SEC must be a non-negative integer, no leading zeros (got '$wait')" >&2
      return 1
      ;;
  esac
  deadline=$(($(date +%s) + wait))
  while :; do
    st=$("$BOARD" claim show "$issue" --json 2>/dev/null |
      jq -r '.state // empty' 2>/dev/null) || st=""
    [ "$st" = "In Progress" ] && return 0
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep 5
  done
}

# spawn_issue_fleet ISSUE K [QUEUE_JSON] — a shared-claim fleet: K sibling
# sessions on ONE issue, ONE worktree, ONE branch. Claim v2 (contracts.ts)
# holds up to 8 holders; this is the cockpit's explicit-join surface.
#
#   sibling 1    the normal spawn path (spawn_work_session): worktree
#                resolved/created ONCE, normal grammar-B name, /ralph:work
#                claims inside the session — unchanged.
#   siblings 2..K  additional panes SPLIT inside that worktree workspace
#                (no --focus), named via ralph_agent_name_collide (--2..--K —
#                the generation suffix retained in Phase 1 for exactly this),
#                each briefed with the SHARED branch, each prompted
#                "/ralph:work ISSUE".
#   join pass    AFTER the spawns: `board claim join` refuses anything not
#                In Progress, and at spawn time the issue is still Backlog —
#                sibling 1's session claims it only once its pane boots. So
#                the fleet waits (bounded — _ralph_fleet_wait_in_progress)
#                for that claim, then joins every started sibling via
#                `board claim join ISSUE --holder <name>`. Warn-not-die on
#                timeout or refusal: an unjoined sibling still works (every
#                session on this machine shares the RALPH_CLAIM_HOLDER
#                identity, so its own claim is a legal refresh) — it just
#                isn't visible as a fleet holder until joined by hand.
#
# Ledger records: siblings are PEERS, not children — parent stays empty and
# depth stays 0 (the depth cap is about runaway trees, and a flat fleet is
# not one); root is patched to the FIRST sibling's ref so sidebar views that
# group by root show the fleet as one cluster.
#
# Requires lib.sh sourced (spawn_work_session et al). Honors
# RALPH_HERDR_DRY_RUN. On rc 0, RALPH_HERDR_FLEET_AGENTS holds every started
# agent name (space-separated) for the caller's watcher exec. rc 2 when a
# session already owns ISSUE (issue fleets start fresh — join a live session
# by hand via `board claim join`); rc 1 when the FIRST sibling fails (no
# workspace to split); sibling 2..K failures warn and continue.
spawn_issue_fleet() {
  local issue="${1-}" k="${2-}" queue_json="${3-}"
  local rc=0 first_agent first_ref first_pane wt branch g name pane out ref
  local ts record ledger live siblings
  RALPH_HERDR_FLEET_AGENTS=""
  export RALPH_HERDR_FLEET_AGENTS
  command -v spawn_work_session >/dev/null 2>&1 || {
    echo "spawn_issue_fleet: lib.sh is not sourced (spawn_work_session missing)" >&2
    return 1
  }
  case "$issue" in '' | *[!0-9]*) echo "spawn_issue_fleet: bad issue '$issue'" >&2; return 1 ;; esac
  case "$k" in [1-4]) : ;; *) echo "spawn_issue_fleet: k must be 1..4 (got '$k') — this is an attended tool" >&2; return 1 ;; esac
  branch="feature/GH-$issue"

  echo "── GH-$issue sibling 1/$k ──"
  spawn_work_session "$issue" "$queue_json" || rc=$?
  case "$rc" in
    0) : ;;
    2)
      echo "spawn_issue_fleet: a session already owns GH-$issue — issue fleets start fresh; add siblings to a live session by hand (board claim join)" >&2
      return 2
      ;;
    *) return 1 ;;
  esac
  first_agent="$RALPH_HERDR_SPAWNED_AGENT"
  first_ref="$RALPH_HERDR_SPAWNED_REF"
  first_pane="${RALPH_HERDR_SPAWNED_PANE:-}"
  wt="${RALPH_HERDR_SPAWNED_WORKTREE:-}"
  RALPH_HERDR_FLEET_AGENTS="$first_agent"
  ralph_brief_write "$first_ref" "$issue" "$branch" >/dev/null ||
    echo "spawn_issue_fleet: brief write failed for $first_ref — continuing (briefs are observations)" >&2

  if [ "${RALPH_HERDR_DRY_RUN:-}" = "true" ]; then
    for g in $(seq 2 "$k"); do
      name=$(ralph_agent_name_collide "$first_agent" "$g") || continue
      echo "DRY RUN — sibling $g/$k would: pane split (no focus) in the GH-$issue worktree,"
      echo "  agent start $name, brief (shared branch $branch), prompt \"/ralph:work $issue\""
      RALPH_HERDR_FLEET_AGENTS="$RALPH_HERDR_FLEET_AGENTS $name"
    done
    if [ "$k" -gt 1 ]; then
      echo "DRY RUN — then: wait (bounded, ${RALPH_HERDR_JOIN_WAIT_SEC:-180}s) for GH-$issue to reach In Progress"
      echo "  (sibling 1's session claims it), then board claim join $issue --holder <each sibling>"
    fi
    return 0
  fi
  if [ -z "$first_pane" ] || [ -z "$wt" ]; then
    echo "spawn_issue_fleet: no pane/worktree captured from sibling 1 — cannot split siblings" >&2
    return 1
  fi

  ledger=$(ralph_ledger_path "$REPO" 2>/dev/null) || ledger=""
  for g in $(seq 2 "$k"); do
    echo "── GH-$issue sibling $g/$k ──"
    name=$(ralph_agent_name_collide "$first_agent" "$g") || {
      echo "sibling $g: no collide name derivable from $first_agent — skipping" >&2
      continue
    }
    live=$("$HERDR" agent list | jq -r --arg n "$name" \
      '[.result.agents[]? | select(.name == $n) | .name] | first // empty' 2>/dev/null || true)
    if [ -n "$live" ]; then
      echo "SKIP $name already live"
      continue
    fi
    # Split INSIDE the worktree workspace: pane id anchors the split, --cwd
    # pins the shell to the shared checkout. No --focus — scripted spawns
    # never steal focus (split's default is unfocused; there is no
    # --no-focus flag on this verb).
    out=$("$HERDR" pane split "$first_pane" --direction down --cwd "$wt") || {
      echo "sibling $g: pane split failed — skipping" >&2
      continue
    }
    pane=$(jq -r '.result.pane.pane_id // .result.pane_id // empty' <<<"$out")
    if [ -z "$pane" ]; then
      echo "sibling $g: no pane id in split response — skipping" >&2
      continue
    fi
    agent_start_when_ready "$name" "$pane" || {
      echo "sibling $g: agent start $name failed — the split pane $pane is left for inspection" >&2
      continue
    }
    ts=$(date -u +%FT%TZ)
    if ref=$(ralph_agent_ref "$name" 2>/dev/null); then
      # Peer record: parent empty, depth 0, root = first sibling's ref (the
      # one patch on the shared C7 builder — root groups the fleet in
      # sidebar views; a parent edge would lie about authority and feed the
      # orphan pass a cascade that must not exist for peers).
      record=$(_ralph_spawn_record "$ref" "$issue" "" "$branch" "" "$pane" "$ts") || record=""
      [ -n "$record" ] && record=$(jq -c --arg root "$first_ref" '.tokens.root = $root' <<<"$record") || record=""
      if [ -n "$record" ] && [ -n "$ledger" ]; then
        RALPH_HERDR_LEDGER="$ledger" ralph_ledger_append "$record" ||
          echo "sibling $g: spawn ledger append failed for $ref — reconcile will discover it" >&2
      fi
      if [ -n "$record" ]; then
        set --
        while IFS= read -r kv; do
          [ -n "$kv" ] || continue
          set -- "$@" "$kv"
        done < <(jq -r '.tokens | to_entries[] | "\(.key)=\(.value)"' <<<"$record" 2>/dev/null || true)
        [ "$#" -ge 1 ] && ralph_tokens_push "$pane" "$@"
      fi
      ralph_brief_write "$ref" "$issue" "$branch" >/dev/null ||
        echo "sibling $g: brief write failed for $ref — continuing" >&2
    else
      echo "sibling $g: no durable ref derivable for $name — spawning unledgered" >&2
    fi
    "$HERDR" agent prompt "$name" "/ralph:work $issue" || {
      echo "sibling $g: prompt delivery failed — $name is LIVE and idle in pane $pane; prompt it manually: herdr agent prompt $name \"/ralph:work $issue\"" >&2
    }
    RALPH_HERDR_FLEET_AGENTS="$RALPH_HERDR_FLEET_AGENTS $name"
    echo "sibling $g: $name spawned for GH-$issue on $branch (pane $pane)"
  done

  # Explicit claim join — the cockpit surface for shared claims, run at the
  # first moment it CAN succeed: `board claim join` is for In Progress items
  # only, and the issue stays Backlog until sibling 1's session claims it.
  # Wait (bounded) for that claim, then register every started sibling as a
  # holder. Warn-not-die on timeout or refusal — the siblings keep working
  # either way (see the header); the warning names the manual join.
  siblings=""
  for name in $RALPH_HERDR_FLEET_AGENTS; do
    [ "$name" = "$first_agent" ] || siblings="$siblings $name"
  done
  if [ -n "$siblings" ]; then
    echo "── claim join pass ──"
    if _ralph_fleet_wait_in_progress "$issue"; then
      for name in $siblings; do
        if out=$("$BOARD" claim join "$issue" --holder "$name" 2>&1); then
          echo "joined: $name now holds GH-$issue"
        else
          echo "claim join refused for $name ($(printf '%s' "$out" | head -1)) — not registered as a claim holder; join by hand: board claim join $issue --holder $name" >&2
        fi
      done
    else
      echo "GH-$issue never reached In Progress within ${RALPH_HERDR_JOIN_WAIT_SEC:-180}s — siblings are NOT registered as claim holders." >&2
      echo "Once sibling 1's session claims it, join by hand:" >&2
      for name in $siblings; do
        echo "  board claim join $issue --holder $name" >&2
      done
    fi
  fi
  return 0
}
