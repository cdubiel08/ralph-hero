#!/usr/bin/env bash
# dispatch-rota.sh — EXAMPLE: scheduled passes of the ralph dispatch lane
# (GH-2184, unit H of #2176).
#
# Copy and own. This is a transport recipe, not shipped harness (scripts are
# examples, contracts are doctrine — see README.md in this directory). The
# authorities it exercises are the standing authorities the dispatch skill
# records in writing (ralph/skills/dispatch/SKILL.md); each pass here is the
# DETERMINISTIC form of one of them — possible because every standing
# authority carries a structural bound (a cap, a gate, idempotence), so no
# model judgment is needed to exercise it safely. The judgment form of the
# lane stays `/ralph:dispatch` (a model pass), which this script never
# replaces.
#
# One invocation runs the passes named on its argv, once each, then exits —
# the scheduler owns cadence (tick.sh's contract). Three passes:
#
#   fleet    feed the worker fleet: if the frontier has eligible work and
#            live workers are under the cap, fire the work-fleet plugin
#            action. The action runs in its own cockpit pane (work-fleet.sh
#            ends by exec'ing into its watcher, which must not hold this
#            rota's lock for the fleet's lifetime) — this rota's log records
#            the invocation; the pane records the pass.
#   leads    lead health: enumerate this repo's team workspaces (labeled
#            "team GH-N" by work-team.sh — the durable evidence a team was
#            stood up, which a dead lead's missing agent cannot be), and
#            re-run `work-team.sh N --lead-only` per epic. Respawn is
#            idempotent re-run by that script's own contract: a standing
#            lead is skipped, a dead one is respawned and loses nothing.
#            OPT-IN (GH-2197): the only writer of that label is a human
#            running work-team.sh by hand — no scheduled path ever creates
#            a team — so on a machine that has never stood up a team this
#            pass is a permanent no-op. It is deliberately absent from the
#            suggested cron lines below; add it to the frequent line only
#            on a machine that actually runs teams.
#   digest   inbox curation: `board inbox --digest` — push a Tier 2
#            notification when the verdict says worthy, then ALWAYS mark
#            (an empty-inbox rota run still closes the day's window;
#            pushWorthy is computed before the stamp write, so marking can
#            never talk the rota out of a push it owed).
#
# WHY passes are named, never defaulted: the digest mark keys "at most one
# push a day" on the local calendar date. A frequent rota that marked on
# every run would close the day's window on its first quiet fire and
# suppress the one push the day was owed — so `digest` rides its own daily
# schedule line, and the frequent line runs `fleet` (add `leads` only on a
# machine that runs teams — see its opt-in note above):
#
#   # crontab — the frequent fleet line, then the daily digest fire
#   */30 8-18 * * *  cd /path/to/repo && bash ralph/examples/dispatch-rota.sh fleet
#   30 7 * * *       cd /path/to/repo && bash ralph/examples/dispatch-rota.sh digest
#
# Unattended arming is the deliver/tend two-key convention: the shared
# `autopilot=true` PLUS `autopilot.dispatch=true` in $RALPH_HOME/config,
# both fail-closed. Neither key alone is sufficient.
#
# Honest limits (keep these in whatever you build):
#   - fleet/leads need herdr + the ralph-herdr plugin; without them those
#     passes are refusals, not silent no-ops. digest needs only the board.
#   - the digest stamp is machine-local: two machines running rotas produce
#     two pushes a day (the board stays the only shared store).
#   - the rota is never load-bearing: fleets, leads, and lanes all function
#     with it dead. A missed fire costs latency, nothing else.
set -euo pipefail

RALPH_HOME="${RALPH_HOME:-$HOME/.ralph}"
# board sits beside this examples dir in the plugin layout; RALPH_BOARD
# overrides for a copied-out script.
BOARD="${RALPH_BOARD:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)/board}"
# The ralph-herdr plugin's scripts dir (work-team.sh lives there). Default
# resolves the in-repo layout; a host repo points this at its installed
# plugin clone.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "dispatch-rota: not inside a git repo — cd to the board's repo first (the cron line should)" >&2
  exit 64
}
HERDR_SCRIPTS="${RALPH_HERDR_SCRIPTS:-$REPO_ROOT/plugin/ralph-herdr/scripts}"
FLEET_CAP="${RALPH_HERDR_FLEET:-2}"

[ "$#" -ge 1 ] || {
  echo "usage: dispatch-rota.sh PASS [PASS...]   passes: fleet leads digest" >&2
  echo "  (passes are named, never defaulted — see the header for why digest rides its own schedule line)" >&2
  exit 64
}
for p in "$@"; do
  case "$p" in
    fleet | leads | digest) ;;
    *)
      echo "dispatch-rota: unknown pass '$p' (fleet, leads, digest)" >&2
      exit 64
      ;;
  esac
done

