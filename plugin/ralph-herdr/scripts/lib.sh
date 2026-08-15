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

# The Herdr boundary (GH-1774), sourced before anything that talks to the
# server: sanitize.sh first because transport.sh scrubs error prose through it,
# then the strict adapter, then the session/repository scoping that decides
# which of the session's agents are ours at all.
# shellcheck source=sanitize.sh
. "$_RALPH_HERDR_LIB_DIR/sanitize.sh"
# shellcheck source=transport.sh
. "$_RALPH_HERDR_LIB_DIR/transport.sh"

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
# Scoping rides after ledger.sh: repo scope reads the same board config the
# ledger path derives from, so it reuses _ralph_ledger_scope rather than
# growing a second, driftable copy of that resolution.
# shellcheck source=scope.sh
. "$_RALPH_HERDR_LIB_DIR/scope.sh"
# shellcheck source=outcome.sh
. "$_RALPH_HERDR_LIB_DIR/outcome.sh"
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

# ralph_agents_json — THIS REPOSITORY's live ralph agents as compact JSON
# lines {name,status,pane,workspace,agent_session,cwd,checkout,via}, filtered
# to ralph-shaped names: the legacy grammar (^gh-[0-9]+$ /
# ^ralph-(deliver|tend)$) plus grammar-B <lane><issue>-<slug> names
# (^[a-z][0-9]+-[a-z].*$) — both accepted through the transition.
#
# The name filter is a display convention; the CONTAINMENT is the scope join
# underneath it (scope.sh). Names are unique only among live agents in a
# session and are reusable after exit, so `w42-fix` in a shared session may
# belong to another repository entirely — and would pass this regex.
#
# Read-only. rc mirrors the transport: 0 with zero lines means "this
# repository genuinely has no live agents", while 1/2/3 mean the answer is
# unknown. Callers MUST distinguish them — a swallowed failure here reads as an
# empty herd, which is how a server hiccup becomes a spurious spawn or a
# cleanup pass over live workers.
ralph_agents_json() {
  local rc
  ralph_scoped_agents_now "$REPO" 2>/dev/null | jq -c '
    select(.name != null)
    | select(.name | test("^gh-[0-9]+$|^ralph-(deliver|tend)$|^[a-z][0-9]+-[a-z].*$"))'
  rc=${PIPESTATUS[0]}
  return "$rc"
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

# ralph_herdr_tab_create LABEL — the lane spawns' tab, through the adapter.
# Prints the validated `tab_created` result (callers read .root_pane.pane_id
# and .tab.tab_id off it); dies with the reason herdr gave otherwise.
#
# The reason is the whole point. Capturing stdout and reading a pane id out of
# it — what the deliver/tend pair did — turns every refusal into an empty
# capture and the single message "no pane id in tab response": true, and
# useless, because the error.code that says WHY landed on stderr and was
# discarded (GH-1855, the same lost-signal defect as GH-1832). `tab create`
# is not subject to the linked-worktree refusal that motivated that issue —
# probed on 0.8.x, it succeeds from a linked worktree — but a busy server, a
# revoked socket, or a future refusal code all arrive by this path.
ralph_herdr_tab_create() {
  local label="$1" out rc=0
  out=$(ralph_herdr_call tab_created tab create --cwd "$REPO" --label "$label" --no-focus) || rc=$?
  case "$rc" in
    0) ;;
    2) die "herdr refused to create the $label tab: $(ralph_herdr_err_code "$out") — $(ralph_herdr_err_message "$out")" ;;
    3) die "herdr did not answer the $label tab create (unreachable, or the call timed out — a timed-out create may still have landed; check the cockpit before retrying)" ;;
    *) die "herdr's answer to the $label tab create was not a response this plugin can read — see the transport error above" ;;
  esac
  printf '%s' "$out"
}

