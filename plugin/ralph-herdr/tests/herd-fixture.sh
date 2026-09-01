#!/usr/bin/env bash
# herd-fixture.sh — build the session-snapshot fixture that a scoped herd read
# resolves against. Sourced by the test suites, never run.
#
# Before GH-1774 a test could describe the herd with a two-field agent list:
#
#   {"result":{"agents":[{"name":"w100-first","agent_status":"blocked","pane_id":"p1"}]}}
#
# That is no longer a complete description, because the plugin no longer asks
# "which agents exist" — it asks "which agents are THIS repository's". Answering
# that needs the join the real snapshot carries: agent -> workspace -> worktree
# provenance -> repository root. An agent with no reachable provenance is out of
# scope by design, so a fixture that omits it describes an empty herd.
#
# herd_fixture exists so tests keep describing the herd in the short form and
# get a protocol-valid, correctly-joined snapshot built for them. Writing the
# join out by hand at twenty call sites would be noise, and worse, each site
# would be free to get it subtly wrong.

# ── chain-of-command scrub (GH-2324) ────────────────────────────────────────
# The spawn path exports these into every pane it opens (lib.sh's _pane_env /
# _plan_env, work-team.sh's --env list), so a suite run FROM a cockpit-hosted
# session inherits the live lead/address/role and the code under test prefers
# that env over the fixture: fleet.test.sh's brief-reply case read the
# session's real lead instead of s0-watch, spawn.test.sh's lineage record
# read invoked_by=agent, work-team.test.sh's lead spawn tripped the edge guard
# as orchestrator→orchestrator. CI never saw it — its runner carries none of
# these — so the suites were unrunnable by exactly the fleet workers they
# test. Scrubbed here, once, because every herd suite sources this file;
# spawn.test.sh pins the list against the injection sites so a new pane var
# cannot leak without a test naming it.
HERD_PANE_ENV="RALPH_HERDR_LEAD RALPH_HERDR_TEAM_LEAD RALPH_HERDR_TEAM_LEAD_REF RALPH_HERDR_ADDRESS WHO_LEAD WHO_DISPATCH RALPH_HERDR_SPAWNER_ROLE RALPH_HERDR_INVOKED_BY RALPH_HERDR_LANE_TAB RALPH_HERDR_LINK_ISSUE RALPH_HERDR_LINK_KIND RALPH_HERDR_LINK_URL"
# shellcheck disable=SC2086
unset $HERD_PANE_ENV 2>/dev/null || true

# herd_fixture AGENTS_JSON [REPO_ROOT] — write the api-snapshot fixture for a
# herd of AGENTS_JSON (a JSON array of partial agents: name, agent_status, and
# optionally pane_id / workspace_id).
#
# Every agent is completed to a protocol-valid AgentInfo and, unless it names
# its own workspace_id, bound to workspace "wR" — whose worktree provenance
# points at REPO_ROOT (default $REPO_DIR). That is what puts them in scope.
#
# To model an agent from ANOTHER repository in the same session — the multi-repo
# containment case — give it a workspace_id that herd_fixture_foreign defined.
herd_fixture() {
  local agents="$1" root="${2:-$REPO_DIR}"

  jq -nc --argjson agents "$agents" --arg root "$root" '
    def complete($i):
      {name: null, agent_status: "unknown", workspace_id: "wR",
       pane_id: ("p" + ($i | tostring)), tab_id: "wR:t1",
       terminal_id: ("term" + ($i | tostring)), focused: false, revision: 1};
    {snapshot: {
      version: 1, protocol: 19,
      workspaces: [{workspace_id: "wR", number: 1, label: "repo", focused: true,
                    pane_count: ($agents | length), tab_count: 1,
                    active_tab_id: "wR:t1", agent_status: "unknown",
                    worktree: {repo_key: "test/repo", repo_name: "repo",
                               repo_root: $root, checkout_path: $root,
                               is_linked_worktree: false}}],
      tabs: [{tab_id: "wR:t1"}],
      panes: [$agents | to_entries[] | (complete(.key) + .value)
              | {pane_id, terminal_id, workspace_id, tab_id, focused,
                 agent_status, revision, cwd: $root,
                 # A partial agent may carry `tokens`: the pane metadata map the
                 # server keeps, which is where the C8 `state` token lives and
                 # therefore where the GH-1907 outcome verdict reads its evidence.
                 tokens: (.tokens // {})}],
      layouts: [],
      agents: [$agents | to_entries[] | complete(.key) + .value]
    }}' >"$FAKE_HERDR_FIXTURES/api-snapshot.json"
}

# herd_fixture_foreign OURS_JSON THEIRS_JSON [OUR_ROOT] — one session, two
# repositories. OURS_JSON lands in the in-scope workspace; THEIRS_JSON lands in
# a workspace whose worktree provenance points somewhere else entirely.
#
# The containment assertion this enables: a foreign agent may carry a name that
# matches ours exactly (both repositories number issues from 1, so `w42-fix` is
# ambiguous by construction) and must still be invisible to every scoped read.
herd_fixture_foreign() {
  local ours="$1" theirs="$2" root="${3:-$REPO_DIR}"

  jq -nc --argjson ours "$ours" --argjson theirs "$theirs" --arg root "$root" '
    def complete($ws; $i):
      {name: null, agent_status: "unknown", workspace_id: $ws,
       pane_id: ($ws + ":p" + ($i | tostring)), tab_id: ($ws + ":t1"),
       terminal_id: ($ws + "term" + ($i | tostring)), focused: false, revision: 1};
    ([$ours | to_entries[] | complete("wR"; .key) + .value]) as $mine
    | ([$theirs | to_entries[] | complete("wF"; .key) + .value]) as $foreign
    | {snapshot: {
        version: 1, protocol: 19,
        workspaces: [
          {workspace_id: "wR", number: 1, label: "ours", focused: true,
           pane_count: ($mine | length), tab_count: 1, active_tab_id: "wR:t1",
           agent_status: "unknown",
           worktree: {repo_key: "test/repo", repo_name: "repo",
                      repo_root: $root, checkout_path: $root,
                      is_linked_worktree: false}},
          {workspace_id: "wF", number: 2, label: "theirs", focused: false,
           pane_count: ($foreign | length), tab_count: 1, active_tab_id: "wF:t1",
           agent_status: "unknown",
           worktree: {repo_key: "other/elsewhere", repo_name: "elsewhere",
                      repo_root: "/nowhere/elsewhere",
                      checkout_path: "/nowhere/elsewhere",
                      is_linked_worktree: false}}],
        tabs: [{tab_id: "wR:t1"}, {tab_id: "wF:t1"}],
        panes: [($mine + $foreign)[]
                | {pane_id, terminal_id, workspace_id, tab_id, focused,
                   agent_status, revision}],
        layouts: [],
        agents: ($mine + $foreign)
      }}' >"$FAKE_HERDR_FIXTURES/api-snapshot.json"
}