# --- Opt-in: two typed keys, fail closed (the deliver/tend convention) ------
if ! grep -q '^autopilot=true$' "$RALPH_HOME/config" 2>/dev/null ||
  ! grep -q '^autopilot\.dispatch=true$' "$RALPH_HOME/config" 2>/dev/null; then
  echo "dispatch-rota: not armed — BOTH 'autopilot=true' AND 'autopilot.dispatch=true' must be in $RALPH_HOME/config (fail closed)" >&2
  exit 3
fi

# --- Billing guard: the fleet pass spawns claude sessions -------------------
if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "${RALPH_ALLOW_API_BILLING:-}" != "true" ]; then
  echo "dispatch-rota: ANTHROPIC_API_KEY is set — refusing (would bill API credits, not the subscription); set RALPH_ALLOW_API_BILLING=true deliberately" >&2
  exit 3
fi

# --- One rota at a time per machine (tick.sh's lock, its own pidfile) -------
mkdir -p "$RALPH_HOME"
LOCK="$RALPH_HOME/dispatch.pid"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  if ! flock -n 9; then
    echo "dispatch-rota: previous rota still running (flock held) — skipping" >&2
    exit 0
  fi
else
  take_lock() { (
    set -o noclobber
    echo $$ >"$LOCK"
  ) 2>/dev/null; }
  if ! take_lock; then
    holder=$(cat "$LOCK" 2>/dev/null || echo "")
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      echo "dispatch-rota: previous rota (pid $holder) still running — skipping" >&2
      exit 0
    fi
    [ "$(cat "$LOCK" 2>/dev/null)" = "$holder" ] && rm -f "$LOCK"
    take_lock || {
      echo "dispatch-rota: lock race — skipping" >&2
      exit 0
    }
  fi
  [ "$(cat "$LOCK" 2>/dev/null)" = "$$" ] || {
    echo "dispatch-rota: lock race — skipping" >&2
    exit 0
  }
  trap 'rm -f "$LOCK"' EXIT
fi

date +%s >"$RALPH_HOME/dispatch.heartbeat"

# notify TITLE BODY — herdr toast when the server is up, else macOS banner,
# else the log line alone. Fire-and-forget: a delivery failure never fails
# the pass (the outcome line below is the proof-of-input either way).
notify() {
  local title="$1" body="$2"
  if command -v herdr >/dev/null 2>&1 && herdr notification show "$title" --body "$body" >/dev/null 2>&1; then
    return 0
  fi
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$body\" with title \"$title\"" >/dev/null 2>&1 || true
  fi
}

FLEET_OUT="" LEADS_OUT="" DIGEST_OUT="" RC=0