# agent_start_when_ready NAME PANE [HARNESS_ARG...] — `agent start` needs the pane's shell to
# own the foreground at its prompt. A pane herdr just created is still sourcing
# rc files for a beat (prompt frameworks, version managers), so herdr answers
# agent_pane_busy — a race, not a refusal: observed live, the identical call
# succeeds seconds later. Retry ONLY that code, and only on a pane we just
# created, where it cannot mean "something else is working here". Every other
# error (a taken agent name above all) is a real refusal and dies at once.
# Trailing HARNESS_ARGs are passed to the harness itself, after `agent start`'s
# own `--` separator (the fork path's `--resume <id> --fork-session`). They are
# forwarded verbatim and never inspected: what claude accepts is claude's
# contract, and a mirror of it here would be a second copy that can drift.
#
#   RALPH_HERDR_START_TRIES   attempts, 1s apart (default 15)
agent_start_when_ready() {
  local name="$1" pane="$2" tries="${RALPH_HERDR_START_TRIES:-15}" n=0 out rc code
  shift 2
  case "$tries" in '' | *[!0-9]* | 0) die "RALPH_HERDR_START_TRIES must be a positive integer (got '$tries')" ;; esac
  # Frozen once, because the retry loop re-sends the identical argv and "$@"
  # is what the loop body would otherwise have to preserve across the call.
  local -a harness_args=()
  [ "$#" -gt 0 ] && harness_args=(-- "$@")
  while :; do
    rc=0
    out=$(ralph_herdr_call agent_started agent start "$name" --kind claude --pane "$pane" \
      ${harness_args+"${harness_args[@]}"}) || rc=$?
    if [ "$rc" -eq 0 ]; then
      printf '%s\n' "$out"
      return 0
    fi
    # From the BODY, not $RALPH_HERDR_ERR_CODE: the call above runs in a
    # command substitution, so any variable the function set died with that
    # subshell. Reading the global here would see an empty string forever and
    # turn every retryable race into a hard failure.
    code=$(ralph_herdr_err_code "$out")
    n=$((n + 1))
    # Retry ONLY the well-formed agent_pane_busy refusal (rc 2 + that code).
    # A transport failure (rc 1) or an unreachable server (rc 3) is never a
    # retryable race: we do not know whether the start landed, and hammering a
    # server that may already have started the agent is how one issue ends up
    # with two sessions. The code comes from the parsed envelope, never from
    # matching prose — error text is terminal-derived and not a contract.
    if [ "$rc" -ne 2 ] || [ "$code" != "agent_pane_busy" ] || [ "$n" -ge "$tries" ]; then
      [ "$rc" -eq 2 ] && echo "agent start $name refused: $code $(ralph_herdr_err_message "$out")" >&2
      return 1
    fi
    [ "$n" -eq 1 ] && echo "waiting for the pane's shell to reach its prompt…"
    sleep 1
  done
}

# spawn_turn_started NAME — confirm the prompt was SUBMITTED, not merely
# delivered. `agent prompt` returning 0 asserts the text reached the pane's
# input buffer; it asserts nothing about Enter landing, and an unsubmitted
# prompt leaves an agent that is live, `idle`, and indistinguishable from one
# between turns (GH-1926 — observed: a fleet slot held for twelve minutes by a
# pane containing the string `/ralph:work 1919`).
#
# The question is asked of herdr rather than re-derived from pane text:
# `agent wait --until` is the owning service's own answer to "has this agent
# left idle". Evidence is the STATUS it woke on, not the exit code — a wait
# that answers `idle` (or a fake that answers it by default) proves nothing,
# and reading rc alone is how this whole conflated-status class starts.
#
#   RALPH_HERDR_TURN_WAIT_SEC   seconds to wait for the turn (default 20)
spawn_turn_started() {
  local name="$1" secs="${RALPH_HERDR_TURN_WAIT_SEC:-20}" cap out status rc=0
  case "$secs" in '' | *[!0-9]* | 0) secs=20 ;; esac
  # Stay inside the adapter's own timeout(1) wrapper: a wait that outlives it
  # comes back as rc 3 "may or may not have been applied", which says nothing
  # about the turn and would report every slow start as an unknown.
  cap=$(( ${RALPH_HERDR_TIMEOUT_SEC:-30} - 5 ))
  [ "$cap" -lt 5 ] && cap=5
  [ "$secs" -gt "$cap" ] && secs="$cap"
  out=$(ralph_herdr_call agent_info agent wait "$name" \
    --until working --until blocked --timeout "$((secs * 1000))") || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "no turn started for $name within ${secs}s ($(ralph_herdr_err_code "$out" || true)) — the prompt was delivered but never submitted" >&2
    return 1
  fi
  status=$(jq -r '.agent.agent_status // empty' <<<"$out" 2>/dev/null || true)
  case "$status" in
    working | blocked) return 0 ;;
  esac
  echo "$name is '${status:-unreadable}' after the prompt — no turn started; the prompt was delivered but never submitted" >&2
  return 1
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
  # The trail line renders sanitized: title and body are assembled from agent
  # names and pane text, so an escape sequence in either would repaint the
  # watcher pane it is supposed to be reporting into.
  echo "$(date -u +%FT%TZ) notify [$(ralph_sanitize "$target")] $(ralph_sanitize "$title") — $(ralph_sanitize "$body")"
  ralph_herdr_call notification_show notification show "$title" --body "$body" >/dev/null || true
}

