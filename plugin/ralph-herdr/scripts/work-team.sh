#!/usr/bin/env bash
# work-team.sh — cockpit action: TEAM LAUNCH (GH-2214, unit F of #2208;
# supersedes the GH-2178 lead+fleet form). Spawn the standing o-lane LEAD for
# ONE epic and STOP — the lead staffs and owns its workers itself.
#
#   work-team.sh EPIC
#   work-team.sh EPIC --lead-only   # accepted for compatibility; same thing
#
# LEAD-ONLY BY DESIGN (D3.2, an operator deviation recorded in
# thoughts/shared/plans/2026-08-28-herd-topology-design.md): "dispatch
# shouldn't spawn the things lead should own; the lead intrinsically knows
# the workers it created." This script therefore spawns NO workers and takes
# no issue list — the lead runs `work-fleet.sh --epic EPIC` from its own
# pane, under the same fleet guards (deps, cap, billing, spawn edge) run BY
# the lead, which makes lead↔worker a hub lane by construction (GH-1890:
# spawner↔spawned). Out-of-team work stays plain `work-fleet.sh NNN`.
#
# THE LEAD (design decision 4, thoughts/shared/plans/2026-08-26-teams-
# dispatch-inbox-design.md): the team's orchestrator — a standing pane living
# the epic's lifetime, read-only by role (roles.sh `orchestrator`: may spawn
# driver/investigator/tender, never writes a tree), REHYDRATABLE FROM BOARD
# STATE ALONE. The spawn brief deliberately carries no state beyond the epic
# number, the role bounds and the chain-of-command addresses (all derived,
# D4.2): everything the lead knows lives on the board, so a dead lead is
# respawned by re-running this script and loses nothing.
#
# RESPAWN IS IDEMPOTENT RE-RUN. A live o<EPIC>-* lead is skipped (the herd
# read is the liveness oracle, fail-closed like every spawn pre-check); a dead
# one is simply spawned again. The event healer (heal.sh, GH-2212) re-runs
# this on the lead's pane.exited; `--lead-only` is retained so its call sites
# keep working — it names what is now the only behavior.
#
# THE TEAM SELF-DISSOLVES (D3.3, GH-2215, an operator deviation: "very
# guaranteed but also fast and efficient"). The brief's close-out makes the
# lead remove its own team space as its FINAL act — `herdr workspace close
# $HERDR_WORKSPACE_ID` (the space is a plain workspace with no worktree, so
# `workspace close` is the verb; nothing on disk is touched) — the pane dies
# with the space, by intent. The GUARANTEE is the backstop, not the primary:
# a lead that dies mid-dissolve is flagged by heal.sh (ev "orphan_space")
# and removed by `herdr-setup.sh sweep` under its liveness proofs — an
# orphan costs one sweep, never forever.
#
# THE TEAM SPACE is a herdr WORKSPACE (`workspace create`), because that is
# the one pane-creating call that carries `--env` (probed on the installed
# 0.8.x CLI; `worktree create` does not) — and herdr panes inherit the
# SERVER's environment, never the spawner's shell (lib.sh's BOARD resolution
# note), so `--env` is the only channel that survives into the lead's shell.
# The lead's env carries:
#   RALPH_HERDR_LEAD=<lead>       fleet-send's lead detector (its env half —
#                                 the o-lane name check is the other)
#   RALPH_HERDR_TEAM_LEAD=<lead>  the spawner-side signal: fleets the lead
#                                 itself launches propagate the lead's address
#                                 into their workers' panes (spawn_work_session
#                                 injects it) without re-derivation
#   RALPH_HERDR_TEAM_LEAD_REF=<ref>  the lead's durable ref (name#epoch):
#                                 worker spawn records the lead performs carry
#                                 parent/root/depth lineage from it (D4.1 —
#                                 the lead owns the workers it created)
#   RALPH_HERDR_SPAWNER_ROLE=orchestrator  the fleet's spawn-edge guard reads
#                                 the true parent role (orchestrator→driver)
#   RALPH_HERDR_INVOKED_BY=agent  C1: spawns the lead performs are recorded
#                                 invoked_by=agent, not human
# The lead gets NO worktree and NO branch: it writes nothing, so it sits in
# the source checkout read-only.
#
# Knobs: RALPH_HERDR_DRY_RUN=true (plans everything, spawns nothing). The
# fleet-size knob belongs to the lead's own work-fleet runs, not to this
# script — it spawns exactly one pane.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

