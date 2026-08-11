#!/usr/bin/env bash
# lib.sh — shared plumbing for the ralph-herdr cockpit scripts. Sourced, never run.
#
# Everything in this plugin is read-mostly by design: board reads + herdr
# orchestration + notifications. The board CLI is the ONLY board path — no
# gh project/graphql anywhere — and no script here writes board state; the
# claiming happens inside the spawned /ralph:work session, on the same
# sanctioned path a human typing the skill would take.
#
# Knobs:
#   RALPH_HERDR_REPO          repo to operate on (default: the pane's cwd —
#                             plugin actions open panes with --cwd <workspace cwd>)
#   RALPH_HERDR_BOARD         path to the board CLI (default: $REPO/ralph/scripts/board,
#                             the vendored-checkout layout). Host repos that install
#                             ralph as a Claude Code plugin have no ralph/ tree —
#                             point this at the installed plugin's scripts/board
#   HERDR_BIN_PATH            injected inside herdr panes; falls back to `herdr`
#                             on PATH for dev runs outside a pane
#   RALPH_ALLOW_API_BILLING   set to "true" to deliberately allow spawning with
#                             ANTHROPIC_API_KEY present (see billing_guard)
#   RALPH_HERDR_DRY_RUN       set to "true" to make every spawn path print its
#                             exact plan (issue, branch, agent name, the herdr
#                             commands it WOULD run) and stop before ANY herdr
#                             mutation. Reads (dashboard/attend) ignore it.
#   NO_COLOR                  set (any value) to disable colored output
set -euo pipefail

REPO="${RALPH_HERDR_REPO:-$PWD}"
HERDR="${HERDR_BIN_PATH:-herdr}"

die() { echo "${0##*/}: $*" >&2; exit 1; }

# Grammar-B agent naming (slugify/format/parse/collide/ref) — a pure-function
# sibling lib, sourced here so every cockpit script gets it with lib.sh.
_RALPH_HERDR_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=naming.sh
. "$_RALPH_HERDR_LIB_DIR/naming.sh"

# Watcher plumbing (Phase 2): the events ledger + pane-token pushers — pure
# functions and file appends, no side effects at source time. The spawn path
# needs both for the C7 spawn record and spawn-time tokens (the one documented
# carve-out from "the watcher is the sole ledger appender": spawn completes
# before any event hook can fire, and a single-line O_APPEND write stays
# atomic).
# shellcheck source=ledger.sh
. "$_RALPH_HERDR_LIB_DIR/ledger.sh"
# shellcheck source=tokens.sh
. "$_RALPH_HERDR_LIB_DIR/tokens.sh"
# Fleet controller (Phase 3): per-run state, FleetBriefs, refill arming,
# shared-claim issue fleets — pure functions + file writes, no side effects
# at source time.
# shellcheck source=fleet.sh
. "$_RALPH_HERDR_LIB_DIR/fleet.sh"

# ── Color helpers ────────────────────────────────────────────────────────────
# Detected ONCE at source time: stdout is a terminal, terminfo reports >= 8
# colors, and NO_COLOR is unset. Otherwise every variable is empty, so callers
# can interpolate unconditionally and degrade to plain text.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YLW=$'\033[33m'; C_BLU=$'\033[34m'
  C_DIM=$'\033[2m';  C_BOLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YLW=""; C_BLU=""; C_DIM=""; C_BOLD=""; C_RST=""
fi
export C_RED C_GRN C_YLW C_BLU C_DIM C_BOLD C_RST

# state_glyph STATUS — print a colored ● for an agent status (no newline).
# working=green, blocked=red, idle/done=blue, anything else=dim. When color is
# off (non-tty, NO_COLOR) the dot alone carries no signal AND breaks the
# advertised ASCII fallback — degrade to a distinct ASCII marker per state.
state_glyph() {
  if [ -z "$C_RST" ]; then
    case "${1:-}" in
      working) printf '>' ;;
      blocked) printf '!' ;;
      idle|done) printf '.' ;;
      *) printf '?' ;;
    esac
    return 0
  fi
  case "${1:-}" in
    working)   printf '%s●%s' "$C_GRN" "$C_RST" ;;
    blocked)   printf '%s●%s' "$C_RED" "$C_RST" ;;
    idle|done) printf '%s●%s' "$C_BLU" "$C_RST" ;;
    *)         printf '%s●%s' "$C_DIM" "$C_RST" ;;
  esac
}

