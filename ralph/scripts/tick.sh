#!/usr/bin/env bash
# tick.sh — one autonomous iteration of the ralph v2 loop (GH-1662 Phase 3).
#
# The scheduler (launchd/cron) owns cadence; this script runs ONE tick:
#   queue check → worktree → one work session → log. Process exit is the
#   continuation signal — no sentinels, no wakeups, no in-session loop state.
#
# Transport-agnostic: RALPH_TICK_RUNNER is any command that accepts a prompt
# argument (default: claude -p at sonnet). Interactive /ralph:work sessions
# and bridge-env routines are equally valid drives of the same board.
set -euo pipefail

RALPH_HOME="${RALPH_HOME:-$HOME/.ralph}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BOARD="$REPO_ROOT/ralph/scripts/board"
TIMEOUT_MIN="${RALPH_TICK_TIMEOUT_MIN:-45}"
RUNNER="${RALPH_TICK_RUNNER:-claude -p --model sonnet --permission-mode acceptEdits}"

mkdir -p "$RALPH_HOME/logs"

# --- Autopilot opt-in: typed, fail-closed (no env-flipping, no hooks) -------
if ! grep -q '^autopilot=true$' "$RALPH_HOME/config" 2>/dev/null; then
  echo "tick: autopilot not enabled — write 'autopilot=true' to $RALPH_HOME/config (install-loop.sh --enable does this)" >&2
  exit 3
fi

# --- Billing guard: a scheduler env with a stray API key would silently bill
# API credits instead of the subscription. Loud, not silent. ------------------
if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "${RALPH_ALLOW_API_BILLING:-}" != "true" ]; then
  echo "tick: ANTHROPIC_API_KEY is set — refusing to spawn (would bill API credits, not the subscription)." >&2
  echo "tick: unset it for OAuth/subscription billing, or set RALPH_ALLOW_API_BILLING=true deliberately." >&2
  exit 3
fi

# --- One tick at a time per machine (portable: no flock on stock macOS) -----
LOCKDIR="$RALPH_HOME/tick.lock"
take_lock() { mkdir "$LOCKDIR" 2>/dev/null && echo $$ > "$LOCKDIR/pid"; }
if ! take_lock; then
  HOLDER_PID=$(cat "$LOCKDIR/pid" 2>/dev/null || echo "")
  if [ -n "$HOLDER_PID" ] && kill -0 "$HOLDER_PID" 2>/dev/null; then
    echo "tick: previous tick (pid $HOLDER_PID) still running — skipping" >&2
    exit 0
  fi
  rm -rf "$LOCKDIR"   # stale lock from a crashed tick
  take_lock || { echo "tick: lock race — skipping" >&2; exit 0; }
fi
trap 'rm -rf "$LOCKDIR"' EXIT

date +%s > "$RALPH_HOME/heartbeat"

# --- Queue check before spawning anything (cheap idle) ----------------------
NEXT=$("$BOARD" next --json | jq -r '.next.number // empty')
if [ -z "$NEXT" ]; then
  echo "$(date -u +%FT%TZ) idle" >> "$RALPH_HOME/ticks.log"
  exit 0
fi

# --- Worktree per job: never a shared HEAD ----------------------------------
WT="$REPO_ROOT/.claude/worktrees/GH-$NEXT"
if [ ! -d "$WT" ]; then
  git -C "$REPO_ROOT" fetch -q origin main
  git -C "$REPO_ROOT" worktree add -q -b "feature/GH-$NEXT" "$WT" origin/main 2>/dev/null \
    || git -C "$REPO_ROOT" worktree add -q "$WT" "feature/GH-$NEXT"
fi

export RALPH_CLAIM_HOLDER="tick@$(hostname -s)"
LOG="$RALPH_HOME/logs/gh-$NEXT.log"
START=$(date -u +%FT%TZ)
STATUS=ok

# Hard timeout: a hung session must not hold the claim past the tick.
# Portable — stock macOS has no `timeout`; use it when present, else a watchdog.
run_with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$((TIMEOUT_MIN * 60))" "$@"
  else
    "$@" & local work_pid=$!
    ( sleep "$((TIMEOUT_MIN * 60))" && kill "$work_pid" 2>/dev/null ) & local dog_pid=$!
    local rc=0; wait "$work_pid" || rc=$?
    kill "$dog_pid" 2>/dev/null || true
    [ "$rc" -ge 128 ] && rc=124   # killed by the watchdog → timeout semantics
    return "$rc"
  fi
}

RC=0
(cd "$WT" && run_with_timeout $RUNNER "/ralph:work $NEXT") >> "$LOG" 2>&1 || RC=$?
if [ "$RC" -ne 0 ]; then
  STATUS="exit=$RC"
  if [ "$RC" -eq 124 ]; then
    STATUS=timeout
    "$BOARD" release "$NEXT" -m "tick timeout after ${TIMEOUT_MIN}m — see $LOG on $(hostname -s); work may be partially committed on feature/GH-$NEXT" \
      >> "$LOG" 2>&1 || true
  fi
fi

# Exit codes lie (a session that does nothing still exits 0) — the board is
# the truth. A tick that left the issue unclaimed in Backlog was a no-op:
# loud in ticks.log, and repeated no-ops mean the runner is misconfigured.
if [ "$STATUS" = "ok" ]; then
  AFTER_STATE=$("$BOARD" get "$NEXT" --json 2>/dev/null | jq -r '.state // "unknown"')
  [ "$AFTER_STATE" = "Backlog" ] && STATUS="no-op (runner ran but board untouched — check RALPH_TICK_RUNNER)"
fi

# Clean worktree gets removed; a dirty one stays for the next tick/human.
if [ -z "$(git -C "$WT" status --porcelain 2>/dev/null)" ]; then
  git -C "$REPO_ROOT" worktree remove "$WT" 2>/dev/null || true
fi

echo "$START GH-$NEXT $STATUS" >> "$RALPH_HOME/ticks.log"
