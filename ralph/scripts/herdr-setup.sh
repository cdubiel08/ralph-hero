#!/usr/bin/env bash
# herdr-setup.sh — check (and optionally wire) the herdr cockpit for a ralph repo.
#
# The single source of truth for "is herdr set up for this board": /ralph:help
# herdr drives it interactively, and `board doctor` shells out to
# `check --oneline` for its advisory herdr-cockpit line. Nothing here touches
# board state; `fix` mutates only herdr's own config (plugin link/install,
# integration install) and announces every mutation before running it.
#
# Usage:
#   herdr-setup.sh [check] [--oneline]   report each prerequisite; no mutations
#   herdr-setup.sh fix                   perform the safely-automatable steps,
#                                        print exact manual commands for the rest
#   herdr-setup.sh reap [--apply] [--limit N]
#                                        sweep zombie panes / orphaned processes
#                                        (dry run by default — see the reap block)
#
# Exit codes (check): 0 fully wired · 1 gaps found · 2 herdr not installed.
# --oneline prints exactly one machine-readable line ("herdr: …") for doctor,
# carrying each gap's full detail — versions and remedy included, not just its
# name (GH-1911: a count plus a check identifier is not triageable).
#
# Knobs (same names the cockpit scripts use):
#   HERDR_BIN_PATH      herdr binary (default: `herdr` on PATH)
#   RALPH_HERDR_BOARD   board CLI path for host repos that install ralph as a
#                       Claude Code plugin (no ralph/ tree in the repo)
#   RALPH_HERDR_REPO    repo to check (default: $PWD)
#   RALPH_HERDR_PLUGINS_JSON  herdr's plugin registry (default:
#                       ${XDG_CONFIG_HOME:-~/.config}/herdr/plugins.json)
#   RALPH_HERDR_VERSION_STAMP  file naming the ralph-herdr version this ralph
#                       release expects (default: alongside this script)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${RALPH_HERDR_REPO:-$PWD}"
HERDR="${HERDR_BIN_PATH:-herdr}"
MIN_HERDR="0.8.0"
PLUGIN_SPEC="cdubiel08/ralph-hero/plugin/ralph-herdr"

MODE="check"
ONELINE=""
REAP_APPLY=""
REAP_LIMIT=50
prev=""
for arg in "$@"; do
  if [ "$prev" = "--limit" ]; then
    case "$arg" in
      '' | *[!0-9]* | 0) echo "herdr-setup.sh: --limit needs a positive integer (got '$arg')" >&2; exit 64 ;;
    esac
    REAP_LIMIT="$arg"
    prev=""
    continue
  fi
  case "$arg" in
    check | fix | reap) MODE="$arg" ;;
    --oneline) ONELINE=1 ;;
    --apply) REAP_APPLY=1 ;;
    --limit) prev="--limit" ;;
    *) echo "herdr-setup.sh: unknown argument '$arg' (usage: [check|fix|reap] [--oneline] [--apply] [--limit N])" >&2; exit 64 ;;
  esac
done
[ "$prev" = "--limit" ] && { echo "herdr-setup.sh: --limit needs a value" >&2; exit 64; }
if [ "$MODE" != "reap" ] && { [ -n "$REAP_APPLY" ] || [ "$REAP_LIMIT" != 50 ]; }; then
  echo "herdr-setup.sh: --apply/--limit belong to the reap verb" >&2
  exit 64
fi

