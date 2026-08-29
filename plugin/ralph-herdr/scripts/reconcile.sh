#!/usr/bin/env bash
# reconcile.sh — one startup reconciliation pass for the ralph-herdr watcher.
#
# The [[startup]] hook runs this once after the herdr server (re)starts; the
# "Ralph: reconcile watcher ledger" action and a bare `bash reconcile.sh` in
# any pane run the identical pass by hand. It heals the gap event hooks cannot
# cover — everything that happened while the server was down:
#
#   E  claim recovery (GH-1809) every open ledger agent whose PANE proves the
#                  worker is gone — the pane was rebuilt (herdr restarted) or
#                  no harness process is left in the same shell — gets
#                  {ev: exit, reason: restart_killed|crashed} and its board
#                  claim RELEASED. Runs first, so phase A only sees what it
#                  does not already explain. The ONLY board write in this file
#   A  exit lost   every open ledger agent THIS SERVER OWNS with no live
#                  herdr agent of that
#                  name gets {ev: exit, reason: lost} — after a FRESH
#                  agent-list re-probe, so a spawn that completed mid-pass
#                  (ledger-open, absent from the pass-start snapshot) is
#                  never falsely exited. Ledger only: an absence is not
#                  evidence enough to touch the board (see the phase)
#   B  discover    every live ralph agent no ledger holds open gets a
#                  discover record (scope from its pane's cwd; a fresh
#                  name#epoch ref — the original spawn epoch died with the
#                  record that never got written)
#   C  token push  live agents re-receive the token map from their most
#                  recent ledger record (server restarts drop pane metadata)
#   D  orphan pass adoption policy for open children whose parent is no
#                  longer open — same pass watch-event.sh runs on pane death
#   F  re-arm      (GH-1862) an ARMED fleet run whose workers the restart
#                  killed is topped back up to k from the frontier — the level
#                  trigger for refill.sh, whose edge trigger a restart destroys
#                  along with the sessions that would have fired it. Inert
#                  unless a human armed a run with `work-fleet --refill`
#
# Single pass, then EXIT — no daemon, no sleep loop; the [[events]] hooks own
# steady-state.
#
# THE ONE BOARD WRITE (GH-1809). Every other phase here is an observation: the
# ledger and tokens describe the world, the board stays authoritative. Phases E
# and A break that for exactly one verb, `board release`, because the thing
# being corrected is a board fact no other actor can see — a claim whose holder
# died without releasing it. A dead worker cannot hand its claim back, and
# leaving it costs the full TTL (120 min) per issue in flight.
#
# The write is bounded to make that carve-out safe:
#   - only `release`, never a state move, never a claim take;
#   - only for an issue the LEDGER binds to this agent (tokens.issue);
#   - only when the PANE proves the worker is gone, by a reading that includes
#     the shell pid this ledger recorded at spawn — an unreadable answer, an
#     unknown pane, or a record with no recorded pid all release nothing;
#   - only when the board itself still reports In Progress WITH a claim, re-read
#     immediately before the write;
#   - only in a checkout whose board scope matches the ledger being walked, so
#     one repository's reconcile can never write another's board;
#   - and board.ts's own guardHolder still refuses a release by a non-holder,
#     which is the authority this pass defers to rather than reimplements.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The Herdr boundary (GH-1774): strict transport + session/repository scoping.
# Sourced here rather than via lib.sh because lib.sh discovers a board CLI
# relative to a workspace cwd these hooks do not have — but the boundary itself
# has no such dependency, so both hooks get the same validation the cockpit has.
# shellcheck source=sanitize.sh
. "$SCRIPT_DIR/sanitize.sh"
# shellcheck source=transport.sh
. "$SCRIPT_DIR/transport.sh"
# shellcheck source=naming.sh
. "$SCRIPT_DIR/naming.sh"
# The role model (GH-1808) — the discover path needs the lane->role default;
# pure functions, and its two reading helpers are not called from here.
# shellcheck source=roles.sh
. "$SCRIPT_DIR/roles.sh"
# shellcheck source=ledger.sh
. "$SCRIPT_DIR/ledger.sh"
# shellcheck source=tokens.sh
. "$SCRIPT_DIR/tokens.sh"
# scope.sh after ledger.sh: repo scope reuses _ralph_ledger_scope.
# shellcheck source=scope.sh
. "$SCRIPT_DIR/scope.sh"
# shellcheck source=dirty.sh
. "$SCRIPT_DIR/dirty.sh"
# shellcheck source=claim-recover.sh
. "$SCRIPT_DIR/claim-recover.sh"
# fleet.sh then refill.sh (phase F): refill.sh calls ralph_fleet_*. Neither
# touches anything at source time, and both are inert unless a fleet.json exists.
# shellcheck source=fleet.sh
. "$SCRIPT_DIR/fleet.sh"
# shellcheck source=refill.sh
. "$SCRIPT_DIR/refill.sh"

HERDR="${HERDR_BIN_PATH:-herdr}"

# set -e can leave a locked section early — never strand the mutex.
trap ralph_ledger_unlock_held EXIT

# Ledgers nest as <root>/<owner>/<repo>/ledger.jsonl (see ledger.sh).
#
# Defined HERE, above log(), and not beside its fellow path helpers: log()
# resolves its destination through it, and the flag block below logs before
# those helpers used to be reached. With the definition later, `--dry-run`'s
# own announcement resolved the log path as `/logs/reconcile.log` — so the one
# mode whose entire promise is that it writes nothing could create a file at
# the filesystem root. A command substitution that fails still leaves printf
# successful, which is why this surfaced as a stray path rather than an error.
ledger_root() { printf '%s\n' "${RALPH_HERDR_LEDGER_ROOT:-$HOME/.ralph}"; }

