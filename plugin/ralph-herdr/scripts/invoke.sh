#!/usr/bin/env bash
# invoke.sh — open a ralph-herdr plugin pane in a NAMED repo's workspace,
# resolved by an explicit repo path (GH-2291).
#
# Every `herdr-plugin.toml` action resolves its target repo from
# HERDR_PLUGIN_CONTEXT_JSON's `workspace_cwd`/`focused_pane_cwd` — whichever
# workspace currently has UI FOCUS. Invoked from a shell via `herdr plugin
# action invoke <id> --plugin ralph-herdr`, that reads whatever the human
# last clicked, not the invoking shell's own cwd — so on a multi-repo machine
# the documented one-liner can silently target the wrong repo's board
# (GH-2269 made that VISIBLE; this closes the gap it left: no way to target
# a repo by NAME from the CLI).
#
# `herdr plugin pane open` — the exact primitive every action already
# execs — takes `--workspace`/`--target-pane`/`--cwd` and never reads
# HERDR_PLUGIN_CONTEXT_JSON at all (confirmed against the installed 0.8.2
# binary: a pane opened with an explicit --cwd/--target-pane landed in the
# named workspace regardless of which one had focus). So this script never
# reads that env var either — it resolves the target workspace itself, by
# matching a REPO PATH against `herdr workspace list`'s own worktree record.
#
#   invoke.sh <repo-path> <entrypoint> [--placement overlay|split|tab|zoomed]
#             [--direction right|down] [--focus|--no-focus] [--workspace ID]
#
# Matching is two-tier, because `herdr workspace list` reports two different
# facts under `.worktree` and only one of them names THIS workspace's own
# directory:
#   - `checkout_path` is where THIS workspace's shell actually sits — the
#     main checkout for a non-linked workspace, or the linked worktree's own
#     directory for one opened via `herdr worktree create/open`.
#   - `repo_root` is the REPO FAMILY's main checkout — the SAME value for
#     every worktree of one repo, main included.
# A repo-path argument names a specific directory, so an exact checkout_path
# match is unambiguous and wins outright. Only when nothing matches on
# checkout_path does repo_root serve as a coarser fallback — and because
# repo_root is shared across every worktree of a repo, that fallback matching
# MORE than one workspace is the ordinary case for a repo with several
# worktrees open, not a corner case: it means "this repo is open in several
# places, and a bare repo-root guess cannot tell which one you meant." That
# refuses, listing the candidates, rather than picking one silently — the
# same "a different checkout" scenario this plugin's docs already name
# elsewhere (herdr-plugin-sync.sh). `--workspace <id>` is the disambiguation
# escape hatch, and skips path matching entirely.
#
# Paths are compared after `cd DIR && pwd -P` (the realpath idiom this repo
# already uses in scope.sh) on both sides, so a symlinked path (macOS's
# /tmp -> /private/tmp being the routine case) still matches its physical
# spelling instead of silently missing.
#
# `split`/`zoomed` placement need an existing pane id INSIDE the target
# workspace (`--target-pane`), not `--workspace` alone — confirmed via a live
# `invalid_params` refusal on `--workspace` alone with `--placement split`.
# `tab` placement is confirmed the opposite way (dispatch-up.sh already ships
# `--workspace <id> --placement tab` with no target-pane). `overlay` is
# UNVERIFIED either way and is treated like `tab` here (no target-pane
# required) rather than guessed into the split/zoomed bucket — flagged should
# it ever need moving.
#
# lib.sh is NOT sourced (the cockpit-open.sh precedent): it dies at source
# time without a resolvable board CLI in $PWD, and this script's whole point
# is to work from a shell that has no board configured at all, targeting a
# repo that does. Only the herdr transport boundary is needed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=sanitize.sh
. "$SCRIPT_DIR/sanitize.sh"
# shellcheck source=transport.sh
. "$SCRIPT_DIR/transport.sh"

HERDR="${HERDR_BIN_PATH:-herdr}"

