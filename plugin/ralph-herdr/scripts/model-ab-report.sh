#!/usr/bin/env bash
# model-ab-report.sh — GH-2352: cost and outcome per driver model, read from
# the herdr ledger's spawn/usage/finish facts and joined to GitHub's own
# issue state. Read-only; never mutates the board or the ledger.
#
# GROUPING KEY: each driver unit's spawn-time ask (model_requested, GH-2350),
# falling back to the usage fact's billed model when no ask was recorded —
# pre-#2350 history, or any spawn path that still inherits the account
# default. That fallback is what lets "asked for X but billed Y" (a harness
# alias resolving to a different model than named) still land in a bucket
# instead of an unreadable "unknown".
#
# What it reports per model bucket: driver units, closed issues, $/closed
# issue (list-price equivalent, rate-limit weight — not a bill), calls/unit,
# and the finish.via split (review vs done, GH-2348). `closed` counts DISTINCT
# issues, not units: a retried or re-picked issue has several driver units
# and must not be paid for once per unit (PR #2408 P1) — its units' $ all
# land in the bucket's total, so $/closed stays the honest per-issue number.
#
# What it deliberately does NOT compute: review rounds per PR
# (review-convergence.sh), escalations to lead, and reopen/rework. Those
# need a per-PR/per-issue walk that doesn't batch through the ledger the way
# spawn/usage/finish do — a follow-up pass composes them once there's enough
# closed volume per model to make that GraphQL spend worth it.
#
# Usage: model-ab-report.sh [--since ISO8601] [--json]
#   --since ISO8601   only include driver units spawned at/after this
#                     instant (default: everything the ledger has)
#   --json            machine-readable {buckets, mixed_model_issues} instead
#                     of the printed table
#
# Knobs (same as every other ledger reader in this plugin):
#   RALPH_HERDR_REPO           repo root to resolve board scope from (default $PWD)
#   RALPH_HERDR_LEDGER         explicit ledger.jsonl locator (overrides derivation)
#   RALPH_HERDR_LEDGER_ROOT    ledger root dir (default ~/.ralph)
#   RALPH_SQLITE3_BIN          sqlite3 binary (default: sqlite3 on PATH)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${RALPH_HERDR_REPO:-$PWD}"

usage() {
  cat >&2 <<'EOF'
model-ab-report.sh — GH-2352: cost/outcome per driver model, from the herdr ledger

Usage: model-ab-report.sh [--since ISO8601] [--json]
EOF
}

SINCE=""
JSON_OUT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --since)
      [ $# -ge 2 ] || { echo "model-ab-report: --since needs an ISO8601 timestamp" >&2; exit 2; }
      SINCE="$2"
      shift 2
      ;;
    --json) JSON_OUT=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "model-ab-report: unknown argument '$1'" >&2; usage; exit 2 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "model-ab-report: jq is required" >&2; exit 1; }
command -v gh >/dev/null 2>&1 || { echo "model-ab-report: gh is required" >&2; exit 1; }

# Same cross-plugin discovery chain as ledger-finish.sh (GH-2348): ralph
# cannot know at authorship time where a host repo installed ralph-herdr.
_rp_json="${RALPH_HERDR_PLUGINS_JSON:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins.json}"
_rp_root=""
if [ -f "$_rp_json" ]; then
  _rp_root=$(jq -r 'map(select(.plugin_id == "ralph-herdr")) | .[0].plugin_root // empty' "$_rp_json" 2>/dev/null) || _rp_root=""
fi
_rp_scripts=""
for _cand in "${RALPH_HERDR_SCRIPTS_DIR:-}" "$_rp_root/scripts" "$REPO/plugin/ralph-herdr/scripts" "$SCRIPT_DIR"; do
  if [ -n "$_cand" ] && [ -f "$_cand/ledger.sh" ]; then
    _rp_scripts="$_cand"
    break
  fi
done
if [ -z "$_rp_scripts" ]; then
  echo "model-ab-report: the ralph-herdr plugin's ledger was not found — nothing to report on" >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$_rp_scripts/ledger.sh"
# shellcheck source=/dev/null
. "$_rp_scripts/ledger-convert.sh"

LEDGER_JSONL=$(ralph_ledger_path "$REPO") || exit 1
DB=$(ralph_lc_db_path "$LEDGER_JSONL")
[ -f "$DB" ] || { echo "model-ab-report: no ledger at $DB — nothing recorded yet" >&2; exit 1; }
SQ="${RALPH_SQLITE3_BIN:-sqlite3}"
command -v "$SQ" >/dev/null 2>&1 || { echo "model-ab-report: sqlite3 binary not runnable ('$SQ')" >&2; exit 1; }