# log LINE — stdout, plus an append to a durable file (GH-1900).
#
# stdout alone made this pass unobservable in exactly the mode that matters.
# Run by hand, reconcile.sh prints to a terminal; run as the `[[startup]]`
# hook — its only automatic invocation, and the one phase F exists for — herdr
# routes the hook's stdout nowhere a reader can reach. Measured 2026-08-15:
# zero `reconcile:` lines in `~/.config/herdr/herdr-server.log` after seven
# days of uptime, and zero in an isolated probe session's own server log while
# the plugin was demonstrably loaded and the hook demonstrably fired. So every
# decision this pass makes after a restart — including whether phase F re-armed
# the fleet, or whether the pass aborted on an unready snapshot before reaching
# it — was written and immediately discarded.
#
# Appending, never truncating: a restart storm's passes are the sequence worth
# reading, so each must not erase the one before it.
#
# Logging FAILS OPEN, absolutely. A read-only or missing log directory is not a
# reason to abort a reconciliation pass — that would let an unwritable disk do
# what a sick server does, and this pass's whole discipline is that it acts
# only on what it can prove. An unwritable log costs observability, never work.
reconcile_log_file() {
  if [ -n "${RALPH_HERDR_RECONCILE_LOG:-}" ]; then
    printf '%s\n' "$RALPH_HERDR_RECONCILE_LOG"
  else
    printf '%s\n' "$(ledger_root)/logs/reconcile.log"
  fi
}

log() {
  local line f dir
  line="$(date -u +%FT%TZ) reconcile: $*"
  echo "$line"
  f=$(reconcile_log_file) || return 0
  dir=$(dirname "$f")
  [ -d "$dir" ] || mkdir -p "$dir" 2>/dev/null || return 0
  printf '%s\n' "$line" >>"$f" 2>/dev/null || true
  return 0
}

# ── flags (GH-1933) ──────────────────────────────────────────────────────────
#   --dry-run  run every read and every decision, perform no write. The pass
#              logs what it WOULD do. Exists because the one irreversible
#              outcome here — a live worker exited `lost`, which leaves a
#              zombie pane no later pass can re-discover — previously had no
#              way to be inspected before it happened.
#   --adopt PATH
#              treat the unproven records of the ONE ledger at PATH as this
#              server's, for this pass only. The escape hatch for records
#              written BEFORE records carried a session key: their writer is
#              unknowable, so no evidence can ever be found for them and only
#              an operator can assert it. It does not weaken the guard — the
#              guard's verdict is still computed and logged, this flag
#              overrides it out loud.
#
#              It takes a PATH because the assertion is about a ledger the
#              operator actually inspected (GH-1944). A bare `--adopt` used to
#              apply that one assertion to every unproven ledger the walk
#              found, writing lost-exits into unrelated — possibly foreign —
#              ledgers; the flag now refuses without a path rather than
#              silently meaning more than was typed.
DRY_RUN=0
ADOPT_LEDGER=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --adopt=*) ADOPT_LEDGER="${1#--adopt=}" ;;
    --adopt)
      _next="${2-}"
      case "$_next" in
        '' | --*)
          echo "reconcile.sh: --adopt needs the ledger path to adopt (e.g. --adopt \$HOME/.ralph/owner/repo/ledger.jsonl)" >&2
          exit 2
          ;;
      esac
      ADOPT_LEDGER="$_next"
      shift
      ;;
    *)
      echo "reconcile.sh: unknown argument '$1' (accepts --dry-run, --adopt PATH)" >&2
      exit 2
      ;;
  esac
  shift
done
if [ -n "$ADOPT_LEDGER" ]; then
  if [ ! -f "$ADOPT_LEDGER" ]; then
    echo "reconcile.sh: --adopt '$ADOPT_LEDGER' is not a ledger file" >&2
    exit 2
  fi
fi

# Dry run is enforced by replacing the mutating primitives, not by an `if` at
# each call site: a guard the phases have to remember is a guard one of them
# will forget. These five are the whole write surface of this pass.
if [ "$DRY_RUN" = 1 ]; then
  log "DRY RUN — every decision below is computed for real; no write is performed"
  ralph_ledger_append() { log "would append: $1"; }
  # Prints an OUTCOME, like the real one — recover_claim logs it verbatim, so
  # the dry run reports the release it would have attempted, checkout scoping
  # and all, through the same line the real pass would print.
  ralph_claim_release() { echo "dry-run (would release)"; }
  ralph_tokens_push() { log "would push tokens onto pane $1: ${*:2}"; }
  refill_all_to_capacity() { log "would evaluate fleet refill for $1"; }
  ralph_dirty_clear() { log "would clear the dirty mark for $(dirname "$1")"; }
fi

# scope_key LEDGER_FILE — the "owner/repo" a ledger path encodes. Used to key
# the cross-phase `open_all` set, because a bare NAME is not a unique key
# across repositories: two repos in one session both hold a `w42-fix`, and a
# name-keyed set would let one repository's live agent suppress the other's
# discovery — the very cross-repo leak this pass is supposed to prevent.
scope_key() {
  local dir
  dir=$(dirname "$1")
  printf '%s/%s' "$(basename "$(dirname "$dir")")" "$(basename "$dir")"
}

# Live ralph agents, each tagged with the repository its checkout resolves to.
# This pass walks EVERY ledger under the ledger root, so it is the one caller
# that legitimately spans repositories — and therefore the one that must never
# compare a name from repository A against a ledger belonging to repository B.
# Two repositories in one Herdr session both produce `w42-fix`; matching on the
# name alone would let A's live worker keep B's dead record open, and B's
# absence mark A's worker lost.
#
# A FAILED read aborts the whole pass: an empty answer from a sick server must
# never mark every agent lost.
# stderr to a FILE, never merged into the capture: on success `2>&1` prepends
# any stray diagnostic line to the JSON, jq rejects the whole value, and the
# scoped herd collapses to an empty list — re-erasing the "no agents" vs
# "could not find out" distinction the transport layer works to preserve.
# The pass announces itself BEFORE the first read that can abort it (GH-1900).
# "the hook never fired" and "the hook fired and found an unready server" are
# opposite diagnoses with opposite remedies — a registration problem versus a
# retry-or-delay problem — and without a line written before the snapshot read,
# both render as an empty log. This is phase F's whole open question: it is the
# only phase whose omission is silent-but-unproductive rather than self-healing.
log "pass started (pid $$, ledger root $(ledger_root))"