# validate_pos_int NAME VALUE — die unless VALUE is a positive integer
# (^[1-9][0-9]*$). NAME is only for the error message.
validate_pos_int() {
  case "${2:-}" in
    ''|*[!0-9]*|0*) die "$1 must be a positive integer (got '${2:-}')" ;;
  esac
}

# ralph_agents_json — live ralph agents as compact JSON lines
# {name,status,pane}, filtered to ralph-shaped names: the legacy grammar
# (^gh-[0-9]+$ / ^ralph-(deliver|tend)$) plus grammar-B <lane><issue>-<slug>
# names (^[a-z][0-9]+-[a-z].*$) — both accepted through the transition.
# Read-only; prints nothing when no ralph agent is live. Non-zero only if the
# herdr read itself fails.
ralph_agents_json() {
  "$HERDR" agent list | jq -c '
    .result.agents[]?
    | select(.name != null)
    | select(.name | test("^gh-[0-9]+$|^ralph-(deliver|tend)$|^[a-z][0-9]+-[a-z].*$"))
    | {name: .name, status: .agent_status, pane: .pane_id}'
}

# The board CLI is the only sanctioned board surface. Resolution order
# (GH-1761): RALPH_HERDR_BOARD override > the vendored-checkout layout
# (ralph-hero itself) > the newest installed Claude Code plugin copy. The
# fallback matters because host repos have no ralph/ tree AND no reliable env
# channel: herdr panes inherit the SERVER's environment, not the user's shell,
# so an exported RALPH_HERDR_BOARD never arrives unless the server itself was
# started with it. Scope is board.ts's own problem and resolves from the repo
# tree (.ralph.json > tracked .claude/settings.json env) — only the CLI path
# needs discovering here. Nothing found anywhere = not a ralph-equipped
# machine — refuse, naming every location tried.
# herdr-setup.sh's board-cli check mirrors this order; change them together.
installed_board_cli() {
  # Sort by the VERSION component (…/ralph/<version>/scripts/board), not the
  # whole path — full-path sort would rank marketplace namespace above version.
  # shellcheck disable=SC2012  # glob over versioned plugin dirs is the point
  ls "$HOME"/.claude/plugins/cache/*/ralph/*/scripts/board 2>/dev/null |
    awk -F/ '{ print $(NF-2) "\t" $0 }' | sort -V -k1,1 | tail -1 | cut -f2-
}
if [ -n "${RALPH_HERDR_BOARD:-}" ]; then
  BOARD="$RALPH_HERDR_BOARD"
  [ -x "$BOARD" ] || die "RALPH_HERDR_BOARD=$BOARD is not an executable board CLI"
elif [ -x "$REPO/ralph/scripts/board" ]; then
  BOARD="$REPO/ralph/scripts/board"
else
  BOARD=$(installed_board_cli || true)
  [ -n "$BOARD" ] && [ -x "$BOARD" ] || die "no board CLI found — tried \$RALPH_HERDR_BOARD (unset), $REPO/ralph/scripts/board, and ~/.claude/plugins/cache/*/ralph/*/scripts/board (is the ralph Claude Code plugin installed?)"
fi

# Billing guard (tick.sh parity): a pane env with a stray API key would
# silently bill API credits instead of the subscription. Loud, not silent.
billing_guard() {
  if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "${RALPH_ALLOW_API_BILLING:-}" != "true" ]; then
    echo "${0##*/}: ANTHROPIC_API_KEY is set — refusing to spawn (would bill API credits, not the subscription)." >&2
    echo "${0##*/}: unset it for OAuth/subscription billing, or set RALPH_ALLOW_API_BILLING=true deliberately." >&2
    exit 3
  fi
}

