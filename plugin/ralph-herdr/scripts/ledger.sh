#!/usr/bin/env bash
# ledger.sh — append-only events ledger for the ralph-herdr watcher. Sourced,
# never run (watch-event.sh and reconcile.sh pull it in; lib.sh's spawn path
# appends the spawn record through it).
#
# THE LEDGER
#   One SQLite tape per board scope: ~/.ralph/<owner>/<repo>/ledger.sqlite
#   (schema v1, GH-2305; the truth since phase D / GH-2311), addressed
#   everywhere by its LOCATOR — the sibling ledger.jsonl path, which is what
#   $RALPH_HERDR_LEDGER and every consumer pass around, whether or not that
#   file still exists. A present ledger.jsonl is FROZEN (export-only; the
#   sanctioned regeneration is `ledger-convert.sh --export`); on a machine
#   never converted, the legacy JSONL still serves reads until ralph 1.0.0,
#   behind a one-line stderr deprecation courtesy. The ledger lives
#   deliberately OUTSIDE any repo (worktree-per-job would make an in-repo
#   ledger a merge hazard). owner and repo are separate path components
#   (slugged separately): a joined "<owner>-<repo>" would collide distinct
#   boards, since '-' is legal inside both (foo-bar/baz vs foo/bar-baz).
#   owner/repo come from the same scope config board.ts reads (.ralph.json,
#   else .claude/settings.json env — wholesale per file, like board.ts), so
#   the main checkout and every worktree of one repo resolve the SAME ledger.
#
#   Every line is one event object:
#     {ts, ev, agent_ref, session, ...ev-specific}
#   `session` is ralph_session_key — the server that WROTE the record, stamped
#   by ralph_ledger_append. It is how reconcile proves a ledger is its own once
#   the last pane that would have proven it is gone (GH-1933).
#   ev vocabulary: spawn | state | adopt | exit | discover | containment |
#   usage | lost ("lost" is
#   reserved; a lost agent is recorded as ev=exit reason=swept-unknown —
#   spelled "lost" before GH-2309, see the exit-reason enum below).
#     spawn     appended by the spawn paths (lib.sh, work-team.sh, fleet.sh's
#               investigator, and since GH-2342 the t0-tend / r0-deliver lane
#               passes) AT PANE CREATION — the one
#               documented carve-out from "the watcher is the sole appender"
#               (spawn happens before any event hook can fire; a single-line
#               O_APPEND write stays atomic). Embeds the C7 LineageRecord as
#               .lineage and the C8 token map as .tokens. Provisional since
#               the 2026-08-19 audit (D2b): written before `agent start`, so
#               a spawner killed pre-start leaves a sweepable open row; the
#               spawn path itself closes it ({ev: exit, reason: never_started,
#               via: spawn}) on the paths that prove no worker ever existed.
#     state     watcher: {agent_status} (raw herdr status) or {state}
#               (lifecycle token value, e.g. "orphaned").
#     adopt     watcher orphan pass: {parent: new, prev_parent: old}.
#     exit      watcher/reconcile/spawn: {reason: <exit reason>}.
#     discover  watcher/reconcile: a live ralph agent with no open ledger
#               record (spawned while the ledger didn't exist, or by hand).
#     containment  spawn path (GH-2267): {tool_binding, process_containment,
#               via: "spawn"} — what the spawn ACHIEVED for each mechanism,
#               one contracts.ts CONTAINMENT_OUTCOMES word each, written
#               after the in-pane probe for a record that was provisional
#               before it. Spawn records written after their probe carry the
#               same two fields at top level instead. Neutral to the open-set
#               reduce: it never opens or closes a row.
#     usage     watcher/reconcile (GH-2347): what the worker's Claude session
#               consumed, reduced from its transcript — at exit and at each
#               `done` turn boundary. Neutral to the open-set reduce like
#               containment; latest wins per ref. See the usage section at
#               the end of this file for the shape and the claude_session
#               field the state/discover records carry.
#
#   EXIT REASON ENUM (GH-2309, phase C). The typed vocabulary for exit.reason:
#     finished | yielded | crashed | restart-killed | swept-unknown |
#     pane-closed | pane-exited | stood-down
#   Reserved values exist before anything emits them: finished/yielded need
#   heartbeat/handshake signals that are a separate swing. Live writers today:
#   reconcile's sweep emits swept-unknown (the honest name for what the sweep
#   proves — an absence asked twice, nothing about how the worker ended; the
#   pre-enum spelling was "lost"), phase E's pane-proved verdicts emit
#   crashed/restart_killed (claim-recover.sh), the event hooks emit
#   pane_exited/pane_closed, and work-team.sh's --stand-down (GH-2357) emits
#   stood-down for an o-lane lead the operator parks deliberately — the one
#   exit reason a human writes on purpose rather than the watcher inferring
#   from a pane death, and the one heal.sh (GH-2212) reads back to refuse a
#   respawn. never_started (the spawn path's provisional close) is via-spawn
#   bookkeeping, outside this enum. Historical rows are NEVER rewritten; a
#   reader that branches on reason normalizes through ralph_ledger_reason_canon
#   (the ONE alias mapping — lost → swept-unknown, underscore spellings →
#   their hyphenated enum forms), never per consumer.
#
#   Appends are sqlite INSERTs (phase D, GH-2311): WAL + busy_timeout carry
#   concurrent-append safety, and the seq race between two writers settles at
#   the PRIMARY KEY with a bounded retry — both land, distinct seq. The old
#   4096-byte line ceiling is GONE: it protected the JSONL sink's single
#   write(2) append atomicity, a budget sqlite rows do not have. Readers are
#   pure jq reductions over the whole event stream, so duplicate events are
#   tolerated by construction; writers that must read-decide-append (the
#   watcher hooks, reconcile) still serialize through
#   ralph_ledger_lock/unlock — appends alone need no lock (see the
#   serialization argument at _ralph_ledger_sqlite_append).
#
# LEDGER SELECTION
#   Every function operates on "the current ledger": $RALPH_HERDR_LEDGER when
#   set (the watcher iterates ~/.ralph/*/*/ledger.jsonl this way; tests point it
#   at a fixture), else derived from a repo root (argument, default $PWD) via
#   ralph_ledger_path.
#
# Knobs:
#   RALPH_HERDR_LEDGER        explicit ledger file path (overrides derivation)
#   RALPH_HERDR_LEDGER_ROOT   ledger root dir (default ~/.ralph)
#
# Pure functions + file appends only — no top-level side effects, no set/shopt
# (callers own their shell options). bash 3.2 compatible. Needs jq.

# The sqlite tape's rules — db path, phash, DDL, user_version, typed
# projection — have ONE definition, ledger-convert.sh (the GH-1843 shape);
# the writer and readers below only call them. Guarded twice: skipped when
# already defined (the converter executable sources ledger.sh back, and
# re-sourcing it here would loop), and skipped when the file is absent (a
# stripped tree — cockpit tests copy ledger.sh alone for its path helpers;
# reads there fall to the extension-swap mirror, and appends refuse loudly).
if ! command -v ralph_lc_db_path >/dev/null 2>&1; then
  _RALPH_LEDGER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -f "$_RALPH_LEDGER_DIR/ledger-convert.sh" ]; then
    # shellcheck source=ledger-convert.sh
    . "$_RALPH_LEDGER_DIR/ledger-convert.sh"
  fi
fi

# _ralph_ledger_slug STR — path-safe component: any char outside
# [A-Za-z0-9._-] becomes '-', and the two traversal names "." and ".." get a
# "_" prefix (dots are otherwise legal — ".github" is a real repo name).
# Each scope component slugs SEPARATELY and becomes its own directory level.
_ralph_ledger_slug() {
  local s
  s=$(printf '%s' "${1-}" | LC_ALL=C tr -c 'A-Za-z0-9._-' '-')
  case "$s" in
    . | ..) s="_$s" ;;
  esac
  printf '%s' "$s"
}

# _ralph_ledger_scope REPO_ROOT — print "owner repo" from the board scope
# config, mirroring board.ts loadConfig: .ralph.json when it exists, ELSE
# .claude/settings.json's env block — wholesale per file, never mixing fields
# across files, and never process env (board.ts treats scope as repo-anchored;
# an event-hook process inherits the SERVER's environment, which must not
# ledger agents under a scope board.ts would never resolve). rc 1 (silently —
# callers probe) when the chosen file yields no complete owner/repo pair.
_ralph_ledger_scope() {
  local root="${1-}" cfg="" owner="" repo=""
  [ -n "$root" ] || return 1
  if [ -f "$root/.ralph.json" ]; then
    cfg="$root/.ralph.json"
    owner=$(jq -r '.owner // empty' "$cfg" 2>/dev/null) || owner=""
    repo=$(jq -r '.repo // empty' "$cfg" 2>/dev/null) || repo=""
  elif [ -f "$root/.claude/settings.json" ]; then
    cfg="$root/.claude/settings.json"
    owner=$(jq -r '.env.RALPH_GH_OWNER // empty' "$cfg" 2>/dev/null) || owner=""
    repo=$(jq -r '.env.RALPH_GH_REPO // empty' "$cfg" 2>/dev/null) || repo=""
  fi
  [ -n "$owner" ] || return 1
  [ -n "$repo" ] || return 1
  printf '%s %s\n' "$owner" "$repo"
}