# A bounded wait for the snapshot to become answerable (GH-1900).
#
# Measured, 4 restarts of an isolated session: herdr starts this hook at
# T+~46ms and the API only answers an external client at T+~76ms. The hook is
# therefore launched INTO the readiness window, and the snapshot read succeeded
# every time only because sourcing the libraries costs more than the ~30ms of
# margin. That is a race won by accident of startup cost, and the measurement
# was taken on an idle 4-pane session — the cockpit this must survive restores
# ten workspaces and eleven agents, where restore is heavier and the margin is
# unmeasured.
#
# Losing that race is uniquely expensive HERE. Every other unknown in this
# script fails closed and is re-asked by the next pass; phase F has no next
# pass. Refill is edge-triggered from a session exiting, a restart destroys the
# listeners that would emit that edge, and nothing else schedules a reconcile —
# so an aborted startup pass means the fleet silently stays un-rearmed until
# its arming expires. The abort is correct (never sweep against an unknown
# herd) and stays exactly as it was; what is wrong is treating the first read,
# issued milliseconds into a server's life, as that read's only chance.
#
# Deliberately a WAIT, not a retry of the pass: the failure being covered is a
# server that is not answering YET, which resolves in tens of milliseconds, and
# re-running whole phases would risk acting twice. The bound is small and the
# fall-through is the unchanged abort — a server that is genuinely sick still
# gets refused, one second later. Fails open in the only direction available:
# if the wait loop cannot run at all, the original read still happens.
# The retry REUSES its own read rather than probing first: a throwaway
# readiness call would make every healthy pass cost two snapshots instead of
# one, and reconcile-cost.test.sh pins that count deliberately. So the loop
# below IS the original read, attempted up to a bounded number of times, and a
# server that answers immediately — the overwhelmingly common case — still
# issues exactly one.
_snap_wait_ms=${RALPH_HERDR_SNAPSHOT_WAIT_MS:-3000}
_snap_waited=0
_snap_err=$(ralph_diag_file)
while :; do
  snapshot=$(ralph_herdr_snapshot 2>"$_snap_err") && break
  [ "$_snap_waited" -lt "$_snap_wait_ms" ] || break
  sleep 0.1
  _snap_waited=$((_snap_waited + 100))
  snapshot=""
done
if [ -z "${snapshot:-}" ]; then
  log "herdr snapshot failed after ${_snap_waited}ms — not reconciling ($(ralph_diag_read "$_snap_err"))"
  rm -f "$_snap_err"
  exit 0
fi
[ "$_snap_waited" -eq 0 ] ||
  log "the herdr snapshot took ${_snap_waited}ms to answer — the pass started inside the server's readiness window"
rm -f "$_snap_err"
# An empty enrichment is NOT an empty herd: phases A and D read absence as
# "mark lost / orphan the children", so a failure here must stop the pass
# rather than let it sweep against nothing.
if ! live_json=$(ralph_herd_by_scope "$snapshot" 2>/dev/null); then
  log "herd scope resolution failed — not reconciling (refusing to sweep against an unknown herd)"
  exit 0
fi


ts=$(date -u +%FT%TZ)
open_all="" # names open in ANY ledger (dedup channel for phase B)
dead_names="" # phase E's proven-gone worker names (capacity input for phase F)

# The ledger set, enumerated ONCE (GH-1775). Every phase below used to re-glob
# the ledger root, which cost five globs and — worse — let a ledger created
# mid-pass be visible to the later phases and not the earlier ones, so a single
# pass could discover an agent it had already declined to sweep. One list means
# every phase reconciles the same world.
ledgers=()
for f in "$(ledger_root)"/*/*/ledger.jsonl; do
  [ -f "$f" ] || continue
  ledgers+=("$f")
done
# bash 3.2 + `set -u`: an empty array is an unbound expansion, so every walk
# below goes through this guard rather than "${ledgers[@]}" directly.
walk_ledgers() { printf '%s\n' ${ledgers[@]+"${ledgers[@]}"}; }

# --adopt names a ledger, so it must name one THIS walk found. Matched with
# `-ef` (same file) rather than by string: the walk emits
# "$(ledger_root)/owner/repo/ledger.jsonl" verbatim — doubled slashes,
# unresolved symlinks and all — while an operator types whatever their shell
# expanded, and a symlink anywhere in the path (final component included) is
# the same ledger by any honest reading.
#
# A path that matches nothing is REFUSED, not ignored. The operator asserted
# ownership of something; adopting nothing and sweeping on regardless would
# turn a typo, a stale root, or an unresolvable symlink into a silent no-op
# that reads exactly like a successful adoption.
if [ -n "$ADOPT_LEDGER" ]; then
  adopt_match=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ "$f" -ef "$ADOPT_LEDGER" ]; then
      adopt_match="$f"
      break
    fi
  done < <(walk_ledgers)
  if [ -z "$adopt_match" ]; then
    echo "reconcile.sh: --adopt '$ADOPT_LEDGER' is not one of the ledgers under $(ledger_root) — nothing to adopt" >&2
    exit 2
  fi
  ADOPT_LEDGER="$adopt_match"
fi

