#!/usr/bin/env bash
# link-offer.sh — popup pane behind the issue/PR link handler: board state
# for the clicked item plus a three-key offer. Opened ONLY by link-open.sh
# (which validated scope and found no live session for N); the number/URL
# arrive via --env, never re-parsed here.
#
#   [s]  spawn a /ralph:work session for N — the same sanctioned path as
#        work-next (spawn_work_session: worktree, grammar-B name, C7 ledger
#        record, claim taken INSIDE the session), then this pane becomes the
#        session's notification watcher
#   [o]  open the URL in the OS browser
#   [q]  close
#
# Read-only until the human presses s; a PR-numbered click (kind=pull) shows
# whatever `board get N` honestly says — PRs share GitHub's number space with
# issues but are not board items, so the read usually fails and the spawn
# offer still stands for the human to judge. Honors RALPH_HERDR_DRY_RUN.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

# A popup closes the instant its command exits — refusals (billing guard,
# missing env, a lost spawn race) must stay readable. The deliberate [q]
# path drops the trap: the human asked for the close.
trap hold_pane EXIT

N="${RALPH_HERDR_LINK_ISSUE:-}"
URL="${RALPH_HERDR_LINK_URL:-}"
KIND="${RALPH_HERDR_LINK_KIND:-issues}"
case "$N" in '' | *[!0-9]*) die "no issue number in RALPH_HERDR_LINK_ISSUE — this pane is opened by link-open.sh, not by hand" ;; esac

# open_url URL — hand off to the OS browser (duplicated from link-open.sh:
# three lines beat a shared helper neither lib needs).
open_url() {
  if command -v open >/dev/null 2>&1; then
    open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1"
  else
    echo "no browser opener (open/xdg-open) found — URL: $1"
  fi
}

echo "${C_BOLD}#$N${C_RST} — $URL"
[ "$KIND" = "pull" ] && echo "${C_DIM}(a PR link — PRs share the issue number space but are not board items)${C_RST}"
echo
if state=$("$BOARD" get "$N" 2>&1); then
  printf '%s\n' "$state"
else
  echo "board get $N failed — not on this board (or a PR number):"
  printf '%s\n' "$state" | head -3
fi

while :; do
  printf '\n[s] spawn work session for #%s   [o] open in browser   [q] close: ' "$N"
  read -r -n 1 key || key="q"
  echo
  case "$key" in
    s | S)
      billing_guard
      ralph_plugin_freshness_notice
      # Queue JSON only feeds the slug/label derivation — #N need not be in
      # it (the agent name then takes the "work" slug).
      QUEUE_JSON=$("$BOARD" next --json 2>/dev/null) || QUEUE_JSON=""
      rc=0
      spawn_work_session "$N" "$QUEUE_JSON" || rc=$?
      case "$rc" in
        0)
          [ "${RALPH_HERDR_DRY_RUN:-}" = "true" ] && exit 0
          # This popup becomes the session's attention surface, work-next
          # style; the agent name is read back, never reconstructed.
          exec "$SCRIPT_DIR/notify-watch.sh" "${RALPH_HERDR_SPAWNED_AGENT:?spawn reported success without an agent name}"
          ;;
        2)
          # Lost a spawn race since link-open's check — the SKIP line above
          # names the winning session; nothing to watch from here.
          exit 0
          ;;
        *)
          echo "spawn failed for #$N (see above)"
          ;;
      esac
      ;;
    o | O)
      open_url "$URL"
      ;;
    q | Q | '')
      trap - EXIT
      exit 0
      ;;
    *)
      echo "unknown key '$key' — s, o, or q"
      ;;
  esac
done
