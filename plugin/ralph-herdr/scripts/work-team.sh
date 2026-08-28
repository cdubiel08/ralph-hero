#!/usr/bin/env bash
# work-team.sh — cockpit action: the TEAM form of the fleet (GH-2178, unit B
# of #2176). Spawn a standing o-lane LEAD pane for ONE epic, then hand the
# epic's ready children to work-fleet.sh — the same spawn primitive, guards,
# ledger and token writes the plain fleet uses; the team form only adds the
# lead in front.
#
#   work-team.sh EPIC [ISSUE...]
#   work-team.sh EPIC --lead-only
#
# THE LEAD (design decision 4, thoughts/shared/plans/2026-08-26-teams-
# dispatch-inbox-design.md): the team's orchestrator — a standing pane living
# the epic's lifetime, read-only by role (roles.sh `orchestrator`: may spawn
# driver/investigator/tender, never writes a tree), REHYDRATABLE FROM BOARD
# STATE ALONE. The spawn brief deliberately carries no state beyond the epic
# number and the role bounds: everything the lead knows lives on the board, so
# a dead lead is respawned by re-running this script and loses nothing.
#
# RESPAWN IS IDEMPOTENT RE-RUN. A live o<EPIC>-* lead is skipped (the herd
# read is the liveness oracle, fail-closed like every spawn pre-check); a dead
# one is simply spawned again. `--lead-only` is the dispatch-pass form (unit H
# calls it per active team epic): respawn the lead, touch nothing else.
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
#   RALPH_HERDR_INVOKED_BY=agent  C1: spawns the lead performs are recorded
#                                 invoked_by=agent, not human
# The lead gets NO worktree and NO branch: it writes nothing, so it sits in
# the source checkout read-only.
#
# WORKERS go through work-fleet.sh's explicit-list path verbatim (GH-1780: an
# argument, not a second code path). Named ISSUEs are validated as the epic's
# children first — the team is scoped to one epic (design decision 3); plain
# work-fleet.sh is the override for out-of-team work. The default pick is the
# ranked frontier filtered to the epic's DIRECT children (parentNumber), capped
# at RALPH_HERDR_FLEET. No ready children is a fine outcome: the lead stands
# alone and staffs the team itself as blockers clear.
#
# Knobs (the fleet's, unchanged): RALPH_HERDR_FLEET (default 2, hard cap 4),
# RALPH_HERDR_DRY_RUN=true (plans everything, spawns nothing). Refill is not
# offered here — the lead IS the standing refiller for its team.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

trap hold_pane EXIT

billing_guard

usage() {
  cat <<'EOF'
usage: work-team.sh EPIC [ISSUE...]
       work-team.sh EPIC --lead-only

  EPIC         the epic issue the team is scoped to. Its lead is the o-lane
               pane o<EPIC>-<slug>; a live one is never doubled (idempotent),
               a dead one is respawned by re-running this script.
  ISSUE...     spawn exactly these children of EPIC as the worker fleet
               (validated against the epic's child list, then against the
               frontier by work-fleet.sh). Default: the ranked frontier
               filtered to EPIC's direct children, capped at RALPH_HERDR_FLEET.
  --lead-only  spawn/respawn the lead and stop — the dispatch pass's form.
  -h, --help   this.

Knobs: RALPH_HERDR_FLEET (default 2, cap 4), RALPH_HERDR_DRY_RUN=true.
EOF
}

LEAD_ONLY="" EPIC="" ISSUES=""
for arg in "$@"; do
  case "$arg" in
    --lead-only) LEAD_ONLY=1 ;;
    -h | --help)
      trap - EXIT # --help is a read, not a pane session: don't hold for Enter
      usage
      exit 0
      ;;
    *[!0-9]* | "") die "unknown argument '$arg' (--lead-only, --help, or issue numbers)" ;;
    *)
      if [ -z "$EPIC" ]; then EPIC="$arg"; else ISSUES="$ISSUES $arg"; fi
      ;;
  esac
done
if [ -n "$LEAD_ONLY" ] && [ -n "$ISSUES" ]; then
  die "--lead-only spawns the lead and nothing else — naming worker issues with it is a contradiction"
fi