# ── Ownership: which of these ledgers is THIS server's to sweep (GH-1863) ────
# herdr runs the [[startup]] hook for EVERY server that starts, including a
# scratch server from an isolated named session (`herdr --session x server`).
# That pass gets pointed at the real ledgers under the ledger root while
# answering about a herd it has never had, so the absence-driven phases read
# "no live agent of that name" and sweep another server's live workers.
# Observed live 2026-08-13: five running workers marked lost in one pass,
# including the session writing the fix.
#
# The evidence is POSITIVE, matching claim-recover.sh's doctrine that an
# absence proves nothing. There are TWO positive proofs, and either suffices:
#
#   pane     the server's own snapshot holds a pane that one of the ledger's
#            open records names. The original proof (GH-1863).
#   session  one of the ledger's open records was WRITTEN by this server —
#            `.session` equals our ralph_session_key (GH-1933).
#
# The second exists because the first is only true while a worker is alive. On
# a fully-retired fleet no open record names a live pane, so a ledger became
# unsweepable in exactly the condition where sweeping it is safest: the
# operator had to keep a worker running to earn the right to sweep, and a
# mis-swept live worker is the irreversible outcome the guard exists to
# prevent. Observed 2026-08-14: 13 stale records, monotonically growing, whose
# named remedy was the command that declined to run.
#
# A foreign server satisfies neither — it holds none of those panes and it
# wrote none of those records — so GH-1863's refusal is unchanged. What is
# still UNKNOWN, and still fails closed: records written before the session
# stamp existed, and open records carrying neither a pane nor a session. Their
# writer is unknowable from the ledger, so only an operator can assert it
# (--adopt PATH), and --dry-run is there to inspect the sweep first.
#
# The verdict is PER RECORD, not per ledger (GH-1944). One ledger path is
# shared by every server that works the same repository, so a whole-ledger
# boolean let ONE matching record hand this server the right to sweep a
# sibling server's records — and those workers are live but absent from THIS
# server's snapshot, so the absence-driven phases read them as gone and exit
# them `lost`. That is the exact GH-1863 failure, re-entered through the back
# door, and a `lost` worker cannot be re-discovered. Deciding each record on
# its own pane and its own writer preserves both proofs and removes the blast
# radius: a foreign server still matches nothing, and a fully-quiesced own
# ledger is still entirely sweepable because every one of its records carries
# our key.
#
# Computed ONCE here, from the pass-start open rows, because phase E closes
# records: a ledger asked again after E could have lost the very row that
# proved a record ours.
server_panes=$(printf '%s' "$snapshot" |
  jq -r '(.panes // [])[] | .pane_id // empty' 2>/dev/null | tr '\n' ' ') || server_panes=""
this_session=$(ralph_session_key)
owned_refs="" # "owner/repo|ref" entries this pass may sweep
while IFS= read -r f; do
  [ -n "$f" ] || continue
  export RALPH_HERDR_LEDGER="$f"
  key=$(scope_key "$f")
  adopt_this=0
  # Both sides came out of the SAME walk (the flag was resolved to its matching
  # entry above), so this is a plain string compare on identical values.
  if [ -n "$ADOPT_LEDGER" ] && [ "$f" = "$ADOPT_LEDGER" ]; then
    adopt_this=1
  fi
  n_ours=0
  n_foreign=0
  n_adopted=0
  while IFS=$'\037' read -r ref pane _pid _harness _parent _state _issue _checkout _toks session; do
    [ -n "$ref" ] || continue
    proof=""
    if [ -n "$pane" ]; then
      case " $server_panes " in
        *" $pane "*) proof="pane $pane, which this server holds" ;;
      esac
    fi
    if [ -z "$proof" ] && [ -n "$session" ] && [ "$session" = "$this_session" ]; then
      proof="this server wrote it (session $session)"
    fi
    if [ -n "$proof" ]; then
      owned_refs="$owned_refs $key|$ref"
      n_ours=$((n_ours + 1))
    elif [ "$adopt_this" = 1 ]; then
      owned_refs="$owned_refs $key|$ref"
      n_adopted=$((n_adopted + 1))
    else
      n_foreign=$((n_foreign + 1))
    fi
  done < <(ralph_ledger_open_rows || true)
  if [ "$n_adopted" -gt 0 ]; then
    log "--adopt: $n_adopted open record(s) in $f have no ownership proof — sweeping them anyway on the operator's assertion"
  fi
  if [ "$n_foreign" -gt 0 ] && [ "$n_ours" -eq 0 ]; then
    log "not this server's ledger — no open record names a pane this server holds, and none carries this server's session key ($this_session); sweeping nothing in $f (re-run with --dry-run --adopt $f to inspect, --adopt $f to assert it is yours)"
  elif [ "$n_foreign" -gt 0 ]; then
    log "$n_foreign of $((n_ours + n_foreign)) open record(s) in $f are not this server's — sweeping the $n_ours that are, leaving the rest untouched"
  fi
done < <(walk_ledgers)
unset RALPH_HERDR_LEDGER

# record_is_ours FILE REF — the prepass verdict, per record. Gates the phases
# whose evidence is an ABSENCE (A's exit-lost sweep, D's orphan pass); phase E
# asks the pane directly and is already safe against a foreign server, and
# phase C writes only where the herd matched a record, which a foreign server
# never does.
#
# Keyed on "owner/repo|ref" rather than the ledger path, for the reason
# scope_key documents: two repositories in one session both hold a `w42-fix`,
# and a bare ref is not unique across them.
record_is_ours() {
  case " $owned_refs " in
    *" $(scope_key "$1")|$2 "*) return 0 ;;
  esac
  return 1
}

