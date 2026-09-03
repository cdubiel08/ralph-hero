#!/usr/bin/env bash
# tend-pass.sh — cockpit action: one /ralph:tend pass, one lane tab.
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
# is named from the LANE (the word the skill already spells: /ralph:tend),
# never a third vocabulary. Without the marker the pre-GH-2317 shape
# survives — a fresh lane tab whose root pane hosts the agent, this
# terminal the watcher — because a pane WITHOUT it sits in a tab someone
# else owns (a bare shell, invoke.sh's default split placement, a
# hand-opened plugin pane) and renaming or splitting that tab would disrupt
# surfaces this lane never created.
#
# LEDGERED (GH-2342). The pass is a spawn like every other: named `t0-tend`
# (grammar B — lane t is the tender role's own letter, issue 0 is the
# "belongs to no unit" convention s0-watch / x0-relay / d0-fork already use),
# so it mints a durable ref and writes the same provisional C7 row every
# spawn path writes, and the GH-2267 outcomes — tool binding, process
# containment — land on the ledger as a `containment` event instead of only
# in this pane's log. Before this the fixed name `ralph-tend` parsed in no
# grammar, so no ref could be minted and a reader who was not present could
# not tell a contained tender pane from an inert one off the ledger. The name
# is still FIXED — no epoch, no generation suffix — so the one-live-pass-per-
# lane interlock below (name taken → die) is unchanged. `ralph-tend` panes
# from an older plugin stay recognised as legacy singletons by every reader.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

trap hold_pane EXIT

billing_guard
ralph_plugin_freshness_notice

lane=tend
agent=t0-tend

next=$("$BOARD" tend-queue --json | jq -r '.next.number // empty')
if [ -z "$next" ]; then
  echo "$lane queue empty — nothing to spawn"
  exit 0
fi

# ONE LIVE PASS PER LANE also holds across the rename (PR #2354 P1): a pane
# spawned by a pre-0.42 plugin is still live under the OLD fixed name, and the
# `agent start` name interlock below keys on the new one only — so the legacy
# name is checked here, by hand, before any surface exists. Fails CLOSED on
# an unreadable herd (PR #2354 P1): the start's own name-taken refusal guards
# the NEW name only, so "could not read" may not render as "no legacy pass" —
# and a herdr that cannot answer a snapshot would refuse the split and the
# start that follow anyway, so the refusal costs nothing the lane would have
# had. An empty herd is a successful read; only a failed one refuses.
herd=$(ralph_agents_json 2>/dev/null) ||
  die "cannot read the herd, so a live pre-0.42 $lane pass (ralph-$lane) cannot be ruled out — one live pass per lane; not spawning $agent until herdr answers"
legacy_live=$(printf '%s' "$herd" | jq -r --arg n "ralph-$lane" 'select(.name == $n) | .name' 2>/dev/null | head -1) || legacy_live=""
[ -z "$legacy_live" ] ||
  die "a $lane pass is already live under its pre-0.42 name ($legacy_live) — one live pass per lane; let it finish (or close its pane) before starting $agent"

# The tender role does not write a tree (roles.sh/contracts.ts ROLES). GH-2265:
# read the tool-binding rule from the registry rather than restate it here.
tool_args=()
while IFS= read -r out; do tool_args+=("$out"); done < <(ralph_tool_binding_args tender)

# Process containment (GH-2266) — the OTHER mechanism on the same registry
# row, deliberately a separate call (opposite failure direction; see
# roles.sh). Resolved BEFORE any surface exists: a platform this was never
# measured on, or an unbuildable profile, refuses here at zero cost. The
# exit status is read off the helper directly — a `while read … < <(cmd)`
# loop reports the last `read`, never the producer.
#
# GH-2360: the platform half is checked FIRST and by hand, ahead of the ref
# mint and provisional row this pass otherwise writes only after `agent
# start` — so a non-Darwin host used to die here with nothing durable
# behind it, unable to tell "refused, platform unmeasured" from "never
# attempted" (the stderr-only paperwork GH-2267 named). Mint the ref, write
# the provisional row, record the containment event and close it
# `containment_not_available` — same shape the probe's own refusals use
# further down — then die. A dry run still refuses, but PRINTS the appends
# it would make and writes none: dry-run stops before ANY mutation, ledger
# appends included (the plan below says so), and a refusal is no exception.
if ralph_role_process_containment tender && ! ralph_process_containment_platform >/dev/null; then
  ref=$(ralph_agent_ref "$agent" 2>/dev/null) || ref=""
  ledger=$(ralph_ledger_path "$REPO" 2>/dev/null) || ledger=""
  tool_binding=$(ralph_tool_binding_observed "${tool_args[@]}")
  if [ "${RALPH_HERDR_DRY_RUN:-}" = "true" ]; then
    echo "DRY RUN — would record the refused $lane pass (nothing written):"
    echo "  ledger append (spawn): provisional row for ${ref:-<no ref>}"
    echo "  ledger append (containment): {ev: \"containment\", agent_ref: \"${ref:-<no ref>}\", tool_binding: \"$tool_binding\", process_containment: \"not_available\", via: \"spawn\"}"
    echo "  ledger append (exit): {ev: \"exit\", agent_ref: \"${ref:-<no ref>}\", reason: \"containment_not_available\", via: \"spawn\"}"
  elif [ -n "$ref" ] && [ -n "$ledger" ]; then
    record=$(_ralph_spawn_record "$ref" 0 "" "" "" "" "$(date -u +%FT%TZ)" \
      "" "$REPO" tender "" "" "" "" "" "" "") || record=""
    if [ -n "$record" ]; then
      RALPH_HERDR_LEDGER="$ledger" ralph_ledger_append "$record" ||
        echo "spawn ledger append failed for $ref — reconcile will discover it" >&2
    fi
    _ralph_spawn_containment_event "$ref" "$ledger" "$tool_binding" not_available
    _ralph_spawn_close "$ref" "$ledger" containment_not_available
  fi
  die "process containment not_available for the tender (see the reason above) — not spawning an uncontained $lane pane"
