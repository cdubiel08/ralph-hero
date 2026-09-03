#!/usr/bin/env bash
# doctor-lineage.sh — L10 lineage-closure check for the ralph-herdr watcher.
#
# Two-sided closure over live herdr agents × open ledger records, READ-ONLY
# (never appends, never touches herdr state — reconcile.sh is the healer,
# this script only reports):
#
#   live side    every live ralph agent with a ledger identity (grammar-B or
#                legacy gh-N; the pre-GH-2342 ralph-deliver/ralph-tend
#                singletons are unledgered by construction — the current
#                t0-tend / r0-deliver passes are ordinary grammar-B agents)
#                has EXACTLY ONE open ledger record
#                across the scanned ledgers — zero means the watcher missed
#                the spawn and no reconcile has run; two+ means a duplicate
#                identity the reads would race on.
#   ledger side  every open record with NO live agent of that name whose
#                latest event is older than RALPH_LOCK_TTL_MIN is flagged —
#                the agent died while the server was down and no [[startup]]
#                reconcile has appended its exit reason=lost yet. Younger
#                un-live records are a note, not a finding: the next
#                reconcile marks them lost inside the same window a stale
#                board claim gets. The per-record lines are capped and the
#                COUNT is always printed (GH-2023) — see the phase.
#   containment  a third question, riding the live side's single-record pass
#                (GH-2361): does a live agent's LATEST recorded tool_binding /
#                process_containment (GH-2267) match what its role's registry
#                row requires — `accepted` tool_binding for every non-driver
#                role, `not_requested`/`not_requested` for the driver? GH-2267
#                shipped the fields and their readers with zero callers; this
#                is the first. A record with no role or no words is skipped,
#                never flagged — those predate the model, and "not recorded"
#                must not render as "recorded and off". Process containment
#                accepts a SECOND non-gap word, `inapplicable`, but ONLY for
#                the investigator: its own harness definition grants no Bash
#                to sandbox, so its spawn path (fleet.sh) records
#                `inapplicable` by design — a correct recording, not a
#                failed one. Every OTHER contained role keeps Bash
#                (`ralph_tool_binding_args` only ever touches Edit/Write/
#                NotebookEdit), so `inapplicable` there would be the exact
#                unsandboxed-writer hole this check exists to catch, and
#                still gaps (review findings on this unit, GH-2361).
#
# The ledger side's remedy is SPLIT by what reconcile can actually do with the
# record (GH-2066). reconcile's ownership proof is positive and two-sided — a
# pane this server holds, or the session key that wrote the record — and a
# record carrying NEITHER (every record written before the session stamp
# existed) is one no reconcile pass can ever sweep. Observed 2026-08-17: a
# pass cleared 15 records and left three exactly as they were while this check
# went on naming the pass as their remedy. An advisory line survives only
# while it is true, so those records name `reconcile.sh --adopt <ledger>` —
# the operator assertion built for them (GH-1944) — with the path resolved,
# since the flag refuses a bare invocation by design.
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
#   RALPH_LINEAGE_STALE_MAX   most stale-open records to list individually
#                             (default 10; 0 lists none). Suppressed records
#                             still count as findings — only the enumeration
#                             is bounded.
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
# shellcheck source=roles.sh
. "$SCRIPT_DIR/roles.sh"

HERDR="${HERDR_BIN_PATH:-herdr}"
TTL_MIN="${RALPH_LOCK_TTL_MIN:-120}"
case "$TTL_MIN" in
  '' | *[!0-9]* | 0*) echo "doctor-lineage.sh: RALPH_LOCK_TTL_MIN must be a positive integer (got '$TTL_MIN')" >&2; exit 64 ;;
