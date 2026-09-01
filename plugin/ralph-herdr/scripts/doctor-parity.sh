#!/usr/bin/env bash
# doctor-parity.sh — ledger tape health check (GH-2305 phase A; re-scoped by
# GH-2311 phase D, where the sqlite became the tape and the JSONL froze).
#
# READ-ONLY, like its doctor-*.sh siblings — the remedy is always
# `ledger-convert.sh`, never a write from here. Since phase D the line's
# meaning CHANGED and says so in its own wording: with a frozen JSONL beside
# a tape it reports "jsonl frozen at N facts (export-only since <version>)"
# instead of comparing counts that now diverge by design (the tape grows,
# the JSONL never does). What is still compared is the one direction that
# stays actionable: a tape holding FEWER facts than the frozen JSONL means
# the adoption never finished — ledger-convert.sh backfills it.
#
# Verdict shapes:
#   ok    tape present and readable, holding at least the frozen JSONL's
#         facts (or sqlite-only — a post-D fresh machine, jsonl via --export)
#   note  not converted yet (legacy JSONL, phase-A opt-in wording), tape
#         behind the frozen JSONL (backfill), or not evaluated (unreadable
#         paths never read as ok, and never as a GAP)
#   GAP   the tape holds fewer VALID facts than the frozen JSONL after a
#         backfill would have been expected — reserved for divergence a
#         re-convert cannot fix (INSERT OR IGNORE never overwrites)
#
# Each ledger also renders its read stamp (ledger-fallback.last, {ts, why},
# overwritten): phase C wrote fallbacks there; since phase D it records read
# ERRORS on a present tape (an unreadable present DB is surfaced HERE, not a
# reason to serve stale JSONL). Age + why when present, "no fallback
# recorded" otherwise; advisory like everything here.
#
# Counts compare VALID lines only (a JSON object per line): the converter
# routes malformed lines to the .rejects sidecar, so they exist on neither
# side of the comparison by construction.
#
# Output: herdr-setup.sh check style (`  ok   ` / `  GAP  ` / `  note `);
# ralph/scripts/herdr-setup.sh relays the verdict NOTE-level into `board
# doctor`'s herdr-cockpit line — never strict-escalated, never --fixed.
#
# Exit codes: 0 healthy (or nothing to check) · 1 divergence(s) · 2 not
# evaluable (no sqlite3) · 64 bad invocation.
#
# Knobs:
#   RALPH_HERDR_LEDGER        check exactly this ledger file (tests; default:
#                             scan every ~/.ralph/<owner>/<repo>/ledger.*)
#   RALPH_HERDR_LEDGER_ROOT   ledger root dir (default ~/.ralph)
#   RALPH_SQLITE3_BIN         sqlite3 binary (default: `sqlite3` on PATH)
set -euo pipefail

# The version at which the JSONL became export-only (phase D) — rendered in
# the frozen line's wording so a reader knows which release changed the
# meaning under them.
EXPORT_ONLY_SINCE="0.33.0"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# ONE definition of the phash/sibling-path/enumeration rules (the GH-1843
# shape): ledger.sh + ledger-convert.sh own them; this check only calls them.
# (ledger.sh sources ledger-convert.sh itself.)
# shellcheck source=ledger.sh
. "$SCRIPT_DIR/ledger.sh"

[ "$#" -eq 0 ] || { echo "doctor-parity.sh: takes no arguments" >&2; exit 64; }

FINDINGS=0
pass() { echo "  ok   $1 — $2"; }
gap()  { FINDINGS=$((FINDINGS + 1)); echo "  GAP  $1 — $2"; }
note() { echo "  note $1 — $2"; }

SQ="${RALPH_SQLITE3_BIN:-sqlite3}"
if ! command -v "$SQ" >/dev/null 2>&1; then
  note "ledger-parity" "not evaluable — sqlite3 not found (looked for '$SQ'); brew install sqlite (macOS) / apt-get install sqlite3 (debian)"
  exit 2
