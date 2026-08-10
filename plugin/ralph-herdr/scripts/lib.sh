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
# {name,status,pane}, filtered to names ^gh-[0-9]+$ or ^ralph-(deliver|tend)$.
# Read-only; prints nothing when no ralph agent is live. Non-zero only if the
# herdr read itself fails.
ralph_agents_json() {
  "$HERDR" agent list | jq -c '
    .result.agents[]?
    | select(.name != null)
    | select(.name | test("^gh-[0-9]+$|^ralph-(deliver|tend)$"))
    | {name: .name, status: .agent_status, pane: .pane_id}'
}

# The board CLI is the only sanctioned board surface. The default path is the
# vendored-checkout layout (ralph-hero itself); repos that install ralph as a
# Claude Code plugin carry board.ts inside the installed plugin instead, so
# RALPH_HERDR_BOARD overrides (detect-if-present, degrade gracefully).
# Missing/non-executable means this is not a ralph-configured repo — refuse
# rather than guess (the real scope gate stays board.ts's; the cockpit just
# shouldn't offer itself).
BOARD="${RALPH_HERDR_BOARD:-$REPO/ralph/scripts/board}"
[ -x "$BOARD" ] || die "no executable board CLI at $BOARD — not a ralph-configured repo (plugin-install host repos: set RALPH_HERDR_BOARD to the installed ralph plugin's scripts/board)"

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
#               --label "GH-N via GH-parent" so the cockpit shows the nesting.
#
# stdout: progress lines ending in "spawned GH-N on BRANCH (pane P, agent gh-N)"
#         (or the dry-run plan / a SKIP line).
# Returns: 0 spawned (or dry-run plan printed); 2 skipped — agent gh-N already
#          live (no mutation attempted); 1 real failure (worktree/start/prompt).
# Honors RALPH_HERDR_DRY_RUN=true: prints the exact plan and returns 0 before
# ANY herdr mutation.
spawn_work_session() {
  local n="$1" queue_json="${2:-}" branch label parent pane out
  case "$n" in ''|*[!0-9]*) echo "spawn_work_session: bad issue number '$n'" >&2; return 1 ;; esac
  branch="feature/GH-$n"

  # Nesting label: children group under an epic on the board; carry that into
  # the worktree workspace label when the caller's queue JSON knows the parent.
  label=""
  if [ -n "$queue_json" ]; then
    parent=$(jq -r --argjson n "$n" '
      [.next, .queue[]?] | map(select(. != null and .number == $n)) | .[0].parentNumber // empty
    ' <<<"$queue_json" 2>/dev/null || true)
    [ -n "$parent" ] && label="GH-$n via GH-$parent"
  fi

  # Skip, don't die, when a session already owns gh-N: fleet callers must keep
  # going. Checked before any mutation so the skip is side-effect free.
  if "$HERDR" agent list | jq -e --arg name "gh-$n" \
      '.result.agents[]? | select(.name == $name)' >/dev/null 2>&1; then
    echo "SKIP gh-$n already live"
    return 2
  fi

  if [ "${RALPH_HERDR_DRY_RUN:-}" = "true" ]; then
    echo "DRY RUN — would spawn GH-$n:"
    echo "  branch:  $branch   agent: gh-$n${label:+   label: $label}"
    echo "  git -C $REPO fetch -q origin main"
    echo "  $HERDR worktree create --cwd $REPO --branch $branch --base origin/main --no-focus${label:+ --label \"$label\"}"
    echo "    (fallback: $HERDR worktree open --cwd $REPO --branch $branch --no-focus${label:+ --label \"$label\"})"
    echo "  $HERDR agent start gh-$n --kind claude --pane <captured>"
    echo "  $HERDR agent prompt gh-$n \"/ralph:work $n\""
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
  # predicted or derived.
  pane=$(jq -r '.result.root_pane.pane_id // empty' <<<"$out")
  if [ -z "$pane" ]; then
    echo "no pane id in worktree response for GH-$n" >&2
    return 1
  fi

  # A name collision means a live session already owns gh-$N — refuse, never
  # improvise suffixes: two sessions on one issue is exactly what the board's
  # claim protocol exists to prevent. (The pre-check above catches the common
  # case; this catches the race.)
  agent_start_when_ready "gh-$n" "$pane" || {
    echo "agent start gh-$n failed — see the herdr error above (a live session owning gh-$n is the common cause, but exhausted startup retries land here too); not spawning a second" >&2
    return 1
  }
  # Past this point the agent is LIVE — a prompt-delivery failure must not exit
  # silently and strand an idle session with no work, and hold_pane must not
  # claim "no session spawned" about it.
  export RALPH_HERDR_AGENT_LIVE=1
  "$HERDR" agent prompt "gh-$n" "/ralph:work $n" || {
    echo "prompt delivery failed — agent gh-$n is LIVE and idle in pane $pane; prompt it manually: herdr agent prompt gh-$n \"/ralph:work $n\"" >&2
    return 1
  }

  echo "spawned GH-$n on $branch (pane $pane, agent gh-$n)"
  return 0
}
