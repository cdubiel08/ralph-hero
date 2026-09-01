#!/usr/bin/env bash
# probe-claim-ttl.sh — the claim-TTL vs pane-persistence probe (design doc §5).
#
# QUESTION UNDER TEST: when a herdr server restarts (lid close, crash, update),
# what actually survives — workspaces? panes? the PROCESSES inside panes?
# in-flight `pane wait-output` clients? — and how long does restore take?
# The answer gates unattended arming (work-fleet --refill default on,
# tick-herdr autopilot without the second typed key): a claim whose TTL
# outlives a dead session is a stall; a session that outlives its claim is
# double-work. Verdict recorded in
# thoughts/shared/research/2026-08-11-claim-ttl-pane-persistence-probe.md.
#
# WHAT IT DOES (all inside an ISOLATED named session, default "ralph-probe"):
#   1. starts a headless server for the named session
#      (`herdr --session <name> server`, backgrounded; clients scope with the
#      same global flag — verified: `--session` routes to that session's
#      socket, `~/.config/herdr/sessions/<name>/herdr.sock`)
#   2. creates a workspace + pane, runs a plain-shell heartbeat marker in the
#      pane (NO coding agents — nothing here can bill)
#   3. writes a fake ClaimV2-shaped claim file + a C7-flavored spawn record to
#      a TEMP ledger (RALPH_HERDR_LEDGER override — never ~/.ralph)
#   4. experiment B arm: launches `pane wait-output --timeout` in the
#      background so a wait is in flight across the restart
#   5. experiment A: scoped `server stop` → observe marker survival while the
#      server is down → restart → observe workspace/pane/process/claim state
#   6. experiment C: millisecond timings for stop, restart, snapshot-ready
#   7. resolves the waiter: clean error, ran-to-timeout, or hard hang (killed)
#
# EXPERIMENT D — `--with-agent` (GH-1809, opt-in, NOT part of the default run):
#   The one question the original probe could not answer without billing:
#   `[session] resume_agents_on_restore` (default on) claims to re-launch
#   supported integrations into their native conversation sessions. Does a
#   restored agent pane hold a WORKER (in-flight work continues) or a
#   TRANSCRIPT (a relaunched CLI idling at a prompt with history)? The claim
#   -release design turns on the answer: releasing a claim under a genuinely
#   resuming worker would be the double-work hazard, not the cure.
#
#   With the flag, the probe adds a second pane running a REAL `claude` agent,
#   sends ONE trivial prompt so there is a conversation to resume, and after
#   the restart records: the pane's shell_pid before/after, the foreground
#   process list, whether the agent is still registered, whether the transcript
#   came back, and whether the pane produces any output UNPROMPTED in a
#   15s observation window (the "is it working or idling?" test).
#
#   Cost: one short prompt on the operator's subscription. Refused outright
#   when ANTHROPIC_API_KEY is set (lib.sh's billing guard, same rule): that
#   key would bill API credits.
#
# SAFETY (absolute):
#   - NEVER touches the default session: every mutating call goes through
#     probe_herdr() which injects `--session "$SESSION"`; a bare `server stop`
#     does not appear in this file; the session name must start with "ralph-"
#     and must not be "default".
#   - that postcondition does NOT rest on trusting `--session`: step 1b PROVES
#     the isolation before the first mutating call (own row, `running`, own
#     socket under sessions/<name>/) and dies if it cannot. Until that proof
#     lands, no scoped `server stop` is issued — teardown is by-name only, so
#     a herdr that accepted-but-ignored the flag can never be mistaken for a
#     healthy probe and can never route a stop at the operator's server.
#   - cleanup runs on EXIT/INT/TERM even on failure: kill marker + waiter +
#     background servers, scoped server stop, `session stop` + `session
#     delete` by name, temp scratch dir removed. The OUTPUT dir persists —
#     it is the probe's product, not scratch.
#   - idempotent: a leftover ralph-probe session from a crashed run is
#     stopped + deleted before starting.
#
# Usage:
#   bash plugin/ralph-herdr/scripts/probe-claim-ttl.sh [--out DIR] [--with-agent]
#
# Knobs:
#   RALPH_PROBE_SESSION   session name (default ralph-probe; must be ralph-*)
#   RALPH_PROBE_OUT       output dir (default: mktemp under $TMPDIR; kept)
#   RALPH_PROBE_WAIT_MS   waiter --timeout in ms (default 60000)
#   RALPH_PROBE_WITH_AGENT  "true" is the same opt-in as --with-agent
#
# Output dir layout: NN-step.out/.err per raw response, server-N.log,
# steps.log (rc per step), summary.json + summary.txt (the findings).
# bash 3.2 compatible. Needs jq + perl (Time::HiRes, for ms timestamps).
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION="${RALPH_PROBE_SESSION:-ralph-probe}"
WAIT_MS="${RALPH_PROBE_WAIT_MS:-60000}"
HERDR_REAL="${HERDR_BIN_PATH:-herdr}"

die() { echo "probe-claim-ttl: $*" >&2; exit 1; }

