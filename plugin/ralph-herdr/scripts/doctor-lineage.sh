#!/usr/bin/env bash
# doctor-lineage.sh — L10 lineage-closure check for the ralph-herdr watcher.
#
# Two-sided closure over live herdr agents × open ledger records, READ-ONLY
# (never appends, never touches herdr state — reconcile.sh is the healer,
# this script only reports):
#
#   live side    every live ralph agent with a ledger identity (grammar-B or
#                legacy gh-N; the ralph-deliver/ralph-tend singletons are
#                deliberately unledgered) has EXACTLY ONE open ledger record
#                across the scanned ledgers — zero means the watcher missed
#                the spawn and no reconcile has run; two+ means a duplicate
#                identity the reads would race on.
#   ledger side  every open record with NO live agent of that name whose
#                latest event is older than RALPH_LOCK_TTL_MIN is flagged —
#                the agent died while the server was down and no [[startup]]
#                reconcile has appended its exit reason=lost yet. Younger
#                un-live records are a note, not a finding: the next
#                reconcile marks them lost inside the same window a stale
#                board claim gets.
#
# Output: herdr-setup.sh check style (`  ok   name — detail` / `  GAP  ` /
# `  note `). ralph/scripts/herdr-setup.sh relays the verdict as an advisory
# NOTE-level section (a lineage finding is watcher telemetry, never a cockpit
# wiring gap), which keeps `board doctor`'s herdr-cockpit line info-level.
#
# Exit codes: 0 closed · 1 findings · 2 not evaluable (no herdr / server
# down) · 64 bad invocation.
#
# Knobs:
#   RALPH_LOCK_TTL_MIN        staleness window, minutes (default 120 — the
#                             same TTL the board's claim protocol uses)
#   RALPH_HERDR_LEDGER        check exactly this ledger file (tests; default:
#                             scan every ~/.ralph/<owner>/<repo>/ledger.jsonl)
#   RALPH_HERDR_LEDGER_ROOT   ledger root dir (default ~/.ralph)
#   HERDR_BIN_PATH            herdr binary (default: `herdr` on PATH)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The Herdr boundary (GH-1774): validated transport + repository scoping. This
# check compares live agents against ledgers from EVERY board scope, so an
# unscoped name match is exactly the defect it would otherwise report.
# shellcheck source=sanitize.sh
. "$SCRIPT_DIR/sanitize.sh"
# shellcheck source=transport.sh
. "$SCRIPT_DIR/transport.sh"
# shellcheck source=naming.sh
. "$SCRIPT_DIR/naming.sh"
# shellcheck source=ledger.sh
. "$SCRIPT_DIR/ledger.sh"
# shellcheck source=scope.sh
. "$SCRIPT_DIR/scope.sh"

HERDR="${HERDR_BIN_PATH:-herdr}"
TTL_MIN="${RALPH_LOCK_TTL_MIN:-120}"
case "$TTL_MIN" in
  '' | *[!0-9]* | 0*) echo "doctor-lineage.sh: RALPH_LOCK_TTL_MIN must be a positive integer (got '$TTL_MIN')" >&2; exit 64 ;;
esac
[ "$#" -eq 0 ] || { echo "doctor-lineage.sh: takes no arguments" >&2; exit 64; }

FINDINGS=0
pass() { echo "  ok   $1 — $2"; }
gap()  { FINDINGS=$((FINDINGS + 1)); echo "  GAP  $1 — $2"; }
note() { echo "  note $1 — $2"; }

# iso_to_epoch TS — seconds since epoch for an ISO-8601 UTC stamp; BSD date
# first (macOS), GNU fallback (linux). rc 1 on an unparseable stamp.
iso_to_epoch() {
  date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null ||
    date -u -d "$1" +%s 2>/dev/null
}

# ── live ralph agents (same regex lib.sh/reconcile.sh use) ───────────────────
# A FAILED read is "not evaluable", never "everything is a gap": an empty
# answer from a sick server must not flag every open record.
if ! command -v "$HERDR" >/dev/null 2>&1; then
  note "lineage" "not evaluable — herdr is not installed (looked for '$HERDR')"
  exit 2
fi
if ! raw=$(ralph_herdr_snapshot 2>&1); then
  note "lineage" "not evaluable — herdr snapshot unavailable (${raw:0:120})"
  exit 2
fi
# Tagged with each agent's repository, because a name is only meaningful
# WITHIN one: two repositories in one session both produce `w42-fix`, and
# comparing across them would report one repository's live agent as the other's
# missing record — a gap invented by the check itself.
live_json=$(ralph_herd_by_scope "$raw" 2>/dev/null) || live_json=""
live_names=$(printf '%s\n' "$live_json" | jq -r 'select(.name != null) | .name' 2>/dev/null) || live_names=""

# scope_of NAME — the repository scope of a live agent, or empty.
scope_of() {
  printf '%s\n' "$live_json" | jq -r --arg n "$1" 'select(.name == $n) | .scope // empty' 2>/dev/null | head -1
}