# ralph_ledger_path [REPO_ROOT] — print the current ledger file path, creating
# its directory. $RALPH_HERDR_LEDGER wins outright; otherwise the scope is
# read from REPO_ROOT (default $PWD), falling back to that directory's git
# toplevel when the scope files aren't at the given path (worktree subdirs).
ralph_ledger_path() {
  local root scope owner repo dir
  if [ -n "${RALPH_HERDR_LEDGER:-}" ]; then
    dir=$(dirname "$RALPH_HERDR_LEDGER")
    mkdir -p "$dir" || return 1
    printf '%s\n' "$RALPH_HERDR_LEDGER"
    return 0
  fi
  root="${1:-$PWD}"
  if [ ! -f "$root/.ralph.json" ] && [ ! -f "$root/.claude/settings.json" ]; then
    root=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null) || root="${1:-$PWD}"
  fi
  scope=$(_ralph_ledger_scope "$root") || {
    echo "ralph_ledger_path: no board scope discoverable from $root — need .ralph.json or .claude/settings.json env (RALPH_GH_OWNER/RALPH_GH_REPO)" >&2
    return 1
  }
  owner=$(_ralph_ledger_slug "${scope%% *}")
  repo=$(_ralph_ledger_slug "${scope#* }")
  # Nested <owner>/<repo> dirs, NOT "<owner>-<repo>": '-' is legal inside
  # both names, so the joined form is not injective (foo-bar/baz and
  # foo/bar-baz would interleave two boards in one ledger file).
  dir="${RALPH_HERDR_LEDGER_ROOT:-$HOME/.ralph}/$owner/$repo"
  mkdir -p "$dir" || return 1
  printf '%s\n' "$dir/ledger.jsonl"
}

# ralph_session_key — a stable identifier for the Herdr server being talked to.
#
# Resolution mirrors Herdr's own socket selection: an explicit --session (which
# callers pass through RALPH_HERDR_SESSION), then HERDR_SOCKET_PATH, then
# HERDR_SESSION, then the default session. The result is hashed rather than
# used raw because it is written into ledger records and a socket path is
# neither length- nor charset-bounded.
#
# Why a key at all: the durable identity of a worker has to survive the socket
# being re-pointed. Two servers can host identically-named agents, and a ledger
# that cannot tell them apart will let one session's reconcile close the
# other's workers.
#
# It lives HERE, not in scope.sh, because ralph_ledger_append stamps it on
# every record and ledger.sh is sourced before scope.sh everywhere. A key that
# was merely usually-defined would degrade to an unstamped record — which reads
# as a legacy record, i.e. as ownership evidence that was never written.
ralph_session_key() {
  local sock

  if [ -n "${RALPH_HERDR_SESSION:-}" ]; then
    sock="session:$RALPH_HERDR_SESSION"
  elif [ -n "${HERDR_SOCKET_PATH:-}" ]; then
    sock="socket:$HERDR_SOCKET_PATH"
  elif [ -n "${HERDR_SESSION:-}" ]; then
    sock="session:$HERDR_SESSION"
  else
    sock="session:default"
  fi

  # Normalized before hashing so "session:foo" reached by two different routes
  # produces one key. Truncated to 12 hex chars: this is a namespace tag inside
  # an already-scoped ledger, not a security boundary.
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$sock" | shasum -a 256 | cut -c1-12
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$sock" | sha256sum | cut -c1-12
  else
    # No hasher anywhere is not a reason to lose scoping — degrade to a
    # slugified literal, which is still unique per socket, only longer.
    printf '%s' "$sock" | LC_ALL=C tr -c 'A-Za-z0-9' '-' | cut -c1-12
  fi
}