WITH_AGENT=no
[ "${RALPH_PROBE_WITH_AGENT:-}" = "true" ] && WITH_AGENT=yes
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out)
      [ "$#" -ge 2 ] || die "--out needs a directory"
      RALPH_PROBE_OUT="$2"
      shift 2
      ;;
    --with-agent)
      WITH_AGENT=yes
      shift
      ;;
    *) die "unknown argument: $1 (usage: probe-claim-ttl.sh [--out DIR] [--with-agent])" ;;
  esac
done

# ── safety gates ─────────────────────────────────────────────────────────────
case "$SESSION" in
  ralph-*) : ;;
  *) die "refusing session name '$SESSION' — probe sessions must be ralph-* (never default)" ;;
esac
[ "$SESSION" != "default" ] || die "refusing to touch the default session"
command -v "$HERDR_REAL" >/dev/null 2>&1 || die "herdr not on PATH"
command -v jq >/dev/null 2>&1 || die "jq required"
command -v perl >/dev/null 2>&1 || die "perl required (ms timestamps)"

# Experiment D starts a REAL agent. Same billing rule as lib.sh's spawn path:
# an API key in the environment bills credits rather than the subscription, and
# a probe is exactly where that would go unnoticed. No RALPH_ALLOW_API_BILLING
# override here — this experiment is never worth an argument about the bill.
if [ "$WITH_AGENT" = yes ]; then
  [ -z "${ANTHROPIC_API_KEY:-}" ] ||
    die "--with-agent refuses to run with ANTHROPIC_API_KEY set (it would bill API credits, not the subscription)"
  command -v claude >/dev/null 2>&1 || die "--with-agent needs the claude CLI on PATH"
  # Measured (run 1, 2026-08-13): launched from inside a Claude Code session,
  # the probe server inherits CLAUDE_CODE_CHILD_SESSION, the pane's claude runs
  # with "Transcript saving is off", and the restore's `claude --resume <id>`
  # then answers "No conversation found". That is an artifact of the launching
  # shell, not a property of restore — and it would be recorded as the finding.
  # Refuse instead, and name the fix.
  for _v in CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ID; do
    eval "_set=\${$_v:-}"
    [ -z "$_set" ] ||
      die "--with-agent refuses with $_v set: the pane's claude would run with transcript saving off, and restore's \`claude --resume\` would fail for that reason alone. Re-run from a clean shell, or: env -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID bash ${0##*/} --with-agent"
  done
fi

# Every herdr call is scoped to the probe session. No exceptions for mutations.
probe_herdr() { "$HERDR_REAL" --session "$SESSION" "$@"; }

now_ms() { perl -MTime::HiRes=time -e 'printf("%d\n", time*1000)'; }

# ── dirs ─────────────────────────────────────────────────────────────────────
if [ -n "${RALPH_PROBE_OUT:-}" ]; then
  OUT="$RALPH_PROBE_OUT"
  mkdir -p "$OUT" || die "cannot create out dir $OUT"
else
  OUT=$(mktemp -d "${TMPDIR:-/tmp}/ralph-claim-ttl-probe.XXXXXX") || die "mktemp out"
fi
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/ralph-claim-ttl-scratch.XXXXXX") || die "mktemp scratch"
STEPS="$OUT/steps.log"
: >"$STEPS"

# cap NAME CMD... — run a step, tee stdout/stderr to $OUT/NAME.{out,err},
# record rc in steps.log. Never aborts the probe: a failed step is a finding.
cap() {
  local name="$1" rc=0
  shift
  "$@" >"$OUT/$name.out" 2>"$OUT/$name.err" || rc=$?
  echo "$name rc=$rc :: $*" >>"$STEPS"
  return "$rc"
}

note() { printf '%s\n' "$*" | tee -a "$OUT/notes.log" >&2; }

