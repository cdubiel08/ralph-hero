#!/usr/bin/env bash
# ledger-convert.sh — idempotent JSONL→SQLite converter for the events ledger
# (GH-2305, phase A of the ledger SQLite deprecation path).
#
# Builds/updates `ledger.sqlite` beside `ledger.jsonl` (schema v1 below).
# PURE ADDITION: no writer or reader of the JSONL changes; the sqlite file is
# a derived artifact the JSONL can always regenerate — and the other way
# round: `--export` prints JSONL from the sqlite in seq order, byte-identical
# to the input it was built from (a CI test, not a claim). This is also the
# disaster-recovery path for every later phase, maintained until ralph 1.0.0.
#
#   bash ledger-convert.sh [LEDGER_JSONL]        # convert / update sibling .sqlite
#   bash ledger-convert.sh --export [LEDGER_JSONL]  # regenerate JSONL on stdout
#
# LEDGER_JSONL defaults like every ledger.sh consumer: $RALPH_HERDR_LEDGER,
# else derived from the repo scope at $PWD via ralph_ledger_path.
#
# Schema v1:
#   PRAGMA journal_mode=WAL; PRAGMA user_version=1;
#   CREATE TABLE facts(
#     seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL,
#     agent TEXT, unit INTEGER, reason TEXT, pane TEXT,
#     payload TEXT NOT NULL,        -- the original JSONL line, VERBATIM
#     phash TEXT NOT NULL UNIQUE    -- sha256("<seq>\t<payload>")
#   );
#
# Typed columns (kind from .ev, agent from .agent_ref, unit from the agent
# ref's leading [a-z]NNN-, reason from .reason, pane from .pane_id) are a
# projection of payload, recomputable; payload is authoritative. A valid JSON
# object missing .ts/.ev stores "" there — the row is kept, because payload
# is the guarantee and the projection is best-effort.
#
# phash is salted with seq, deliberately deviating from the filing's
# sha256(payload): ledger.sh states duplicate identical events are tolerated
# by construction (concurrent appends), so a payload-only UNIQUE hash would
# silently DROP a legal duplicate line and break --export's byte-identity.
# seq is deterministic (file order), so idempotence still holds by
# construction: a re-run computes the same (seq, payload) pairs and INSERT OR
# IGNORE inserts nothing.
#
# Guarantees:
#   idempotent    re-runs insert nothing (phash UNIQUE, deterministic seq)
#   crash-safe    fresh build lands via atomic rename; incremental inserts are
#                 one sqlite transaction — a kill leaves the previous state,
#                 never a half-built ledger.sqlite
#   lossless      a malformed line (not a JSON object) goes to the
#                 `<ledger>.rejects` sidecar and is counted, never silently
#                 dropped; the sidecar is derived and regenerated per run
#   fail closed   a db whose user_version is above 1 (a newer ralph's schema)
#                 is refused, never written
#
# seq is the JSONL line number, so rejected lines leave gaps — order is
# preserved and a later fix of a malformed line converts into its own slot.
#
# Exit codes: 0 ok · 64 bad invocation · 65 refused (future user_version /
# unreadable db) · 66 no input (missing ledger, or --export before convert) ·
# 69 missing tool (sqlite3/sha256 — the message names the install).
#
# Knobs:
#   RALPH_HERDR_LEDGER      ledger file (overrides derivation; tests)
#   RALPH_SQLITE3_BIN       sqlite3 binary (default: `sqlite3` on PATH)
#
# Sourceable: doctor-parity.sh sources this file for ralph_lc_hash_line and
# ralph_lc_db_path — ONE definition of the hash rule, the GH-1843 shape. When
# sourced, nothing runs and no shell options are touched (callers own their
# options, ledger.sh's rule). bash 3.2 compatible.

_RALPH_LC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ralph_lc_db_path LEDGER — the sibling sqlite path for a ledger file.
ralph_lc_db_path() {
  case "${1-}" in
    *.jsonl) printf '%s.sqlite\n' "${1%.jsonl}" ;;
    *) printf '%s.sqlite\n' "${1-}" ;;
  esac
}

# ralph_lc_hash_line SEQ LINE — sha256 over "<seq>\t<line>", 64 hex chars.
# rc 69 (with the remedy on stderr) when no sha256 tool exists: the hash is
# load-bearing here (it IS the idempotence key), so unlike ralph_session_key
# there is no degraded mode.
ralph_lc_hash_line() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s\t%s' "${1-}" "${2-}" | shasum -a 256 | cut -c1-64
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s\t%s' "${1-}" "${2-}" | sha256sum | cut -c1-64
  else
    echo "ledger-convert: no sha256 tool — install perl/shasum (macOS ships it) or coreutils/sha256sum" >&2
    return 69
  fi
}