# live_rows — the herd as US-separated columns, derived once:
#   name  status  pane  scope  checkout
# Phase B walked live_json with four jq forks per agent to read exactly these.
live_rows=$(printf '%s\n' "$live_json" | jq -r '
  [(.name // ""), (.status // ""), (.pane // ""), (.scope // ""), (.checkout // "")]
  | join("\u001f")' 2>/dev/null) || live_rows=""

# pane_cwd PANE — the pane's cwd from the pass-start snapshot, or empty. Read
# from `panes`, not `agents`: a restored pane whose agent registration did not
# come back still has a cwd, and that is precisely the case being recovered.
pane_cwd() {
  [ -n "${1-}" ] || return 0
  printf '%s' "$snapshot" | jq -r --arg p "$1" \
    '(.panes // [])[] | select(.pane_id == $p) | .cwd // empty' 2>/dev/null | head -1
}

# recover_claim REF LEDGER_FILE REASON ISSUE CHECKOUT PANE — release REF's
# board claim, if the ledger binds it to an issue and the checkout it names
# really is the repository this ledger belongs to. Logs one line either way;
# never fails the pass. Shared by phases E and A so the two cannot drift on
# what "gone" earns.
#
# ISSUE/CHECKOUT/PANE are passed in rather than re-read (GH-1775): they come off
# the same ralph_ledger_open_rows line the caller is already holding, so this
# no longer re-slurps the whole ledger three more times per dead worker.
#
# The scope check is the load-bearing one. A ledger path names owner/repo but
# not a checkout, and the checkout is where board.ts reads its own scope from —
# so a worktree that has since been repointed, or a pane cwd that wandered,
# could otherwise aim `board release` at a DIFFERENT board than the ledger this
# loop is walking. Mismatch is refused, not corrected.
recover_claim() {
  local ref="${1-}" file="${2-}" reason="${3-}" issue="${4-}" root="${5-}" pane="${6-}"
  local scope dir owner repo outcome
  case "$issue" in
    '' | *[!0-9]*)
      log "claim not evaluated for $ref — the ledger binds it to no issue"
      return 0
      ;;
  esac
  if [ -z "$root" ] || [ ! -d "$root" ]; then
    root=$(pane_cwd "$pane")
  fi
  if [ -z "$root" ] || [ ! -d "$root" ]; then
    log "claim NOT released for GH-$issue ($ref) — no checkout resolvable; it will expire at TTL"
    return 0
  fi
  root=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null) || root=""
  if [ -z "$root" ]; then
    log "claim NOT released for GH-$issue ($ref) — checkout is not a git repository; it will expire at TTL"
    return 0
  fi
  dir=$(dirname "$file")
  repo=$(basename "$dir")
  owner=$(basename "$(dirname "$dir")")
  scope=$(ralph_repo_scope "$root" 2>/dev/null) || scope=""
  case "$scope" in
    *"/$owner/$repo") : ;;
    *)
      log "claim NOT released for GH-$issue ($ref) — checkout $root resolves to scope '${scope:-unreadable}', not $owner/$repo; refusing to write another board"
      return 0
      ;;
  esac
  outcome=$(ralph_claim_release "$root" "$issue" "$ref" "$reason")
  case "$outcome" in
    released) log "released the claim on GH-$issue ($ref, $reason)" ;;
    not-in-progress) log "claim untouched on GH-$issue ($ref) — no longer In Progress; the worker got somewhere before it died" ;;
    not-claimed) log "claim untouched on GH-$issue ($ref) — already unclaimed" ;;
    no-board) log "claim NOT released for GH-$issue ($ref) — no board CLI found from $root" ;;
    *) log "claim NOT released for GH-$issue ($ref) — $outcome" ;;
  esac
}

# ── E: claims whose worker the pane proves is gone (GH-1809) ────────────────
# Before phase A, and looking at a DIFFERENT question. Phase A asks "is this
# name in the herd?"; a restart answers yes for a pane that was rebuilt around
# a fresh shell and may hold nothing but a relaunched `claude --resume` sitting
# at a prompt. So this phase asks the pane instead, and only a positive answer
# — rebuilt, or no harness process left — closes the record and releases the
# claim. `alive` and `unknown` are both left entirely to phase A.
#
# One ralph_ledger_open_rows read per ledger supplies every field this phase and
# recover_claim need (GH-1775). It used to take six whole-file jq slurps per
# open worker — pane, shell_pid and harness for the verdict, then issue,
# checkout and pane again to recover the claim — so the ledger's size was a
# per-worker cost.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  export RALPH_HERDR_LEDGER="$f"
  ralph_ledger_lock "$f"
  while IFS=$'\037' read -r ref pane pid harness _parent _state issue checkout _toks _session; do
    [ -n "$ref" ] || continue
    verdict=$(ralph_worker_verdict "$pane" "$pid" "$harness")
    case "$verdict" in
      restart_killed | crashed) : ;;
      *) continue ;;
    esac
    ralph_ledger_append "$(jq -nc --arg ts "$ts" --arg ref "$ref" --arg r "$verdict" \
      '{ts: $ts, ev: "exit", agent_ref: $ref, reason: $r, via: "reconcile"}')" || {
      log "exit-$verdict append failed for $ref — leaving the claim alone"
      continue
    }
    log "exit $ref (reason $verdict) [$f]"
    # Phase F needs these NAMES (GH-1862). This phase exists precisely because
    # a restart-rebuilt pane is still ANSWERED by `agent list` — that is why the
    # verdict comes from the pane and not from the herd — so the herd read that
    # refill uses for capacity would count every one of these dead workers as an
    # occupied seat and refuse to spawn. The set of workers proven gone is
    # computed exactly once, here, and handed forward.
    dead_names="$dead_names ${ref%%#*}"
    recover_claim "$ref" "$f" "$verdict" "$issue" "$checkout" "$pane"
  done < <(ralph_ledger_open_rows || true)
  ralph_ledger_unlock "$f"
done < <(walk_ledgers)
unset RALPH_HERDR_LEDGER

# ── A: exit reason=lost for open ledger agents with no live counterpart ──────
# The pass-start snapshot ages while the pass runs, and lib.sh appends a
# spawn record only AFTER `agent start` succeeded — so an open ref absent
# from the snapshot may be a spawn that completed mid-pass, live and working.
# Never exit on the stale read alone: collect candidates, then re-probe ONE
# fresh `agent list` and mark lost only what the fresh read also lacks (an
# agent whose record exists was live before the record was written, so a
# truly-live agent always survives the re-probe). A failed re-probe leaves
# the candidates open for the next reconcile — same fail-closed posture as
# the pass-start read.
#
# The re-probe is ONE snapshot for the whole pass, not one per ledger
# (GH-1775). It used to sit inside this loop, so a machine with N boards under
# the ledger root paid N+1 session.snapshot calls in a pass whose stated
# contract is one per session. Hoisting it is also strictly more correct:
# every ledger is now swept against ONE consistent fresh view of the herd
# instead of N views drifting apart as the pass runs. It stays LAZY — a pass
# where nothing looks lost never asks — and its outcome is remembered so a
# failed probe is not retried per ledger either.
#
# Deliberately UNBOUNDED, unlike the board's own prune (GH-2023). 36 of 39 open
# records swept in one measured pass, and a per-pass limit would have been the
# wrong shape for all three reasons prune's exists: the sweep costs zero remote
# calls per record (the one re-probe above is hoisted and charged once for the
# pass), it writes to a local append-only file rather than to GitHub, and it
# makes no board write at all. A limit would also not converge — this pass runs
# on server restart, so N stale records past the limit would need N/limit
# restarts to clear, while doctor-lineage kept reporting them. The hazard a
# limit gestures at is a MASS sweep from a bad read, and that is already
# answered by evidence rather than by arithmetic: the fail-closed re-probe, the
# per-record `record_is_ours` scoping, and this phase releasing no claim.
fresh_json=""   # scoped herd from the one fresh re-probe
fresh_state=""  # "" not yet asked | ok | failed
fresh_err=""    # the diagnostic from a failed probe, for the log line
reprobe() {
  [ -z "$fresh_state" ] || return 0
  # Same rule as the pass-start read, and it matters MORE here: a corrupted
  # capture yields an empty herd, and every candidate then gets an exit
  # reason=lost. Merging stderr would let one stray diagnostic line close
  # every open record in every ledger.
  local err snap
  err=$(ralph_diag_file)
  if snap=$(ralph_herdr_snapshot 2>"$err"); then
    fresh_json=$(ralph_herd_by_scope "$snap" 2>/dev/null) || fresh_json=""
    fresh_state=ok
  else
    fresh_err=$(ralph_diag_read "$err")
    fresh_state=failed
  fi
  rm -f "$err"
}

