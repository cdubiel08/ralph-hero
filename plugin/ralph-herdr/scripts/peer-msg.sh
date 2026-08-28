#!/usr/bin/env bash
# peer-msg.sh — compose one templated message for the cross-session
# SendMessage transport (GH-2183, unit G of #2176; role-agnostic v2 in
# GH-2216, unit H of #2208). fleet-send.sh's sibling:
# that script owns the herdr-prompt grammar, this one owns the SendMessage
# side. herdr keeps spawn/lifecycle; SendMessage carries the brief→reply
# loops on hub edges (lead↔worker, hero↔lead) and the GH-1890 knowledge
# edge between peers.
#
# A shell script cannot invoke a harness tool, so the contract is: everything
# DETERMINISTIC happens here — address resolution (enumerate, never
# construct), liveness, the message grammar, the reporting discipline — and
# stdout is the exact TO/BODY pair the caller passes to SendMessage
# verbatim. NOTHING IS SENT BY THIS SCRIPT.
#
#   peer-msg.sh brief TO VERB [--candidates LIST] [-m MSG] [--re N]
#               [--file PATH] [--found TEXT] [--changed TEXT]
#   peer-msg.sh reply FROM VERB [-m MSG] [--re N]
#               [--file PATH] [--found TEXT] [--changed TEXT]
#   peer-msg.sh live TO [--candidates LIST]
#
#   TO      role-agnostic (GH-2216, topology H): an ISSUE number (the live
#           session driving that unit), `lead`, or `dispatch`. The lead and
#           the hero hold no worktree (D3.2/D3.1), so their peer addresses
#           root at the SOURCE-CHECKOUT leaf — `board peer lead|dispatch`
#           owns that rule; every source-checkout session shares the leaf,
#           so a hero beside a lead is a refusal, never a guess (the herd
#           lane, fleet-send --lead/--dispatch, resolves roles precisely).
#
#   brief   initiate to the live session TO names. The peer namespace
#           is harness-owned (GH-1918): an address is ENUMERATED, NEVER
#           CONSTRUCTED, so the live peer names the caller's transport
#           listed (ListAgents) arrive via --candidates (comma- or
#           newline-separated) or stdin, and resolution is delegated to
#           `board peer`, which holds the prefix rules and both branch
#           grammars. Zero matches from a non-empty list → exit 2 (that
#           session is not running; the board is the lane). Two → exit 3
#           (name one explicitly — the wrong session is worse than no
#           session). An EMPTY candidate set → exit 64: that is a question
#           never asked, not a negative answer (GH-2245).
#   reply   answer a message you received. FROM is the transport's own
#           `from` address, used VERBATIM — resolution would be a second
#           guess at a fact the transport already handed over. A herdr agent
#           name (w1234-…, o1234-…) is refused: it does not resolve on the
#           peer transport (the observed GH-1890 §9.1 bounce); copy the
#           message's from line, or use fleet-send.sh for the herdr lane.
#           No liveness probe: a dead address fails loudly at send, which
#           is the sanctioned discovery (§9.2).
#   live    the liveness check alone — resolve TO against the enumerated
#           candidates and print the one address. Same exits as brief.
#
#   VERB    one lowercase word naming what this message IS:
#           question | finding | correction | objection | brief | answer …
#           The template's KIND field is VERSIONED (D2.1) — this script
#           stamps `:v1` on it; callers never type the version, so a richer
#           dispatch protocol later bumps the stamp without a second family.
#   -m      free-form body (optional)
#   --file / --found / --changed
#           the three structured sections; omitted sections print `-` so a
#           reader can grep the template without wondering whether a blank
#           means "nothing" or "not filled in"
#   --re N  the issue this message is about, when TO does not name it
#           (reply, and role-target briefs)
#
# Exit: 0 composed (live: the address is stdout, alone)
#       2 no live peer for TO — the board is the durable lane (C9 for a lead)
#       3 ambiguous — two live sessions match; name one explicitly
#      64 bad invocation (incl. a herdr name where a peer address belongs,
#          and an empty candidate set — enumerate first, GH-2245)
#       1 the board CLI itself failed — the resolver's error is printed
#
# The discipline the sender carries out of here (stderr on every compose):
# sent ≠ read — SendMessage returning success means the transport accepted
# the message, never that it entered the peer's context; there is
# deliberately no read receipt, so the honest report is "sent; unknown
# whether read". Work that REQUIRES the message land goes on the board,
# where a reader is verifiable by state. Payload stays GH-1890's whitelist:
# newly-created knowledge and questions — state and assignment are never
# sent (the board is the data plane, and hub briefs ride the spawn path).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() { sed -n '2,78p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
udie() {
  echo "peer-msg: $*" >&2
  exit 64
}

