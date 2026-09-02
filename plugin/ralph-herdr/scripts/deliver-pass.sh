#!/usr/bin/env bash
# deliver-pass.sh — cockpit action: one /ralph:deliver pass, one lane tab.
#
# Empty `next` means spawn nothing — the lane contract. The pass itself runs
# inside the spawned session; this script only reads the queue and builds
# herdr layout, then execs into notify-watch.sh so this pane becomes the
# pass's attention surface.
#
# ONE TAB PER LANE (GH-2317): lane-open.sh placed this launcher pane as a
# tab in the repo's MAIN workspace — marked RALPH_HERDR_LANE_TAB=1, the
# opener's assertion that the tab is its own artifact — so this pane IS the
# lane tab's script-log pane: the agent gets a split beside it, and the tab
# is named from the LANE (the word the skill already spells: /ralph:deliver),
# never a third vocabulary. Without the marker the pre-GH-2317 shape
# survives — a fresh lane tab whose root pane hosts the agent, this
# terminal the watcher — because a pane WITHOUT it sits in a tab someone
# else owns (a bare shell, invoke.sh's default split placement, a
# hand-opened plugin pane) and renaming or splitting that tab would disrupt
# surfaces this lane never created.
#
# LEDGERED (GH-2342). The pass is a spawn like every other: named
# `r0-deliver` (grammar B — lane r's default role is driver, which is what
# this pass IS: it rebases and pushes branches, so it is handed no tool
# binding and no sandbox; issue 0 is the "belongs to no unit" convention
# s0-watch / x0-relay / d0-fork already use), so it mints a durable ref and
# writes the same provisional C7 row every spawn path writes. Both GH-2267
# outcomes are `not_requested`, read off the EMPTY argv this path hands
# `agent start` — known at record time, so they ride the row itself and no
# later event is needed. The name is still FIXED — no epoch, no generation
# suffix — so the one-live-pass-per-lane interlock below (name taken → die)
# is unchanged. `ralph-deliver` panes from an older plugin stay recognised as
# legacy singletons by every reader.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

trap hold_pane EXIT

billing_guard
ralph_plugin_freshness_notice

lane=deliver
agent=r0-deliver

next=$("$BOARD" deliver-queue --json | jq -r '.next.number // empty')
if [ -z "$next" ]; then
  echo "$lane queue empty — nothing to spawn"
  exit 0
fi

if [ "${RALPH_HERDR_DRY_RUN:-}" = "true" ]; then
  echo "DRY RUN — would spawn $lane pass (queue head #$next):"
  echo "  agent: $agent"
  if [ "${RALPH_HERDR_LANE_TAB:-}" = "1" ] && [ -n "${HERDR_PANE_ID:-}" ]; then
    echo "  $HERDR tab rename <own tab> $lane"
    echo "  $HERDR pane split $HERDR_PANE_ID --direction down --cwd $REPO --no-focus"
  else
    echo "  $HERDR tab create --cwd $REPO --label \"$lane\" --no-focus"
  fi
  echo "  $HERDR agent start $agent --kind claude --pane <captured>"
  echo "  $HERDR agent prompt $agent \"/ralph:$lane\""
  # The exact spawn record the live path would append (pane_id omitted — pane
  # ids are captured live, never predicted). Printed, never written: dry-run
  # stops before ANY mutation, ledger appends included.
  if ref=$(ralph_agent_ref "$agent" 2>/dev/null); then
    record=$(_ralph_spawn_record "$ref" 0 "" "" "" "" "$(date -u +%FT%TZ)" "" "$REPO" driver "" "" "" "" \
      "$(ralph_tool_binding_observed)" not_requested) || record=""
    echo "  ledger append (spawn): ${record:-<could not build the record>}"
  fi
  exit 0
fi

if [ "${RALPH_HERDR_LANE_TAB:-}" = "1" ] && [ -n "${HERDR_PANE_ID:-}" ]; then
  # In-tab shape — only under the opener's own-tab marker: rename our tab
  # from the lane (best-effort — the label is chrome and a failed rename may
  # not cost the pass), then split the agent pane below. Full width for both
  # surfaces; the logs stay on top.
  tab=$(ralph_herdr_call pane_info pane get "$HERDR_PANE_ID" 2>/dev/null \
    | jq -r '.pane.tab_id // empty' 2>/dev/null) || tab=""
  if [ -n "$tab" ]; then
    "$HERDR" tab rename "$tab" "$lane" >/dev/null 2>&1 || true
  fi
  rc=0
  s=$(ralph_herdr_call pane_info pane split "$HERDR_PANE_ID" --direction down --cwd "$REPO" --no-focus) || rc=$?
  case "$rc" in
    0) ;;
    2) die "herdr refused to split the $lane tab for the agent pane: $(ralph_herdr_err_code "$s") — $(ralph_herdr_err_message "$s")" ;;
    3) die "herdr did not answer the $lane agent-pane split (unreachable, or timed out — a timed-out split may still have landed; check the tab before retrying)" ;;
    *) die "herdr's answer to the $lane agent-pane split was not a response this plugin can read — see the transport error above" ;;
  esac
  pane=$(jq -r '.pane.pane_id // empty' <<<"$s")
  [ -n "$pane" ] || die "no pane id in split response"
  cleanup_pane="$pane" cleanup_tab=""
