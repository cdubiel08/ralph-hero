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

# ralph_tool_binding_observed [HARNESS_ARG...] — the tool-binding outcome a
# spawn ACHIEVED (GH-2267), read off the argv actually handed to `agent start`
# and never off the registry row: one CONTAINMENT_OUTCOMES word on stdout,
# rc 0 always (this observes; the caller decides).
#   not_requested  no binding flag in the argv at all — the driver; beside
#                  `role: tender` it is the flags-dropped defect, and it reads
#                  as one because the role is its own field on the record
#   accepted       every one of Edit, Write, NotebookEdit is outside the
#                  enabled set the argv describes (--disallowedTools naming
#                  it, or a --tools allowlist omitting it)
#   not_applied    a binding flag was passed and still leaves one of the
#                  three enabled — a writer in the tree; callers refuse
#
# WHY `accepted` AND NOT `applied`: the harness refuses an unknown flag at
# start (a failed `agent start`, loud) and answers a bound tool with "No such
# tool available" (GH-2265, measured) — so what the spawn path can observe
# without a turn is that the flags were handed over and the start succeeded.
# That is a real observation of the harness, one level short of a kernel
# denial, and it gets its own word so a reader never mistakes it for one.
# The in-pane self-test (spawn_containment_probe, lib.sh — GH-2341) can
# REFUTE this word but never promote it: measured on 2.1.258, an unbound
# Write tool writes its file with no prompt under `defaultMode: auto` and
# raises a permission dialog under `default` — both read as `not_applied`
# (a file inside the denied tree, or a pane blocked on the Write step) —
# while a BOUND harness renders no refusal at all when the model declines a
# tool it does not have, and an auto-mode classifier denial of an available
# Write looks the same. "No file" is therefore not an observed refusal, and
# `applied` stays reserved.
ralph_tool_binding_observed() {
  local a tools="" deny="" have_tools=0 have_deny=0 t enabled
  while [ "$#" -gt 0 ]; do
    a="$1"
    shift
    case "$a" in
      --disallowedTools) have_deny=1; deny="${1-}"; shift || true ;;
      --disallowedTools=*) have_deny=1; deny="${a#*=}" ;;
      --tools) have_tools=1; tools="${1-}"; shift || true ;;
      --tools=*) have_tools=1; tools="${a#*=}" ;;
    esac
  done
  if [ "$have_tools" = 0 ] && [ "$have_deny" = 0 ]; then
    echo not_requested
    return 0
  fi
  tools=$(printf '%s' "$tools" | tr -d '[:space:]')
  deny=$(printf '%s' "$deny" | tr -d '[:space:]')
  for t in Edit Write NotebookEdit; do
    enabled=1
    if [ "$have_tools" = 1 ]; then
      case ",$tools," in
        *",$t,"*) enabled=1 ;;
        *) enabled=0 ;;
      esac
    fi
    if [ "$enabled" = 1 ] && [ "$have_deny" = 1 ]; then
      case ",$deny," in
        *",$t,"*) enabled=0 ;;
      esac
    fi
    if [ "$enabled" = 1 ]; then
      echo not_applied
      return 0
    fi
  done
  echo accepted
}

# ── Process containment (GH-2266) — the OTHER half of the tree invariant ─────
#
# Tool binding (above) fails CLOSED and loudly: the model receives "No such
# tool available". Process containment fails OPEN and SILENTLY: a sandbox that
# was never applied produces no error and no signal — the process simply runs
# unconfined. Re-measured on Claude Code 2.1.257 (Darwin 25.5.0): a
# `denyWrite` given as a string instead of an array yields exit 0, a written
# file, and no warning on either stream. That failure direction shapes
# everything here:
#
#   * the settings document is BUILT by jq, never string-templated, and
#     self-validated before it is handed out (a typo is the likely defect);
#   * absence of an error is never evidence — the spawn path runs a POSITIVE
#     self-test in the pane (spawn_containment_probe, lib.sh) and refuses on
#     anything but an observed kernel denial;
#   * the platform is named: measured on macOS/Seatbelt ONLY. Linux
#     (bubblewrap/Landlock) is unmeasured and answers not_available, never
#     "probably fine".
#
# The profile is what the roles' OWN tooling needs and nothing more, each
# entry measured rather than assumed (research note:
# thoughts/shared/research/2026-09-01-sandbox-profile-spike-claude-2-1-257.md):
#   denyWrite  [<checkout realpath>]      the tree — the invariant itself
#   allowWrite [$RALPH_HOME]              budget.jsonl, the ledger, the cache,
#                                         the probe's outside marker; the
#                                         sandbox default (cwd + session tmp)
#                                         would deny all of them
#   network.allowedDomains github hosts   the board CLI is gh underneath
#   network.allowMachLookup trustd.agent  gh's Go TLS verifies through the
#                                         trust daemon; without this lookup
#                                         every gh call fails x509 (OSStatus
#                                         -26276). The docs' remedy —
#                                         excludedCommands ["gh *"] — is a
#                                         HOLE: an excluded `gh … > <tree>/f`
#                                         writes the tree (observed), so it is
#                                         refused here and excludedCommands
#                                         stays EMPTY by construction
#   network.allowUnixSockets [herdr sock] herdr's CLI is a socket client; the
#                                         top-level spelling does nothing
# Deliberately NOT here: read confinement (~/.ssh, ~/.aws) — a separate
# judgment the design record left open; and any `.git` allowance — allowWrite
# cannot re-open a path under denyWrite (deny wins for writes, measured), and
# herdr's SERVER provisions worktrees, so the lead's Bash never needs it.