[ "$#" -ge 1 ] || {
  usage >&2
  exit 64
}
SUB="$1"
shift

case "$SUB" in
  brief | reply | live) ;;
  -h | --help)
    usage
    exit 0
    ;;
  *) udie "unknown subcommand '$SUB' — brief, reply, or live" ;;
esac

TARGET="" VERB="" MSG="" FILE_SEC="" FOUND_SEC="" CHANGED_SEC="" CANDS="" RE_SEC=""
if [ "$SUB" = "live" ]; then
  [ "$#" -ge 1 ] || udie "live needs the ISSUE number"
  TARGET="$1"
  shift
else
  [ "$#" -ge 2 ] || {
    usage >&2
    exit 64
  }
  TARGET="$1"
  VERB="$2"
  shift 2
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    -m) MSG="${2-}"; shift ;;
    --file) FILE_SEC="${2-}"; shift ;;
    --found) FOUND_SEC="${2-}"; shift ;;
    --changed) CHANGED_SEC="${2-}"; shift ;;
    --candidates) CANDS="${2-}"; shift ;;
    --re) RE_SEC="${2-}"; shift ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) udie "unknown argument '$1'" ;;
  esac
  shift
done

if [ "$SUB" != "live" ]; then
  # LC_ALL=C, because a bare [a-z] range collates case-insensitively under
  # en_US locales — measured here: 'STATUS' passed the glob-pattern version.
  printf '%s\n' "$VERB" | LC_ALL=C grep -q '^[a-z-]\{1,\}$' ||
    udie "VERB must be one lowercase word (got '$VERB') — it names what this message IS"
fi

# The role-agnostic TO grammar (GH-2216): an issue number, or a role.
if [ "$SUB" != "reply" ]; then
  case "$TARGET" in
    lead | dispatch) ;;
    '' | *[!0-9]*) udie "TO must be an issue number, 'lead', or 'dispatch' (got '$TARGET')" ;;
  esac
fi

# resolve_addr TO — the enumerate-never-construct step, delegated to
# `board peer` (GH-1918 holds the worker prefix rule there; GH-2216 the
# role targets' source-checkout leaf; a second copy here is the drift shape
# GH-1843 names). Candidates come from --candidates or stdin — whatever the
# caller's transport enumerated; this script never invents one. Prints the
# address; the exit code carries the refusal. On failed liveness the refusal
# names the DURABLE lane (D2.3): the C9 board comment, whose escalation TTL
# already bounds the wait on a lead.
resolve_addr() {
  local target="$1" raw out kind
  if [ -n "$CANDS" ]; then
    raw="$CANDS"
  else
    raw=$(cat)
  fi
  # An empty candidate set is not an enumeration that came back empty — it is
  # a question that was never asked (GH-2245). Rendering it as the zero-matches
  # answer would tell the caller "dead peer, use the board" when the truth is
  # "you forgot to enumerate", silently downgrading all live delivery.
  if ! printf '%s' "$raw" | LC_ALL=C grep -q '[^[:space:],]'; then
    echo "peer-msg: no candidates supplied — cannot tell a dead peer from an unasked question." >&2
    echo "peer-msg: enumerate your transport's peers (ListAgents) and pass them via --candidates or on stdin." >&2
    return 64
  fi
  out=$("$BOARD" peer "$target" --candidates "$raw" --json 2>&1) || true
  kind=$(printf '%s' "$out" | jq -r '.kind // empty' 2>/dev/null || true)
  case "$kind" in
    resolved)
      printf '%s' "$out" | jq -r '.address'
      return 0
      ;;
    none)
      case "$target" in
        lead)
          echo "peer-msg: no live source-checkout session to carry this to the lead." >&2
          echo "peer-msg: the durable lane is C9 (GH-2179): \`board move <your-unit> human-needed --why \"…\"\` routes to the lead and the escalation TTL bounds the wait; \`board comment <epic> -m …\` for non-escalation knowledge." >&2
          ;;
        dispatch)
          echo "peer-msg: no live source-checkout session to carry this to dispatch." >&2
          echo "peer-msg: dispatch's durable address IS the board (D5.1) — \`board comment NNN -m …\`; the inbox reads the board." >&2
          ;;
        *)
          echo "peer-msg: no live peer is driving #$target among the enumerated candidates — that session is not running." >&2
          echo "peer-msg: file the message on the board instead (\`board comment $target -m …\` / \`board answer $target -m …\`) — a message no live peer can read is lost; the board is not." >&2
          ;;
      esac
      return 2
      ;;
    ambiguous)
      case "$target" in
        lead | dispatch)
          echo "peer-msg: ambiguous — $(printf '%s' "$out" | jq -r '.candidates | join(", ")') share the source checkout, and the peer namespace cannot tell the $target from its neighbors. Name one explicitly (pass its exact address as --candidates), or take the herd lane: fleet-send.sh --$target resolves roles precisely (token-stamped names)." >&2
          ;;
        *)
          echo "peer-msg: ambiguous — $(printf '%s' "$out" | jq -r '.candidates | join(", ")') are distinct live sessions for #$target. Name one explicitly (pass its exact address as --candidates); never guess." >&2
          ;;
      esac
      return 3
      ;;
    *)
      echo "peer-msg: could not resolve a peer address — board peer failed:" >&2
      printf '%s\n' "$out" >&2
      return 1
      ;;
  esac
}