esac
# 0 is meaningful here — enumerate nothing, report only the count.
STALE_MAX="${RALPH_LINEAGE_STALE_MAX:-10}"
case "$STALE_MAX" in
  '' | *[!0-9]*) echo "doctor-lineage.sh: RALPH_LINEAGE_STALE_MAX must be a non-negative integer (got '$STALE_MAX')" >&2; exit 64 ;;
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
# stderr to a file, never merged: on success `2>&1` would prepend a diagnostic
# line to the JSON, ralph_herd_by_scope would yield nothing, and this check
# would report every open record as a gap — findings invented by the capture.
_snap_err=$(ralph_diag_file)
if ! raw=$(ralph_herdr_snapshot 2>"$_snap_err"); then
  note "lineage" "not evaluable — herdr snapshot unavailable ($(ralph_diag_read "$_snap_err"))"
  rm -f "$_snap_err"
  exit 2
fi
rm -f "$_snap_err"
# Tagged with each agent's repository, because a name is only meaningful
# WITHIN one: two repositories in one session both produce `w42-fix`, and
# comparing across them would report one repository's live agent as the other's
# missing record — a gap invented by the check itself.
live_json=$(ralph_herd_by_scope "$raw" 2>/dev/null) || live_json=""
live_names=$(printf '%s\n' "$live_json" | jq -r 'select(.name != null) | .name' 2>/dev/null) || live_names=""
# The pane half of reconcile's ownership proof, read the same way it reads it:
# every pane_id this server holds, unscoped. A pane is a server-wide fact, not
# a repository-scoped one, and reconcile compares against exactly this set.
server_panes=$(printf '%s' "$raw" | jq -r '(.panes // [])[] | .pane_id // empty' 2>/dev/null | tr '\n' ' ') || server_panes=""

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

# ── open ledger records, as US-separated "FILE + open row" lines ─────────────
# $RALPH_HERDR_LEDGER pins one file (tests); otherwise every board scope's
# ledger is scanned — live agents can belong to any repo's board.
#
# Rows rather than bare refs (GH-2066): the ledger side needs each record's
# `pane` and `session`, the two halves of reconcile's ownership proof, to say
# which remedy clears it. US (0x1f) is the separator ralph_ledger_open_rows
# already emits, and it is not tab for the reason stated there — tab is IFS
# whitespace, so two adjacent empty columns would collapse into one and shift
# every field after them, and a pre-session-key record's trailing columns are
# empty by definition.
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

open_rows=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    open_rows="$open_rows$f$row
"
  done < <(RALPH_HERDR_LEDGER="$f" ralph_ledger_open_rows || true)
done < <(ledger_files)

# ── live side: exactly one open record per live ralph agent ──────────────────
live_checked=0
while IFS= read -r name; do
  [ -n "$name" ] || continue
  case "$name" in
    ralph-deliver | ralph-tend)
      note "lineage-$name" "legacy singleton lane (pre-GH-2342 name) — no ledger identity by design"
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
  matched_ref="" matched_file=""
  while IFS=$'\037' read -r pf pref _rest; do
    [ -n "$pref" ] || continue
    in_ledger_scope "$name" "$pf" || continue
    case "${pref%%#*}" in
      "$name") count=$((count + 1)); matched_ref="$pref"; matched_file="$pf" ;;
    esac
  done <<EOF_ROWS
