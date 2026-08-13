#!/usr/bin/env bash
# tick-herdr.sh — EXAMPLE: one iteration of the ralph work lane on a herdr pane.
#
# Copy and own. This is a transport recipe, not shipped harness (scripts are
# examples, contracts are doctrine — see README.md in this directory). It is
# tick.sh with the spawn swapped: instead of a headless `claude -p` under a
# kill-on-timeout, the session runs interactively in a herdr-managed pane that
# SURVIVES the tick.
#
# Same contract as tick.sh: the scheduler owns cadence, this runs ONE tick,
# board state is the truth. What changes:
#   - worktree via `herdr worktree create` (fetch first + --base origin/main —
#     without --base herdr branches from the parent checkout's HEAD)
#   - the session is `herdr agent start --kind claude` in the worktree's pane
#   - the wait is BOUNDED AT THE CLAIM TTL, deliberately: herdr persistence
#     outlives the claim (RALPH_LOCK_TTL_MIN, default 120m), so a pane still
#     working past TTL could double-work against a fresh claimant. This is
#     countermeasure (a) from the design doc: never kill the pane — on TIMEOUT,
#     send ONE wrap-up prompt (commit WIP; the tail owns the release), post a
#     notification, and release the claim. On BLOCKED (screen-detected, a hint
#     never a gate input) the tick only notifies: the claim stays with the
#     live session (TTL is the backstop) and no prompt is sent — `agent
#     prompt` submits text plus an encoded Enter, which at an approval dialog
#     could answer the very question that needed a human.
#   - the pane and its worktree are NOT removed at the end: the finished pane
#     holds the session transcript for review — that persistence is the point
#     of this transport. Cleanup is the human's explicit `herdr worktree
#     remove` (never deletes the branch; refuses a dirty checkout without
#     --force, which is tick.sh's dirty-stays semantics for free).
#
# Unattended arming takes TWO typed keys in ~/.ralph/config: the shared
# work-lane `autopilot=true` (tick.sh's key) plus `herdr_autopilot=true` for
# this transport. The second key STAYS: the server-restart TTL probe (design
# doc §5) ran 2026-08-11 (plugin/ralph-herdr/scripts/probe-claim-ttl.sh →
# thoughts/shared/research/2026-08-11-claim-ttl-pane-persistence-probe.md)
# and returned NO-GO for unattended arming — a restart restores pane
# topology (~225ms, same IDs) but KILLS the process in every pane and every
# in-flight `pane wait-output` (clean rc=1 `server_unavailable`, no resume;
# this tick's bounded wait errors, correctly leaving the claim to TTL). So
# an unattended tick chain across a restart strands one claim per in-flight
# issue for up to the TTL with a restored-but-idle pane looking alive.
#
# GH-1809 settled both of that verdict's revisit conditions, and the key still
# stays — for a different, smaller reason. (a) A restart-aware reconcile now
# releases a dead worker's claim at watcher startup, so the stall is one
# reconcile pass rather than 120 minutes. (b) Agent resume was verified live
# (thoughts/shared/research/2026-08-13-agent-pane-resume-probe.md): restore
# types `claude --resume <id>` into a fresh shell, so a restored pane holds a
# transcript at a prompt at best — never a worker mid-turn. What remains is
# that nothing RE-ARMS: after a restart the claims come back to Backlog
# correctly and no one picks them up, so an unattended chain is now safe but
# not productive across a restart. That is the open blocker, and it is the
# only one.
#
# Design record: thoughts/shared/research/2026-08-09-herdr-runtime-ralph-addon.md
# Cockpit sibling (actions, lane panes, notifications): plugin/ralph-herdr/
#
# Knobs (all optional):
#   RALPH_HOME          state dir (default ~/.ralph) — shares tick.pid and
#                       ticks.log with tick.sh, so the two transports serialize
#   RALPH_LOCK_TTL_MIN  claim TTL in minutes (default 120) — also the wait
#                       bound, on purpose (see above)
#   RALPH_CLAIM_HOLDER  holder identity for the release-if-still-held check —
#                       note the pane inherits the herdr SERVER's env, not this
#                       script's (see the EXPECTED_HOLDER comment below)
set -euo pipefail

