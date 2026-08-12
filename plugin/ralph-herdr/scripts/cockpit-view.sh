#!/usr/bin/env bash
# cockpit-view.sh — best-effort 'ralph' agent view for the herdr sidebar.
# TODAY A DOCUMENTED NO-OP (tokens.sh pattern): every path logs at most one
# line and exits 0. The view is DECORATION — cockpit chrome over the agent
# sidebar. Nothing may ever gate on it; degradation loses chrome, never verbs.
#
# DISCOVERED SURFACE (herdr 0.8.0, probed read-only 2026-08-11):
#
#   The SOCKET has the methods. `herdr api schema --json` (protocol 19)
#   defines agent.view.set / agent.view.clear with
#     AgentViewSetParams  {source (required), label?, filter?, sort?[]}
#     AgentViewFilter     ops all|any|not|eq|in|exists over builtin fields
#                         (status, workspace_id, tab_id, pane_id, agent,
#                         seen, state_change_seq) OR token fields
#                         ({token: NAME} — the C8 pane-metadata tokens)
#     AgentViewSort       {field, order: asc|desc}; field builtin
#                         (workspace_order, tab_order, pane_order, attention,
#                         status, agent, seen, state_change_seq) or
#                         {token: NAME}
#     AgentViewClearParams {source?}
#
#   The CLI has NO invocation surface for them: `herdr agent` lists no `view`
#   subcommand (an unknown subcommand echoes the command list, rc 0) and
#   `herdr api` offers only `snapshot` and `schema` — no generic request
#   sender. So a plugin script cannot set the view today; this stub probes on
#   every run and starts reporting the moment a CLI form ships.
#
# THE INTENDED VIEW (pinned here so it ships pre-designed):
#   source "ralph-herdr", label "ralph"
#   filter  {op: "exists", field: {token: "role"}}   — every ralph agent
#           carries the C8 role token (pushed at spawn/discover; reconcile
#           re-pushes after server restarts), so token-existence IS the
#           ralph-agent predicate, no name regex needed
#   sort    [{field: {token: "state"}, order: "asc"},
#            {field: "attention", order: "desc"}]
#           — token-based sort on the C8 state token: "blocked" sorts before
#           "done"/"orphaned"/"spawned"/"working" lexically, so asc = blocked
#           first (a lexical accident of the C8 vocabulary we accept and pin
#           here; if the vocabulary grows a pre-"blocked" state, revisit).
#           Fallback if token sorts turn out unsupported live: the builtin
#           "status" field, same asc trick ("blocked" < "working").
#
# Runnable, not sourced (reconcile.sh and any pane call it as a command);
# no arguments. Always exits 0. bash 3.2 compatible.
set -euo pipefail

HERDR="${HERDR_BIN_PATH:-herdr}"

log() { echo "$(date -u +%FT%TZ) cockpit-view: $*"; }

# Probe: does the installed CLI list an `agent view` subcommand? A bare
# `herdr agent` echoes its command list (rc 2 on 0.8.0 — a usage exit, not a
# server error; this probe never reaches the socket), so the list itself is
# the capability read — no mutation, no guessing. The rc is deliberately
# ignored: the list is judged by content, in three honest branches.
help_out=$("$HERDR" agent 2>&1) || true

if printf '%s\n' "$help_out" | grep -q 'agent view'; then
  # The surface arrived after this stub was written. Refusing to guess flag
  # syntax against a live server: an honest nudge beats a wrong request.
  log "herdr agent view EXISTS in this CLI — cockpit-view.sh predates its syntax; update it to set the 'ralph' view (shape pinned in this file's header)"
elif printf '%s\n' "$help_out" | grep -q 'herdr agent commands'; then
  log "no agent-view CLI surface in this herdr (0.8.0 has none) — view skipped, chrome only"
else
  log "herdr missing or unrecognized (${help_out:0:80}) — view skipped, chrome only"
fi
exit 0
