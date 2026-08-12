#!/usr/bin/env bash
# link-open.sh — [[link_handlers]] target: a clicked github.com issue/PR URL
# becomes attention.
#
# Runs in the ACTION process (attend pattern — focusing needs no pane; the
# offer path opens its own popup). The clicked URL arrives in
# HERDR_PLUGIN_CLICKED_URL (context JSON carries it as .clicked_url too,
# alongside .link_handler_id — herdr 0.8.0, verified against the installed
# binary's schema). The manifest pattern is deliberately GENERIC
# (any github.com owner/repo) — scope judgment lives HERE, where the board
# config is readable:
#
#   in scope   (URL owner/repo == the workspace repo's board scope)
#     live ralph agent for N (gh-N or w<N>-*)  → herdr agent focus
#     no live agent                            → link-offer popup
#                                                (board state + spawn offer)
#   deep sub-resource / fragment tail (/files, /commits/<sha>,
#     #issuecomment-N) → the OS browser even in scope: the click named a
#     SPECIFIC view no pane can show, and the focus path has no escape
#     hatch. A bare ?query or trailing slash is link plumbing, not intent.
#   out of scope / no scope resolvable / no cwd → hand the URL to the OS
#     browser — another repo's issue is not this board's business, and a
#     click must never dead-end.
#
# GHE boards never reach this script: the pattern matches github.com only.
# Read-only apart from focus / popup-open / browser-open; never writes board
# state. Exits 0 on every non-parse path — a link click is not a build step.
set -euo pipefail

HERDR="${HERDR_BIN_PATH:-herdr}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# ledger.sh only for _ralph_ledger_scope (side-effect free at source time);
# lib.sh is NOT sourced here — it dies without a board CLI, and the
# out-of-scope browser path must survive non-ralph repos.
# shellcheck source=ledger.sh
. "$SCRIPT_DIR/ledger.sh"
# The Herdr boundary (GH-1774): the herd read below must be repository-scoped,
# and these three have no board-CLI dependency to trip the same wire lib.sh does.
# shellcheck source=sanitize.sh
. "$SCRIPT_DIR/sanitize.sh"
# shellcheck source=transport.sh
. "$SCRIPT_DIR/transport.sh"
# shellcheck source=scope.sh
. "$SCRIPT_DIR/scope.sh"

log() { echo "$(date -u +%FT%TZ) link-open: $*"; }

# open_url URL — hand off to the OS browser (macos/linux per the manifest).
open_url() {
  if command -v open >/dev/null 2>&1; then
    open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1"
  else
    log "no browser opener (open/xdg-open) — URL: $1"
  fi
}

url="${HERDR_PLUGIN_CLICKED_URL:-}"
if [ -z "$url" ] && [ -n "${HERDR_PLUGIN_CONTEXT_JSON:-}" ]; then
  url=$(jq -r '.clicked_url // empty' <<<"$HERDR_PLUGIN_CONTEXT_JSON" 2>/dev/null) || url=""
fi
if [ -z "$url" ]; then
  # Reachable from the plain action menu, where nothing was clicked.
  log "no clicked URL — this action is the [[link_handlers]] target; click a github.com issue/PR link instead"
  exit 0
fi

re='^https://github\.com/([^/]+)/([^/]+)/(issues|pull)/([0-9]+)([/?#].*)?$'
if ! [[ $url =~ $re ]]; then
  log "unparseable URL '$url' — opening in the browser"
  open_url "$url"
  exit 0
fi
u_owner="${BASH_REMATCH[1]}" u_repo="${BASH_REMATCH[2]}" u_kind="${BASH_REMATCH[3]}" n="${BASH_REMATCH[4]}"
u_tail="${BASH_REMATCH[5]:-}"

# Deep sub-resource / fragment tails are browser intent (see header): a
# path segment beyond a bare slash, or any #fragment, names a view the
# attention path would swallow. A ?query alone is plumbing and stays.
u_tail_path="${u_tail%%[?#]*}"
deep=0
case "$u_tail" in *'#'*) deep=1 ;; esac
case "$u_tail_path" in *[!/]*) deep=1 ;; esac
if [ "$deep" -eq 1 ]; then
  log "$u_owner/$u_repo#$n carries a deep-link tail ('$u_tail') — opening in the browser"
  open_url "$url"
  exit 0
fi

cwd=$(jq -r '.workspace_cwd // .focused_pane_cwd // empty' <<<"${HERDR_PLUGIN_CONTEXT_JSON:-null}" 2>/dev/null) || cwd=""
scope=""
if [ -n "$cwd" ]; then
  root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || root="$cwd"
  scope=$(_ralph_ledger_scope "$root" 2>/dev/null) || scope=""
fi
# Case-insensitive compare: GitHub owner/repo names are.
lc() { printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]'; }
if [ -n "$scope" ]; then
  scope_disp="${scope%% *}/${scope#* }"
else
  scope_disp="none resolvable"
fi
if [ -z "$scope" ] || [ "$(lc "$scope_disp")" != "$(lc "$u_owner/$u_repo")" ]; then
  log "$u_owner/$u_repo#$n is outside this workspace's board scope ($scope_disp) — opening in the browser"
  open_url "$url"
  exit 0
fi

# In scope. A live session for N gets the focus — same name shapes as
# spawn_work_session's pre-check (legacy gh-N or any grammar-B w<N>-*).
# Scoped: in a shared session another repository's GH-N worker carries the
# identical name, and focusing it would jump the human into someone else's
# work on an unrelated issue. An unreadable herd degrades to the offer popup —
# the honest "I could not find a session" branch, which is also what the human
# gets when there genuinely is none.
# Scope from the COMMON repo root, not the clicked pane's cwd. In a worker's
# worktree pane that cwd resolves to the linked worktree, which matches only
# agents in that same worktree — so clicking an issue link from inside one
# worker's pane would miss the live session for a different issue and offer to
# spawn a duplicate. --git-common-dir points at the parent checkout's .git for
# a linked worktree and at our own otherwise; its parent is the root both share.
# Derived TEXTUALLY by stripping the trailing /.git, never by cd + pwd: pwd
# resolves symlinks, and on macOS that alone renames /var/... to /private/var/...
# — a different spelling of the same directory, which then matches nothing the
# server reported.
link_scope_root() {
  local d common
  d="${cwd:-$PWD}"
  common=$(git -C "$d" rev-parse --git-common-dir 2>/dev/null) || { printf '%s' "$d"; return 0; }
  case "$common" in
    .git) printf '%s' "$d"; return 0 ;;
    /*) : ;;
    *) common="$d/$common" ;;
  esac
  printf '%s' "${common%/.git}"
}
live=$(ralph_scoped_agents_now "$(link_scope_root)" 2>/dev/null | jq -rs --arg legacy "gh-$n" --arg pfx "w$n-" '
  [.[] | select(.name == $legacy or (.name | startswith($pfx))) | .name]
  | first // empty' 2>/dev/null) || live=""
if [ -n "$live" ]; then
  log "focusing $live for #$n"
  exec "$HERDR" agent focus "$live"
fi

# No session — offer one. --focus is deliberate: the human clicked the link.
log "no live session for #$n — opening the offer popup"
exec "$HERDR" plugin pane open --plugin "${HERDR_PLUGIN_ID:-ralph-herdr}" \
  --entrypoint link-offer --placement popup --cwd "$cwd" --focus \
  --env "RALPH_HERDR_LINK_ISSUE=$n" \
  --env "RALPH_HERDR_LINK_URL=$url" \
  --env "RALPH_HERDR_LINK_KIND=$u_kind"
