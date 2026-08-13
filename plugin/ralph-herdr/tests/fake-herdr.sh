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
# ── Protocol validity is the fake's job, not each fixture's ──────────────────
#
# Herdr 0.8.0 speaks protocol 19: every success carries a correlation `id` and
# a `result.type` discriminant, and Ralph's transport adapter refuses anything
# that doesn't. A fake that answered with bare `{"result":{"agents":[]}}` would
# be accepting a combination the real server cannot produce — so tests written
# against it would pass while the real thing failed, which is precisely the
# class of bug GH-1774 exists to close.
#
# So the fake OWNS the envelope. It knows the id and result type for each
# subcommand it dispatches (it already dispatches on them) and composes:
#
#   {"id": "cli:agent:list", "result": {"type": "agent_list"} + <fixture>}
#
# Fixtures therefore supply only the PAYLOAD — `{"agents":[…]}` — and every
# existing and future fixture is protocol-valid by construction. A fixture may
# still override `type` or `id` by including them; the composed defaults lose
# to whatever the fixture states, which is what makes the wrong-type and
# mismatched-id adversarial cases expressible.
#
# For responses that must be malformed at a level no envelope composition can
# express — invalid JSON, trailing garbage, two envelopes, an empty body — use
# a `<key>.raw` fixture. Raw fixtures are emitted BYTE FOR BYTE with no
# composition and no validation. That is the adversarial surface.
#
# Knobs:
#   FAKE_HERDR_FIXTURES  dir of canned responses (unset = built-in defaults)
#   FAKE_HERDR_LOG       invocation log — one line per call, argv joined by
#                        spaces (unset = no logging)
#
# Fixture files, first match wins (all under $FAKE_HERDR_FIXTURES):
#   agent list                    agent-list.json         payload {agents:[…]}
#   agent start <NAME> …          agent-start.<NAME>.json, then agent-start.json
#   agent prompt …                agent-prompt.json
#   agent focus <NAME>            agent-focus.json
#   agent read <NAME> …           agent-read.<NAME>.txt, then agent-read.txt —
#                                 RAW pane text, not a JSON envelope (default:
#                                 empty output, the blank-tail degradation)
#   agent                         agent-help.txt — RAW command list (default
#                                 mimics 0.8.0's "herdr agent commands" list;
#                                 cockpit-view.sh's capability probe)
#   api snapshot                  api-snapshot.json       payload {snapshot:{…}}
#   pane get <ID>                 pane-get.<ID>.json, then pane-get.json
#   pane process-info --pane <ID> pane-process-info.<ID>.json, then
#                                 pane-process-info.json (default: a live
#                                 claude in an un-rebuilt shell)
#   pane split <ID> …             pane-split.<ID>.json, then pane-split.json
#   pane report-metadata …        pane-report-metadata.json
#   plugin pane …                 plugin-pane.json
#   worktree list …               worktree-list.json      payload {source:{…},worktrees:[…]}
#   worktree create …             worktree-create.json
#   worktree open …               worktree-open.json
#   notification show …           notification-show.json
#   any of the above              <cmd>-<sub>.raw   verbatim body, no envelope
#                                 <cmd>-<sub>.err   text emitted on STDERR
#                                                   (a chatty-but-successful
#                                                   server; pins that callers
#                                                   never merge it into stdout)
#                                 <cmd>-<sub>.rc    forces the exit code
#                                 (failure injection; body still printed;
#                                 per-arg fixtures share the base key's .rc)
#
# Built-in defaults answer the shapes the watcher scripts parse: an empty
# herd, an empty pane, and protocol-valid success envelopes. Anything not
# modeled here prints an .error body and exits 1 — a test reaching for an
# unmodeled subcommand should fail loudly, not silently succeed.
#
# The real herdr 0.8.x CLI answers a refusal on STDERR — an error JSON body
# there, an empty stdout, and a nonzero exit (re-probed for GH-1832; see
# respond() for the capture). Mirror a refusal by pairing a *.json error
# fixture WITH a *.rc file carrying the nonzero code; the fake routes the
# envelope to the right pipe on its own. A test that needs the envelope on
# STDOUT instead — the shape checks, which must be refused whichever pipe they
# come from — uses a *.raw fixture, which is emitted verbatim on stdout.
# bash 3.2 compatible.
set -u

FIX="${FAKE_HERDR_FIXTURES:-}"
LOG="${FAKE_HERDR_LOG:-}"

if [ -n "$LOG" ]; then
  printf '%s\n' "$*" >>"$LOG"
fi

# fixture_body KEY... — print the first existing "$FIX/<KEY>.json" body; rc 1
# when none exists (callers fall through to their built-in default payload).
fixture_body() {
  local key
  for key in "$@"; do
    if [ -n "$FIX" ] && [ -f "$FIX/$key.json" ]; then
      cat "$FIX/$key.json"
      return 0
    fi
  done
  return 1
}