# ── cleanup (EXIT/INT/TERM, even on failure) ─────────────────────────────────
MARKER_PID=""
WAITER_PID=""
SERVER1_PID=""
SERVER2_PID=""
# yes only after step 1b proves `--session` routed to an isolated session.
# Gates the one teardown call that is scoped-by-flag rather than by-name.
SESSION_PROVEN=no
cleanup() {
  trap - EXIT INT TERM
  # evidence first: the temp ledger + claim survive into OUT before scratch dies
  cp "$SCRATCH/ledger/ledger.jsonl" "$OUT/evidence-ledger.jsonl" 2>/dev/null || true
  cp "$SCRATCH/ledger/ledger.sqlite" "$OUT/evidence-ledger.sqlite" 2>/dev/null || true
  cp "$SCRATCH/claim.json" "$OUT/evidence-claim.json" 2>/dev/null || true
  tail -5 "$SCRATCH/marker.beat" >"$OUT/evidence-marker-beat.tail" 2>/dev/null || true
  [ -n "$WAITER_PID" ] && kill "$WAITER_PID" 2>/dev/null
  [ -n "$MARKER_PID" ] && kill "$MARKER_PID" 2>/dev/null
  # scoped stop (primary), by-name stop + delete (belt): never the default.
  # The scoped stop is the ONLY teardown call whose targeting depends on
  # `--session` being honored, so it is skipped unless step 1b proved it was
  # — otherwise it is exactly the call that would kill the operator's server.
  # By-name stop+delete below is safe either way (probe doc §4.3: idempotent).
  if [ "$SESSION_PROVEN" = yes ]; then
    probe_herdr server stop >/dev/null 2>&1
  fi
  sleep 1
  "$HERDR_REAL" session stop "$SESSION" >/dev/null 2>&1
  sleep 1
  "$HERDR_REAL" session delete "$SESSION" >/dev/null 2>&1
  [ -n "$SERVER1_PID" ] && kill "$SERVER1_PID" 2>/dev/null
  [ -n "$SERVER2_PID" ] && kill "$SERVER2_PID" 2>/dev/null
  rm -rf "$SCRATCH"
  # postcondition: the default session must still be running, untouched
  "$HERDR_REAL" session list >"$OUT/post-cleanup-session-list.txt" 2>&1 || true
  echo "probe-claim-ttl: cleanup done — output kept in $OUT" >&2
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ── step 0: preflight + idempotent pre-clean ─────────────────────────────────
cap 00-version "$HERDR_REAL" --version || true
cap 00-session-list-before "$HERDR_REAL" session list || true
if grep -q "^$SESSION " "$OUT/00-session-list-before.out" 2>/dev/null; then
  note "pre-clean: leftover $SESSION session found — stopping + deleting"
  # By-name only: nothing is proven about `--session` yet, and `session stop
  # <name>` is the correct idempotent by-name teardown anyway (probe doc §4.3).
  "$HERDR_REAL" session stop "$SESSION" >/dev/null 2>&1 || true
  sleep 1
  "$HERDR_REAL" session delete "$SESSION" >/dev/null 2>&1 || true
fi

# ── ledger-root isolation — BEFORE any server starts (GH-1900) ───────────────
# herdr fires the `[[startup]]` hook for EVERY server that starts, the probe's
# own included, and the hook is reconcile.sh — which walks every ledger under
# `ledger_root()` (reconcile.sh) while asking a herdr that has never heard of
# any of those agents. That is exactly how the 2026-08-13 run marked all five
# of the operator's running workers `lost` in one pass (predecessor probe, D8).
#
# GH-1863 and #1905 since added ownership gates that should refuse both the
# lost-sweep and the refill, but a probe that must run beside a live fleet may
# not rest its safety on a gate holding: the server inherits this environment,
# so pointing the ROOT at scratch means the hook has nothing of the operator's
# to find. `RALPH_HERDR_LEDGER` (set at step 3) is only this probe's own write
# target and never bounded the hook's walk.
export RALPH_HERDR_LEDGER_ROOT="$SCRATCH/ledger-root"
mkdir -p "$RALPH_HERDR_LEDGER_ROOT" || die "cannot create scratch ledger root"

# ── step 1: start the isolated headless server ───────────────────────────────
T_S1_EXEC=$(now_ms)
nohup "$HERDR_REAL" --session "$SESSION" server >"$OUT/server-1.log" 2>&1 &
SERVER1_PID=$!
T_S1_READY=""
i=0
while [ "$i" -lt 100 ]; do
  if probe_herdr workspace list >/dev/null 2>&1; then
    T_S1_READY=$(now_ms)
    break
  fi
  sleep 0.2
  i=$((i + 1))
done
[ -n "$T_S1_READY" ] || die "isolated server for $SESSION never became ready (see $OUT/server-1.log)"
note "server 1 ready in $((T_S1_READY - T_S1_EXEC))ms (session $SESSION)"
cap 01-session-list "$HERDR_REAL" session list || true

# ── step 1b: PROVE the isolation before any mutating call ────────────────────
# The readiness loop above is itself scoped (`--session <name> workspace
# list`), so it cannot distinguish "our isolated server answered" from "a herdr
# that accepts-but-ignores --session answered from the operator's ALREADY
# RUNNING default server" — in the latter case the backgrounded server never
# bound (socket busy) and every step below (workspace create, server stop)
# would land in the live session. So assert it out of the UNSCOPED session
# list: our name must have its own row, be running, and own a socket under
# sessions/<name>/ (the default session's socket has no such path segment).
# Fail-closed: die before the first mutation, with the row as evidence.
SESSION_ROW=$(grep "^$SESSION  *" "$OUT/01-session-list.out" 2>/dev/null | head -1)
[ -n "$SESSION_ROW" ] ||
  die "session '$SESSION' has no row in \`session list\` even though a scoped call answered — refusing to mutate (a herdr that ignores --session would answer from the default server). See $OUT/01-session-list.out"
case "$SESSION_ROW" in
  *" running "*) : ;;
  *) die "session '$SESSION' is not running but a scoped call answered — refusing to mutate. Row: $SESSION_ROW" ;;
esac
case "$SESSION_ROW" in
  *"sessions/$SESSION/"*) : ;;
  *) die "session '$SESSION' does not own a socket under sessions/$SESSION/ — refusing to mutate (scoped calls may be routing to the default server). Row: $SESSION_ROW" ;;
esac
SESSION_PROVEN=yes
note "isolation proven: $SESSION has its own running server + socket (scoped teardown enabled)"