for pass in "$@"; do
  case "$pass" in

    fleet)
      # Feed the worker fleet — bound: frontier eligibility (read here, and
      # re-validated inside work-fleet.sh) + the live-worker cap.
      if ! command -v herdr >/dev/null 2>&1; then
        echo "dispatch-rota: fleet pass needs herdr — skipping (refusal, not a quiet no-op)" >&2
        FLEET_OUT="no-herdr" RC=1
        continue
      fi
      # Shape-checked frontier read (GH-2196). `frontier --json` is
      # {frontier: [...], blocked, cache} — a LIST with no `.next` head (that
      # shape is `board next --json`'s). "No candidate" is idle; a read whose
      # shape does not match is a loud refusal, never idle — "no work" and
      # "this pass is broken" must not look alike (GH-2048's rule, and the
      # same one the leads pass follows for a missing herdr).
      fj=$("$BOARD" frontier --json 2>/dev/null) || fj=""
      if [ -z "$fj" ] || ! jq -e '.frontier | type == "array"' >/dev/null 2>&1 <<<"$fj"; then
        echo "dispatch-rota: frontier read failed or shape mismatch (expected {frontier: [...]}) — skipping the fleet pass (refusal, not idle)" >&2
        FLEET_OUT="bad-shape" RC=1
        continue
      fi
      head=$(jq -r '.frontier[0].number // empty' <<<"$fj")
      if [ -z "$head" ]; then
        # A non-empty frontier whose head carries no number is shape drift
        # too — only a genuinely empty list may read as idle.
        if [ "$(jq -r '.frontier | length' <<<"$fj")" -gt 0 ]; then
          echo "dispatch-rota: frontier head has no .number — shape drift, skipping the fleet pass (refusal, not idle)" >&2
          FLEET_OUT="bad-shape" RC=1
          continue
        fi
        FLEET_OUT="idle"
        continue
      fi
      # Live w-lane agents for THIS repo vs the cap. Scope is the worktree
      # path (source checkout, or herdr's worktrees dir keyed by the repo's
      # basename) — honest limit: a repo dir renamed between spawns escapes
      # the count. An unreadable herd fails closed: spawning into a fleet we
      # cannot count is how a cap stops meaning anything.
      live=$(herdr agent list 2>/dev/null | jq -r \
        --arg root "$REPO_ROOT" --arg wt "/worktrees/$(basename "$REPO_ROOT")/" '
          [.result.agents[]?
           | select((.name // "") | test("^w[0-9]"))
           | select((.cwd // "") | (startswith($root) or contains($wt)))]
          | length' 2>/dev/null) || live=""
      if [ -z "$live" ]; then
        echo "dispatch-rota: cannot read the herd — skipping the fleet pass (fail closed)" >&2
        FLEET_OUT="herd-unreadable" RC=1
        continue
      fi
      if [ "$live" -ge "$FLEET_CAP" ]; then
        FLEET_OUT="at-capacity($live/$FLEET_CAP)"
        continue
      fi
      # The standing-authority spelling (dispatch skill). The action runs in
      # its own cockpit pane — work-fleet.sh ends in its watcher, which must
      # not hold this rota's lock. The ack is what this log records; the
      # pane records the pass.
      if herdr plugin action invoke work-fleet --plugin ralph-herdr >/dev/null 2>&1; then
        FLEET_OUT="invoked(head=#$head,live=$live/$FLEET_CAP)"
      else
        echo "dispatch-rota: work-fleet action invoke failed — is the ralph-herdr plugin registered?" >&2
        FLEET_OUT="invoke-failed" RC=1
      fi
      ;;

    leads)
      # Lead health — bound: work-team.sh --lead-only is idempotent (a
      # standing lead is never doubled; its liveness read fails closed).
      if ! command -v herdr >/dev/null 2>&1 || [ ! -f "$HERDR_SCRIPTS/work-team.sh" ]; then
        echo "dispatch-rota: leads pass needs herdr + work-team.sh (looked in $HERDR_SCRIPTS; set RALPH_HERDR_SCRIPTS) — skipping" >&2
        LEADS_OUT="no-herdr" RC=1
        continue
      fi
      # Team workspaces for THIS repo: work-team.sh labels them "team GH-N"
      # and roots them in the repo's source checkout. Scoping on repo_root
      # keeps one machine's rotas out of each other's teams.
      epics=$(herdr workspace list 2>/dev/null |
        jq -r --arg root "$REPO_ROOT" '
          .result.workspaces[]?
          | select(.worktree.repo_root == $root)
          | (.label | capture("^team GH-(?<n>[0-9]+)$") | .n)' 2>/dev/null) || epics=""
      if [ -z "$epics" ]; then
        LEADS_OUT="no-teams"
        continue
      fi
      ok=0 total=0
      for n in $epics; do
        total=$((total + 1))
        # Per-epic tolerance: one closed epic's lingering workspace (team
        # dissolution is the human's cleanup) must not starve the rest of
        # the pass. work-team.sh refuses a closed epic loudly on its own.
        if bash "$HERDR_SCRIPTS/work-team.sh" "$n" --lead-only </dev/null; then
          ok=$((ok + 1))
        else
          echo "dispatch-rota: lead pass for GH-$n failed (see above) — continuing" >&2
          RC=1
        fi
      done
      LEADS_OUT="$ok/$total"
      ;;

    digest)
      # Inbox curation — bound: pushWorthy already encodes "at most one push
      # a day" (it keys on markedToday), and marking happens AFTER it was
      # computed, so the stamp can never suppress a push it owed.
      j=$("$BOARD" inbox --digest --json) || {
        echo "dispatch-rota: board inbox read failed — not marking (a window we could not read must not be closed)" >&2
        DIGEST_OUT="unreadable" RC=1
        continue
      }
      worthy=$(jq -r '.digest.pushWorthy // false' <<<"$j")
      tier1=$(jq -r '.tier1.count // 0' <<<"$j")
      comps=$(jq -r '.digest.counts.completions // 0' <<<"$j")
      if [ "$worthy" = "true" ]; then
        notify "ralph inbox" "$tier1 decision(s) waiting, $comps completion(s) since the last digest — board inbox has the verbs"
        DIGEST_OUT="pushed(tier1=$tier1,done=$comps)"
      else
        DIGEST_OUT="quiet(tier1=$tier1,done=$comps)"
      fi
      # Mark ALWAYS: an empty-inbox run still closes the day's window
      # (board.ts's own stated direction for a rota).
      "$BOARD" inbox --digest --mark >/dev/null ||
        echo "dispatch-rota: digest mark failed — next window will over-notify, the safe direction" >&2
      ;;
  esac
done

line="$(date -u +%FT%TZ) dispatch rc=$RC passes=$(
  IFS=,
  echo "$*"
)${FLEET_OUT:+ fleet=$FLEET_OUT}${LEADS_OUT:+ leads=$LEADS_OUT}${DIGEST_OUT:+ digest=$DIGEST_OUT}"
echo "$line" >>"$RALPH_HOME/dispatch.outcomes.log"
echo "$line"
exit "$RC"
