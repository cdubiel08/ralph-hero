#!/usr/bin/env bash
# ledger.sh — append-only events ledger for the ralph-herdr watcher. Sourced,
# never run (watch-event.sh and reconcile.sh pull it in; lib.sh's spawn path
# appends the spawn record through it).
#
# THE LEDGER
#   One JSONL file per board scope: ~/.ralph/<owner>/<repo>/ledger.jsonl —
#   deliberately OUTSIDE any repo (worktree-per-job would make an in-repo
#   ledger a merge hazard). owner and repo are separate path components
#   (slugged separately): a joined "<owner>-<repo>" would collide distinct
#   boards, since '-' is legal inside both (foo-bar/baz vs foo/bar-baz).
#   owner/repo come from the same scope config board.ts reads (.ralph.json,
#   else .claude/settings.json env — wholesale per file, like board.ts), so
#   the main checkout and every worktree of one repo resolve the SAME ledger.
#
#   Every line is one event object:
#     {ts, ev, agent_ref, ...ev-specific}
#   ev vocabulary: spawn | state | adopt | exit | discover | lost ("lost" is
#   reserved; today a lost agent is recorded as ev=exit reason=lost).
#     spawn     appended by lib.sh's spawn path AT SPAWN TIME — the one
#               documented carve-out from "the watcher is the sole appender"
#               (spawn happens before any event hook can fire; a single-line
#               O_APPEND write stays atomic). Embeds the C7 LineageRecord as
#               .lineage and the C8 token map as .tokens.
#     state     watcher: {agent_status} (raw herdr status) or {state}
#               (lifecycle token value, e.g. "orphaned").
#     adopt     watcher orphan pass: {parent: new, prev_parent: old}.
#     exit      watcher: {reason: pane_exited|pane_closed|lost}.
#     discover  watcher/reconcile: a live ralph agent with no open ledger
#               record (spawned while the ledger didn't exist, or by hand).
#
#   Appends are single-line `>>` writes (O_APPEND) issued as ONE write(2):
#   the line goes through an EXTERNAL printf, whose fresh stdio buffer holds
#   a full 4KB line and flushes it in one call. bash's BUILTIN printf flushes
#   in ~1KB chunks on Darwin and provably tears concurrent appends over that
#   size — never "fix" the `env printf` below back to the builtin.
#   ralph_ledger_append REFUSES lines whose write (line + newline) would
#   reach 4096 bytes rather than risk a torn write. Readers are pure jq
#   reductions over the whole file, so duplicate events are tolerated by
#   construction; writers that must read-decide-append (the watcher hooks,
#   reconcile) serialize through ralph_ledger_lock/unlock — appends alone
#   need no lock.
#
# LEDGER SELECTION
#   Every function operates on "the current ledger": $RALPH_HERDR_LEDGER when
#   set (the watcher iterates ~/.ralph/*/*/ledger.jsonl this way; tests point it
#   at a fixture), else derived from a repo root (argument, default $PWD) via
#   ralph_ledger_path.
#
# Knobs:
#   RALPH_HERDR_LEDGER        explicit ledger file path (overrides derivation)
#   RALPH_HERDR_LEDGER_ROOT   ledger root dir (default ~/.ralph)
#
# Pure functions + file appends only — no top-level side effects, no set/shopt
# (callers own their shell options). bash 3.2 compatible. Needs jq.

# _ralph_ledger_slug STR — path-safe component: any char outside
# [A-Za-z0-9._-] becomes '-', and the two traversal names "." and ".." get a
# "_" prefix (dots are otherwise legal — ".github" is a real repo name).
# Each scope component slugs SEPARATELY and becomes its own directory level.
_ralph_ledger_slug() {
  local s
  s=$(printf '%s' "${1-}" | LC_ALL=C tr -c 'A-Za-z0-9._-' '-')
  case "$s" in
    . | ..) s="_$s" ;;
  esac
  printf '%s' "$s"
}