# ── step 2: workspace + pane + plain-shell marker process ────────────────────
cap 02-workspace-create probe_herdr workspace create --cwd "$SCRATCH" --no-focus ||
  die "workspace create failed: $(cat "$OUT/02-workspace-create.err")"
WS=$(jq -r '.result.workspace.workspace_id // .result.workspace.id // empty' "$OUT/02-workspace-create.out")
PANE=$(jq -r '.result.root_pane.pane_id // .result.root_pane.id // empty' "$OUT/02-workspace-create.out")
[ -n "$WS" ] && [ -n "$PANE" ] || die "could not parse workspace/pane ids from 02-workspace-create.out"
note "workspace $WS root pane $PANE"

cat >"$SCRATCH/marker.sh" <<EOF
#!/bin/sh
echo "MARKER_START pid=\$\$"
echo "\$\$" >"$SCRATCH/marker.pid"
while :; do
  date +%s >>"$SCRATCH/marker.beat"
  sleep 1
done
EOF
chmod +x "$SCRATCH/marker.sh"
cap 03-pane-run probe_herdr pane run "$PANE" "$SCRATCH/marker.sh" || true
i=0
while [ ! -s "$SCRATCH/marker.pid" ] && [ "$i" -lt 50 ]; do
  sleep 0.2
  i=$((i + 1))
done
[ -s "$SCRATCH/marker.pid" ] || die "marker never started (see $OUT/03-pane-run.err)"
MARKER_PID=$(cat "$SCRATCH/marker.pid")
note "marker process pid=$MARKER_PID beating in $SCRATCH/marker.beat"
# NB (probe finding): herdr 0.8.0's printed usage says `pane read [OPTIONS]
# <PANE_ID>` but the parser rejects value-options before the positional
# ("unknown option: 20") — PANE_ID must come FIRST for read/wait-output.
cap 04-process-info-before probe_herdr pane process-info --pane "$PANE" || true
cap 05-pane-read-before probe_herdr pane read "$PANE" --lines 20 || true

# ── step 3: fake claim + C7-flavored spawn record on a TEMP ledger ───────────
mkdir -p "$SCRATCH/ledger"
export RALPH_HERDR_LEDGER="$SCRATCH/ledger/ledger.jsonl"
# shellcheck source=ledger.sh
. "$SCRIPT_DIR/ledger.sh"
TS=$(date -u +%FT%TZ)
AGENT_REF="work-9999#probe1"
ralph_ledger_append "$(jq -nc --arg ts "$TS" --arg ref "$AGENT_REF" --arg pane "$PANE" '
  {ts: $ts, ev: "spawn", agent_ref: $ref, pane_id: $pane,
   lineage: {contract: "ralph.lineage", contract_version: 1, agent_ref: $ref,
             issue: 9999, spawner: {script: "probe-claim-ttl.sh", invoked_by: "human"},
             herdr: {worktree_branch: "probe/none", pane_id: $pane},
             plane: "herdr", spawned_at: $ts},
   tokens: {role: "work", issue: "9999", root: $ref, depth: "0",
            state: "spawned", branch: "probe/none", harness: "none",
            spawn_epoch: "probe1"}}')" || note "ledger append FAILED (finding)"
jq -nc --arg ts "$TS" --arg pane "$PANE" '
  {issue: 9999, holders: ["probe-holder"], claimed_at: $ts,
   ttl_min: 120, pane_id: $pane, note: "fake claim — probe artifact"}' \
  >"$SCRATCH/claim.json"
note "temp ledger + fake claim written under $SCRATCH (never ~/.ralph)"

# ── step 3b (experiment D arm): a REAL agent pane, only with --with-agent ────
# Every field below stays "n/a" on a default run, so summary.json has one shape.
AGENT_NAME="ralph-probe-agent"
AGENT_PANE=""
AGENT_WS=""
AGENT_SHELL_PID_BEFORE=n/a
AGENT_SHELL_PID_AFTER=n/a
AGENT_FOREGROUND_BEFORE=n/a
AGENT_FOREGROUND_AFTER=n/a
AGENT_SESSION_BEFORE=n/a
AGENT_SESSION_AFTER=n/a
AGENT_REGISTERED_AFTER=n/a
AGENT_STATUS_AFTER=n/a
AGENT_ACKED=n/a
AGENT_TRANSCRIPT_AFTER=n/a
AGENT_UNPROMPTED_OUTPUT=n/a
AGENT_PID_BEFORE=""
AGENT_PROC_ALIVE_DOWN=n/a

# pi_shell_pid FILE / pi_foreground FILE — read one `pane process-info` capture.
# The foreground list is joined on argv0 because herdr reports a claude
# process's `name` as its VERSION string ("2.1.229"), not "claude" — matching
# on .name would find no harness where one is plainly running.
pi_shell_pid() { jq -r '.result.process_info.shell_pid // "n/a"' "$1" 2>/dev/null || echo n/a; }
pi_foreground() {
  jq -r '[.result.process_info.foreground_processes[]?.argv0] | join(",") | if . == "" then "none" else . end' \
    "$1" 2>/dev/null || echo n/a
}