RALPH_HOME="${RALPH_HOME:-$HOME/.ralph}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BOARD="$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)/board"
TTL_MIN="${RALPH_LOCK_TTL_MIN:-120}"

command -v herdr >/dev/null 2>&1 \
  || { echo "tick-herdr: herdr not on PATH (https://herdr.dev) — tick.sh is the headless transport" >&2; exit 3; }
[ -x "$BOARD" ] \
  || { echo "tick-herdr: $BOARD not executable — not a ralph checkout? (copy-and-own: point BOARD at your board CLI)" >&2; exit 3; }

mkdir -p "$RALPH_HOME/logs"

# --- Autopilot opt-in: typed, fail-closed, TWO keys (see header). The shared
# work-lane key first (tick.sh parity), then this transport's own key — a
# pane-persistence tick is a different hazard class than a kill-on-timeout
# tick, so it gets its own deliberate arming.
if ! grep -q '^autopilot=true$' "$RALPH_HOME/config" 2>/dev/null; then
  echo "tick-herdr: autopilot not enabled — write 'autopilot=true' to $RALPH_HOME/config" >&2
  exit 3
fi
if ! grep -q '^herdr_autopilot=true$' "$RALPH_HOME/config" 2>/dev/null; then
  echo "tick-herdr: herdr transport not armed — write 'herdr_autopilot=true' to $RALPH_HOME/config (distinct from tick.sh's key: the pane outlives the tick, and the 2026-08-11 server-restart TTL probe returned NO-GO for unattended arming — a restart restores pane topology but kills the process in every pane, stranding one claim per in-flight issue for up to the TTL behind a restored-but-idle pane; see this script's header and the probe doc §3)" >&2
  exit 3
fi

# --- Billing guard (tick.sh parity). One herdr-specific caveat: the pane runs
# with the herdr SERVER's env, not this script's — this guard proves the
# scheduler env is clean, not the server's. Verify the server was started
# key-free too (design doc §6, finding 8); panes inherit its env for life.
if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "${RALPH_ALLOW_API_BILLING:-}" != "true" ]; then
  echo "tick-herdr: ANTHROPIC_API_KEY is set — refusing to spawn (would bill API credits, not the subscription)." >&2
  echo "tick-herdr: unset it for OAuth/subscription billing, or set RALPH_ALLOW_API_BILLING=true deliberately." >&2
  exit 3
fi

# --- One tick at a time per machine — same lock, same file as tick.sh, so the
# two transports also serialize against each other. The full rationale (flock
# vs noclobber pidfile, compare-and-delete takeover, the residual window the
# per-issue claim guard backstops) lives in tick.sh; kept terse here.
LOCK="$RALPH_HOME/tick.pid"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  if ! flock -n 9; then
    echo "tick-herdr: previous tick still running (flock held) — skipping" >&2
    exit 0
  fi
else
  take_lock() { ( set -o noclobber; echo $$ > "$LOCK" ) 2>/dev/null; }
  if ! take_lock; then
    HOLDER_PID=$(cat "$LOCK" 2>/dev/null || echo "")
    if [ -n "$HOLDER_PID" ] && kill -0 "$HOLDER_PID" 2>/dev/null; then
      echo "tick-herdr: previous tick (pid $HOLDER_PID) still running — skipping" >&2
      exit 0
    fi
    if [ "$(cat "$LOCK" 2>/dev/null)" = "$HOLDER_PID" ]; then
      rm -f "$LOCK"   # compare-and-delete: still the stale pid we judged dead
    fi
    take_lock || { echo "tick-herdr: lock race — skipping" >&2; exit 0; }
  fi
  [ "$(cat "$LOCK" 2>/dev/null)" = "$$" ] || { echo "tick-herdr: lock race — skipping" >&2; exit 0; }
  trap 'rm -f "$LOCK"' EXIT