# ledger_scope_tail FILE — the "owner/repo" a ledger path encodes.
ledger_scope_tail() {
  local dir
  dir=$(dirname "$1")
  printf '%s/%s' "$(basename "$(dirname "$dir")")" "$(basename "$dir")"
}

# in_ledger_scope NAME FILE — does live agent NAME belong to FILE's repository?
#
# When $RALPH_HERDR_LEDGER pins ONE ledger there is no cross-repository
# ambiguity to resolve — and the pinned path need not follow the
# <root>/<owner>/<repo>/ layout at all, so its scope tail is not merely unknown
# but meaningless. Matching by name alone is then exact rather than sloppy.
in_ledger_scope() {
  [ -n "${RALPH_HERDR_LEDGER:-}" ] && return 0
  case "$(scope_of "$1")" in
    *"/$(ledger_scope_tail "$2")") return 0 ;;
  esac
  return 1
}

# ── open ledger records, as "FILE<TAB>REF" pairs ─────────────────────────────
# $RALPH_HERDR_LEDGER pins one file (tests); otherwise every board scope's
# ledger is scanned — live agents can belong to any repo's board.
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

open_pairs=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    open_pairs="$open_pairs$f	$ref
"
  done < <(RALPH_HERDR_LEDGER="$f" ralph_ledger_open_agents || true)
done < <(ledger_files)

# ── live side: exactly one open record per live ralph agent ──────────────────
live_checked=0
while IFS= read -r name; do
  [ -n "$name" ] || continue
  case "$name" in
    ralph-deliver | ralph-tend)
      note "lineage-$name" "legacy singleton lane — no ledger identity by design"
      continue
      ;;
  esac
  ralph_agent_parse "$name" >/dev/null || continue
  # Only agents belonging to a repository we actually hold a ledger for. A
  # herdr session can host repositories Ralph does not manage at all, and
  # reporting their workers as "live agent with NO open ledger record" would be
  # inventing findings about someone else's tree — the check would get noisier
  # the more the human uses herdr for anything but Ralph.
  scoped=""
  while IFS= read -r lf; do
    [ -n "$lf" ] || continue
    if in_ledger_scope "$name" "$lf"; then scoped=1; break; fi
  done < <(ledger_files)
  [ -n "$scoped" ] || continue
  live_checked=$((live_checked + 1))
  # Only records in THIS agent's repository count. An agent whose scope cannot
  # be resolved matches nothing and is reported as an unledgered gap, which is
  # the honest answer: we cannot say which ledger should hold it.
  count=0
  while IFS='	' read -r pf pref; do
    [ -n "$pref" ] || continue
    in_ledger_scope "$name" "$pf" || continue
    case "${pref%%#*}" in
      "$name") count=$((count + 1)) ;;
    esac
  done <<EOF_PAIRS
$open_pairs
EOF_PAIRS
  case "$count" in
    1) pass "lineage-$name" "one open ledger record" ;;
    0) gap "lineage-$name" "live agent with NO open ledger record — run the reconcile action (the [[startup]] pass heals this on server restart)" ;;
    *) gap "lineage-$name" "$count open ledger records — duplicate identity; the ledger reads would race" ;;
  esac
done <<EOF
$live_names
EOF

# ── ledger side: open records with no live agent, older than the TTL ─────────
now=$(date -u +%s)
open_checked=0
while IFS='	' read -r f ref; do
  [ -n "$ref" ] || continue
  open_checked=$((open_checked + 1))
  name=${ref%%#*}
  # Alive only if a live agent of that name belongs to THIS ledger's
  # repository — a same-named worker in another repository is not this
  # record's agent, and treating it as one would hide a real stale record.
  alive=""
  while IFS= read -r ln; do
    [ "$ln" = "$name" ] || continue
    in_ledger_scope "$ln" "$f" && { alive=1; break; }
  done <<EOF2
$live_names
EOF2
  [ -n "$alive" ] && continue
  ts=$(RALPH_HERDR_LEDGER="$f" ralph_ledger_last "$ref" 2>/dev/null | jq -r '.ts // empty' 2>/dev/null) || ts=""
  if [ -z "$ts" ] || ! ep=$(iso_to_epoch "$ts"); then
    gap "lineage-$ref" "open record with no live agent and no readable timestamp — reconcile should mark it lost"
    continue
  fi
  age_min=$(((now - ep) / 60))
  if [ "$age_min" -ge "$TTL_MIN" ]; then
    gap "lineage-$ref" "open record, no live agent, last event $ts (${age_min}m ago >= TTL ${TTL_MIN}m) — reconcile has not run; run the reconcile action"
  else
    note "lineage-$ref" "open record, no live agent, last event ${age_min}m ago (< TTL ${TTL_MIN}m) — the next reconcile marks it lost"
  fi
done <<EOF3
$open_pairs
EOF3

if [ "$FINDINGS" -eq 0 ]; then
  pass "lineage" "closed ($live_checked live ledgered agent(s), $open_checked open record(s))"
  exit 0
fi
echo "  $FINDINGS lineage finding(s)"
exit 1
