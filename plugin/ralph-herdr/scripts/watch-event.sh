#!/usr/bin/env bash
# watch-event.sh — the ralph-herdr watcher's [[events]] hook target.
#
# The herdr server runs this once per subscribed event with the event name in
# HERDR_PLUGIN_EVENT and the payload in HERDR_PLUGIN_EVENT_JSON. Three
# subscriptions (herdr-plugin.toml):
#
#   pane.agent_status_changed  payload {pane_id, workspace_id, agent,
#                              agent_status, display_agent, state_labels,
#                              title} — ralph agents only (grammar-B or
#                              legacy): append a state event, update the state
#                              token, and on blocked show a notification.
#   pane.exited / pane.closed  payload {pane_id, workspace_id} — NO agent
#                              name: the ledger itself is the correlation
#                              (open agents whose latest record binds that
#                              pane). Append exit + run the orphan pass for
#                              the dead agent's children.
#
# Duplicate events are tolerated: the ledger is append-only (a second exit
# for an already-closed ref finds no open agent) and token updates are
# last-write-wins. RACING events need more than tolerance — the server runs
# hook commands concurrently, and pane.exited + pane.closed both fire for one
# pane death — so every read-decide-append section below runs under the
# per-ledger mutex (ralph_ledger_lock): the loser of the race re-reads a
# ledger the winner already amended and finds nothing left to do. This hook
# NEVER writes board state — blocked routes attention (notification +
# ledger); skills own transitions.
#
# Event-hook processes have no workspace cwd, so lib.sh (which discovers a
# board CLI relative to one) is deliberately NOT sourced; the ledger root is
# scanned instead, and an agent seen before any ledger knew it gets its scope
# from its pane's cwd.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=naming.sh
. "$SCRIPT_DIR/naming.sh"
# shellcheck source=ledger.sh
. "$SCRIPT_DIR/ledger.sh"
# shellcheck source=tokens.sh
. "$SCRIPT_DIR/tokens.sh"

HERDR="${HERDR_BIN_PATH:-herdr}"
EVENT="${HERDR_PLUGIN_EVENT:-}"
PAYLOAD="${HERDR_PLUGIN_EVENT_JSON:-}"

# set -e can leave a locked section early — never strand the mutex.
trap ralph_ledger_unlock_held EXIT

log() { echo "$(date -u +%FT%TZ) watch-event: $*"; }

[ -n "$PAYLOAD" ] || { log "no HERDR_PLUGIN_EVENT_JSON — nothing to do"; exit 0; }
if [ -z "$EVENT" ]; then
  EVENT=$(jq -r '.event // .type // empty' <<<"$PAYLOAD" 2>/dev/null) || EVENT=""
fi

# pfield EXPR — read a payload field defensively: the payload is the EventData
# object today, but tolerate an {event, data} envelope shape too.
pfield() {
  jq -r "$1" <<<"$PAYLOAD" 2>/dev/null || true
}

ledger_root() { printf '%s\n' "${RALPH_HERDR_LEDGER_ROOT:-$HOME/.ralph}"; }

# ledger_for_agent NAME — find the ledger that holds NAME open; prints
# "FILE<TAB>REF" for the first match. rc 1 when no ledger knows the agent.
# Ledgers nest as <root>/<owner>/<repo>/ledger.jsonl (see ledger.sh).
ledger_for_agent() {
  local name="$1" f ref
  for f in "$(ledger_root)"/*/*/ledger.jsonl; do
    [ -f "$f" ] || continue
    ref=$(RALPH_HERDR_LEDGER="$f" ralph_ledger_open_agents |
      awk -F'#' -v n="$name" '$1 == n { print; exit }') || ref=""
    if [ -n "$ref" ]; then
      printf '%s\t%s\n' "$f" "$ref"
      return 0
    fi
  done
  return 1
}

# live_names — space-separated names of ALL live herdr agents (the orphan
# pass only needs membership). A failed read yields the empty set: adoption
# then conservatively falls back to orphaned, and the next reconcile heals.
live_names() {
  "$HERDR" agent list 2>/dev/null |
    jq -r '.result.agents[]? | select(.name != null) | .name' 2>/dev/null |
    tr '\n' ' ' || true
}

