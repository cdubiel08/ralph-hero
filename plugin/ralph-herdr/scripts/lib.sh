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

# The fleet role model (GH-1808): lane->role defaults, the spawn edge graph,
# the one-driver-per-worktree guard, and the investigator's harness binding.
# Pure functions plus two reads (ledger, herd); no side effects at source time.
# shellcheck source=roles.sh
. "$_RALPH_HERDR_LIB_DIR/roles.sh"

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
# herdr-setup.sh's board-cli check and cockpit/main.go mirror this order;
# change them together.
#
# Within the installed tier the registry wins (GH-1865). `installed_plugins.json`
# RECORDS which copy Claude Code executes; the cache glob merely finds the
# highest-versioned directory that exists, and this machine's cache holds 29 of
# them. They coincide only while the newest install is also the newest
# directory — a downgrade, a second marketplace, or a project-scoped install
# breaks that and the glob then names a plausible path nobody runs. The glob
# survives as a last resort because it answers when the registry cannot (no jq,
# no registry, a vendored layout), but it is labelled a guess wherever it is
# reported, so a wrong path is visibly a guess rather than silently a record.
ralph_installed_plugins_file() {
  printf '%s\n' "${RALPH_INSTALLED_PLUGINS_FILE:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json}"
}

# Prints "<source>\t<path>" — source is `registry` or `guess`. Empty output
# means no board CLI was found by either route.
installed_board_cli_tagged() {
  local file best=""
  file=$(ralph_installed_plugins_file)
  if [ -r "$file" ] && command -v jq >/dev/null 2>&1; then
    # Keys are "<name>@<marketplace>", so match the name half only. The
    # recorded version is a TIE-BREAK between several registered copies, never
    # the reason to prefer the registry — being recorded is.
    best=$(jq -r '
        (.plugins // {}) | to_entries[]
        | select((.key | split("@")[0]) == "ralph")
        | .value[]? | select(.installPath != null)
        | ((.version // "0") + "\t" + .installPath + "/scripts/board")' "$file" 2>/dev/null |
      while IFS=$'\t' read -r ver path; do
        [ -x "$path" ] && printf '%s\t%s\n' "$ver" "$path"
      done | sort -V -k1,1 | tail -1 | cut -f2-)
    [ -n "$best" ] && { printf 'registry\t%s\n' "$best"; return 0; }
  fi
  # Sort by the VERSION component (…/ralph/<version>/scripts/board), not the
  # whole path — full-path sort would rank marketplace namespace above version.
  # shellcheck disable=SC2012  # glob over versioned plugin dirs is the point
  best=$(ls "$HOME"/.claude/plugins/cache/*/ralph/*/scripts/board 2>/dev/null |
    awk -F/ '{ print $(NF-2) "\t" $0 }' | sort -V -k1,1 | tail -1 | cut -f2-)
  [ -n "$best" ] && [ -x "$best" ] && printf 'guess\t%s\n' "$best"
}

installed_board_cli() { installed_board_cli_tagged | cut -f2-; }
if [ -n "${RALPH_HERDR_BOARD:-}" ]; then
  BOARD="$RALPH_HERDR_BOARD"
  [ -x "$BOARD" ] || die "RALPH_HERDR_BOARD=$BOARD is not an executable board CLI"
elif [ -x "$REPO/ralph/scripts/board" ]; then
  BOARD="$REPO/ralph/scripts/board"
else
  BOARD=$(installed_board_cli || true)
  [ -n "$BOARD" ] && [ -x "$BOARD" ] || die "no board CLI found — tried \$RALPH_HERDR_BOARD (unset), $REPO/ralph/scripts/board, $(ralph_installed_plugins_file), and ~/.claude/plugins/cache/*/ralph/*/scripts/board (is the ralph Claude Code plugin installed?)"
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

# ralph_plugin_freshness_notice — spawn-time observability for the drift that
# doctor's `ralph-herdr-content` line reports (GH-2260). ADVISORY: it returns
# 0 on every path and gates nothing. The remedy swaps code under a live
# cockpit, so it is the operator's act with the fleet quiesced; refusing a
# spawn over a stale plugin is strictly worse than spawning on one.
#
# The SUBJECT is anchored at $REPO — the checkout the spawn is cwd'd to — and
# is handed to the sync script as a `--source` tree to HASH. That anchor is
# the whole reason this detects anything: when herdr executes the INSTALLED
# copy (`plugin action invoke`, the fleet lane, the dispatch seat — the lanes
# that actually run stale code), the sync script's own default SRC_TREE *is*
# the installed tree, so without the argument it would hash a tree against
# itself and every stale cockpit would certify itself fresh.
#
# The CODE that runs is this tree's own sibling, never the checkout's copy
# (GH-2340). The first version ran `$REPO/.../herdr-plugin-sync.sh` — the
# installed plugin executing whatever script the worktree it was pointed at
# happened to carry, on any branch, with the cockpit's env, across a version
# boundary where `--check` and the exit codes belong to the other side. A
# checkout is a subject to be measured, not a program to be trusted; and a
# caller and callee from one tree cannot disagree about the flag contract.
#
# Running that script rather than re-implementing its hash is deliberate: the
# behavior surface already lives in two mirrored copies (it and
# herdr-setup.sh's `ralph-herdr-content` line), and a third held in sync by a
# comment asking for it is the GH-1843 shape.
#
# Four outcomes, none conflated:
#   no source tree at $REPO  silent — NOT APPLICABLE, not unevaluated. A host
#                            repo has no tree to be stale against and no
#                            remedy to name, and a permanent line whose remedy
#                            cannot act is the GH-2052 trap.
#   in sync                  silent — the common case; a preamble that prints
#                            on every spawn stops being read (GH-2048).
#   unreadable               NOT CHECKED, with the reason — a failed
#                            measurement may not read like a clean one
#                            (GH-1971). A missing sibling script is this case.
#   different                the drift, loud, with the sync command.
#
# The MEASUREMENT is memoized per process, the MESSAGE is not. Hashing both
# trees forks shasum per file and costs ~1.1s, which the cockpit's fzf rung
# would otherwise pay on every spawn in its loop — usually to print nothing.
# Nothing can change the answer inside one process either: doing so means
# syncing the plugin under the very loop that is running, which is the act
# this notice tells the operator to take with the fleet quiesced. Re-rendering
# the message each call is deliberate and separate: every spawn takes the
# risk, so every spawn is told. The memo is KEYED on the subject tree, never
# a bare "already ran" flag: $REPO is a variable, and a cache that answered
# for one checkout while asked about another would report the wrong tree with
# full confidence. Clearing _RALPH_FRESHNESS_KEY forces a re-measure.
#
# The two phrases below — "INSTALLED ralph-herdr differs" and "freshness NOT
# CHECKED" — are read by the cockpit (cockpit/fetch.go freshnessNotice), which
# discards spawn stderr on success and would otherwise announce nothing.
_RALPH_FRESHNESS_KEY=""
_RALPH_FRESHNESS_RC=""
_RALPH_FRESHNESS_TAIL=""
ralph_plugin_freshness_notice() {
  local subject="$REPO/plugin/ralph-herdr" sync="$_RALPH_HERDR_LIB_DIR/herdr-plugin-sync.sh" out rc=0
  [ -d "$subject/scripts" ] || return 0
  if [ "$_RALPH_FRESHNESS_KEY" = "$subject" ]; then
    rc="$_RALPH_FRESHNESS_RC"
  else
    if [ -f "$sync" ]; then
      out=$(bash "$sync" --check --source "$subject" 2>&1) || rc=$?
    else
      out="no herdr-plugin-sync.sh beside $_RALPH_HERDR_LIB_DIR/lib.sh"
      rc=2
    fi
    _RALPH_FRESHNESS_KEY="$subject"
    _RALPH_FRESHNESS_RC="$rc"
    _RALPH_FRESHNESS_TAIL=$(printf '%s' "$out" | tail -1)
  fi
  case "$rc" in
    0) ;;
    1)
      echo "${0##*/}: the INSTALLED ralph-herdr differs from $subject — the cockpit's own lanes (plugin action invoke, the fleet, the dispatch seat) execute that installed copy, not this checkout." >&2
      echo "${0##*/}: spawning anyway — this is advisory, never a gate. Sync with the fleet quiesced, since it swaps code under live panes: bash $subject/scripts/herdr-plugin-sync.sh" >&2
      ;;
    *)
      echo "${0##*/}: ralph-herdr freshness NOT CHECKED — $_RALPH_FRESHNESS_TAIL" >&2
      ;;
  esac
  return 0
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
  # How a failure failed, for callers that clean up a surface they created:
  # "refused" is herdr's own well-formed no — nothing started, cleanup is
  # safe; "uncertain" is a transport failure or silence — the start MAY have
  # landed, and closing the pane could kill a live agent (PR #2326 P1).
  RALPH_HERDR_START_OUTCOME=""
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
      if [ "$rc" -eq 2 ]; then
        RALPH_HERDR_START_OUTCOME="refused"
        echo "agent start $name refused: $code $(ralph_herdr_err_message "$out")" >&2
      else
        RALPH_HERDR_START_OUTCOME="uncertain"
      fi
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
# vanishes teaches nothing), so the trap holds the pane open until a human
# reads it. It is reached on EVERY exit of a script that did not exec away —
# success included — so the banner may not assert that a spawn failed; the rc
# and RALPH_HERDR_AGENT_LIVE (set by callers the moment agent start succeeds)
# are the only two facts it has. Three outcomes are distinguished: a live-but-
# undispatched agent, a clean exit, and a spawn that never started.
hold_pane() {
  local rc=$?
  # RALPH_HERDR_NO_HOLD is the CALLER's assertion that this process is not a
  # pane entrypoint: nothing closes on exit, so there is nothing to hold and
  # no human on this stdin. The assertion must come from the caller — no
  # environment variable distinguishes a pane entrypoint from a subprocess of
  # one (HERDR_PANE_ID/HERDR_ENV are inherited by every child), which is the
  # same property day.sh relies on to know it is inside Herdr at all.
  # RESIDUAL, deliberately not closed: `bash dispatch-up.sh` run BY HAND from a
  # managed pane shell sets nothing and still holds, because that invocation
  # passed through no caller that could assert anything.
  [ -z "${RALPH_HERDR_NO_HOLD:-}" ] || return 0
  if [ -n "${RALPH_HERDR_AGENT_LIVE:-}" ]; then
    printf '\n[ralph-herdr] agent STARTED but dispatch did not complete (exit %d) — the agent is live and idle; see the error above for the manual prompt command. Enter to close.\n' "$rc"
  elif [ "$rc" -eq 0 ]; then
    printf '\n[ralph-herdr] done (exit 0) — press Enter to close this pane.\n'
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
#                     [ROLE] [PARENT_REF] [DEPTH] [ROOT_REF] [ADDRESS]
#                     [TOOL_BINDING] [PROCESS_CONTAINMENT]
# — print the ledger spawn event as ONE compact JSON line:
#   {ts, ev: "spawn", agent_ref, pane_id?, shell_pid?, checkout?,
#    tool_binding?, process_containment?, lineage: <C7>, tokens: <C8 map>}
#
# tool_binding and process_containment (GH-2267) are what the spawn ACHIEVED
# for each containment mechanism — two top-level fields, one
# CONTAINMENT_OUTCOMES word each, never one field carrying both and never
# derived from the role token (the design record's collapse). They ride the
# spawn record only where the outcome is known when the record is written:
# an investigator's record is appended after its probe, a driver requested
# nothing. A record written BEFORE the outcome exists (the team lead's
# provisional row) leaves both empty and a later `containment` event carries
# them — see _ralph_spawn_containment_event. Empty omits the field.
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
  local shell_pid="${8-}" checkout="${9-}" role="${10-}" parent_ref="${11-}" depth="${12-}" root_ref="${13-}"
  # GH-2209 (D0.4): the herd address, stamped at spawn beside the C8 lineage
  # tokens — spawn-time truth like role, because the team half needs a board
  # read the pane cannot repeat. Empty omits the token (an older board copy,
  # or a spawn that never read `board name`); a positional, never an env read,
  # so a stale address from an earlier spawn in the same shell cannot leak
  # onto a different unit's record.
  local address="${14-}" tool_binding="${15-}" process_containment="${16-}"
  local parsed lane slug epoch by
  parsed=$(ralph_agent_parse "${ref%%#*}") || return 1
  # shellcheck disable=SC2086  # intentional: parse output is space-separated
  set -- $parsed
  lane="$1" slug="$3"
  [ "$slug" = "''" ] && slug=""
  epoch="${ref##*#}"
  # GH-1808: the role is stated by the caller and only DEFAULTED from the lane
  # — the lane is the name's first char, so a lane-derived role asserts nothing
  # the ref did not already say. depth/parent/root carry a child spawn (a
  # driver's investigator); absent, this is a depth-0 root and root is self,
  # which is what every work-next/work-fleet spawn is by construction.
  [ -n "$role" ] || role=$(ralph_role_for_lane "$lane") || role="driver"
  case "$depth" in '' | *[!0-9]*) depth=0 ;; esac
  [ -n "$root_ref" ] || root_ref="$ref"
  case "${RALPH_HERDR_INVOKED_BY:-}" in
    agent | scheduler) by="$RALPH_HERDR_INVOKED_BY" ;;
    *) by="human" ;;
  esac
  jq -nc \
    --arg ts "$ts" --arg ref "$ref" --arg pane "$pane" \
    --argjson n "$n" --arg pi "$parent_issue" \
    --arg script "${0##*/}" --arg branch "$branch" --arg label "$label" \
    --arg lane "$lane" --arg slug "$slug" --arg epoch "$epoch" \
    --arg by "$by" --arg shell "$shell_pid" --arg checkout "$checkout" \
    --arg role "$role" --arg parent "$parent_ref" --arg depth "$depth" \
    --arg root "$root_ref" --arg address "$address" \
    --arg tb "$tool_binding" --arg pc "$process_containment" '
    {ts: $ts, ev: "spawn", agent_ref: $ref}
    + (if $pane == "" then {} else {pane_id: $pane} end)
    + (if $shell == "" then {} else {shell_pid: $shell} end)
    + (if $checkout == "" then {} else {checkout: $checkout} end)
    + (if $tb == "" then {} else {tool_binding: $tb} end)
    + (if $pc == "" then {} else {process_containment: $pc} end)
    + {lineage:
        ({contract: "ralph.lineage", contract_version: 1,
          agent_ref: $ref, issue: $n}
         + (if $pi == "" then {} else {parent_issue: ($pi | tonumber)} end)
         + {role: $role, spawner: {script: $script, invoked_by: $by},
            herdr: ({worktree_branch: $branch}
              + (if $pane == "" then {} else {pane_id: $pane} end)
              + (if $label == "" then {} else {workspace_label: $label} end)),
            plane: "herdr", spawned_at: $ts}),
       tokens:
        ({role: $role, issue: ($n | tostring)}
         + (if $slug == "" then {} else {slug: $slug} end)
         + (if $parent == "" then {} else {parent: $parent} end)
         + (if $address == "" then {} else {address: $address} end)
         + {root: $root, depth: $depth, state: "spawned", branch: $branch,
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

# ralph_main_ws_from_list WS_JSON SRC — resolve the repo's MAIN workspace id
# from a `workspace list` body (the GH-2246 rule, one definition — dispatch-up
# and the lane openers both read it). Primary key: the non-linked worktree
# binding on the source checkout — that binding is what makes the sidebar nest
# the fleet's worktrees underneath. Fallback: a workspace labeled with the
# checkout's basename and carrying no worktree object — the shape a main
# workspace this plugin itself created (dispatch-up's `workspace create`)
# reports. Prints the id, or nothing when no workspace matches; the CALLER
# owns the workspace-list read and its failure direction, because those
# directions legitimately differ (dispatch-up fails closed — it would create
# a duplicate; a lane opener falls back to the invoking workspace).
ralph_main_ws_from_list() {
  local ws_out="$1" src="$2" ws_id
  ws_id=$(jq -r --arg src "$src" \
    '[.workspaces[] | select(((.worktree.is_linked_worktree // false) | not) and ((.worktree.checkout_path // "") == $src))][0].workspace_id // empty' \
    <<<"$ws_out" 2>/dev/null) || ws_id=""
  if [ -z "$ws_id" ]; then
    # The label match must be UNIQUE: two repos can share a checkout basename,
    # and a label-only workspace carries nothing else to tell them apart — a
    # first-match pick would silently adopt another repo's space. Ambiguity
    # returns no id, so each caller lands on its own stated fallback (lane
    # openers use the invoking workspace; dispatch-up creates the space).
    ws_id=$(jq -r --arg l "$(basename "$src")" \
      '[.workspaces[] | select((.label == $l) and ((.worktree.is_linked_worktree // false) | not) and ((.worktree.checkout_path // "") == ""))] | if length == 1 then .[0].workspace_id else empty end' \
      <<<"$ws_out" 2>/dev/null) || ws_id=""
  fi
  printf '%s' "$ws_id"
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
# moment the pane exists (dry-run: planned), same read-back rule.
#
# Phase 2 (amended by the 2026-08-19 audit, D2b): the C7 spawn record is
# appended AT PANE CREATION — provisional, so a spawner killed before `agent
# start` still leaves a sweepable row — and closed with reason `never_started`
# on the paths that prove no worker exists; the spawn-time C8 tokens are
# pushed once the agent is LIVE. Both are observations: a failed append or
# push warns and never aborts the spawn — reconcile discovers an unledgered
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
  _ralph_resolve_names "${1-}" || return 1
  printf '%s\n' "$RALPH_HERDR_NAMED_BRANCH"
}

# _ralph_resolve_names N — the `board name` read behind ralph_branch_for_issue,
# split out so a caller that needs MORE than the branch can run it in ITS OWN
# shell: a `$(ralph_branch_for_issue …)` capture is a subshell, and a global
# set inside one evaporates with it (the first draft of the GH-2209 stamping
# lost the address exactly that way). Sets, never prints:
#   RALPH_HERDR_NAMED_BRANCH   the branch to cut/resume (legacy-aware)
#   RALPH_HERDR_NAMED_ADDRESS  the herd address (GH-2209/D0.4) — empty against
#                              an older board copy, and the spawn record then
#                              omits the token, which every consumer must
#                              already survive (tokens are decorative)
_ralph_resolve_names() {
  local n="${1-}" names branch legacy
  RALPH_HERDR_NAMED_BRANCH=""
  RALPH_HERDR_NAMED_ADDRESS=""
  names=$("$BOARD" name "$n" --json) || {
    echo "ralph_branch_for_issue: \`board name $n\` failed — cannot derive the branch" >&2
    return 1
  }
  branch=$(printf '%s' "$names" | jq -r '.branch // empty')
  legacy=$(printf '%s' "$names" | jq -r '.legacyBranch // empty')
  RALPH_HERDR_NAMED_ADDRESS=$(printf '%s' "$names" | jq -r '.address // empty')
  if [ -z "$branch" ]; then
    echo "ralph_branch_for_issue: \`board name $n\` returned no branch" >&2
    return 1
  fi
  if [ -n "$legacy" ] && ! _ralph_branch_exists "$branch" && _ralph_branch_exists "$legacy"; then
    branch="$legacy"
  fi
  RALPH_HERDR_NAMED_BRANCH="$branch"
}

# ── spawn-path additions (2026-08-19 ways-of-working audit, D1/D2/D3) ───────

# ralph_sessions_dir — the machine-shared per-(worktree, unit) lock directory
# board.ts's claim path publishes (GH-1956, worktreeLockPath). Read here, never
# written: `board claim` is the one writer, and that acquisition is mandatory.
ralph_sessions_dir() {
  printf '%s\n' "${RALPH_HERDR_SESSIONS_DIR:-${RALPH_HOME:-$HOME/.ralph}/sessions}"
}

# _ralph_file_mtime FILE — epoch mtime, GNU stat first, BSD second. GNU MUST
# come first: on GNU, `stat -f %m FILE` SUCCEEDS and prints the mount point
# ("/"), so a BSD-first probe returns garbage on Linux and every lock reads
# as garbled — observed as CI (ubuntu) skipping a lock the mac read fine.
# `stat -c` on BSD fails cleanly, so this order is safe on both.
_ralph_file_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }

# ralph_worktree_lock_holder N — print one line describing a LIVE per-
# (worktree, unit) lock on issue N, or nothing. Read-only and advisory (audit
# D3): the spawn pre-check SKIPs on a live lock, because the pane it would
# open is exactly the "correctly refused, fully wasted" pane observed when a
# spawner raced a session already driving the unit (eef416fb / feat-1965).
# It can only SKIP, never override — the enforcement stays at `board claim`
# (GH-1948/GH-1956), which is where the lock is taken and read back.
#
# Failure directions, deliberately split: a lock we can READ and that is fresh
# on the board claim's own clock (RALPH_LOCK_TTL_MIN, the one staleness
# definition) skips the spawn; an absent or unreadable sessions dir asserts
# NOTHING and the spawn proceeds — a failed local read must not block work the
# real guard would admit, and the claim protocol inside the session is the
# backstop. The filename match is anchored so `wt-19290-…` is never read as a
# hold on #1929 (the GH-1996 prefix-match trap).
ralph_worktree_lock_holder() {
  local n="$1" dir f m now ttl cutoff wt since
  dir=$(ralph_sessions_dir)
  [ -d "$dir" ] || return 0
  ttl="${RALPH_LOCK_TTL_MIN:-120}"
  case "$ttl" in '' | *[!0-9]* | 0) ttl=120 ;; esac
  now=$(date +%s)
  cutoff=$((now - ttl * 60))
  for f in "$dir"/wt-"$n"-*.json; do
    [ -f "$f" ] || continue
    case "${f##*/}" in "wt-$n-"????????????????.json) : ;; *) continue ;; esac
    m=$(_ralph_file_mtime "$f") || continue
    case "$m" in '' | *[!0-9]*) continue ;; esac
    [ "$m" -ge "$cutoff" ] || continue # aged out on the board claim's clock
    wt=$(jq -r '.worktree // "unknown"' "$f" 2>/dev/null) || continue
    since=$(jq -r '.since // "unknown"' "$f" 2>/dev/null) || since="unknown"
    printf 'a live local session holds it (lock %s, worktree %s, since %s; self-clears %s min after its last touch)\n' \
      "${f##*/}" "$wt" "$since" "$ttl"
    return 0
  done
  return 0
}