# The cockpit pane has no argv to type into (work-these.sh precedent): prompt
# on a TTY, refuse on EOF — a non-TTY caller that named no epic made an error,
# and there is no default epic to fall back to.
if [ -z "$EPIC" ]; then
  if [ ! -t 0 ]; then
    echo "work-team.sh: no epic given and stdin is not a TTY — there is no default epic." >&2
    echo "  name it: work-team.sh EPIC [ISSUE...]" >&2
    exit 64
  fi
  echo "Ralph: work team"
  echo "  the epic number this team is scoped to, optionally followed by"
  echo "  specific child issues to staff (default: ranked ready children)."
  printf 'epic [children...]: '
  read -r line || line=""
  # shellcheck disable=SC2086  # intentional word-splitting: one argv per number
  set -- $line
  [ "$#" -ge 1 ] || die "no epic named — nothing to do"
  EPIC="$1"
  shift
  case "$EPIC" in '' | *[!0-9]*) die "epic must be an issue number (got '$EPIC')" ;; esac
  for arg in "$@"; do
    case "$arg" in *[!0-9]* | "") die "bad child issue '$arg'" ;; *) ISSUES="$ISSUES $arg" ;; esac
  done
fi

FLEET="${RALPH_HERDR_FLEET:-2}"
validate_pos_int RALPH_HERDR_FLEET "$FLEET"
[ "$FLEET" -le 4 ] || die "RALPH_HERDR_FLEET=$FLEET exceeds the hard cap of 4 — this is an attended tool, not a farm"

# The epic, read once from the board: the title feeds the lead's name slug,
# the child list is the team-membership oracle for a named ISSUE list, and a
# closed epic has no team to stand up.
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

# Liveness, fail-closed: an unreadable herd cannot prove no lead is standing,
# and doubling a lead is exactly what idempotence exists to prevent.
herd=$(ralph_agents_json 2>/dev/null) || die "cannot read the herd — refusing to spawn a lead for GH-$EPIC without proving none is standing"
live=$(printf '%s\n' "$herd" | jq -r --arg pfx "o$EPIC-" '
  select(.name | startswith($pfx)) | .name' 2>/dev/null | head -1)

lead_spawned=""
if [ -n "$live" ]; then
  echo "lead $live already standing for GH-$EPIC — not doubling it"
  LEAD="$live"
else
  # ── Spawn the lead ─────────────────────────────────────────────────────────
  src=$(ralph_worktree_source_dir)
  team_label="team GH-$EPIC"
  # The tool cut removes the editing surface (Edit/Write) from the lead's
  # harness. Honestly labelled: Bash remains — it is the board CLI, the herdr
  # CLI and the spawn scripts — so this is not hard read-only enforcement;
  # that stays with the role model (roles.sh: only a driver writes a tree,
  # and the one-writer guard runs at claim and at spawn).
  lead_tools="Bash,Read,Grep,Glob"

  if [ "${RALPH_HERDR_DRY_RUN:-}" = "true" ]; then
    echo "DRY RUN — would spawn the lead for GH-$EPIC:"
    echo "  agent: $LEAD   workspace label: $team_label   cwd: $src"
    echo "  $HERDR workspace create --cwd $src --label \"$team_label\" --env RALPH_HERDR_LEAD=$LEAD --env RALPH_HERDR_TEAM_LEAD=$LEAD --env RALPH_HERDR_INVOKED_BY=agent --no-focus"
    echo "  $HERDR agent start $LEAD --kind claude --pane <captured> -- --tools $lead_tools"
    echo "  $HERDR agent prompt $LEAD \"<lead brief: rehydrate GH-$EPIC from board state>\""
    ref=$(ralph_agent_ref "$LEAD") || die "could not derive a durable ref for $LEAD"
    record=$(_ralph_spawn_record "$ref" "$EPIC" "" "" "$team_label" "" "$(date -u +%FT%TZ)" "" "" orchestrator) || record=""
    echo "  ledger append (spawn): ${record:-<could not build the record>}"
  else
    out=$(ralph_herdr_call workspace_created workspace create \
      --cwd "$src" --label "$team_label" \
      --env "RALPH_HERDR_LEAD=$LEAD" --env "RALPH_HERDR_TEAM_LEAD=$LEAD" \
      --env "RALPH_HERDR_INVOKED_BY=agent" --no-focus) ||
      die "workspace create failed for $team_label ($(ralph_herdr_err_code "$out" || true)) — see the diagnostic above"
    pane=$(jq -r '.root_pane.pane_id // empty' <<<"$out")
    [ -n "$pane" ] || die "no pane id in workspace response for the GH-$EPIC lead"

    # Provisional C7 record at pane creation (audit D2b parity with
    # spawn_work_session): a spawner killed before `agent start` leaves a
    # sweepable row instead of nothing. role=orchestrator, no branch, no
    # parent issue — the epic IS the lead's issue.
    ts=$(date -u +%FT%TZ)
    shell_pid=$(ralph_herdr_call pane_process_info pane process-info --pane "$pane" 2>/dev/null |
      jq -r '.process_info.shell_pid // empty' 2>/dev/null) || shell_pid=""
    case "$shell_pid" in '' | *[!0-9]*) shell_pid="" ;; esac
    record="" ledger=""
    if ref=$(ralph_agent_ref "$LEAD" 2>/dev/null); then
      record=$(_ralph_spawn_record "$ref" "$EPIC" "" "" "$team_label" "$pane" "$ts" \
        "$shell_pid" "$src" orchestrator) || record=""
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
      ref=""
      echo "no durable ref derivable for $LEAD — spawning unledgered (reconcile will discover it)" >&2
    fi

    if ! agent_start_when_ready "$LEAD" "$pane" --tools "$lead_tools"; then
      if printf '%s\n' "$(ralph_agents_json 2>/dev/null)" | jq -e --arg name "$LEAD" \
        'select(.name == $name)' >/dev/null 2>&1; then
        _ralph_spawn_close "$ref" "$ledger" never_started
        echo "SKIP $LEAD already live (lost the spawn race for GH-$EPIC's lead) — leaving pane $pane to the winner"
      else
        _ralph_spawn_close "$ref" "$ledger" never_started
        die "agent start $LEAD failed — see the herdr error above; not spawning"
      fi
    else
      export RALPH_HERDR_AGENT_LIVE=1
      if [ -n "$record" ]; then
        set --
        while IFS= read -r kv; do
          [ -n "$kv" ] || continue
          set -- "$@" "$kv"
        done < <(jq -r '.tokens | to_entries[] | "\(.key)=\(.value)"' <<<"$record" 2>/dev/null || true)
        [ "$#" -ge 1 ] && ralph_tokens_push "$pane" "$@"
      fi

      # The standing brief. Deliberately STATE-FREE beyond the epic number and
      # the role bounds: the lead rehydrates from the board, so this exact
      # prompt is also the respawn prompt and a replacement lead loses nothing.
      brief="You are the standing LEAD for team GH-$EPIC — the orchestrator of this epic's fleet (role: orchestrator; read-only by role).