# _ralph_ledger_scope REPO_ROOT — print "owner repo" from the board scope
# config, mirroring board.ts loadConfig: .ralph.json when it exists, ELSE
# .claude/settings.json's env block — wholesale per file, never mixing fields
# across files, and never process env (board.ts treats scope as repo-anchored;
# an event-hook process inherits the SERVER's environment, which must not
# ledger agents under a scope board.ts would never resolve). rc 1 (silently —
# callers probe) when the chosen file yields no complete owner/repo pair.
_ralph_ledger_scope() {
  local root="${1-}" cfg="" owner="" repo=""
  [ -n "$root" ] || return 1
  if [ -f "$root/.ralph.json" ]; then
    cfg="$root/.ralph.json"
    owner=$(jq -r '.owner // empty' "$cfg" 2>/dev/null) || owner=""
    repo=$(jq -r '.repo // empty' "$cfg" 2>/dev/null) || repo=""
  elif [ -f "$root/.claude/settings.json" ]; then
    cfg="$root/.claude/settings.json"
    owner=$(jq -r '.env.RALPH_GH_OWNER // empty' "$cfg" 2>/dev/null) || owner=""
    repo=$(jq -r '.env.RALPH_GH_REPO // empty' "$cfg" 2>/dev/null) || repo=""
  fi
  [ -n "$owner" ] || return 1
  [ -n "$repo" ] || return 1
  printf '%s %s\n' "$owner" "$repo"
}

# ralph_ledger_path [REPO_ROOT] — print the current ledger file path, creating
# its directory. $RALPH_HERDR_LEDGER wins outright; otherwise the scope is
# read from REPO_ROOT (default $PWD), falling back to that directory's git
# toplevel when the scope files aren't at the given path (worktree subdirs).
ralph_ledger_path() {
  local root scope owner repo dir
  if [ -n "${RALPH_HERDR_LEDGER:-}" ]; then
    dir=$(dirname "$RALPH_HERDR_LEDGER")
    mkdir -p "$dir" || return 1
    printf '%s\n' "$RALPH_HERDR_LEDGER"
    return 0
  fi
  root="${1:-$PWD}"
  if [ ! -f "$root/.ralph.json" ] && [ ! -f "$root/.claude/settings.json" ]; then
    root=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null) || root="${1:-$PWD}"
  fi
  scope=$(_ralph_ledger_scope "$root") || {
    echo "ralph_ledger_path: no board scope discoverable from $root — need .ralph.json or .claude/settings.json env (RALPH_GH_OWNER/RALPH_GH_REPO)" >&2
    return 1
  }
  owner=$(_ralph_ledger_slug "${scope%% *}")
  repo=$(_ralph_ledger_slug "${scope#* }")
  # Nested <owner>/<repo> dirs, NOT "<owner>-<repo>": '-' is legal inside
  # both names, so the joined form is not injective (foo-bar/baz and
  # foo/bar-baz would interleave two boards in one ledger file).
  dir="${RALPH_HERDR_LEDGER_ROOT:-$HOME/.ralph}/$owner/$repo"
  mkdir -p "$dir" || return 1
  printf '%s\n' "$dir/ledger.jsonl"
}

# ralph_ledger_append JSON — validate and append ONE event as one line.
# Refuses: invalid JSON, anything that compacts to more than one line
# (multiple documents), and lines whose write (line + newline) would reach
# 4096 bytes (the atomic-append budget).
#
# The write MUST go through an external printf: a fresh process's stdio
# buffer holds the whole line and flushes it as ONE write(2) to the O_APPEND
# fd. bash's BUILTIN printf flushes in ~1KB chunks (measured on Darwin
# /bin/bash 3.2: 200 concurrent 4KB appends produced merged 7-10KB lines and
# sub-line remnants; the identical run through `env printf` produced zero
# tears), so the builtin would tear exactly the concurrent hook appends this
# budget exists to protect.
ralph_ledger_append() {
  local raw="${1-}" file line bytes
  file=$(ralph_ledger_path) || return 1
  line=$(jq -ec . <<<"$raw" 2>/dev/null) || {
    echo "ralph_ledger_append: not valid JSON: ${raw:0:120}" >&2
    return 1
  }
  case "$line" in
    *$'\n'*)
      echo "ralph_ledger_append: one JSON object per call (got multiple documents)" >&2
      return 1
      ;;
  esac
  bytes=$(printf '%s' "$line" | wc -c)
  if [ "$bytes" -ge 4095 ]; then
    echo "ralph_ledger_append: refusing oversize line ($bytes bytes + newline >= 4096 — appends must stay atomic)" >&2
    return 1
  fi
  env printf '%s\n' "$line" >>"$file"
}