fi
contain_out=$(ralph_process_containment_args tender "$REPO") ||
  die "process containment cannot be established for the tender (see the reason above) — not spawning an uncontained $lane pane"
contain_args=()
while IFS= read -r out; do [ -n "$out" ] && contain_args+=("$out"); done < <(printf '%s\n' "$contain_out")
# The lane's model (GH-2350), appended LAST so the binding/containment argv
# a reader already recognises keeps its shape; an unridable value refuses.
model=$(ralph_lane_model "$lane" "$REPO") ||
  die "the $lane model could not be resolved (see the reason above) — not spawning $agent"
harness_args=("${tool_args[@]}" "${contain_args[@]}")
[ -n "$model" ] && harness_args+=(--model "$model")
# GH-2267: the tool-binding outcome, read off the argv the pane will be
# handed — never off the registry row. It is recorded on the `containment`
# event beside the probe's verdict once both are known (GH-2342); a writing
# tool left enabled refuses here, before any surface exists.
tool_binding=$(ralph_tool_binding_observed "${harness_args[@]}")
[ "$tool_binding" != not_applied ] ||
  die "tool binding not_applied for the tender (a writing tool is left enabled by: ${harness_args[*]}) — not spawning a writer into $REPO"

if [ "${RALPH_HERDR_DRY_RUN:-}" = "true" ]; then
  echo "DRY RUN — would spawn $lane pass (queue head #$next):"
  echo "  agent: $agent"
  if [ "${RALPH_HERDR_LANE_TAB:-}" = "1" ] && [ -n "${HERDR_PANE_ID:-}" ]; then
    echo "  $HERDR tab rename <own tab> $lane"
    echo "  $HERDR pane split $HERDR_PANE_ID --direction down --cwd $REPO --no-focus"
  else
    echo "  $HERDR tab create --cwd $REPO --label \"$lane\" --no-focus"
  fi
  echo "  $HERDR agent start $agent --kind claude --pane <captured>${tool_args[*]:+ -- ${tool_args[*]}}${contain_args[*]:+ --settings <process containment: seatbelt denyWrite $REPO>}${model:+ --model $model}"
  [ "${#contain_args[@]}" -gt 0 ] &&
    echo "  containment probe: prompt <captured> to touch <inside $REPO> <outside \$RALPH_HOME/containment-probes>; refuse unless applied; then Write <inside $REPO> and a control touch — refuse on tool binding not_applied (GH-2341)"
  echo "  tool binding: $tool_binding (read off the argv above — GH-2267; recorded on the containment event beside the probe verdict, after the in-pane Write step has had its say)"
  echo "  $HERDR agent prompt $agent \"/ralph:$lane\""
  # The exact spawn record the live path would append (pane_id omitted — pane
  # ids are captured live, never predicted) and the containment event that
  # follows the probe. Printed, never written: dry-run stops before ANY
  # mutation, ledger appends included.
  if ref=$(ralph_agent_ref "$agent" 2>/dev/null); then
    record=$(_ralph_spawn_record "$ref" 0 "" "" "" "" "$(date -u +%FT%TZ)" "" "$REPO" tender "" "" "" "" "" "" "$model") || record=""
    echo "  ledger append (spawn): ${record:-<could not build the record>}"
    echo "  ledger append (containment, after the probe): {ev: \"containment\", agent_ref: \"$ref\", tool_binding: \"$tool_binding\", process_containment: <probe verdict>, via: \"spawn\"}"
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
  pane=$(printf '%s' "$s" | jq -r '.pane.pane_id // empty')
  [ -n "$pane" ] || die "no pane id in split response"
  cleanup_pane="$pane" cleanup_tab=""
else
  t=$(ralph_herdr_tab_create "$lane")
  pane=$(printf '%s' "$t" | jq -r '.root_pane.pane_id // empty')
  [ -n "$pane" ] || die "no pane id in tab response"
  cleanup_pane="" cleanup_tab=$(printf '%s' "$t" | jq -r '.tab.tab_id // empty')