Rehydrate from board state alone (you were spawned — or respawned — with no other context, on purpose):
  $BOARD get $EPIC     # the epic, its children and their states
  $BOARD brief         # queues + this repo's live leases
  herdr agent list     # which team sessions are live now

Your bounds (the roles.sh registry):
- READ-ONLY: never write a working tree, never claim a unit, never run /ralph:work yourself, never merge.
- You MAY staff the team: bash $SCRIPT_DIR/work-fleet.sh NNN... spawns driver sessions for ready children (your environment carries RALPH_HERDR_TEAM_LEAD, so their panes learn your address); investigators via the sanctioned role helpers.
- Assignment is never pushed: workers claim from the board. Do not nudge working sessions for status — read the board instead.
- Workers escalate on board items, never in private channels. Answer what is knowable on the item's own thread; leave to the human what needs the human.

Standing loop: orient from the board; keep the epic's ready children staffed up to capacity as blockers clear and workers finish; when every child is closed, post a close-out comment on GH-$EPIC and stop. Anything durable you learn goes to the board — your pane dies with you; the board does not."
      ralph_herdr_agent_prompt "$LEAD" "$brief" >/dev/null || {
        echo "prompt delivery failed — lead $LEAD is LIVE and idle in pane $pane; prompt it manually: herdr agent prompt $LEAD \"rehydrate team GH-$EPIC from the board\"" >&2
        exit 1
      }

      confirm_total="${RALPH_HERDR_SPAWN_CONFIRM_SEC:-60}" confirm_waited=0 turn_ok=""
      case "$confirm_total" in '' | *[!0-9]* | 0) confirm_total=60 ;; esac
      chunk="${RALPH_HERDR_TURN_WAIT_SEC:-20}"
      case "$chunk" in '' | *[!0-9]* | 0) chunk=20 ;; esac
      turn_err=$(ralph_diag_file)
      while :; do
        if spawn_turn_started "$LEAD" 2>"$turn_err"; then
          turn_ok=1
          break
        fi
        confirm_waited=$((confirm_waited + chunk))
        [ "$confirm_waited" -lt "$confirm_total" ] || break
      done
      if [ -z "$turn_ok" ]; then
        [ -s "$turn_err" ] && cat "$turn_err" >&2
        [ "$turn_err" = /dev/null ] || rm -f "$turn_err" 2>/dev/null || true
        spawn_modal_probe "$pane"
        echo "SPAWN-UNCONFIRMED $pane — GH-$EPIC's lead $LEAD is LIVE holding an unsubmitted brief (no turn within ~${confirm_total}s); submit it with: herdr pane send-keys $pane Enter" >&2
        exit 1
      fi
      [ "$turn_err" = /dev/null ] || rm -f "$turn_err" 2>/dev/null || true
      lead_spawned=1
      echo "lead spawned for GH-$EPIC (pane $pane, agent $LEAD, workspace \"$team_label\")"
    fi
  fi
