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
# Requires naming.sh + ledger.sh sourced first (lib.sh and watch-event.sh both
# do); the GH-1808 spawn paths at the bottom also need lib.sh itself — for
# spawn_work_session, agent_start_when_ready, ralph_depth_guard and roles.sh —
# which is why they are only reachable from a lib.sh-sourced caller. All JSON through jq; writes are
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
  local dir file tmp ttl budget left expires repo session n
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
  # `session` is the arming server's ralph_session_key (GH-1905) — the run's
  # provenance, stamped once, here, where it is free and unambiguous. Phase F
  # of reconcile is the only reader: it must know whether the server about to
  # top this fleet back up is the one the fleet belongs to, and no ledger
  # record can answer that (a fully-retired fleet has none, which is exactly
  # the restart GH-1862 exists for). No hasher / no ledger.sh leaves it empty,
  # and an empty answer arms nothing on the level path — fail closed.
  session=""
  if command -v ralph_session_key >/dev/null 2>&1; then
    session=$(ralph_session_key 2>/dev/null) || session=""
  fi
  jq -nc \
    --arg id "$id" --arg expires "$expires" --arg repo "$repo" \
    --arg session "$session" \
    --arg now "$(date -u +%FT%TZ)" \
    --argjson k "$k" --argjson refill "$refill" --argjson left "$left" \
    --args '
    {run_id: $id, armed: ($refill == 1), k: $k, refill: ($refill == 1),
     budget_left: $left, expires_at: $expires, repo: $repo, session: $session,
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
# spawn_issue_fleet — REMOVED (GH-1774), and STILL removed (GH-1808). Hard
# refusal with a migration path.
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
# GH-1808 narrows the SUBJECT of that finding without weakening it: the hazard
# was never several AGENTS in one tree, it was several WRITERS. What stays
# refused is K sibling drivers. What is now possible is one driver plus N
# read-only investigators — see spawn_investigator_fleet below, where the "one"
# is enforced (ralph_driver_guard) and the "read-only" is a harness allowlist
# rather than a promise.
#
# For a second WRITER the replacement is unchanged and remains decomposition:
# split the work into real board issues with dependency edges, and let
# work-fleet spawn one worker per issue in its own worktree. Git itself agrees
# — one branch cannot be checked out in two worktrees.
#
# Readers and doctor checks may still RECOGNIZE existing Claim v2 values in
# order to report and clean state that was already written. Nothing creates
# them any more.
spawn_issue_fleet() {
  local issue="${1:-<issue>}"
  echo "spawn_issue_fleet: removed in GH-1774 — shared-checkout fleets put several WRITERS in ONE git worktree, where they race on the index, the branch, and each other's uncommitted files. The claim protocol never protected the tree." >&2
  echo "Instead: decompose GH-$issue into separate board issues (board create + board dep), then run work-fleet — one worker per issue, each in its own worktree, each holding its own claim." >&2
  echo "For read-only parallelism on ONE issue, use spawn_investigator_fleet $issue K — one driver, N investigators, no second writer." >&2
  return 1
}

# spawn_investigator_fleet ISSUE K [QUESTION...] — one driver plus K read-only
# investigators on ISSUE, all in the DRIVER'S worktree (GH-1808).
#
# The shape is the whole safety argument:
#   * the driver is spawned by the normal sanctioned path (spawn_work_session),
#     so it takes the board claim, cuts the branch and owns the tree exactly as
#     a lone worker does — a fleet adds no second writer to reason about;
#   * investigators are herdr-plane CHILDREN of that driver, which the edge
#     rules permit (driver -> investigator) and the depth guard bounds;
#   * each investigator's pane runs `claude` under the investigator agent
#     definition's tool allowlist, so "read-only" is what the harness will
#     execute, not what the prompt asks for.
#
# Trailing QUESTION arguments are the investigators' dispatch prompts, one per
# investigator. Fewer questions than K is not padded with a generic prompt: an
# investigator with nothing sharp to answer is fan-out for its own sake, so K
# is capped at the number of questions given.
#
# Returns 0 when the driver is live (investigator failures are reported and
# tolerated — a driver with fewer investigators than asked is still a working
# session); 1 when the driver could not be spawned; 2 when the driver was
# skipped because a session already owns ISSUE or its tree.
spawn_investigator_fleet() {
  local issue="${1-}" k="${2-}" driver_ref driver_pane checkout rc=0
  case "$issue" in '' | *[!0-9]*) echo "spawn_investigator_fleet: bad issue number '$issue'" >&2; return 1 ;; esac
  case "$k" in '' | *[!0-9]* | 0 | 0*) echo "spawn_investigator_fleet: K must be a positive integer (got '$k')" >&2; return 1 ;; esac
  shift 2
  if [ "$#" -lt "$k" ]; then
    echo "spawn_investigator_fleet: $# question(s) for K=$k — spawning $# investigator(s); an investigator with no sharp question is fan-out for its own sake" >&2
    k="$#"
  fi

  spawn_work_session "$issue" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "spawn_investigator_fleet: no driver for GH-$issue — spawning no investigators (they have no tree to read)" >&2
    return "$rc"
  fi
  driver_ref="$RALPH_HERDR_SPAWNED_REF"
  driver_pane="$RALPH_HERDR_SPAWNED_PANE"
  checkout="$RALPH_HERDR_SPAWNED_WORKTREE"
  [ "$k" -ge 1 ] || return 0

  local i=0 q
  for q in "$@"; do
    i=$((i + 1))
    [ "$i" -le "$k" ] || break
    spawn_investigator "$issue" "$driver_ref" "$checkout" "$q" ||
      echo "spawn_investigator_fleet: investigator $i for GH-$issue did not start — the driver is unaffected" >&2
  done
  echo "fleet GH-$issue: driver $driver_ref in $checkout (pane $driver_pane), $k investigator(s) dispatched"
  return 0
}

