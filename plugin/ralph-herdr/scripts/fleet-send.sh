#!/usr/bin/env bash
# fleet-send.sh — send one templated team message to a live agent (2026-08-19
# audit, D5: 251 multi-KB `herdr agent prompt` heredocs re-invented a message
# grammar per session; this owns it once).
#
#   fleet-send.sh AGENT VERB [-m MSG] [--file PATH] [--found TEXT]
#                 [--changed TEXT] [--wait MS]
#
#   AGENT   a live agent name copied from `herdr agent list` (never guessed)
#   VERB    the status verb — one word naming what this message IS:
#           status | ack | handoff | blocked | done | review | question …
#   -m      free-form body (optional)
#   --file / --found / --changed
#           the three structured sections; omitted sections print `-` so a
#           reader can grep the template without wondering whether a blank
#           means "nothing" or "not filled in"
#   --wait MS
#           confirm delivery via herdr's own wait. STRIPPED (loudly) when the
#           target is the lead — an orchestrator (`o` lane, or
#           $RALPH_HERDR_LEAD) that is itself blocked waiting on YOUR reply
#           deadlocks against a sender waiting on its: both sides sit in
#           `agent prompt --wait` forever. The message still goes; only the
#           wait is dropped.
#
# Delivery goes through the strict transport adapter (transport.sh), which is
# what maps a herdr stderr refusal to a DISTINCT exit code instead of the
# "server unreachable" every 2>/dev/null turns it into:
#
#   0  delivered (and confirmed, when --wait was honored)
#   4  delivered but NOT confirmed within --wait — look at the pane, don't retry
#   2  herdr refused — the error code is printed
#   3  herdr unreachable / timed out
#   1  malformed response / bad invocation
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() { sed -n '2,35p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

[ "$#" -ge 2 ] || { usage >&2; exit 64; }
AGENT="$1"
VERB="$2"
shift 2

MSG="" FILE_SEC="" FOUND_SEC="" CHANGED_SEC="" WAIT_MS=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -m) MSG="${2-}"; shift ;;
    --file) FILE_SEC="${2-}"; shift ;;
    --found) FOUND_SEC="${2-}"; shift ;;
    --changed) CHANGED_SEC="${2-}"; shift ;;
    --wait) WAIT_MS="${2-}"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument '$1'" ;;
  esac
  shift
done

# LC_ALL=C, because a bare [a-z] range collates case-insensitively under
# en_US locales — measured by peer-msg.test.sh: 'STATUS' passed the
# glob-pattern version of this check (GH-2183).
printf '%s\n' "$VERB" | LC_ALL=C grep -q '^[a-z-]\{1,\}$' ||
  die "VERB must be one lowercase word (got '$VERB') — it names what this message IS"

# The lead check: an o-lane target, or whatever $RALPH_HERDR_LEAD names.
# Stripping (not refusing) is deliberate — the MESSAGE is the point, and a
# refusal that loses it to protect a wait nobody needed is the wrong trade.
if [ -n "$WAIT_MS" ]; then
  lane=""
  if parsed=$(ralph_agent_parse "$AGENT" 2>/dev/null); then
    lane="${parsed%% *}"
  fi
  if [ "$lane" = "o" ] || { [ -n "${RALPH_HERDR_LEAD:-}" ] && [ "$AGENT" = "$RALPH_HERDR_LEAD" ]; }; then
    echo "fleet-send: --wait stripped — $AGENT is the lead, and a lead blocked on your reply while you wait on its is the documented deadlock (both sides sit in agent prompt --wait forever). Sending without the wait." >&2
    WAIT_MS=""
  fi
fi

sender="${RALPH_HERDR_SENDER:-$(whoami)@$(hostname -s 2>/dev/null || hostname)}"
[ -n "${HERDR_PANE_ID:-}" ] && sender="$sender (pane $HERDR_PANE_ID)"
ts=$(date -u +%FT%TZ)

body="[fleet-send] STATUS: $VERB
FROM: $sender AT: $ts
FILE: ${FILE_SEC:--}
FOUND: ${FOUND_SEC:--}
CHANGED: ${CHANGED_SEC:--}"
[ -n "$MSG" ] && body="$body

$MSG"

rc=0
out=$(ralph_herdr_agent_prompt "$AGENT" "$body" "$WAIT_MS") || rc=$?
case "$rc" in
  0)
    if [ -n "$WAIT_MS" ]; then echo "delivered to $AGENT (confirmed by state change)"; else echo "delivered to $AGENT"; fi
    ;;
  4) echo "delivered to $AGENT but NOT confirmed within ${WAIT_MS}ms — look at the pane, do not blind-retry" >&2 ;;
  2) echo "herdr refused the prompt to $AGENT: $(ralph_herdr_err_code "$out") — $(ralph_herdr_err_message "$out")" >&2 ;;
  3) echo "herdr did not answer — the prompt to $AGENT may or may not have landed; read the pane before retrying" >&2 ;;
  *) echo "unreadable response from herdr (transport rc $rc) — see the diagnostic above" >&2 ;;
esac
exit "$rc"