trap hold_pane EXIT

billing_guard

usage() {
  cat <<'EOF'
usage: work-team.sh EPIC [--lead-only]

  EPIC         the epic issue the team is scoped to. Its lead is the o-lane
               pane o<EPIC>-<slug>; a live one is never doubled (idempotent),
               a dead one is respawned by re-running this script.
  --lead-only  accepted for compatibility (heal.sh, GH-2212): lead-only is
               the only behavior now — team launch spawns the lead and stops.
  -h, --help   this.

The lead staffs its own workers (D3.2): from its pane it runs
  work-fleet.sh --epic EPIC     # ranked ready children, fleet guards run BY it
  work-fleet.sh NNN...          # the explicit override / out-of-team lane
Naming worker issues HERE is refused — dispatch does not spawn what the lead
owns.

Knobs: RALPH_HERDR_DRY_RUN=true.
EOF
}

EPIC=""
for arg in "$@"; do
  case "$arg" in
    --lead-only) ;; # compatibility no-op: lead-only is the only behavior
    -h | --help)
      trap - EXIT # --help is a read, not a pane session: don't hold for Enter
      usage
      exit 0
      ;;
    *[!0-9]* | "") die "unknown argument '$arg' (--lead-only, --help, or the epic number)" ;;
    *)
      if [ -z "$EPIC" ]; then
        EPIC="$arg"
      else
        die "a worker issue list is no longer taken here (D3.2: the lead staffs its own workers) — the lead runs work-fleet.sh --epic $EPIC; out-of-team work is plain work-fleet.sh $arg"
      fi
      ;;
  esac
done

# The cockpit pane has no argv to type into (work-these.sh precedent): prompt
# on a TTY, refuse on EOF — a non-TTY caller that named no epic made an error,
# and there is no default epic to fall back to.
if [ -z "$EPIC" ]; then
  if [ ! -t 0 ]; then
    echo "work-team.sh: no epic given and stdin is not a TTY — there is no default epic." >&2
    echo "  name it: work-team.sh EPIC" >&2
    exit 64
  fi
  echo "Ralph: team launch"
  echo "  the epic number this team is scoped to. The lead is spawned and"
  echo "  staffs its own workers from the epic's ready frontier (D3.2)."
  printf 'epic: '
  read -r EPIC || EPIC=""
  [ -n "$EPIC" ] || die "no epic named — nothing to do"
  case "$EPIC" in *[!0-9]*) die "epic must be an issue number (got '$EPIC')" ;; esac
fi

# The epic, read once from the board: the title feeds the lead's name slug,
# and a closed or complete epic has no team to stand up.
EPIC_JSON=$("$BOARD" get "$EPIC" --json 2>/dev/null) || die "board get $EPIC failed — is it on this board?"
jq -e '.number' <<<"$EPIC_JSON" >/dev/null 2>&1 || die "board get $EPIC --json returned no issue envelope"
# A complete or terminal epic has no team to stand up. Exit 4 is the CLEAN
# refusal, distinct from every error: the event-driven healer (heal.sh,
# GH-2212) reads it as "the self-dissolve backstop is working — do not
# notify", where any other nonzero rc is a failed respawn that demands
# attention. In Review on an epic ROOT means every child is closed
# (parent-check's rollup), so a lead respawned into it would rehydrate,
# find nothing to staff, and stop — a session spent confirming completion.
die_complete() {
  echo "${0##*/}: $*" >&2
  trap - EXIT
  exit 4
}
if [ "$(jq -r '.issueState // empty' <<<"$EPIC_JSON")" = "CLOSED" ]; then
  die_complete "GH-$EPIC is closed — a team stands for a live epic; reopen it or name a different one"