if [ "$WITH_AGENT" = yes ]; then
  note "experiment D: starting a REAL claude agent (one prompt, subscription billing)"
  cap 20-agent-workspace-create probe_herdr workspace create --cwd "$SCRATCH" --no-focus ||
    die "experiment D: workspace create failed: $(cat "$OUT/20-agent-workspace-create.err")"
  AGENT_WS=$(jq -r '.result.workspace.workspace_id // .result.workspace.id // empty' "$OUT/20-agent-workspace-create.out")
  AGENT_PANE=$(jq -r '.result.root_pane.pane_id // .result.root_pane.id // empty' "$OUT/20-agent-workspace-create.out")
  [ -n "$AGENT_PANE" ] || die "experiment D: could not parse the agent pane id"
  note "experiment D: agent workspace $AGENT_WS pane $AGENT_PANE"

  # `agent start` needs the pane's shell at its prompt (lib.sh documents the
  # same race); retry a few times rather than racing rc-file sourcing.
  i=0
  while [ "$i" -lt 15 ]; do
    cap 21-agent-start probe_herdr agent start "$AGENT_NAME" --kind claude --pane "$AGENT_PANE" && break
    sleep 1
    i=$((i + 1))
  done
  grep -q '"type"' "$OUT/21-agent-start.out" 2>/dev/null ||
    die "experiment D: agent start never succeeded: $(cat "$OUT/21-agent-start.err")"

  # Wait for a REGISTERED agent_session before prompting. `interactive_ready`
  # goes true at revision 0, before the CLI has a conversation id — prompting
  # then submits into a still-booting TUI and the text lands nowhere (run 1:
  # `agent prompt --wait` returned `timeout`, and the pane held an empty
  # prompt). The session id is the thing restore will try to resume, so it is
  # also the honest readiness signal.
  i=0
  while [ "$i" -lt 90 ]; do
    cap 22-agent-list-before probe_herdr agent list || true
    AGENT_SESSION_BEFORE=$(jq -r --arg n "$AGENT_NAME" \
      '[.result.agents[]? | select(.name == $n) | .agent_session.value] | first // "n/a"' \
      "$OUT/22-agent-list-before.out" 2>/dev/null || echo n/a)
    [ "$AGENT_SESSION_BEFORE" != "n/a" ] && break
    sleep 1
    i=$((i + 1))
  done

  # ONE trivial prompt — the cheapest exchange that still creates a real
  # conversation for `resume_agents_on_restore` to have something to resume.
  # No --wait: the ack in the pane is the proof, and it does not depend on how
  # herdr models a status transition.
  cap 23-agent-prompt probe_herdr agent prompt "$AGENT_NAME" \
    'Reply with exactly PROBE_ACK_OK and nothing else. Do not use any tools.' || true
  if probe_herdr pane wait-output "$AGENT_PANE" --match PROBE_ACK_OK --timeout 180000 \
    >"$OUT/24-agent-ack.out" 2>"$OUT/24-agent-ack.err"; then
    AGENT_ACKED=yes
  else
    AGENT_ACKED=no
  fi
  # Let the CLI flush the turn to its transcript before the server is stopped:
  # an unwritten conversation is not resumable, and that would look like a
  # restore finding instead of a race in the probe.
  sleep 5
  note "experiment D: agent answered the prompt: $AGENT_ACKED (session ${AGENT_SESSION_BEFORE})"

  # `pane read` defaults to the `recent` source — scrollback, not the screen.
  # A TUI that is waiting on a modal shows that modal only in `visible`, so
  # both are captured: run 2 recorded status=blocked with a bare prompt in
  # `recent`, which cannot distinguish "nothing was typed" from "a dialog is
  # covering it".
  cap 24b-agent-visible probe_herdr pane read "$AGENT_PANE" --lines 50 --source visible || true
  cap 24c-agent-read probe_herdr agent read "$AGENT_NAME" || true
  cap 25-agent-process-info-before probe_herdr pane process-info --pane "$AGENT_PANE" || true
  AGENT_SHELL_PID_BEFORE=$(pi_shell_pid "$OUT/25-agent-process-info-before.out")
  AGENT_FOREGROUND_BEFORE=$(pi_foreground "$OUT/25-agent-process-info-before.out")
  AGENT_PID_BEFORE=$(jq -r '[.result.process_info.foreground_processes[]? | select(.argv0 == "claude") | .pid] | first // empty' \
    "$OUT/25-agent-process-info-before.out" 2>/dev/null || echo "")
  cap 26-agent-pane-read-before probe_herdr pane read "$AGENT_PANE" --lines 40 || true
  note "experiment D: agent pane shell_pid=$AGENT_SHELL_PID_BEFORE foreground=[$AGENT_FOREGROUND_BEFORE] claude pid=${AGENT_PID_BEFORE:-none}"
fi

# ── step 4 (experiment B arm): in-flight wait-output across the restart ──────
(
  echo "start_ms=$(now_ms)" >"$OUT/06-waiter.meta"
  rc=0
  probe_herdr pane wait-output "$PANE" --match PROBE_NEVER_MATCHES \
    --timeout "$WAIT_MS" >"$OUT/06-waiter.out" 2>"$OUT/06-waiter.err" || rc=$?
  {
    echo "end_ms=$(now_ms)"
    echo "rc=$rc"
  } >>"$OUT/06-waiter.meta"
) &
WAITER_PID=$!
sleep 2 # ensure the wait is genuinely in flight