# ralph_ledger_append JSON — validate and append ONE event to the tape.
# Refuses: invalid JSON, anything that compacts to more than one line
# (multiple documents), and any sqlite failure — since phase D (GH-2311) the
# sqlite IS the only sink, so a failed insert is a refused append (rc 1, the
# reason on stderr), never a silently dropped fact. The 4096-byte ceiling is
# GONE: it protected the JSONL sink's single-write(2) append atomicity, a
# budget sqlite rows do not have.
#
# Every record carries `.session`, the ralph_session_key of the server that
# wrote it (GH-1933). It is stamped HERE rather than at each of the ~dozen call
# sites so no appender can forget it, and it is what lets reconcile prove a
# ledger is its own after the last pane is gone: a pane proves ownership only
# while it lives, but the record outlives it. A caller that already supplied
# `.session` keeps it — replay and migration paths must be able to preserve the
# original writer.
# _ralph_ledger_sqlite_append FILE LINE — insert LINE as the next fact in
# FILE's sibling ledger.sqlite (schema v1, GH-2305), creating the tape when
# absent. rc 1 with the reason on stderr on ANY failure — never a silent drop.
#
# Absent DB: a legacy JSONL beside it is converted INTO the fresh tape first
# (full history, then this append at N+1). Creating an empty tape instead
# would (a) blind every reader to the whole history the moment the tape
# appears — a present tape is served, full stop, phase D's own read rule —
# and (b) burn seqs 1..k that the converter's seq-salted phash needs for the
# JSONL's lines, making the promised later backfill silently impossible
# (INSERT OR IGNORE never overwrites). No JSONL at all = a fresh machine,
# fresh tape at seq 1. The creation step is serialized under the ledger
# mutex (re-entrancy-aware: a caller already inside a locked section keeps
# its lock), so two first-appends cannot each build a tape and rename over
# the other's first fact.
#
# Serialization argument (the flock question, stated per phase D's ask): the
# mkdir mutex (ralph_ledger_lock) STAYS for read-decide-append sections — its
# job was never write atomicity but decision atomicity, and that is
# unchanged. The append itself takes NO lock: WAL + busy_timeout=2000
# serializes the writes themselves, and the seq race between two concurrent
# appenders settles at the PRIMARY KEY with the bounded retry below — the
# loser re-reads max(seq) and lands at the next slot, so both land, distinct
# seq (behavior-equivalent to the old O_APPEND serialization). It also
# CANNOT take the mutex: appends run inside sections that already hold it
# (watch-event's exit sweep), and the mkdir lock is not re-entrant — a second
# acquisition would deadlock, then break its own caller's lock at ~15s.
_ralph_ledger_sqlite_append() {
  local file="${1-}" line="${2-}" db sq uv seq ph proj q out line_sql attempt jl
  local f_ts f_ev f_agent f_unit f_reason f_pane had_lock
  # The sqlite rules — db path, phash, DDL, projection — live in
  # ledger-convert.sh (ONE definition, GH-1843). A stripped tree without the
  # converter cannot append: refusing is the only honest answer once there is
  # no JSONL sink to fall back on (nothing real appends from a stripped tree
  # — the cockpit copies ledger.sh for its path helpers alone).
  if ! command -v ralph_lc_db_path >/dev/null 2>&1; then
    echo "ralph_ledger_append: cannot append — ledger-convert.sh unavailable (stripped tree has no sqlite rules); the fact was NOT recorded" >&2
    return 1
  fi
  db=$(ralph_lc_db_path "$file") || return 1
  sq="${RALPH_SQLITE3_BIN:-sqlite3}"
  if ! command -v "$sq" >/dev/null 2>&1; then
    echo "ralph_ledger_append: cannot append — no sqlite3 ('$sq'); install it: brew install sqlite (macOS) / apt-get install sqlite3 (debian); the fact was NOT recorded" >&2
    return 1
  fi
  if [ ! -f "$db" ]; then
    had_lock="$_RALPH_LEDGER_LOCK_HELD"
    [ -n "$had_lock" ] || ralph_ledger_lock "$file"
    if [ ! -f "$db" ]; then # re-check inside the mutex
      if [ -s "$file" ]; then
        out=$(ralph_lc_convert "$file" 2>&1 >/dev/null) || {
          [ -n "$had_lock" ] || ralph_ledger_unlock "$file"
          echo "ralph_ledger_append: cannot adopt the legacy JSONL into a fresh $db (${out:0:120}) — the fact was NOT recorded; run ledger-convert.sh and retry" >&2
          return 1
        }
      else
        out=$(ralph_lc_init_db "$db" 2>&1) || {
          [ -n "$had_lock" ] || ralph_ledger_unlock "$file"
          echo "ralph_ledger_append: cannot create $db (${out:0:120}) — the fact was NOT recorded" >&2
          return 1
        }
      fi
    fi
    [ -n "$had_lock" ] || ralph_ledger_unlock "$file"
  fi
  # busy_timeout on EVERY invocation here, gate reads included: even WAL
  # reads can see transient SQLITE_BUSY (a peer mid-checkpoint or building
  # the -shm), and a gate read that refuses on BUSY is a lost fact — the one
  # outcome this function exists to rule out. The PRAGMA echoes its value, so
  # answers are parsed from the LAST output line.
  uv=$("$sq" "$db" 'PRAGMA busy_timeout=2000; PRAGMA user_version;' 2>/dev/null) || uv=""
  uv=${uv##*$'\n'}
  case "$uv" in
    0)
      # uv=0 is either a crash mid-create (the DDL is IF NOT EXISTS
      # throughout, so re-running init completes it) or — the racy reading —
      # a PEER's init in flight right now: the db file exists from the
      # moment sqlite opens it, so a second appender can arrive here before
      # the creator's uv=1 lands, and an unserialized init would then step
      # into the creator's DDL ("database is locked", raw on stderr, fact
      # lost — measured on CI's 8-way first-append race). Same remedy as
      # the creation path: enter the mutex, RE-READ inside it — the common
      # case finds uv=1 (the creator finished) and inits nothing.
      had_lock="$_RALPH_LEDGER_LOCK_HELD"
      [ -n "$had_lock" ] || ralph_ledger_lock "$file"
      uv=$("$sq" "$db" 'PRAGMA busy_timeout=2000; PRAGMA user_version;' 2>/dev/null) || uv=""
      uv=${uv##*$'\n'}
      if [ "$uv" = "0" ]; then
        out=$(ralph_lc_init_db "$db" 2>&1) || {
          [ -n "$had_lock" ] || ralph_ledger_unlock "$file"
          echo "ralph_ledger_append: cannot complete half-created $db (${out:0:120}) — the fact was NOT recorded" >&2
          return 1
        }
        uv=1
      fi
      [ -n "$had_lock" ] || ralph_ledger_unlock "$file"
      ;;
  esac
  case "$uv" in
    1) : ;;
    *)
      echo "ralph_ledger_append: refusing $db — user_version='${uv:-?}' (unreadable, or a schema newer than v1); the fact was NOT recorded" >&2
      return 1
      ;;
  esac
  # A dual-write-era tape can TRAIL its legacy JSONL (a sink insert skipped
  # at phase B and never healed): appending at max(seq)+1 would occupy the
  # seq the converter's backfill needs for the JSONL's own line there, and
  # INSERT OR IGNORE never overwrites — the heal would become permanently
  # impossible. So when the JSONL still has a line beyond the tape's max
  # seq, adopt it FIRST; a failed adoption refuses the append rather than
  # burning the seq. One successful convert per process is enough (after it,
  # any line still beyond max is a reject the converter already sidecarred),
  # so the probe is one sed read per append and the convert runs at most
  # once.
  if [ -s "$file" ] && ! printf '%s\n' "$_RALPH_LEDGER_BACKFILL_DONE" | grep -qFx -- "$file"; then
    seq=$("$sq" "$db" 'PRAGMA busy_timeout=2000; SELECT coalesce(max(seq), 0) FROM facts;' 2>/dev/null) || seq=""
    seq=${seq##*$'\n'}
    case "$seq" in
      '' | *[!0-9]*)
        # While a legacy JSONL exists, "is the tape trailing?" is the
        # question that decides whether this insert would burn a historical
        # line's seq — an unanswerable probe may not wave it through
        # (the inner re-read refuses on the same principle).
        echo "ralph_ledger_append: cannot probe $db against the legacy JSONL — the fact was NOT recorded" >&2
        return 1
        ;;
      *)
        if [ -n "$(sed -n "$((seq + 1))p" "$file" 2>/dev/null)" ]; then
          # The convert must not race a peer's append: an insert allocating
          # max(seq)+1 mid-backfill would burn a historical line's seq
          # after all. Serialize under the ledger mutex (re-entrancy-aware,
          # like the creation path) and RE-CHECK inside it — a peer that
          # held the mutex first has usually converted already, making this
          # a no-op. The peer's own insert cannot slip past the mutex
          # unserialized: every appender in a trailing-tape state lands in
          # this same branch before its insert (the pre-check above is run
          # by each fresh process), and one whose pre-check reads clean is
          # only reachable after a completed convert.
          had_lock="$_RALPH_LEDGER_LOCK_HELD"
          [ -n "$had_lock" ] || ralph_ledger_lock "$file"
          seq=$("$sq" "$db" 'PRAGMA busy_timeout=2000; SELECT coalesce(max(seq), 0) FROM facts;' 2>/dev/null) || seq=""
          seq=${seq##*$'\n'}
          case "$seq" in
            '' | *[!0-9]*)
              # The unlocked probe just proved the tape trailing; a re-read
              # that cannot answer may not wave the append through — the
              # insert would burn the very seq the backfill needs.
              [ -n "$had_lock" ] || ralph_ledger_unlock "$file"
              echo "ralph_ledger_append: cannot re-verify the trailing tape in $db — the fact was NOT recorded" >&2
              return 1
              ;;
            *)
              if [ -n "$(sed -n "$((seq + 1))p" "$file" 2>/dev/null)" ]; then
                if ! out=$(ralph_lc_convert "$file" 2>&1 >/dev/null); then
                  [ -n "$had_lock" ] || ralph_ledger_unlock "$file"
                  echo "ralph_ledger_append: the tape trails the legacy JSONL and the backfill failed (${out:0:120}) — the fact was NOT recorded (run ledger-convert.sh $file)" >&2
                  return 1
                fi
              fi
              ;;
          esac
          [ -n "$had_lock" ] || ralph_ledger_unlock "$file"
          _RALPH_LEDGER_BACKFILL_DONE="$_RALPH_LEDGER_BACKFILL_DONE
