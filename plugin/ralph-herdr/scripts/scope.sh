#!/usr/bin/env bash
# scope.sh — the containment boundary: which agents belong to THIS repository
# in THIS Herdr session. Sourced, never run. Needs transport.sh and ledger.sh.
#
# A Herdr session is a namespace, not a project. `agent list` and
# `session.snapshot` return every agent in the session — every workspace, every
# repository, every checkout. Two Ralph-equipped repositories open in one
# session see each other's workers in full.
#
# That makes issue-number filtering a containment illusion. Repository A's
# GH-42 worker and repository B's GH-42 worker produce identical `w42-*` names,
# and a spawn-collision check, a reconcile sweep, or a cleanup pass filtering
# only by name will happily read one as the other. Filtering by $PWD is no
# better: plugin commands run from the plugin directory, and a pane's cwd is
# runtime state a shell can change.
#
# So scoping is two-dimensional and both dimensions are required:
#
#   session scope  the resolved socket — which server answered
#   repo scope     canonical host/owner/repository from board config, joined to
#                  the snapshot through workspace worktree provenance
#
# Agents outside the target repo scope are INVISIBLE, not merely deprioritized:
# they cannot be listed, matched, counted toward capacity, or mutated. And
# where provenance is ambiguous, the agent stays invisible too — an unknown
# owner is not this repository's to touch. Fail closed, in that exact order.

# ralph_session_key — a stable identifier for the Herdr server being talked to.
#
# Resolution mirrors Herdr's own socket selection: an explicit --session (which
# callers pass through RALPH_HERDR_SESSION), then HERDR_SOCKET_PATH, then
# HERDR_SESSION, then the default session. The result is hashed rather than
# used raw because it becomes a ledger path component and a socket path is
# neither length- nor charset-bounded.
#
# Why a key at all: the durable identity of a worker has to survive the socket
# being re-pointed. Two servers can host identically-named agents, and a ledger
# that cannot tell them apart will let one session's reconcile close the
# other's workers.
ralph_session_key() {
  local sock

  if [ -n "${RALPH_HERDR_SESSION:-}" ]; then
    sock="session:$RALPH_HERDR_SESSION"
  elif [ -n "${HERDR_SOCKET_PATH:-}" ]; then
    sock="socket:$HERDR_SOCKET_PATH"
  elif [ -n "${HERDR_SESSION:-}" ]; then
    sock="session:$HERDR_SESSION"
  else
    sock="session:default"
  fi

  # Normalized before hashing so "session:foo" reached by two different routes
  # produces one key. Truncated to 12 hex chars: this is a namespace tag inside
  # an already-scoped ledger path, not a security boundary.
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$sock" | shasum -a 256 | cut -c1-12
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$sock" | sha256sum | cut -c1-12
  else
    # No hasher anywhere is not a reason to lose scoping — degrade to a
    # slugified literal, which is still unique per socket, only longer.
    printf '%s' "$sock" | LC_ALL=C tr -c 'A-Za-z0-9' '-' | cut -c1-12
  fi
}

# ralph_repo_scope [REPO_ROOT] — print "host/owner/repo", the canonical
# repository identity, read from the same board config board.ts itself reads
# (.ralph.json, else .claude/settings.json's env block). rc 1 when the
# directory has no discoverable board scope — which is a refusal, not a
# default: a Ralph operation with no idea which repository it is for has no
# business touching a shared session.
ralph_repo_scope() {
  local root="${1:-$PWD}" scope host

  if [ ! -f "$root/.ralph.json" ] && [ ! -f "$root/.claude/settings.json" ]; then
    root=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null) || root="${1:-$PWD}"
  fi
  scope=$(_ralph_ledger_scope "$root") || {
    echo "ralph_repo_scope: no board scope discoverable from $root — need .ralph.json or .claude/settings.json env (RALPH_GH_OWNER/RALPH_GH_REPO)" >&2
    return 1
  }

  # GHE installs set a host; github.com is the default and is spelled out
  # rather than left empty so the scope string is always three components and
  # can never accidentally compare equal across hosts by absence.
  host=$(jq -r '.host // empty' "$root/.ralph.json" 2>/dev/null) || host=""
  [ -n "$host" ] || host="github.com"

  printf '%s/%s/%s' "$host" "${scope%% *}" "${scope#* }"
}

# ralph_repo_root [DIR] — the git toplevel for DIR, or rc 1. The verification
# anchor for provenance joins: a path only counts as belonging to this
# repository when git itself says so.
ralph_repo_root() {
  git -C "${1:-$PWD}" rev-parse --show-toplevel 2>/dev/null
}

