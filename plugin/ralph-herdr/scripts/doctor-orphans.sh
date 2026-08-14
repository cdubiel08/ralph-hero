#!/usr/bin/env bash
# doctor-orphans.sh — find processes herdr spawned whose pane no longer exists.
#
# The third side of the lineage picture. doctor-lineage.sh compares live AGENTS
# against ledger RECORDS; both of its sides are keyed on a ledger identity, so
# neither can see a process that was never a ledgered agent at all — a cockpit,
# a watcher, a shell loop. Observed 2026-08-14: a cockpit polled a dead PTY for
# 30 hours, invisible to every existing check, found by hand.
#
# The signal is the one thing such a process still carries: herdr stamps
# HERDR_PANE_ID into every pane's environment, and that value outlives the pane.
# A process whose HERDR_PANE_ID names no pane in the live snapshot is orphaned.
#
#   process side   every own-uid process carrying HERDR_PANE_ID is resolved
#                  against the snapshot's pane ids. Present -> ok. Absent -> GAP,
#                  with the pid, its elapsed time, and its command line.
#
# Three properties this check commits to:
#
#   It reports, it never reaps. Consistent with the watcher's orphan pass: no
#   kill, no signal, no herdr write. The GAP line hands the human the pid and
#   they decide. A sweep that kills on a snapshot read is one partial snapshot
#   away from killing live work.
#
#   It does NOT scope by repository, and that is load-bearing rather than lax
#   (GH-1888). scope.sh fails closed because it decides *may I write here*; this
#   decides *is anyone still home*, and writes nothing. Worse, scope resolution
#   runs through the pane -> workspace -> worktree join, which for an orphan no
#   longer exists BY CONSTRUCTION — the pane is the thing that is gone. A
#   scoped orphan check could never fire on the case it exists to catch. So a
#   herdr process from any repository, or none, is reported here.
#
#   A read it could not perform is "not evaluable", never "clean". Three ways to
#   get there: no herdr, no snapshot, or a process table that shows no
#   environments at all (Linux `ps -E` means "every process", not "with
#   environment" — a silent empty answer that would read as a healthy machine).
#   The PATH probe below is what tells those apart.
#
# Output: herdr-setup.sh check style (`  ok  name — detail` / `  GAP  ` /
# `  note `), relayed by ralph/scripts/herdr-setup.sh at NOTE level.
#
# Exit codes: 0 no orphans · 1 orphans found · 2 not evaluable · 64 bad invocation.
#
# Knobs:
#   HERDR_BIN_PATH     herdr binary (default: `herdr` on PATH)
#   RALPH_HERDR_PS     command emitting the process table as `PID COMMAND ENV...`
#                      (tests; default: the `ps` probe below)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=sanitize.sh
. "$SCRIPT_DIR/sanitize.sh"
# shellcheck source=transport.sh
. "$SCRIPT_DIR/transport.sh"

HERDR="${HERDR_BIN_PATH:-herdr}"
[ "$#" -eq 0 ] || { echo "doctor-orphans.sh: takes no arguments" >&2; exit 64; }

FINDINGS=0
pass() { echo "  ok   $1 — $2"; }
gap()  { FINDINGS=$((FINDINGS + 1)); echo "  GAP  $1 — $2"; }
note() { echo "  note $1 — $2"; }

# ── the process table ────────────────────────────────────────────────────────
# One `ps` that prints EVERY process with its environment after its command
# line. Both halves of that are load-bearing:
#
#   the environment — BSD (macOS) spells it `-E`, procps (Linux) spells it `e`
#   and reads `-E` as "all processes", printing a full table with no
#   environments in it. Both forms are tried and the answer is only accepted if
#   environments are actually visible (the PATH probe below).
#
#   every process — without an all-processes selector `ps` reports only the
#   invoking terminal's own processes. Measured on this machine while writing
#   the check: 10 pane ids with `-E`, 13 with `-AE`. An orphan runs in a pane
#   that is gone, so it is never on the caller's terminal — the narrow form
#   would have hidden precisely the case this check exists to find.
#
# Values containing spaces mis-split here and that is harmless: the only token
# read is HERDR_PANE_ID, whose value is an opaque id like `w1:p13`.
#
# Note the absence of `| grep -q` anywhere in this file: under `set -o
# pipefail` a satisfied `grep -q` SIGPIPEs its producer and the pipeline
# reports failure, which here would have turned every healthy machine into
# "not evaluable". Membership is tested with `case` against a captured string.
ps_table() {
  local out
  if [ -n "${RALPH_HERDR_PS:-}" ]; then
    eval "$RALPH_HERDR_PS" 2>/dev/null || true
    return 0
  fi
  out=$(ps -AEwwo pid=,command= 2>/dev/null || true)
  case "$out" in *PATH=*) printf '%s\n' "$out"; return 0 ;; esac
  ps axewwo pid=,command= 2>/dev/null || true
}