$file"
        fi
        ;;
    esac
  fi
  # Typed columns are best-effort (the converter's own rule: payload is the
  # guarantee, the projection is recomputable) — an empty projection stores
  # empty typed columns, never drops the fact.
  proj=$(ralph_lc_project_line "$line") || proj=""
  IFS=$'\037' read -r f_ts f_ev f_agent f_unit f_reason f_pane <<<"$proj"
  # SQL string literals: double every single quote — the one metacharacter in
  # a quoted sqlite literal. The projection already flattened control chars,
  # and the payload is single-line JSON by the append's own validation. The
  # phash is computed over the RAW line; only the SQL copy is escaped.
  q="'"
  f_ts=${f_ts//$q/$q$q}; f_ev=${f_ev//$q/$q$q}; f_agent=${f_agent//$q/$q$q}
  f_unit=${f_unit//$q/$q$q}; f_reason=${f_reason//$q/$q$q}; f_pane=${f_pane//$q/$q$q}
  line_sql=${line//$q/$q$q}
  # seq is allocated ATOMICALLY by the insert itself (SELECT max(seq)+1
  # inside the one INSERT statement, which holds the write lock for its
  # whole evaluation) — a read-then-insert retry loop provably starves under
  # contention (measured: 15 of 21 simultaneous appenders exhausted 5
  # retries), while here busy_timeout simply queues the writers. The
  # seq-salted phash cannot be known before the seq is, so the row lands
  # with a unique provisional phash and a follow-up UPDATE stamps the real
  # one; a crash between the two leaves the provisional value — the payload
  # (the guarantee) is already durable, and nothing derives history from an
  # appended row's phash (the converter's phash rule exists for JSONL
  # import idempotence, and a frozen JSONL never re-imports these rows).
  # While a frozen/legacy JSONL exists, its ENTIRE line range is reserved
  # for the converter — rejected lines included, whose repair "converts into
  # its own slot" by the converter's contract. Appends allocate above it, so
  # no new fact can ever occupy a line's seq. The count is one grep per
  # append and static (the JSONL never grows post-D); an uncountable file
  # refuses, per the probe rule above.
  jl=0
  if [ -s "$file" ]; then
    jl=$(grep -c '' <"$file" 2>/dev/null) || jl=""
    case "$jl" in
      '' | *[!0-9]*)
        echo "ralph_ledger_append: cannot count the legacy JSONL's reserved range — the fact was NOT recorded" >&2
        return 1
        ;;
    esac
  fi
  ph="provisional:$$:${RANDOM-0}${RANDOM-0}:$(date +%s 2>/dev/null || true)"
  # busy_timeout waits out ordinary write contention, but a peer converting
  # the db to WAL holds an EXCLUSIVE lock that can outlive it on a slow
  # machine — the insert then fails at PREPARE with "database is locked"
  # (measured on CI under an 8-way first-append race). A locked/busy failure
  # is retried a bounded few times; anything else refuses immediately.
  attempt=0
  while :; do
    if out=$("$sq" "$db" "PRAGMA busy_timeout=2000;
INSERT INTO facts(seq, ts, kind, agent, unit, reason, pane, payload, phash)
  SELECT max(coalesce(max(seq), 0), $jl) + 1, '$f_ts', '$f_ev', nullif('$f_agent',''),
         CAST(nullif('$f_unit','') AS INTEGER), nullif('$f_reason',''),
         nullif('$f_pane',''), '$line_sql', '$ph'
  FROM facts;
SELECT last_insert_rowid();" 2>&1); then
      break
    fi
    attempt=$((attempt + 1))
    case "$out" in
      *"database is locked"* | *"database table is locked"* | *"database is busy"*)
        if [ "$attempt" -lt 8 ]; then
          sleep 0.25
          continue
        fi
        ;;
    esac
    echo "ralph_ledger_append: sqlite insert failed on $db (${out:0:160}) — the fact was NOT recorded" >&2
    return 1
  done
  seq=${out##*$'\n'}
  case "$seq" in
    '' | *[!0-9]* | 0)
      echo "ralph_ledger_append: insert landed but $db returned no seq (${out:0:120}) — inspect with doctor-parity" >&2
      return 1
      ;;
  esac
  if out=$(ralph_lc_hash_line "$seq" "$line" 2>/dev/null); then
    "$sq" "$db" "PRAGMA busy_timeout=2000;
UPDATE facts SET phash='${out}' WHERE seq=$seq AND phash='$ph';" >/dev/null 2>&1 ||
      echo "ralph_ledger_append: fact $seq recorded, but its phash stays provisional (update failed)" >&2
  fi
  return 0
}

_RALPH_SESSION_KEY=""
# Ledgers whose backfill probe has completed, one path per line — keyed per
# FILE, never process-wide: watch-event and reconcile walk several ledgers in
# one shell, and a process-wide flag would let the first trailing tape's
# convert silence the second's.
_RALPH_LEDGER_BACKFILL_DONE=""
ralph_ledger_append() {
  local raw="${1-}" file line
  file=$(ralph_ledger_path) || return 1
  [ -n "$_RALPH_SESSION_KEY" ] || _RALPH_SESSION_KEY=$(ralph_session_key)
  line=$(jq -ec --arg s "$_RALPH_SESSION_KEY" \
    'if type == "object" and (.session // "") == "" then .session = $s else . end' <<<"$raw" 2>/dev/null) || {
    echo "ralph_ledger_append: not valid JSON: ${raw:0:120}" >&2
    return 1
  }
  case "$line" in
    *$'\n'*)
      echo "ralph_ledger_append: one JSON object per call (got multiple documents)" >&2
      return 1
      ;;
  esac
  _ralph_ledger_sqlite_append "$file" "$line"
}

# ── read-decide-append serialization ─────────────────────────────────────────
# Plain appends are atomic on their own; what is NOT atomic is reading the
# ledger, deciding, and appending on the strength of that read. The herdr
# server runs event hooks concurrently (pane.exited and pane.closed both fire
# for one pane death), so two watch-event.sh processes provably overlap and
# would double-append exits/discovers and double-notify. Writers wrap those
# sections in this per-ledger-directory mutex (mkdir — atomic on POSIX,
# bash 3.2 safe; no flock on stock macOS). Pure readers never take it.
#
# A holder that dies mid-section leaves the lock behind; waiters break a lock
# after ~15s (sections are tens of ms — anything older is a corpse) and log
# loudly. _RALPH_LEDGER_LOCK_HELD tracks the one held lock so the executable
# scripts can `trap ralph_ledger_unlock_held EXIT` as insurance.

_RALPH_LEDGER_LOCK_HELD=""

# ralph_ledger_lock FILE — acquire the mutex for FILE's directory. Blocks;
# always returns 0 (a broken stale lock is taken over, not an error).
ralph_ledger_lock() {
  local file="${1-}" lock waited=0
  [ -n "$file" ] || return 0
  lock="$(dirname "$file")/.ledger.lock"
  mkdir -p "$(dirname "$lock")" 2>/dev/null || true
  while ! mkdir "$lock" 2>/dev/null; do
    waited=$((waited + 1))
    if [ "$waited" -gt 150 ]; then
      echo "ralph_ledger_lock: breaking stale lock $lock (held > ~15s — a hook died mid-section)" >&2
      rm -rf "$lock" 2>/dev/null || true
      waited=0
      continue
    fi
    sleep 0.1
  done
  _RALPH_LEDGER_LOCK_HELD="$lock"
  return 0
}

# ralph_ledger_unlock FILE — release FILE's directory mutex.
ralph_ledger_unlock() {
  local file="${1-}"
  [ -n "$file" ] || return 0
  rmdir "$(dirname "$file")/.ledger.lock" 2>/dev/null || true
  _RALPH_LEDGER_LOCK_HELD=""
  return 0
}

# ralph_ledger_unlock_held — EXIT-trap insurance: release whatever lock this
# process still holds (set -e can leave a section early).
ralph_ledger_unlock_held() {
  if [ -n "$_RALPH_LEDGER_LOCK_HELD" ]; then
    rmdir "$_RALPH_LEDGER_LOCK_HELD" 2>/dev/null || true
    _RALPH_LEDGER_LOCK_HELD=""
  fi
  return 0
}

# ── the read path (flipped in GH-2309 phase C; truth since GH-2311 phase D) ──
# Every read helper below consumes the ledger through _ralph_ledger_events.
# Since phase D the rule is: a PRESENT ledger.sqlite is served, full stop —
# the JSONL beside it is a frozen export-only projection, and serving it
# would serve stale facts. An unreadable present tape is an ERROR (stamped
# for doctor + one stderr line, empty output, rc 1), never a reason to read
# the frozen JSONL. Only a machine with NO sqlite at all still reads the
# legacy JSONL — that path works until ralph 1.0.0 and prints ONE stderr
# deprecation line per process naming ledger-convert.sh (courtesy, the hooks
# rule: never enforcement; exit codes unchanged).
#
# Serving payload verbatim through the same jq reductions is what keeps the
# two paths byte/shape-compatible BY CONSTRUCTION — the helpers feed jq
# across ~20 scripts, so compatibility is not a property to approximate per
# helper. Phase C's tail parity probe is GONE: it asked whether the sqlite
# had caught up to the JSONL, a question with no meaning now that the sqlite
# is where appends land and the JSONL never grows.

# _ralph_ledger_fallback_stamp FILE WHY — overwrite FILE's sibling
# ledger-fallback.last with {ts, why}. Best-effort and silent: the stamp is
# observability (doctor-parity renders it), and a stamp failure may not fail
# a read for a second reason. Since phase D it records read ERRORS on a
# present tape (there is no fallback to record); the filename stays, because
# doctor already reads it and a rename would orphan the trail.
_ralph_ledger_fallback_stamp() {
  local file="${1-}" why="${2-}"
  [ -n "$file" ] || return 0
  printf '{"ts":"%s","why":"%s"}\n' "$(date -u +%FT%TZ)" "$why" \
    >"$(dirname "$file")/ledger-fallback.last" 2>/dev/null || true
  return 0
}

# _ralph_ledger_db_path FILE — the sibling tape path. Extension swap when the
# converter is stripped from the tree, mirroring ralph_lc_db_path (the
# GH-2310 shape: the rule is trivial enough that a stripped tree may not lose
# its reads over it).
_ralph_ledger_db_path() {
  if command -v ralph_lc_db_path >/dev/null 2>&1; then
    ralph_lc_db_path "${1-}"
  else
    case "${1-}" in
      *.jsonl) printf '%s.sqlite\n' "${1%.jsonl}" ;;
      *) printf '%s.sqlite\n' "${1-}" ;;
    esac
  fi
}

