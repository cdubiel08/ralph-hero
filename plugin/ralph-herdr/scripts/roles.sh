#!/usr/bin/env bash
# roles.sh — the fleet role model (GH-1808). Sourced, never run.
#
# THE INVARIANT
#   Only one agent may WRITE a worktree at a time.
#
# GH-1774 removed shared-checkout fleets because K sibling /ralph:work sessions
# in one tree race on the index, the branch, and each other's uncommitted
# files, and "no amount of claim-holder bookkeeping makes concurrent writes to
# one checkout safe, because the claim is coordinating access to the ISSUE
# while the damage happens to the TREE."
#
# That finding is intact and is the reason the writer count is capped at ONE.
# What narrows is its subject: the hazard was never several AGENTS in one tree,
# it was several WRITERS. One driver plus N read-only investigators is not
# concurrent writing at all, so it is allowed — and the "one" is enforced here
# rather than asserted in prose.
#
# ROLE, NOT LANE
#   The C8 `role` token used to hold the lane letter, which is the agent name's
#   first character and was therefore already derivable from agent_ref. It now
#   holds the FLEET ROLE, which is derivable from nothing: it is a spawn-time
#   decision about who may write. ralph_role_for_lane is the DEFAULT for the
#   discover path (reconcile has no spawn to read a role from), never an
#   override — a spawn states its role.
#
# MIRRORED, UNDER A GOLDEN TABLE
#   contracts.ts (ROLES, LANE_ROLES, HUMAN_SPAWNS, spawnEdgeAllowed) owns this
#   vocabulary; the tables below are a bash mirror, the same arrangement
#   naming.sh has with slugify. tests/roles.test.sh diffs the mirror against
#   the TypeScript registry, so a role added on one side fails on the other
#   rather than drifting quietly.
#
# bash 3.2 compatible (no associative arrays). No top-level side effects.

# ralph_role_for_lane LANE — the default role for a lane letter. rc 1 on an
# unknown lane; the caller decides whether that is fatal.
ralph_role_for_lane() {
  case "${1-}" in
    w | r | d) echo driver ;;
    o) echo orchestrator ;;
    s) echo watcher ;;
    x) echo relay ;;
    i) echo investigator ;;
    t) echo tender ;;
    *)
      echo "ralph_role_for_lane: unknown lane '${1-}' (registry: w r o d s x i t)" >&2
      return 1
      ;;
  esac
}

# ralph_role_writes_tree ROLE — rc 0 when ROLE may write the working tree.
# Exactly one such agent per worktree; everything else is read-only there.
# An unknown role is NOT a writer and NOT an error here — the edge guard is
# what refuses unknown roles, and a "may this write?" question that answered
# yes on garbage would be the wrong failure direction.
ralph_role_writes_tree() {
  [ "${1-}" = "driver" ]
}

# ralph_role_tool_binding ROLE — rc 0 when ROLE's registry row requires tool
# binding (contracts.ts ROLES[role].toolBinding). Mirrors the TypeScript field
# rather than re-deriving it from writesTree, because the two mechanisms are
# independent (GH-2255's design record) and a role could in principle need one
# without the other. Opposite fail direction from ralph_role_writes_tree: an
# unknown role here answers YES (bind it) — a role this function cannot
# classify is not one we know may safely keep Edit/Write/NotebookEdit, and the
# whole point of GH-2265 is that the unrestricted case is never the default.
ralph_role_tool_binding() {
  [ "${1-}" != "driver" ]
}

# ralph_tool_binding_args ROLE — the `claude` arguments enforcing ROLE's tool
# binding, one per line (empty output for a role that may write — driver).
# Callers read them into "$@" exactly like ralph_investigator_harness_args.
#
# --disallowedTools, not --tools: --tools REPLACES the enabled set, so
# denying just these three would require enumerating every other builtin
# tool, and that list drifts the moment Claude Code ships a new one (silently
# UNDER-restricting new roles the day it happens, since an unlisted tool is
# simply unavailable — the safe direction, but still a maintenance trap this
# avoids entirely). --disallowedTools removes only the named tools from
# whatever set is otherwise enabled, so Bash and every other builtin —
# including tools that do not exist yet — stay available. Bash staying
# available is deliberate, not a leak: process containment is #2266, a
# different mechanism with the opposite failure direction (see contracts.ts).
#
# Verified empirically (GH-2265, claude 2.1.251): --disallowedTools produces
# the identical hard failure --tools does — "No such tool available: Write.
# Write is disabled for this session, in subagents as well as here" — never a
# permission prompt, so a role bound this way fails exactly as loudly as the
# investigator's existing allowlist does.
ralph_tool_binding_args() {
  ralph_role_tool_binding "${1-}" || return 0
  printf '%s\n' "--disallowedTools" "Edit,Write,NotebookEdit"
}

# ralph_role_known ROLE — rc 0 when ROLE is in the registry.
ralph_role_known() {
  case "${1-}" in
    orchestrator | driver | investigator | tender | relay | watcher) return 0 ;;
  esac
  return 1
}

