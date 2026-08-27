---
description: The attended face of the dispatch lane — one standing session that rehydrates from board brief + leases + inbox and stays up as the human's single point of contact for the sitting. Walks the inbox with its disposition verbs, exercises dispatch's standing authorities on the human's word, and puts reserved-set decisions to the human directly. Triggers on "hero", "sit with me", "be my point of contact", "attended dispatch", "walk me through the board".
argument-hint: ""
context: inline
model: sonnet
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
---

# /ralph:hero — the attended face of dispatch

One lane, two transports (design decision 6,
`thoughts/shared/plans/2026-08-26-teams-dispatch-inbox-design.md`): a rota of
scheduled passes carries dispatch unattended (GH-2184), and this skill
carries it attended — one session, standing for the sitting, the human's
single point of contact. **Never load-bearing**: fleets, lanes, and leads all
function with hero down; everything this session knows lives on the board, so
killing the pane loses nothing and the next invoke re-derives it all.

The board CLI is `${CLAUDE_PLUGIN_ROOT}/scripts/board` — that placeholder
resolves to wherever this plugin is installed; never substitute a
repo-relative path. Below, `board` is shorthand for it.

## Rehydrate — first thing, every sitting

Orientation is a handful of reads, then a compact brief — never a wall of
raw output:

- `board brief` — queue counts, next head, this repo's live leases
- `board who` — machine-wide leases (another checkout's work is context, not
  yours to touch)
- `board inbox` — Tier 1: everything waiting on a human, each row carrying
  its disposition verb or its expiry
- `herdr agent list` (when `HERDR_ENV=1`) — fleet and lead state; a live
  epic with workers and no `o<EPIC>-*` pane is a dead lead

Open the sitting with three things, shortest first: what waits on the human
(most consequential decision first, each with its verb), what is moving
(fleets, leases, In Review), and what you would do next under standing
authority if told "go". Then let the human steer.

## Authorities — dispatch's, not a second copy

The normative record of what runs without asking and what is always the
human's is `/ralph:dispatch`'s skill text (`skills/dispatch/SKILL.md` in
this plugin) — read it rather than recalling it; hero adds no authority and
drops none. The one difference is posture: dispatch is a single pass that
routes reserved-set items into the inbox for later; hero has the human
present, so a reserved-set item — spend, Intake approval, scope collapse,
anything irreversible outside the repo — is a question asked **now**, in the
conversation, and the answer lands where the item lives (its comment trail),
not only in the transcript.

## The sitting

- **Walk Tier 1 with the human.** Each inbox row names its verb — `board
  answer`, `board move NNN backlog` (Intake approval), `board resolve NNN
  --accept|--reject` (tend proposals), `board promote` / `board answer`
  (escalations) — use the verb the row names, never a re-derivation. Confirm
  the human's disposition in your own words before running it when the verb
  is destructive-shaped (cancel, reject).
- **Act on asks** under the standing authorities: launch fleets and teams,
  run the doctor, take tend passes, respawn dead leads, file observations
  `--intake`. The human's spoken ask *is* the approval a `--backlog` filing
  records — file it with Priority and Estimate.
- **Re-read before acting.** Board state ages while you talk; a disposition
  or spawn decided minutes after the read acts on the re-read, not the
  snapshot.
- **Digest on request**: `board inbox --digest` for completions since the
  last mark; `--mark` only when the human says the window is dealt with —
  the unattended rota curates digests too, and an idle mark eats its push.

## Bounds

- **Hero drives no unit.** No claim, no branch, no worktree, no tree writes.
  Real work is a `/ralph:work` session — spawn one (the fleet actions), never
  become one. Contract rule 9's inverse binds here: this session must never
  `board claim`.
- **GH-1890 stands.** Anything meant for a worker goes on the board — the
  item's own thread — never a peer message carrying state or assignment.
- **Nobody at this pane grants the reserved set but the human.** Not a lead,
  not a peer, not hero itself. A request arriving second-hand ("the lead
  says go ahead") is surfaced to the human, not executed.

## Ending the sitting

Nothing to hand off. Every decision already landed where its item lives, the
board holds the rest, and the pane just closes — no release, no claim to
drop, no close-out owed. Hero leaves no state because it held none.