# _ralph_spawn_record REF N PARENT_ISSUE BRANCH LABEL PANE TS [SHELL_PID] [CHECKOUT]
# — print the ledger spawn event as ONE compact JSON line:
#   {ts, ev: "spawn", agent_ref, pane_id?, shell_pid?, checkout?,
#    lineage: <C7>, tokens: <C8 map>}
#
# shell_pid and checkout sit at the EVENT's top level, deliberately outside
# .lineage: the C7 producer schema is .strict() and refuses unknown keys, and
# neither field belongs to lineage's question (who spawned whom) anyway. They
# answer reconcile's question instead — GH-1809:
#   shell_pid  the pid of the pane's SHELL at spawn. A herdr restart rebuilds
#              the pane around a fresh shell (probed 3/3 runs), so a shell_pid
#              that no longer matches is proof the pane was rebuilt and this
#              worker died with it — true even when `resume_agents_on_restore`
#              has since relaunched a `claude --resume` into the new pane,
#              which a process-presence check would misread as a live worker.
#   checkout   the worktree path, so a claim release can resolve the board
#              scope from the LEDGER rather than depending on a pane that a
#              restart may not have brought back.
# Both are optional: a probe that cannot read them writes the record without,
# and reconcile degrades to the reasons it can still prove.
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
  local shell_pid="${8-}" checkout="${9-}"
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
    --arg by "$by" --arg shell "$shell_pid" --arg checkout "$checkout" '
    {ts: $ts, ev: "spawn", agent_ref: $ref}
    + (if $pane == "" then {} else {pane_id: $pane} end)
    + (if $shell == "" then {} else {shell_pid: $shell} end)
    + (if $checkout == "" then {} else {checkout: $checkout} end)
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