# ── step 5 (experiment A): scoped stop → observe → restart → observe ─────────
BEATS_BEFORE_STOP=$(wc -l <"$SCRATCH/marker.beat" | tr -d ' ')
T_STOP_EXEC=$(now_ms)
cap 07-server-stop probe_herdr server stop || true
T_STOP_DONE=""
i=0
while [ "$i" -lt 50 ]; do
  if "$HERDR_REAL" session list 2>/dev/null | grep -q "^$SESSION  *stopped"; then
    T_STOP_DONE=$(now_ms)
    break
  fi
  sleep 0.2
  i=$((i + 1))
done
cap 08-session-list-stopped "$HERDR_REAL" session list || true

# marker survival while the server is DOWN
MARKER_ALIVE_DOWN=no
kill -0 "$MARKER_PID" 2>/dev/null && MARKER_ALIVE_DOWN=yes
if [ "$WITH_AGENT" = yes ] && [ -n "$AGENT_PID_BEFORE" ]; then
  AGENT_PROC_ALIVE_DOWN=no
  kill -0 "$AGENT_PID_BEFORE" 2>/dev/null && AGENT_PROC_ALIVE_DOWN=yes
  note "server down: the agent's claude process (pid $AGENT_PID_BEFORE) alive=$AGENT_PROC_ALIVE_DOWN"
fi
sleep 3
BEATS_DURING_STOP=$(wc -l <"$SCRATCH/marker.beat" 2>/dev/null | tr -d ' ')
BEAT_GREW_DOWN=no
[ "${BEATS_DURING_STOP:-0}" -gt "${BEATS_BEFORE_STOP:-0}" ] && BEAT_GREW_DOWN=yes
note "server down: marker alive=$MARKER_ALIVE_DOWN, heartbeat grew=$BEAT_GREW_DOWN ($BEATS_BEFORE_STOP -> ${BEATS_DURING_STOP:-0})"

# restart the isolated server — this IS "session restore" for a named session:
# a fresh `herdr --session <name> server` reloads the session's persisted state
T_S2_EXEC=$(now_ms)
nohup "$HERDR_REAL" --session "$SESSION" server >"$OUT/server-2.log" 2>&1 &
SERVER2_PID=$!
T_S2_READY=""
i=0
while [ "$i" -lt 100 ]; do
  if probe_herdr workspace list >/dev/null 2>&1; then
    T_S2_READY=$(now_ms)
    break
  fi
  sleep 0.2
  i=$((i + 1))
done
[ -n "$T_S2_READY" ] || die "restarted server for $SESSION never became ready (see $OUT/server-2.log)"
sleep 1 # let restore settle before snapshotting
# The `[[startup]]` hook's own output (GH-1900). reconcile.sh logs to stdout,
# and herdr routes a startup hook's stdout to the SESSION log — not to the
# server's console stdout (`server-2.log` holds only the banner) and not to
# `~/.config/herdr/herdr-server.log`, which contains zero `reconcile:` lines
# after a week of uptime. So phase F's decision is, in production, written
# nowhere anyone reads. Copy the session log out before teardown deletes it
# with the session; this is the only capture of what the hook decided.
# The reconcile log FIRST — it is the one that carries the decisions. It lives
# under the scratch ledger root, which cleanup removes with $SCRATCH, so a
# completed probe would otherwise discard the very record this capture exists
# for.
PROBE_RECONCILE_LOG="$RALPH_HERDR_LEDGER_ROOT/logs/reconcile.log"
if [ -f "$PROBE_RECONCILE_LOG" ]; then
  cp "$PROBE_RECONCILE_LOG" "$OUT/reconcile.log" || true
  note "startup-hook decisions captured ($(grep -c 'reconcile:' "$OUT/reconcile.log" 2>/dev/null || echo 0) lines)"
else
  note "no reconcile log at $PROBE_RECONCILE_LOG — the hook wrote no decisions (it may not have fired)"
fi

# The session log too, but only as context: it holds herdr's own restore
# tracing, and — measured — zero `reconcile:` lines, since herdr does not route
# a startup hook's stdout here. Kept because restore timing is what explains a
# slow pass, discarded as evidence of what the pass decided.
PROBE_SESSION_LOG="$HOME/.config/herdr/sessions/$SESSION/herdr-server.log"
[ -f "$PROBE_SESSION_LOG" ] && { cp "$PROBE_SESSION_LOG" "$OUT/session-server.log" || true; }

cap 09-workspace-list-after probe_herdr workspace list || true
cap 10-pane-list-after probe_herdr pane list || true
cap 11-process-info-after probe_herdr pane process-info --pane "$PANE" || true
cap 12-pane-read-after probe_herdr pane read "$PANE" --lines 40 || true
cap 13-session-list-after "$HERDR_REAL" session list || true