_RALPH_LEDGER_DEPR_WARNED=""
# _ralph_ledger_present FILE — is there a ledger at FILE's scope: a sqlite
# tape in any state, or a non-empty legacy/frozen JSONL. The read helpers
# gate on this rather than `-s FILE` — post phase D a fresh machine has ONLY
# ledger.sqlite, and "the locator file is missing" must not read as "the
# ledger is empty".
#
# The legacy-read deprecation line is printed HERE, not in
# _ralph_ledger_events: the events reader runs inside a pipeline (a subshell,
# where the once-per-process guard variable cannot persist), while this probe
# runs in each helper's own shell — so one process's helpers warn once, per
# the courtesy's contract, instead of once per pipeline.
_ralph_ledger_present() {
  local file="${1-}" db
  db=$(_ralph_ledger_db_path "$file") || db=""
  if [ -n "$db" ] && [ -f "$db" ]; then
    return 0
  fi
  [ -s "$file" ] || return 1
  if [ -z "$_RALPH_LEDGER_DEPR_WARNED" ]; then
    _RALPH_LEDGER_DEPR_WARNED=1
    echo "ralph ledger: JSONL-only read (deprecated — the tape is SQLite since phase D; legacy reads end at ralph 1.0.0): convert with ledger-convert.sh $file" >&2
  fi
  return 0
}
# _ralph_ledger_events FILE — the ledger's event lines on stdout: payload
# rows from a present tape (seq order — the converter's byte-identity
# guarantee), else the legacy JSONL verbatim. The sqlite read is CAPTURED
# before a byte is emitted, so a failed read emits nothing rather than a torn
# prefix; WAL readers don't block on writers, so no busy_timeout.
_ralph_ledger_events() {
  local file="${1-}" db sq uv out
  db=$(_ralph_ledger_db_path "$file") || db=""
  if [ -n "$db" ] && [ -f "$db" ]; then
    sq="${RALPH_SQLITE3_BIN:-sqlite3}"
    if ! command -v "$sq" >/dev/null 2>&1; then
      _ralph_ledger_fallback_stamp "$file" "read error: no sqlite3 ('$sq') for a present $db"
      echo "ralph ledger: cannot read present $db — no sqlite3 ('$sq'); NOT serving the frozen JSONL" >&2
      return 1
    fi
    uv=$("$sq" "$db" 'PRAGMA user_version;' 2>/dev/null) || uv=""
    case "$uv" in
      0 | 1) : ;;
      *)
        _ralph_ledger_fallback_stamp "$file" "read error: user_version='${uv:-unreadable}' on present $db"
        echo "ralph ledger: refusing present $db — user_version='${uv:-unreadable}' (unreadable, or a schema newer than v1); NOT serving the frozen JSONL" >&2
        return 1
        ;;
    esac
    if out=$("$sq" "$db" 'SELECT payload FROM facts ORDER BY seq;' 2>/dev/null); then
      printf '%s\n' "$out"
      return 0
    fi
    _ralph_ledger_fallback_stamp "$file" "read error: sqlite read failed on present $db"
    echo "ralph ledger: cannot read present $db — NOT serving the frozen JSONL; see doctor-parity" >&2
    return 1
  fi
  # No tape at all: the legacy JSONL path, deprecated since phase D (the
  # one-line courtesy is printed by _ralph_ledger_present, which runs in the
  # caller's own shell — this function runs inside pipelines).
  if [ -f "$file" ]; then
    cat "$file"
    return 0
  fi
  return 0
}

# ralph_ledger_enum — every ledger under the root, one LOCATOR per line (the
# jsonl-form path, whether or not that file exists — post phase D a fresh
# machine has only ledger.sqlite, and the locator is the identity every
# consumer already passes around as RALPH_HERDR_LEDGER). Deliberately does
# NOT honor a pre-set $RALPH_HERDR_LEDGER: the fleet-wide walkers
# (watch-event, reconcile) export it per iteration, and honoring a leftover
# value would silently shrink their world to one ledger.
ralph_ledger_enum() {
  local f loc
  for f in "${RALPH_HERDR_LEDGER_ROOT:-$HOME/.ralph}"/*/*/ledger.jsonl \
    "${RALPH_HERDR_LEDGER_ROOT:-$HOME/.ralph}"/*/*/ledger.sqlite; do
    [ -f "$f" ] || continue
    loc="${f%.sqlite}"
    loc="${loc%.jsonl}"
    printf '%s.jsonl\n' "$loc"
  done | sort -u
  return 0
}

# ralph_ledger_reason_canon REASON — the ONE legacy-alias mapping for the
# exit-reason enum (see the header): historical spellings normalize to their
# enum value, everything else passes through verbatim. Historical rows are
# never rewritten — consumers that branch on reason call this instead.
ralph_ledger_reason_canon() {
  case "${1-}" in
    lost) printf 'swept-unknown\n' ;;
    pane_exited) printf 'pane-exited\n' ;;
    pane_closed) printf 'pane-closed\n' ;;
    restart_killed) printf 'restart-killed\n' ;;
    *) printf '%s\n' "${1-}" ;;
  esac
}