# provision_worktree DIR — make a fresh worktree runnable BEFORE the session
# lands in it (audit D1: 46 mid-work npm installs across ~28 sessions, seven
# sessions of wrong-tsc/vitest config deaths, red attestations from
# node_modules-less trees — a failure the repo had already memorialized and
# that recurred anyway, i.e. a mechanism gap, not a knowledge gap).
#
# Order: the host repo's own executable scripts/provision-worktree.sh when
# present (the repo states its own recipe), else the lockfile-matched install
# when node_modules is absent, else nothing. Which path was taken is PRINTED
# into the spawn output either way.
#
# FAIL-OPEN by design, stated rather than implied: a failed install prints and
# the spawn continues — the agent can still read and plan, and the fail-closed
# half of this audit finding lives at the evidence gate (attest refusing
# unrunnable runs), which is the mutation path, not a spawn hook. The rc is
# recorded in RALPH_HERDR_SPAWNED_PROVISION_RC so a fleet's summary can name
# the spawns that landed unprovisioned (GH-2106) — a provisioner failing on
# every spawn read, in the per-spawn log alone, exactly like one broken host
# script, and went unnoticed for a whole run.
provision_worktree() {
  local wt="${1-}" rc=0 tool=""
  if [ -z "$wt" ] || [ ! -d "$wt" ]; then
    echo "provision: skipped (no worktree path readable from the response)"
    return 0
  fi
  if [ -x "$wt/scripts/provision-worktree.sh" ]; then
    echo "provision: running $wt/scripts/provision-worktree.sh"
    # The worktree path is passed as argv1 (GH-2106): a host script that
    # ignores argv is unaffected, one that reads it (`${1:?Usage}`) exited 1 on
    # EVERY spawn without it — fail-open, so the log said "continuing" and the
    # agent landed in an uninstalled tree that could not type-check or test.
    (cd "$wt" && bash scripts/provision-worktree.sh "$wt") || rc=$?
    RALPH_HERDR_SPAWNED_PROVISION_RC="$rc"
    [ "$rc" -eq 0 ] ||
      echo "provision: scripts/provision-worktree.sh exited $rc — continuing (fail-open; the attest gate is the fail-closed half)" >&2
    return 0
  fi
  if [ -d "$wt/node_modules" ]; then
    echo "provision: node_modules already present — nothing to do"
    return 0
  fi
  if [ -f "$wt/package-lock.json" ]; then
    tool="npm ci --no-audit --no-fund"
  elif [ -f "$wt/pnpm-lock.yaml" ]; then
    tool="pnpm install --frozen-lockfile"
  elif [ -f "$wt/yarn.lock" ]; then
    tool="yarn install --frozen-lockfile"
  fi
  if [ -z "$tool" ]; then
    echo "provision: no provision script and no lockfile — nothing to do"
    return 0
  fi
  if ! command -v "${tool%% *}" >/dev/null 2>&1; then
    echo "provision: ${tool%% *} not on PATH — skipping; by hand: cd $wt && $tool" >&2
    return 0
  fi
  echo "provision: $tool (fresh worktree: lockfile present, node_modules absent)"
  # shellcheck disable=SC2086  # $tool is one of the three fixed strings above
  (cd "$wt" && $tool) || rc=$?
  RALPH_HERDR_SPAWNED_PROVISION_RC="$rc"
  [ "$rc" -eq 0 ] ||
    echo "provision: '$tool' exited $rc — continuing (fail-open; attest refuses unrunnable evidence downstream)" >&2
  return 0
}

