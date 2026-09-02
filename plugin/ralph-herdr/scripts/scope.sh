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

# The session dimension — ralph_session_key — lives in ledger.sh (GH-1933),
# because ralph_ledger_append stamps it on every record and ledger.sh is
# sourced first everywhere. It is the same key this file's doctrine describes.

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
  #
  # Read from the SAME file the owner/repo came from, mirroring board.ts's
  # wholesale-per-file rule: .ralph.json when present, else the settings env
  # block. Defaulting the host to github.com while owner/repo came from
  # settings would silently mis-scope every GHE board.
  if [ -f "$root/.ralph.json" ]; then
    host=$(jq -r '.host // empty' "$root/.ralph.json" 2>/dev/null) || host=""
  else
    host=$(jq -r '.env.RALPH_GH_HOST // empty' "$root/.claude/settings.json" 2>/dev/null) || host=""
  fi
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
# The weakest tier matches a root or any path beneath it, on a path-separator
# boundary — so `/repo-other` never matches `/repo`, while `/repo/src` (a
# worker that cd'd into a subdirectory) still does. It is deliberately NOT a
# `git rev-parse` on the reported path: that would be a fork per agent per
# refresh on the cockpit's hot path, and it would consult the filesystem about
# a directory the reporting process may already have left.
#
# The looseness is bounded by where this tier applies at all — only to
# workspaces carrying no worktree provenance. A nested checkout inside our tree
# has its own provenance and is matched (or excluded) by the authoritative tier
# above, before this one is ever consulted.
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
    # A root itself, or anything BENEATH it. A pane cwd is wherever the shell
    # last moved to, so a worker sitting in $REPO/src is still in $REPO —
    # exact equality would make it invisible, and the spawn pre-check that
    # reads this would then miss a live owner and attempt a duplicate spawn.
    # The boundary slash is what stops /repo from swallowing /repo-other.
    # Each root is bound to $r before use: inside startswith(...) the implicit
    # dot would rebind to the piped-in path, silently comparing it to itself.
    def mine: . != null and (norm as $p
      | $roots | map(. as $r | $p == $r or ($p | startswith($r + "/"))) | any);
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
           # The current C8 `state` token on the pane, carried so a caller reading a
           # terminal agent_status can ask outcome.sh whether the session ever
           # closed out (GH-1907). Null when the pane has none — and null is
           # the ABSENCE of a completion claim, never a claim of one.
           state_token: ($p.tokens.state // null),
           via: $via})
    | .[]'
}

# RALPH_NAME_RE — the display convention for a Ralph-owned agent: the legacy
# grammar (gh-N, and the pre-GH-2342 lane-pass names ralph-deliver/tend) or
# grammar B (<lane><issue>-…, which the current t0-tend / r0-deliver are). Named
# rather than inlined because it is read from BOTH sides now — `grep -E` below
# and jq's `test()` in ralph_herd_by_scope — and two spellings of the same
# convention is exactly how a filter starts disagreeing with itself. The syntax
# used here (anchors, alternation, classes) means the same thing to POSIX ERE
# and to jq's Oniguruma.
RALPH_NAME_RE='^gh-[0-9]+$|^ralph-(deliver|tend)$|^[a-z][0-9]+-[a-z].*$'

# ralph_is_ralph_name NAME — RALPH_NAME_RE as a predicate.
# A convention, never a boundary — see ralph_agents_json.
ralph_is_ralph_name() {
  case "${1-}" in '' | null) return 1 ;; esac
  printf '%s' "$1" | grep -Eq "$RALPH_NAME_RE"
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
# Scope is resolved per DISTINCT CHECKOUT, not per agent: the resolution reads
# config off disk and may fork `git rev-parse`, and a session with a dozen
# workers in one worktree would otherwise pay for the same answer a dozen
# times.
#
# An agent whose scope resolves to null is deliberately RETAINED here with a
# null tag rather than dropped, because reconcile needs to tell "this agent
# belongs to another repository" (leave it entirely alone) from "this agent
# belongs to no repository I can identify" (also leave it alone, but say so).
# Dropping it would make the two look identical to a caller counting names.
#
# Shape (GH-1775): a keyed join in three steps — filter, resolve the distinct
# key set, join the map back on — rather than a per-agent loop. The old form
# forked three jq per agent and memoized only the LAST checkout seen, so a herd
# whose workers interleave across worktrees re-resolved every one of them. Cost
# is now a fixed handful of jq passes plus one resolution per distinct
# checkout, and it stops growing with the number of agents.
#
# rc 1 when the snapshot cannot be read. That is a CHANGE and a deliberate one:
# the old loop consumed `ralph_all_agents` through a heredoc, so a jq failure
# on a malformed snapshot produced an empty herd and rc 0 — indistinguishable
# from "this session has no Ralph agents", which is precisely the distinction
# reconcile's `if ! live_json=$(...)` guard exists to act on before it sweeps.
ralph_herd_by_scope() {
  local snapshot="$1" named paths path scope map='{}'

  named=$(ralph_all_agents "$snapshot" |
    jq -c --arg re "$RALPH_NAME_RE" 'select((.name // "") | test($re))') || return 1
  [ -n "$named" ] || return 0

  paths=$(printf '%s\n' "$named" | jq -r '.checkout // empty' | sort -u) || return 1
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    scope=$(ralph_repo_scope "$path" 2>/dev/null) || scope=""
    map=$(printf '%s' "$map" | jq -c --arg p "$path" --arg s "$scope" \
      '.[$p] = (if $s == "" then null else $s end)') || return 1
  done <<EOF
$paths
EOF

  printf '%s\n' "$named" | jq -c --argjson m "$map" \
    '. + {scope: ($m[.checkout // ""] // null)}'
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
           checkout: ($wt.checkout_path // $wt.repo_root // $p.cwd // $a.cwd // null),
           state_token: ($p.tokens.state // null)})
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
