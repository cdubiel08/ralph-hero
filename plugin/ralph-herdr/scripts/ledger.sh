#!/usr/bin/env bash
# ledger.sh — append-only events ledger for the ralph-herdr watcher. Sourced,
# never run (watch-event.sh and reconcile.sh pull it in; lib.sh's spawn path
# appends the spawn record through it).
#
# THE LEDGER
#   One JSONL file per board scope: ~/.ralph/<owner>/<repo>/ledger.jsonl —
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
#   ev vocabulary: spawn | state | adopt | exit | discover | lost ("lost" is
#   reserved; today a lost agent is recorded as ev=exit reason=lost).
#     spawn     appended by lib.sh's spawn path AT PANE CREATION — the one
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
#     exit      watcher: {reason: pane_exited|pane_closed|lost}.
#     discover  watcher/reconcile: a live ralph agent with no open ledger
#               record (spawned while the ledger didn't exist, or by hand).
#
#   Appends are single-line `>>` writes (O_APPEND) issued as ONE write(2):
#   the line goes through an EXTERNAL printf, whose fresh stdio buffer holds
#   a full 4KB line and flushes it in one call. bash's BUILTIN printf flushes
#   in ~1KB chunks on Darwin and provably tears concurrent appends over that
#   size — never "fix" the `env printf` below back to the builtin.
#   ralph_ledger_append REFUSES lines whose write (line + newline) would
#   reach 4096 bytes rather than risk a torn write. Readers are pure jq
#   reductions over the whole file, so duplicate events are tolerated by
#   construction; writers that must read-decide-append (the watcher hooks,
#   reconcile) serialize through ralph_ledger_lock/unlock — appends alone
#   need no lock.
#
#   DUAL WRITE (GH-2306, phase B): after the JSONL line lands, the same event
#   is inserted into the sibling ledger.sqlite (schema v1, GH-2305) when that
#   file exists. JSONL is the truth — a sqlite failure warns and never fails
#   an append, and any gap self-heals at the next ledger-convert.sh run.
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

# The sqlite sibling's rules — db path, phash, user_version, typed projection
# — have ONE definition, ledger-convert.sh (the GH-1843 shape); the dual-write
# sink below only calls them. Guarded twice: skipped when already defined (the
# converter executable sources ledger.sh back, and re-sourcing it here would
# loop), and skipped when the file is absent (a stripped tree — cockpit tests
# copy ledger.sh alone; the sink then no-ops via its own command -v probe).
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