# raw_body KEY... — print the first existing "$FIX/<KEY>.raw" VERBATIM. The
# escape hatch for responses that are deliberately not valid protocol (and
# often not valid JSON), so it must never be parsed or reshaped on the way out.
raw_body() {
  local key
  for key in "$@"; do
    if [ -n "$FIX" ] && [ -f "$FIX/$key.raw" ]; then
      cat "$FIX/$key.raw"
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

# respond ID TYPE DEFAULT_PAYLOAD FIXTURE_KEY... — the composition step.
#
# Emits {"id": ID, "result": {"type": TYPE} + payload}, where payload is the
# first matching fixture body or DEFAULT_PAYLOAD. A fixture that itself states
# `id` or `type` wins over the composed values (jq's later-operand-wins
# semantics), which is how a test asks for a wrong-type or mismatched-id
# response without hand-rolling a whole envelope.
#
# A fixture that is not valid JSON is a broken test, not a scenario: those go
# through .raw. So this fails loudly rather than emitting something halfway.
respond() {
  local id="$1" type="$2" default="$3"; shift 3
  local payload

  payload=$(fixture_body "$@") || payload="$default"

  if ! printf '%s' "$payload" | jq -e . >/dev/null 2>&1; then
    printf '{"error":{"code":"fake_herdr_bad_fixture","message":"fixture for %s is not valid JSON — use a .raw fixture for deliberately malformed bodies"}}\n' "$type" >&2
    return 1
  fi

  # Three shapes a fixture can take, in precedence order:
  #   {"error":{…}}   an error envelope — emitted as one, never wrapped in a
  #                   result, because that is what the real CLI does on refusal
  #   {"id":…, …}     an explicit id — overrides the composed one, which is how
  #                   the mismatched-correlation case is written
  #   anything else   the payload, merged under the composed result.type
  #
  # An error envelope goes to STDERR with stdout left empty, because that is
  # where the real binary puts it. Re-probed for GH-1832 against 0.8.x:
  #
  #   $ herdr worktree create --cwd <a linked worktree> …
  #   rc 1 | stdout: (empty)
  #        | stderr: {"error":{"code":"linked_worktree_source",…},"id":"cli:worktree:create"}
  #   $ herdr agent start x --kind claude --pane <bogus>
  #   rc 1 | stdout: (empty)
  #        | stderr: {"error":{"code":"agent_pane_not_found",…},"id":"cli:agent:start"}
  #
  # This fake previously answered refusals on stdout. The header's earlier
  # probe note recorded the exit code and not the channel, so the whole rc-2
  # suite passed green against a channel the server never uses — while the
  # adapter, reading stdout only, turned every real refusal into rc 3 "server
  # unreachable". A fake that models the wrong pipe does not test the boundary;
  # it certifies it.
  local envelope
  envelope=$(printf '%s' "$payload" | jq -c --arg id "$id" --arg type "$type" '
    (.id // $id) as $rid
    | if has("error") then {id: $rid, error: .error}
      else {id: $rid, result: ({type: $type} + (del(.id)))}
      end')
  if printf '%s' "$envelope" | jq -e 'has("error")' >/dev/null 2>&1; then
    printf '%s\n' "$envelope" >&2
  else
    printf '%s\n' "$envelope"
  fi
}

key="${1-}-${2-}"

# Stderr noise, independent of the body: the real binary logs diagnostics there
# on successful calls too, and a caller that captures with 2>&1 turns them into
# a corrupt response. Emitted BEFORE the body so a merging caller gets exactly
# the prepended-garbage shape that breaks jq.
if [ -n "$FIX" ] && [ -f "$FIX/$key.err" ]; then
  cat "$FIX/$key.err" >&2
fi

# A .raw fixture short-circuits everything: byte-for-byte output, then the
# forced rc. Checked before dispatch so even an unmodeled subcommand can be
# given a deliberately broken response.
if raw_body "$key"; then
  exit "$(rc_for "$key")"
fi

case "$key" in
  agent-list)
    respond "cli:agent:list" "agent_list" '{"agents":[]}' agent-list
    ;;
  agent-start)
    # AgentInfo's required fields are present in the default because the
    # transport adapter checks the envelope, and a caller that starts an agent
    # goes straight on to use its pane.
    respond "cli:agent:start" "agent_started" \
      "$(printf '{"agent":{"name":"%s","agent_status":"idle","pane_id":"p1","workspace_id":"w1","tab_id":"w1:t1","terminal_id":"term_fake","focused":false,"revision":1},"argv":["claude"]}' "${3-}")" \
      "agent-start.${3-}" agent-start
    ;;
  agent-prompt)
    respond "cli:agent:prompt" "agent_prompted" \
      "$(printf '{"agent":{"name":"%s","agent_status":"working","pane_id":"p1","workspace_id":"w1","tab_id":"w1:t1","terminal_id":"term_fake","focused":false,"revision":2}}' "${3-}")" \
      agent-prompt
    ;;
  agent-focus)
    respond "cli:agent:focus" "ok" '{}' agent-focus
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
  api-snapshot)
    # SessionSnapshot's required fields, all present: version/protocol (which
    # double as the capability probe) and the five arrays the join reads. An
    # empty session is the honest default — a test wanting agents supplies them.
    respond "cli:api:snapshot" "session_snapshot" \
      '{"snapshot":{"version":1,"protocol":19,"workspaces":[],"tabs":[],"panes":[],"layouts":[],"agents":[]}}' \
      api-snapshot
    ;;
  plugin-pane)
    respond "cli:plugin:pane" "plugin_pane_opened" '{"plugin_pane":{"pane_id":"pP1"}}' plugin-pane
    ;;
  pane-get)
    respond "cli:pane:get" "pane_info" \
      '{"pane":{"pane_id":"p1","terminal_id":"term_fake","workspace_id":"w1","tab_id":"w1:t1","focused":false,"agent_status":"unknown","revision":1}}' \
      "pane-get.${3-}" pane-get
    ;;
  pane-split)
    respond "cli:pane:split" "pane_info" \
      '{"pane":{"pane_id":"pS1","terminal_id":"term_fake","workspace_id":"w1","tab_id":"w1:t1","focused":false,"agent_status":"unknown","revision":1}}' \
      "pane-split.${3-}" pane-split
    ;;
  pane-report-metadata)
    respond "cli:pane:report-metadata" "ok" '{}' pane-report-metadata
    ;;
  pane-process-info)
    # `pane process-info --pane <ID>` — the id is not positional, so the
    # per-pane fixture key is scanned out of argv rather than read from $3.
    #
    # The DEFAULT is a healthy worker: a shell that was never rebuilt and a
    # live `claude` in the foreground. That matters — reconcile's claim
    # recovery treats "no harness process" as evidence of death, so a default
    # of "nothing running" would make every existing fixture's open agent look
    # dead and release its claim. argv0 carries the binary name because herdr
    # reports a claude process's `name` as its VERSION string.
    _pi_pane=""
    _pi_prev=""
    for _pi_arg in "$@"; do
      [ "$_pi_prev" = "--pane" ] && _pi_pane="$_pi_arg"
      _pi_prev="$_pi_arg"
    done
    # Per-pane .raw, checked here rather than at the top: the global raw hook
    # keys on "<cmd>-<sub>" and cannot see a pane id that arrives as an option
    # value. Without this, "this ONE pane is unreadable" is inexpressible —
    # and that is the case reconcile's fail-closed branch turns on.
    if raw_body "pane-process-info.$_pi_pane"; then
      exit "$(rc_for "pane-process-info.$_pi_pane")"
    fi
    respond "cli:pane:process_info" "pane_process_info" \
      "$(printf '{"process_info":{"pane_id":"%s","shell_pid":9000,"foreground_process_group_id":9100,"foreground_processes":[{"argv0":"claude","name":"2.1.229","pid":9100,"cmdline":"claude"}]}}' "$_pi_pane")" \
      "pane-process-info.$_pi_pane" pane-process-info
    ;;
  worktree-create)
    # The spawn path reads root_pane.pane_id and worktree.path — a default
    # must answer both or every live-spawn test would need a fixture. workspace
    # and tab ride along because worktree_created requires them.
    respond "cli:worktree:create" "worktree_created" \
      '{"workspace":{"workspace_id":"w1","number":1,"label":"fake","focused":false,"pane_count":1,"tab_count":1,"active_tab_id":"w1:t1","agent_status":"unknown"},"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"pW1"},"worktree":{"path":"/tmp/fake-herdr-wt"}}' \
      worktree-create
    ;;
  worktree-list)
    # The spawn path reads .source.source_checkout_path to find the checkout
    # herdr will start a worktree action from (GH-1860). The default answers a
    # parent that differs from any plausible test cwd, so a test asserting the
    # resolution cannot pass by accident.
    respond "cli:worktree:list" "worktree_list" \
      '{"source":{"repo_key":"/tmp/fake-herdr-parent/.git","repo_name":"fake","repo_root":"/tmp/fake-herdr-parent","source_checkout_path":"/tmp/fake-herdr-parent","source_workspace_id":"w1"},"worktrees":[]}' \
      worktree-list
    ;;
  worktree-open)
    respond "cli:worktree:open" "worktree_opened" \
      '{"workspace":{"workspace_id":"w1","number":1,"label":"fake","focused":false,"pane_count":1,"tab_count":1,"active_tab_id":"w1:t1","agent_status":"unknown"},"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"pW1"},"worktree":{"path":"/tmp/fake-herdr-wt"},"already_open":true}' \
      worktree-open
    ;;
  notification-show)
    respond "cli:notification:show" "notification_show" '{"shown":true,"reason":"delivered"}' notification-show
    ;;
  *)
    printf '{"id":"cli:unhandled","error":{"code":"fake_herdr_unhandled","message":"unmodeled command %s"}}\n' "$key" >&2
    exit 1
    ;;
esac
exit "$(rc_for "$key")"