# ralph_lc_user_version DB — print the db's user_version, or rc 1.
ralph_lc_user_version() {
  "${RALPH_SQLITE3_BIN:-sqlite3}" "${1-}" 'PRAGMA user_version;' 2>/dev/null
}

# _ralph_lc_require_tools — sqlite3 + a hasher, each refusal naming its
# install. An absent sqlite3 exits with the hint, never a silent no-op.
_ralph_lc_require_tools() {
  if ! command -v "${RALPH_SQLITE3_BIN:-sqlite3}" >/dev/null 2>&1; then
    echo "ledger-convert: sqlite3 not found (looked for '${RALPH_SQLITE3_BIN:-sqlite3}') — install it: brew install sqlite (macOS) / apt-get install sqlite3 (debian)" >&2
    return 69
  fi
  ralph_lc_hash_line probe probe >/dev/null || return 69
  return 0
}

# _ralph_lc_check_version DB — refuse (rc 65) any db whose user_version is
# above 1 or unreadable: a future schema is a newer ralph's file, and writing
# into it from here is exactly the destructive half fail-closed exists for.
_ralph_lc_check_version() {
  local db="${1-}" uv
  [ -f "$db" ] || return 0
  uv=$(ralph_lc_user_version "$db") || uv=""
  case "$uv" in
    0 | 1) return 0 ;;
    '' | *[!0-9]*)
      echo "ledger-convert: cannot read user_version of $db — refusing to write into it" >&2
      return 65
      ;;
    *)
      echo "ledger-convert: $db has user_version=$uv (schema newer than v1) — this ralph refuses to touch it; upgrade ralph instead" >&2
      return 65
      ;;
  esac
}