# spawn_modal_probe PANE — best-effort probe for the known blocking modals
# (audit D2: three spawns lost to an onboarding modal — trust prompt, theme
# picker, login — visible only to a human look). One pane read, matched
# against the observed modal strings; a hit prints one machine-greppable
# `pane-blocked-modal` line. Decoration: every failure returns 0 silently —
# an unreadable pane is not evidence of a modal, and this probe gates nothing.
spawn_modal_probe() {
  local pane="${1-}" out text line err
  [ -n "$pane" ] || return 0
  err=$(ralph_diag_file)
  out=$(ralph_herdr_call pane_read pane read "$pane" --lines 40 --source visible 2>"$err") || {
    [ "$err" = /dev/null ] || rm -f "$err" 2>/dev/null || true
    return 0
  }
  [ "$err" = /dev/null ] || rm -f "$err" 2>/dev/null || true
  text=$(jq -r '.read
    | if type == "object" then ((.lines // .text // .content // empty)
        | if type == "array" then join("\n") else tostring end)
      else tostring end' <<<"$out" 2>/dev/null) || text=""
  [ -n "$text" ] || return 0
  line=$(printf '%s\n' "$text" |
    grep -iE 'trust the files|choose the text style|select login method|welcome to claude|press enter to continue|paste code here if' |
    head -1) || line=""
  [ -n "$line" ] || return 0
  echo "pane-blocked-modal $pane — $(printf '%s' "$line" | ralph_sanitize)"
  return 0
}

# spawn_prompt_probe PANE FRAGMENT — is the delivered prompt actually sitting
# in the pane's input box? (GH-2223: SPAWN-UNCONFIRMED shipped one remedy —
# `pane send-keys Enter` — written for present-but-unsubmitted, while both
# observed instances were never-delivered: an EMPTY input box, where Enter
# submits a blank line and the session sits idle looking alive.) One
# visible-pane read, fixed-string match on a short fragment of the prompt.
# Three verdicts, because the two failure modes have OPPOSITE remedies and an
# unreadable pane may pick neither:
#   0  present — the text sits unsubmitted in the input box
#   1  absent  — the pane rendered text and the fragment is nowhere in it
#   2  unknown — the pane could not be read, or rendered nothing (a live
#      session always renders its input-box chrome, so a blank read is a
#      degraded read, not evidence of an empty box)
spawn_prompt_probe() {
  local pane="${1-}" frag="${2-}" out text
  { [ -n "$pane" ] && [ -n "$frag" ]; } || return 2
  out=$(ralph_herdr_call pane_read pane read "$pane" --lines 40 --source visible 2>/dev/null) || return 2
  text=$(jq -r '.read
    | if type == "object" then ((.lines // .text // .content // empty)
        | if type == "array" then join("\n") else tostring end)
      else tostring end' <<<"$out" 2>/dev/null) || return 2
  [ -n "$text" ] || return 2
  printf '%s\n' "$text" | grep -qF -- "$frag" && return 0
  return 1
}

# spawn_confirm_turn AGENT PANE PROMPT SUBJECT RESPAWN — the one spawn-confirm
# loop (GH-2223; previously duplicated verbatim in spawn_work_session and
# work-team.sh — the GH-2058 shape). Waits for the delivered prompt to become
# a STARTED turn, and on timeout separates the two failure modes that used to
# share one message:
#   - prompt present in the input box → the original remedy: submit it
#     (`herdr pane send-keys PANE Enter`)
#   - input box demonstrably empty → the prompt was NEVER DELIVERED; redeliver
#     it ONCE to the live session (it is addressable at exactly this moment),
#     and only if that too fails hand back RESPAWN — the caller-worded
#     remove-and-respawn remedy, safe because an agent that never took a turn
#     holds no claim and no commits
#   - pane unreadable → say so and hand back BOTH remedies keyed on a human
#     look; never redeliver blind, since a redelivery onto a present-but-
#     unsubmitted prompt would double the text
# rc 0 = turn started (possibly via the redelivery); rc 1 = unconfirmed, one
# SPAWN-UNCONFIRMED line printed that names the pane and the applicable remedy.
spawn_confirm_turn() {
  local agent="$1" pane="$2" prompt="$3" subject="$4" respawn="$5"
  local confirm_total="${RALPH_HERDR_SPAWN_CONFIRM_SEC:-60}" chunk frag
  local waited turn_ok turn_err probe_rc redelivered=""
  case "$confirm_total" in '' | *[!0-9]* | 0) confirm_total=60 ;; esac
  chunk="${RALPH_HERDR_TURN_WAIT_SEC:-20}"
  case "$chunk" in '' | *[!0-9]* | 0) chunk=20 ;; esac
  # Short so terminal line-wrapping cannot split it across a pane read's
  # lines; fixed-string so prompt text is never a pattern.
  frag=$(printf '%s\n' "$prompt" | head -n 1 | cut -c1-24)
  while :; do
    waited=0 turn_ok=""
    turn_err=$(ralph_diag_file)
    while :; do
      if spawn_turn_started "$agent" 2>"$turn_err"; then
        turn_ok=1
        break
      fi
      waited=$((waited + chunk))
      [ "$waited" -lt "$confirm_total" ] || break
    done
    if [ -n "$turn_ok" ]; then
      [ "$turn_err" = /dev/null ] || rm -f "$turn_err" 2>/dev/null || true
      [ -n "$redelivered" ] &&
        echo "spawn: the first delivery never reached pane $pane — the redelivered prompt started the turn"
      return 0
    fi
    [ -s "$turn_err" ] && cat "$turn_err" >&2
    [ "$turn_err" = /dev/null ] || rm -f "$turn_err" 2>/dev/null || true
    spawn_modal_probe "$pane"
    probe_rc=0
    spawn_prompt_probe "$pane" "$frag" || probe_rc=$?
    case "$probe_rc" in
      0)
        echo "SPAWN-UNCONFIRMED $pane — $subject is LIVE holding an unsubmitted prompt (no turn within ~${confirm_total}s${redelivered:+; redelivered once}); submit it with: herdr pane send-keys $pane Enter" >&2
        return 1
        ;;
      1)
        if [ -z "$redelivered" ]; then
          echo "spawn: pane $pane's input box is empty — the prompt was never delivered; redelivering once to the live session" >&2
          if ralph_herdr_agent_prompt "$agent" "$prompt" >/dev/null; then
            redelivered=1
            continue
          fi
          echo "SPAWN-UNCONFIRMED $pane — $subject is LIVE but the prompt was NEVER DELIVERED and redelivery failed; no turn was taken (no claim, no commits) — $respawn" >&2
          return 1
        fi
        echo "SPAWN-UNCONFIRMED $pane — $subject is LIVE but the prompt was NEVER DELIVERED (input box still empty after one redelivery); no turn was taken (no claim, no commits) — $respawn" >&2
        return 1
        ;;
      *)
        echo "SPAWN-UNCONFIRMED $pane — $subject is LIVE and no turn started within ~${confirm_total}s${redelivered:+ (one redelivery attempted)}; the pane could not be read to tell undelivered from unsubmitted — look at it: prompt present → herdr pane send-keys $pane Enter; input box empty → $respawn" >&2
        return 1
        ;;
    esac
  done
}

