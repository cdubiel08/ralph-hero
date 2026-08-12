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
                 agent_status, revision, cwd: $root}],
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
