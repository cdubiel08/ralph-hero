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
set -euo pipefail

REPO="${RALPH_HERDR_REPO:-$PWD}"
HERDR="${HERDR_BIN_PATH:-herdr}"

die() { echo "${0##*/}: $*" >&2; exit 1; }

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
