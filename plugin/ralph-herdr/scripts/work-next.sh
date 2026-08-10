#!/usr/bin/env bash
# work-next.sh — cockpit action: spawn one /ralph:work session for board-next.
#
# No board mutation happens here: `board next` is a read, and the claim is
# taken by /ralph:work inside the spawned session. This script is herdr
# orchestration only; after the spawn it execs into notify-watch.sh so the
# cockpit pane becomes the session's attention surface.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

billing_guard

N=$("$BOARD" next --json | jq -r '.next.number // empty')
if [ -z "$N" ]; then
  echo "queue empty — nothing to spawn"
  exit 0
fi

BRANCH="feature/GH-$N"

# Never branch from local HEAD: herdr's `worktree create` bases NEW branches
# on the parent checkout's HEAD unless told otherwise, so fetch and pin
# --base origin/main (tick.sh parity). The fresh base only holds for
# brand-new branches: an existing feature/GH-N branch is silently checked
# out as-is (--base ignored) — resumed, possibly behind origin/main, and the
# session is expected to rebase. Create refuses only when the CHECKOUT
# already exists — then open it instead: resuming beats re-creating.
git -C "$REPO" fetch -q origin main
if ! out=$("$HERDR" worktree create --cwd "$REPO" --branch "$BRANCH" --base origin/main --no-focus); then
  echo "worktree create refused (existing checkout is the usual cause) — opening instead"
  out=$("$HERDR" worktree open --cwd "$REPO" --branch "$BRANCH" --no-focus) \
    || die "neither worktree create nor worktree open succeeded for $BRANCH"
fi

# IDs are opaque server-local tokens — captured from the response, never
# predicted or derived.
pane=$(jq -r '.result.root_pane.pane_id // empty' <<<"$out")
[ -n "$pane" ] || die "no pane id in worktree response"

# A name collision means a live session already owns gh-$N — refuse, never
# improvise suffixes: two sessions on one issue is exactly what the board's
# claim protocol exists to prevent.
"$HERDR" agent start "gh-$N" --kind claude --pane "$pane" \
  || die "agent start gh-$N failed — a session for GH-$N is likely already live; not spawning a second"
# Past this point the agent is LIVE — a prompt-delivery failure must not exit
# silently under set -e and strand an idle session with no work.
"$HERDR" agent prompt "gh-$N" "/ralph:work $N" \
  || die "prompt delivery failed — agent gh-$N is LIVE and idle in pane $pane; prompt it manually: herdr agent prompt gh-$N \"/ralph:work $N\""

echo "spawned GH-$N on $BRANCH (pane $pane, agent gh-$N)"

exec "$SCRIPT_DIR/notify-watch.sh" "gh-$N"