# ── read-decide-append serialization ─────────────────────────────────────────
# Plain appends are atomic on their own; what is NOT atomic is reading the
# ledger, deciding, and appending on the strength of that read. The herdr
# server runs event hooks concurrently (pane.exited and pane.closed both fire
# for one pane death), so two watch-event.sh processes provably overlap and
# would double-append exits/discovers and double-notify. Writers wrap those
# sections in this per-ledger-directory mutex (mkdir — atomic on POSIX,
# bash 3.2 safe; no flock on stock macOS). Pure readers never take it.
#
# A holder that dies mid-section leaves the lock behind; waiters break a lock
# after ~15s (sections are tens of ms — anything older is a corpse) and log
# loudly. _RALPH_LEDGER_LOCK_HELD tracks the one held lock so the executable
# scripts can `trap ralph_ledger_unlock_held EXIT` as insurance.

_RALPH_LEDGER_LOCK_HELD=""

# ralph_ledger_lock FILE — acquire the mutex for FILE's directory. Blocks;
# always returns 0 (a broken stale lock is taken over, not an error).
ralph_ledger_lock() {
  local file="${1-}" lock waited=0
  [ -n "$file" ] || return 0
  lock="$(dirname "$file")/.ledger.lock"
  mkdir -p "$(dirname "$lock")" 2>/dev/null || true
  while ! mkdir "$lock" 2>/dev/null; do
    waited=$((waited + 1))
    if [ "$waited" -gt 150 ]; then
      echo "ralph_ledger_lock: breaking stale lock $lock (held > ~15s — a hook died mid-section)" >&2
      rm -rf "$lock" 2>/dev/null || true
      waited=0
      continue
    fi
    sleep 0.1
  done
  _RALPH_LEDGER_LOCK_HELD="$lock"
  return 0
}

# ralph_ledger_unlock FILE — release FILE's directory mutex.
ralph_ledger_unlock() {
  local file="${1-}"
  [ -n "$file" ] || return 0
  rmdir "$(dirname "$file")/.ledger.lock" 2>/dev/null || true
  _RALPH_LEDGER_LOCK_HELD=""
  return 0
}

# ralph_ledger_unlock_held — EXIT-trap insurance: release whatever lock this
# process still holds (set -e can leave a section early).
ralph_ledger_unlock_held() {
  if [ -n "$_RALPH_LEDGER_LOCK_HELD" ]; then
    rmdir "$_RALPH_LEDGER_LOCK_HELD" 2>/dev/null || true
    _RALPH_LEDGER_LOCK_HELD=""
  fi
  return 0
}