# ralph_ledger_append JSON — validate and append ONE event as one line.
# Refuses: invalid JSON, anything that compacts to more than one line
# (multiple documents), and lines whose write (line + newline) would reach
# 4096 bytes (the atomic-append budget).
#
# The write MUST go through an external printf: a fresh process's stdio
# buffer holds the whole line and flushes it as ONE write(2) to the O_APPEND
# fd. bash's BUILTIN printf flushes in ~1KB chunks (measured on Darwin
# /bin/bash 3.2: 200 concurrent 4KB appends produced merged 7-10KB lines and
# sub-line remnants; the identical run through `env printf` produced zero
# tears), so the builtin would tear exactly the concurrent hook appends this
# budget exists to protect.
#
# Every record carries `.session`, the ralph_session_key of the server that
# wrote it (GH-1933). It is stamped HERE rather than at each of the ~dozen call
# sites so no appender can forget it, and it is what lets reconcile prove a
# ledger is its own after the last pane is gone: a pane proves ownership only
# while it lives, but the record outlives it. A caller that already supplied
# `.session` keeps it — replay and migration paths must be able to preserve the
# original writer.
# _ralph_ledger_sqlite_insert FILE LINE — the sqlite half of the dual write
# (GH-2306, phase B): mirror the line JUST appended to FILE into the sibling
# ledger.sqlite (schema v1, GH-2305). ALWAYS returns 0 — JSONL is the truth,
# and this sink may never block or fail a spawn/exit record: every failure
# (locked, corrupt, missing sqlite3, a newer schema, a lost race on seq)
# WARNS on stderr and proceeds. The cost of any skipped insert is a parity
# gap the next ledger-convert.sh run backfills (phash-keyed) — never data.
_ralph_ledger_sqlite_insert() {
  local file="${1-}" line="${2-}" db sq uv seq at ph proj q err
  local f_ts f_ev f_agent f_unit f_reason f_pane
  # A tree without ledger-convert.sh has no converter, so no sqlite ledger to
  # keep current — nothing to do (the guarded source above already skipped).
  command -v ralph_lc_db_path >/dev/null 2>&1 || return 0
  db=$(ralph_lc_db_path "$file") || return 0
  # Absent ledger.sqlite = a not-yet-converted machine: skip SILENTLY and do
  # NOT create the db — phase A's converter is the adoption path, and a
  # half-adopted machine must read as "not converted" in doctor, never as a
  # mystery partial db.
  [ -f "$db" ] || return 0
  sq="${RALPH_SQLITE3_BIN:-sqlite3}"
  if ! command -v "$sq" >/dev/null 2>&1; then
    echo "ralph_ledger_append: sqlite sink skipped — no sqlite3 ('$sq'); JSONL holds the record, ledger-convert.sh backfills" >&2
    return 0
  fi
  uv=$(ralph_lc_user_version "$db") || uv=""
  case "$uv" in
    0 | 1) : ;;
    *)
      echo "ralph_ledger_append: sqlite sink skipped — $db user_version='${uv:-?}' (unreadable, or a schema newer than v1); JSONL holds the record" >&2
      return 0
      ;;
  esac
  # seq must be the JSONL line number of the line just appended — it is the
  # salt in schema v1's phash — so a wrong seq is a row the converter will
  # disagree with FOREVER (INSERT OR IGNORE never overwrites). Appends alone
  # take no lock (this file's own rule), so a concurrent append can land
  # between our write and this count: read the counted line back, and on any
  # mismatch SKIP — a missing row self-heals at the next convert, a wrong row
  # is a permanent parity GAP. The file is append-only, so a pair verified
  # here is stable: line N never changes after it is read back.
  seq=$(grep -c '' <"$file" 2>/dev/null) || seq=""
  case "$seq" in
    '' | *[!0-9]* | 0)
      echo "ralph_ledger_append: sqlite sink skipped — cannot count $file; ledger-convert.sh backfills" >&2
      return 0
      ;;
  esac
  at=$(sed -n "${seq}p" "$file" 2>/dev/null) || at=""
  if [ "$at" != "$line" ]; then
    echo "ralph_ledger_append: sqlite sink skipped — a concurrent append moved the tail of $file; ledger-convert.sh backfills" >&2
    return 0
  fi
  ph=$(ralph_lc_hash_line "$seq" "$line") || {
    echo "ralph_ledger_append: sqlite sink skipped — no sha256 tool; ledger-convert.sh backfills" >&2
    return 0
  }
  proj=$(ralph_lc_project_line "$line") || proj=""
  if [ -z "$proj" ]; then
    echo "ralph_ledger_append: sqlite sink skipped — typed projection failed; ledger-convert.sh backfills" >&2
    return 0
  fi
  IFS=$'\037' read -r f_ts f_ev f_agent f_unit f_reason f_pane <<<"$proj"
  # SQL string literals: double every single quote — the one metacharacter in
  # a quoted sqlite literal. The projection already flattened control chars,
  # and the payload is single-line JSON by the append's own validation.
  q="'"
  f_ts=${f_ts//$q/$q$q}; f_ev=${f_ev//$q/$q$q}; f_agent=${f_agent//$q/$q$q}
  f_unit=${f_unit//$q/$q$q}; f_reason=${f_reason//$q/$q$q}; f_pane=${f_pane//$q/$q$q}
  line=${line//$q/$q$q}
  # INSERT OR IGNORE: a retry, or a line the converter already imported, is a
  # no-op — the converter's own idempotence rule. busy_timeout bounds a
  # writer collision on the WAL db at 2s; past it the warn below answers,
  # never a blocked append.
  err=$("$sq" "$db" "PRAGMA busy_timeout=2000;
INSERT OR IGNORE INTO facts(seq, ts, kind, agent, unit, reason, pane, payload, phash)
  VALUES ($seq, '$f_ts', '$f_ev', nullif('$f_agent',''),
          CAST(nullif('$f_unit','') AS INTEGER), nullif('$f_reason',''),
          nullif('$f_pane',''), '$line', '$ph');" 2>&1 >/dev/null) || {
    echo "ralph_ledger_append: sqlite sink failed on $db (${err:0:160}) — JSONL holds the record, ledger-convert.sh backfills" >&2
    return 0
  }
  return 0
}

_RALPH_SESSION_KEY=""
ralph_ledger_append() {
  local raw="${1-}" file line bytes
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
  bytes=$(printf '%s' "$line" | wc -c)
  if [ "$bytes" -ge 4095 ]; then
    echo "ralph_ledger_append: refusing oversize line ($bytes bytes + newline >= 4096 — appends must stay atomic)" >&2
    return 1
  fi
  env printf '%s\n' "$line" >>"$file" || return 1
  # Dual write (GH-2306): mirror the line into the sibling ledger.sqlite.
  # JSONL stays the truth — the sink warns and proceeds on ANY failure, so
  # this function's rc never depends on sqlite. Both sinks run under whatever
  # serialization the caller already holds (read-decide-append writers hold
  # ralph_ledger_lock; bare appends are atomic on their own) — deliberately
  # no second lock, which preserves cross-sink ordering wherever the caller
  # locked. The 4096-byte guard above still governs: the JSONL sink rules
  # while it is a sink (lifting it is phase D).
  _ralph_ledger_sqlite_insert "$file" "$line"
  return 0
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

# ralph_ledger_open_agents [REPO_ROOT] — agent_refs (one per line) with a
# spawn/discover event and no later exit. Order-aware reduce: an exit closes
# the ref; a fresh spawn/discover of the SAME ref (shouldn't happen — epochs
# are per-spawn) would legitimately re-open it. Missing/empty ledger: rc 0,
# no output.
# shellcheck disable=SC2120  # REPO_ROOT is for callers outside the watcher (lib.sh)
ralph_ledger_open_agents() {
  local file
  file=$(ralph_ledger_path "$@") || return 1
  [ -s "$file" ] || return 0
  jq -rs '
    reduce .[] as $e ({};
      if ($e.agent_ref // "") == "" then .
      elif $e.ev == "spawn" or $e.ev == "discover" then .[$e.agent_ref] = true
      elif $e.ev == "exit" then .[$e.agent_ref] = false
      else . end)
    | to_entries[] | select(.value) | .key' <"$file"
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
  [ -s "$file" ] || return 1
  out=$(jq -c --arg ref "$ref" -s 'map(select(.agent_ref == $ref)) | last // empty' <"$file")
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
  [ -s "$file" ] || return 0
  jq -rs --arg p "$pane" '
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
    | .open | to_entries[] | select(.value and ($pn[.key] == $p)) | .key' <"$file"
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
  [ -s "$file" ] || return 1
  out=$(jq -r --arg ref "$ref" -s "
    [ .[]
      | select(.agent_ref == \$ref)
      | $expr ]
    | map(select(. != null and . != \"\")) | last // empty" <"$file")
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
  [ -s "$file" ] || return 0
  jq -rs '
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
    | join("\u001f")' <"$file"
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
  [ -s "$file" ] || return 0
  jq -rs '
    reduce .[] as $e ({open: {}, s: {}};
      (($e.agent_ref // "")) as $ref
      | if $ref == "" then .
        elif $e.ev == "spawn" or $e.ev == "discover" then
          .open[$ref] = true | .s[$ref] = (($e.session // "") | tostring)
        elif $e.ev == "exit" then .open[$ref] = false
        else . end)
    | .s as $s
    | [.open | to_entries[] | select(.value) | ($s[.key] // "")]
    | map(select(. != "")) | unique | .[]' <"$file"
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
  [ -s "$file" ] || return 0
  jq -rs --arg ref "$ref" '
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
    | .key' <"$file"
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
