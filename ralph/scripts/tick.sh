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
# board sits beside this script — resolve it that way, not off REPO_ROOT, so the
# tick works when the plugin is installed outside the ralph-hero checkout.
BOARD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/board"
TIMEOUT_MIN="${RALPH_TICK_TIMEOUT_MIN:-45}"

# --- Driver model (GH-2350) ---------------------------------------------------
# The same knob the cockpit's spawn paths read (roles.sh ralph_lane_model),
# restated here because this runner is installed without the herdr plugin:
# RALPH_MODEL_DRIVER > .ralph.json models.driver > .claude/settings.json
# env.RALPH_MODEL_DRIVER > sonnet, the default this runner always had.
# A file that cannot be read is a usage error, never an empty answer: a
# malformed or EMPTY file (jq -n + input errors on it; a plain filter runs
# zero times and prints nothing) or a non-string value must not fall through
# to sonnet. RALPH_TICK_RUNNER replaces the whole command and never sees
# MODEL, so under it the knob is neither read nor validated — a custom
# transport keeps working over a models block it does not use (PR #2374 P2).
MODEL=""
if [ -z "${RALPH_TICK_RUNNER:-}" ]; then
  MODEL="${RALPH_MODEL_DRIVER:-}"
  if [ -z "$MODEL" ] && [ -f "$REPO_ROOT/.ralph.json" ]; then
    MODEL=$(jq -rn 'input | if type != "object" then error("expected a JSON object at the top level") else . end
        | .models as $m | if $m == null then empty
        elif ($m | type) != "object" then error("models must be an object")
        elif $m.driver == null then empty
        elif ($m.driver | type) != "string" then error("models.driver must be a string")
        else $m.driver end' "$REPO_ROOT/.ralph.json" 2>&1) || {
      echo "tick: cannot read $REPO_ROOT/.ralph.json models.driver — $MODEL" >&2; exit 64; }
  fi
  if [ -z "$MODEL" ] && [ -f "$REPO_ROOT/.claude/settings.json" ]; then
    MODEL=$(jq -rn 'input | if type != "object" then error("expected a JSON object at the top level") else . end
        | .env as $e | if $e == null then empty
        elif ($e | type) != "object" then error("env must be an object")
        elif $e.RALPH_MODEL_DRIVER == null then empty
        elif ($e.RALPH_MODEL_DRIVER | type) != "string" then error("env.RALPH_MODEL_DRIVER must be a string")
        else $e.RALPH_MODEL_DRIVER end' "$REPO_ROOT/.claude/settings.json" 2>&1) || {
      echo "tick: cannot read $REPO_ROOT/.claude/settings.json env.RALPH_MODEL_DRIVER — $MODEL" >&2; exit 64; }
  fi
  [ -n "$MODEL" ] || MODEL=sonnet
  # Shape only — one argv word; the harness owns whether the model exists.
  # No length ceiling: a Vertex id carries `@` and a Bedrock application
  # inference-profile ARN carries `/` and `:` and runs past 80 chars
  # (mirrors roles.sh ralph_lane_model — GH-2375).
  # Control bytes (ESC, CR, ...) refused too — not shell metacharacters, but
  # printing the model unescaped could forge terminal output (GH-2375 review).
  _rest=""
  case "$MODEL" in [A-Za-z0-9]*) ;; *) _rest="x" ;; esac
  if [ -z "$_rest" ]; then
    case "$MODEL" in *[[:cntrl:]]*) _rest="x" ;; esac
  fi
  if [ -z "$_rest" ]; then
    for _c in ' ' $'\t' $'\n' ';' '|' '&' '<' '>' '$' '`' "'" '"' '(' ')'; do
      case "$MODEL" in *"$_c"*) _rest="x"; break ;; esac
    done
  fi
  if [ -n "$_rest" ]; then
    echo "tick: driver model '$MODEL' is not a model name (must start with a letter or digit, no whitespace, control characters or shell metacharacters: ; | & < > \$ \` ' \" ( ))" >&2
    exit 64
  fi