WS_AFTER=$(jq -r '.result.workspaces | map(.workspace_id // .id // "?") | join(",")' "$OUT/09-workspace-list-after.out" 2>/dev/null || echo parse-error)
PANE_AFTER=$(jq -r '.result.panes // .result | tostring | .[0:200]' "$OUT/10-pane-list-after.out" 2>/dev/null || echo parse-error)
MARKER_ALIVE_AFTER=no
kill -0 "$MARKER_PID" 2>/dev/null && MARKER_ALIVE_AFTER=yes
BEATS_AFTER_RESTART=$(wc -l <"$SCRATCH/marker.beat" 2>/dev/null | tr -d ' ')
sleep 3
BEATS_SETTLED=$(wc -l <"$SCRATCH/marker.beat" 2>/dev/null | tr -d ' ')
BEAT_GREW_AFTER=no
[ "${BEATS_SETTLED:-0}" -gt "${BEATS_AFTER_RESTART:-0}" ] && BEAT_GREW_AFTER=yes
note "after restart: workspaces=[$WS_AFTER] marker alive=$MARKER_ALIVE_AFTER heartbeat growing=$BEAT_GREW_AFTER"
note "pane list after (truncated): $PANE_AFTER"

# ── experiment D observations after restore ─────────────────────────────────
# The design question is not "did something come back" but "did a WORKER come
# back". Three separate readings answer it, and they can disagree:
#   shell_pid   — a DIFFERENT pid proves the pane was rebuilt, whatever now
#                 runs inside it. This is the signal reconcile keys on.
#   foreground  — whether a harness process exists in the restored pane at all.
#   unprompted  — whether the pane produces output on its own over a 15s
#                 window. A resumed TRANSCRIPT sits silent at a prompt; a
#                 resumed WORKER would still be talking. Nothing else
#                 distinguishes them from outside.
if [ "$WITH_AGENT" = yes ] && [ -n "$AGENT_PANE" ]; then
  # resume_agents_on_restore relaunches asynchronously — give it room before
  # reading, so "not back yet" is never recorded as "did not come back".
  sleep 10
  cap 27-agent-process-info-after probe_herdr pane process-info --pane "$AGENT_PANE" || true
  AGENT_SHELL_PID_AFTER=$(pi_shell_pid "$OUT/27-agent-process-info-after.out")
  AGENT_FOREGROUND_AFTER=$(pi_foreground "$OUT/27-agent-process-info-after.out")
  cap 28-agent-list-after probe_herdr agent list || true
  AGENT_REGISTERED_AFTER=$(jq -r --arg n "$AGENT_NAME" \
    '[.result.agents[]? | select(.name == $n)] | if length > 0 then "yes" else "no" end' \
    "$OUT/28-agent-list-after.out" 2>/dev/null || echo n/a)
  AGENT_STATUS_AFTER=$(jq -r --arg n "$AGENT_NAME" \
    '[.result.agents[]? | select(.name == $n) | .agent_status] | first // "n/a"' \
    "$OUT/28-agent-list-after.out" 2>/dev/null || echo n/a)
  AGENT_SESSION_AFTER=$(jq -r --arg n "$AGENT_NAME" \
    '[.result.agents[]? | select(.name == $n) | .agent_session.value] | first // "n/a"' \
    "$OUT/28-agent-list-after.out" 2>/dev/null || echo n/a)
  cap 29-agent-pane-read-after probe_herdr pane read "$AGENT_PANE" --lines 60 || true
  if grep -q PROBE_ACK_OK "$OUT/29-agent-pane-read-after.out" 2>/dev/null; then
    AGENT_TRANSCRIPT_AFTER=yes
  else
    AGENT_TRANSCRIPT_AFTER=no
  fi
  # the silence test
  cp "$OUT/29-agent-pane-read-after.out" "$SCRATCH/agent-read-t0" 2>/dev/null || true
  sleep 15
  cap 30-agent-pane-read-settle probe_herdr pane read "$AGENT_PANE" --lines 60 || true
  if cmp -s "$SCRATCH/agent-read-t0" "$OUT/30-agent-pane-read-settle.out"; then
    AGENT_UNPROMPTED_OUTPUT=no
  else
    AGENT_UNPROMPTED_OUTPUT=yes
  fi
  note "experiment D after restore: registered=$AGENT_REGISTERED_AFTER status=$AGENT_STATUS_AFTER shell_pid $AGENT_SHELL_PID_BEFORE -> $AGENT_SHELL_PID_AFTER foreground=[$AGENT_FOREGROUND_AFTER] transcript=$AGENT_TRANSCRIPT_AFTER unprompted_output=$AGENT_UNPROMPTED_OUTPUT"
fi

# temp ledger + claim survival (they are plain files — recorded as evidence)
LEDGER_OK=no
# Post phase D the probe's appends land in the sqlite tape; the events
# helper serves either form, so validate whatever the tape actually is.
_ralph_ledger_events "$RALPH_HERDR_LEDGER" 2>/dev/null | jq -es 'length > 0' >/dev/null 2>&1 && LEDGER_OK=yes
CLAIM_OK=no
[ -s "$SCRATCH/claim.json" ] && jq -e . "$SCRATCH/claim.json" >/dev/null 2>&1 && CLAIM_OK=yes