# ralph_scoped_agents SNAPSHOT REPO_ROOT — the agents in SNAPSHOT that belong
# to the repository rooted at REPO_ROOT, as compact JSON lines:
#   {name, status, pane, workspace, agent_session, cwd, checkout}
#
# The join, in strict precedence order:
#
#   agent.workspace_id -> workspace.worktree.repo_root      (authoritative)
#                      -> workspace.worktree.checkout_path  (authoritative)
#   agent.pane_id      -> pane.cwd
#   agent.cwd / agent.foreground_cwd                        (runtime, weakest)
#
# Snapshot worktree provenance outranks runtime working directories because a
# worktree binding is server-recorded topology, while a cwd is whatever the
# shell last chdir'd to — a worker that cd's into a sibling repository must not
# thereby become that repository's worker, and one that cd's out of its own
# must not vanish from it.
#
# The weakest tier gets a second gate: a bare cwd match is accepted only when
# `git rev-parse --show-toplevel` on that path resolves to a root this
# repository owns. That is what stops `/repo-b/src` from matching `/repo-a`
# on a shared path prefix, and what stops an agent in a directory that no
# longer exists from being adopted at all.
#
# Agents whose provenance resolves to nothing are omitted. That is the fail-
# closed half of the contract and the reason this returns "the agents I can
# PROVE are mine" rather than "the agents that are probably mine".
ralph_scoped_agents() {
  local snapshot="$1" repo_root="$2" canonical physical roots

  # One repository, several legitimate spellings of its path. Herdr reports
  # paths as the process that opened them saw them; git always answers with
  # symlinks resolved. On macOS that difference is routine, not exotic —
  # $TMPDIR and /tmp both live under a /private symlink, so the same checkout
  # is "/var/folders/…" to herdr and "/private/var/folders/…" to git.
  # Comparing one spelling against the other silently scopes out every agent.
  #
  # So the match runs against the SET of spellings: as given, as git resolves
  # it, and as the filesystem resolves it. They collapse to one entry on a
  # normal path; the duplicates cost nothing and the omission costs the entire
  # herd.
  canonical=$(ralph_repo_root "$repo_root") || canonical="$repo_root"
  physical=$(cd "$repo_root" 2>/dev/null && pwd -P) || physical="$repo_root"
  roots=$(printf '%s\n%s\n%s\n' "$repo_root" "$canonical" "$physical" |
    sed 's|/*$||' | sort -u | jq -R . | jq -sc .)

  # The whole join runs inside one jq pass over one snapshot: indexed lookups
  # from workspace_id and pane_id, then a per-agent decision. Doing it in shell
  # would mean an O(agents x workspaces) scan and a fork per agent, and the
  # cockpit refresh path calls this on every tick.
  printf '%s' "$snapshot" | jq -c --argjson roots "$roots" '
    def norm: if . == null then null else sub("/+$"; "") end;
    def mine: . != null and (norm as $p | $roots | index($p) != null);
    (.workspaces // [] | map({key: .workspace_id, value: .}) | from_entries) as $ws
    | (.panes // [] | map({key: .pane_id, value: .}) | from_entries) as $panes
    | .agents // []
    | map(
        . as $a
        | ($ws[$a.workspace_id // ""] // null) as $w
        | ($panes[$a.pane_id // ""] // null) as $p
        | ($w.worktree // null) as $wt
        # Authoritative tier: server-recorded worktree provenance. repo_root is
        # the parent repository, checkout_path the linked worktree — a worker
        # in feature/GH-42s checkout is still this repositorys worker, so
        # either match counts.
        | (if $wt != null and (($wt.repo_root | mine) or ($wt.checkout_path | mine))
           then "worktree"
           # Runtime tier: only reachable when the workspace carries no
           # worktree provenance at all. A workspace that HAS provenance
           # pointing elsewhere is a definite no, never a fall-through — that
           # is the multi-repo containment case.
           elif $wt == null and (($p.cwd | mine) or ($a.cwd | mine) or ($a.foreground_cwd | mine))
           then "cwd"
           else null end) as $via
        | select($via != null)
        | {name: $a.name, status: ($a.agent_status // "unknown"),
           pane: $a.pane_id, workspace: $a.workspace_id,
           agent_session: ($a.agent_session.value // null),
           cwd: ($a.cwd // null),
           checkout: ($wt.checkout_path // $p.cwd // $a.cwd // null),
           via: $via})
    | .[]'
}

# ralph_is_ralph_name NAME — the display convention for a Ralph-owned agent:
# the legacy grammar (gh-N, ralph-deliver/tend) or grammar B (<lane><issue>-…).
# A convention, never a boundary — see ralph_agents_json.
ralph_is_ralph_name() {
  case "${1-}" in '' | null) return 1 ;; esac
  printf '%s' "$1" | grep -Eq '^gh-[0-9]+$|^ralph-(deliver|tend)$|^[a-z][0-9]+-[a-z].*$'
}

# ralph_herd_by_scope SNAPSHOT — every Ralph-named agent in SNAPSHOT, each
# tagged with the repository scope its checkout resolves to:
#   {name, status, pane, workspace, checkout, scope}
# where `scope` is "host/owner/repo" or null when the checkout names no
# board-configured repository.
#
# This is the cross-repository read, and the ONLY caller that should want it is
# reconcile.sh — which walks every ledger under the ledger root and therefore
# genuinely spans repositories. Everything else wants ralph_scoped_agents,
# which asks the narrower and safer question.
#
# Scope is resolved per checkout, not per agent, and memoized in the loop: the
# resolution reads files off disk, and a session with a dozen workers in one
# worktree would otherwise stat the same config a dozen times.
#
# An agent whose scope resolves to null is deliberately RETAINED here with a
# null tag rather than dropped, because reconcile needs to tell "this agent
# belongs to another repository" (leave it entirely alone) from "this agent
# belongs to no repository I can identify" (also leave it alone, but say so).
# Dropping it would make the two look identical to a caller counting names.
ralph_herd_by_scope() {
  local snapshot="$1" line name checkout scope
  local seen_path="" seen_scope=""

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    name=$(printf '%s' "$line" | jq -r '.name // empty')
    ralph_is_ralph_name "$name" || continue

    checkout=$(printf '%s' "$line" | jq -r '.checkout // empty')
    if [ -n "$checkout" ] && [ "$checkout" = "$seen_path" ]; then
      scope="$seen_scope"
    elif [ -n "$checkout" ]; then
      scope=$(ralph_repo_scope "$checkout" 2>/dev/null) || scope=""
      seen_path="$checkout"
      seen_scope="$scope"
    else
      scope=""
    fi

    printf '%s' "$line" | jq -c --arg scope "$scope" \
      '. + {scope: (if $scope == "" then null else $scope end)}'
  done <<EOF
$(ralph_all_agents "$snapshot")
EOF
}

# ralph_names_for_ledger LIVE_JSON LEDGER_FILE — space-separated live agent
# names belonging to the repository whose ledger LEDGER_FILE is.
#
# The two hooks that walk EVERY ledger under the ledger root (reconcile's
# exit-lost sweep, watch-event's orphan pass) both need this, and both are
# exactly where an unscoped name match does its worst damage: one marks another
# repository's live worker lost, the other adopts it as a foreign orphan's
# parent. LIVE_JSON is ralph_herd_by_scope output, taken once per pass.
#
# Ledgers nest as <root>/<owner>/<repo>/, so the path names the repository;
# agent scopes are "host/owner/repo", and the match is on the owner/repo tail
# because the ledger layout records no host. Two hosts serving the same
# owner/repo already collide in that layout, so a stricter match here would
# only hide a collision that exists anyway — while a looser one is the bug this
# function exists to prevent.
ralph_names_for_ledger() {
  local live_json="$1" dir owner repo
  dir=$(dirname "$2")
  repo=$(basename "$dir")
  owner=$(basename "$(dirname "$dir")")
  printf '%s\n' "$live_json" | jq -r --arg tail "$owner/$repo" \
    'select(.scope != null and (.scope | endswith($tail))) | .name' 2>/dev/null | tr '\n' ' '
}

# ralph_all_agents SNAPSHOT — every agent in the snapshot with its provenance
# resolved, unscoped. The raw material for ralph_herd_by_scope; not a general
# surface, because "every agent in the session" is precisely the unbounded view
# this file exists to prevent callers from taking by accident.
ralph_all_agents() {
  printf '%s' "$1" | jq -c '
    (.workspaces // [] | map({key: .workspace_id, value: .}) | from_entries) as $ws
    | (.panes // [] | map({key: .pane_id, value: .}) | from_entries) as $panes
    | .agents // []
    | map(
        . as $a
        | ($ws[$a.workspace_id // ""] // null) as $w
        | ($panes[$a.pane_id // ""] // null) as $p
        | ($w.worktree // null) as $wt
        | {name: $a.name, status: ($a.agent_status // "unknown"),
           pane: $a.pane_id, workspace: $a.workspace_id,
           agent_session: ($a.agent_session.value // null),
           checkout: ($wt.checkout_path // $wt.repo_root // $p.cwd // $a.cwd // null)})
    | .[]'
}

# ralph_scoped_agents_now REPO_ROOT — fetch one validated snapshot and print
# this repository's agents from it. The everyday entry point; callers that
# already hold a snapshot use ralph_scoped_agents directly so a reconcile pass
# makes exactly one snapshot call no matter how many times it needs the list.
#
# Propagates the transport codes unchanged (1 malformed, 2 refused, 3
# unreachable) so a caller can tell "this repository has no workers" from "I
# could not find out" — the distinction the whole file exists to preserve.
ralph_scoped_agents_now() {
  local repo_root="${1:-$PWD}" snapshot rc
  snapshot=$(ralph_herdr_snapshot) || { rc=$?; return "$rc"; }
  ralph_scoped_agents "$snapshot" "$repo_root"
}
