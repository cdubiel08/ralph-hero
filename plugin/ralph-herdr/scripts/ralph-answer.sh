#!/usr/bin/env bash
# ralph-answer.sh — popup pane: walk Human Needed, answer ONE item,
# COMMENT-FIRST.
#
# The durable half is GitHub: `board answer N -m` posts the **Answer** issue
# comment BEFORE any state write (board.ts owns that ordering) — if this pane,
# or herdr itself, vanishes mid-answer, the decision is on the record and the
# item retries cleanly. Only AFTER the durable half does the decorative half
# run: when a live session owns N, a `herdr agent prompt` nudges it to re-read
# the issue — and its delivery is reported honestly, never assumed.
#
# Flow: list Human Needed → pick a number → see the issue's latest comments
# (bounded gh read — the question being answered) → type the answer, mail(1)
# style (end with a single '.' line) → board answer → optional nudge.
#
# Knobs:
#   RALPH_HERDR_ANSWER_TAIL      lines of `gh issue view --comments` shown
#                                (default 40)
#   RALPH_HERDR_ANSWER_NUDGE_MS  --wait timeout for the post-answer nudge
#                                (default 15000)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

# The popup must not flash-and-vanish on a refusal or a failed read.
hold() {
  printf '\npress Enter to close '
  read -r _ || true
}

# stdout only into the JSON — the board shim's stderr can carry harmless
# noise on a SUCCESSFUL read (npx cold-cache install chatter, node
# ExperimentalWarning lines), and merging it would garble the parse into a
# false "herd calm". stderr is kept aside and surfaced on the failure
# branch, where it is the diagnostic.
hn_err=$(mktemp "${TMPDIR:-/tmp}/ralph-answer-err.XXXXXX")
if ! hn_json=$("$BOARD" list --state "Human Needed" --json 2>"$hn_err"); then
  echo "board list failed — cannot walk the queue:"
  head -5 "$hn_err"
  rm -f "$hn_err"
  hold
  exit 1
fi
rm -f "$hn_err"
# A 0-exit with unparseable stdout is a failed read, never an empty queue —
# an empty queue and a failed query are different facts.
if ! count=$(jq '.items | length' <<<"$hn_json" 2>/dev/null); then
  echo "board list printed unparseable JSON — cannot walk the queue:"
  printf '%s\n' "$hn_json" | head -5
  hold
  exit 1
fi

if [ "$count" -eq 0 ]; then
  echo "nothing in Human Needed — herd calm"
  hold
  exit 0
fi

echo "${C_BOLD}Human Needed ($count)${C_RST}"
jq -r '.items | to_entries[] | "  [\(.key + 1)] #\(.value.number)  \(.value.title)"' <<<"$hn_json"

printf '\nanswer which? [1-%s, q to close]: ' "$count"
read -r pick || pick="q"
case "$pick" in
  q | Q | '') exit 0 ;;
  *[!0-9]* | 0*) echo "not a queue position: '$pick'"; hold; exit 1 ;;
esac
if [ "$pick" -gt "$count" ]; then
  echo "only $count item(s) in the queue"
  hold
  exit 1
fi
n=$(jq -r --argjson i "$((pick - 1))" '.items[$i].number' <<<"$hn_json")

# The question being answered: the issue's latest comments, bounded. gh
# resolves the repo from origin (the pane cwd is the workspace repo); a
# failed read costs context, never the verb.
echo
echo "${C_BOLD}── #$n, latest comments (tail) ──${C_RST}"
if command -v gh >/dev/null 2>&1; then
  gh issue view "$n" --comments 2>/dev/null | tail -n "${RALPH_HERDR_ANSWER_TAIL:-40}" ||
    echo "(gh read failed — read the issue in a browser; the answer still posts)"
else
  echo "(gh not installed — read the issue in a browser; the answer still posts)"
fi

echo
echo "type the answer — end with a single '.' on its own line (mail(1) style; empty answer aborts):"
ans=""
while IFS= read -r ln; do
  [ "$ln" = "." ] && break
  ans="${ans}${ans:+
}$ln"
done
if [ -z "$(printf '%s' "$ans" | tr -d '[:space:]')" ]; then
  echo "empty answer — nothing posted"
  hold
  exit 0
fi

# ── Durable half: the comment-first verb ─────────────────────────────────────
# `board answer` posts the **Answer** comment before the Human Needed →
# In Progress move (board.ts owns the ordering). On a board CLI too old for
# the verb, the SAME ordering is preserved by hand: gh comment (durable)
# first, board move second — never the reverse.
if "$BOARD" help 2>/dev/null | grep -q '^  answer NNN'; then
  if ! "$BOARD" answer "$n" -m "$ans"; then
    echo
    echo "board answer failed — if the **Answer** comment posted (the durable half),"
    echo "retry the MOVE (board claim $n), not the answer; re-answering would duplicate it."
    hold
    exit 1
  fi
else
  echo "(this board CLI predates the answer verb — falling back to gh comment + board move, same ordering)"
  command -v gh >/dev/null 2>&1 || { echo "…and gh is not installed: cannot post the durable half. Nothing written."; hold; exit 1; }
  gh issue comment "$n" --body "**Answer** (ralph-herdr):

$ans" || { echo "gh comment failed — nothing written, safe to retry"; hold; exit 1; }
  "$BOARD" move "$n" "In Progress" ||
    echo "the answer comment IS on the record — only the move failed; retry with: board claim $n"
fi

# ── Decorative half: nudge the paused session, honestly ──────────────────────
live=$(ralph_agents_json 2>/dev/null | jq -rs --arg legacy "gh-$n" --arg pfx "w$n-" '
  [.[] | select(.name == $legacy or (.name | startswith($pfx))) | .name]
  | first // empty') || live=""
if [ -z "$live" ]; then
  # Honest about where the item landed: the answer verb moved it Human
  # Needed → In Progress under THIS CLI's claim — it is not in `board next`,
  # so no spawner will find it on its own.
  echo "no live session for #$n — the answer is on the issue and #$n is now In Progress under your claim;"
  echo "spawn a session for it (click the issue link) or requeue it with: board move $n Backlog"
  hold
  exit 0
fi

out=$(ralph_herdr_agent_prompt "$live" "answered on issue — re-read #$n and resume" \
  "${RALPH_HERDR_ANSWER_NUDGE_MS:-15000}" 2>/dev/null) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  echo "nudged $live — prompt delivered and the session moved on"
else
  # rc 4 is herdr's wait expiry: submitted, unconfirmed. Every other nonzero
  # means the prompt did not land — a refusal or a transport fault.
  if [ "$rc" -eq 4 ]; then
    echo "nudge to $live sent but not confirmed within ${RALPH_HERDR_ANSWER_NUDGE_MS:-15000}ms — check its pane; the answer IS on the issue. By hand:"
  else
    code=$(ralph_herdr_err_code "$out")
    echo "nudge to $live refused (${code:-transport failure}) — the answer IS on the issue; by hand:"
  fi
  echo "  herdr agent prompt $live 'answered on issue — re-read #$n and resume'"
fi

hold
exit 0