$open_rows
EOF_ROWS
  case "$count" in
    1)
      pass "lineage-$name" "one open ledger record"
      # containment exception naming (GH-2361, GH-2267's ledgered-but-unread
      # fields): a single well-formed record is the only shape with one
      # latest-words state to compare, so this rides the pass branch rather
      # than re-walking the ledger. Skipped on an empty role or empty words —
      # those are pre-GH-2267/pre-role-model records, and "not recorded" must
      # never render as "recorded and off" (roles.sh's CONTAINMENT_OUTCOMES
      # doc, ledger.sh's latest_tool_binding/latest_process_containment).
      role=$(RALPH_HERDR_LEDGER="$matched_file" _ralph_ledger_latest_role "$matched_ref" 2>/dev/null) || role=""
      if [ -n "$role" ]; then
        tb=$(RALPH_HERDR_LEDGER="$matched_file" _ralph_ledger_latest_tool_binding "$matched_ref" 2>/dev/null) || tb=""
        pc=$(RALPH_HERDR_LEDGER="$matched_file" _ralph_ledger_latest_process_containment "$matched_ref" 2>/dev/null) || pc=""
        if [ -n "$tb" ] && [ -n "$pc" ]; then
          exp_tb="not_requested"
          ralph_role_tool_binding "$role" && exp_tb="accepted"
          # `inapplicable` is a SECOND non-gap answer, but ONLY for the
          # investigator (review finding on this unit, GH-2361: a first
          # draft accepted it for every non-driver role, which would have
          # let an unsandboxed tender/orchestrator/watcher/relay — every one
          # of which keeps Bash, per `ralph_tool_binding_args` — pass as
          # healthy). `inapplicable` means the role's OWN harness definition
          # grants no Bash for a sandbox to hold; today that is true only of
          # the investigator (`ralph/agents/investigator.md`, and the only
          # caller that ever writes the word — fleet.sh's spawn_investigator).
          # Every other contained role must show a real kernel denial.
          if ralph_role_process_containment "$role"; then
            exp_pc="applied"
            case "$role" in
              investigator) case "$pc" in applied | inapplicable) pc_ok=1 ;; *) pc_ok=0 ;; esac ;;
              *) [ "$pc" = "applied" ] && pc_ok=1 || pc_ok=0 ;;
            esac
          else
            exp_pc="not_requested"
            [ "$pc" = "$exp_pc" ] && pc_ok=1 || pc_ok=0
          fi
          if [ "$tb" != "$exp_tb" ] || [ "$pc_ok" -ne 1 ]; then
            exp_pc_note=""
            [ "$role" = investigator ] && exp_pc_note=" (or inapplicable)"
            gap "containment-$name" "role $role achieved tool_binding=$tb process_containment=$pc (expected $exp_tb/$exp_pc$exp_pc_note)"
          fi
        fi
      fi
      ;;
    0) gap "lineage-$name" "live agent with NO open ledger record — run the reconcile action (the [[startup]] pass heals this on server restart)" ;;
    *) gap "lineage-$name" "$count open ledger records — duplicate identity; the ledger reads would race" ;;
  esac
done <<EOF
$live_names
EOF