# ralph_ledger_open_agents [REPO_ROOT] — agent_refs (one per line) with a
# spawn/discover event and no later exit. Order-aware reduce: an exit closes
# the ref; a fresh spawn/discover of the SAME ref (shouldn't happen — epochs
# are per-spawn) would legitimately re-open it. Missing/empty ledger: rc 0,
# no output.
# shellcheck disable=SC2120  # REPO_ROOT is for callers outside the watcher (lib.sh)
ralph_ledger_open_agents() {
  local file
  file=$(ralph_ledger_path "$@") || return 1
  _ralph_ledger_present "$file" || return 0
  _ralph_ledger_events "$file" | jq -rs '
    reduce .[] as $e ({};
      if ($e.agent_ref // "") == "" then .
      elif $e.ev == "spawn" or $e.ev == "discover" then .[$e.agent_ref] = true
      elif $e.ev == "exit" then .[$e.agent_ref] = false
      else . end)
    | to_entries[] | select(.value) | .key'
}

# ralph_ledger_open_ref NAME [REPO_ROOT] — the open agent_ref whose name part
# is NAME, or nothing. This is the bridge for the callers that only have a
# name: herdr knows names, the ledger keys on refs, and the join between them
# has to happen somewhere. Doing it HERE means it happens once, against the
# open set — a recycled name's dead generations are already closed, so they
# cannot answer. A caller that instead matched `split("#")[0]` against every
# record would match them (GH-1776), which is the ABA _ralph_ledger_latest
# describes.
#
# Should a name ever have two open refs — it should not; a spawn of a live
# name loses the agent-name mutex — the LAST is served: the newest generation
# is the live one, and the older is a missing exit record, not a live worker.
# shellcheck disable=SC2120  # REPO_ROOT is optional, as in the helpers above
ralph_ledger_open_ref() {
  local name="${1-}" ref out=""
  [ -n "$name" ] || return 0
  shift
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    [ "${ref%%#*}" = "$name" ] || continue
    out="$ref"
  done <<EOF
$(ralph_ledger_open_agents "$@" 2>/dev/null || true)
EOF
  [ -n "$out" ] || return 0
  printf '%s\n' "$out"
}

# ralph_ledger_last AGENT_REF — the most recent record for a ref, compact
# JSON. rc 1 (silently) when the ref has no records.
ralph_ledger_last() {
  local ref="${1-}" file out
  [ -n "$ref" ] || return 1
  file=$(ralph_ledger_path) || return 1
  _ralph_ledger_present "$file" || return 1
  out=$(_ralph_ledger_events "$file" | jq -c --arg ref "$ref" -s 'map(select(.agent_ref == $ref)) | last // empty')
  [ -n "$out" ] || return 1
  printf '%s\n' "$out"
}

# ── watcher plumbing over the same reductions ────────────────────────────────
# pane.exited/closed payloads carry ONLY a pane_id (no agent name), and the
# orphan pass needs parent edges — both resolved from the ledger itself, never
# from herdr state. pane_id is a correlation key for LIVE records only; the
# durable key stays agent_ref.

# ralph_ledger_open_for_pane PANE_ID — open agent_refs whose most recent
# pane-bearing record binds PANE_ID.
ralph_ledger_open_for_pane() {
  local pane="${1-}" file
  [ -n "$pane" ] || return 1
  file=$(ralph_ledger_path) || return 1
  _ralph_ledger_present "$file" || return 0
  _ralph_ledger_events "$file" | jq -rs --arg p "$pane" '
    reduce .[] as $e ({open: {}, pane: {}};
      if ($e.agent_ref // "") == "" then .
      else
        (if $e.ev == "spawn" or $e.ev == "discover" then .open[$e.agent_ref] = true
         elif $e.ev == "exit" then .open[$e.agent_ref] = false
         else . end)
        | (((try ($e.pane_id // $e.lineage.herdr.pane_id) catch null) // "") as $pp
           | if $pp == "" then . else .pane[$e.agent_ref] = $pp end)
      end)
    | .pane as $pn
    | .open | to_entries[] | select(.value and ($pn[.key] == $p)) | .key'
}

# _ralph_ledger_latest FIELD_EXPR REF — last non-empty value of a per-record
# jq expression over REF's records, matched on the EXACT ref (name#epoch).
# Deterministic names make respawn-after-crash recycle a NAME as the norm,
# so a bare-name match would leak the previous epoch's values across the
# recycle (a new root inheriting the dead epoch's parent edge — the ABA that
# feeds wrong adoptions and depth-guard misfires). Every producer writes full
# refs; a record that somehow carries a bare name is simply never "latest".
_ralph_ledger_latest() {
  local expr="${1-}" ref="${2-}" file out
  [ -n "$ref" ] || return 1
  file=$(ralph_ledger_path) || return 1
  _ralph_ledger_present "$file" || return 1
  out=$(_ralph_ledger_events "$file" | jq -r --arg ref "$ref" -s "
    [ .[]
      | select(.agent_ref == \$ref)
      | $expr ]
    | map(select(. != null and . != \"\")) | last // empty")
  [ -n "$out" ] || return 1
  printf '%s\n' "$out"
}

# ralph_ledger_open_rows [REPO_ROOT] — the open set AND every open ref's latest
# fields, in ONE pass over the file. One line per open ref, fields separated by
# US (0x1f), in this order:
#
#   ref  pane  shell_pid  harness  parent  state  issue  checkout  tokens  session
#
# `session` is the ONLY column that is not "last non-empty wins": it is read
# from the spawn/discover record alone, for the same reason
# ralph_ledger_open_sessions does (a later exit written by whichever server
# observed the death must not hand that server the record). It is the
# per-record half of reconcile's ownership proof (GH-1944) — the ledger-wide
# `ralph_ledger_open_sessions` answers "did this server write ANY open record
# here", which is a different and much wider question.
#
# Read it with `IFS=$'\037' read -r ...`. The separator is US and not a tab
# because tab is IFS *whitespace*: bash collapses runs of it and strips it from
# the ends, so two adjacent empty columns would silently become one and every
# field after them would shift. US is not whitespace, so an empty column stays
# an empty column — and empty is the common case here (a discover record has no
# shell_pid, a root has no parent).
#
# The open set is the same order-aware reduce as ralph_ledger_open_agents, and
# each field is the same "last non-empty value for this EXACT ref" rule as
# _ralph_ledger_latest. Those helpers stay: they are the right shape for a
# caller asking about one ref (lib.sh's depth guard, the watcher tests). This
# is the shape for a caller that walks every open ref and wants several fields
# from each — which is every phase of reconcile.
#
# Why (GH-1775): _ralph_ledger_latest re-slurps the WHOLE ledger per (ref,
# field), so a reconcile pass cost O(open refs x ledger size) across ~6 forks
# per worker — phase E alone reads pane, shell_pid and harness for the verdict,
# then issue, checkout and pane again to recover the claim. Emitting rows lets
# the loops read fields straight off the line, so a pass is O(ledger size) and
# one fork per ledger, and the ledger's size stops being a per-worker cost.
#
# No column can forge a separator: `tokens` is jq's own `tojson`, which escapes
# a control character rather than emitting it, and every other column is a
# grammar-constrained identifier, path or number. The explicit gsub is the belt
# — a stray separator or newline degrades one field to a space, it never shifts
# a column. Joined manually rather than with `@tsv`, which also escapes
# BACKSLASH: the tokens column is JSON, so `@tsv` would double every escape in
# it and hand the caller back something that no longer parses.
#
# Missing/empty ledger: rc 0, no output.
# shellcheck disable=SC2120  # REPO_ROOT is optional, as in the helpers above
ralph_ledger_open_rows() {
  local file
  file=$(ralph_ledger_path "$@") || return 1
  _ralph_ledger_present "$file" || return 0
  _ralph_ledger_events "$file" | jq -rs '
    def keep($cur; $new): if ($new == null or $new == "") then $cur else $new end;
    def col: (. // "") | tostring | gsub("[\u001f\t\r\n]"; " ");
    reduce .[] as $e ({open: {}, f: {}, s: {}};
      (($e.agent_ref // "")) as $ref
      | if $ref == "" then .
        else
          (if $e.ev == "spawn" or $e.ev == "discover" then
             .open[$ref] = true | .s[$ref] = (($e.session // "") | tostring)
           elif $e.ev == "exit" then .open[$ref] = false
           else . end)
          | (.f[$ref] // {}) as $c
          | .f[$ref] = {
              pane:      keep($c.pane;      ((try ($e.pane_id // $e.lineage.herdr.pane_id) catch null) // "")),
              shell_pid: keep($c.shell_pid; (($e.shell_pid // "") | tostring)),
              harness:   keep($c.harness;   ((try $e.tokens.harness catch null) // "")),
              parent:    keep($c.parent;    (if $e.ev == "adopt" then ($e.parent // "") else ((try $e.tokens.parent catch null) // "") end)),
              state:     keep($c.state;     (if $e.ev == "state" then ($e.state // "") else ((try $e.tokens.state catch null) // "") end)),
              issue:     keep($c.issue;     (((try $e.tokens.issue catch null) // "") | tostring)),
              checkout:  keep($c.checkout;  (($e.checkout // "") | tostring)),
              tokens:    keep($c.tokens;    ((try $e.tokens catch null) | if . == null then "" else tojson end))
            }
        end)
    | .f as $f
    | .s as $s
    | .open
    | to_entries[]
    | select(.value)
    | .key as $ref
    | ($f[$ref] // {}) as $v
    | [$ref, ($v.pane|col), ($v.shell_pid|col), ($v.harness|col),
       ($v.parent|col), ($v.state|col), ($v.issue|col), ($v.checkout|col),
       ($v.tokens|col), (($s[$ref] // "")|col)]
    | join("\u001f")'
}

# ralph_ledger_open_sessions [REPO_ROOT] — the distinct session keys that
# OPENED the still-open records (one per line, empty keys omitted). Ownership
# evidence for reconcile (GH-1933): a pane proves a ledger ours only while it
# lives, so a fully-retired fleet became permanently unsweepable; the writer's
# key survives the last pane closing.
#
# Read from the spawn/discover record only, never kept-latest across the ref's
# whole history: a later event appended by a DIFFERENT server (an exit written
# by whichever pass observed the death) would otherwise hand that server
# ownership of a record it did not open. Missing/empty ledger: rc 0, no output.
# shellcheck disable=SC2120  # REPO_ROOT is optional, as in the helpers above
ralph_ledger_open_sessions() {
  local file
  file=$(ralph_ledger_path "$@") || return 1
  _ralph_ledger_present "$file" || return 0
  _ralph_ledger_events "$file" | jq -rs '
    reduce .[] as $e ({open: {}, s: {}};
      (($e.agent_ref // "")) as $ref
      | if $ref == "" then .
        elif $e.ev == "spawn" or $e.ev == "discover" then
          .open[$ref] = true | .s[$ref] = (($e.session // "") | tostring)
        elif $e.ev == "exit" then .open[$ref] = false
        else . end)
    | .s as $s
    | [.open | to_entries[] | select(.value) | ($s[.key] // "")]
    | map(select(. != "")) | unique | .[]'
}

# Latest parent edge for a ref (adopt events win over the spawn/discover
# token), latest bound pane, latest lifecycle state, latest token map.
_ralph_ledger_latest_parent() {
  _ralph_ledger_latest '(if .ev == "adopt" then (.parent // "") else ((try .tokens.parent catch null) // "") end)' "$@"
}
_ralph_ledger_latest_pane() {
  _ralph_ledger_latest '((try (.pane_id // .lineage.herdr.pane_id) catch null) // "")' "$@"
}
_ralph_ledger_latest_state() {
  _ralph_ledger_latest '(if .ev == "state" then (.state // "") else ((try .tokens.state catch null) // "") end)' "$@"
}
_ralph_ledger_latest_tokens() {
  _ralph_ledger_latest '((try .tokens catch null) | if . == null then "" else tojson end)' "$@"
}
# The FLEET role (GH-1808): stated by the spawner on the spawn record, or
# lane-defaulted by reconcile on a discover record. Read here rather than off
# a pane token because the token is display chrome a launcher may never have
# pushed (killed between `agent start` and the push), while the provisional
# row already carries it — and fork.sh (GH-2359) decides on this whether a
# source may be resumed uncontained. Empty means the record predates the
# role model; never "driver".
_ralph_ledger_latest_role() {
  _ralph_ledger_latest '((try .tokens.role catch null) // "")' "$@"
}
# The herd address (GH-2210): stamped by the spawner as tokens.address on the
# spawn record (GH-2209/D0.4). Last-non-empty like its siblings, so state
# events that carry no tokens never blank it; empty means the record predates
# the grammar (or an over-budget address was dropped at the push site).
_ralph_ledger_latest_address() {
  _ralph_ledger_latest '((try .tokens.address catch null) // "")' "$@"
}
# GH-1809's three: the pane's shell pid at spawn (a rebuilt pane's differs),
# the worktree path (board scope without needing the pane back), and the issue
# whose claim this worker holds. All optional for historical compatibility.
# Discover records have no shell pid; reconciliation discoveries now retain
# their proven checkout, while records written before that addition do not.
_ralph_ledger_latest_shell_pid() {
  _ralph_ledger_latest '((.shell_pid // "") | tostring)' "$@"
}
_ralph_ledger_latest_checkout() {
  _ralph_ledger_latest '((.checkout // "") | tostring)' "$@"
}
_ralph_ledger_latest_issue() {
  _ralph_ledger_latest '(((try .tokens.issue catch null) // "") | tostring)' "$@"
}
# GH-2267 — what the spawn ACHIEVED for each containment mechanism, read
# from wherever the producer put it (the spawn record, or the `containment`
# event that follows a provisional row). Two readers on purpose: one helper
# returning both would be the single-field collapse the design record
# refuses, one level up. Empty means the record predates GH-2267 or the
# outcome was never recorded — never "off" (that is `not_requested`).
_ralph_ledger_latest_tool_binding() {
  _ralph_ledger_latest '((.tool_binding // "") | tostring)' "$@"
}
_ralph_ledger_latest_process_containment() {
  _ralph_ledger_latest '((.process_containment // "") | tostring)' "$@"
}

# ralph_ledger_children REF — open agent_refs whose latest parent edge points
# at REF, matched as the EXACT ref.
#
# The bare-name arm this used to carry (GH-1776) admitted that a child whose
# parent edge names a DEAD generation of REF's name is REF's child. It is not:
# names recycle on respawn, so that child belongs to the previous session and
# the live agent inherits it. Every consequence of the mis-join is a write —
# orphan_pass re-parents the child to this ref's grandparent, or marks it
# orphaned and notifies — so the leniency did not degrade a diagnostic, it
# corrupted the tree. Every producer writes a full ref (the token vocabulary's
# `parent` is `name#epoch`, and ralph_depth_guard has always resolved it
# exact-only through _ralph_ledger_latest), so nothing legitimate is lost.
ralph_ledger_children() {
  local ref="${1-}" file
  [ -n "$ref" ] || return 1
  file=$(ralph_ledger_path) || return 1
  _ralph_ledger_present "$file" || return 0
  _ralph_ledger_events "$file" | jq -rs --arg ref "$ref" '
    reduce .[] as $e ({open: {}, par: {}};
      if ($e.agent_ref // "") == "" then .
      else
        (if $e.ev == "spawn" or $e.ev == "discover" then .open[$e.agent_ref] = true
         elif $e.ev == "exit" then .open[$e.agent_ref] = false
         else . end)
        | ((if $e.ev == "adopt" then ($e.parent // "") else ((try $e.tokens.parent catch null) // "") end) as $p
           | if $p == "" then . else .par[$e.agent_ref] = $p end)
      end)
    | .par as $par
    | .open | to_entries[]
    | select(.value)
    | select(($par[.key] // "") == $ref)
    | .key'
}

# ralph_ledger_orphan_pass DEAD_REF LIVE_NAMES [ONLY_REFS] — the adoption
# policy, run when DEAD_REF is gone (pane exited/closed, or exit reason=lost at
# reconcile). LIVE_NAMES is a space-separated list of currently live herdr agent
# names. ONLY_REFS, when non-empty, restricts the pass to those child refs.
#
# For each open child of DEAD_REF:
#   grandparent live AND ledger-open  → append adopt (child re-parents to the
#                                       grandparent) + update the child's
#                                       parent token
#   otherwise                         → append state=orphaned + state token +
#                                       ONE notification (skipped when the
#                                       child is already marked orphaned)
#
# Cascade reap is deliberately NOT here — that is Phase-3 fleet-controller
# behavior. This pass only records reality and routes attention. Lives in
# ledger.sh (not watch-event.sh) because reconcile.sh runs the identical pass;
# token pushes go through ralph_tokens_push when tokens.sh is sourced, and are
# skipped (decoration, never load-bearing) when it isn't.
ralph_ledger_orphan_pass() {
  local dead="${1-}" live="${2-}" only="${3-}"
  local herdr children child gp gp_name gp_ok pane ts state
  [ -n "$dead" ] || return 0
  children=$(ralph_ledger_children "$dead") || children=""
  [ -n "$children" ] || return 0
  herdr="${HERDR_BIN_PATH:-herdr}"
  gp=$(_ralph_ledger_latest_parent "$dead") || gp=""
  gp_name="${gp%%#*}"
  gp_ok=""
  if [ -n "$gp" ]; then
    case " $live " in
      *" $gp_name "*)
        # Ledger-open check is on the EXACT gp ref: liveness is name-level
        # (herdr knows names, not epochs), but adopting to a ref whose epoch
        # already exited would hand the child to a recycled name's ghost.
        if ralph_ledger_open_agents | grep -qFx "$gp"; then
          gp_ok=1
        fi
        ;;
    esac
  fi
  ts=$(date -u +%FT%TZ)
  for child in $children; do
    # ONLY, when given, is the set of child refs the caller is entitled to
    # write (GH-1944). A dead parent's children can include another server's
    # records — one ledger per repository is shared by every server working it
    # — and re-parenting or orphan-marking those is exactly the cross-session
    # write this filter exists to refuse. Empty ONLY means "no filter", which
    # is watch-event.sh: it acts on a pane death this server observed.
    if [ -n "$only" ]; then
      case " $only " in
        *" $child "*) : ;;
        *) continue ;;
      esac
    fi
    pane=$(_ralph_ledger_latest_pane "$child") || pane=""
    if [ -n "$gp_ok" ]; then
      ralph_ledger_append "$(jq -nc --arg ts "$ts" --arg c "$child" --arg gp "$gp" --arg prev "$dead" \
        '{ts: $ts, ev: "adopt", agent_ref: $c, parent: $gp, prev_parent: $prev}')" || continue
      if [ -n "$pane" ] && command -v ralph_tokens_push >/dev/null 2>&1; then
        ralph_tokens_push "$pane" "parent=$gp"
      fi
    else
      state=$(_ralph_ledger_latest_state "$child") || state=""
      if [ "$state" = "orphaned" ]; then
        continue
      fi
      ralph_ledger_append "$(jq -nc --arg ts "$ts" --arg c "$child" --arg prev "$dead" \
        '{ts: $ts, ev: "state", agent_ref: $c, state: "orphaned", via: "orphan", prev_parent: $prev}')" || continue
      if [ -n "$pane" ] && command -v ralph_tokens_push >/dev/null 2>&1; then
        ralph_tokens_push "$pane" "state=orphaned"
      fi
      "$herdr" notification show "${child%%#*} orphaned" \
        --body "parent ${dead%%#*} gone, no live grandparent — board claim still stands; attend or hand off" \
        >/dev/null 2>&1 || true
    fi
  done
  return 0
}

# ── usage facts (GH-2347) ────────────────────────────────────────────────────
# What a worker CONSUMED, on the tape beside what it did. The ledger recorded
# spawn/exit/discover and nothing about cost; per-unit cost had to be rebuilt
# offline from the transcripts, joined by worktree path — a join a fork pane
# (same worktree, new session) or a reused worktree breaks. Two additions:
#
#   claude_session   a top-level field on the records that KNOW it — the
#                    state event (watch-event confirms the agent against a
#                    snapshot that carries agent_session) and the discover
#                    record (reconcile reads the same snapshot). The spawn
#                    record cannot carry it: it is written at pane creation,
#                    before any harness has started a conversation. Read
#                    last-non-empty like every other field
#                    (_ralph_ledger_latest_claude_session), so the first
#                    confirmed event after spawn binds it and nothing later
#                    can blank it.
#   usage            {ts, ev: "usage", agent_ref, claude_session, via,
#                     usage: {...}} — the transcript's per-message usage
#                    blocks reduced to one object (see
#                    ralph_usage_from_transcript). Written at exit by every
#                    exit writer that had a worker to measure, and at each
#                    `done` turn boundary as the live heartbeat. Neutral to
#                    the open-set reduce like `containment`: it never opens
#                    or closes a row. Latest wins per ref — each fact is the
#                    whole transcript re-read, never a delta, so a reader
#                    takes the last one and sums nothing.
#
# The transcript is the ONE source: the harness writes
# $CLAUDE_CONFIG_DIR/projects/<slug(cwd)>/<session-id>.jsonl, one row per
# streamed message chunk, each carrying the message's full `usage`. Rows are
# deduped by message.id (a streamed message lands as several rows whose
# input-side counts agree and whose output count grows), taking the max per
# field. Cost is a LIST-PRICE EQUIVALENT under the 1-hour cache TTL Claude Code
# uses — rate-limit weight, never a bill (a subscription pays nothing per
# token) — and the price table is stamped on the fact (`price_table`) so a
# later reader knows which rates priced it. A model with no row prices as 0
# and is counted in `unpriced_calls`, never silently folded into a number
# that reads complete.

# _ralph_usage_transcript SESSION_ID [CHECKOUT] — the transcript path for a
# Claude session, or rc 1. The harness slugs the cwd with every char outside
# [A-Za-z0-9] → '-'; the derived path is tried first, then a glob over every
# project dir — a session id is a UUID, so the glob cannot collide, and it
# covers a checkout the ledger recorded differently from the pane's cwd.
_ralph_usage_transcript() {
  local sid="${1-}" checkout="${2-}" base slug f
  [ -n "$sid" ] || return 1
  case "$sid" in *[!A-Za-z0-9-]*) return 1 ;; esac
  base="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
  if [ -n "$checkout" ]; then
    slug=$(printf '%s' "$checkout" | LC_ALL=C tr -c 'A-Za-z0-9' '-')
    f="$base/$slug/$sid.jsonl"
    if [ -f "$f" ]; then
      printf '%s\n' "$f"
      return 0
    fi
  fi
  for f in "$base"/*/"$sid.jsonl"; do
    if [ -f "$f" ]; then
      printf '%s\n' "$f"
      return 0
    fi
  done
  return 1
}

# The list-price table, USD per million tokens, in the order
#   [input, cache_write_5m, cache_write_1h, cache_read, output]
# matched by model-id PREFIX (dated snapshots like claude-haiku-4-5-20251001
# share their family's row). Cache writes are 1.25× / 2× input; reads are
# 0.1× input except Fable 5.1's $0.25. Stamped on every fact as `price_table`
# — bump the stamp when a row changes.
RALPH_USAGE_PRICE_TABLE="2026-09-01"
_RALPH_USAGE_PRICES='{
  "claude-fable-5-1": [10, 12.5, 20, 0.25, 50],
  "claude-mythos-5-1": [10, 12.5, 20, 0.25, 50],
  "claude-fable-5":   [10, 12.5, 20, 1.0, 50],
  "claude-opus-5":    [5, 6.25, 10, 0.5, 25],
  "claude-opus-4-8":  [5, 6.25, 10, 0.5, 25],
  "claude-opus-4-7":  [5, 6.25, 10, 0.5, 25],
  "claude-opus-4-6":  [5, 6.25, 10, 0.5, 25],
  "claude-opus-4-5":  [5, 6.25, 10, 0.5, 25],
  "claude-sonnet-5":  [2, 2.5, 4, 0.2, 10],
  "claude-sonnet-4-6": [3, 3.75, 6, 0.3, 15],
  "claude-sonnet-4-5": [3, 3.75, 6, 0.3, 15],
  "claude-haiku-4-5": [1, 1.25, 2, 0.1, 5]
}'

# ralph_usage_from_transcript FILE — reduce one transcript to the usage
# object, compact JSON on stdout. rc 1 when the file is unreadable or holds
# no assistant message with a usage block (a session that never called the
# model has nothing to price). Torn or foreign lines are skipped, never
# fatal: the last line of a live transcript is routinely mid-write.
#
#   calls            distinct message ids
#   models           {model: calls}; model = the one with the most calls
#   input, cache_write_5m, cache_write_1h, cache_read, output, thinking
#   max_context      the largest single-call prompt (input + cache read +
#                    cache write) — what the advisory compares to
#                    RALPH_UNIT_CTX_MAX
#   list_usd         list-price equivalent, 4 dp; unpriced_calls counts the
#                    calls whose model has no price row
#   first_ts/last_ts the span of the calls
ralph_usage_from_transcript() {
  local file="${1-}"
  [ -n "$file" ] && [ -r "$file" ] || return 1
  jq -R -n -c --argjson prices "$_RALPH_USAGE_PRICES" '
    def num: if type == "number" then . else 0 end;
    def price($m):
      ($prices | to_entries | map(.key as $k | select($m | startswith($k))) | sort_by(-(.key | length)) | first | .value) // null;
    [inputs | (fromjson? // empty)
     | select(.type == "assistant" and (.message.usage | type) == "object" and (.message.id // "") != "")
     | {id: .message.id, ts: (.timestamp // ""), model: (.message.model // "unknown"),
        u: .message.usage}]
    | group_by(.id)
    | map({
        id: .[0].id, ts: ([.[].ts] | min), model: .[0].model,
        input: ([.[].u.input_tokens | num] | max),
        w5: ([.[].u.cache_creation.ephemeral_5m_input_tokens | num] | max),
        w1: ([.[].u.cache_creation.ephemeral_1h_input_tokens | num] | max),
        wtotal: ([.[].u.cache_creation_input_tokens | num] | max),
        read: ([.[].u.cache_read_input_tokens | num] | max),
        output: ([.[].u.output_tokens | num] | max),
        thinking: ([.[].u.output_tokens_details.thinking_tokens | num] | max)})
    # A pre-TTL-split usage block reports only the total; charge it at the 1h
    # rate (what Claude Code uses) rather than reading it as free.
    | map(if (.w5 + .w1) == 0 and .wtotal > 0 then .w1 = .wtotal else . end)
    | if length == 0 then halt_error(1) else . end
    | (map(.model) | group_by(.) | map({key: .[0], value: length}) | from_entries) as $models
    | {
        calls: length,
        model: ($models | to_entries | max_by(.value) | .key),
        models: $models,
        input: (map(.input) | add),
        cache_write_5m: (map(.w5) | add),
        cache_write_1h: (map(.w1) | add),
        cache_read: (map(.read) | add),
        output: (map(.output) | add),
        thinking: (map(.thinking) | add),
        max_context: (map(.input + .read + .w5 + .w1) | max),
        list_usd: ((map(price(.model) as $p
                     | if $p == null then 0
                       else (.input * $p[0] + .w5 * $p[1] + .w1 * $p[2] + .read * $p[3] + .output * $p[4]) / 1000000
                       end) | add) * 10000 | round / 10000),
        unpriced_calls: (map(select(price(.model) == null)) | length),
        first_ts: (map(.ts) | min),
        last_ts: (map(.ts) | max)
      }' "$file" 2>/dev/null
}

# _ralph_ledger_latest_claude_session REF — the worker's Claude session id,
# last-non-empty across the ref's records (state/discover carry it; the
# spawn record predates the conversation). Empty = never confirmed against
# a snapshot, or a record from before GH-2347.
_ralph_ledger_latest_claude_session() {
  _ralph_ledger_latest '((.claude_session // "") | tostring)' "$@"
}

# ralph_ledger_usage_append REF VIA — read REF's transcript and append one
# usage fact. Best-effort by contract: rc 0 with the fact recorded, rc 1
# (one stderr line) when the ref has no session on the tape, no transcript
# on disk, or no model calls — "could not measure" is a stderr line, never
# a fact saying zero. Callers that already hold the ledger mutex may call
# this inside the section: it appends only.
ralph_ledger_usage_append() {
  local ref="${1-}" via="${2:-event}" sid checkout file usage ts
  [ -n "$ref" ] || return 1
  sid=$(_ralph_ledger_latest_claude_session "$ref" 2>/dev/null) || sid=""
  if [ -z "$sid" ]; then
    echo "ledger usage: no claude_session recorded for $ref — nothing to measure (the record predates GH-2347, or no state event ever confirmed it)" >&2
    return 1
  fi
  checkout=$(_ralph_ledger_latest_checkout "$ref" 2>/dev/null) || checkout=""
  file=$(_ralph_usage_transcript "$sid" "$checkout") || {
    echo "ledger usage: no transcript for $ref (session $sid) under ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects — nothing to measure" >&2
    return 1
  }
  usage=$(ralph_usage_from_transcript "$file") || {
    echo "ledger usage: $file holds no model calls for $ref — nothing to price" >&2
    return 1
  }
  ts=$(date -u +%FT%TZ)
  ralph_ledger_append "$(jq -nc --arg ts "$ts" --arg ref "$ref" --arg sid "$sid" --arg via "$via" \
    --arg pt "$RALPH_USAGE_PRICE_TABLE" --argjson u "$usage" \
    '{ts: $ts, ev: "usage", agent_ref: $ref, claude_session: $sid, via: $via, price_table: $pt, usage: $u}')"
}
