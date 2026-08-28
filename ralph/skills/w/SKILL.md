---
description: Whisper — send one templated message to a live agent. Thin front-end over the GH-2216 wrappers, choosing the lane by target shape: a literal agent name or the role flags --lead [EPIC] / --dispatch ride the herd lane (fleet-send.sh, roles resolved through the board's phone book), an issue-number target rides the peer transport (peer-msg.sh composes, SendMessage carries). Triggers on "/ralph:w", "whisper", "tell the lead …", "message dispatch", "ping w1743-…", "send a note to the session on 2183".
argument-hint: "[AGENT | --lead [EPIC] | --dispatch | NNN] [verb] <message>"
context: inline
model: sonnet
allowed-tools:
  - Read
  - Bash
  - ListAgents
  - SendMessage
---

# /ralph:w — whisper this target

Compose-and-send, nothing else: the wrappers own the grammar, the resolution,
and the refusals (GH-2216, unit H of #2208); this skill picks the lane, fills
the flags, and relays the verdict. The wrappers live in the ralph-herdr plugin
install — resolve the root once
(`herdr plugin list --json | jq -r '.result.plugins[]|select(.plugin_id=="ralph-herdr").plugin_root'`)
and it is `<herdr-plugin-root>` below. No herdr plugin → no wrappers → the
board is the lane (`board comment NNN -m …` / `board answer NNN -m …`); say
so and stop. A wrapper that rejects a role flag, or is missing outright, is
a STALE INSTALL (herdr has no auto-update): run
`bash ${CLAUDE_PLUGIN_ROOT}/scripts/herdr-setup.sh check`, which names the
reinstall command on drift — never work around it with a raw prompt.

**Lane by target shape** — both lanes stamp the same versioned KIND protocol:

- **Agent name or role flag** (`w1743-…` copied from `herdr agent list`, never
  guessed; `--lead [EPIC]`; `--dispatch`) → the herd lane:
  `bash <herdr-plugin-root>/scripts/fleet-send.sh <target> <verb> -m "<message>"`.
  Roles resolve through the board's phone book — `board who lead EPIC` /
  `board who dispatch`; bare `--lead` uses `$RALPH_HERDR_LEAD`, the
  chain-of-command address the spawn stamped (D4.2). Exit 5 (no live match)
  and 6 (ambiguous) are refusals that name the durable lane — relay them
  verbatim and stop; never pick a session yourself, never fall back to a raw
  `herdr agent prompt`.
- **Issue number** (the live session driving that unit) → the peer transport:
  `bash <herdr-plugin-root>/scripts/peer-msg.sh brief <NNN> <verb> --candidates "<ListAgents names>" -m "<message>"`,
  then pass the printed TO/BODY to SendMessage **verbatim** — the script
  composes, it never sends. Exit 2 = that session is not running (the board is
  the lane); exit 3 = two live sessions match — name one explicitly, never
  guess.

**verb** is one lowercase word naming what the message IS — `question`,
`finding`, `correction`, `brief`, `status`, `answer` — derived from the
message when the user gave none.

**What a whisper may carry (GH-1890):** newly-created knowledge and
questions. State ("I'm In Review") and assignment ("take this unit") are
never sent — the board is the data plane, and work is claimed, never pushed.
Anything worth having tomorrow goes on the board; the message at most points
at it.

**Report honestly.** Herd lane: relay the wrapper's own verdict line
(delivered / unconfirmed — look at the pane, don't blind-retry / refused /
unreachable). Peer lane: "sent; unknown whether read" — the transport
acknowledges acceptance, and there is deliberately no read receipt. One
whisper per invocation; a refusal ends it — the refusal text already names
the remedy.