while IFS= read -r f; do
  [ -n "$f" ] || continue
  export RALPH_HERDR_LEDGER="$f"
  ralph_ledger_lock "$f"
  live_names=$(ralph_names_for_ledger "$live_json" "$f")
  candidates=""
  while IFS=$'\037' read -r ref _pane _pid _harness _parent _state _issue _checkout _toks _session; do
    [ -n "$ref" ] || continue
    name=${ref%%#*}
    # Not ours to sweep (GH-1863, narrowed to the record by GH-1944). Every
    # open name still counts as open, so phase B does not mint a second epoch
    # for a worker this pass declined to judge.
    if ! record_is_ours "$f" "$ref"; then
      open_all="$open_all $(scope_key "$f")|$name"
      continue
    fi
    case " $live_names " in
      *" $name "*)
        open_all="$open_all $(scope_key "$f")|$name"
        continue
        ;;
    esac
    candidates="$candidates $ref"
  done < <(ralph_ledger_open_rows || true)
  if [ -n "$candidates" ]; then
    reprobe
    if [ "$fresh_state" = ok ]; then
      fresh_names=$(ralph_names_for_ledger "$fresh_json" "$f") || fresh_names=""
      for ref in $candidates; do
        name=${ref%%#*}
        case " $fresh_names " in
          *" $name "*)
            log "spared $ref — went live mid-pass (fresh re-probe) [$f]"
            open_all="$open_all $(scope_key "$f")|$name"
            continue
            ;;
        esac
        ralph_ledger_append "$(jq -nc --arg ts "$ts" --arg ref "$ref" \
          '{ts: $ts, ev: "exit", agent_ref: $ref, reason: "lost", via: "reconcile"}')" ||
          log "exit-lost append failed for $ref"
        log "exit $ref (reason lost) [$f]"
        # NO claim release here, deliberately. Phase A's evidence is an
        # ABSENCE — this name is not in the herd — and an absence does not
        # survive being asked of the wrong server. herdr runs [[startup]] for
        # every server that starts, so a scratch server from an isolated
        # session gets this pass pointed at the real ledgers while answering
        # about a herd it has never had. Observed live 2026-08-13: exactly
        # that marked all five running workers `lost` in one sweep. Closing a
        # ledger record on that basis is recoverable (the next pass rediscovers
        # a live agent); releasing five working agents' claims is not.
        # Phase E releases instead, on a positive reading of the pane.
      done
    else
      log "fresh herd re-probe failed ($fresh_err) — leaving$candidates open for the next reconcile [$f]"
      for ref in $candidates; do
        open_all="$open_all $(scope_key "$f")|${ref%%#*}"
      done
    fi
  fi
  ralph_ledger_unlock "$f"
done < <(walk_ledgers)
unset RALPH_HERDR_LEDGER