# spawn_containment_probe AGENT PANE CHECKOUT RESPAWN — the positive self-test
# for process containment (GH-2266), run IN THE PANE after `agent start` and
# BEFORE the real prompt. Prints ONE outcome word from contracts.ts
# CONTAINMENT_OUTCOMES on stdout (also left in RALPH_HERDR_CONTAINMENT_OUTCOME)
# and returns 0 only for `applied`; every other outcome is a refusal and the
# caller closes the pane it just opened — an uncontained pane must never
# receive its prompt.
#
# WHY A PROBE AT ALL: the sandbox fails OPEN and SILENTLY. A malformed block
# yields exit 0, a written file and no warning (measured, twice: 2.1.233 and
# 2.1.257). "Nothing went wrong" is exactly what an inert sandbox produces, so
# acceptance is an OBSERVED kernel denial or nothing.
#
# WHY IN THE PANE, not a sibling `claude -p` with the same settings: the pane
# is the exact process that will do the work, so its denial is the fact
# wanted, not a proxy for it; and a spawner that is itself contained (a lead
# staffing investigators) cannot run a nested `claude -p` at all — its Bash
# has no route to the model API — and a nested probe would read the OUTER
# sandbox's denial as the inner settings' success.
#
# WHY A WRITABILITY PRE-CHECK: an absent inside marker is a kernel denial only
# if this process — outside the sandbox — could write that exact path a
# moment before. Without it, an unwritable checkout root (permissions, a
# read-only mount) reads as `applied` under an inert sandbox while every
# writable file in the tree stays writable (PR #2337 P1).
#
# WHY THE FILESYSTEM, not the model's reply: the pane is asked to run ONE
# command — `touch <inside> <outside>` — and the verdict is read from which
# marker exists. `touch` continues past a failed operand, so both are always
# attempted from one command; the inside operand comes first, so an inert
# sandbox writes it before the outside one lands. The differential is what
# makes absence evidence: the outside marker proves the command RAN, the
# inside marker's absence proves the tree denial HELD. Neither present is
# `unverified` — the pane took no turn or wrote nothing — distinct from
# `not_applied`, because "could not check" may not render as "checked".
#
# Prompt delivery rides spawn_confirm_turn (GH-2223): the modal probe, the
# undelivered-vs-unsubmitted split and the one redelivery are all reused
# rather than restated.
#
#   RALPH_HERDR_CONTAINMENT_PROBE_SEC  seconds to wait for a marker once the
#                                       turn has started (default 30)
spawn_containment_probe() {
  local agent="${1-}" pane="${2-}" checkout="${3-}" respawn="${4:-re-spawn it}"
  local dir home inside outside prompt secs waited=0 outcome
  RALPH_HERDR_CONTAINMENT_OUTCOME=""
  _spawn_containment_verdict() {
    RALPH_HERDR_CONTAINMENT_OUTCOME="$1"
    rm -f "$inside" "$outside" 2>/dev/null || true
    printf '%s\n' "$1"
    [ "$1" = applied ]
  }
  { [ -n "$agent" ] && [ -n "$pane" ] && [ -n "$checkout" ]; } || {
    echo "containment probe: agent, pane and checkout are all required" >&2
    inside="" outside=""
    _spawn_containment_verdict unverified
    return 1
  }
  dir=$(cd "$checkout" 2>/dev/null && pwd -P) || {
    echo "containment probe: $checkout is not a directory" >&2
    inside="" outside=""
    _spawn_containment_verdict unverified
    return 1
  }
  home="${RALPH_HOME:-$HOME/.ralph}/containment-probes"
  mkdir -p "$home" 2>/dev/null || {
    echo "containment probe: cannot create $home for the outside marker" >&2
    inside="" outside=""
    _spawn_containment_verdict unverified
    return 1
  }
  inside="$dir/.ralph-containment-probe-$agent"
  outside="$home/$agent.$$"
  rm -f "$inside" "$outside" 2>/dev/null || true
  # The denial is evidence only against a target KNOWN to be writable without
  # containment (PR #2337 P1): a checkout root that refuses the write for an
  # ordinary reason — permissions, a read-only mount — would fail the inside
  # touch under an inert sandbox too, and the probe would read that as
  # `applied` while the tree's writable files stayed writable. So this
  # process, which runs outside the pane's sandbox, creates and removes the
  # exact inside path first; a target it cannot write is `unverified`, never
  # a pass.
  if ! { : >"$inside"; } 2>/dev/null; then
    echo "containment probe: $inside is not writable even OUTSIDE the sandbox — a denial there would prove nothing (unverified); check the checkout's permissions" >&2
    _spawn_containment_verdict unverified
    return 1
  fi
  rm -f "$inside" 2>/dev/null || {
    echo "containment probe: could not remove the writability check file $inside (unverified)" >&2
    _spawn_containment_verdict unverified
    return 1
  }
  prompt="Containment self-test (automatic, at startup — GH-2266). Run exactly this one Bash command, then reply with only its output. Do not retry it, do not run anything else, and do not investigate the result:
touch '$inside' '$outside'; echo PROBE_RC=\$?"
  ralph_herdr_agent_prompt "$agent" "$prompt" >/dev/null || {
    echo "containment probe: prompt delivery to $agent failed" >&2
    _spawn_containment_verdict unverified
    return 1
  }
  spawn_confirm_turn "$agent" "$pane" "$prompt" "$agent's containment probe" "$respawn" || {
    _spawn_containment_verdict unverified
    return 1
  }
  secs="${RALPH_HERDR_CONTAINMENT_PROBE_SEC:-30}"
  case "$secs" in '' | *[!0-9]* | 0) secs=30 ;; esac
  while :; do
    if [ -e "$inside" ]; then
      echo "containment probe: $agent WROTE INSIDE $dir — the sandbox is inert (not_applied); refusing to hand an uncontained pane its prompt" >&2
      _spawn_containment_verdict not_applied
      return 1
    fi
    if [ -e "$outside" ]; then
      # One more look at the inside marker AFTER the outside one landed: the
      # command touches inside first, so this is the ordering that makes an
      # absent inside marker mean "denied" rather than "not yet".
      if [ -e "$inside" ]; then
        echo "containment probe: $agent WROTE INSIDE $dir — the sandbox is inert (not_applied)" >&2
        _spawn_containment_verdict not_applied
        return 1
      fi
      _spawn_containment_verdict applied
      return 0
    fi
    [ "$waited" -lt "$secs" ] || break
    sleep 1
    waited=$((waited + 1))
  done
  echo "containment probe: $agent took a turn but neither marker appeared within ${secs}s (unverified) — the pane could not be proved contained; $respawn" >&2
  _spawn_containment_verdict unverified
  return 1
}