fi

ledger_files() {
  if [ -n "${RALPH_HERDR_LEDGER:-}" ]; then
    # Presence includes the sqlite sibling — post phase D a fresh machine
    # has no jsonl at all (2>/dev/null: the probe's deprecation courtesy
    # belongs to reads, not to this enumeration).
    _ralph_ledger_present "$RALPH_HERDR_LEDGER" 2>/dev/null &&
      printf '%s\n' "$RALPH_HERDR_LEDGER"
    return 0
  fi
  ralph_ledger_enum
}

# ledger_scope_tail FILE — the "owner/repo" a ledger path encodes (the check
# label; meaningless but harmless for a pinned test path).
ledger_scope_tail() {
  local dir
  dir=$(dirname "$1")
  printf '%s/%s' "$(basename "$(dirname "$dir")")" "$(basename "$dir")"
}

# age_of ISO_TS — human-ish age of an ISO-8601 UTC timestamp; the raw
# timestamp when neither date dialect can parse it (BSD -j -f vs GNU -d).
age_of() {
  local ts="${1-}" t0 now d
  t0=$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$ts" +%s 2>/dev/null) ||
    t0=$(date -u -d "$ts" +%s 2>/dev/null) || { printf '%s' "$ts"; return 0; }
  now=$(date -u +%s)
  d=$((now - t0))
  if [ "$d" -lt 0 ]; then printf '%s' "$ts"
  elif [ "$d" -lt 120 ]; then printf '%ss ago' "$d"
  elif [ "$d" -lt 7200 ]; then printf '%sm ago' "$((d / 60))"
  else printf '%sh ago' "$((d / 3600))"
  fi
}

# fallback_note SCOPE FILE — render the read-fallback stamp ledger.sh's read
# flip (GH-2309) leaves beside FILE: age + why when present, "no fallback
# recorded" otherwise. Advisory like everything here — a fallback is the
# readers protecting themselves, and the stamp is how a human learns the
# sqlite side is not being read.
fallback_note() {
  local scope="${1-}" f="${2-}" stampf sts swhy
  stampf="$(dirname "$f")/ledger-fallback.last"
  if [ ! -f "$stampf" ]; then
    note "parity-$scope" "no fallback recorded"
    return 0
  fi
  sts=$(jq -r '.ts // ""' "$stampf" 2>/dev/null) || sts=""
  swhy=$(jq -r '.why // ""' "$stampf" 2>/dev/null) || swhy=""
  note "parity-$scope" "read fallback $(age_of "$sts") — ${swhy:-unrecorded why}"
}