# spawn_investigator ISSUE PARENT_REF CHECKOUT QUESTION — one read-only
# investigator child, in PARENT's checkout.
#
# Three refusals before anything is created, in the order that costs least:
# the edge rule (a driver may spawn an investigator; an investigator may spawn
# nothing), the depth cap (unchanged at 3), and the harness binding (no
# definition readable = no investigator, because an investigator that could not
# be restricted is a second writer in the tree wearing the wrong token).
#
# The pane is opened in the EXISTING checkout — `pane create --cwd` rather than
# `worktree create`, which would cut a second tree and defeat the point.
spawn_investigator() {
  local issue="${1-}" parent="${2-}" checkout="${3-}" question="${4-}"
  local parent_role depth name pane ref ts record ledger out
  case "$issue" in '' | *[!0-9]*) echo "spawn_investigator: bad issue number '$issue'" >&2; return 1 ;; esac
  [ -n "$parent" ] || { echo "spawn_investigator: no parent ref — an investigator is always a child" >&2; return 1; }
  [ -n "$checkout" ] || { echo "spawn_investigator: no checkout — an investigator reads its parent's tree" >&2; return 1; }
  [ -n "$question" ] || { echo "spawn_investigator: no question — nothing to dispatch" >&2; return 1; }

  # The parent's role from the ledger, defaulted from its lane when the record
  # predates roles. Never assumed: "the caller would not ask if it were not a
  # driver" is the assumption an edge guard exists to stop making.
  parent_role=$(_ralph_ledger_latest '((try .tokens.role catch null) // "")' "$parent" 2>/dev/null) || parent_role=""
  if [ -z "$parent_role" ]; then
    parent_role=$(ralph_role_for_lane "$(ralph_agent_parse "${parent%%#*}" | awk '{print $1}')" 2>/dev/null) || parent_role=""
  fi
  ralph_spawn_edge_guard "${parent_role:-unknown}" investigator || return 1
  depth=$(ralph_depth_guard "$parent") || return 1

  local -a harness=()
  while IFS= read -r out; do harness+=("$out"); done < <(ralph_investigator_harness_args) || true
  [ "${#harness[@]}" -ge 1 ] || {
    echo "spawn_investigator: no investigator harness binding available — refusing to spawn an unrestricted session into $checkout" >&2
    return 1
  }

  name=$(ralph_agent_name i "$issue" "$question" 2>/dev/null) ||
    name=$(ralph_agent_name i "$issue" investigate) || {
      echo "spawn_investigator: could not derive an agent name for GH-$issue" >&2
      return 1
    }

  if [ "${RALPH_HERDR_DRY_RUN:-}" = "true" ]; then
    echo "DRY RUN — would spawn investigator for GH-$issue:"
    echo "  agent: $name   parent: $parent   depth: $depth   cwd: $checkout"
    echo "  $HERDR tab create --cwd $checkout --no-focus --label \"GH-$issue investigator\""
    echo "  $HERDR agent start $name --kind claude --pane <captured> -- ${harness[*]}"
    echo "  $HERDR agent prompt $name <question>"
    return 0
  fi

  # A TAB in the existing checkout, never a worktree: cutting a second tree
  # would give the investigator its own copy of the work the driver is editing,
  # which is the opposite of reading the driver's tree. --workspace keeps it
  # beside the driver when the caller knows where that is.
  set -- --cwd "$checkout" --no-focus --label "GH-$issue investigator"
  [ -n "${RALPH_HERDR_SPAWNED_WORKSPACE:-}" ] && set -- --workspace "$RALPH_HERDR_SPAWNED_WORKSPACE" "$@"
  out=$(ralph_herdr_call tab_created tab create "$@") || {
    echo "spawn_investigator: could not open a tab in $checkout" >&2
    return 1
  }
  pane=$(jq -r '.root_pane.pane_id // empty' <<<"$out")
  [ -n "$pane" ] || { echo "spawn_investigator: no pane id in the tab response" >&2; return 1; }

  agent_start_when_ready "$name" "$pane" "${harness[@]}" || {
    echo "spawn_investigator: agent start $name failed" >&2
    return 1
  }

  ts=$(date -u +%FT%TZ)
  if ref=$(ralph_agent_ref "$name" 2>/dev/null); then
    record=$(_ralph_spawn_record "$ref" "$issue" "" "" "" "$pane" "$ts" "" "$checkout" \
      investigator "$parent" "$depth" "$parent") || record=""
    ledger=$(ralph_ledger_path "$REPO" 2>/dev/null) || ledger=""
    if [ -n "$record" ] && [ -n "$ledger" ]; then
      RALPH_HERDR_LEDGER="$ledger" ralph_ledger_append "$record" ||
        echo "spawn_investigator: ledger append failed for $ref — reconcile will discover it" >&2
    fi
    if [ -n "$record" ]; then
      set --
      while IFS= read -r out; do
        [ -n "$out" ] || continue
        set -- "$@" "$out"
      done < <(jq -r '.tokens | to_entries[] | "\(.key)=\(.value)"' <<<"$record" 2>/dev/null || true)
      [ "$#" -ge 1 ] && ralph_tokens_push "$pane" "$@"
    fi
  fi

  ralph_herdr_call agent_prompted agent prompt "$name" "$question" >/dev/null || {
    echo "spawn_investigator: prompt delivery failed — $name is LIVE and idle in pane $pane" >&2
    return 1
  }
  echo "spawned investigator $name for GH-$issue (pane $pane, parent $parent, depth $depth)"
  return 0
}