# _ralph_spawn_containment_event REF LEDGER TOOL_BINDING PROCESS_CONTAINMENT
# — append the achieved containment outcomes (GH-2267) for a spawn whose
# record was written BEFORE they were known (the provisional row, audit D2b):
#   {ts, ev: "containment", agent_ref, tool_binding, process_containment,
#    via: "spawn"}
# Both words come from CONTAINMENT_OUTCOMES; both are REQUIRED here, because
# a containment event naming one mechanism would be read as the other being
# unknown, and this event exists so that nothing about either is unknown. An
# unknown `ev` is neutral to every open-set reducer in ledger.sh (spawn/
# discover open, exit closes, everything else passes through), so the event
# can never open or close a row. Written on success AND on refusal — the
# refusal is the fact this line of work exists to keep (a `not_applied` that
# lived only in a stderr line and an exit reason string was the paperwork
# nobody could re-read). Best-effort like _ralph_spawn_close: a failed append
# warns, since the spawn's own record already stands.
_ralph_spawn_containment_event() {
  local ref="${1-}" ledger="${2-}" tb="${3-}" pc="${4-}"
  { [ -n "$ref" ] && [ -n "$ledger" ]; } || return 0
  { [ -n "$tb" ] && [ -n "$pc" ]; } || {
    echo "spawn: not recording containment for $ref — both outcomes are required (tool_binding='${tb}', process_containment='${pc}')" >&2
    return 0
  }
  RALPH_HERDR_LEDGER="$ledger" ralph_ledger_append "$(jq -nc \
    --arg ts "$(date -u +%FT%TZ)" --arg ref "$ref" --arg tb "$tb" --arg pc "$pc" \
    '{ts: $ts, ev: "containment", agent_ref: $ref, tool_binding: $tb, process_containment: $pc, via: "spawn"}')" ||
    echo "spawn: could not record containment for $ref (tool_binding=$tb process_containment=$pc) — the ledger row says nothing about either" >&2
  return 0
}