# ── pane.agent_status_changed ────────────────────────────────────────────────
handle_status() {
  local agent status pane parsed legacy entry file ref ts cwd repo_root
  local lane issue slug gen title labels body
  agent=$(pfield '.agent // .data.agent // empty')
  status=$(pfield '.agent_status // .data.agent_status // empty')
  pane=$(pfield '.pane_id // .data.pane_id // empty')
  [ -n "$agent" ] || exit 0
  [ -n "$status" ] || exit 0

  # Ralph agents only: grammar-B / gh-N via ralph_agent_parse, plus the two
  # legacy singleton lanes (which have no parseable identity — they get
  # attention routing but no ledger record; reconcile skips them the same way).
  legacy=""
  if ! parsed=$(ralph_agent_parse "$agent"); then
    case "$agent" in
      ralph-deliver | ralph-tend) legacy=1 ;;
      *) exit 0 ;;
    esac
  fi

  ts=$(date -u +%FT%TZ)
  file="" ref=""
  if [ -z "$legacy" ]; then
    if entry=$(ledger_for_agent "$agent"); then
      IFS=$'\t' read -r file ref <<<"$entry"
    else
      # First sighting: no ledger holds this agent open (spawned before the
      # watcher existed, or by hand). Resolve its board scope from the pane's
      # cwd; the discover append happens under the ledger lock below, after a
      # re-check — two concurrent status events for one unledgered agent must
      # mint ONE identity, not two epochs.
      cwd=$("$HERDR" pane get "$pane" 2>/dev/null |
        jq -r '.result.pane.foreground_cwd // .result.pane.cwd // empty' 2>/dev/null) || cwd=""
      repo_root=""
      if [ -n "$cwd" ]; then
        repo_root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || repo_root="$cwd"
      fi
      if [ -n "$repo_root" ]; then
        file=$(ralph_ledger_path "$repo_root" 2>/dev/null) || file=""
      fi
      if [ -z "$file" ]; then
        log "no ledger scope resolvable for $agent (pane $pane) — routing attention without a ledger record"
      fi
    fi
  fi

  if [ -n "$file" ]; then
    export RALPH_HERDR_LEDGER="$file"
    ralph_ledger_lock "$file"
    if [ -z "$ref" ]; then
      # Re-check under the lock: the racing hook that beat us to the mutex
      # may have discovered this agent already — reuse its ref.
      ref=$(ralph_ledger_open_agents 2>/dev/null |
        awk -F'#' -v n="$agent" '$1 == n { print; exit }') || ref=""
      if [ -n "$ref" ]; then
        log "discover race: $ref already ledgered — reusing"
      elif ref=$(ralph_agent_ref "$agent" 2>/dev/null); then
        # shellcheck disable=SC2086  # intentional: parse output is space-separated
        set -- $parsed
        lane="$1" issue="$2" slug="$3" gen="$4"
        [ "$slug" = "''" ] && slug=""
        [ "$gen" = "''" ] && gen=""
        ralph_ledger_append "$(jq -nc --arg ts "$ts" --arg ref "$ref" --arg p "$pane" \
          --arg lane "$lane" --arg issue "$issue" --arg slug "$slug" \
          '{ts: $ts, ev: "discover", agent_ref: $ref, pane_id: $p, via: "event",
            tokens: ({role: $lane, issue: $issue} + (if $slug == "" then {} else {slug: $slug} end))}')" ||
          log "discover append failed for $agent"
        log "discover $ref (pane $pane) in $file"
      else
        ref=""
        log "no durable ref derivable for $agent — routing attention without a ledger record"
      fi
    fi
    if [ -n "$ref" ]; then
      ralph_ledger_append "$(jq -nc --arg ts "$ts" --arg ref "$ref" --arg st "$status" --arg p "$pane" \
        '{ts: $ts, ev: "state", agent_ref: $ref, agent_status: $st, pane_id: $p, via: "event"}')" ||
        log "state append failed for $ref"
    fi
    ralph_ledger_unlock "$file"
  fi

  # State token: only herdr statuses with a clean C8 lifecycle mapping are
  # pushed (working→working, blocked→blocked). idle/done/unknown carry no
  # honest lifecycle claim — the token keeps its last value; the ledger's
  # state event above still records the raw status.
  case "$status" in
    working | blocked)
      if [ -n "$pane" ]; then
        ralph_tokens_push "$pane" "state=$status"
      fi
      ;;
  esac

  if [ "$status" = "blocked" ]; then
    title=$(pfield '.title // .data.title // empty')
    labels=$(pfield '(.state_labels // .data.state_labels // {}) | to_entries | map(.value) | join("; ")')
    body="$title"
    if [ -n "$labels" ]; then
      body="${body:+$body — }$labels"
    fi
    [ -n "$body" ] || body="attend the pane"
    body=$(printf '%s' "$body" | tr '\r\n' '  ')
    body=${body:0:240}
    "$HERDR" notification show "$agent blocked" --body "$body" >/dev/null 2>&1 || true
    log "notified: $agent blocked — $body"
  fi
}

# ── pane.exited / pane.closed ────────────────────────────────────────────────
handle_gone() {
  local reason="$1" pane live f refs ref ts
  pane=$(pfield '.pane_id // .data.pane_id // empty')
  [ -n "$pane" ] || exit 0
  live=$(live_names)
  ts=$(date -u +%FT%TZ)
  for f in "$(ledger_root)"/*/*/ledger.jsonl; do
    [ -f "$f" ] || continue
    export RALPH_HERDR_LEDGER="$f"
    # Locked read-decide-append: pane.exited and pane.closed both fire for
    # one pane death and the hooks run concurrently — whichever takes the
    # mutex second re-reads a ledger where the ref is already closed (and
    # the children already adopted/orphaned) and appends/notifies nothing.
    ralph_ledger_lock "$f"
    refs=$(ralph_ledger_open_for_pane "$pane") || refs=""
    for ref in $refs; do
      ralph_ledger_append "$(jq -nc --arg ts "$ts" --arg ref "$ref" --arg r "$reason" --arg p "$pane" \
        '{ts: $ts, ev: "exit", agent_ref: $ref, reason: $r, pane_id: $p}')" ||
        log "exit append failed for $ref"
      log "exit $ref (reason $reason, pane $pane)"
      ralph_ledger_orphan_pass "$ref" "$live"
    done
    ralph_ledger_unlock "$f"
  done
}

case "$EVENT" in
  pane.agent_status_changed | pane_agent_status_changed) handle_status ;;
  pane.exited | pane_exited) handle_gone pane_exited ;;
  pane.closed | pane_closed) handle_gone pane_closed ;;
  *) exit 0 ;;
esac