# ── ledger side: open records with no live agent, older than the TTL ─────────
#
# The per-record lines are CAPPED (GH-2023). Measured 2026-08-16 on the live
# ledgers: 36 of 39 open records were stale, so this side emitted 36 GAP lines
# — one remedy, repeated 36 times, burying the live-side findings that each
# name their own. Past the cap the records still COUNT as findings (a
# suppressed gap is not a healed one); only their enumeration stops, and the
# summary below says how many were withheld.
now=$(date -u +%s)
open_checked=0
stale_total=0
stale_shown=0
unownable_total=0
while IFS=$'\037' read -r f ref pane _pid _harness _parent _state _issue _checkout _toks session; do
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
  # Which remedy can clear this record (GH-2066) — reconcile's own proof,
  # asked the way reconcile asks it: a pane this server holds, or the session
  # key that wrote the record. Either one and the next pass sweeps it. Neither
  # and no pass ever will: the writer is unknowable from the ledger, so only
  # an operator can assert it. A record whose session key belongs to some
  # OTHER server stays on the reconcile wording deliberately — that pass has
  # not run here, which is a different claim from cannot run, and the honest
  # failure direction for a wording fix is toward the remedy that might work.
  ownable=""
  if [ -n "$pane" ]; then
    case " $server_panes " in
      *" $pane "*) ownable=1 ;;
    esac
  fi
  [ -n "$session" ] && ownable=1
  if [ -n "$ownable" ]; then
    remedy="reconcile has not run; run the reconcile action"
    lost_remedy="reconcile should mark it lost"
    fresh_remedy="the next reconcile marks it lost"
  else
    # The ledger path is resolved into the line because --adopt refuses a bare
    # invocation by design (GH-1944): the flag names the ledger the operator
    # actually inspected, so a remedy that made the reader go find the path
    # would be one more step between a true finding and the action that clears
    # it.
    remedy="no ownership proof (pre-session-key record), so reconcile cannot clear this; inspect and assert: bash $SCRIPT_DIR/reconcile.sh --dry-run --adopt $f"
    lost_remedy="$remedy"
    fresh_remedy="$remedy"
  fi
  ts=$(RALPH_HERDR_LEDGER="$f" ralph_ledger_last "$ref" 2>/dev/null | jq -r '.ts // empty' 2>/dev/null) || ts=""
  if [ -z "$ts" ] || ! ep=$(iso_to_epoch "$ts"); then
    stale_total=$((stale_total + 1))
    [ -n "$ownable" ] || unownable_total=$((unownable_total + 1))
    if [ "$stale_shown" -lt "$STALE_MAX" ]; then
      stale_shown=$((stale_shown + 1))
      gap "lineage-$ref" "open record with no live agent and no readable timestamp — $lost_remedy"
    else
      FINDINGS=$((FINDINGS + 1))
    fi
    continue
  fi
  age_min=$(((now - ep) / 60))
  if [ "$age_min" -ge "$TTL_MIN" ]; then
    stale_total=$((stale_total + 1))
    [ -n "$ownable" ] || unownable_total=$((unownable_total + 1))
    if [ "$stale_shown" -lt "$STALE_MAX" ]; then
      stale_shown=$((stale_shown + 1))
      gap "lineage-$ref" "open record, no live agent, last event $ts (${age_min}m ago >= TTL ${TTL_MIN}m) — $remedy"
    else
      FINDINGS=$((FINDINGS + 1))
    fi
  else
    note "lineage-$ref" "open record, no live agent, last event ${age_min}m ago (< TTL ${TTL_MIN}m) — $fresh_remedy"
  fi
done <<EOF3
$open_rows
EOF3

# The accumulation line (GH-2023) — printed at EVERY verdict, including the
# clean one. The count of stale-open records is the growth curve of a reconcile
# that has stopped landing: 36 of them was the tell that the [[startup]] hook's
# output had been routed nowhere for weeks (GH-1900). A number only visible
# when there is nothing to report is not a curve anyone can watch, and a number
# only visible when it is already large is a number nobody saw grow.
#
# The count is also split (GH-2066): "3 stale open record(s). One reconcile
# pass closes all of them" was read as three actionable items on a board where
# zero of them were actionable by the named pass. A number is only a curve
# anyone can watch while the sentence beside it is true.
if [ "$unownable_total" -gt 0 ]; then
  adopt_tail="; $unownable_total of them have no ownership proof — no reconcile pass clears those, only reconcile.sh --adopt <ledger>"
else
  adopt_tail=""
fi
if [ "$stale_total" -gt "$stale_shown" ]; then
  if [ "$unownable_total" -eq 0 ]; then
    sweepable="One reconcile pass closes all of them"
  elif [ "$unownable_total" -eq "$stale_total" ]; then
    sweepable="No reconcile pass closes any of them"
  else
    sweepable="One reconcile pass closes the $((stale_total - unownable_total)) with ownership proof"
  fi
  echo "  note lineage-stale-open — $stale_total stale open record(s); $((stale_total - stale_shown)) not listed (cap RALPH_LINEAGE_STALE_MAX=$STALE_MAX). $sweepable$adopt_tail"
else
  echo "  note lineage-stale-open — $stale_total stale open record(s) of $open_checked open$adopt_tail"
fi

if [ "$FINDINGS" -eq 0 ]; then
  pass "lineage" "closed ($live_checked live ledgered agent(s), $open_checked open record(s))"
  exit 0
fi
if [ "$unownable_total" -gt 0 ]; then
  echo "  $FINDINGS lineage finding(s) — $unownable_total need an operator assertion (reconcile.sh --adopt), not a reconcile pass"
else
  echo "  $FINDINGS lineage finding(s)"
fi
exit 1