# ralph_role_process_containment ROLE — rc 0 when ROLE's registry row requires
# process containment (contracts.ts ROLES[role].processContainment). Same
# fail direction as ralph_role_tool_binding: an unknown role is contained.
ralph_role_process_containment() {
  [ "${1-}" != "driver" ]
}

# ralph_containment_outcomes — the achieved-value vocabulary, one per line;
# mirror of contracts.ts CONTAINMENT_OUTCOMES (golden-table tested).
ralph_containment_outcomes() {
  printf '%s\n' applied not_applied not_available inapplicable unverified accepted not_requested
}

# ralph_process_containment_platform — prints the kernel mechanism this
# machine was MEASURED on (`seatbelt`), or rc 1 with a not_available reason.
# $RALPH_HERDR_UNAME overrides uname for tests (CI runs the bash suites on
# Linux, where the honest answer is a refusal).
ralph_process_containment_platform() {
  local os
  os="${RALPH_HERDR_UNAME:-$(uname -s 2>/dev/null || true)}"
  case "$os" in
    Darwin)
      echo seatbelt
      return 0
      ;;
  esac
  echo "process containment: not_available on ${os:-an unknown platform} — measured on macOS/Seatbelt only (GH-2266); Linux (bubblewrap/Landlock) is unmeasured and is refused rather than inherited" >&2
  return 1
}

# _ralph_containment_gh_host CHECKOUT — the GitHub host the board client in
# CHECKOUT will actually talk to, resolved from EXACTLY the two sources
# board.ts loadConfig reads and in its order: `.ralph.json`'s `host` when that
# file exists, else the tracked `.claude/settings.json` env block. Never the
# process environment — board.ts does not read it either, so a stray
# $RALPH_GH_HOST in the spawner's shell would widen the allow-list to a host
# the client never contacts (PR #2337, second P1), while reading only the
# environment would let a GHE repo whose host lives in `.ralph.json` pass the
# tree probe and then have every board call denied at the proxy (the first
# P1). The allow-list and the client key on the same fact, from the same
# files. Prints nothing for github.com or when no host is configured.
_ralph_containment_gh_host() {
  local root="${1-}" host=""
  if [ -n "$root" ] && [ -f "$root/.ralph.json" ]; then
    host=$(jq -r '.host // empty' "$root/.ralph.json" 2>/dev/null) || host=""
  elif [ -n "$root" ] && [ -f "$root/.claude/settings.json" ]; then
    host=$(jq -r '.env.RALPH_GH_HOST // empty' "$root/.claude/settings.json" 2>/dev/null) || host=""
  fi
  case "$host" in "" | github.com) return 0 ;; esac
  printf '%s\n' "$host"
}