# ralph_spawn_edge_guard PARENT_ROLE CHILD_ROLE — the herdr-plane spawn graph.
# PARENT_ROLE is a role or "human" (the only spawner with no record of its
# own). rc 0 allowed, rc 1 refused with the reason on stderr.
#
#   human        -> orchestrator, driver
#   orchestrator -> driver, investigator, tender
#   driver       -> investigator          (a driver never spawns a driver:
#                                          that is a second writer, or a
#                                          second tree, and both are
#                                          decomposition, not fan-out)
#   investigator, tender, relay, watcher -> nothing (leaves)
#
# The watcher's refill spawn is not an exception: it is recorded as a depth-0
# ROOT with no parent ref, the same shape a human click produces, so it never
# reaches this guard.
#
# Unknown roles are REFUSED on both sides. An edge check that waved through
# what it could not classify would fail open, and the whole point of moving
# this out of prose is that it does not.
ralph_spawn_edge_guard() {
  local parent="${1-}" child="${2-}" allowed=""
  if ! ralph_role_known "$child"; then
    echo "ralph_spawn_edge_guard: unknown child role '$child' (registry: orchestrator driver investigator tender relay watcher)" >&2
    return 1
  fi
  case "$parent" in
    human) allowed="orchestrator driver" ;;
    orchestrator) allowed="driver investigator tender" ;;
    driver) allowed="investigator" ;;
    investigator | tender | relay | watcher) allowed="" ;;
    *)
      echo "ralph_spawn_edge_guard: unknown parent role '$parent' (a role, or 'human')" >&2
      return 1
      ;;
  esac
  case " $allowed " in
    *" $child "*) return 0 ;;
  esac
  echo "ralph_spawn_edge_guard: a $parent may not spawn a $child (allowed: ${allowed:-nothing — $parent is a leaf})" >&2
  return 1
}