fi
RUNNER="${RALPH_TICK_RUNNER:-claude -p --model $MODEL --permission-mode acceptEdits}"

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

# --- One tick at a time per machine ------------------------------------------
# Preferred: flock (Linux, or brew coreutils on macOS) — a real atomic lock
# with stale-owner recovery for free (the fd dies with the process).
# Fallback (stock macOS has no flock): noclobber pidfile. O_EXCL create+write
# is one atomic op, takeover of a dead holder is compare-and-delete (re-read
# immediately before rm; only remove if the content is still the stale pid we
# judged dead — a contender that suspended across another taker's acquisition
# sees a changed pid and backs off), and a read-back verify guards the tail.
# A microsecond cat→rm window remains; the per-issue claim guard in board.ts
# is the mutual-exclusion backstop that makes any residual overlap refuse
# per-item rather than double-work.
LOCK="$RALPH_HOME/tick.pid"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  if ! flock -n 9; then
    echo "tick: previous tick still running (flock held) — skipping" >&2
    exit 0
  fi
else
  take_lock() { ( set -o noclobber; echo $$ > "$LOCK" ) 2>/dev/null; }
  if ! take_lock; then
    HOLDER_PID=$(cat "$LOCK" 2>/dev/null || echo "")
    if [ -n "$HOLDER_PID" ] && kill -0 "$HOLDER_PID" 2>/dev/null; then
      echo "tick: previous tick (pid $HOLDER_PID) still running — skipping" >&2
      exit 0
    fi
    if [ "$(cat "$LOCK" 2>/dev/null)" = "$HOLDER_PID" ]; then
      rm -f "$LOCK"   # compare-and-delete: still the stale pid we judged dead
    fi
    take_lock || { echo "tick: lock race — skipping" >&2; exit 0; }
  fi
  [ "$(cat "$LOCK" 2>/dev/null)" = "$$" ] || { echo "tick: lock race — skipping" >&2; exit 0; }
  trap 'rm -f "$LOCK"' EXIT
fi

date +%s > "$RALPH_HOME/heartbeat"

# --- Queue check before spawning anything (cheap idle) ----------------------
NEXT=$("$BOARD" next --json | jq -r '.next.number // empty')
if [ -z "$NEXT" ]; then
  echo "$(date -u +%FT%TZ) idle" >> "$RALPH_HOME/ticks.log"
  exit 0
fi

# --- Names: derived by the CLI, never re-implemented here (GH-1807) ---------
# The grammar lives in contracts.ts. A shell that rebuilt slugify in sed would
# be a second grammar, and two grammars drift.
NAMES=$("$BOARD" name "$NEXT" --json) || {
  echo "tick: \`board name $NEXT\` failed — cannot derive the branch" >&2; exit 1; }
BRANCH=$(printf '%s' "$NAMES" | jq -r '.branch // empty')
LEGACY_BRANCH=$(printf '%s' "$NAMES" | jq -r '.legacyBranch // empty')
WT_LEAF=$(printf '%s' "$NAMES" | jq -r '.worktree // empty')
if [ -z "$BRANCH" ] || [ -z "$WT_LEAF" ]; then
  echo "tick: \`board name $NEXT\` returned no branch/worktree" >&2; exit 1
fi

# --- Worktree per job: never a shared HEAD ----------------------------------
# Resume beats re-cut, and the legacy layout is a first-class resume target: a
# unit that already has a feature/GH-N worktree or branch keeps it, or one
# unit's work splits across two heads. Git is touched only when there is no
# checkout to resume — an existing worktree needs no decision at all.
branch_exists() {
  git -C "$REPO_ROOT" show-ref -q --verify "refs/heads/$1" \
    || git -C "$REPO_ROOT" show-ref -q --verify "refs/remotes/origin/$1"
}
WT="$REPO_ROOT/.claude/worktrees/$WT_LEAF"
LEGACY_WT="$REPO_ROOT/.claude/worktrees/GH-$NEXT"
if [ ! -d "$WT" ] && [ -d "$LEGACY_WT" ]; then
  WT="$LEGACY_WT"
  BRANCH="$LEGACY_BRANCH"