fi

date +%s > "$RALPH_HOME/heartbeat"

# --- Queue check before creating anything (cheap idle) ----------------------
NEXT=$("$BOARD" next --json | jq -r '.next.number // empty')
if [ -z "$NEXT" ]; then
  echo "$(date -u +%FT%TZ) idle" >> "$RALPH_HOME/ticks.log"
  exit 0
fi

# --- Worktree as a herdr workspace. ALWAYS fetch + --base origin/main: left
# to itself herdr branches from the parent checkout's HEAD (design doc §6,
# finding 3). The fresh base only holds for brand-new branches: an existing
# feature/GH-N branch is silently checked out as-is (--base ignored) — resumed
# possibly behind origin/main, and the session is expected to rebase. Create
# refuses only when the CHECKOUT already exists (e.g. a prior tick's) — reopen
# it instead; never branch twice, never --force.
git -C "$REPO_ROOT" fetch -q origin main
if ! OUT=$(herdr worktree create --cwd "$REPO_ROOT" --branch "feature/GH-$NEXT" --base origin/main --no-focus 2>&1); then
  OUT=$(herdr worktree open --cwd "$REPO_ROOT" --branch "feature/GH-$NEXT" --no-focus 2>&1) \
    || { echo "tick-herdr: worktree create refused and open fallback failed for feature/GH-$NEXT:" >&2; echo "$OUT" >&2; exit 1; }
fi

# IDs are opaque, server-local tokens — captured from the response, never
# predicted or pattern-matched (design doc §6, finding 4).
PANE=$(jq -r '.result.root_pane.pane_id // empty' <<<"$OUT")
[ -n "$PANE" ] || { echo "tick-herdr: no pane id in worktree response:" >&2; echo "$OUT" >&2; exit 1; }

LOG="$RALPH_HOME/logs/gh-$NEXT.log"
START=$(date -u +%FT%TZ)
START_EPOCH=$(date +%s)
STATUS=ok
WAIT_MS=$(( TTL_MIN * 60 * 1000 ))

# The pane inherits the herdr server's env — an export here would NOT reach
# the session, so the session claims as the server env's holder (board.ts
# default: user@hostname). Compute that same value for the release-if-still-
# held tail. Honest residual: that default is the MACHINE identity, not this
# session's — any same-machine session under the default holder (a human
# working the issue in another terminal, say) matches too, so the check
# proves "claimed by this machine's default identity", not "claimed by this
# tick's pane". tick.sh can export a distinct tick@host holder into its
# child; this transport cannot inject env into the pane, so the identity
# proof is genuinely weaker. If the server env overrides RALPH_CLAIM_HOLDER
# to something else, the check degrades safely to leaving the claim to TTL.
EXPECTED_HOLDER="${RALPH_CLAIM_HOLDER:-$(id -un)@$(hostname)}"

# --- Spawn: the agent in the worktree's root pane. Two different refusals
# hide behind one command. A TAKEN NAME means something live is already
# working this issue — die loudly, never improvise suffixes, never trample
# (design doc §6, finding 5). agent_pane_busy on a pane herdr JUST created
# means only that its shell has not reached its prompt yet (rc files, prompt
# frameworks, version managers) — observed live: the identical call succeeds
# seconds later. Retry that one code; anything else is real.
START_TRIES="${RALPH_HERDR_START_TRIES:-15}"
case "$START_TRIES" in '' | *[!0-9]* | 0)
  echo "tick-herdr: RALPH_HERDR_START_TRIES must be a positive integer (got '$START_TRIES')" >&2
  exit 1