# _ralph_spawn_close REF LEDGER REASON — close a provisional spawn record for
# a worker that never started (audit D2b). Best-effort: a failed append warns
# and leaves the row open, which reconcile's pane-proved phase E then closes.
_ralph_spawn_close() {
  local ref="${1-}" ledger="${2-}" reason="${3-}"
  { [ -n "$ref" ] && [ -n "$ledger" ]; } || return 0
  RALPH_HERDR_LEDGER="$ledger" ralph_ledger_append "$(jq -nc \
    --arg ts "$(date -u +%FT%TZ)" --arg ref "$ref" --arg r "$reason" \
    '{ts: $ts, ev: "exit", agent_ref: $ref, reason: $r, via: "spawn"}')" ||
    echo "spawn: could not close the provisional record for $ref ($reason) — reconcile will prove it gone" >&2
  return 0
}

# ralph_dep_refs_verdict N QUEUE_JSON — one shared producer of the unwired
# body-reference verdict (GH-2109/GH-2120), for every surface that spawns off
# a ranked read: work-fleet's ranked path, refill, work-next. Wired edges are
# taken from the frontier/next read already in hand (never a second board
# call, and both envelope spellings are read); dep-refs.sh runs from $REPO so
# `gh repo view` resolves the slug the candidate lives in; and the output is
# ALWAYS one JSON line in dep-refs.sh's own envelope — synthesized ok=false
# when the script is absent or answered nothing, because "not evaluated" must
# never render as "checked and clean" at any caller. The refusal decision and
# its rendering stay with each caller: the biases differ by surface (GH-2120
# journal on the issue), and one producer is what keeps the three readers from
# drifting (the GH-1843 shape).
ralph_dep_refs_verdict() {
  local n="$1" q="$2" wired out
  [ -f "$SCRIPT_DIR/dep-refs.sh" ] || {
    jq -nc '{ok: false, count: 0, unwired: [], summary: "",
             detail: "dep-refs.sh is absent from this install"}'
    return 0
  }
  wired=$(jq -r --argjson n "$n" '
    [.queue[]? | select(.number == $n)] | .[0] // {} |
    ((.blockers // []) | map(.number)) + (.openBlockers // []) + (.closedBlockers // [])
    | map(tostring) | join(",")' <<<"$q" 2>/dev/null) || wired=""
  out=$(cd "$REPO" 2>/dev/null && bash "$SCRIPT_DIR/dep-refs.sh" "$n" "$wired" 2>/dev/null) || out=""
  if [ -z "$out" ] || ! jq -e '.ok | type == "boolean"' >/dev/null 2>&1 <<<"$out"; then
    jq -nc '{ok: false, count: 0, unwired: [], summary: "",
             detail: "dep-refs.sh produced no verdict"}'
    return 0
  fi
  printf '%s\n' "$out"
}

spawn_work_session() {
  local n="$1" queue_json="${2:-}" branch label parent title agent live pane out
  local ref ts record ledger src lead_ref="" lead_depth=""
  local team_lead="" who_lead="" who_dispatch=""
  # Lineage (GH-2214/D4.1): a team lead's workspace env carries its own
  # durable ref (work-team.sh mints it at workspace creation), and the
  # workers the lead spawns record it as their C8 parent and root, depth 1 —
  # "the lead intrinsically knows the workers it created", written down where
  # unit I's readers can read it. Gated on the NAME half parsing and an epoch
  # half existing, because the value lands in a ledger record; absent or
  # malformed, the spawn is a depth-0 root exactly as before (tokens are
  # chrome — a lost lineage never costs the spawn).
  if [ -n "${RALPH_HERDR_TEAM_LEAD_REF:-}" ]; then
    case "$RALPH_HERDR_TEAM_LEAD_REF" in
      *#?*)
        if ralph_agent_parse "${RALPH_HERDR_TEAM_LEAD_REF%%#*}" >/dev/null 2>&1; then
          lead_ref="$RALPH_HERDR_TEAM_LEAD_REF"
          lead_depth=1
        fi
        ;;
    esac
    [ -n "$lead_ref" ] ||
      echo "RALPH_HERDR_TEAM_LEAD_REF='$RALPH_HERDR_TEAM_LEAD_REF' is not a durable ref (name#epoch) — spawning as a depth-0 root" >&2
  fi
  RALPH_HERDR_SPAWNED_AGENT=""
  RALPH_HERDR_SPAWNED_REF=""
  # Pane id + worktree checkout path, read back from the live responses
  # (never predicted; empty in dry runs).
  RALPH_HERDR_SPAWNED_PANE=""
  RALPH_HERDR_SPAWNED_WORKTREE=""
  # The workspace the worktree landed in, so a child spawn (GH-1808's
  # investigators) opens its tab beside the driver rather than wherever herdr
  # would otherwise put it.
  RALPH_HERDR_SPAWNED_WORKSPACE=""
  # provision_worktree's rc, empty until a provisioner actually ran — "no
  # provisioning was attempted" and "provisioning succeeded" are different
  # answers and a summary may not print one as the other.
  RALPH_HERDR_SPAWNED_PROVISION_RC=""
  export RALPH_HERDR_SPAWNED_AGENT RALPH_HERDR_SPAWNED_REF
  export RALPH_HERDR_SPAWNED_PANE RALPH_HERDR_SPAWNED_WORKTREE
  export RALPH_HERDR_SPAWNED_WORKSPACE RALPH_HERDR_SPAWNED_PROVISION_RC
  case "$n" in ''|*[!0-9]*) echo "spawn_work_session: bad issue number '$n'" >&2; return 1 ;; esac
  # Direct call, NOT a $() capture: the resolver sets the address global the
  # spawn record stamps (GH-2209), and a subshell would drop it on the floor.
  _ralph_resolve_names "$n" || return 1
  branch="$RALPH_HERDR_NAMED_BRANCH"

  # Chain of command (GH-2217, D4.2) — derived LOCALLY from the one address
  # read the resolver already paid for, never a second board call per spawn:
  # dispatch is the address's repo segment + /dispatch (the same spelling
  # `board who dispatch` derives), and the lead's address is the worker's own
  # team segment + the lead's grammar-B name — knowledge the spawner already
  # holds (the lead spawned us; D3.2). The lead half is derived only when the
  # team segment's epic and the lead name's number AGREE: a lead staffing an
  # out-of-team unit (explicit work-fleet.sh NNN) would otherwise mint an
  # address naming a team the lead is not in. Empty on any doubt — addresses
  # are chrome, and a wrong address is worse than none.
  team_lead="${RALPH_HERDR_TEAM_LEAD:-}"
  if [ -n "$team_lead" ] && ! ralph_agent_parse "$team_lead" >/dev/null 2>&1; then
    team_lead=""
  fi
  if [ -n "$RALPH_HERDR_NAMED_ADDRESS" ]; then
    case "$RALPH_HERDR_NAMED_ADDRESS" in
      *[!A-Za-z0-9._/-]*) : ;; # off-charset address: inject nothing derived from it
      */*)
        who_dispatch="${RALPH_HERDR_NAMED_ADDRESS%%/*}/dispatch"
        case "$RALPH_HERDR_NAMED_ADDRESS" in
          */t*-*/*)
            if [ -n "$team_lead" ]; then
              local _team_seg _team_epic _lead_num
              _team_seg="${RALPH_HERDR_NAMED_ADDRESS#*/}" _team_seg="${_team_seg%%/*}"
              _team_epic="${_team_seg#t}" _team_epic="${_team_epic%%-*}"
              _lead_num="${team_lead#?}" _lead_num="${_lead_num%%-*}"
              [ -n "$_team_epic" ] && [ "$_team_epic" = "$_lead_num" ] &&
                who_lead="${RALPH_HERDR_NAMED_ADDRESS%/*}/$team_lead"
            fi
            ;;
        esac
        ;;
    esac
  fi
  # Out-vars for the C3 brief writer (ralph_brief_write reads them): the who
  # block and the pane env below come from ONE derivation, so they cannot
  # disagree about who the lead is.
  RALPH_HERDR_SPAWNED_ADDRESS="$RALPH_HERDR_NAMED_ADDRESS"
  RALPH_HERDR_SPAWNED_WHO_LEAD="$who_lead"
  RALPH_HERDR_SPAWNED_WHO_DISPATCH="$who_dispatch"
  export RALPH_HERDR_SPAWNED_ADDRESS RALPH_HERDR_SPAWNED_WHO_LEAD RALPH_HERDR_SPAWNED_WHO_DISPATCH

  # Workspace label: the DISPLAY form of the herd address (GH-2235) — the
  # leaf segment, because the sidebar already groups the worktree workspace
  # under its repo (and team) container, so a label carrying the absolute
  # address rendered as `repo/t2208-herd-topo…` twice over: the prefix
  # duplicated the container and the truncation cut the one segment that
  # distinguished the rows. The ADDRESS itself stays absolute where it is
  # authoritative — the C8 `address` token stamped below, the ledger, the
  # roster. Against an older board with no address, the legacy
  # "GH-N via GH-parent" nesting spelling survives as the fallback. The queue
  # JSON still feeds parent (lineage record) and title (agent-name slug).
  label=$(ralph_address_display "$RALPH_HERDR_NAMED_ADDRESS" 2>/dev/null) || label=""
  title="" parent=""
  if [ -n "$queue_json" ]; then
    parent=$(jq -r --argjson n "$n" '
      [.next, .queue[]?] | map(select(. != null and .number == $n)) | .[0].parentNumber // empty
    ' <<<"$queue_json" 2>/dev/null || true)
    [ -z "$label" ] && [ -n "$parent" ] && label="GH-$n via GH-$parent"
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

  # Audit D3: consult the per-(worktree, unit) lock `board claim` publishes
  # (GH-1956) before opening a pane. The herd read above sees herdr sessions;
  # this sees the OTHER population — a hand-started `claude`, a fork, any
  # local session that claimed N without ever passing a spawner. Read-only,
  # skip-only: the lock stays the enforcement, at claim; a stale read here
  # costs one refused pane, which was the baseline.
  local lockline
  lockline=$(ralph_worktree_lock_holder "$n") || lockline=""
  if [ -n "$lockline" ]; then
    echo "SKIP GH-$n — $lockline"
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
    local _plan_env=""
    [ -n "$team_lead" ] && _plan_env="RALPH_HERDR_LEAD=$team_lead RALPH_HERDR_TEAM_LEAD=$team_lead"
    case "$RALPH_HERDR_NAMED_ADDRESS" in
      '' | *[!A-Za-z0-9._/-]*) : ;;
      *) _plan_env="$_plan_env${_plan_env:+ }RALPH_HERDR_ADDRESS=$RALPH_HERDR_NAMED_ADDRESS" ;;
    esac
    [ -n "$who_lead" ] && _plan_env="$_plan_env${_plan_env:+ }WHO_LEAD=$who_lead"
    [ -n "$who_dispatch" ] && _plan_env="$_plan_env${_plan_env:+ }WHO_DISPATCH=$who_dispatch"
    [ -n "$_plan_env" ] && echo "  $HERDR pane run <captured> export $_plan_env"
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
    record=$(_ralph_spawn_record "$ref" "$n" "$parent" "$branch" "$label" "" "$(date -u +%FT%TZ)" \
      "" "" "" "$lead_ref" "$lead_depth" "$lead_ref" "${RALPH_HERDR_NAMED_ADDRESS-}" \
      "$(ralph_tool_binding_observed)" not_requested) || record=""
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
  RALPH_HERDR_SPAWNED_WORKSPACE=$(jq -r '.workspace.workspace_id // .workspace.id // empty' <<<"$out" 2>/dev/null) ||
    RALPH_HERDR_SPAWNED_WORKSPACE=""

  # One driver owns a tree (GH-1808). The w<N>-* pre-check above refuses a
  # second session on one ISSUE; this refuses a second WRITER in one CHECKOUT,
  # which is a different question — a reused worktree, a fork resumed in place,
  # or any path that reaches an occupied tree under a name the issue check
  # cannot see. Asked here because the checkout is only knowable from the
  # worktree response, and before `agent start` so the refusal costs a pane at
  # most, never a live second writer. rc 2, not 1: like every other
  # already-owned outcome on this path, a fleet caller keeps going.
  if [ -n "$RALPH_HERDR_SPAWNED_WORKTREE" ]; then
    if ! ralph_driver_guard "$RALPH_HERDR_SPAWNED_WORKTREE" "$n" >/dev/null; then
      echo "SKIP $RALPH_HERDR_SPAWNED_WORKTREE already has a live driver — not adding a second writer for GH-$n"
      return 2
    fi
  fi

  # Provisional ledger record, AT PANE CREATION (audit D2b). The record used
  # to be appended only after `agent start` succeeded, so a spawner killed
  # between the worktree opening and the agent starting left NOTHING — no
  # ledger row, no claim, no board state: outage-killed rendered identical to
  # finished, and 2-3 dead workers per incident were found by the user, not by
  # any sweep. Appending the spawn record here means a pre-start death leaves
  # an OPEN row bound to the pane and its shell pid, which reconcile phase E's
  # pane-proved verdict (GH-1809) closes as `crashed`/`restart_killed`. The
  # paths below that PROVE the worker never started close the row themselves
  # (reason `never_started`); the paths where the agent is live leave it open,
  # because a live worker is exactly what an open row means. Residual, stated:
  # a hand-run reconcile in the seconds between this append and the harness
  # process appearing could read the row as `crashed` and close it early — the
  # worker then goes live unledgered and phase B re-discovers it on the next
  # pass (the ledger is eventually-honest by design).
  #
  # The token PUSH stays where it was — after the agent is live — because a
  # spawn that loses the start race would otherwise stamp its own root/epoch
  # tokens over the winner's on the shared pane.
  ts=$(date -u +%FT%TZ)
  # The pane's shell pid, read once now: reconcile compares it later to tell a
  # rebuilt pane (herdr restart) from a worker that died inside a surviving one
  # (GH-1809). Best-effort — a failure costs the restart/crash distinction,
  # never the spawn.
  local shell_pid=""
  shell_pid=$(ralph_herdr_call pane_process_info pane process-info --pane "$pane" 2>/dev/null |
    jq -r '.process_info.shell_pid // empty' 2>/dev/null) || shell_pid=""
  case "$shell_pid" in '' | *[!0-9]*) shell_pid="" ;; esac
  [ -n "$shell_pid" ] || echo "could not read pane $pane's shell pid — reconcile will not be able to tell a restart from a crash for $agent" >&2
  record=""
  ledger=""
  if ref=$(ralph_agent_ref "$agent" 2>/dev/null); then
    RALPH_HERDR_SPAWNED_REF="$ref"
    # GH-2267: a driver is the one writer, and this path hands `agent start`
    # no harness argument at all — no binding flag, no sandbox document. Both
    # outcomes are therefore `not_requested`, read off the (empty) argv this
    # path passes rather than off the role: the observation is the spawner's
    # own act, and it is written so an absent field keeps meaning "a record
    # from before this existed", never "known off".
    record=$(_ralph_spawn_record "$ref" "$n" "$parent" "$branch" "$label" "$pane" "$ts" \
      "$shell_pid" "$RALPH_HERDR_SPAWNED_WORKTREE" "" "$lead_ref" "$lead_depth" "$lead_ref" "${RALPH_HERDR_NAMED_ADDRESS-}" \
      "$(ralph_tool_binding_observed)" not_requested) || record=""
    ledger=$(ralph_ledger_path "$REPO" 2>/dev/null) || ledger=""
    if [ -n "$record" ] && [ -n "$ledger" ]; then
      RALPH_HERDR_LEDGER="$ledger" ralph_ledger_append "$record" || {
        echo "spawn ledger append failed for $ref — reconcile will discover it" >&2
        record=""
      }
    else
      echo "spawn ledger: ${ledger:+record build failed}${ledger:-no board scope discoverable from $REPO} — reconcile will discover $ref" >&2
      record=""
    fi
  else
    ref=""
    echo "no durable ref derivable for $agent — spawning unledgered (reconcile will discover it)" >&2
  fi

  # Audit D1: make the fresh checkout runnable BEFORE the session starts.
  # After the provisional record on purpose — the record is one cheap append,
  # while an install can run for a minute, and a spawner killed mid-install
  # should still have left the sweepable row.
  provision_worktree "$RALPH_HERDR_SPAWNED_WORKTREE"

  # Team linkage (GH-2178) + chain of command (GH-2217): a team spawner
  # (work-team.sh, or a lead whose own workspace env carries it) names the
  # lead in RALPH_HERDR_TEAM_LEAD, and the addresses are exported into the
  # pane's interactive shell BEFORE `agent start` so the harness inherits
  # them — herdr panes inherit the SERVER's environment, never the spawner's
  # shell (see the BOARD resolution note above), and `worktree create` has no
  # --env, so the pane shell is the one channel that survives into the
  # session. Best-effort, tokens.sh-style direct call with nothing parsed:
  # fleet-send's o-lane name check is the primary lead detector, so a lost
  # injection costs the by-name env fallback (and the SessionStart who-is-who
  # line), never the spawn. Every value was validated above — the lead name
  # against grammar B, the addresses against the address charset — because
  # they are about to land on a shell command line.
  local _pane_env=""
  if [ -n "${RALPH_HERDR_TEAM_LEAD:-}" ] && [ -z "$team_lead" ]; then
    echo "RALPH_HERDR_TEAM_LEAD='$RALPH_HERDR_TEAM_LEAD' is not a grammar-B agent name — not injecting the lead address" >&2
  fi
  [ -n "$team_lead" ] && _pane_env="RALPH_HERDR_LEAD=$team_lead RALPH_HERDR_TEAM_LEAD=$team_lead"
  case "$RALPH_HERDR_NAMED_ADDRESS" in
    '' | *[!A-Za-z0-9._/-]*) : ;;
    *) _pane_env="$_pane_env${_pane_env:+ }RALPH_HERDR_ADDRESS=$RALPH_HERDR_NAMED_ADDRESS" ;;
  esac
  [ -n "$who_lead" ] && _pane_env="$_pane_env${_pane_env:+ }WHO_LEAD=$who_lead"
  [ -n "$who_dispatch" ] && _pane_env="$_pane_env${_pane_env:+ }WHO_DISPATCH=$who_dispatch"
  if [ -n "$_pane_env" ]; then
    "$HERDR" pane run "$pane" "export $_pane_env" >/dev/null 2>&1 ||
      echo "could not inject the chain-of-command env into pane $pane — the session can still find its lead by the o-lane name" >&2
  fi

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
      # The winner's own record is the live one; ours never became a worker,
      # so the provisional row is closed rather than left for a sweep to prove.
      _ralph_spawn_close "$ref" "$ledger" never_started
      echo "SKIP $agent already live (lost the spawn race for GH-$n) — leaving the worktree pane $pane to the winning session"
      return 2
    fi
    _ralph_spawn_close "$ref" "$ledger" never_started
    echo "agent start $agent failed — see the herdr error above (exhausted startup retries and non-collision refusals land here); not spawning" >&2
    return 1
  fi
  # Past this point the agent is LIVE — a prompt-delivery failure must not exit
  # silently and strand an idle session with no work, and hold_pane must not
  # claim "no session spawned" about it. The provisional ledger row stays OPEN
  # on every failure below: a live worker is exactly what an open row means.
  export RALPH_HERDR_AGENT_LIVE=1

  # Spawn tokens, now that the agent (and not a race's winner) owns the pane.
  # Read back off the record so the pane chrome and the ledger can never
  # disagree at spawn; failures cost chrome, never the spawn.
  if [ -n "$record" ]; then
    set --
    while IFS= read -r kv; do
      [ -n "$kv" ] || continue
      set -- "$@" "$kv"
    done < <(jq -r '.tokens | to_entries[] | "\(.key)=\(.value)"' <<<"$record" 2>/dev/null || true)
    [ "$#" -ge 1 ] && ralph_tokens_push "$pane" "$@"
  fi

  ralph_herdr_agent_prompt "$agent" "/ralph:work $n" >/dev/null || {
    echo "prompt delivery failed — agent $agent is LIVE and idle in pane $pane; prompt it manually: herdr agent prompt $agent \"/ralph:work $n\"" >&2
    return 1
  }

  # The spawn is not complete when the prompt is delivered — it is complete
  # when a turn has STARTED. An unconfirmed start is reported as a failure so
  # the fleet's `failed:` line carries it and the slot is not counted as
  # occupied and working (GH-1926). The agent is left live and the pane intact:
  # the remedy in the failure line recovers it, and reconcile already knows
  # the ledgered worker. spawn_confirm_turn holds the wait loop, the modal
  # probe, the undelivered-vs-unsubmitted split and the one redelivery
  # (GH-2223); audit D2a's machine-greppable SPAWN-UNCONFIRMED token and
  # RALPH_HERDR_SPAWN_CONFIRM_SEC live there.
  local respawn
  if [ -n "${RALPH_HERDR_SPAWNED_WORKSPACE:-}" ]; then
    respawn="remove the worktree and respawn: herdr worktree remove --workspace $RALPH_HERDR_SPAWNED_WORKSPACE, then re-spawn GH-$n"
  else
    respawn="remove the worktree (herdr worktree remove --workspace <id>) and re-spawn GH-$n"
  fi
  spawn_confirm_turn "$agent" "$pane" "/ralph:work $n" "GH-$n's agent $agent" "$respawn" || return 1

  RALPH_HERDR_SPAWNED_AGENT="$agent"
  echo "spawned GH-$n on $branch (pane $pane, agent $agent)"
  return 0
}