# agent_start_when_ready NAME PANE — `agent start` needs the pane's shell to
# own the foreground at its prompt. A pane herdr just created is still sourcing
# rc files for a beat (prompt frameworks, version managers), so herdr answers
# agent_pane_busy — a race, not a refusal: observed live, the identical call
# succeeds seconds later. Retry ONLY that code, and only on a pane we just
# created, where it cannot mean "something else is working here". Every other
# error (a taken agent name above all) is a real refusal and dies at once.
#   RALPH_HERDR_START_TRIES   attempts, 1s apart (default 15)
agent_start_when_ready() {
  local name="$1" pane="$2" tries="${RALPH_HERDR_START_TRIES:-15}" n=0 out code
  case "$tries" in '' | *[!0-9]* | 0) die "RALPH_HERDR_START_TRIES must be a positive integer (got '$tries')" ;; esac
  while :; do
    if out=$("$HERDR" agent start "$name" --kind claude --pane "$pane" 2>&1); then
      printf '%s\n' "$out"
      return 0
    fi
    code=$(jq -r '.error.code // empty' <<<"$out" 2>/dev/null || true)
    n=$((n + 1))
    if [ "$code" != "agent_pane_busy" ] || [ "$n" -ge "$tries" ]; then
      printf '%s\n' "$out" >&2
      return 1
    fi
    [ "$n" -eq 1 ] && echo "waiting for the pane's shell to reach its prompt…"
    sleep 1
  done
}

# hold_pane — EXIT trap for the spawn scripts. A plugin pane closes the instant
# its command exits, taking the reason with it (a pane that flashes and
# vanishes teaches nothing). The spawn scripts exec into notify-watch.sh on
# success, so reaching this trap means the spawn did not complete — but that
# splits into two truths: nothing started (empty queue, refusal), or the agent
# DID start and only the dispatch after it failed (prompt delivery). Callers
# set RALPH_HERDR_AGENT_LIVE=1 the moment agent start succeeds so the trap
# never claims "no session" while a live agent sits idle in a pane.
hold_pane() {
  local rc=$?
  if [ -n "${RALPH_HERDR_AGENT_LIVE:-}" ]; then
    printf '\n[ralph-herdr] agent STARTED but dispatch did not complete (exit %d) — the agent is live and idle; see the error above for the manual prompt command. Enter to close.\n' "$rc"
  else
    printf '\n[ralph-herdr] no session spawned (exit %d) — press Enter to close this pane.\n' "$rc"
  fi
  read -r _ || true
}

# notify TARGET TITLE BODY — advisory toast via herdr. The echoed line keeps a
# visible trail in the watcher pane; the toast itself is fire-and-forget and a
# delivery failure must never kill a watcher that could re-arm.
notify() {
  local target="$1" title="$2" body="$3"
  echo "$(date -u +%FT%TZ) notify [$target] $title — $body"
  "$HERDR" notification show "$title" --body "$body" || true
}