# ralph_process_containment_settings CHECKOUT — the `--settings` document
# (one compact JSON line) that contains Bash and every child process for a
# pane whose working tree is CHECKOUT. rc 1, printing nothing, when the
# document cannot be built or does not validate: a builder that hands out a
# shape it could not check is the silent-open defect one level up.
#
# Posture, decided and written down (the spike's result depended on it):
#   failIfUnavailable:true          a missing sandbox is a startup refusal,
#                                   never a warning-and-run-unconfined
#   allowUnsandboxedCommands:false  strict mode — the dangerouslyDisableSandbox
#                                   retry is ignored, so a denied command
#                                   cannot be re-run outside the sandbox
#   autoAllowBashIfSandboxed:true   sandboxed commands run without prompts;
#                                   the pane is unattended by design
#   excludedCommands:[]             no per-command escape (see above)
ralph_process_containment_settings() {
  local checkout="${1-}" dir home sock host json
  [ -n "$checkout" ] || { echo "ralph_process_containment_settings: no checkout given — refusing to build a profile that denies nothing" >&2; return 1; }
  dir=$(cd "$checkout" 2>/dev/null && pwd -P) || { echo "ralph_process_containment_settings: $checkout is not a directory" >&2; return 1; }
  # The realpath is load-bearing: /tmp is a symlink to /private/tmp on macOS,
  # and a denyWrite spelled through the symlink denies nothing (the spike's
  # first confound).
  home="${RALPH_HOME:-$HOME/.ralph}"
  [ -d "$home" ] && home=$(cd "$home" && pwd -P)
  sock="${HERDR_SOCKET_PATH:-}"
  host=$(_ralph_containment_gh_host "$dir")
  json=$(jq -nc --arg dir "$dir" --arg home "$home" --arg sock "$sock" --arg host "$host" '
    {sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      filesystem: {denyWrite: [$dir], allowWrite: [$home]},
      network: {
        allowedDomains: (["api.github.com", "github.com"] + (if $host != "" and $host != "github.com" then [$host] else [] end)),
        allowMachLookup: ["com.apple.trustd.agent"],
        allowUnixSockets: (if $sock != "" then [$sock] else [] end)
      }
    }}') || { echo "ralph_process_containment_settings: could not build the sandbox document (jq)" >&2; return 1; }
  # Self-validate the SHAPE the spike showed degrading silently. The check
  # reads the document back rather than trusting the builder that just wrote
  # it — the same read-back discipline the board claim uses.
  jq -e --arg dir "$dir" '
    .sandbox.enabled == true
    and .sandbox.failIfUnavailable == true
    and .sandbox.allowUnsandboxedCommands == false
    and (.sandbox.excludedCommands | type == "array" and length == 0)
    and (.sandbox.filesystem.denyWrite | type == "array" and length == 1 and .[0] == $dir)
    and (.sandbox.filesystem.denyWrite[0] | startswith("/"))
    and (.sandbox.filesystem.allowWrite | type == "array")
    and (.sandbox.network.allowedDomains | type == "array" and length >= 2)
    and (.sandbox.network.allowUnixSockets | type == "array")' >/dev/null <<<"$json" 2>/dev/null || {
    echo "ralph_process_containment_settings: the built sandbox document failed its shape check — refusing to hand out a profile that may deny nothing" >&2
    return 1
  }
  printf '%s\n' "$json"
}