checked=0
unconverted=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  scope=$(ledger_scope_tail "$f")
  fallback_note "$scope" "$f"
  db=$(ralph_lc_db_path "$f")
  if [ ! -f "$db" ]; then
    unconverted=$((unconverted + 1))
    note "parity-$scope" "not converted yet — bash $SCRIPT_DIR/ledger-convert.sh $f"
    continue
  fi
  uv=$(ralph_lc_user_version "$db") || uv=""
  case "$uv" in
    0 | 1) : ;;
    *)
      note "parity-$scope" "not evaluated — $db has user_version='${uv:-?}' (unreadable, or a schema newer than v1)"
      continue
      ;;
  esac
  checked=$((checked + 1))

  # sqlite side: count, last seq, last phash. An unreadable db is `not
  # evaluated`, never a GAP — a failed read may not render as divergence.
  dcount=$("$SQ" "$db" 'SELECT count(*) FROM facts;' 2>/dev/null) || dcount=""
  dmax=$("$SQ" "$db" 'SELECT coalesce(max(seq), 0) FROM facts;' 2>/dev/null) || dmax=""
  dhash=$("$SQ" "$db" 'SELECT phash FROM facts WHERE seq = (SELECT max(seq) FROM facts);' 2>/dev/null) || dhash=""
  if [ -z "$dcount" ] || [ -z "$dmax" ]; then
    note "parity-$scope" "not evaluated — cannot read $db"
    continue
  fi

  # A tape with no jsonl beside it is a post-D fresh machine: nothing to
  # compare, and that is the healthy shape, not a finding.
  if [ ! -f "$f" ]; then
    pass "parity-$scope" "sqlite-only ($dcount fact(s); jsonl export via ledger-convert.sh --export)"
    continue
  fi

  # frozen jsonl side: valid-line count, last valid line's number and bytes,
  # in one jq pass. Same `not evaluated` rule on failure.
  jstats=$(jq -Rrn '
    [inputs] | to_entries
    | map(select((.value | try fromjson catch null | type) == "object"))
    | if length == 0 then "0\u001f0\u001f"
      else "\(length)\u001f\(.[-1].key + 1)\u001f\(.[-1].value)" end' <"$f" 2>/dev/null) || jstats=""
  if [ -z "$jstats" ]; then
    note "parity-$scope" "not evaluated — cannot read $f"
    continue
  fi
  IFS=$'\037' read -r jcount jlastseq jlastline <<<"$jstats"

  # The counts diverge BY DESIGN now (the tape grows, the frozen jsonl never
  # does), so equality is not the question anymore. What is checked instead:
  # the frozen jsonl must be an intact PREFIX of the tape — its last valid
  # line's seq-salted phash standing at that seq. Ahead-or-equal with an
  # intact prefix is the healthy post-D shape; behind means the adoption
  # never finished (backfill); a broken overlap is the one state re-running
  # the converter cannot fix (INSERT OR IGNORE never overwrites).
  if [ "$jcount" = "0" ]; then
    pass "parity-$scope" "tape holds $dcount fact(s); jsonl frozen at 0 facts (export-only since $EXPORT_ONLY_SINCE)"
  elif [ "$dcount" -ge "$jcount" ] 2>/dev/null; then
    jh=$(ralph_lc_hash_line "$jlastseq" "$jlastline") || jh=""
    oph=$("$SQ" "$db" "SELECT phash FROM facts WHERE seq=$jlastseq;" 2>/dev/null) || oph=""
    if [ -n "$jh" ] && [ "$jh" = "$oph" ]; then
      pass "parity-$scope" "tape holds $dcount fact(s); jsonl frozen at $jcount facts (export-only since $EXPORT_ONLY_SINCE)"
    else
      gap "parity-$scope" "the tape's fact at seq $jlastseq does not match the frozen jsonl's last line — the histories diverged; re-converting cannot reconcile this, inspect before trusting either"
    fi
  else
    # Behind is only curable while the overlap is intact: the phash at the
    # tape's last seq must match the jsonl's line there.
    ok_prefix=""
    if [ "$dmax" = "0" ]; then
      ok_prefix=1
    else
      oline=$(sed -n "${dmax}p" "$f" 2>/dev/null) || oline=""
      oh=$(ralph_lc_hash_line "$dmax" "$oline") || oh=""
      [ -n "$oh" ] && [ "$oh" = "$dhash" ] && ok_prefix=1
    fi
    if [ -n "$ok_prefix" ]; then
      note "parity-$scope" "tape behind the frozen jsonl by $((jcount - dcount)) fact(s) ($dcount of $jcount) — the adoption never finished; bash $SCRIPT_DIR/ledger-convert.sh $f backfills"
    else
      gap "parity-$scope" "tape is behind AND its last fact (seq $dmax) does not match the jsonl line there — the histories diverged; re-converting cannot reconcile this, inspect before trusting either"
    fi
  fi
done < <(ledger_files)

tail_note=""
[ "$unconverted" -gt 0 ] && tail_note="; $unconverted not converted yet"
if [ "$FINDINGS" -eq 0 ]; then
  pass "ledger-parity" "in parity ($checked tape(s) checked$tail_note)"
  exit 0
fi
echo "  $FINDINGS parity divergence(s) of $checked checked$tail_note"
exit 1