# _ralph_spawn_record REF N PARENT_ISSUE BRANCH LABEL PANE TS — print the
# ledger spawn event as ONE compact JSON line:
#   {ts, ev: "spawn", agent_ref, pane_id?, lineage: <C7>, tokens: <C8 map>}
# The C7 LineageRecord mirrors contracts.ts buildLineageRecord: issue and
# parent_issue are numbers, spawner.script is the invoking script ($0 —
# lib.sh is sourced, so that is work-next.sh / work-fleet.sh / the watcher's
# refill branch), invoked_by defaults to "human" (every cockpit action is a
# click); orchestrator-driven spawns thread their identity via
# RALPH_HERDR_INVOKED_BY (validated against the C1 enum — the watcher's
# refill sets "scheduler"; anything unrecognized honestly stays "human",
# the cockpit default), plane is "herdr".
# PANE may be empty (the dry-run plan — pane ids are captured live, never
# predicted): pane_id is then omitted, C7 marks it optional for exactly this.
# The C8 token map is the spawn-time truth: work-next/work-fleet spawns are
# depth-0 roots from a human, so depth=0, root=self, and no parent token.
_ralph_spawn_record() {
  local ref="$1" n="$2" parent_issue="$3" branch="$4" label="$5" pane="$6" ts="$7"
  local parsed lane slug epoch by
  parsed=$(ralph_agent_parse "${ref%%#*}") || return 1
  # shellcheck disable=SC2086  # intentional: parse output is space-separated
  set -- $parsed
  lane="$1" slug="$3"
  [ "$slug" = "''" ] && slug=""
  epoch="${ref##*#}"
  case "${RALPH_HERDR_INVOKED_BY:-}" in
    agent | scheduler) by="$RALPH_HERDR_INVOKED_BY" ;;
    *) by="human" ;;
  esac
  jq -nc \
    --arg ts "$ts" --arg ref "$ref" --arg pane "$pane" \
    --argjson n "$n" --arg pi "$parent_issue" \
    --arg script "${0##*/}" --arg branch "$branch" --arg label "$label" \
    --arg lane "$lane" --arg slug "$slug" --arg epoch "$epoch" \
    --arg by "$by" '
    {ts: $ts, ev: "spawn", agent_ref: $ref}
    + (if $pane == "" then {} else {pane_id: $pane} end)
    + {lineage:
        ({contract: "ralph.lineage", contract_version: 1,
          agent_ref: $ref, issue: $n}
         + (if $pi == "" then {} else {parent_issue: ($pi | tonumber)} end)
         + {spawner: {script: $script, invoked_by: $by},
            herdr: ({worktree_branch: $branch}
              + (if $pane == "" then {} else {pane_id: $pane} end)
              + (if $label == "" then {} else {workspace_label: $label} end)),
            plane: "herdr", spawned_at: $ts}),
       tokens:
        ({role: $lane, issue: ($n | tostring)}
         + (if $slug == "" then {} else {slug: $slug} end)
         + {root: $ref, depth: "0", state: "spawned", branch: $branch,
            harness: "claude", spawn_epoch: $epoch})}'
}

# ralph_depth_guard PARENT_REF — the herdr-plane spawn-depth cap: at most
# three nested levels (depths 0-2; inner-plane subagents are free and never
# counted). Prints the CHILD's depth on rc 0; rc 1 REFUSES the spawn when the
# parent's recorded depth is already >= 2.
#
# An empty (or "-") PARENT_REF is a root spawn — human or scheduler — and
# prints 0; work-next/work-fleet never call this (their spawns are depth-0 by
# construction). A parent the ledger knows but without a depth token (discover
# records carry none) is treated as depth 0: the guard enforces what the
# ledger can prove — the ledger is eventually-honest by design, and a missing
# record must never block work (degradation loses chrome, never verbs; the
# cap is about runaway TREES, which by definition wrote spawn records).
# Callers arrive with Phase 3's fleet controller; the guard ships (and is
# tested) now so the contract is pinned before any orchestrator exists.
# Honors $RALPH_HERDR_LEDGER / cwd scope like every ledger reader.
ralph_depth_guard() {
  local parent="${1-}" d
  if [ -z "$parent" ] || [ "$parent" = "-" ]; then
    echo 0
    return 0
  fi
  d=$(_ralph_ledger_latest '((try .tokens.depth catch null) // "")' "$parent" 2>/dev/null) || d=""
  case "$d" in
    '' | *[!0-9]*) d=0 ;; # unknown/unparseable depth — treated as a root
  esac
  if [ "$d" -ge 2 ]; then
    echo "ralph_depth_guard: parent $parent is at depth $d — refusing a herdr-plane child (cap: 3 levels, depths 0-2; use inner subagents instead)" >&2
    return 1
  fi
  echo $((d + 1))
}