# ── step 6 (experiment B resolve): did the waiter error, finish, or hang? ────
WAITER_STATE=hung
i=0
while [ "$i" -lt 90 ]; do
  if ! kill -0 "$WAITER_PID" 2>/dev/null; then
    WAITER_STATE=exited
    break
  fi
  sleep 1
  i=$((i + 1))
done
if [ "$WAITER_STATE" = "hung" ]; then
  kill "$WAITER_PID" 2>/dev/null || true
  echo "killed_after_s=90" >>"$OUT/06-waiter.meta"
fi
wait "$WAITER_PID" 2>/dev/null || true
WAITER_PID=""
WAITER_RC=$(sed -n 's/^rc=//p' "$OUT/06-waiter.meta" | head -1)
W_START=$(sed -n 's/^start_ms=//p' "$OUT/06-waiter.meta" | head -1)
W_END=$(sed -n 's/^end_ms=//p' "$OUT/06-waiter.meta" | head -1)
WAITER_ELAPSED_MS=""
[ -n "$W_START" ] && [ -n "$W_END" ] && WAITER_ELAPSED_MS=$((W_END - W_START))
note "waiter: state=$WAITER_STATE rc=${WAITER_RC:-none} elapsed_ms=${WAITER_ELAPSED_MS:-n/a} (timeout was ${WAIT_MS}ms)"

# ── step 7 (experiment C): timings + summary ─────────────────────────────────
STOP_MS=n/a
[ -n "$T_STOP_DONE" ] && STOP_MS=$((T_STOP_DONE - T_STOP_EXEC))
jq -n \
  --arg session "$SESSION" \
  --arg s1_ready_ms "$((T_S1_READY - T_S1_EXEC))" \
  --arg stop_ms "$STOP_MS" \
  --arg s2_ready_ms "$((T_S2_READY - T_S2_EXEC))" \
  --arg marker_alive_down "$MARKER_ALIVE_DOWN" \
  --arg beat_grew_down "$BEAT_GREW_DOWN" \
  --arg marker_alive_after "$MARKER_ALIVE_AFTER" \
  --arg beat_grew_after "$BEAT_GREW_AFTER" \
  --arg workspaces_after "$WS_AFTER" \
  --arg ledger_survived "$LEDGER_OK" \
  --arg claim_survived "$CLAIM_OK" \
  --arg waiter_state "$WAITER_STATE" \
  --arg waiter_rc "${WAITER_RC:-}" \
  --arg waiter_elapsed_ms "${WAITER_ELAPSED_MS:-}" \
  --arg waiter_timeout_ms "$WAIT_MS" \
  --arg with_agent "$WITH_AGENT" \
  --arg a_acked "$AGENT_ACKED" \
  --arg a_proc_alive_down "$AGENT_PROC_ALIVE_DOWN" \
  --arg a_registered_after "$AGENT_REGISTERED_AFTER" \
  --arg a_status_after "$AGENT_STATUS_AFTER" \
  --arg a_session_before "$AGENT_SESSION_BEFORE" \
  --arg a_session_after "$AGENT_SESSION_AFTER" \
  --arg a_shell_before "$AGENT_SHELL_PID_BEFORE" \
  --arg a_shell_after "$AGENT_SHELL_PID_AFTER" \
  --arg a_fg_before "$AGENT_FOREGROUND_BEFORE" \
  --arg a_fg_after "$AGENT_FOREGROUND_AFTER" \
  --arg a_transcript_after "$AGENT_TRANSCRIPT_AFTER" \
  --arg a_unprompted "$AGENT_UNPROMPTED_OUTPUT" \
  '{session: $session,
    agent_resume: {ran: $with_agent, prompt_acked: $a_acked,
                   process_alive_while_down: $a_proc_alive_down,
                   registered_after_restore: $a_registered_after,
                   status_after_restore: $a_status_after,
                   agent_session_before: $a_session_before,
                   agent_session_after: $a_session_after,
                   shell_pid_before: $a_shell_before,
                   shell_pid_after: $a_shell_after,
                   foreground_before: $a_fg_before,
                   foreground_after: $a_fg_after,
                   transcript_after_restore: $a_transcript_after,
                   unprompted_output_after_restore: $a_unprompted},
    timings_ms: {server1_ready: $s1_ready_ms, scoped_stop: $stop_ms,
                 server2_restore_ready: $s2_ready_ms},
    marker: {alive_while_server_down: $marker_alive_down,
             heartbeat_grew_while_down: $beat_grew_down,
             alive_after_restart: $marker_alive_after,
             heartbeat_growing_after_restart: $beat_grew_after},
    restore: {workspaces_after_restart: $workspaces_after},
    files: {temp_ledger_survived: $ledger_survived,
            fake_claim_survived: $claim_survived},
    waiter: {state: $waiter_state, rc: $waiter_rc,
             elapsed_ms: $waiter_elapsed_ms, timeout_ms: $waiter_timeout_ms}}' \
  >"$OUT/summary.json"
{
  echo "probe-claim-ttl summary ($(date -u +%FT%TZ))"
  jq . "$OUT/summary.json"
} | tee "$OUT/summary.txt"
echo "probe-claim-ttl: raw responses + summary in $OUT"