die() { echo "${0##*/}: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
usage: invoke.sh <repo-path> <entrypoint> [OPTIONS]

Open a ralph-herdr plugin pane targeting the repo at <repo-path>, resolved by
matching herdr's own workspace records — never by which workspace has UI
focus. Use this instead of `herdr plugin action invoke <id> --plugin
ralph-herdr` on a machine with more than one repo open in herdr.

  <repo-path>    a directory herdr already has open as a workspace (the main
                 checkout or a linked worktree) — not necessarily $PWD
  <entrypoint>   the [[panes]] entrypoint id (cockpit, dashboard, work-fleet,
                 work-next, hero, deliver-pass, tend-pass, doctor, …)

Options:
  --placement overlay|split|tab|zoomed   default: split
  --direction right|down                 default: right (split only)
  --focus | --no-focus                   default: --focus
  --workspace ID   skip path matching — use this exact herdr workspace id
                   (the disambiguation escape hatch when a repo has several
                   worktrees open and repo-path alone cannot tell them apart)
  -h, --help

No matching workspace, or more than one with no --workspace to pick among
them, refuses rather than guessing.
EOF
}

[ "$#" -ge 1 ] || { usage >&2; exit 2; }
case "$1" in -h | --help) usage; exit 0 ;; esac
[ "$#" -ge 2 ] || die "needs a repo path AND an entrypoint (got only '$1'); see --help"

REPO_PATH="$1"
ENTRYPOINT="$2"
shift 2

PLACEMENT="split"
DIRECTION="right"
FOCUS_FLAG="--focus"
WORKSPACE_OVERRIDE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --placement)
      [ "$#" -ge 2 ] || die "--placement needs a value (overlay|split|tab|zoomed)"
      PLACEMENT="$2"
      shift 2
      ;;
    --direction)
      [ "$#" -ge 2 ] || die "--direction needs a value (right|down)"
      DIRECTION="$2"
      shift 2
      ;;
    --focus) FOCUS_FLAG="--focus"; shift ;;
    --no-focus) FOCUS_FLAG="--no-focus"; shift ;;
    --workspace)
      [ "$#" -ge 2 ] || die "--workspace needs a value (an id from 'herdr workspace list')"
      WORKSPACE_OVERRIDE="$2"
      shift 2
      ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument '$1' (see --help)" ;;
  esac
done

case "$PLACEMENT" in
  overlay | split | tab | zoomed) ;;
  *) die "--placement must be one of overlay, split, tab, zoomed (got '$PLACEMENT')" ;;
esac
case "$DIRECTION" in
  right | down) ;;
  *) die "--direction must be right or down (got '$DIRECTION')" ;;
esac

# _iv_realpath DIR — `cd DIR && pwd -P`, or DIR unchanged (trailing slash
# stripped) when it cannot be resolved locally (herdr may report a path from
# another machine's worktree, or one whose directory has since been removed —
# neither should crash the match, just fall back to a literal comparison).
_iv_realpath() {
  local p
  p=$(cd "$1" 2>/dev/null && pwd -P) || p="$1"
  printf '%s' "$p" | sed 's|/*$||'
}

REPO_REAL=$(cd "$REPO_PATH" 2>/dev/null && pwd -P) ||
  die "repo path '$REPO_PATH' does not exist or is not a directory"
TARGET=$(printf '%s' "$REPO_REAL" | sed 's|/*$||')

ws_out=$(ralph_herdr_call workspace_list workspace list) ||
  die "cannot read the herdr workspace list ($(ralph_herdr_err_code "${ws_out:-}" || true)) — refusing to guess which workspace holds $REPO_PATH"

ws_id="" cwd_path=""

if [ -n "$WORKSPACE_OVERRIDE" ]; then
  ws_id="$WORKSPACE_OVERRIDE"
  jq -e --arg w "$ws_id" '[.workspaces[]? | select(.workspace_id == $w)] | length == 1' \
    <<<"$ws_out" >/dev/null 2>&1 ||
    die "--workspace $ws_id names no workspace herdr currently has open (see 'herdr workspace list')"
  cwd_path="$TARGET"