table=$(ps_table || true)
case "$table" in
  *PATH=*) ;;
  *)
    note "orphan-procs" "not evaluable — this system's ps shows no process environments, so a herdr process cannot be recognised"
    exit 2
    ;;
esac

# ── live pane ids ────────────────────────────────────────────────────────────
# A failed read is "not evaluable", never "every process is orphaned": an empty
# answer from a sick server must not condemn the whole herd.
if ! command -v "$HERDR" >/dev/null 2>&1; then
  note "orphan-procs" "not evaluable — herdr is not installed (looked for '$HERDR')"
  exit 2
fi
_snap_err=$(ralph_diag_file)
if ! raw=$(ralph_herdr_snapshot 2>"$_snap_err"); then
  note "orphan-procs" "not evaluable — herdr snapshot unavailable ($(ralph_diag_read "$_snap_err"))"
  rm -f "$_snap_err"
  exit 2
fi
rm -f "$_snap_err"

live_panes=$(printf '%s' "$raw" | jq -r '.panes[]?.pane_id // empty' 2>/dev/null) || live_panes=""
pane_count=0
while IFS= read -r _p; do
  [ -n "$_p" ] && pane_count=$((pane_count + 1))
done <<EOF_PANES
$live_panes
EOF_PANES

is_live() {
  local p
  while IFS= read -r p; do
    [ "$p" = "$1" ] && return 0
  done <<EOF
$live_panes
EOF
  return 1
}

# ── resolve each herdr process against the live panes ────────────────────────
checked=0
# Default IFS on purpose (no `IFS=`): `ps` right-aligns the pid column, so the
# line usually begins with padding spaces and a `${line%% *}` split would yield
# an empty pid on every narrow one. `read pid rest` strips that padding.
while read -r pid rest; do
  case "$rest" in *HERDR_PANE_ID=*) ;; *) continue ;; esac
  case "$pid" in '' | *[!0-9]*) continue ;; esac
  pane=${rest#*HERDR_PANE_ID=}
  pane=${pane%% *}
  [ -n "$pane" ] || continue
  checked=$((checked + 1))
  if is_live "$pane"; then
    continue
  fi
  # The command line is taken from the row already in hand rather than from a
  # second `ps -p`, which would re-read a process that may have exited between
  # the two calls and would report nothing when it had. It is the row's prefix
  # up to the first VAR= token, since `ps` prints the environment after the
  # command; an argument that itself looks like an assignment truncates the
  # display and nothing else. Elapsed time has no such in-row source, so it
  # stays a second call and degrades to "unknown" — the pid is the load-bearing
  # part of the finding, and no detail is worth dropping it over.
  # Token-wise, not a `${rest%% [A-Za-z_]*=*}` glob: `*` spans spaces, so that
  # pattern matches at the first argument containing a letter and cuts the
  # command line down to its first word. Scanned with globbing off, because the
  # word split is over a real command line full of `*`.
  cmd=""
  set -f
  for tok in $rest; do
    case "$tok" in [A-Za-z_]*=*) break ;; esac
    cmd="$cmd $tok"
  done
  set +f
  cmd=$(printf '%s' "${cmd# }" | cut -c1-120)
  age=$(ps -p "$pid" -o etime= 2>/dev/null | tr -d ' ') || age=""
  gap "orphan-proc-$pid" "pane ${pane} is gone, process still running (up ${age:-unknown}) — ${cmd:-command unreadable}; nothing here kills it, decide and run: kill $pid"
done <<EOF_TABLE
$table
EOF_TABLE

if [ "$FINDINGS" -eq 0 ]; then
  pass "orphan-procs" "no orphans ($checked herdr process(es) checked against $pane_count live pane(s))"
  exit 0
fi
echo "  $FINDINGS orphaned process(es)"
exit 1