elif [ ! -d "$WT" ]; then
  git -C "$REPO_ROOT" fetch -q origin main
  if ! branch_exists "$BRANCH" && branch_exists "$LEGACY_BRANCH"; then
    BRANCH="$LEGACY_BRANCH"
    WT="$LEGACY_WT"
  fi
  git -C "$REPO_ROOT" worktree add -q -b "$BRANCH" "$WT" origin/main 2>/dev/null \
    || git -C "$REPO_ROOT" worktree add -q "$WT" "$BRANCH"
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
# $RUNNER is word-split on purpose (RALPH_TICK_RUNNER is a command line), but
# never glob-expanded: a model such as claude-haiku-4-5[1m] is a bracket
# expression to the shell, and a stray file in the worktree would rewrite
# the argv (PR #2374 P2). set -f inside the subshell keeps it literal.
(cd "$WT" && set -f && run_with_timeout $RUNNER "/ralph:work $NEXT") >> "$LOG" 2>&1 || RC=$?

# Exit codes lie in both directions — the board is the truth. Any non-zero
# exit means the session is gone, so decide the claim by board state, not by
# which failure code the runner picked: if this machine still holds the claim
# and the issue sits In Progress, release now rather than pinning it until
# the TTL (default 120 min). A failed state query logs and leaves the claim
# to TTL — never mask the runner's failure with a query hiccup.
if [ "$RC" -ne 0 ]; then
  STATUS="exit=$RC"
  if [ "$RC" -eq 124 ]; then
    STATUS=timeout
    NOTE="tick timeout after ${TIMEOUT_MIN}m — see $LOG on $(hostname -s); work may be partially committed on $BRANCH"
  else
    NOTE="tick runner exited RC=$RC — see $LOG on $(hostname -s); work may be partially committed on $BRANCH"
  fi
  if AFTER_JSON=$("$BOARD" get "$NEXT" --json 2>>"$LOG"); then
    # ClaimV2: .claim.holders is an ARRAY (a single holder is a one-element
    # array) — release only when THIS holder is a member, not on string match.
    HOLDER_OK=$(printf '%s' "$AFTER_JSON" | jq -r --arg h "$RALPH_CLAIM_HOLDER" \
      '(.claim.holders // []) | index($h) != null' 2>/dev/null || echo false)
    STATE=$(printf '%s' "$AFTER_JSON" | jq -r '.state // empty' 2>/dev/null || true)
    if [ "$HOLDER_OK" = "true" ] && [ "$STATE" = "In Progress" ]; then
      "$BOARD" release "$NEXT" -m "$NOTE" >> "$LOG" 2>&1 || true
    fi
  else
    echo "tick: board get $NEXT failed after RC=$RC — leaving claim to TTL" >> "$LOG"
  fi
fi

# The other direction of the lie: a session that does nothing still exits 0.
# A tick that left the issue unclaimed in Backlog was a no-op: loud in
# ticks.log, and repeated no-ops mean the runner is misconfigured.
if [ "$STATUS" = "ok" ]; then
  AFTER_STATE=$("$BOARD" get "$NEXT" --json 2>/dev/null | jq -r '.state // "unknown"')
  [ "$AFTER_STATE" = "Backlog" ] && STATUS="no-op (runner ran but board untouched — check RALPH_TICK_RUNNER)"
fi

# Clean worktree gets removed; a dirty one stays for the next tick/human.
if [ -z "$(git -C "$WT" status --porcelain 2>/dev/null)" ]; then
  git -C "$REPO_ROOT" worktree remove "$WT" 2>/dev/null || true
fi

echo "$START GH-$NEXT $STATUS" >> "$RALPH_HOME/ticks.log"