# ralph_driver_guard CHECKOUT [ISSUE] — the one-writer enforcement, structural.
# Prints the LIVE driver already holding CHECKOUT and returns 1; rc 0 (silent)
# when the tree has no live driver and a new one may take it.
#
# Two reads, and the order matters. The ledger names every driver ever spawned
# into a checkout; `agent list` says which of them still exists. A ledger hit
# alone would refuse forever on a tree whose driver died — the ledger is
# append-only and nothing retracts a spawn — so liveness is CONFIRMED against
# the herd, never inferred from the record.
#
# Fails CLOSED on an unreadable herd: an unprovable "nobody is driving this
# tree" must not become permission to add a second writer. That is the same
# direction spawn_work_session's own duplicate-owner pre-check fails in.
#
# A live driver on ISSUE itself is NOT a hit. That case — two sessions on one
# issue — is already answered by the agent-name mutex, which is atomic and
# server-side; this ledger read is eventually-honest and must not preempt it,
# or a lost name race would be reported as a tree conflict and the actual
# arbiter would never run. What this guard adds is the case the name mutex
# cannot see: a DIFFERENT unit's driver already writing this checkout.
#
# This is a structural refusal, not a lock: nothing is taken, nothing expires,
# and there is no --force. A tree whose driver is gone is simply free again.
ralph_driver_guard() {
  local checkout="${1-}" issue="${2-}" ledger refs ref name herd
  if [ -z "$checkout" ]; then
    echo "ralph_driver_guard: no checkout path given — refusing to prove a tree unowned without naming it" >&2
    return 1
  fi
  ledger=$(ralph_ledger_path "${REPO:-$PWD}" 2>/dev/null) || ledger=""
  [ -n "$ledger" ] && [ -f "$ledger" ] || return 0
  # Every driver spawn recorded into this exact checkout, newest last.
  refs=$(jq -r --arg c "$checkout" --arg i "$issue" '
    select(.ev == "spawn" and .checkout == $c and (.tokens.role // "") == "driver")
    | select($i == "" or (.tokens.issue // "") != $i)
    | .agent_ref' "$ledger" 2>/dev/null) || refs=""
  [ -n "$refs" ] || return 0
  herd=$(ralph_agents_json 2>/dev/null) || {
    echo "ralph_driver_guard: cannot read the herd — refusing to add a driver to $checkout without proving no live driver holds it" >&2
    return 1
  }
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    name="${ref%%#*}"
    if printf '%s\n' "$herd" | jq -e --arg n "$name" 'select(.name == $n)' >/dev/null 2>&1; then
      echo "ralph_driver_guard: $checkout already has a live driver — $ref. One driver owns a tree; a second writer is a decomposition signal (split the work into board issues, one worktree each), not a lock to wait on." >&2
      printf '%s\n' "$ref"
      return 1
    fi
  done <<EOF
$refs
EOF
  return 0
}

# ralph_investigator_def — the path to ralph/agents/investigator.md, derived
# from $BOARD (…/<ralph-root>/scripts/board), so it inherits lib.sh's whole
# resolution order — env override, vendored checkout, newest installed plugin
# — instead of growing a second, driftable one. $RALPH_INVESTIGATOR_AGENT
# overrides, for tests.
ralph_investigator_def() {
  local root
  if [ -n "${RALPH_INVESTIGATOR_AGENT:-}" ]; then
    printf '%s\n' "$RALPH_INVESTIGATOR_AGENT"
    return 0
  fi
  [ -n "${BOARD:-}" ] || { echo "ralph_investigator_def: no board CLI resolved — cannot locate the investigator agent definition" >&2; return 1; }
  root=$(dirname "$(dirname "$BOARD")")
  printf '%s/agents/investigator.md\n' "$root"
}

# ralph_investigator_tools — the tool allowlist an investigator session runs
# under, READ from the agent definition rather than restated here. That file
# is the single declaration of what an investigator may do; a second copy in
# bash is a copy that can drift, and the direction it would drift is
# "investigators may write".
#
# Prints a comma-separated list for `claude --tools`. rc 1 when the definition
# cannot be read or names no tools — callers MUST treat that as fatal, because
# an unrestricted fallback is exactly the failure this exists to prevent.
ralph_investigator_tools() {
  local def tools
  def=$(ralph_investigator_def) || return 1
  if [ ! -f "$def" ]; then
    echo "ralph_investigator_tools: no investigator agent definition at $def" >&2
    return 1
  fi
  # The frontmatter's `tools:` block, inline (`tools: [Read, Grep]`) or as a
  # YAML list. awk rather than a YAML dependency; the shape is pinned by
  # tests/roles.test.sh against the real file, so a reformat fails a test
  # instead of silently yielding an empty list (which this refuses anyway).
  tools=$(awk '
    /^tools:[[:space:]]*\[/ {
      line = $0
      sub(/^tools:[[:space:]]*\[/, "", line)
      sub(/\].*$/, "", line)
      gsub(/[[:space:]]/, "", line)
      print line
      exit
    }
    /^tools:[[:space:]]*$/ { inlist = 1; next }
    # The frontmatter fence closes the list. Checked BEFORE the item rule,
    # which would otherwise read `---` as an item named `--`.
    inlist && /^---[[:space:]]*$/ { if (out != "") { print out; out = "" } exit }
    inlist && /^[[:space:]]*-[[:space:]]*/ {
      t = $0
      sub(/^[[:space:]]*-[[:space:]]*/, "", t)
      gsub(/[[:space:]]/, "", t)
      out = (out == "" ? t : out "," t)
      next
    }
    inlist { if (out != "") print out; exit }
    END { if (inlist && out != "") print out }
  ' "$def")
  if [ -z "$tools" ]; then
    echo "ralph_investigator_tools: $def declares no tools — refusing to spawn an investigator with an unrestricted tool set" >&2
    return 1
  fi
  printf '%s\n' "$tools"
}

# ralph_investigator_harness_args — the `claude` arguments that make a pane an
# investigator, printed one per line (callers read them into "$@" and forward
# them verbatim through `agent start … --`, the same channel fork.sh uses).
#
# TWO flags, deliberately:
#   --agents/--agent   binds the definition itself — description, system
#                      prompt and declared tools — built inline from the file
#                      so it resolves whatever the install layout is. Naming a
#                      registered agent instead ("investigator" in a checkout,
#                      "ralph:investigator" from a plugin) would be a guess
#                      that fails at start time in the layout we guessed wrong.
#   --tools            the DOCUMENTED built-in allowlist ("specify tool names,
#                      e.g. Read,Grep,Glob"). This is the flag that carries the
#                      invariant. Whether `--agent`'s own `tools:` restricts a
#                      TOP-LEVEL session is undocumented — it is hard
#                      enforcement for a subagent, and assuming that transfers
#                      to a session flag is precisely the unverified claim this
#                      whole line of work refuses to make.
#
# rc 1 if the definition cannot be read. There is no degraded mode: an
# investigator that could not be restricted is a second writer in the tree.
ralph_investigator_harness_args() {
  local def tools json
  def=$(ralph_investigator_def) || return 1
  tools=$(ralph_investigator_tools) || return 1
  json=$(jq -Rsc --arg tools "$tools" '
    (split("\n") | map(select(. != null))) as $lines
    | {desc: ($lines | map(select(startswith("description: "))) | .[0] // "Read-only investigator." | sub("^description: "; "")),
       body: ($lines[(($lines | to_entries | map(select(.value == "---")) | .[1].key) // 0) + 1:] | join("\n"))}
    | {investigator: {description: .desc, prompt: (.body | ltrimstr("\n")),
                      tools: ($tools | split(","))}}' <"$def") || {
    echo "ralph_investigator_harness_args: could not build an agent definition from $def" >&2
    return 1
  }
  printf '%s\n' "--agents" "$json" "--agent" "investigator" "--tools" "$tools"
}