# ── B: discover live ralph agents no ledger holds open ───────────────────────
# Reads the pre-derived live_rows columns rather than re-parsing each agent
# (GH-1775): this loop used to fork four jq and an awk per live agent to pull
# out name/pane/scope/checkout that one pass had already produced.
while IFS=$'\037' read -r name _status pane agent_scope cwd; do
  [ -n "$name" ] || continue
  # Keyed by scope|name: a live `w42-fix` already ledgered in repo A must not
  # suppress the discovery of repo B's genuinely different `w42-fix`.
  agent_key="${agent_scope##*/}"
  if [ -n "$agent_scope" ]; then
    # "host/owner/repo" -> "owner/repo": the last two path components, taken
    # with shell suffix/prefix trims rather than an awk fork per agent.
    agent_key="${agent_scope%/*}"
    agent_key="${agent_key##*/}/${agent_scope##*/}"
  fi
  case " $open_all " in *" $agent_key|$name "*) continue ;; esac
  if ! parsed=$(ralph_agent_parse "$name"); then
    # ralph-deliver / ralph-tend: legacy singleton lanes with no parseable
    # identity — watched live (lib.sh regex) but never ledgered.
    log "skip $name (legacy singleton, no ledger identity)"
    continue
  fi
  # `cwd` is the checkout column, which came out of the snapshot join and
  # already preferred server-recorded worktree provenance over a runtime cwd.
  # Re-asking with a per-agent `pane get` would be both weaker (a bare cwd, no
  # provenance) and a remote call per agent in a loop over the whole herd.
  repo_root=""
  if [ -n "$cwd" ]; then
    repo_root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || repo_root="$cwd"
  fi
  file=""
  if [ -n "$repo_root" ]; then
    file=$(ralph_ledger_path "$repo_root" 2>/dev/null) || file=""
  fi
  if [ -z "$file" ]; then
    log "skip $name — no board scope resolvable from pane $pane (cwd '$cwd')"
    continue
  fi
  if ! ref=$(ralph_agent_ref "$name" 2>/dev/null); then
    log "skip $name — no durable ref derivable"
    continue
  fi
  # shellcheck disable=SC2086  # intentional: parse output is space-separated
  set -- $parsed
  lane="$1" issue="$2" slug="$3"
  [ "$slug" = "''" ] && slug=""
  export RALPH_HERDR_LEDGER="$file"
  # Locked re-check before minting an identity: an event hook can discover
  # this agent concurrently — one ref per agent, never two epochs.
  # Deliberately NOT hoisted out of the loop: the whole point is to re-read the
  # open set INSIDE the lock, because an event hook can ledger this agent while
  # this loop is running. A cached open set would reintroduce the double-epoch
  # race the lock exists to close, so this read stays per-candidate.
  ralph_ledger_lock "$file"
  if ralph_ledger_open_agents 2>/dev/null |
    awk -F'#' -v n="$name" '$1 == n { found = 1 } END { exit !found }'; then
    log "skip $name — already ledgered (an event hook won the race)"
    open_all="$open_all $(scope_key "$file")|$name"
    ralph_ledger_unlock "$file"
    continue
  fi
  # GH-1808: the C8 `role` token is the FLEET role. A discovered agent has no
  # spawn record to read one from, so it takes the lane's default — the only
  # thing knowable about an agent nobody ledgered. An unmappable lane leaves
  # the token off rather than inventing a role: a wrong role here would be
  # read as permission to write a tree.
  discovered_role=$(ralph_role_for_lane "$lane" 2>/dev/null) || discovered_role=""
  ralph_ledger_append "$(jq -nc --arg ts "$ts" --arg ref "$ref" --arg p "$pane" \
    --arg checkout "$repo_root" \
    --arg role "$discovered_role" --arg issue "$issue" --arg slug "$slug" \
    '{ts: $ts, ev: "discover", agent_ref: $ref, pane_id: $p, via: "reconcile",
      checkout: $checkout,
      tokens: ({issue: $issue}
               + (if $role == "" then {} else {role: $role} end)
               + (if $slug == "" then {} else {slug: $slug} end))}')" ||
    { log "discover append failed for $name"; ralph_ledger_unlock "$file"; continue; }
  ralph_ledger_unlock "$file"
  log "discover $ref (pane $pane) in $file"
  open_all="$open_all $(scope_key "$file")|$name"
done < <(printf '%s\n' "$live_rows")
unset RALPH_HERDR_LEDGER