DRIVERS_JSON=$("$SQ" -json "$DB" "SELECT payload FROM facts WHERE kind IN ('spawn','usage','finish') ORDER BY seq;" | jq -c '
  [.[].payload | fromjson?]
  | map(select(.agent_ref))
  | group_by(.agent_ref)
  | map({
      ref: .[0].agent_ref,
      issue: ([.[] | select(.ev == "spawn") | (.lineage.issue // .tokens.issue // null)] | map(select(. != null)) | .[0] // null),
      role: ([.[] | select(.ev == "spawn") | .lineage.role] | map(select(. != null)) | .[0] // null),
      spawned_at: ([.[] | select(.ev == "spawn") | .ts] | map(select(. != null)) | .[0] // null),
      model_requested: ([.[] | select(.ev == "spawn") | .model_requested] | map(select(. != null and . != "")) | .[0] // null),
      usage: ([.[] | select(.ev == "usage") | .usage] | sort_by(.last_ts // "") | last),
      finish_via: ([.[] | select(.ev == "finish") | .via] | sort | last)
    })
  | map(select(.role == "driver" and .issue != null))')

if [ -n "$SINCE" ]; then
  DRIVERS_JSON=$(printf '%s' "$DRIVERS_JSON" | jq -c --arg since "$SINCE" 'map(select(.spawned_at != null and .spawned_at >= $since))')
fi

N=$(printf '%s' "$DRIVERS_JSON" | jq 'length')
if [ "$N" -eq 0 ]; then
  echo "model-ab-report: no driver units recorded${SINCE:+ since $SINCE}" >&2
  exit 0
fi

# Closed state per issue — one gh call per DISTINCT issue among the driver
# units found (bounded by that count, never the whole board). Run from $REPO
# so a bare number resolves in the repo the ledger was scoped from, not
# whatever cwd the caller happens to be in (PR #2408 P1).
CLOSED_JSON="{}"
while IFS= read -r n; do
  [ -n "$n" ] || continue
  state=$(cd "$REPO" && gh issue view "$n" --json state -q .state 2>/dev/null) || state="UNKNOWN"
  CLOSED_JSON=$(printf '%s' "$CLOSED_JSON" | jq --arg n "$n" --arg s "$state" '. + {($n): $s}')
done < <(printf '%s' "$DRIVERS_JSON" | jq -r '[.[].issue] | unique | .[]')

REPORT=$(printf '%s' "$DRIVERS_JSON" | jq -c --argjson closed "$CLOSED_JSON" '
  map(. + {issue_state: ($closed[(.issue | tostring)] // "UNKNOWN")})
  | map(. + {model: (.model_requested // .usage.model // "unknown (no spawn ask, no usage fact)")})
  | group_by(.model)
  | map({
      model: .[0].model,
      units: length,
      closed: (map(select(.issue_state == "CLOSED") | .issue) | unique | length),
      total_list_usd: (map(.usage.list_usd // 0) | add),
      total_calls: (map(.usage.calls // 0) | add),
      finish_review: (map(select(.finish_via == "review")) | length),
      finish_done: (map(select(.finish_via == "done")) | length)
    })
  | map(. + {
      usd_per_closed: (if .closed > 0 then (.total_list_usd / .closed) else null end),
      calls_per_unit: (if .units > 0 then (.total_calls / .units) else null end)
    })
  | sort_by(.model)')

# Issues whose driver units span MORE THAN ONE model bucket — a retry or a
# re-pick across the window flip. Each bucket above still carries its own
# units' $ and credits the issue's close, so such an issue is counted closed
# in every bucket it touched (PR #2408 P1). Which model "owns" that close is
# a methodology call the protocol doc leaves to the reader, so the report
# NAMES them rather than silently picking: exclude or adjudicate by hand.
MIXED=$(printf '%s' "$DRIVERS_JSON" | jq -c '
  map({issue, model: (.model_requested // .usage.model // "unknown (no spawn ask, no usage fact)")})
  | group_by(.issue)
  | map(select((map(.model) | unique | length) > 1) | {issue: .[0].issue, models: (map(.model) | unique)})
  | sort_by(.issue)')

if [ "$JSON_OUT" -eq 1 ]; then
  jq -cn --argjson buckets "$REPORT" --argjson mixed "$MIXED" '{buckets: $buckets, mixed_model_issues: $mixed}'
  exit 0
fi

printf '%s\n' "$REPORT" | jq -r '
  (["model", "units", "closed", "$/closed", "calls/unit", "total $", "finish:review", "finish:done"] | @tsv),
  (.[] | [
      .model, .units, .closed,
      (if .usd_per_closed then (.usd_per_closed * 100 | round / 100 | tostring) else "n/a" end),
      (if .calls_per_unit then (.calls_per_unit * 10 | round / 10 | tostring) else "n/a" end),
      (.total_list_usd * 100 | round / 100 | tostring),
      .finish_review, .finish_done
    ] | @tsv)'
MIXED_N=$(printf '%s' "$MIXED" | jq 'length')
if [ "$MIXED_N" -gt 0 ]; then
  printf '\nmixed-model issues (counted closed in EVERY bucket they touched — adjudicate by hand): %s\n' "$MIXED_N"
  printf '%s' "$MIXED" | jq -r '.[] | "  #\(.issue)  \(.models | join(" + "))"'
else
  printf '\nmixed-model issues: none (no issue has driver units in more than one bucket)\n'
fi