# ralph_process_containment_args ROLE CHECKOUT — the `claude` arguments that
# contain ROLE's processes in CHECKOUT, one per line (empty output, rc 0, for
# a role that may write — driver). rc 1 when the role requires containment
# and it cannot be established: an unmeasured platform (not_available) or an
# unbuildable document. There is no degraded mode, for the same reason
# ralph_investigator_harness_args has none: a contained role that could not
# be contained is a second writer in the tree.
#
# Callers read these into "$@" beside ralph_tool_binding_args. The two are
# deliberately separate calls: they are separate mechanisms with opposite
# failure directions (contracts.ts ROLE_DEFS), and a helper returning both at
# once is the single-flag collapse the design record refuses.
ralph_process_containment_args() {
  local role="${1-}" checkout="${2-}" json
  ralph_role_process_containment "$role" || return 0
  ralph_process_containment_platform >/dev/null || return 1
  json=$(ralph_process_containment_settings "$checkout") || return 1
  printf '%s\n' "--settings" "$json"
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

# ── Per-lane model (GH-2350) ─────────────────────────────────────────────────
# A spawn asks the harness for a model per LANE, or asks for nothing and
# inherits the account default (the status quo: every spawn path handed
# `agent start` no --model at all, which is why the corpus walked the
# calendar of default models). The lane vocabulary is the five session kinds
# a cockpit starts — not the C8 role, which is about who may WRITE, and not
# the lane letter, which is a name grammar. `driver` covers every /ralph:work
# session (fleet, team worker, headless tick); `lead` the team orchestrator;
# `dispatch` the hero seat; `deliver` and `tend` their passes.
#
# Resolution, first hit wins:
#   1. RALPH_MODEL_<LANE> in the spawner's environment (uppercased lane)
#   2. .ralph.json            models.<lane>
#   3. .claude/settings.json  env.RALPH_MODEL_<LANE>
# — 2 and 3 are the two files board.ts loadConfig reads, in its order, so a
# repo configures its model where it configured its board and never has to
# switch config lanes to reach this knob. Unlike loadConfig the chain falls
# THROUGH: a lane `.ralph.json` does not name is looked up in the settings
# block rather than read as inherit, since "the first place that names it"
# is the rule a reader can hold in their head. Unset everywhere = inherit.
RALPH_MODEL_LANES="driver lead dispatch deliver tend"

# ralph_lane_model LANE [ROOT] — the model LANE's session should be asked
# for, on stdout; empty output (rc 0) means inherit. rc 1 on an unknown lane
# or a value that could not ride an argv — a loud config error, never a
# silent inherit, because "the knob is set" and "the knob is ignored" must
# not render alike (the RALPH_CLAIM_MAX_ESTIMATE shape). Whether the model
# EXISTS is claude's contract: harness args are forwarded verbatim, and a
# mirror of its alias table here would be a second copy that drifts.
ralph_lane_model() {
  local lane="${1-}" root="${2:-${REPO:-$PWD}}" var model="" src=""
  case " $RALPH_MODEL_LANES " in
    *" $lane "*) ;;
    *)
      echo "ralph_lane_model: unknown lane '$lane' (lanes: $RALPH_MODEL_LANES)" >&2
      return 1
      ;;
  esac
  var="RALPH_MODEL_$(printf '%s' "$lane" | tr '[:lower:]' '[:upper:]')"
  model="${!var-}"
  src="\$$var"
  # A file that cannot be READ is a refusal, never an empty answer: malformed
  # JSON, a `models` that is not an object, or a value that is not a string
  # would otherwise fall through to a lower-priority source or to inherit —
  # "the knob is set" rendering as "the knob is ignored" (PR #2374 P1). The
  # jq program errors on every such shape and is silent only on absence.
  if [ -z "$model" ] && [ -n "$root" ] && [ -f "$root/.ralph.json" ]; then
    src="$root/.ralph.json models.$lane"
    model=$(jq -r --arg l "$lane" '
      .models as $m
      | if $m == null then empty
        elif ($m | type) != "object" then error("models must be an object, got \($m | type)")
        else ($m[$l] as $v
          | if $v == null then empty
            elif ($v | type) != "string" then error("models.\($l) must be a string, got \($v | type)")
            else $v end)
        end' "$root/.ralph.json" 2>&1) || {
      echo "ralph_lane_model: cannot read $src — ${model:-jq failed}; refusing rather than inheriting" >&2
      return 1
    }
  fi
  if [ -z "$model" ] && [ -n "$root" ] && [ -f "$root/.claude/settings.json" ]; then
    src="$root/.claude/settings.json env.$var"
    model=$(jq -r --arg v "$var" '
      .env as $e
      | if $e == null then empty
        elif ($e | type) != "object" then error("env must be an object, got \($e | type)")
        else ($e[$v] as $x
          | if $x == null then empty
            elif ($x | type) != "string" then error("env.\($v) must be a string, got \($x | type)")
            else $x end)
        end' "$root/.claude/settings.json" 2>&1) || {
      echo "ralph_lane_model: cannot read $src — ${model:-jq failed}; refusing rather than inheriting" >&2
      return 1
    }
  fi
  [ -n "$model" ] || return 0
  # Shape only: one argv word, no whitespace or shell metacharacters. The
  # bracket pair admits the harness's context-window suffix (`[1m]`).
  case "$model" in
    [A-Za-z0-9]*) ;;
    *)
      echo "ralph_lane_model: $src='$model' is not a model name (must start with a letter or digit)" >&2
      return 1
      ;;
  esac
  # Parameter expansion, not grep: a `]` inside a bracket expression closes
  # it in every regex flavour, and the first draft's pattern matched nothing.
  local rest="${model//[A-Za-z0-9._:-]/}"
  rest="${rest//\[/}"
  rest="${rest//\]/}"
  if [ "${#model}" -gt 80 ] || [ -n "$rest" ]; then
    echo "ralph_lane_model: $src='$model' is not a model name (allowed: letters, digits, . _ : [ ] -; max 80 chars)" >&2
    return 1
  fi
  printf '%s\n' "$model"
}

# ralph_model_args LANE [ROOT] — the `claude` arguments asking for LANE's
# model, one per line (empty output, rc 0, when nothing is configured).
# Callers read them into "$@" beside the binding and containment args and
# append them LAST, so the argv a reader already recognises keeps its shape.
# rc 1 propagates ralph_lane_model's refusal.
ralph_model_args() {
  local model
  model=$(ralph_lane_model "$@") || return 1
  [ -n "$model" ] || return 0
  printf '%s\n' "--model" "$model"
}