# _ralph_lc_classify FILE — one jq pass over the JSONL: each line becomes a
# US-separated record, "F"-tagged (seq, sanitized typed fields, raw payload
# LAST so an embedded escape cannot shift a column) or "R"-tagged (seq, raw).
# A line is a fact iff it parses as a JSON object; anything else is a reject.
_ralph_lc_classify() {
  jq -R -r '
    def col: (. // "") | tostring | gsub("[\u001f\t\r\n]"; " ");
    (input_line_number | tostring) as $n
    | . as $raw
    | (try fromjson catch null) as $j
    | if ($j | type) == "object" then
        [ "F", $n,
          ($j.ts | col), ($j.ev | col), ($j.agent_ref | col),
          ((($j.agent_ref // "") | tostring
            | (try capture("^[a-z](?<u>[0-9]+)-") catch null) | (.u // "")) | col),
          ($j.reason | col), ($j.pane_id | col),
          $raw ] | join("\u001f")
      else "R\u001f\($n)\u001f\($raw)" end' <"${1-}"
}

# ralph_lc_convert LEDGER — build/update LEDGER's sibling sqlite. Prints a
# one-line summary on success.
ralph_lc_convert() {
  local file="${1-}" db sq work import_rows rejects n_valid n_rejects
  local fresh target before after new row tag seq ts ev agent unit reason pane payload ph rc rejraw
  db=$(ralph_lc_db_path "$file")
  sq="${RALPH_SQLITE3_BIN:-sqlite3}"
  _ralph_lc_require_tools || return $?
  if [ ! -f "$file" ]; then
    echo "ledger-convert: no ledger at $file" >&2
    return 66
  fi
  _ralph_lc_check_version "$db" || return $?

  work=$(mktemp -d "${TMPDIR:-/tmp}/ralph-ledger-convert.XXXXXX") || return 1
  # shellcheck disable=SC2064  # expand $work now; it never changes
  trap "rm -rf '$work'" EXIT INT TERM
  import_rows="$work/import"
  : >"$import_rows"
  : >"$work/rejects"

  # Classify, then hash each fact line. Payload is the LAST column and read
  # back with a slurping last field, so an embedded separator (impossible in
  # valid single-line JSON, but this is the belt) cannot shift a column.
  _ralph_lc_classify "$file" >"$work/classified" || {
    echo "ledger-convert: jq failed reading $file" >&2
    return 1
  }
  n_valid=0
  n_rejects=0
  while IFS= read -r row; do
    tag=${row%%$'\037'*}
    case "$tag" in
      F)
        IFS=$'\037' read -r _ seq ts ev agent unit reason pane payload <<<"$row"
        ph=$(ralph_lc_hash_line "$seq" "$payload") || return 69
        printf '%s\037%s\037%s\037%s\037%s\037%s\037%s\037%s\037%s\n' \
          "$seq" "$ts" "$ev" "$agent" "$unit" "$reason" "$pane" "$payload" "$ph" >>"$import_rows"
        n_valid=$((n_valid + 1))
        ;;
      R)
        # rejraw slurps the rest of the record, so a raw byte that happens to
        # BE the separator (one way a line gets rejected) survives verbatim.
        IFS=$'\037' read -r _ _ rejraw <<<"$row"
        printf '%s\n' "$rejraw" >>"$work/rejects"
        n_rejects=$((n_rejects + 1))
        ;;
    esac
  done <"$work/classified"

  # Rejects sidecar: derived, regenerated whole each run (the source is
  # append-only, so regeneration is idempotent); removed when clean so a
  # stale sidecar cannot claim rejects that no longer exist.
  rejects="$file.rejects"
  if [ "$n_rejects" -gt 0 ]; then
    mv "$work/rejects" "$rejects" || return 1
  else
    rm -f "$rejects"
  fi

  # Fresh build lands in a temp sibling then renames into place (atomic on
  # one filesystem): a kill mid-build leaves NO ledger.sqlite, only a
  # pid-suffixed tmp the next run sweeps. Incremental runs write the live db
  # inside one transaction — sqlite's own atomicity carries crash-safety.
  rm -f "$db".tmp.* 2>/dev/null || true
  if [ -f "$db" ]; then
    fresh=""
    target="$db"
    before=$("$sq" "$target" 'SELECT count(*) FROM facts;') || {
      echo "ledger-convert: cannot read $db — refusing to write into it" >&2
      return 65
    }
  else
    fresh=1
    target="$db.tmp.$$"
    before=0
  fi

  rc=0
  "$sq" "$target" >/dev/null <<SQL || rc=$?
.bail on
PRAGMA journal_mode=WAL;
BEGIN;
CREATE TABLE IF NOT EXISTS facts(
  seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL,
  agent TEXT, unit INTEGER, reason TEXT, pane TEXT,
  payload TEXT NOT NULL,
  phash TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS ix_unit ON facts(unit);
CREATE INDEX IF NOT EXISTS ix_kind ON facts(kind, ts);
CREATE TEMP TABLE staging(
  seq TEXT, ts TEXT, kind TEXT, agent TEXT, unit TEXT, reason TEXT,
  pane TEXT, payload TEXT, phash TEXT
);
.mode ascii
.separator "\037" "\n"
.import "$import_rows" staging
INSERT OR IGNORE INTO facts(seq, ts, kind, agent, unit, reason, pane, payload, phash)
  SELECT CAST(seq AS INTEGER), ts, kind, nullif(agent, ''),
         CAST(nullif(unit, '') AS INTEGER), nullif(reason, ''), nullif(pane, ''),
         payload, phash
  FROM staging ORDER BY CAST(seq AS INTEGER);
COMMIT;
PRAGMA user_version=1;
SQL
  if [ "$rc" -ne 0 ]; then
    echo "ledger-convert: sqlite3 failed (exit $rc) — $db left untouched" >&2
    [ -n "$fresh" ] && rm -f "$target"
    return 1
  fi
  if [ -n "$fresh" ]; then
    mv "$target" "$db" || return 1
  fi
  after=$("$sq" "$db" 'SELECT count(*) FROM facts;') || after="?"
  new="?"
  case "$after" in '' | *[!0-9]*) : ;; *) new=$((after - before)) ;; esac
  printf 'ledger-convert: %s fact(s) in %s (%s new); %s reject(s)%s\n' \
    "$after" "$db" "$new" "$n_rejects" \
    "$([ "$n_rejects" -gt 0 ] && printf ' → %s' "$rejects")"
  return 0
}

# ralph_lc_export LEDGER — regenerate JSONL from LEDGER's sqlite on stdout,
# payload verbatim in seq order.
ralph_lc_export() {
  local file="${1-}" db
  db=$(ralph_lc_db_path "$file")
  _ralph_lc_require_tools || return $?
  if [ ! -f "$db" ]; then
    echo "ledger-convert: no sqlite ledger at $db — run the convert first" >&2
    return 66
  fi
  _ralph_lc_check_version "$db" || return $?
  "${RALPH_SQLITE3_BIN:-sqlite3}" "$db" 'SELECT payload FROM facts ORDER BY seq;'
}

_ralph_lc_main() {
  set -euo pipefail
  local mode="convert" file=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --export) mode="export" ;;
      --*)
        echo "usage: ledger-convert.sh [--export] [LEDGER_JSONL]" >&2
        exit 64
        ;;
      *)
        if [ -n "$file" ]; then
          echo "usage: ledger-convert.sh [--export] [LEDGER_JSONL]" >&2
          exit 64
        fi
        file="$1"
        ;;
    esac
    shift
  done
  if [ -z "$file" ]; then
    # shellcheck source=ledger.sh
    . "$_RALPH_LC_DIR/ledger.sh"
    file=$(ralph_ledger_path) || exit 66
  fi
  if [ "$mode" = "export" ]; then
    ralph_lc_export "$file"
  else
    ralph_lc_convert "$file"
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  _ralph_lc_main "$@"
fi