# spawn_work_session N [QUEUE_JSON] — spawn one /ralph:work session for issue N.
#
# The single sanctioned spawn path (extracted from work-next.sh; work-fleet.sh
# shares it). No board mutation happens here: the claim is taken by /ralph:work
# inside the spawned session, on the same path a human typing the skill would
# take.
#
#   N           issue number (digits)
#   QUEUE_JSON  optional: the caller's `board next --json` output. When it
#               carries parentNumber for N, the worktree workspace gets
#               --label "GH-N via GH-parent" so the cockpit shows the nesting;
#               when it carries N's title, the agent name gets its slug.
#
# Agent naming is grammar B (naming.sh, which mirrors contracts.ts slugify
# exactly — the golden table pins both): w<N>-<slug> from the queue item's
# title. An absent title takes the "work" slug; a pathological one (all
# punctuation/digits) takes ralph_slugify's shared "task" fallback. Legacy
# gh-N sessions stay first-class through the transition: the skip check
# treats either shape as "issue N already owned".
#
# stdout: progress lines ending in "spawned GH-N on BRANCH (pane P, agent A)"
#         (or the dry-run plan / a SKIP line).
# On rc 0 the started (or dry-run planned) agent name is exported in
# RALPH_HERDR_SPAWNED_AGENT — the name is derived in here, so callers that
# watch or report must read it back rather than reconstruct it. The durable
# ref (name#epoch) is exported alongside as RALPH_HERDR_SPAWNED_REF the
# moment the agent is live (dry-run: planned), same read-back rule.
#
# Phase 2: once the agent is LIVE this function appends the C7 spawn record
# to the events ledger (the documented carve-out — see ledger.sh) and pushes
# the spawn-time C8 tokens onto the pane. Both are observations: a failed
# append or push warns and never aborts the spawn — reconcile discovers the
# agent later (eventually-honest), and tokens are chrome.
# Returns: 0 spawned (or dry-run plan printed); 2 skipped — a session already
#          owns issue N (from the pre-check: no mutation attempted; from the
#          start-time race: the already-opened worktree pane is left to the
#          winning session); 1 real failure (worktree/start/prompt).
# Honors RALPH_HERDR_DRY_RUN=true: prints the exact plan and returns 0 before
# ANY herdr mutation.
spawn_work_session() {
  local n="$1" queue_json="${2:-}" branch label parent title agent live pane out
  local ref ts record ledger
  RALPH_HERDR_SPAWNED_AGENT=""
  RALPH_HERDR_SPAWNED_REF=""
  # Pane id + worktree checkout path, read back from the live responses
  # (never predicted; empty in dry runs). spawn_issue_fleet splits sibling
  # panes inside exactly this workspace — same read-back rule as the name.
  RALPH_HERDR_SPAWNED_PANE=""
  RALPH_HERDR_SPAWNED_WORKTREE=""
  export RALPH_HERDR_SPAWNED_AGENT RALPH_HERDR_SPAWNED_REF
  export RALPH_HERDR_SPAWNED_PANE RALPH_HERDR_SPAWNED_WORKTREE
  case "$n" in ''|*[!0-9]*) echo "spawn_work_session: bad issue number '$n'" >&2; return 1 ;; esac
  branch="feature/GH-$n"

  # Nesting label + title: children group under an epic on the board; carry
  # that into the worktree workspace label when the caller's queue JSON knows
  # the parent. The same queue item's title feeds the agent-name slug.
  label="" title="" parent=""
  if [ -n "$queue_json" ]; then
    parent=$(jq -r --argjson n "$n" '
      [.next, .queue[]?] | map(select(. != null and .number == $n)) | .[0].parentNumber // empty
    ' <<<"$queue_json" 2>/dev/null || true)
    [ -n "$parent" ] && label="GH-$n via GH-$parent"
    title=$(jq -r --argjson n "$n" '
      [.next, .queue[]?] | map(select(. != null and .number == $n)) | .[0].title // empty
    ' <<<"$queue_json" 2>/dev/null || true)
  fi

  # Grammar-B name. ralph_slugify itself falls back to "task" for a title
  # that slugifies to nothing letter-led (mirroring contracts.ts), so the
  # second call is unreachable defense against future naming.sh edits.
  agent=$(ralph_agent_name w "$n" "${title:-work}" 2>/dev/null) ||
    agent=$(ralph_agent_name w "$n" work) || {
      echo "could not derive an agent name for GH-$n" >&2
      return 1
    }

  # Skip, don't die, when a session already owns issue N — under EITHER
  # grammar (legacy gh-N or any w<N>-*): fleet callers must keep going.
  # Checked before any mutation so the skip is side-effect free.
  live=$("$HERDR" agent list | jq -r --arg legacy "gh-$n" --arg pfx "w$n-" '
    [.result.agents[]? | select(.name != null)
     | select(.name == $legacy or (.name | startswith($pfx))) | .name]
    | first // empty' 2>/dev/null || true)
  if [ -n "$live" ]; then
    echo "SKIP $live already live"
    return 2
  fi

  if [ "${RALPH_HERDR_DRY_RUN:-}" = "true" ]; then
    echo "DRY RUN — would spawn GH-$n:"
    echo "  branch:  $branch   agent: $agent${label:+   label: $label}"
    echo "  git -C $REPO fetch -q origin main"
    echo "  $HERDR worktree create --cwd $REPO --branch $branch --base origin/main --no-focus${label:+ --label \"$label\"}"
    echo "    (fallback: $HERDR worktree open --cwd $REPO --branch $branch --no-focus${label:+ --label \"$label\"})"
    echo "  $HERDR agent start $agent --kind claude --pane <captured>"
    echo "  $HERDR agent prompt $agent \"/ralph:work $n\""
    # The exact spawn record the live path would append (pane_id omitted —
    # pane ids are captured from the worktree response, never predicted) and
    # the token push derived from it. Printed, never written: dry-run stops
    # before ANY mutation, ledger appends included.
    ref=$(ralph_agent_ref "$agent") || {
      echo "could not derive a durable ref for $agent" >&2
      return 1
    }
    record=$(_ralph_spawn_record "$ref" "$n" "$parent" "$branch" "$label" "" "$(date -u +%FT%TZ)") || record=""
    echo "  ledger append (spawn): ${record:-<could not build the record>}"
    echo "  tokens push (pane <captured>): $(jq -r '[.tokens | to_entries[] | "\(.key)=\(.value)"] | join(" ")' <<<"$record" 2>/dev/null || echo '<none>')"
    RALPH_HERDR_SPAWNED_AGENT="$agent"
    RALPH_HERDR_SPAWNED_REF="$ref"
    return 0
  fi

  # Never branch from local HEAD: herdr's `worktree create` bases NEW branches
  # on the parent checkout's HEAD unless told otherwise, so fetch and pin
  # --base origin/main (tick.sh parity). The fresh base only holds for
  # brand-new branches: an existing feature/GH-N branch is silently checked
  # out as-is (--base ignored) — resumed, possibly behind origin/main, and the
  # session is expected to rebase. Create refuses only when the CHECKOUT
  # already exists — then open it instead: resuming beats re-creating.
  # The label carries spaces — build argv positionally, never via unquoted
  # expansion (bash 3.2, no arrays needed beyond "$@").
  # Callers invoke this on the RHS of `||` (rc capture), which disables set -e
  # through the whole function body — every step must check its own outcome. A
  # failed fetch must stop here: --base origin/main against a stale or missing
  # ref would branch from the wrong base (the very thing the fetch prevents).
  git -C "$REPO" fetch -q origin main || {
    echo "git fetch origin main failed for GH-$n — not branching from a stale ref" >&2
    return 1
  }
  set -- --cwd "$REPO" --branch "$branch" --base origin/main --no-focus
  [ -n "$label" ] && set -- "$@" --label "$label"
  if ! out=$("$HERDR" worktree create "$@"); then
    echo "worktree create refused (existing checkout is the usual cause) — opening instead"
    set -- --cwd "$REPO" --branch "$branch" --no-focus
    [ -n "$label" ] && set -- "$@" --label "$label"
    out=$("$HERDR" worktree open "$@") || {
      echo "neither worktree create nor worktree open succeeded for $branch" >&2
      return 1
    }
  fi

  # IDs are opaque server-local tokens — captured from the response, never
  # predicted or derived. The worktree checkout path rides along for callers
  # that split sibling panes into the same workspace (spawn_issue_fleet);
  # its absence costs those callers, never this spawn.
  pane=$(jq -r '.result.root_pane.pane_id // empty' <<<"$out")
  if [ -z "$pane" ]; then
    echo "no pane id in worktree response for GH-$n" >&2
    return 1
  fi
  RALPH_HERDR_SPAWNED_PANE="$pane"
  RALPH_HERDR_SPAWNED_WORKTREE=$(jq -r '.result.worktree.path // .result.workspace.worktree.path // empty' <<<"$out" 2>/dev/null) ||
    RALPH_HERDR_SPAWNED_WORKTREE=""

  # A confirmed-live name collision at start means a session already owns
  # issue N: the name is always w<N>-<slug>, so any live agent holding it
  # would have matched the w<N>-* pre-check — it either spawned inside the
  # check→start race window, or the pre-check's agent-list read failed and
  # was swallowed (fail-open). Both are the lost race rc=2 exists for; never
  # improvise a --N sibling here — that would put TWO /ralph:work sessions on
  # one issue, the very thing the pre-check (and the board's claim protocol)
  # refuse. Shared-claim sibling fleets exist (spawn_issue_fleet), and they
  # JOIN a claim deliberately, not by collision; the --N generation suffix
  # belongs to that plane (ralph_agent_name_collide). Liveness is confirmed by a
  # read, never inferred from error prose; every other start failure dies at
  # once, unchanged.
  if ! agent_start_when_ready "$agent" "$pane"; then
    if "$HERDR" agent list | jq -e --arg name "$agent" \
        '.result.agents[]? | select(.name == $name)' >/dev/null 2>&1; then
      echo "SKIP $agent already live (lost the spawn race for GH-$n) — leaving the worktree pane $pane to the winning session"
      return 2
    fi
    echo "agent start $agent failed — see the herdr error above (exhausted startup retries and non-collision refusals land here); not spawning" >&2
    return 1
  fi
  # Past this point the agent is LIVE — a prompt-delivery failure must not exit
  # silently and strand an idle session with no work, and hold_pane must not
  # claim "no session spawned" about it.
  export RALPH_HERDR_AGENT_LIVE=1

  # Spawn record + spawn tokens, BEFORE the prompt: a live-but-unprompted
  # agent still belongs in the ledger. The ledger resolves from $REPO (not
  # $PWD — same scope board.ts reads), and every failure here is a warning,
  # never an abort: reconcile discovers an unledgered live agent, and tokens
  # are chrome. The pushed tokens are read back off the record so the pane
  # chrome and the ledger can never disagree at spawn.
  ts=$(date -u +%FT%TZ)
  if ref=$(ralph_agent_ref "$agent" 2>/dev/null); then
    RALPH_HERDR_SPAWNED_REF="$ref"
    record=$(_ralph_spawn_record "$ref" "$n" "$parent" "$branch" "$label" "$pane" "$ts") || record=""
    ledger=$(ralph_ledger_path "$REPO" 2>/dev/null) || ledger=""
    if [ -n "$record" ] && [ -n "$ledger" ]; then
      RALPH_HERDR_LEDGER="$ledger" ralph_ledger_append "$record" ||
        echo "spawn ledger append failed for $ref — reconcile will discover it" >&2
    else
      echo "spawn ledger: ${ledger:+record build failed}${ledger:-no board scope discoverable from $REPO} — reconcile will discover $ref" >&2
    fi
    if [ -n "$record" ]; then
      set --
      while IFS= read -r kv; do
        [ -n "$kv" ] || continue
        set -- "$@" "$kv"
      done < <(jq -r '.tokens | to_entries[] | "\(.key)=\(.value)"' <<<"$record" 2>/dev/null || true)
      [ "$#" -ge 1 ] && ralph_tokens_push "$pane" "$@"
    fi
  else
    echo "no durable ref derivable for $agent — spawning unledgered (reconcile will discover it)" >&2
  fi

  "$HERDR" agent prompt "$agent" "/ralph:work $n" || {
    echo "prompt delivery failed — agent $agent is LIVE and idle in pane $pane; prompt it manually: herdr agent prompt $agent \"/ralph:work $n\"" >&2
    return 1
  }

  RALPH_HERDR_SPAWNED_AGENT="$agent"
  echo "spawned GH-$n on $branch (pane $pane, agent $agent)"
  return 0
}
