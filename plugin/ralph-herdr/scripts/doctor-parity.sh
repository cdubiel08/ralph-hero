#!/usr/bin/env bash
# doctor-parity.sh — ledger JSONL↔SQLite parity check (GH-2305, phase A).
#
# For every ledger.jsonl with a converted sibling ledger.sqlite: fact-count
# and last-phash agreement. READ-ONLY, like its doctor-*.sh siblings — the
# remedy is always `ledger-convert.sh`, never a write from here.
#
# Three verdict shapes, deliberately not two:
#   ok    counts equal and the last fact's phash matches — in parity.
#   note  sqlite is BEHIND the jsonl and the overlap is intact (the phash at
#         sqlite's last seq matches the jsonl line there). That is the normal
#         state between appends and converts, not a finding — flagging it
#         would cry wolf on every ledger the moment the watcher appends.
#   GAP   anything else: same count with a different last phash, sqlite ahead
#         of the jsonl, or a mismatched overlap — the two files disagree
#         about history, which re-running the converter will NOT reconcile
#         (INSERT OR IGNORE never overwrites); a human looks first.
#
# An absent sqlite file is "not converted yet" — info, never a failure (the
# converter is opt-in in phase A). Any unreadable path — db, jsonl, a schema
# newer than v1 — reads `not evaluated`, never ok and never a GAP.
#
# Each ledger also renders its read-fallback stamp (GH-2309, phase C): the
# read flip in ledger.sh stamps ledger-fallback.last ({ts, why}, overwritten)
# whenever a read fell back to the JSONL, keeping stderr clean on the read
# path — this line is where that record becomes visible. Age + why when
# present, "no fallback recorded" otherwise; advisory like everything here.
#
# Counts compare VALID lines only (a JSON object per line): the converter
# routes malformed lines to the .rejects sidecar, so they exist on neither
# side of the comparison by construction.
#
# Output: herdr-setup.sh check style (`  ok   ` / `  GAP  ` / `  note `);
# ralph/scripts/herdr-setup.sh relays the verdict NOTE-level into `board
# doctor`'s herdr-cockpit line — never strict-escalated, never --fixed.
#
# Exit codes: 0 in parity (or nothing to check) · 1 divergence(s) · 2 not
# evaluable (no sqlite3) · 64 bad invocation.
#
# Knobs:
#   RALPH_HERDR_LEDGER        check exactly this ledger file (tests; default:
#                             scan every ~/.ralph/<owner>/<repo>/ledger.jsonl)
#   RALPH_HERDR_LEDGER_ROOT   ledger root dir (default ~/.ralph)
#   RALPH_SQLITE3_BIN         sqlite3 binary (default: `sqlite3` on PATH)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# ONE definition of the phash rule and the sibling-path rule (the GH-1843
# shape): the converter owns both; this check only calls them.
# shellcheck source=ledger-convert.sh
. "$SCRIPT_DIR/ledger-convert.sh"

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
    [ -f "$RALPH_HERDR_LEDGER" ] && printf '%s\n' "$RALPH_HERDR_LEDGER"
    return 0
  fi
  local f
  for f in "${RALPH_HERDR_LEDGER_ROOT:-$HOME/.ralph}"/*/*/ledger.jsonl; do
    [ -f "$f" ] && printf '%s\n' "$f"
  done
  return 0
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

  # jsonl side: valid-line count, last valid line's number and bytes, in one
  # jq pass. Same `not evaluated` rule on failure.
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

  if [ "$dcount" = "$jcount" ]; then
    if [ "$jcount" = "0" ]; then
      pass "parity-$scope" "in parity (0 facts)"
      continue
    fi
    jh=$(ralph_lc_hash_line "$jlastseq" "$jlastline") || jh=""
    if [ "$dmax" = "$jlastseq" ] && [ -n "$jh" ] && [ "$jh" = "$dhash" ]; then
      pass "parity-$scope" "in parity ($jcount facts, last phash agrees)"
    else
      gap "parity-$scope" "same fact count ($jcount) but the last fact disagrees (jsonl line $jlastseq vs sqlite seq $dmax) — the files diverged; re-converting will not reconcile this, inspect before trusting either"
    fi
  elif [ "$dcount" -lt "$jcount" ] 2>/dev/null; then
    # Behind is only benign while the overlap is intact: the phash at
    # sqlite's last seq must match the jsonl's line there.
    ok_prefix=""
    if [ "$dmax" = "0" ]; then
      ok_prefix=1
    else
      oline=$(sed -n "${dmax}p" "$f" 2>/dev/null) || oline=""
      oh=$(ralph_lc_hash_line "$dmax" "$oline") || oh=""
      [ -n "$oh" ] && [ "$oh" = "$dhash" ] && ok_prefix=1
    fi
    if [ -n "$ok_prefix" ]; then
      note "parity-$scope" "sqlite behind by $((jcount - dcount)) fact(s) ($dcount of $jcount) — bash $SCRIPT_DIR/ledger-convert.sh $f"
    else
      gap "parity-$scope" "sqlite is behind AND its last fact (seq $dmax) does not match the jsonl line there — the jsonl was rewritten; inspect before trusting either"
    fi
  else
    gap "parity-$scope" "sqlite holds $dcount fact(s) but the jsonl only $jcount — the jsonl was truncated or rewritten; the sqlite side is the recovery copy (--export), inspect before touching either"
  fi
done < <(ledger_files)

tail_note=""
[ "$unconverted" -gt 0 ] && tail_note="; $unconverted not converted yet"
if [ "$FINDINGS" -eq 0 ]; then
  pass "ledger-parity" "in parity ($checked converted ledger(s) checked$tail_note)"
  exit 0
fi
echo "  $FINDINGS parity divergence(s) of $checked checked$tail_note"
exit 1