fi

if [ -n "$LEAD_ONLY" ]; then
  trap - EXIT
  if [ "${RALPH_HERDR_DRY_RUN:-}" = "true" ]; then
    echo "team GH-$EPIC: DRY RUN — lead ${lead_spawned:+would be spawned}${lead_spawned:-plan printed above}; workers untouched (--lead-only)"
  else
    echo "team GH-$EPIC: lead $LEAD ${lead_spawned:+spawned}${lead_spawned:-standing}; workers untouched (--lead-only)"
  fi
  [ -t 0 ] && { printf 'Enter to close.\n'; read -r _ || true; }
  exit 0
fi

# ── Workers: the epic's children, through work-fleet.sh's explicit list ──────
CHILDREN=$(jq -r '[.children[]?.number] | join(" ")' <<<"$EPIC_JSON" 2>/dev/null) || CHILDREN=""
CHILD_TRUNC=$(jq -r '.childrenTruncated // false' <<<"$EPIC_JSON" 2>/dev/null) || CHILD_TRUNC=false

is_child() {
  local n="$1" c
  for c in $CHILDREN; do [ "$c" = "$n" ] && return 0; done
  return 1
}

WORK_LIST=""
if [ -n "$ISSUES" ]; then
  for n in $ISSUES; do
    if is_child "$n"; then
      WORK_LIST="$WORK_LIST $n"
    elif [ "$CHILD_TRUNC" = "true" ]; then
      # Membership unprovable, operator-named work: proceed, say so. The
      # frontier verdict downstream still gates eligibility.
      echo "GH-$n: child list for GH-$EPIC is truncated — membership not proven; proceeding because you named it"
      WORK_LIST="$WORK_LIST $n"
    else
      echo "SKIP GH-$n — not a child of GH-$EPIC (the team is scoped to one epic; plain work-fleet.sh $n is the out-of-team lane)"
    fi
  done
else
  # Ranked frontier ∩ direct children, order preserved from the ranking.
  QUEUE_JSON=$(ralph_fleet_frontier_json)
  WORK_LIST=$(jq -r --argjson e "$EPIC" --argjson k "$FLEET" '
    [.queue[]? | select(.parentNumber == $e)][0:$k] | map(.number | tostring) | join(" ")' \
    <<<"$QUEUE_JSON" 2>/dev/null) || WORK_LIST=""
fi
# shellcheck disable=SC2086  # intentional word-splitting: one word per issue
set -- $WORK_LIST

if [ "$#" -eq 0 ]; then
  trap - EXIT
  echo "team GH-$EPIC: no workers to spawn — the lead stands alone and staffs the team as blockers clear"
  [ -t 0 ] && { printf 'Enter to close.\n'; read -r _ || true; }
  exit 0
fi

echo "team GH-$EPIC: handing $# worker issue(s) to work-fleet.sh:$(printf ' GH-%s' "$@")"
export RALPH_HERDR_TEAM_LEAD="$LEAD"
trap - EXIT # work-fleet.sh installs its own hold
exec bash "$SCRIPT_DIR/work-fleet.sh" "$@"