# ralph_worktree_source_dir [DIR] — the checkout herdr will start a `worktree
# create`/`worktree open` from, resolved for the repo containing DIR (default
# $REPO).
#
# herdr refuses both actions when --cwd is a LINKED worktree:
#   {"error":{"code":"linked_worktree_source","message":"New and open worktree
#    actions start from the repo parent workspace."}}
# and $REPO defaults to $PWD — which, for an agent spawning an agent, is always
# a linked worktree, because that is where /ralph:work runs. So the spawn path
# was structurally broken from the only place it actually runs (GH-1832).
#
# ASKED, not derived: `worktree list` already reports the source herdr would
# use, and answers identically from a linked worktree and from the main
# checkout. GH-1832 first computed this locally with `git worktree list`, whose
# head is the main GIT worktree — a different concept from the checkout HERDR
# starts from. They agree today and nothing makes them agree tomorrow, so the
# local derivation could produce a source herdr refuses: the same bug with a
# longer fuse. The server owns the rule; this reads it. (GH-1860)
#
# `source_checkout_path`, not `source_workspace_id` — the schema
# (WorktreeSourceInfo) marks the path required and the id nullable, so the
# otherwise-more-native `worktree create --workspace <ID>` form has a hole
# whenever no workspace is open for the source.
#
# --cwd is passed explicitly and is load-bearing: without it herdr answers from
# its own session context rather than our directory (probed — from /tmp it
# still reported this repo), which for a background spawn could resolve a
# source in the WRONG repository.
#
# Falls back to DIR unchanged when herdr cannot answer. The caller is about to
# make a worktree call against the same server, so that call surfaces herdr's
# own error code — a better failure than a path this function invented.
ralph_worktree_source_dir() {
  local dir="${1:-$REPO}" out src
  out=$(ralph_herdr_call worktree_list worktree list --cwd "$dir" 2>/dev/null) || {
    printf '%s' "$dir"
    return 0
  }
  src=$(printf '%s' "$out" | jq -r '.source.source_checkout_path // empty' 2>/dev/null) || src=""
  if [ -n "$src" ]; then
    printf '%s' "$src"
  else
    printf '%s' "$dir"
  fi
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
# The BRANCH comes from ralph_branch_for_issue (the board CLI's grammar, with
# the legacy feature/GH-N resume). Agent naming is grammar B (naming.sh,
# which mirrors contracts.ts slugify
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
# _ralph_branch_exists BRANCH — rc 0 when BRANCH is a local head or an
# origin remote-tracking ref in $REPO. Reads refs as they stand; see the
# fetch note in ralph_branch_for_issue.
_ralph_branch_exists() {
  git -C "$REPO" show-ref -q --verify "refs/heads/$1" ||
    git -C "$REPO" show-ref -q --verify "refs/remotes/origin/$1"
}

# ralph_branch_for_issue N — print the branch the cockpit spawns N on.
#
# The grammar (<kind>/N-<slug>) is derived by the board CLI, never rebuilt
# here (GH-1807, GH-1858). Unlike an AGENT name — a pure function of lane,
# issue and title, which is why naming.sh can mirror it under a golden table
# — a branch name needs the issue's LABELS to pick <kind>, so a bash mirror
# would need this same round trip to be correct. One implementation, one
# subprocess.
#
# Resume beats re-cut: when the semantic branch does not exist but the legacy
# feature/GH-N one does, the legacy branch is printed, so a unit's work never
# splits across two heads (tick.sh parity). The refs are read as they stand —
# the spawn's `git fetch` runs later, because a dry run must reach its plan
# without mutating anything, ref updates included. Residual: a legacy branch
# that exists only on an unfetched origin is not seen and the semantic name
# wins. That is a fresh cut, not a wrong one — the create/open fallback below
# still resumes any checkout that is really there.
#
# rc 1 with a stderr message when `board name` fails or names no branch.
ralph_branch_for_issue() {
  local n="${1-}" names branch legacy
  names=$("$BOARD" name "$n" --json) || {
    echo "ralph_branch_for_issue: \`board name $n\` failed — cannot derive the branch" >&2
    return 1
  }
  branch=$(printf '%s' "$names" | jq -r '.branch // empty')
  legacy=$(printf '%s' "$names" | jq -r '.legacyBranch // empty')
  if [ -z "$branch" ]; then
    echo "ralph_branch_for_issue: \`board name $n\` returned no branch" >&2
    return 1
  fi
  if [ -n "$legacy" ] && ! _ralph_branch_exists "$branch" && _ralph_branch_exists "$legacy"; then
    branch="$legacy"
  fi
  printf '%s\n' "$branch"
}

spawn_work_session() {
  local n="$1" queue_json="${2:-}" branch label parent title agent live pane out
  local ref ts record ledger src
  RALPH_HERDR_SPAWNED_AGENT=""
  RALPH_HERDR_SPAWNED_REF=""
  # Pane id + worktree checkout path, read back from the live responses
  # (never predicted; empty in dry runs).
  RALPH_HERDR_SPAWNED_PANE=""
  RALPH_HERDR_SPAWNED_WORKTREE=""
  export RALPH_HERDR_SPAWNED_AGENT RALPH_HERDR_SPAWNED_REF
  export RALPH_HERDR_SPAWNED_PANE RALPH_HERDR_SPAWNED_WORKTREE
  case "$n" in ''|*[!0-9]*) echo "spawn_work_session: bad issue number '$n'" >&2; return 1 ;; esac
  branch=$(ralph_branch_for_issue "$n") || return 1

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
  #
  # Scoped to THIS repository: in a shared session another repository's GH-N
  # worker carries the identical name, and treating it as ours would refuse a
  # spawn that should proceed. The failure here is fail-CLOSED in the other
  # direction — an unreadable herd means we cannot prove nobody owns GH-N, and
  # spawning a second session onto one issue is worse than not spawning.
  # Two steps, not one pipeline: in a pipeline the rc belongs to the LAST
  # command, so a transport failure would arrive as jq's cheerful 0 and read as
  # an empty herd — the exact fail-open this check exists to close.
  local herd
  herd=$(ralph_agents_json 2>/dev/null) || {
    echo "cannot read the herd — refusing to spawn GH-$n without proving no session already owns it" >&2
    return 1
  }
  live=$(printf '%s\n' "$herd" | jq -r --arg legacy "gh-$n" --arg pfx "w$n-" '
    select(.name == $legacy or (.name | startswith($pfx))) | .name' 2>/dev/null | head -1)
  if [ -n "$live" ]; then
    echo "SKIP $live already live"
    return 2
  fi

  # The worktree source, resolved before the dry-run branch so the plan prints
  # the cwd the live path would actually use — a plan that names $REPO while
  # the spawn sends the parent workspace is a plan you cannot debug from.
  src=$(ralph_worktree_source_dir)

  if [ "${RALPH_HERDR_DRY_RUN:-}" = "true" ]; then
    echo "DRY RUN — would spawn GH-$n:"
    echo "  branch:  $branch   agent: $agent${label:+   label: $label}"
    echo "  git -C $REPO fetch -q origin main"
    echo "  $HERDR worktree create --cwd $src --branch $branch --base origin/main --no-focus${label:+ --label \"$label\"}"
    echo "    (fallback: $HERDR worktree open --cwd $src --branch $branch --no-focus${label:+ --label \"$label\"})"
    echo "  $HERDR agent start $agent --kind claude --pane <captured>"
    echo "  $HERDR agent prompt $agent \"/ralph:work $n\""
    echo "  $HERDR agent wait $agent --until working --until blocked --timeout <${RALPH_HERDR_TURN_WAIT_SEC:-20}s>  (unconfirmed turn = failed spawn)"
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
  # brand-new branches: an existing branch (either grammar) is silently checked
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
  # Both calls go through the strict adapter, so `out` is an already-validated
  # result object: the right discriminant (worktree_created / worktree_opened)
  # carrying root_pane and worktree. That validation is what lets the reads
  # below be plain field accesses instead of defensive guesses — a response
  # that reached here cannot be an error envelope, a reply to another request,
  # or a success missing the pane we are about to start an agent in.
  local create_rc=0 open_rc=0 create_code open_code
  set -- --cwd "$src" --branch "$branch" --base origin/main --no-focus
  [ -n "$label" ] && set -- "$@" --label "$label"
  out=$(ralph_herdr_call worktree_created worktree create "$@") || create_rc=$?
  if [ "$create_rc" -ne 0 ]; then
    # Report the refusal the server actually gave. The old line here asserted
    # "existing checkout is the usual cause" without checking — and when the
    # real cause was a linked-worktree cwd, that guess sent the reader looking
    # for a checkout that did not exist. A cause is named only when the code
    # names it; otherwise this says it does not know.
    create_code=$(ralph_herdr_err_code "$out")
    echo "worktree create failed for $branch (${create_code:-no error code — see the diagnostic above}) — trying worktree open"
    set -- --cwd "$src" --branch "$branch" --no-focus
    [ -n "$label" ] && set -- "$@" --label "$label"
    out=$(ralph_herdr_call worktree_opened worktree open "$@") || open_rc=$?
    if [ "$open_rc" -ne 0 ]; then
      open_code=$(ralph_herdr_err_code "$out")
      echo "neither worktree create (${create_code:-no code}) nor worktree open (${open_code:-no code}) succeeded for $branch from $src" >&2
      return 1
    fi
  fi

  # IDs are opaque server-local tokens — captured from the response, never
  # predicted or derived.
  pane=$(jq -r '.root_pane.pane_id // empty' <<<"$out")
  if [ -z "$pane" ]; then
    echo "no pane id in worktree response for GH-$n" >&2
    return 1
  fi
  RALPH_HERDR_SPAWNED_PANE="$pane"
  RALPH_HERDR_SPAWNED_WORKTREE=$(jq -r '.worktree.path // .workspace.worktree.checkout_path // empty' <<<"$out" 2>/dev/null) ||
    RALPH_HERDR_SPAWNED_WORKTREE=""

  # A confirmed-live name collision at start means a session already owns
  # issue N: the name is always w<N>-<slug>, so any live agent holding it
  # would have matched the w<N>-* pre-check — it either spawned inside the
  # check→start race window, or the pre-check's agent-list read failed and
  # was swallowed (fail-open). Both are the lost race rc=2 exists for; never
  # improvise a --N sibling here — that would put TWO /ralph:work sessions on
  # one issue, the very thing the pre-check (and the board's claim protocol)
  # refuse — and since GH-1774 there is no shared-claim plane to defer to
  # either: sibling fleets are gone. Liveness is confirmed by a
  # read, never inferred from error prose; every other start failure dies at
  # once, unchanged.
  if ! agent_start_when_ready "$agent" "$pane"; then
    if printf '%s\n' "$(ralph_agents_json 2>/dev/null)" | jq -e --arg name "$agent" \
        'select(.name == $name)' >/dev/null 2>&1; then
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
  # The pane's shell pid, read once now: reconcile compares it later to tell a
  # rebuilt pane (herdr restart) from a worker that died inside a surviving one
  # (GH-1809). Best-effort like every other observation on this path — a
  # failure costs the restart/crash distinction, never the spawn.
  local shell_pid=""
  shell_pid=$(ralph_herdr_call pane_process_info pane process-info --pane "$pane" 2>/dev/null |
    jq -r '.process_info.shell_pid // empty' 2>/dev/null) || shell_pid=""
  case "$shell_pid" in '' | *[!0-9]*) shell_pid="" ;; esac
  [ -n "$shell_pid" ] || echo "could not read pane $pane's shell pid — reconcile will not be able to tell a restart from a crash for $agent" >&2
  if ref=$(ralph_agent_ref "$agent" 2>/dev/null); then
    RALPH_HERDR_SPAWNED_REF="$ref"
    record=$(_ralph_spawn_record "$ref" "$n" "$parent" "$branch" "$label" "$pane" "$ts" \
      "$shell_pid" "$RALPH_HERDR_SPAWNED_WORKTREE") || record=""
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

  ralph_herdr_call agent_prompted agent prompt "$agent" "/ralph:work $n" >/dev/null || {
    echo "prompt delivery failed — agent $agent is LIVE and idle in pane $pane; prompt it manually: herdr agent prompt $agent \"/ralph:work $n\"" >&2
    return 1
  }

  # The spawn is not complete when the prompt is delivered — it is complete
  # when a turn has STARTED. An unconfirmed start is reported as a failure so
  # the fleet's `failed:` line carries it and the slot is not counted as
  # occupied and working (GH-1926). The agent is left live and the pane intact:
  # the manual submit below recovers it, and reconcile already knows the
  # ledgered worker.
  if ! spawn_turn_started "$agent"; then
    echo "spawn NOT confirmed for GH-$n — agent $agent is LIVE in pane $pane holding an unsubmitted prompt; submit it with: herdr pane send-keys $pane Enter" >&2
    return 1
  fi

  RALPH_HERDR_SPAWNED_AGENT="$agent"
  echo "spawned GH-$n on $branch (pane $pane, agent $agent)"
  return 0
}