;; esac
START_N=0
while :; do
  START_ERR=$(mktemp)
  if herdr agent start "gh-$NEXT" --kind claude --pane "$PANE" >>"$LOG" 2>"$START_ERR"; then
    rm -f "$START_ERR"; break
  fi
  START_CODE=$(jq -r '.error.code // empty' "$START_ERR" 2>/dev/null || true)
  cat "$START_ERR" >>"$LOG" 2>/dev/null || true
  rm -f "$START_ERR"
  START_N=$((START_N + 1))
  if [ "$START_CODE" != "agent_pane_busy" ] || [ "$START_N" -ge "$START_TRIES" ]; then
    echo "tick-herdr: agent start gh-$NEXT refused (${START_CODE:-unknown}) — see $LOG" >&2
    exit 1
  fi
  sleep 1
done

# --- Prompt, waiting BOUNDED AT THE CLAIM TTL (see header). `--wait` already
# waits until done|idle|blocked by default (never repeat defaults as flags):
# done|idle = the session settled; blocked = herdr detected an
# approval/question UI (screen-detected — a hint, never a gate input). Non-zero exit is NOT synonymous
# with timeout: the CLI exits 1 for deadline expiry, transport/server
# failures, agent_prompt_stalled, and a dead agent alike, emitting a JSON
# error (with .error.code) on stderr. Only a real "timeout" earns the
# timeout path (wrap-up + release-≈-TTL); every other failure leaves the
# claim to the TTL — a transport hiccup proves nothing about the session.
RC=0
ERR_TMP=$(mktemp)
herdr agent prompt "gh-$NEXT" "/ralph:work $NEXT" \
  --wait --timeout "$WAIT_MS" \
  >>"$LOG" 2>"$ERR_TMP" || RC=$?
ERR_CODE=$(jq -r '.error.code // empty' "$ERR_TMP" 2>/dev/null || true)
cat "$ERR_TMP" >>"$LOG" 2>/dev/null || true
rm -f "$ERR_TMP"

# agent get is JSON-native (no --json flag).
AGENT_STATE=$(herdr agent get "gh-$NEXT" 2>/dev/null | jq -r '.result.agent.agent_status // "unknown"' 2>/dev/null || true)
[ -n "$AGENT_STATE" ] || AGENT_STATE=unknown
ELAPSED_MIN=$(( ( $(date +%s) - START_EPOCH ) / 60 ))

if [ "$RC" -ne 0 ]; then
  if [ "$ERR_CODE" = "timeout" ]; then
    STATUS=timeout
  else
    STATUS="prompt-failed(${ERR_CODE:-rc=$RC})"
    echo "tick-herdr: agent prompt failed (${ERR_CODE:-rc=$RC}) after ${ELAPSED_MIN}m — not a timeout; leaving claim to TTL, pane $PANE untouched" >>"$LOG"
  fi
elif [ "$AGENT_STATE" = "blocked" ]; then
  STATUS=blocked
fi

# --- Countermeasure (a): the pane is never killed. On TIMEOUT, ONE wrap-up
# prompt asks the session to stop cleanly — but only when the screen is not
# blocked: `agent prompt` submits text plus an encoded Enter atomically, and
# at an approval/question UI that Enter could select the highlighted option,
# auto-answering the very dialog that needed a human (the docs' blocked
# recipe uses agent read + send-keys, never prompt). On BLOCKED, notify only:
# the human answers in the pane, the claim stays put (TTL is the backstop).
# Fire-and-forget (no --wait) — this tick is done waiting either way.
if [ "$STATUS" = "timeout" ]; then
  if [ "$AGENT_STATE" != "blocked" ]; then
    herdr agent prompt "gh-$NEXT" \
      "This tick's bounded wait timed out after ${ELAPSED_MIN}m (claim TTL ${TTL_MIN}m). Wrap up now: commit WIP to feature/GH-$NEXT, push, and note where you stopped on issue #$NEXT — this tick releases the claim itself. Then stop." \
      >>"$LOG" 2>&1 || true
    NOTIFY_BODY="pane $PANE still live in $(basename "$REPO_ROOT") — wrap-up prompt sent; claim released below only if still this tick's"
  else
    NOTIFY_BODY="pane $PANE blocked on an approval/question UI in $(basename "$REPO_ROOT") — answer it in the pane; no wrap-up prompt sent (its Enter could answer the dialog)"
  fi
  herdr notification show "ralph: gh-$NEXT timeout" \
    --body "$NOTIFY_BODY" \
    --sound request >>"$LOG" 2>&1 || true