fi
case "$(jq -r '.state // empty' <<<"$EPIC_JSON")" in
  "In Review" | Done | Canceled)
    die_complete "GH-$EPIC is $(jq -r '.state' <<<"$EPIC_JSON") — every child is closed or the epic is terminal; no team to stand up"
    ;;
esac
TITLE=$(jq -r '.title // empty' <<<"$EPIC_JSON")

LEAD=$(ralph_agent_name o "$EPIC" "${TITLE:-team}") || die "could not derive a lead name for GH-$EPIC"

# The spawn edge, checked against the roles registry rather than assumed: this
# script is a cockpit action (a human click) unless a spawner states otherwise.
SPAWNER_ROLE="${RALPH_HERDR_SPAWNER_ROLE:-human}"
ralph_spawn_edge_guard "$SPAWNER_ROLE" orchestrator || die "spawn edge refused (see above)"

# Chain of command, DERIVED (D0.4/D4.2, GH-2209/GH-2210). The team ADDRESS
# is `<repo>/t<epic>-<slug>` — the team slug is byte-identical to the lead's
# own by construction (D0.3: both ride the same slugify/truncate pipeline),
# so the segment derives from $LEAD locally and the repo segment comes off
# the board's derived address. The workspace LABEL is that address's display
# suffix (GH-2235): the sidebar groups the space under the repo already, so
# the label drops the repo segment — `t<epic>-<slug>`, the tNNNN-semantic
# spelling. The lead's own herd address extends the full team address
# (`…/o<epic>-<slug>`) — board name's .address names the unit's DRIVER lane,
# so the o-lane form is spelled here. The dispatch seat's address is a
# second read. All of it degrades against an older board copy: the legacy
# label spelling survives, no token is stamped, the brief omits the address
# lines — addresses are chrome, and a failed read may not cost the spawn.
team_label="team GH-$EPIC" lead_addr=""
if _ralph_resolve_names "$EPIC" 2>/dev/null && [ -n "$RALPH_HERDR_NAMED_ADDRESS" ]; then
  team_addr="${RALPH_HERDR_NAMED_ADDRESS%%/*}/t${LEAD#o}"
  team_label="t${LEAD#o}"
  lead_addr="$team_addr/$LEAD"
fi
DISPATCH_ADDR=$("$BOARD" name dispatch --json 2>/dev/null | jq -r '.address // empty' 2>/dev/null) || DISPATCH_ADDR=""

