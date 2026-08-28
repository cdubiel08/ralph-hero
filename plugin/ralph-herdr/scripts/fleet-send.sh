#!/usr/bin/env bash
# fleet-send.sh — send one templated team message to a live agent (2026-08-19
# audit, D5: 251 multi-KB `herdr agent prompt` heredocs re-invented a message
# grammar per session; this owns it once). Role-agnostic to-address in
# GH-2216 (topology H): dispatch→lead briefs and lead→dispatch replies ride
# the identical protocol.
#
#   fleet-send.sh AGENT VERB [-m MSG] [--file PATH] [--found TEXT]
#                 [--changed TEXT] [--wait MS]
#   fleet-send.sh --lead [EPIC] VERB [...]
#   fleet-send.sh --dispatch VERB [...]
#
#   AGENT   a live agent name copied from `herdr agent list` (never guessed)
#   --lead [EPIC]
#           the standing o-lane lead. With EPIC, resolved by enumeration:
#           `board who lead EPIC --json` lists the live grammar-matched
#           panes, and zero-or-many is a refusal (exit 5 / 6), never a
#           guess. Without EPIC, $RALPH_HERDR_LEAD — the chain-of-command
#           address the spawn path stamped (D4.2) — is used verbatim.
#   --dispatch
#           the live dispatch seat, resolved via `board who dispatch
#           --json` (token-stamped panes only — a token-less hero is
#           invisible there, and the refusal names the durable lane: the
#           board, D5.1).
#   VERB    the kind verb — one word naming what this message IS:
#           status | ack | handoff | blocked | done | review | question |
#           brief …  Stamped `:v1` in the template's KIND field (D2.1): the
#           caller never types the version, so a richer dispatch protocol
#           bumps the stamp without a second family.
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
#   5  no live match for a role target — the refusal names the durable lane
#   6  ambiguous role target — the live names are printed; name one
#   1  malformed response / bad invocation
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() { sed -n '2,53p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

[ "$#" -ge 2 ] || { usage >&2; exit 64; }

# The to-address (GH-2216): a literal agent name, or a role resolved by
# enumeration. Role resolution delegates to the board's phone book — the one
# owner of the herd-address grammar (GH-2209/GH-2211) — and refuses on
# zero-or-many: the wrong session is worse than no session.
AGENT="" ROLE=""
case "$1" in
  --lead)
    ROLE=lead
    shift
    EPIC=""
    case "${1-}" in *[!0-9]* | '') ;; *) EPIC="$1"; shift ;; esac
    if [ -n "$EPIC" ]; then
      who=$("$BOARD" who lead "$EPIC" --json 2>&1) ||
        { echo "fleet-send: board who lead $EPIC failed:" >&2; printf '%s\n' "$who" >&2; exit 1; }
      count=$(printf '%s' "$who" | jq -r '.live | length' 2>/dev/null) || count=""
      case "$count" in
        1) AGENT=$(printf '%s' "$who" | jq -r '.live[0].name') ;;
        0 | "")
          evaluated=$(printf '%s' "$who" | jq -r '.agentsEvaluated // false' 2>/dev/null) || evaluated=false
          [ "$evaluated" = "true" ] && why="no live pane matches lane o + the epic" || why="the herd could not be read"
          echo "fleet-send: no live lead for GH-$EPIC ($why)." >&2
          echo "fleet-send: the durable lane is the board (C9, GH-2179): \`board move NNN human-needed --why …\` routes to the lead and the TTL bounds the wait; \`work-team.sh $EPIC\` respawns it." >&2
          exit 5
          ;;
        *)
          echo "fleet-send: ambiguous — $(printf '%s' "$who" | jq -r '[.live[].name] | join(", ")') all match GH-$EPIC's lead. Name one explicitly; never guess." >&2
          exit 6
          ;;
      esac
    elif [ -n "${RALPH_HERDR_LEAD:-}" ]; then
      # The chain-of-command address the spawn path stamped (D4.2) — used
      # verbatim, the same trust `reply FROM` extends to the transport.
      AGENT="$RALPH_HERDR_LEAD"
    else
      echo "fleet-send: --lead needs the epic number when \$RALPH_HERDR_LEAD is not stamped (this pane was not spawned by a lead)." >&2
      exit 64
    fi
    ;;
  --dispatch)
    ROLE=dispatch
    shift
    who=$("$BOARD" who dispatch --json 2>&1) ||
      { echo "fleet-send: board who dispatch failed:" >&2; printf '%s\n' "$who" >&2; exit 1; }
    count=$(printf '%s' "$who" | jq -r '.live | length' 2>/dev/null) || count=""
    case "$count" in
      1) AGENT=$(printf '%s' "$who" | jq -r '.live[0].name') ;;
      0 | "")
        echo "fleet-send: no live dispatch seat (token-stamped panes only — a token-less hero is invisible here)." >&2
        echo "fleet-send: dispatch's durable address IS the board (D5.1) — \`board comment NNN -m …\`; the inbox reads the board." >&2
        exit 5
        ;;
      *)
        echo "fleet-send: ambiguous — $(printf '%s' "$who" | jq -r '[.live[].name] | join(", ")') all claim the dispatch seat. Name one explicitly; never guess." >&2
        exit 6
        ;;
    esac
    ;;
  *)
    AGENT="$1"
    shift
    ;;
esac
[ "$#" -ge 1 ] || { usage >&2; exit 64; }
VERB="$1"
shift

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
  if [ -n "$ROLE" ] || [ "$lane" = "o" ] || { [ -n "${RALPH_HERDR_LEAD:-}" ] && [ "$AGENT" = "$RALPH_HERDR_LEAD" ]; }; then
    echo "fleet-send: --wait stripped — $AGENT is a standing seat (${ROLE:-lead}), and a seat blocked on your reply while you wait on its is the documented deadlock (both sides sit in agent prompt --wait forever). Sending without the wait." >&2
    WAIT_MS=""
  fi
fi

sender="${RALPH_HERDR_SENDER:-$(whoami)@$(hostname -s 2>/dev/null || hostname)}"
[ -n "${HERDR_PANE_ID:-}" ] && sender="$sender (pane $HERDR_PANE_ID)"
ts=$(date -u +%FT%TZ)

# KIND is stamped :v1 by this script (D2.1, GH-2216) — the caller never
# types the version, so a richer dispatch protocol bumps the stamp, not the
# family. One protocol on both transports: peer-msg.sh stamps the same field.
body="[fleet-send] KIND: $VERB:v1
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