elif [ "$STATUS" = "blocked" ]; then
  herdr notification show "ralph: gh-$NEXT blocked" \
    --body "pane $PANE waiting on an approval/question UI in $(basename "$REPO_ROOT") after ${ELAPSED_MIN}m — answer it in the pane; claim left to the live session (TTL is the backstop)" \
    --sound request >>"$LOG" 2>&1 || true
fi

# --- tick.sh-parity tail, TIMEOUT ONLY: exit codes and status chips lie in
# both directions — the board is the truth. Release only on the TTL-bounded
# timeout path (releasing there ≈ TTL expiry), and only a claim whose holder
# matches (see the EXPECTED_HOLDER caveat above). Blocked never releases:
# it is a screen-detected hint, never a gate input — stripping a live,
# healthy session's claim minutes into a permission prompt would re-serve
# the issue to a fresh claimant while the pane resumes on the human's
# answer, the exact double-work the claim protocol exists to prevent. A
# failed state query logs and leaves the claim to TTL, never masking the
# non-ok outcome with a query hiccup.
if [ "$STATUS" = "timeout" ]; then
  NOTE="tick-herdr timeout after ${ELAPSED_MIN}m (bounded at claim TTL ${TTL_MIN}m) — pane $PANE stays live on $(hostname -s); transcript in herdr, tick log $LOG"
  if AFTER_JSON=$("$BOARD" get "$NEXT" --json 2>>"$LOG"); then
    # ClaimV2: .claim.holders is an ARRAY (a single holder is a one-element
    # array) — release only when the expected holder is a member.
    B_HOLDER_OK=$(printf '%s' "$AFTER_JSON" | jq -r --arg h "$EXPECTED_HOLDER" \
      '(.claim.holders // []) | index($h) != null' 2>/dev/null || echo false)
    B_STATE=$(printf '%s' "$AFTER_JSON" | jq -r '.state // empty' 2>/dev/null || true)
    if [ "$B_HOLDER_OK" = "true" ] && [ "$B_STATE" = "In Progress" ]; then
      "$BOARD" release "$NEXT" -m "$NOTE" >>"$LOG" 2>&1 || true
    fi
  else
    echo "tick-herdr: board get $NEXT failed after timeout — leaving claim to TTL" >>"$LOG"
  fi
fi

# The other direction of the lie: a session can settle done having touched
# nothing. A tick that left the issue unclaimed in Backlog was a no-op — loud
# in ticks.log; repeated no-ops mean the pane session isn't picking up the
# work skill (read the pane transcript, not this log).
if [ "$STATUS" = "ok" ]; then
  if AFTER_STATE=$("$BOARD" get "$NEXT" --json 2>>"$LOG" | jq -r '.state // "unknown"' 2>>"$LOG"); then
    [ "$AFTER_STATE" = "Backlog" ] && STATUS="no-op (agent settled but board untouched — read pane $PANE)"
  else
    STATUS="unknown (agent settled; final board read failed — read pane $PANE)"
  fi
fi

# Deliberately NO worktree/workspace removal here — see the header. The
# finished pane holds the transcript; persistence is the feature.
echo "$START GH-$NEXT $STATUS pane=$PANE" >> "$RALPH_HOME/ticks.log"