# Liveness, fail-closed: an unreadable herd cannot prove no lead is standing,
# and doubling a lead is exactly what idempotence exists to prevent.
herd=$(ralph_agents_json 2>/dev/null) || die "cannot read the herd — refusing to spawn a lead for GH-$EPIC without proving none is standing"
live=$(printf '%s\n' "$herd" | jq -r --arg pfx "o$EPIC-" '
  select(.name | startswith($pfx)) | .name' 2>/dev/null | head -1)

finish() {
  trap - EXIT
  echo "$1"
  # Same constraint as hold_pane: a caller that is not a pane says so.
  [ -t 0 ] && [ -z "${RALPH_HERDR_NO_HOLD:-}" ] && { printf 'Enter to close.\n'; read -r _ || true; }
  exit 0
}

if [ -n "$live" ]; then
  finish "team GH-$EPIC: lead $live already standing — not doubling it (the lead staffs its own workers)"
fi

# ── Spawn the lead ───────────────────────────────────────────────────────────
src=$(ralph_worktree_source_dir)
# The tool cut removes Edit/Write/NotebookEdit from the lead's harness — READ
# from the role registry (GH-2265), not restated here: an orchestrator's row
# says toolBinding:true, same as every other non-driver role. Honestly
# labelled: Bash remains available (it is the board CLI, the herdr CLI and
# the spawn scripts, and denying it is a different mechanism with the
# opposite failure direction — process containment, #2266) — so this is hard
# enforcement of the editing surface only, not of the session as a whole;
# the one-writer invariant for the TREE still rests on the role model
# (roles.sh: only a driver writes a tree, and the one-writer guard runs at
# claim and at spawn).
lead_tools=()
while IFS= read -r out; do lead_tools+=("$out"); done < <(ralph_tool_binding_args orchestrator)
# Process containment (GH-2266) — the second mechanism, same registry row,
# separate call by design. The lead sits in the SOURCE checkout, so that is
# the tree denied. Refuses before any surface exists when it cannot be
# established (unmeasured platform, unbuildable profile).
lead_contain_out=$(ralph_process_containment_args orchestrator "$src") ||
  die "process containment cannot be established for GH-$EPIC's lead (see the reason above) — not spawning an uncontained lead"
lead_contain=()
while IFS= read -r out; do [ -n "$out" ] && lead_contain+=("$out"); done <<<"$lead_contain_out"
lead_harness=("${lead_tools[@]}" "${lead_contain[@]}")

# The durable ref, minted BEFORE the workspace so it can ride the env: the
# workers the lead spawns record it as their lineage parent/root, and `--env`
# at workspace creation is the one channel into the lead's shell. A failed
# mint degrades exactly as before — unledgered spawn, no lineage env.
ref=$(ralph_agent_ref "$LEAD" 2>/dev/null) || ref=""
[ -n "$ref" ] || echo "no durable ref derivable for $LEAD — spawning unledgered (reconcile will discover it)" >&2

# The standing brief. Deliberately STATE-FREE beyond the epic number, the
# role bounds and the derived chain-of-command addresses: the lead rehydrates
# from the board, so this exact prompt is also the respawn prompt and a
# replacement lead loses nothing.
brief="You are the standing LEAD for team GH-$EPIC — the orchestrator of this epic's fleet (role: orchestrator; read-only by role).

Rehydrate from board state alone (you were spawned — or respawned — with no other context, on purpose):
  $BOARD get $EPIC     # the epic, its children and their states
  $BOARD brief         # queues + this repo's live leases
  herdr agent list     # which team sessions are live now

Chain of command (derived — \`board name\`; your address is stable across respawns):${lead_addr:+
- You are $lead_addr (agent $LEAD).}${DISPATCH_ADDR:+
- Dispatch is $DISPATCH_ADDR — reachable, never a rung: escalations you cannot dispose go to the INBOX directly (board promote NNN), not through dispatch.}
- Your workers report to you: panes you spawn carry your address (RALPH_HERDR_LEAD), and their escalations route to you (board escalations shows them; board answer NNN -m answers what is knowable; board promote NNN hands the human what is not).

Your bounds (the roles.sh registry):
- READ-ONLY: never write a working tree, never claim a unit, never run /ralph:work yourself, never merge.
- YOU staff the team (D3.2 — nobody staffs it for you): bash $SCRIPT_DIR/work-fleet.sh --epic $EPIC spawns driver sessions for the epic's ready children from the ranked frontier, under the fleet's own guards (deps, cap, billing, spawn edge — your environment states your role); bash $SCRIPT_DIR/work-fleet.sh NNN... is the explicit override. Investigators via the sanctioned role helpers.
- Assignment is never pushed: workers claim from the board. Do not nudge working sessions for status — read the board instead.
- Workers escalate on board items, never in private channels. Answer what is knowable on the item's own thread; leave to the human what needs the human.

Standing loop: orient from the board; keep the epic's ready children staffed up to capacity as blockers clear and workers finish. Anything durable you learn goes to the board — your pane dies with you; the board does not.

When every child is closed, the team is done (D3.3): post the close-out comment on GH-$EPIC FIRST — it must be on the board before your pane dies — then DISSOLVE the team as your final act: herdr workspace close \$HERDR_WORKSPACE_ID. Your pane dies with the space; that is the intent, not an error. A dissolve you never reach is healed without you: the event healer flags your space and the sweep removes it — dying mid-dissolve costs one sweep, never an orphan forever."

if [ "${RALPH_HERDR_DRY_RUN:-}" = "true" ]; then
  echo "DRY RUN — would spawn the lead for GH-$EPIC:"
  echo "  agent: $LEAD   workspace label: $team_label   cwd: $src"
  echo "  $HERDR workspace create --cwd $src --label \"$team_label\" --env RALPH_HERDR_LEAD=$LEAD --env RALPH_HERDR_TEAM_LEAD=$LEAD${ref:+ --env RALPH_HERDR_TEAM_LEAD_REF=$ref}${DISPATCH_ADDR:+ --env WHO_DISPATCH=$DISPATCH_ADDR} --env RALPH_HERDR_SPAWNER_ROLE=orchestrator --env RALPH_HERDR_INVOKED_BY=agent --no-focus"
  echo "  $HERDR agent start $LEAD --kind claude --pane <captured>${lead_tools[*]:+ -- ${lead_tools[*]}}${lead_contain[*]:+ --settings <process containment: seatbelt denyWrite $src>}"
  [ "${#lead_contain[@]}" -gt 0 ] &&
    echo "  containment probe: prompt <captured> to touch <inside $src> <outside \$RALPH_HOME/containment-probes>; refuse unless applied"
  echo "  $HERDR agent prompt $LEAD \"<lead brief: rehydrate GH-$EPIC from board state; staff via work-fleet.sh --epic $EPIC; on epic Done, self-dissolve via workspace close (D3.3)>\""
  if [ -n "$ref" ]; then
    record=$(_ralph_spawn_record "$ref" "$EPIC" "" "" "$team_label" "" "$(date -u +%FT%TZ)" "" "" orchestrator "" "" "" "$lead_addr") || record=""
    echo "  ledger append (spawn): ${record:-<could not build the record>}"
  fi
  finish "team GH-$EPIC: DRY RUN — lead plan printed above; workers are the lead's to staff (D3.2)"
fi

set -- --cwd "$src" --label "$team_label" \
  --env "RALPH_HERDR_LEAD=$LEAD" --env "RALPH_HERDR_TEAM_LEAD=$LEAD"
[ -n "$ref" ] && set -- "$@" --env "RALPH_HERDR_TEAM_LEAD_REF=$ref"
# The dispatch seat's address (GH-2217): the lead's own chain of command is
# one rung — dispatch, reachable-never-a-rung. Same derivation the brief's
# prose lines use; empty (older board copy) simply omits the var.
[ -n "$DISPATCH_ADDR" ] && set -- "$@" --env "WHO_DISPATCH=$DISPATCH_ADDR"
set -- "$@" --env "RALPH_HERDR_SPAWNER_ROLE=orchestrator" \
  --env "RALPH_HERDR_INVOKED_BY=agent" --no-focus
out=$(ralph_herdr_call workspace_created workspace create "$@") ||
  die "workspace create failed for $team_label ($(ralph_herdr_err_code "$out" || true)) — see the diagnostic above"
pane=$(jq -r '.root_pane.pane_id // empty' <<<"$out")
[ -n "$pane" ] || die "no pane id in workspace response for the GH-$EPIC lead"
lead_ws=$(jq -r '.workspace.workspace_id // .workspace.id // empty' <<<"$out" 2>/dev/null) || lead_ws=""

# Provisional C7 record at pane creation (audit D2b parity with
# spawn_work_session): a spawner killed before `agent start` leaves a
# sweepable row instead of nothing. role=orchestrator, no branch, no
# parent issue — the epic IS the lead's issue.
ts=$(date -u +%FT%TZ)
shell_pid=$(ralph_herdr_call pane_process_info pane process-info --pane "$pane" 2>/dev/null |
  jq -r '.process_info.shell_pid // empty' 2>/dev/null) || shell_pid=""
case "$shell_pid" in '' | *[!0-9]*) shell_pid="" ;; esac
record="" ledger=""
if [ -n "$ref" ]; then
  record=$(_ralph_spawn_record "$ref" "$EPIC" "" "" "$team_label" "$pane" "$ts" \
    "$shell_pid" "$src" orchestrator "" "" "" "$lead_addr") || record=""
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
fi

if ! agent_start_when_ready "$LEAD" "$pane" "${lead_harness[@]}"; then
  if printf '%s\n' "$(ralph_agents_json 2>/dev/null)" | jq -e --arg name "$LEAD" \
    'select(.name == $name)' >/dev/null 2>&1; then
    _ralph_spawn_close "$ref" "$ledger" never_started
    finish "SKIP $LEAD already live (lost the spawn race for GH-$EPIC's lead) — leaving pane $pane to the winner"
  fi
  _ralph_spawn_close "$ref" "$ledger" never_started
  die "agent start $LEAD failed — see the herdr error above; not spawning"
fi
export RALPH_HERDR_AGENT_LIVE=1

# The positive self-test (GH-2266), before the brief: a lead whose sandbox is
# inert is a second writer in the source checkout. Anything but `applied`
# closes the team space (nothing on disk is touched — the lead's workspace
# carries no worktree), closes the provisional record with the outcome, and
# fails naming it.
if [ "${#lead_contain[@]}" -gt 0 ]; then
  outcome=$(spawn_containment_probe "$LEAD" "$pane" "$src" \
    "close the team space (herdr workspace close ${lead_ws:-<workspace-id>}) and re-run work-team.sh $EPIC") || {
    _ralph_spawn_close "$ref" "$ledger" "containment_${outcome:-unverified}"
    [ -n "$lead_ws" ] && "$HERDR" workspace close "$lead_ws" >/dev/null 2>&1 || true
    RALPH_HERDR_AGENT_LIVE=""
    die "process containment ${outcome:-unverified} for $LEAD (pane $pane) — an uncontained lead must not receive its brief; closed the team space (the probe's reason is above)"
  }
  echo "process containment: $outcome for $LEAD (a Bash write inside $src was refused by the kernel)"
fi

if [ -n "$record" ]; then
  set --
  while IFS= read -r kv; do
    [ -n "$kv" ] || continue
    set -- "$@" "$kv"
  done < <(jq -r '.tokens | to_entries[] | "\(.key)=\(.value)"' <<<"$record" 2>/dev/null || true)
  [ "$#" -ge 1 ] && ralph_tokens_push "$pane" "$@"
fi

ralph_herdr_agent_prompt "$LEAD" "$brief" >/dev/null || {
  echo "prompt delivery failed — lead $LEAD is LIVE and idle in pane $pane; prompt it manually: herdr agent prompt $LEAD \"rehydrate team GH-$EPIC from the board\"" >&2
  exit 1
}

# spawn_confirm_turn (lib.sh) holds the wait loop, the modal probe, the
# undelivered-vs-unsubmitted split and the one redelivery (GH-2223). The
# lead's workspace carries no worktree, so the undelivered-mode remedy is
# `workspace close`, not `worktree remove` — nothing on disk is touched.
spawn_confirm_turn "$LEAD" "$pane" "$brief" "GH-$EPIC's lead $LEAD" \
  "close the team space (herdr workspace close ${lead_ws:-<workspace-id>}) and re-run work-team.sh $EPIC" ||
  exit 1
echo "lead spawned for GH-$EPIC (pane $pane, agent $LEAD, workspace \"$team_label\")"
finish "team GH-$EPIC: lead $LEAD standing — it staffs its own workers (work-fleet.sh --epic $EPIC from its pane)"
