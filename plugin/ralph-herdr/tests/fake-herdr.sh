#!/usr/bin/env bash
# fake-herdr.sh — a PATH-shim `herdr` for the watcher tests. Replays canned
# JSON per subcommand from a fixtures dir and records every invocation to a
# log so tests can assert exactly which herdr calls a script made (and how
# many times). No server, no sockets, no panes — pure files.
#
# Wire-up (watcher.test.sh does both):
#   ln -s .../fake-herdr.sh "$TMP/bin/herdr"; PATH="$TMP/bin:$PATH"
#   export HERDR_BIN_PATH="$TMP/bin/herdr"      # scripts prefer this knob
#
# Knobs:
#   FAKE_HERDR_FIXTURES  dir of canned responses (unset = built-in defaults)
#   FAKE_HERDR_LOG       invocation log — one line per call, argv joined by
#                        spaces (unset = no logging)
#
# Fixture files, first match wins (all under $FAKE_HERDR_FIXTURES):
#   agent list                    agent-list.json
#   agent start <NAME> …          agent-start.<NAME>.json, then agent-start.json
#   agent prompt …                agent-prompt.json
#   agent focus <NAME>            agent-focus.json
#   agent read <NAME> …           agent-read.<NAME>.txt, then agent-read.txt —
#                                 RAW pane text, not a JSON envelope (default:
#                                 empty output, the blank-tail degradation)
#   agent                         agent-help.txt — RAW command list (default
#                                 mimics 0.8.0's "herdr agent commands" list;
#                                 cockpit-view.sh's capability probe)
#   pane get <ID>                 pane-get.<ID>.json, then pane-get.json
#   pane split <ID> …             pane-split.<ID>.json, then pane-split.json
#   pane report-metadata …        pane-report-metadata.json
#   plugin pane …                 plugin-pane.json
#   worktree create …             worktree-create.json
#   worktree open …               worktree-open.json
#   notification show …           notification-show.json
#   any of the above              <cmd>-<sub>.rc — forces the exit code
#                                 (failure injection; body still printed;
#                                 per-arg fixtures share the base key's .rc)
#
# Built-in defaults answer the shapes the watcher scripts parse: an empty
# herd, an empty pane, and bare success envelopes. Anything not modeled here
# prints an .error body and exits 1 — a test reaching for an unmodeled
# subcommand should fail loudly, not silently succeed.
#
# The real herdr 0.8.0 CLI prints an .error JSON body AND exits nonzero when
# the server refuses (probed: pane_not_found → rc 1) — mirror a refusal by
# pairing a *.json error fixture WITH a *.rc file carrying the nonzero code.
# An error body with rc 0 models only a hypothetical future CLI that reports
# refusals softly. bash 3.2 compatible.
set -u

FIX="${FAKE_HERDR_FIXTURES:-}"
LOG="${FAKE_HERDR_LOG:-}"

if [ -n "$LOG" ]; then
  printf '%s\n' "$*" >>"$LOG"
fi

# emit_fixture KEY... — cat the first existing "$FIX/<KEY>.json"; rc 1 when
# none exists (callers fall through to their built-in default).
emit_fixture() {
  local key
  for key in "$@"; do
    if [ -n "$FIX" ] && [ -f "$FIX/$key.json" ]; then
      cat "$FIX/$key.json"
      return 0
    fi
  done
  return 1
}

# emit_raw KEY... — cat the first existing "$FIX/<KEY>.txt" (RAW text
# surfaces: agent read's pane tail, the bare `agent` command list); rc 1 when
# none exists.
emit_raw() {
  local key
  for key in "$@"; do
    if [ -n "$FIX" ] && [ -f "$FIX/$key.txt" ]; then
      cat "$FIX/$key.txt"
      return 0
    fi
  done
  return 1
}

# rc_for KEY — the forced exit code from "$FIX/<KEY>.rc", default 0.
rc_for() {
  local key="$1"
  if [ -n "$FIX" ] && [ -f "$FIX/$key.rc" ]; then
    cat "$FIX/$key.rc"
  else
    echo 0
  fi
}

key="${1-}-${2-}"

case "$key" in
  agent-list)
    emit_fixture agent-list || echo '{"result":{"agents":[]}}'
    ;;
  agent-start)
    emit_fixture "agent-start.${3-}" agent-start ||
      printf '{"result":{"agent":{"name":"%s"}}}\n' "${3-}"
    ;;
  agent-prompt)
    emit_fixture agent-prompt || echo '{"result":{}}'
    ;;
  agent-focus)
    emit_fixture agent-focus || echo '{"result":{}}'
    ;;
  agent-read)
    # RAW pane text (what --source recent-unwrapped prints), never a JSON
    # envelope. No fixture = an empty tail — the honest blank-pane read.
    emit_raw "agent-read.${3-}" agent-read || true
    key="agent-read"
    ;;
  agent-)
    # Bare `herdr agent` echoes its command list (the real 0.8.0 exits rc 2,
    # a usage exit; force it with agent-help.rc when a test needs the code —
    # cockpit-view.sh's probe judges content only).
    emit_raw agent-help || printf 'herdr agent commands:\n  list\n  start\n  stop\n  prompt\n  focus\n  read\n'
    key="agent-help"
    ;;
  plugin-pane)
    emit_fixture plugin-pane || echo '{"result":{"pane":{"pane_id":"pP1"}}}'
    ;;
  pane-get)
    emit_fixture "pane-get.${3-}" pane-get || echo '{"result":{"pane":{}}}'
    ;;
  pane-split)
    emit_fixture "pane-split.${3-}" pane-split ||
      echo '{"result":{"pane":{"pane_id":"pS1"}}}'
    ;;
  pane-report-metadata)
    emit_fixture pane-report-metadata || echo '{"result":{"ok":true}}'
    ;;
  worktree-create)
    # The spawn path reads root_pane.pane_id and worktree.path — a default
    # must answer both or every live-spawn test would need a fixture.
    emit_fixture worktree-create ||
      echo '{"result":{"root_pane":{"pane_id":"pW1"},"worktree":{"path":"/tmp/fake-herdr-wt"}}}'
    ;;
  worktree-open)
    emit_fixture worktree-open ||
      echo '{"result":{"root_pane":{"pane_id":"pW1"},"worktree":{"path":"/tmp/fake-herdr-wt"}}}'
    ;;
  notification-show)
    emit_fixture notification-show || echo '{"result":{}}'
    ;;
  *)
    printf '{"error":{"code":"fake_herdr_unhandled","command":"%s"}}\n' "$key"
    exit 1
    ;;
esac
exit "$(rc_for "$key")"