# ── reap: zombie panes, orphaned daemons, stale unknown panes (audit D6) ─────
#
# doctor-orphans.sh commits to REPORT, NEVER REAP, and states the argument:
# "a sweep that kills on a snapshot read is one partial snapshot away from
# killing live work." That argument is answered here rather than skated past,
# and the answer is four bounds, not a counter-doctrine:
#
#   1. DRY RUN by default. Nothing is closed or killed until a human, having
#      read exactly what would happen, re-runs with --apply — so the snapshot
#      read is never the thing that kills; the human's assertion is.
#   2. Every action requires a reading the snapshot CANNOT fake: the cwd or
#      checkout missing from the LOCAL FILESYSTEM. A partial snapshot can make
#      a live pane invisible (which here means it is left alone — invisible
#      panes are never candidates); it cannot make a directory vanish from
#      disk. The one pass keyed on snapshot-side facts alone (unknown-status
#      panes) additionally requires a positive process-info read: no
#      foreground process AND a shell older than 60 min — and an unreadable
#      process-info disqualifies, never qualifies.
#   3. Ownership-unclear is LISTED, never acted on: only ralph-named agents
#      (grammar B / legacy gh-N) are actionable; every other finding prints
#      with no command run against it, --apply or not.
#   4. A per-sweep --limit (default 50) bounds the blast radius of any wrong
#      premise to one bounded, attended pass.
#
# Board state is NEVER written here: for each reaped unit the operator is
# handed `board claim show N` — releasing a dead worker's claim stays
# reconcile's pane-proved job (claim-recover.sh), which requires evidence this
# sweep does not collect.
#
# Exit: 0 nothing to reap · 1 candidates found (dry run) or actions performed ·
#       2 not evaluable · 64 bad invocation.
if [ "$MODE" = "reap" ]; then
  command -v "$HERDR" >/dev/null 2>&1 || { echo "reap: not evaluable — herdr is not installed (looked for '$HERDR')" >&2; exit 2; }
  command -v jq >/dev/null 2>&1 || { echo "reap: not evaluable — jq is required" >&2; exit 2; }

  # The strict transport boundary ships in the herdr plugin; resolve it the
  # same way the lineage/orphans relays below do. No boundary, no sweep.
  _rp_json="${RALPH_HERDR_PLUGINS_JSON:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins.json}"
  _rp_root=""
  [ -f "$_rp_json" ] && _rp_root=$(jq -r 'map(select(.plugin_id == "ralph-herdr")) | .[0].plugin_root // empty' "$_rp_json" 2>/dev/null) || _rp_root=""
  _rp_scripts=""
  for _cand in "${RALPH_HERDR_SCRIPTS_DIR:-}" "$_rp_root/scripts" "$REPO/plugin/ralph-herdr/scripts" "$SCRIPT_DIR/../../plugin/ralph-herdr/scripts"; do
    [ -n "$_cand" ] && [ -f "$_cand/transport.sh" ] && { _rp_scripts="$_cand"; break; }
  done
  if [ -z "$_rp_scripts" ]; then
    echo "reap: not evaluable — the ralph-herdr plugin's transport boundary was not found (install the herdr plugin, or run from a vendored checkout)" >&2
    exit 2
  fi
  # shellcheck source=/dev/null
  . "$_rp_scripts/sanitize.sh"
  # shellcheck source=/dev/null
  . "$_rp_scripts/transport.sh"

  snap=$(ralph_herdr_snapshot) || { echo "reap: not evaluable — herdr snapshot unavailable (an unreadable herd must never read as a reapable one)" >&2; exit 2; }

  [ -n "$REAP_APPLY" ] && echo "reap: APPLY mode — acting, limit $REAP_LIMIT action(s)" ||
    echo "reap: DRY RUN — nothing is closed or killed; re-run with --apply to act (limit $REAP_LIMIT)"

  findings=0
  acted=0
  budget_hit=""
  # act DESC CMD... — print the finding; under --apply (and budget) run CMD.
  act() {
    local desc="$1"
    shift
    findings=$((findings + 1))
    if [ -z "$REAP_APPLY" ]; then
      echo "  WOULD $desc — $*"
      return 0
    fi
    if [ "$acted" -ge "$REAP_LIMIT" ]; then
      budget_hit=1
      echo "  SKIP  $desc — per-sweep limit $REAP_LIMIT reached (re-run to continue)"
      return 0
    fi
    acted=$((acted + 1))
    echo "  REAP  $desc — $*"
    local out rc=0
    out=$("$@" 2>&1) || rc=$?
    if [ "$rc" -ne 0 ] || jq -e '.error' <<<"$out" >/dev/null 2>&1; then
      echo "        failed (rc $rc): $(printf '%s' "$out" | head -c 200 | tr '\n' ' ' | ralph_sanitize)"
    fi
    return 0
  }
  listed() { findings=$((findings + 1)); echo "  LIST  $1 — ownership unclear, never acted on: $2"; }

  # ── (a) agents whose recorded checkout/cwd no longer exists on disk ────────
  # The zombie-pane shape: reconcile exits the worker `lost` when its worktree
  # dir is deleted (scope resolution fails closed), and can never re-discover
  # it — the pane sits forever, invisible to every scoped surface.
  rows=$(printf '%s' "$snap" | jq -r '
    (.workspaces // [] | map({key: .workspace_id, value: (.worktree.checkout_path // "")}) | from_entries) as $ws
    | (.panes // [] | map({key: .pane_id, value: (.cwd // "")}) | from_entries) as $pc
    | (.agents // [])[]
    | [ (.name // ""), (.pane_id // ""),
        (($ws[.workspace_id // ""] // "") | if . == "" then ($pc[.pane_id // ""] // (.cwd // "")) else . end) ]
    | @tsv' 2>/dev/null) || rows=""
  while IFS=$'\t' read -r a_name a_pane a_dir; do
    [ -n "$a_name" ] && [ -n "$a_pane" ] || continue
    [ -n "$a_dir" ] || continue
    [ ! -d "$a_dir" ] || continue
    unit=$(printf '%s' "$a_name" | grep -Eo '^(gh-|[a-z])[0-9]+' | grep -Eo '[0-9]+' || true)
    if printf '%s' "$a_name" | grep -Eq '^gh-[0-9]+$|^ralph-(deliver|tend)$|^[a-z][0-9]+-[a-z].*$'; then
      act "close pane $a_pane (agent $a_name: checkout '$a_dir' is gone from disk)" "$HERDR" pane close "$a_pane"
      [ -n "$unit" ] && echo "        operator: board claim show $unit — reap never writes board state; a stale claim self-clears at TTL or releases via reconcile's pane-proved pass"
    else
      listed "agent $a_name (pane $a_pane)" "checkout '$a_dir' is gone, but the name is not ralph's — not ours to close"
    fi
  done <<EOF_ZOMBIES
$rows
EOF_ZOMBIES

  # ── (b) processes whose cwd is a deleted worktree (the daemon-leak shape) ──
  # Recognised by HERDR_PANE_ID in the environment (doctor-orphans' probe) plus
  # a cwd read straight from the kernel via lsof — a local, un-fakeable fact.
  ps_out=$(ps -AEwwo pid=,user=,command= 2>/dev/null || true)
  case "$ps_out" in *PATH=*) ;; *) ps_out=$(ps axewwo pid=,user=,command= 2>/dev/null || true) ;; esac
  me=$(id -un)
  if command -v lsof >/dev/null 2>&1; then
    case "$ps_out" in
      *PATH=*)
        while read -r p_pid p_user p_rest; do
          case "$p_rest" in *HERDR_PANE_ID=*) ;; *) continue ;; esac
          case "$p_pid" in '' | *[!0-9]*) continue ;; esac
          [ "$p_pid" != "$$" ] || continue
          cwd=$(lsof -a -p "$p_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1) || cwd=""
          [ -n "$cwd" ] || continue
          [ ! -d "$cwd" ] || continue
          # Command = the row's prefix up to the first VAR= token (ps prints
          # the environment after the command line — doctor-orphans.sh's rule),
          # scanned with globbing off because the row is full of `*`.
          cmd=""
          set -f
          for _tok in $p_rest; do
            case "$_tok" in [A-Za-z_]*=*) break ;; esac
            cmd="$cmd $_tok"
          done
          set +f
          cmd=$(printf '%s' "${cmd# }" | cut -c1-100)
          if [ "$p_user" = "$me" ]; then
            act "kill pid $p_pid (cwd '$cwd' is a deleted worktree; $cmd)" kill "$p_pid"
          else
            listed "pid $p_pid (user $p_user)" "cwd '$cwd' deleted, but the process is not $me's — not ours to kill"
          fi
        done <<EOF_PROCS
$ps_out
EOF_PROCS
        ;;
      *) echo "  note  orphan-process pass skipped — this ps shows no environments" ;;
    esac
  else
    echo "  note  orphan-process pass skipped — lsof not available to read a process's cwd"
  fi
  # Stale pid files under the ralph home: a *.pid naming a dead pid is a
  # leftover no scheduler will clean. Removed only under --apply.
  for pf in "${RALPH_HOME:-$HOME/.ralph}"/*.pid; do
    [ -f "$pf" ] || continue
    fpid=$(head -1 "$pf" 2>/dev/null | tr -dc '0-9') || fpid=""
    [ -n "$fpid" ] || continue
    kill -0 "$fpid" 2>/dev/null && continue
    act "remove stale pidfile $pf (pid $fpid is dead)" rm -f "$pf"
  done

  # ── (c) unknown-status panes: no foreground process, older than 60 min ─────
  # Three positive readings required; an unreadable process-info DISQUALIFIES.
  unk=$(printf '%s' "$snap" | jq -r '
    (.agents // [])[] | select((.agent_status // "unknown") == "unknown")
    | [(.name // ""), (.pane_id // "")] | @tsv' 2>/dev/null) || unk=""
  while IFS=$'\t' read -r u_name u_pane; do
    [ -n "$u_pane" ] || continue
    pinfo=$(ralph_herdr_call pane_process_info pane process-info --pane "$u_pane" 2>/dev/null) || continue
    fg=$(jq -r '(.process_info.foreground_processes // []) | length' <<<"$pinfo" 2>/dev/null) || continue
    [ "$fg" = "0" ] || continue
    spid=$(jq -r '.process_info.shell_pid // empty' <<<"$pinfo" 2>/dev/null) || spid=""
    case "$spid" in '' | *[!0-9]*) continue ;; esac
    et=$(ps -p "$spid" -o etime= 2>/dev/null | tr -d ' ') || et=""
    [ -n "$et" ] || continue
    # etime: [[dd-]hh:]mm:ss — older than 60 min = has a day part or an hour part.
    case "$et" in
      *-* | *:*:*) : ;;
      *) continue ;;
    esac
    if printf '%s' "${u_name:-}" | grep -Eq '^gh-[0-9]+$|^ralph-(deliver|tend)$|^[a-z][0-9]+-[a-z].*$'; then
      act "close pane $u_pane (agent ${u_name:-<unnamed>}: status unknown, no foreground process, shell up $et)" "$HERDR" pane close "$u_pane"
    else
      listed "pane $u_pane (agent ${u_name:-<unnamed>})" "unknown status, idle shell up $et, but the name is not ralph's"
    fi
  done <<EOF_UNK
$unk
EOF_UNK

  echo
  if [ "$findings" -eq 0 ]; then
    echo "reap: nothing to reap — every agent's checkout exists, no orphaned processes, no stale unknown panes"
    exit 0
  fi
  if [ -n "$REAP_APPLY" ]; then
    echo "reap: $findings finding(s), $acted action(s) performed${budget_hit:+ (limit reached — re-run to continue)}"
  else
    echo "reap: $findings finding(s) — DRY RUN, nothing was touched; re-run with --apply to act"
  fi
  exit 1
fi

# Gaps accumulate as "name|how to close it" lines; notes are advisory only and
# never affect the exit code.
GAPS=()
NOTES=()
say() { [ -n "$ONELINE" ] || echo "$@"; }
pass() { say "  ok   $1 — $2"; }
gap() { GAPS+=("$1|$2"); say "  GAP  $1 — $2"; }
note() { NOTES+=("$1|$2"); say "  note $1 — $2"; }

# ── herdr binary + version ───────────────────────────────────────────────────
if ! command -v "$HERDR" >/dev/null 2>&1; then
  if [ -n "$ONELINE" ]; then echo "herdr: not installed"; else
    echo "herdr is not installed (looked for '$HERDR')."
    echo "Install it from https://herdr.dev/ — everything else waits on this."
  fi
  exit 2
fi

# Version: first x.y.z in --version output; unparseable degrades to a note,
# never a false gap.
# component-wise compare, bash-3.2-safe: ver_ge A B → true when A >= B.
ver_ge() {
  printf '%s\n%s\n' "$2" "$1" | awk -F. '
    NR==1 { m1=$1+0; m2=$2+0; m3=$3+0 }
    NR==2 { if ($1+0>m1 || ($1+0==m1 && ($2+0>m2 || ($2+0==m2 && $3+0>=m3)))) print "yes" }' |
    grep -q yes
}

ver=$("$HERDR" --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
if [ -z "$ver" ]; then
  note "herdr-version" "could not parse '$HERDR --version'; need >= $MIN_HERDR"
else
  if ver_ge "$ver" "$MIN_HERDR"; then pass "herdr-version" "$ver (>= $MIN_HERDR)"
  else gap "herdr-version" "$ver < $MIN_HERDR — upgrade herdr (https://herdr.dev/)"; fi
fi

# ── jq ───────────────────────────────────────────────────────────────────────
if command -v jq >/dev/null 2>&1; then pass "jq" "$(jq --version 2>/dev/null || echo present)"
else gap "jq" "not on PATH — the cockpit scripts require it (brew install jq)"; fi

# ── server reachable ─────────────────────────────────────────────────────────
SERVER_UP=""
if "$HERDR" agent list >/dev/null 2>&1; then
  SERVER_UP=1
  pass "herdr-server" "reachable"
else
  gap "herdr-server" "not reachable — start herdr (run \`herdr\` in a terminal)"
fi

# ── ralph-herdr plugin installed/linked ──────────────────────────────────────
PLUGIN_MISSING=""
PLUGIN_DISABLED=""
if [ -n "$SERVER_UP" ]; then
  if plugins=$("$HERDR" plugin list 2>/dev/null) && grep -q "ralph-herdr.*enabled" <<<"$plugins"; then
    pass "ralph-herdr-plugin" "installed and enabled"
  elif grep -q "ralph-herdr" <<<"${plugins:-}"; then
    PLUGIN_DISABLED=1
    gap "ralph-herdr-plugin" "installed but disabled — herdr plugin enable ralph-herdr"
  else
    PLUGIN_MISSING=1
    gap "ralph-herdr-plugin" "not installed — herdr plugin install $PLUGIN_SPEC (or \`herdr plugin link <checkout>/plugin/ralph-herdr\` for a dev checkout)"
  fi
else
  note "ralph-herdr-plugin" "not checked (server down)"
fi

# ── herdr plugin state: authoritative root + version ─────────────────────────
# herdr registers every installed/linked plugin in plugins.json, recording the
# real on-disk root (`plugin_root`) for all three source kinds. That is the
# only reliable way to find files that ship inside the herdr plugin: the ralph
# plugin's own SCRIPT_DIR is a Claude Code cache path with no plugin/ sibling.
# One read, no network — this stays cheap enough for doctor's info line.
HERDR_PLUGINS_JSON="${RALPH_HERDR_PLUGINS_JSON:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins.json}"
PLUGIN_ROOT=""
plugin_entry=""
if command -v jq >/dev/null 2>&1 && [ -f "$HERDR_PLUGINS_JSON" ]; then
  plugin_entry=$(jq -c 'map(select(.plugin_id == "ralph-herdr")) | .[0] // empty' \
    "$HERDR_PLUGINS_JSON" 2>/dev/null || true)
  [ -n "$plugin_entry" ] && PLUGIN_ROOT=$(jq -r '.plugin_root // empty' <<<"$plugin_entry")
fi

# ── ralph-herdr plugin currency ──────────────────────────────────────────────
# herdr has no `plugin update` and no refresh-on-launch, while the ralph plugin
# IS auto-updated by Claude Code — so the two halves of the cockpit drift apart
# silently. Compare herdr's registered version against the stamp this ralph
# release ships. Every unknown degrades to a note: an older ralph plugin
# against a newer herdr plugin must never manufacture a false gap.
STAMP_FILE="${RALPH_HERDR_VERSION_STAMP:-$SCRIPT_DIR/herdr-plugin-version}"
stamp_ver=$(grep -Eo '^[0-9]+\.[0-9]+\.[0-9]+' "$STAMP_FILE" 2>/dev/null | head -1 || true)
plugin_ver=""
[ -n "$plugin_entry" ] && plugin_ver=$(jq -r '.version // empty' <<<"$plugin_entry" |
  grep -Eo '^[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
if ! command -v jq >/dev/null 2>&1; then
  note "ralph-herdr-version" "not evaluated (jq unavailable)"
elif [ -z "$plugin_entry" ]; then
  note "ralph-herdr-version" "not evaluated (no ralph-herdr entry in $HERDR_PLUGINS_JSON)"
elif [ -z "$stamp_ver" ]; then
  note "ralph-herdr-version" "not evaluated (no version stamp in this ralph plugin copy)"
elif [ -z "$plugin_ver" ]; then
  note "ralph-herdr-version" "not evaluated (herdr records no parseable version for ralph-herdr)"
elif ver_ge "$plugin_ver" "$stamp_ver"; then
  pass "ralph-herdr-version" "$plugin_ver (this ralph expects >= $stamp_ver)"
else
  src_kind=$(jq -r '.source.kind // empty' <<<"$plugin_entry")
  if [ "$src_kind" = "github" ]; then
    # The DRIFT is known here (plugin_ver < stamp_ver) — only the remedy string
    # depends on herdr's source metadata, so incomplete coordinates downgrade
    # the command, never the gap. `jq -r` renders a missing field as the string
    # "null", and `//` does not catch an EMPTY ref, so both are checked
    # explicitly: a copy-pasteable `install null/null/null --ref  -y` would be
    # worse than naming the canonical spec.
    # Read one field at a time: a tab-separated read would collapse empty
    # fields (tab is IFS whitespace in bash) and silently shift the values.
    src_field() { jq -r --arg f "$1" '.source[$f] // empty | tostring' <<<"$plugin_entry"; }
    src_owner=$(src_field owner)
    src_repo=$(src_field repo)
    src_subdir=$(src_field subdir)
    src_ref=$(src_field requested_ref)
    [ -n "$src_ref" ] || src_ref="main"
    if [ -n "$src_owner" ] && [ -n "$src_repo" ] && [ -n "$src_subdir" ]; then
      reinstall="herdr plugin install $src_owner/$src_repo/$src_subdir --ref $src_ref -y"
    else
      reinstall="herdr plugin install $PLUGIN_SPEC -y (herdr records incomplete source coordinates for this install — verify the spec before running)"
    fi
    gap "ralph-herdr-version" "$plugin_ver < $stamp_ver expected by this ralph, so the cockpit is EXECUTING PLUGIN CODE OLDER than this ralph relies on — fixes released since $stamp_ver are not in effect in the copy it runs; herdr has no auto-update, reinstall: $reinstall"
  else
    note "ralph-herdr-version" "$plugin_ver < $stamp_ver expected by this ralph, so the cockpit is executing plugin code older than this ralph relies on — local source at ${PLUGIN_ROOT:-unknown}; update that checkout"
  fi
fi

# ── ralph-herdr plugin content freshness (2026-08-19 audit, D4) ──────────────
# The version check above compares two STRINGS, and the strings were measured
# equal while the trees differed (f96286a7) — four merged≠installed incidents
# ran merged fixes unexecuted for a day each. So the subject here is CONTENT:
# a sorted sha256 over the plugin's behavior surface (scripts/**, cockpit's
# non-test Go source + go.mod/go.sum, the manifest), computed identically on
# the source tree beside this ralph copy and on herdr's registered install.
# MIRRORS plugin/ralph-herdr/scripts/herdr-plugin-sync.sh's tree_hash — change
# the two together. Every unreadable input degrades to a note ("not
# evaluated"), never a pass and never a gap: hashing can only under-report
# freshness, never claim it.
_hsu_sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1; else sha256sum | cut -d' ' -f1; fi
}
_hsu_tree_hash() {
  local dir="$1"
  [ -d "$dir/scripts" ] || return 1
  (
    cd "$dir" 2>/dev/null || exit 1
    {
      find scripts -type f 2>/dev/null
      find cockpit -type f \( -name '*.go' ! -name '*_test.go' -o -name 'go.mod' -o -name 'go.sum' \) 2>/dev/null
      [ -f herdr-plugin.toml ] && printf 'herdr-plugin.toml\n'
    } | LC_ALL=C sort | while IFS= read -r _f; do
      [ -f "$_f" ] || continue
      printf '%s ' "$_f"
      _hsu_sha256 <"$_f"
    done
  ) | _hsu_sha256
}
CONTENT_SRC="${RALPH_HERDR_CONTENT_SOURCE:-}"
if [ -z "$CONTENT_SRC" ]; then
  for _c in "$REPO/plugin/ralph-herdr" "$SCRIPT_DIR/../../plugin/ralph-herdr"; do
    [ -d "$_c/scripts" ] && { CONTENT_SRC="$_c"; break; }
  done
fi
if ! command -v jq >/dev/null 2>&1; then
  note "ralph-herdr-content" "not evaluated (jq unavailable)"
elif [ -z "$PLUGIN_ROOT" ] || [ ! -d "$PLUGIN_ROOT" ]; then
  note "ralph-herdr-content" "not evaluated (herdr records no readable plugin_root for ralph-herdr)"
elif [ -z "$CONTENT_SRC" ]; then
  note "ralph-herdr-content" "not evaluated (no plugin/ralph-herdr source tree beside this ralph copy — plugin-installed ralph has nothing to hash against)"
else
  src_hash=$(_hsu_tree_hash "$CONTENT_SRC" 2>/dev/null) || src_hash=""
  inst_hash=$(_hsu_tree_hash "$PLUGIN_ROOT" 2>/dev/null) || inst_hash=""
  if [ -z "$src_hash" ] || [ -z "$inst_hash" ]; then
    note "ralph-herdr-content" "not evaluated (a tree could not be hashed: source ${src_hash:-unreadable}, installed ${inst_hash:-unreadable})"
  elif [ "$src_hash" = "$inst_hash" ]; then
    pass "ralph-herdr-content" "installed tree matches the source tree (content hash $(printf '%.16s' "$src_hash"))"
  else
    gap "ralph-herdr-content" "the INSTALLED ralph-herdr tree differs from the source tree even though versions may read equal — the cockpit is executing code that does not match this checkout; sync and verify: bash $CONTENT_SRC/scripts/herdr-plugin-sync.sh (prints the exact reinstall, runs it, re-hashes)"
  fi
fi

# ── cockpit heartbeat (2026-08-19 audit, D6d) ────────────────────────────────
# The Go cockpit writes ${RALPH_HOME:-~/.ralph}/cockpit.heartbeat.json on
# every tick (pid + instant). A cockpit that died — GraphQL exhaustion killed
# one silently, discovered only when the user asked — leaves a stale file
# whose pid no longer runs. NOTE level always: the cockpit is optional chrome,
# and its absence is not a wiring gap. Four states, none conflated: no file
# (never ran / pre-heartbeat build), fresh+alive (ok), stale or pid-dead
# (cockpit-down, with the relaunch), unreadable (not evaluated).
HB_FILE="${RALPH_HERDR_HEARTBEAT_FILE:-${RALPH_HOME:-$HOME/.ralph}/cockpit.heartbeat.json}"
if [ ! -f "$HB_FILE" ]; then
  note "cockpit-heartbeat" "no heartbeat file at $HB_FILE — no cockpit has run here (or it predates the heartbeat); launch: herdr plugin action invoke cockpit --plugin ralph-herdr"
elif ! command -v jq >/dev/null 2>&1; then
  note "cockpit-heartbeat" "not evaluated (jq unavailable)"
else
  hb_pid=$(jq -r '.pid // empty' "$HB_FILE" 2>/dev/null) || hb_pid=""
  hb_age=""
  hb_mtime=$(stat -f %m "$HB_FILE" 2>/dev/null || stat -c %Y "$HB_FILE" 2>/dev/null) || hb_mtime=""
  case "$hb_mtime" in '' | *[!0-9]*) hb_mtime="" ;; esac
  [ -n "$hb_mtime" ] && hb_age=$(( ($(date +%s) - hb_mtime) / 60 ))
  case "$hb_pid" in '' | *[!0-9]*) hb_pid="" ;; esac
  if [ -z "$hb_pid" ] || [ -z "$hb_mtime" ]; then
    note "cockpit-heartbeat" "not evaluated (heartbeat file unreadable)"
  elif kill -0 "$hb_pid" 2>/dev/null && [ "$hb_age" -le 5 ]; then
    note "cockpit-heartbeat" "cockpit alive (pid $hb_pid, heartbeat ${hb_age}m old)"
  else
    note "cockpit-heartbeat" "cockpit-down — last heartbeat ${hb_age:-?}m ago, pid ${hb_pid} $(kill -0 "$hb_pid" 2>/dev/null && echo 'alive but silent' || echo 'gone'); relaunch: herdr plugin action invoke cockpit --plugin ralph-herdr (unattended: see CHEATSHEET §3's launchd KeepAlive note)"
  fi
fi

# ── claude integration (optional but recommended) ────────────────────────────
INTEGRATION_MISSING=""
if [ -n "$SERVER_UP" ]; then
  intline=$("$HERDR" integration status 2>/dev/null | grep '^claude:' || true)
  case "$intline" in
    *"not installed"* | "")
      INTEGRATION_MISSING=1
      note "claude-integration" "not installed — recommended: herdr integration install claude (session-identity restore after server restart)"
      ;;
    *current*) pass "claude-integration" "$intline" ;;
    *)
      INTEGRATION_MISSING=1
      note "claude-integration" "$intline — recommended: herdr integration install claude to refresh"
      ;;
  esac
else
  note "claude-integration" "not checked (server down)"
fi

# ── board CLI reachable the way the cockpit scripts will look for it ─────────
# Mirrors lib.sh's resolution order (GH-1761): RALPH_HERDR_BOARD > vendored
# ralph/ tree > newest installed Claude Code plugin copy. Change them together.
if [ -n "${RALPH_HERDR_BOARD:-}" ]; then
  if [ -x "$RALPH_HERDR_BOARD" ]; then
    pass "board-cli" "RALPH_HERDR_BOARD=$RALPH_HERDR_BOARD (note: reaches herdr panes only if the herdr SERVER was started with it)"
  else gap "board-cli" "RALPH_HERDR_BOARD=$RALPH_HERDR_BOARD is not executable"; fi
elif [ -x "$REPO/ralph/scripts/board" ]; then
  pass "board-cli" "$REPO/ralph/scripts/board (vendored-checkout layout)"
else
  # Registry first (GH-1865): installed_plugins.json RECORDS the copy Claude
  # Code executes, while the cache glob only finds the highest-versioned
  # directory that exists — this machine's cache holds 29. They coincide only
  # while the newest install is also the newest directory, so reporting a glob
  # hit as "the installed copy" is how `check` passes a path the cockpit does
  # not run. The glob stays as a last resort (no jq, no registry) but says so.
  INSTALLED_PLUGINS_FILE="${RALPH_INSTALLED_PLUGINS_FILE:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json}"
  installed=""
  if [ -r "$INSTALLED_PLUGINS_FILE" ] && command -v jq >/dev/null 2>&1; then
    # Keys are "<name>@<marketplace>". The recorded version is a TIE-BREAK
    # between several registered copies, never the reason to prefer the
    # registry — being recorded is.
    installed=$(jq -r '
        (.plugins // {}) | to_entries[]
        | select((.key | split("@")[0]) == "ralph")
        | .value[]? | select(.installPath != null)
        | ((.version // "0") + "\t" + .installPath + "/scripts/board")' \
      "$INSTALLED_PLUGINS_FILE" 2>/dev/null |
      while IFS=$'\t' read -r v p; do [ -x "$p" ] && printf '%s\t%s\n' "$v" "$p"; done |
      sort -V -k1,1 | tail -1 | cut -f2- || true)
  fi
  if [ -n "$installed" ]; then
    pass "board-cli" "$installed (installed plugin copy, recorded in $INSTALLED_PLUGINS_FILE — the cockpit scripts discover this automatically)"
  else
    # Sorted by the VERSION component, not the whole path (namespace would win).
    # shellcheck disable=SC2012  # glob over versioned plugin dirs is the point
    installed=$(ls "$HOME"/.claude/plugins/cache/*/ralph/*/scripts/board 2>/dev/null |
      awk -F/ '{ print $(NF-2) "\t" $0 }' | sort -V -k1,1 | tail -1 | cut -f2- || true)
    if [ -n "$installed" ] && [ -x "$installed" ]; then
      pass "board-cli" "$installed (GUESS: highest version under ~/.claude/plugins/cache — no ralph install recorded in $INSTALLED_PLUGINS_FILE, so this may not be the copy that runs)"
    else
      gap "board-cli" "no board CLI found (no ralph/ tree in $REPO, no ralph install recorded in $INSTALLED_PLUGINS_FILE, nothing under ~/.claude/plugins/cache) — install the ralph Claude Code plugin"
    fi
  fi
fi

# ── gh auth scopes ───────────────────────────────────────────────────────────
if ! command -v gh >/dev/null 2>&1; then
  gap "gh-auth" "gh is not installed"
elif auth=$(gh auth status 2>&1) && grep -q "project" <<<"$auth"; then
  pass "gh-auth" "authenticated with project scope"
elif [ -n "$auth" ] && grep -qi "logged in" <<<"$auth"; then
  gap "gh-auth" "authenticated but no 'project' scope — gh auth refresh -s repo,project"
else
  gap "gh-auth" "not authenticated — gh auth login -s repo,project"
fi

# ── watcher lineage closure (advisory — L10, doctor-lineage.sh) ──────────────
# Relayed at NOTE level only, on purpose: `board doctor` consumes this
# script's verdict as its info-level herdr-cockpit line, and a lineage
# finding is watcher telemetry (a missed reconcile), never a cockpit wiring
# gap — it must move neither the exit code nor the --oneline gap count. The
# check itself lives with the watcher (the herdr plugin), so it is found via
# herdr's registered plugin_root (correct for github installs, local links and
# checkouts alike); the repo-relative guess remains as the last fallback for a
# vendored checkout whose plugin herdr does not know about.
lineage_sh="${RALPH_HERDR_LINEAGE_SH:-}"
if [ -z "$lineage_sh" ]; then
  lineage_sh="$SCRIPT_DIR/../../plugin/ralph-herdr/scripts/doctor-lineage.sh"
  [ -n "$PLUGIN_ROOT" ] && [ -f "$PLUGIN_ROOT/scripts/doctor-lineage.sh" ] &&
    lineage_sh="$PLUGIN_ROOT/scripts/doctor-lineage.sh"
fi
if [ ! -f "$lineage_sh" ]; then
  note "watcher-lineage" "not evaluated (doctor-lineage.sh not found — it ships inside the ralph-herdr herdr plugin)"
elif [ -z "$SERVER_UP" ]; then
  note "watcher-lineage" "not checked (server down)"
else
  lineage_rc=0
  lineage_out=$(bash "$lineage_sh" 2>/dev/null) || lineage_rc=$?
  case "$lineage_rc" in
    0) note "watcher-lineage" "closed — every live ralph agent has exactly one open ledger record" ;;
    1)
      lineage_gaps=$(grep -c '^  GAP ' <<<"$lineage_out" || true)
      note "watcher-lineage" "${lineage_gaps:-some} lineage finding(s) — bash $lineage_sh for detail"
      if [ -z "$ONELINE" ]; then
        grep '^  GAP ' <<<"$lineage_out" | sed 's/^  GAP  /       · /' || true
      fi
      ;;
    2) note "watcher-lineage" "not evaluable (herdr unreachable mid-check)" ;;
    *) note "watcher-lineage" "not evaluated (doctor-lineage.sh exited $lineage_rc)" ;;
  esac
fi

# ── orphaned herdr processes (advisory — GH-1888, doctor-orphans.sh) ─────────
# Same NOTE-level contract as the lineage relay above, and for the same reason:
# a process outliving its pane is telemetry about the machine, never a cockpit
# wiring gap, so it must move neither the exit code nor the --oneline gap count.
# Resolved the same way (herdr's registered plugin_root first, repo-relative
# guess as the fallback for a vendored checkout).
orphans_sh="${RALPH_HERDR_ORPHANS_SH:-}"
if [ -z "$orphans_sh" ]; then
  orphans_sh="$SCRIPT_DIR/../../plugin/ralph-herdr/scripts/doctor-orphans.sh"
  [ -n "$PLUGIN_ROOT" ] && [ -f "$PLUGIN_ROOT/scripts/doctor-orphans.sh" ] &&
    orphans_sh="$PLUGIN_ROOT/scripts/doctor-orphans.sh"
fi
if [ ! -f "$orphans_sh" ]; then
  note "watcher-orphans" "not evaluated (doctor-orphans.sh not found — it ships inside the ralph-herdr herdr plugin)"
elif [ -z "$SERVER_UP" ]; then
  note "watcher-orphans" "not checked (server down)"
else
  orphans_rc=0
  orphans_out=$(bash "$orphans_sh" 2>/dev/null) || orphans_rc=$?
  case "$orphans_rc" in
    0) note "watcher-orphans" "no orphans — every herdr process still has its pane" ;;
    1)
      orphans_gaps=$(grep -c '^  GAP ' <<<"$orphans_out" || true)
      note "watcher-orphans" "${orphans_gaps:-some} orphaned process(es) — bash $orphans_sh for detail (nothing is killed for you)"
      if [ -z "$ONELINE" ]; then
        grep '^  GAP ' <<<"$orphans_out" | sed 's/^  GAP  /       · /' || true
      fi
      ;;
    2) note "watcher-orphans" "not evaluable (herdr unreachable, or this system's ps hides process environments)" ;;
    *) note "watcher-orphans" "not evaluated (doctor-orphans.sh exited $orphans_rc)" ;;
  esac
fi

# ── report / oneline ─────────────────────────────────────────────────────────
# Note the length guards before every "${GAPS[@]}" expansion: macOS ships
# bash 3.2, where an empty array trips `set -u` even quoted.
gapnames() {
  local IFS=,; local names=() g
  [ "${#GAPS[@]}" -gt 0 ] && for g in "${GAPS[@]}"; do names+=("${g%%|*}"); done
  echo "${names[*]}"
}

# GH-1911: --oneline carries each gap's DETAIL, not just its name. A count plus
# a check identifier is not triageable — the reader learns which check fired and
# how many, but not what it found, so every fact needed to act on it (the two
# versions, the remedy command) required re-running the sub-check by hand. That
# is how a stale-plugin deploy gap was read as cosmetic setup drift for a day.
# Still exactly one line: gap details are single-line by construction, and any
# stray newline is folded so the machine-readable contract holds.
gapdetails() {
  local out="" g
  if [ "${#GAPS[@]}" -gt 0 ]; then
    for g in "${GAPS[@]}"; do
      [ -n "$out" ] && out+="; "
      out+="${g%%|*}: $(tr '\n' ' ' <<<"${g#*|}" | sed 's/[[:space:]]*$//')"
    done
  fi
  echo "$out"
}

if [ -n "$ONELINE" ]; then
  if [ "${#GAPS[@]}" -eq 0 ]; then echo "herdr: wired"
  else echo "herdr: ${#GAPS[@]} gap(s) — $(gapdetails)"; fi
fi

if [ "$MODE" = "check" ]; then
  [ "${#GAPS[@]}" -eq 0 ] && exit 0 || exit 1
fi

# ── fix mode: close what is safely automatable, print the rest ───────────────
[ -n "$ONELINE" ] && { echo "herdr-setup.sh: --oneline is check-only" >&2; exit 64; }

if [ "${#GAPS[@]}" -eq 0 ] && [ -z "$INTEGRATION_MISSING" ]; then
  echo "nothing to fix — the cockpit is wired."
  exit 0
fi

echo
echo "fixing what can be safely automated:"

if [ -n "$PLUGIN_DISABLED" ] && [ -n "$SERVER_UP" ]; then
  echo "→ herdr plugin enable ralph-herdr"
  "$HERDR" plugin enable ralph-herdr
fi

if [ -n "$PLUGIN_MISSING" ] && [ -n "$SERVER_UP" ]; then
  if [ -d "$REPO/plugin/ralph-herdr" ]; then
    echo "→ herdr plugin link $REPO/plugin/ralph-herdr"
    "$HERDR" plugin link "$REPO/plugin/ralph-herdr"
  else
    echo "→ herdr plugin install $PLUGIN_SPEC"
    "$HERDR" plugin install "$PLUGIN_SPEC"
  fi
fi

if [ -n "$INTEGRATION_MISSING" ] && [ -n "$SERVER_UP" ]; then
  echo "→ herdr integration install claude"
  "$HERDR" integration install claude || echo "  (integration install failed — optional, continuing)"
fi

# Everything left needs a human hand (installs, auth, env) — print exact
# commands rather than guessing at package managers or touching credentials.
manual=0
if [ "${#GAPS[@]}" -gt 0 ]; then
  for g in "${GAPS[@]}"; do
    case "${g%%|*}" in
      ralph-herdr-plugin) continue ;; # handled above (when the server was up)
      *)
        [ "$manual" -eq 0 ] && { echo; echo "remaining manual steps:"; manual=1; }
        echo "  ${g%%|*}: ${g#*|}"
        ;;
    esac
  done
fi
[ "$manual" -eq 0 ] && echo "done."
exit 0