else
  t=$(ralph_herdr_tab_create "$lane")
  pane=$(jq -r '.root_pane.pane_id // empty' <<<"$t")
  [ -n "$pane" ] || die "no pane id in tab response"
  cleanup_pane="" cleanup_tab=$(jq -r '.tab.tab_id // empty' <<<"$t")
fi

# Provisional C7 record at pane creation (audit D2b parity with
# spawn_work_session and work-team.sh): a launcher killed between the split
# and `agent start` leaves a sweepable row instead of nothing. role=driver,
# issue 0, checkout $REPO. GH-2267: this path hands `agent start` no harness
# argument at all — no binding flag, no sandbox document — so both outcomes
# are `not_requested`, read off that (empty) argv rather than off the role,
# and written so an absent field keeps meaning "a record from before this
# existed", never "known off". A ref that cannot be minted degrades exactly
# as every other spawn path does: unledgered, discovered by reconcile B.
ts=$(date -u +%FT%TZ)
shell_pid=$(ralph_herdr_call pane_process_info pane process-info --pane "$pane" 2>/dev/null |
  jq -r '.process_info.shell_pid // empty' 2>/dev/null) || shell_pid=""
case "$shell_pid" in '' | *[!0-9]*) shell_pid="" ;; esac
record="" ledger=""
ref=$(ralph_agent_ref "$agent" 2>/dev/null) || ref=""
if [ -n "$ref" ]; then
  record=$(_ralph_spawn_record "$ref" 0 "" "" "" "$pane" "$ts" "$shell_pid" "$REPO" driver "" "" "" "" \
    "$(ralph_tool_binding_observed)" not_requested) || record=""
  ledger=$(ralph_ledger_path "$REPO" 2>/dev/null) || ledger=""
  if [ -n "$record" ] && [ -n "$ledger" ]; then
    RALPH_HERDR_LEDGER="$ledger" ralph_ledger_append "$record" || {
      echo "spawn ledger append failed for $ref — reconcile will discover it" >&2
      record=""
    }
  else
    echo "spawn ledger: ${ledger:+record build failed}${ledger:-no board scope discoverable from $REPO} — reconcile will discover $ref" >&2
    record=""
  fi
else
  echo "no durable ref derivable for $agent — spawning unledgered (reconcile will discover it)" >&2
fi

# One live pass per lane: the unique agent name is the interlock. A
# name-taken refusal means a pass is already live — die, never suffix. On a
# REFUSED start the pane just created holds only an idle shell, so closing
# it is cleanup, not killing an agent — but an UNCERTAIN failure (transport
# error, silence) means the start may have LANDED, and the surface is left
# up rather than closed over a possibly-live agent (PR #2326 P1).
# The provisional row follows the same split: a REFUSED start proved no
# worker ever existed, so the row closes here (never_started); an UNCERTAIN
# one stays open for reconcile to prove, like the pane it describes.
if ! agent_start_when_ready "$agent" "$pane"; then
  if [ "${RALPH_HERDR_START_OUTCOME:-uncertain}" = "refused" ]; then
    _ralph_spawn_close "$ref" "$ledger" never_started
    [ -n "$cleanup_pane" ] && "$HERDR" pane close "$cleanup_pane" >/dev/null 2>&1 || true
    [ -n "$cleanup_tab" ] && "$HERDR" tab close "$cleanup_tab" >/dev/null 2>&1 || true
    die "agent start $agent refused — see the herdr error above (a live $lane pass owning the name is the common cause, but exhausted startup retries land here too); cleaned up the empty agent pane"
  fi
  die "agent start $agent did not answer — the start MAY have landed, so the agent pane is left up rather than closed over a possibly-live agent, and its ledger row stays open for reconcile to prove; check it (herdr agent list) before retrying"
fi
# Past this point the agent is LIVE — a prompt failure must not strand it
# silently, and hold_pane must not claim "no session spawned" about it.
export RALPH_HERDR_AGENT_LIVE=1

# Spawn-time tokens onto the pane, derived from the record — the same push
# every spawn path makes, after the agent is live so a lost start race never
# stamps over a winner.
if [ -n "$record" ]; then
  set --
  while IFS= read -r kv; do
    [ -n "$kv" ] || continue
    set -- "$@" "$kv"
  done < <(jq -r '.tokens | to_entries[] | "\(.key)=\(.value)"' <<<"$record" 2>/dev/null || true)
  [ "$#" -ge 1 ] && ralph_tokens_push "$pane" "$@"
fi
ralph_herdr_agent_prompt "$agent" "/ralph:$lane" >/dev/null \
  || die "prompt delivery failed — agent $agent is LIVE and idle in pane $pane; prompt it manually: herdr agent prompt $agent \"/ralph:$lane\""

echo "spawned $lane pass (queue head #$next, pane $pane, agent $agent)"

exec "$SCRIPT_DIR/notify-watch.sh" "$agent"
