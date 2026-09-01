#!/usr/bin/env bash
# doctor-labels.sh — canonical-workspace-label check (GH-2210, topology B).
#
# The workspace label is CANONICAL when it matches the DISPLAY form of the
# herd address the spawner derived (GH-2209, display rule GH-2235): the
# address is absolute, the label is its shortest unambiguous suffix given
# the container the sidebar renders it in — a worker's worktree workspace is
# labelled the address's leaf (`<lane><issue>-<slug>`), and a team space the
# leaf of the address's team prefix (`t<epic>-<slug>`) — the space hosts the
# lead, it is not the lead. A label carrying the pre-2235 ABSOLUTE spelling
# still passes (it matched its derivation when spawned; a respawn shortens
# it). READ-ONLY, like its siblings:
# herdr has NO rename verb (labels are creation-time only), so nothing here
# heals — the remedy is always a respawn under the current plugin, which
# re-derives the label from the same grammar.
#
# The EXPECTED value is the ledger-stamped `tokens.address` (the spawn
# record, GH-2209/D0.4), never a fresh `board name` per agent: the stamp IS
# the spawn-time derivation, and this keeps the check zero-board-reads like
# every other doctor-*.sh here. Honest limit: an issue retitled after spawn
# re-derives to a DIFFERENT address, which this check cannot see — it compares
# the label against what the spawner actually derived, not against what a
# fresh derivation would say today. A record with no address token predates
# the grammar and is skipped (counted, never flagged: it cannot state its
# derivation).
#
# Output: herdr-setup.sh check style (`  ok   ` / `  GAP  ` / `  note `).
# ralph/scripts/herdr-setup.sh relays the verdict NOTE-level into `board
# doctor`'s herdr-cockpit line, same contract as doctor-lineage.sh — a label
# divergence is cockpit chrome telemetry, never a wiring gap.
#
# Exit codes: 0 canonical · 1 divergence(s) · 2 not evaluable (no herdr /
# server down) · 64 bad invocation.
#
# Knobs:
#   RALPH_HERDR_LEDGER        check exactly this ledger file (tests; default:
#                             scan every ~/.ralph/<owner>/<repo>/ledger.jsonl)
#   RALPH_HERDR_LEDGER_ROOT   ledger root dir (default ~/.ralph)
#   HERDR_BIN_PATH            herdr binary (default: `herdr` on PATH)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
[ "$#" -eq 0 ] || { echo "doctor-labels.sh: takes no arguments" >&2; exit 64; }

FINDINGS=0
pass() { echo "  ok   $1 — $2"; }
gap()  { FINDINGS=$((FINDINGS + 1)); echo "  GAP  $1 — $2"; }
note() { echo "  note $1 — $2"; }

# ── live herd + workspace labels, one snapshot ───────────────────────────────
if ! command -v "$HERDR" >/dev/null 2>&1; then
  note "labels" "not evaluable — herdr is not installed (looked for '$HERDR')"
  exit 2
fi
_snap_err=$(ralph_diag_file)
if ! raw=$(ralph_herdr_snapshot 2>"$_snap_err"); then
  note "labels" "not evaluable — herdr snapshot unavailable ($(ralph_diag_read "$_snap_err"))"
  rm -f "$_snap_err"
  exit 2
fi
rm -f "$_snap_err"
live_json=$(ralph_herd_by_scope "$raw" 2>/dev/null) || live_json=""

# label_of WORKSPACE_ID — the live label of a workspace, or empty.
label_of() {
  printf '%s' "$raw" | jq -r --arg w "$1" \
    '(.workspaces // [])[] | select(.workspace_id == $w) | .label // empty' 2>/dev/null | head -1
}

# workspace_of NAME — the workspace id hosting a live agent, or empty.
workspace_of() {
  printf '%s\n' "$live_json" | jq -r --arg n "$1" \
    'select(.name == $n) | .workspace // empty' 2>/dev/null | head -1
}

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

# ── every open ledger row with a LIVE agent: compare label vs address ────────
checked=0
unstamped=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  while IFS=$'\037' read -r ref _pane _pid _harness _parent _state _issue _checkout toks _session; do
    [ -n "$ref" ] || continue
    name=${ref%%#*}
    ws=$(workspace_of "$name")
    [ -n "$ws" ] || continue # not live (or unhosted) — a dead workspace's label is moot
    addr=$(printf '%s' "$toks" | jq -r '.address // empty' 2>/dev/null) || addr=""
    if [ -z "$addr" ]; then
      # Pre-grammar record: it cannot state its derivation, so it cannot
      # diverge from it. Counted, never flagged.
      unstamped=$((unstamped + 1))
      continue
    fi
    checked=$((checked + 1))
    label=$(label_of "$ws")
    # Canonical: the DISPLAY form (GH-2235) — the address's leaf (a worker's
    # worktree workspace), or the leaf of the address's team prefix (the team
    # space hosting a lead — the space is the team, not the agent). The
    # prefix arm only exists for a three-segment address; `${addr%/*}` of a
    # flat one would be the bare repo segment, which names nothing. The
    # pre-2235 ABSOLUTE spellings pass too: they matched their derivation
    # when spawned, and labels are creation-time only.
    team_prefix=""
    case "$addr" in */*/*) team_prefix="${addr%/*}" ;; esac
    display=$(ralph_address_display "$addr") || display=""
    team_display=""
    [ -n "$team_prefix" ] && { team_display=$(ralph_address_display "$team_prefix") || team_display=""; }
    if [ "$label" = "$display" ] || { [ -n "$team_display" ] && [ "$label" = "$team_display" ]; }; then
      pass "label-$name" "workspace label matches its derivation ($label)"
    elif [ "$label" = "$addr" ] || { [ -n "$team_prefix" ] && [ "$label" = "$team_prefix" ]; }; then
      pass "label-$name" "workspace label carries the pre-GH-2235 absolute spelling ($label) — a respawn shortens it to the display suffix"
    else
      gap "label-$name" "workspace label '${label:-<none>}' diverges from the derived address '$addr' — labels are creation-time only (no herdr rename verb); a respawn under the current plugin re-derives it"
    fi
  done < <(RALPH_HERDR_LEDGER="$f" ralph_ledger_open_rows || true)
done < <(ledger_files)

tail_note=""
[ "$unstamped" -gt 0 ] && tail_note="; $unstamped record(s) predate the address grammar (not evaluated)"
if [ "$FINDINGS" -eq 0 ]; then
  pass "labels" "canonical ($checked live labelled agent(s) checked$tail_note)"
  exit 0
fi
echo "  $FINDINGS label divergence(s) of $checked checked$tail_note"
exit 1