# ── C: re-push tokens for live agents from their latest ledger records ───────
# Server restarts drop pane metadata; the ledger remembers. Two token names
# have LATER ledger truth than the spawn/discover token map and are overlaid
# rather than replayed wholesale: state (the CURRENT herdr status when it
# maps cleanly, else the latest recorded lifecycle state — adopt/orphan
# passes append state events the token map never sees) and parent (adopt
# events re-parent a child; replaying the spawn map would restore the dead
# ref the adopt path promised to supersede).
#
# Two keyed joins replace two linear scans (GH-1775). The live agent was looked
# up by re-filtering the WHOLE herd per open ref — the exact O(agents x
# workers) shape scope.sh warns against — and state/parent/tokens were three
# more whole-ledger slurps per ref. Now the herd is indexed once per ledger and
# the ledger fields ride in on the row.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  export RALPH_HERDR_LEDGER="$f"
  # Scoped like phases A and D. A token push is a WRITE onto a pane, so an
  # unscoped name lookup here does not merely mis-read — it stamps this
  # repository's role/issue/branch metadata onto another repository's agent,
  # and makes our own record look live because THEIR agent is.
  scope_tail=$(basename "$(dirname "$(dirname "$f")")")/$(basename "$(dirname "$f")")
  # name -> "pane<US>status" for THIS ledger's repository only. `first` keeps
  # the previous `head -1` tie-break, so a duplicate name resolves identically.
  herd_index=$(jq -cs --arg tail "$scope_tail" '
    map(select(.scope != null and (.scope | endswith($tail))))
    | group_by(.name)
    | map({key: (.[0].name // ""), value: [(.[0].pane // ""), (.[0].status // "")]})
    | from_entries' <<<"$live_json" 2>/dev/null) || herd_index='{}'
  [ -n "$herd_index" ] || herd_index='{}'
  while IFS=$'\037' read -r ref _pane _pid _harness par state _issue _checkout toks _session; do
    [ -n "$ref" ] || continue
    name=${ref%%#*}
    hit=$(jq -r --arg n "$name" '(.[$n] // []) | join("\u001f")' <<<"$herd_index" 2>/dev/null) || hit=""
    [ -n "$hit" ] || continue
    pane=${hit%%$'\037'*}
    status=${hit#*$'\037'}
    [ -n "$pane" ] || continue
    statekv=""
    case "$status" in
      working | blocked) statekv="state=$status" ;;
    esac
    if [ -z "$statekv" ] && [ -n "$state" ]; then
      statekv="state=$state"
    fi
    set --
    if [ -n "$toks" ]; then
      while IFS= read -r kv; do
        [ -n "$kv" ] || continue
        set -- "$@" "$kv"
      done < <(jq -r '
        to_entries[]
        | select(.key != "state" and .key != "parent")
        | select((.value | tostring | test("[\\r\\n]")) | not)
        | "\(.key)=\(.value | tostring)"' <<<"$toks" 2>/dev/null || true)
    fi
    if [ -n "$par" ]; then
      set -- "$@" "parent=$par"
    fi
    if [ -n "$statekv" ]; then
      set -- "$@" "$statekv"
    fi
    if [ "$#" -ge 1 ]; then
      # One `pane report-metadata` per live worker, and irreducibly so: this is
      # a WRITE addressed to one pane, and protocol 19 has no bulk form. It is
      # the reason this phase is O(workers) in herdr calls while every READ
      # above is O(1) — a distinction the call-count test pins deliberately.
      ralph_tokens_push "$pane" "$@"
      log "re-pushed $# token(s) for $ref (pane $pane)"
    fi
  done < <(ralph_ledger_open_rows || true)
done < <(walk_ledgers)
unset RALPH_HERDR_LEDGER

# ── C2: re-arm the cockpit agent view (best-effort, chrome only) ─────────────
# Server restarts drop any agent view along with the pane metadata; re-arm it
# after the tokens are back so a token-based sort has tokens to sort on.
# cockpit-view.sh is a documented no-op until the herdr CLI grows an
# agent-view surface (see its header); either way it never fails this pass.
bash "$SCRIPT_DIR/cockpit-view.sh" || true

# ── D: orphan pass — open children whose parent is no longer open ────────────
# Was O(refs^2) plus a whole-ledger slurp per ref (GH-1775): the parent edge
# came from _ralph_ledger_latest_parent, then the entire open list was re-piped
# through awk to ask whether that parent was still open. Both are now one pass:
# the parents ride in on the row, and open NAMES are collected into a
# membership string first — the same substring-set idiom `open_all` already
# uses a few phases up.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  export RALPH_HERDR_LEDGER="$f"
  ralph_ledger_lock "$f"
  # Re-scoped per ledger: phase A's loop variable belongs to phase A's
  # iteration, and reusing it here would hand this repository's orphan pass
  # whichever repository happened to be last in that earlier loop.
  live_names=$(ralph_names_for_ledger "$live_json" "$f")
  rows=$(ralph_ledger_open_rows) || rows=""
  # Membership is by full ref, never by name part (GH-1776): a parent edge
  # pointing at a DEAD generation whose name a live agent has since recycled
  # would read as "parent still open" and the orphan pass would never run —
  # the child stays silently parented to a worker that no longer exists, which
  # is the ghost this phase exists to clear.
  open_refs=""
  while IFS=$'\037' read -r ref _p _pid _h _par _st _i _co _t _s; do
    [ -n "$ref" ] || continue
    open_refs="$open_refs $ref"
  done <<EOF
$rows
EOF
  # Per-record again (GH-1944): the orphan decision is a WRITE onto the CHILD
  # — a re-parent or an orphaned mark plus a notification — so the record that
  # must be ours is the child, not the dead parent and not the ledger. A
  # sibling server's child of the same dead parent is left alone, and
  # `ours_children` carries that entitlement into the pass itself so a child
  # discovered there (rather than here) cannot slip past it.
  deads=""
  ours_children=""
  while IFS=$'\037' read -r ref _pane _pid _harness p _state _issue _checkout _toks _session; do
    [ -n "$ref" ] || continue
    [ -n "$p" ] || continue
    record_is_ours "$f" "$ref" || continue
    case " $open_refs " in
      *" $p "*) continue ;; # parent still open — not an orphan edge
    esac
    ours_children="$ours_children $ref"
    case " $deads " in
      *" $p "*) : ;;
      *) deads="$deads $p" ;;
    esac
  done <<EOF
$rows
EOF
  for d in $deads; do
    ralph_ledger_orphan_pass "$d" "$live_names" "$ours_children"
  done
  ralph_ledger_unlock "$f"
done < <(walk_ledgers)
unset RALPH_HERDR_LEDGER

# ── F: re-arm the fleet a restart emptied (GH-1862) ─────────────────────────
# LAST of the phases, because it is the only one that acts on the world the
# others just corrected. Phase E released the dead workers' claims, so those
# issues are back in Backlog and back on the frontier; this phase is what
# notices and spawns onto them.
#
# The gap it closes: refill is EDGE-triggered from watch-event.sh, on a w-lane
# session exiting or finishing. A restart kills every pane's process at once and
# restores panes holding a transcript at a prompt rather than a worker, so no
# surviving session is left to emit the event that would refill the seat it just
# vacated. An armed fleet.json then sits on disk, unexpired and unread, until
# its TTL lapses — safe (GH-1809 made sure of that) but not productive. A
# restart is an edge that destroys its own listeners, so it needs the same
# question asked at a level instead: once, here, after the server comes back.
#
# NO NEW OPT-IN KEY, and no new bound. Every bound already lives in fleet.json,
# which only exists because a human typed `work-fleet --refill`, and refill.sh
# re-takes all of them from disk. `budget_left` in particular is durable, so a
# restart STORM drains one shared budget and then disarms rather than getting a
# fresh allowance per restart — the acceptance criterion is met by the existing
# bound rather than by a restart-specific counter. With nothing armed this phase
# is one jq read per fleet file and no board access whatsoever.
#
# Phase E's `dead_names` is load-bearing, not an optimization: see the
# RALPH_HERDR_REFILL_EXCLUDE note in refill.sh. A restart's rebuilt panes still
# answer `agent list`, so without it the capacity check counts the very workers
# phase E just proved dead and this phase spawns nothing.
#
# OWNED RUNS ONLY (GH-1905). This is the one phase that starts processes, so a
# foreign server reaching it is worse than the ledger noise GH-1863 fixed. It
# cannot reuse record_is_ours — a fleet whose workers all exited cleanly has no
# open record to prove anything — so refill_all_to_capacity gates on the run's
# own provenance instead (the arming server's session key in fleet.json) and
# fails closed on an unrecorded one. The argument is in refill.sh.
#
# Safe to reach a sick server: the pass already aborted above if the herdr
# snapshot or scope resolution failed, and refill.sh's own herd and frontier
# reads fail closed — an unreadable answer leaves the run armed for the next
# reconcile rather than spawning into an unknown herd.
export RALPH_HERDR_REFILL_EXCLUDE="$dead_names"
while IFS= read -r f; do
  [ -n "$f" ] || continue
  refill_all_to_capacity "$f" || true
done < <(walk_ledgers)
unset RALPH_HERDR_REFILL_EXCLUDE

# Clear the dirty markers events left behind. LAST, after every phase: a marker
# dropped earlier would be a promise this pass had already looked, and any
# event arriving mid-pass would land in the window between the clear and the
# read that was supposed to answer it. Clearing here instead means such an
# event re-marks the scope and earns one more pass — a redundant reconcile,
# never a missed one.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if ralph_dirty_check "$f"; then
    log "cleared the dirty mark for $(dirname "$f")"
    ralph_dirty_clear "$f"
  fi
done < <(walk_ledgers)

log "reconcile complete"
exit 0