# ralph_ledger_open_agents [REPO_ROOT] — agent_refs (one per line) with a
# spawn/discover event and no later exit. Order-aware reduce: an exit closes
# the ref; a fresh spawn/discover of the SAME ref (shouldn't happen — epochs
# are per-spawn) would legitimately re-open it. Missing/empty ledger: rc 0,
# no output.
# shellcheck disable=SC2120  # REPO_ROOT is for callers outside the watcher (lib.sh)
ralph_ledger_open_agents() {
  local file
  file=$(ralph_ledger_path "$@") || return 1
  [ -s "$file" ] || return 0
  jq -rs '
    reduce .[] as $e ({};
      if ($e.agent_ref // "") == "" then .
      elif $e.ev == "spawn" or $e.ev == "discover" then .[$e.agent_ref] = true
      elif $e.ev == "exit" then .[$e.agent_ref] = false
      else . end)
    | to_entries[] | select(.value) | .key' <"$file"
}

# ralph_ledger_open_ref NAME [REPO_ROOT] — the open agent_ref whose name part
# is NAME, or nothing. This is the bridge for the callers that only have a
# name: herdr knows names, the ledger keys on refs, and the join between them
# has to happen somewhere. Doing it HERE means it happens once, against the
# open set — a recycled name's dead generations are already closed, so they
# cannot answer. A caller that instead matched `split("#")[0]` against every
# record would match them (GH-1776), which is the ABA _ralph_ledger_latest
# describes.
#
# Should a name ever have two open refs — it should not; a spawn of a live
# name loses the agent-name mutex — the LAST is served: the newest generation
# is the live one, and the older is a missing exit record, not a live worker.
# shellcheck disable=SC2120  # REPO_ROOT is optional, as in the helpers above
ralph_ledger_open_ref() {
  local name="${1-}" ref out=""
  [ -n "$name" ] || return 0
  shift
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    [ "${ref%%#*}" = "$name" ] || continue
    out="$ref"
  done <<EOF
$(ralph_ledger_open_agents "$@" 2>/dev/null || true)
EOF
  [ -n "$out" ] || return 0
  printf '%s\n' "$out"
}

# ralph_ledger_last AGENT_REF — the most recent record for a ref, compact
# JSON. rc 1 (silently) when the ref has no records.
ralph_ledger_last() {
  local ref="${1-}" file out
  [ -n "$ref" ] || return 1
  file=$(ralph_ledger_path) || return 1
  [ -s "$file" ] || return 1
  out=$(jq -c --arg ref "$ref" -s 'map(select(.agent_ref == $ref)) | last // empty' <"$file")
  [ -n "$out" ] || return 1
  printf '%s\n' "$out"
}

# ── watcher plumbing over the same reductions ────────────────────────────────
# pane.exited/closed payloads carry ONLY a pane_id (no agent name), and the
# orphan pass needs parent edges — both resolved from the ledger itself, never
# from herdr state. pane_id is a correlation key for LIVE records only; the
# durable key stays agent_ref.

# ralph_ledger_open_for_pane PANE_ID — open agent_refs whose most recent
# pane-bearing record binds PANE_ID.
ralph_ledger_open_for_pane() {
  local pane="${1-}" file
  [ -n "$pane" ] || return 1
  file=$(ralph_ledger_path) || return 1
  [ -s "$file" ] || return 0
  jq -rs --arg p "$pane" '
    reduce .[] as $e ({open: {}, pane: {}};
      if ($e.agent_ref // "") == "" then .
      else
        (if $e.ev == "spawn" or $e.ev == "discover" then .open[$e.agent_ref] = true
         elif $e.ev == "exit" then .open[$e.agent_ref] = false
         else . end)
        | (((try ($e.pane_id // $e.lineage.herdr.pane_id) catch null) // "") as $pp
           | if $pp == "" then . else .pane[$e.agent_ref] = $pp end)
      end)
    | .pane as $pn
    | .open | to_entries[] | select(.value and ($pn[.key] == $p)) | .key' <"$file"
}

# _ralph_ledger_latest FIELD_EXPR REF — last non-empty value of a per-record
# jq expression over REF's records, matched on the EXACT ref (name#epoch).
# Deterministic names make respawn-after-crash recycle a NAME as the norm,
# so a bare-name match would leak the previous epoch's values across the
# recycle (a new root inheriting the dead epoch's parent edge — the ABA that
# feeds wrong adoptions and depth-guard misfires). Every producer writes full
# refs; a record that somehow carries a bare name is simply never "latest".
_ralph_ledger_latest() {
  local expr="${1-}" ref="${2-}" file out
  [ -n "$ref" ] || return 1
  file=$(ralph_ledger_path) || return 1
  [ -s "$file" ] || return 1
  out=$(jq -r --arg ref "$ref" -s "
    [ .[]
      | select(.agent_ref == \$ref)
      | $expr ]
    | map(select(. != null and . != \"\")) | last // empty" <"$file")
  [ -n "$out" ] || return 1
  printf '%s\n' "$out"
}

# ralph_ledger_open_rows [REPO_ROOT] — the open set AND every open ref's latest
# fields, in ONE pass over the file. One line per open ref, fields separated by
# US (0x1f), in this order:
#
#   ref  pane  shell_pid  harness  parent  state  issue  checkout  tokens
#
# Read it with `IFS=$'\037' read -r ...`. The separator is US and not a tab
# because tab is IFS *whitespace*: bash collapses runs of it and strips it from
# the ends, so two adjacent empty columns would silently become one and every
# field after them would shift. US is not whitespace, so an empty column stays
# an empty column — and empty is the common case here (a discover record has no
# shell_pid, a root has no parent).
#
# The open set is the same order-aware reduce as ralph_ledger_open_agents, and
# each field is the same "last non-empty value for this EXACT ref" rule as
# _ralph_ledger_latest. Those helpers stay: they are the right shape for a
# caller asking about one ref (lib.sh's depth guard, the watcher tests). This
# is the shape for a caller that walks every open ref and wants several fields
# from each — which is every phase of reconcile.
#
# Why (GH-1775): _ralph_ledger_latest re-slurps the WHOLE ledger per (ref,
# field), so a reconcile pass cost O(open refs x ledger size) across ~6 forks
# per worker — phase E alone reads pane, shell_pid and harness for the verdict,
# then issue, checkout and pane again to recover the claim. Emitting rows lets
# the loops read fields straight off the line, so a pass is O(ledger size) and
# one fork per ledger, and the ledger's size stops being a per-worker cost.
#
# No column can forge a separator: `tokens` is jq's own `tojson`, which escapes
# a control character rather than emitting it, and every other column is a
# grammar-constrained identifier, path or number. The explicit gsub is the belt
# — a stray separator or newline degrades one field to a space, it never shifts
# a column. Joined manually rather than with `@tsv`, which also escapes
# BACKSLASH: the tokens column is JSON, so `@tsv` would double every escape in
# it and hand the caller back something that no longer parses.
#
# Missing/empty ledger: rc 0, no output.
# shellcheck disable=SC2120  # REPO_ROOT is optional, as in the helpers above
ralph_ledger_open_rows() {
  local file
  file=$(ralph_ledger_path "$@") || return 1
  [ -s "$file" ] || return 0
  jq -rs '
    def keep($cur; $new): if ($new == null or $new == "") then $cur else $new end;
    def col: (. // "") | tostring | gsub("[\u001f\t\r\n]"; " ");
    reduce .[] as $e ({open: {}, f: {}};
      (($e.agent_ref // "")) as $ref
      | if $ref == "" then .
        else
          (if $e.ev == "spawn" or $e.ev == "discover" then .open[$ref] = true
           elif $e.ev == "exit" then .open[$ref] = false
           else . end)
          | (.f[$ref] // {}) as $c
          | .f[$ref] = {
              pane:      keep($c.pane;      ((try ($e.pane_id // $e.lineage.herdr.pane_id) catch null) // "")),
              shell_pid: keep($c.shell_pid; (($e.shell_pid // "") | tostring)),
              harness:   keep($c.harness;   ((try $e.tokens.harness catch null) // "")),
              parent:    keep($c.parent;    (if $e.ev == "adopt" then ($e.parent // "") else ((try $e.tokens.parent catch null) // "") end)),
              state:     keep($c.state;     (if $e.ev == "state" then ($e.state // "") else ((try $e.tokens.state catch null) // "") end)),
              issue:     keep($c.issue;     (((try $e.tokens.issue catch null) // "") | tostring)),
              checkout:  keep($c.checkout;  (($e.checkout // "") | tostring)),
              tokens:    keep($c.tokens;    ((try $e.tokens catch null) | if . == null then "" else tojson end))
            }
        end)
    | .f as $f
    | .open
    | to_entries[]
    | select(.value)
    | .key as $ref
    | ($f[$ref] // {}) as $v
    | [$ref, ($v.pane|col), ($v.shell_pid|col), ($v.harness|col),
       ($v.parent|col), ($v.state|col), ($v.issue|col), ($v.checkout|col),
       ($v.tokens|col)]
    | join("\u001f")' <"$file"
}

# Latest parent edge for a ref (adopt events win over the spawn/discover
# token), latest bound pane, latest lifecycle state, latest token map.
_ralph_ledger_latest_parent() {
  _ralph_ledger_latest '(if .ev == "adopt" then (.parent // "") else ((try .tokens.parent catch null) // "") end)' "$@"
}
_ralph_ledger_latest_pane() {
  _ralph_ledger_latest '((try (.pane_id // .lineage.herdr.pane_id) catch null) // "")' "$@"
}
_ralph_ledger_latest_state() {
  _ralph_ledger_latest '(if .ev == "state" then (.state // "") else ((try .tokens.state catch null) // "") end)' "$@"
}
_ralph_ledger_latest_tokens() {
  _ralph_ledger_latest '((try .tokens catch null) | if . == null then "" else tojson end)' "$@"
}
# GH-1809's three: the pane's shell pid at spawn (a rebuilt pane's differs),
# the worktree path (board scope without needing the pane back), and the issue
# whose claim this worker holds. All optional — records written before GH-1809,
# and discover records, carry none.
_ralph_ledger_latest_shell_pid() {
  _ralph_ledger_latest '((.shell_pid // "") | tostring)' "$@"
}
_ralph_ledger_latest_checkout() {
  _ralph_ledger_latest '((.checkout // "") | tostring)' "$@"
}
_ralph_ledger_latest_issue() {
  _ralph_ledger_latest '(((try .tokens.issue catch null) // "") | tostring)' "$@"
}

# ralph_ledger_children REF — open agent_refs whose latest parent edge points
# at REF, matched as the EXACT ref.
#
# The bare-name arm this used to carry (GH-1776) admitted that a child whose
# parent edge names a DEAD generation of REF's name is REF's child. It is not:
# names recycle on respawn, so that child belongs to the previous session and
# the live agent inherits it. Every consequence of the mis-join is a write —
# orphan_pass re-parents the child to this ref's grandparent, or marks it
# orphaned and notifies — so the leniency did not degrade a diagnostic, it
# corrupted the tree. Every producer writes a full ref (the token vocabulary's
# `parent` is `name#epoch`, and ralph_depth_guard has always resolved it
# exact-only through _ralph_ledger_latest), so nothing legitimate is lost.
ralph_ledger_children() {
  local ref="${1-}" file
  [ -n "$ref" ] || return 1
  file=$(ralph_ledger_path) || return 1
  [ -s "$file" ] || return 0
  jq -rs --arg ref "$ref" '
    reduce .[] as $e ({open: {}, par: {}};
      if ($e.agent_ref // "") == "" then .
      else
        (if $e.ev == "spawn" or $e.ev == "discover" then .open[$e.agent_ref] = true
         elif $e.ev == "exit" then .open[$e.agent_ref] = false
         else . end)
        | ((if $e.ev == "adopt" then ($e.parent // "") else ((try $e.tokens.parent catch null) // "") end) as $p
           | if $p == "" then . else .par[$e.agent_ref] = $p end)
      end)
    | .par as $par
    | .open | to_entries[]
    | select(.value)
    | select(($par[.key] // "") == $ref)
    | .key' <"$file"
}

# ralph_ledger_orphan_pass DEAD_REF LIVE_NAMES — the adoption policy, run when
# DEAD_REF is gone (pane exited/closed, or exit reason=lost at reconcile).
# LIVE_NAMES is a space-separated list of currently live herdr agent names.
#
# For each open child of DEAD_REF:
#   grandparent live AND ledger-open  → append adopt (child re-parents to the
#                                       grandparent) + update the child's
#                                       parent token
#   otherwise                         → append state=orphaned + state token +
#                                       ONE notification (skipped when the
#                                       child is already marked orphaned)
#
# Cascade reap is deliberately NOT here — that is Phase-3 fleet-controller
# behavior. This pass only records reality and routes attention. Lives in
# ledger.sh (not watch-event.sh) because reconcile.sh runs the identical pass;
# token pushes go through ralph_tokens_push when tokens.sh is sourced, and are
# skipped (decoration, never load-bearing) when it isn't.
ralph_ledger_orphan_pass() {
  local dead="${1-}" live="${2-}" herdr children child gp gp_name gp_ok pane ts state
  [ -n "$dead" ] || return 0
  children=$(ralph_ledger_children "$dead") || children=""
  [ -n "$children" ] || return 0
  herdr="${HERDR_BIN_PATH:-herdr}"
  gp=$(_ralph_ledger_latest_parent "$dead") || gp=""
  gp_name="${gp%%#*}"
  gp_ok=""
  if [ -n "$gp" ]; then
    case " $live " in
      *" $gp_name "*)
        # Ledger-open check is on the EXACT gp ref: liveness is name-level
        # (herdr knows names, not epochs), but adopting to a ref whose epoch
        # already exited would hand the child to a recycled name's ghost.
        if ralph_ledger_open_agents | grep -qFx "$gp"; then
          gp_ok=1
        fi
        ;;
    esac
  fi
  ts=$(date -u +%FT%TZ)
  for child in $children; do
    pane=$(_ralph_ledger_latest_pane "$child") || pane=""
    if [ -n "$gp_ok" ]; then
      ralph_ledger_append "$(jq -nc --arg ts "$ts" --arg c "$child" --arg gp "$gp" --arg prev "$dead" \
        '{ts: $ts, ev: "adopt", agent_ref: $c, parent: $gp, prev_parent: $prev}')" || continue
      if [ -n "$pane" ] && command -v ralph_tokens_push >/dev/null 2>&1; then
        ralph_tokens_push "$pane" "parent=$gp"
      fi
    else
      state=$(_ralph_ledger_latest_state "$child") || state=""
      if [ "$state" = "orphaned" ]; then
        continue
      fi
      ralph_ledger_append "$(jq -nc --arg ts "$ts" --arg c "$child" --arg prev "$dead" \
        '{ts: $ts, ev: "state", agent_ref: $c, state: "orphaned", via: "orphan", prev_parent: $prev}')" || continue
      if [ -n "$pane" ] && command -v ralph_tokens_push >/dev/null 2>&1; then
        ralph_tokens_push "$pane" "state=orphaned"
      fi
      "$herdr" notification show "${child%%#*} orphaned" \
        --body "parent ${dead%%#*} gone, no live grandparent — board claim still stands; attend or hand off" \
        >/dev/null 2>&1 || true
    fi
  done
  return 0
}