fi

# Provisional C7 record at pane creation (audit D2b parity with
# spawn_work_session and work-team.sh): a launcher killed between the split
# and `agent start` leaves a sweepable row instead of nothing. role=tender,
# issue 0, checkout = the tree the sandbox denies. Both containment fields
# are left EMPTY here — neither outcome exists until the probe has run — and
# land as their own `containment` event below (GH-2267), on success and on
# refusal alike. A ref that cannot be minted degrades exactly as every other
# spawn path does: unledgered, and reconcile phase B discovers the live pane.
ts=$(date -u +%FT%TZ)
shell_pid=$(ralph_herdr_call pane_process_info pane process-info --pane "$pane" 2>/dev/null |
  jq -r '.process_info.shell_pid // empty' 2>/dev/null) || shell_pid=""
case "$shell_pid" in '' | *[!0-9]*) shell_pid="" ;; esac
record="" ledger=""
ref=$(ralph_agent_ref "$agent" 2>/dev/null) || ref=""
if [ -n "$ref" ]; then
  record=$(_ralph_spawn_record "$ref" 0 "" "" "" "$pane" "$ts" "$shell_pid" "$REPO" tender "" "" "" "" "" "" "$model") || record=""
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
if ! agent_start_when_ready "$agent" "$pane" "${harness_args[@]}"; then
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

# The positive self-test (GH-2266): a live pane is not a contained pane until
# the kernel has been SEEN to refuse it. Anything but `applied` closes the
# surface this run created — the agent has taken no pass yet, so nothing is
# lost — and the pass fails naming the outcome.
if [ "${#contain_args[@]}" -gt 0 ]; then
  # Two words (GH-2341): the process verdict, then the tool-binding word —
  # which the probe's Write step can only REFUTE, never promote.
  probe_out=$(spawn_containment_probe "$agent" "$pane" "$REPO" "re-run the $lane pass" "$tool_binding") || {
    read -r outcome tool_binding < <(printf '%s' "${probe_out:-unverified $tool_binding}")
    # The refusal is recorded as the two achieved values BEFORE the row is
    # closed (GH-2267): a reader who was not present must be able to tell
    # this pane from a contained one off the ledger alone. The close reason
    # names the mechanism that refused (work-team.sh parity).
    _ralph_spawn_containment_event "$ref" "$ledger" "$tool_binding" "${outcome:-unverified}"
    if [ "$tool_binding" = not_applied ]; then
      _ralph_spawn_close "$ref" "$ledger" "tool_binding_not_applied"
    else
      _ralph_spawn_close "$ref" "$ledger" "containment_${outcome:-unverified}"
    fi
    [ -n "$cleanup_pane" ] && "$HERDR" pane close "$cleanup_pane" >/dev/null 2>&1 || true
    [ -n "$cleanup_tab" ] && "$HERDR" tab close "$cleanup_tab" >/dev/null 2>&1 || true
    RALPH_HERDR_AGENT_LIVE=""
    die "process containment ${outcome:-unverified} for $agent, tool binding $tool_binding (pane $pane) — an uncontained $lane pane must not receive its prompt; closed the surface this run created (the probe's reason is above)"
  }
  read -r outcome tool_binding < <(printf '%s' "$probe_out")
  echo "process containment: $outcome for $agent (a Bash write inside $REPO was refused by the kernel; tool binding is the separate GH-2265 mechanism)"
else
  outcome=not_requested
fi
echo "tool binding: $tool_binding for $agent (the harness accepted the flags at start${contain_args[*]:+ and the in-pane Write step wrote nothing in $REPO}; applied is reserved for an observed refusal — GH-2341)"
# The provisional record predates both outcomes, so they land as their own
# event now that they are known (GH-2342 — the row is what outlives this log).
_ralph_spawn_containment_event "$ref" "$ledger" "$tool_binding" "$outcome"

# Spawn-time tokens onto the pane, derived from the record (role, issue,
# root, depth, state …) — the same push every spawn path makes, after the
# agent is live so a lost start race never stamps over a winner.
if [ -n "$record" ]; then
  set --
  while IFS= read -r kv; do
    [ -n "$kv" ] || continue
    set -- "$@" "$kv"
  done < <(printf '%s' "$record" | jq -r '.tokens | to_entries[] | "\(.key)=\(.value)"' 2>/dev/null || true)
  [ "$#" -ge 1 ] && ralph_tokens_push "$pane" "$@"
fi

ralph_herdr_agent_prompt "$agent" "/ralph:$lane" >/dev/null \
  || die "prompt delivery failed — agent $agent is LIVE and idle in pane $pane; prompt it manually: herdr agent prompt $agent \"/ralph:$lane\""

echo "spawned $lane pass (queue head #$next, pane $pane, agent $agent)"

exec "$SCRIPT_DIR/notify-watch.sh" "$agent"