if [ "$SUB" = "live" ]; then
  resolve_addr "$TARGET"
  exit "$?"
fi

RE_LINE="-"
if [ "$SUB" = "brief" ]; then
  addr=$(resolve_addr "$TARGET") || exit "$?"
  case "$TARGET" in
    lead | dispatch) [ -n "$RE_SEC" ] && RE_LINE="#$RE_SEC" ;;
    *) RE_LINE="#$TARGET" ;;
  esac
else
  addr="$TARGET"
  case "$addr" in
    '' | *[[:space:]]*) udie "FROM must be one peer address copied from the message's own 'from' line (got '$addr')" ;;
  esac
  # The observed GH-1890 §9.1 bounce, refused before it is re-lived: a herdr
  # agent name is a different namespace and does not resolve on the peer
  # transport.
  if ralph_agent_parse "$addr" >/dev/null 2>&1; then
    udie "'$addr' is a herdr agent name, and herdr names do not resolve on the peer transport — reply to the message's transport 'from' address verbatim, or use fleet-send.sh for the herdr lane"
  fi
  [ -n "$RE_SEC" ] && RE_LINE="#$RE_SEC"
fi

sender="${RALPH_HERDR_SENDER:-$(whoami)@$(hostname -s 2>/dev/null || hostname)}"
[ -n "${HERDR_PANE_ID:-}" ] && sender="$sender (pane $HERDR_PANE_ID)"
ts=$(date -u +%FT%TZ)

# KIND is stamped :v1 by this script (D2.1) — the caller never types the
# version, so a richer dispatch protocol bumps the stamp, not the family.
body="[peer-msg] KIND: $SUB:v1 VERB: $VERB RE: $RE_LINE
FROM: $sender AT: $ts
REPLY: to this message's transport 'from' address, verbatim — a peer address is enumerated, never constructed, and a herdr agent name does not resolve here
FILE: ${FILE_SEC:--}
FOUND: ${FOUND_SEC:--}
CHANGED: ${CHANGED_SEC:--}"
[ -n "$MSG" ] && body="$body

$MSG"

printf 'TO: %s\nBODY:\n%s\n' "$addr" "$body"

echo "peer-msg: pass TO and BODY to SendMessage verbatim — nothing was sent by this script." >&2
echo "peer-msg: sent ≠ read — the transport's success means accepted, never read; report \"sent; unknown whether read\", not \"delivered\" or \"considered\"." >&2
echo "peer-msg: anything worth having tomorrow goes on the board (\`board comment\` / \`board answer\`); the message may at most point at it. Payload is GH-1890's whitelist — knowledge and questions, never state or assignment." >&2