else
  # Augment each workspace row with the path spellings it should match on:
  # the raw checkout_path/repo_root herdr reported, plus each one's local
  # realpath when it still resolves. Two separate arrays (never merged) is
  # what keeps checkout_path an unambiguous win over the repo-family fallback.
  augmented=""
  while IFS= read -r wsrow; do
    [ -n "$wsrow" ] || continue
    cp=$(jq -r '.worktree.checkout_path // empty' <<<"$wsrow")
    rr=$(jq -r '.worktree.repo_root // empty' <<<"$wsrow")
    pcp="" prr=""
    [ -z "$cp" ] || pcp=$(_iv_realpath "$cp")
    [ -z "$rr" ] || prr=$(_iv_realpath "$rr")
    row=$(jq -c --arg cp "$cp" --arg rr "$rr" --arg pcp "$pcp" --arg prr "$prr" '
      . + {
        _cp_paths: ([$cp, $pcp] | map(select(. != "")) | unique),
        _rr_paths: ([$rr, $prr] | map(select(. != "")) | unique)
      }' <<<"$wsrow")
    augmented="$augmented$row"$'\n'
  done < <(jq -c '.workspaces[]?' <<<"$ws_out")
  ws_augmented=$(jq -sc '{workspaces: .}' <<<"$augmented")

  primary=$(jq -c --arg t "$TARGET" '[.workspaces[] | select(._cp_paths | index($t))]' <<<"$ws_augmented")
  n_primary=$(jq 'length' <<<"$primary")

  _iv_candidates() {
    jq -r '.[] | "  \(.workspace_id) (\(.label // "?")) — \(.worktree.checkout_path // .worktree.repo_root // "no worktree recorded")"' <<<"$1"
  }

  if [ "$n_primary" -eq 1 ]; then
    match=$(jq -c '.[0]' <<<"$primary")
  elif [ "$n_primary" -gt 1 ]; then
    die "$n_primary herdr workspaces are open at exactly '$TARGET':
$(_iv_candidates "$primary")
pass --workspace <id> to pick one"
  else
    fallback=$(jq -c --arg t "$TARGET" '[.workspaces[] | select(._rr_paths | index($t))]' <<<"$ws_augmented")
    n_fallback=$(jq 'length' <<<"$fallback")
    if [ "$n_fallback" -eq 1 ]; then
      match=$(jq -c '.[0]' <<<"$fallback")
    elif [ "$n_fallback" -gt 1 ]; then
      die "'$REPO_PATH' names a repo open in $n_fallback different checkouts (a different worktree each) — repo-root alone cannot tell them apart:
$(_iv_candidates "$fallback")
pass --workspace <id> to pick one, or name the exact checkout's own path"
    else
      die "no herdr workspace has repo path '$REPO_PATH' (resolved: $TARGET) open — open it first ('herdr workspace create --cwd $REPO_PATH' or 'herdr worktree create/open'), or check the path"
    fi
  fi
  ws_id=$(jq -r '.workspace_id' <<<"$match")
  cwd_path=$(jq -r '.worktree.checkout_path // empty' <<<"$match")
  [ -n "$cwd_path" ] || cwd_path="$TARGET"
fi

# split/zoomed need an existing pane id INSIDE the target workspace; herdr
# refuses --workspace alone for either (invalid_params, live-confirmed for
# split). tab and overlay do not (dispatch-up.sh already ships tab this way).
target_pane=""
case "$PLACEMENT" in
  split | zoomed)
    panes_out=$(ralph_herdr_call pane_list pane list --workspace "$ws_id") ||
      die "cannot list panes in workspace $ws_id ($(ralph_herdr_err_code "${panes_out:-}" || true)) — needed to place a $PLACEMENT pane"
    target_pane=$(jq -r '.panes[0].pane_id // empty' <<<"$panes_out")
    [ -n "$target_pane" ] || die "workspace $ws_id has no panes to place a $PLACEMENT pane against — open one first, or use --placement tab"
    ;;
esac

open_args=(plugin pane open --plugin "${HERDR_PLUGIN_ID:-ralph-herdr}" --entrypoint "$ENTRYPOINT" --placement "$PLACEMENT")
if [ -n "$target_pane" ]; then
  open_args+=(--target-pane "$target_pane")
else
  open_args+=(--workspace "$ws_id")
fi
[ "$PLACEMENT" = split ] && open_args+=(--direction "$DIRECTION")
open_args+=(--cwd "$cwd_path" "$FOCUS_FLAG")

# A hand-off, not a read: nothing here parses the response, so this execs
# straight into herdr rather than routing through ralph_herdr_call — the same
# choice cockpit-open.sh and link-open.sh already make for their terminal
# `plugin pane open` call.
exec "$HERDR" "${open_args[@]}"
