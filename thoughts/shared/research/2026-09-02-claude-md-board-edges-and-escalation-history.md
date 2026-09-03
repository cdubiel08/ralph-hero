---
date: 2026-09-02
issue: GH-2078, GH-2204, GH-2179, GH-2218
topic: Backward-edge tightening, the resume edge, and escalation arbitration — rationale behind the rules stated in CLAUDE.md
status: shipped
---

# Board machine: backward edges, resume, and escalation routing

## Backward edges are tightened (GH-2078, the second GH-2060 unit)

The two demotions — `In Progress → Backlog` and `In Review → In Progress` —
refuse without a `--why`, which lands as a comment before the state write:
backward moves are exceptional, and the reason should be auditable instead of
implicit. `release` already carried it as `-m`; `board claim` gained `--why`
because claiming an In Review item IS the demotion lane GH-1816 showed being
over-used.

`Human Needed → Backlog` is REMOVED from the machine. An answered item
resumes (`→ In Progress`) or dies (`→ Canceled`) — a parking edge out of an
escalation loses the question, since the item re-enters the eligible pool and
the next claimant re-derives the context the escalation existed to hand over.
"Answered: not now, park it" is a recorded-but-undecided case (possibly
`Human Needed → Intake`); it does not resurrect the removed edge in the
meantime.

Deliberately untouched: doctor's stale-claim demotion (a direct field write,
In Progress only, already commented) and `reconcile` (reality lane, never
MACHINE-guarded).

## The resume edge belongs to the RESUMING agent (GH-2204)

`board answer NNN -m` is comment-only: the **Answer** comment lands
(timestamped by a `ralph-answer:v1` marker) and the item STAYS Human Needed.
The driving session takes `Human Needed → In Progress` itself via
`board claim NNN`, so the session→unit binding (GH-1948), the worktree lock
(GH-1956) and the size ceiling (GH-2134) all bind on the actual driver, never
on the answering proxy.

The old transition claimed to the ANSWERER, and that produced three concrete
failures: a hero pane broke on rule 9 (one unit per session) at its second
answer; `deliver-queue` read a phantom `local-session-active`; and a dead
driver left the item In Progress + claimed + nobody — invisible to
work-fleet for a full TTL.

`--resume` keeps the one-invocation form for self-answer (answerer == driver).
The answered-but-unresumed window is surfaced, never silent: `board
escalations` marks those rows `ANSWERED … resume pending`, and doctor's
`answer-unresumed` `i` line ages them past `RALPH_SMELL_ANSWER_MIN` (30 min;
an unreadable answer clock ages as overdue — toward visibility).

## Escalations carry an audience (GH-2179, the GH-2176 arbitration unit)

In a team, a worker's `move NNN human-needed --why` routes to the epic's
**lead** — the route rides the Decision-needed comment as a
`ralph-escalation:v1` marker (no marker = human-addressed: every pre-existing
escalation and every reconcile correction, by construction). Default keys on
`$RALPH_HERDR_LEAD` (the team spawn path sets it; solo sessions keep the
status quo untouched); `--to-human` forces the reserved-set direction,
`--to-lead <name>` is explicit.

The lead dispositions via `answer` (answer/re-steer — the resuming session's
claim then disposes it by state, GH-2204) or `board promote NNN [-m]`
(durable marker, no state change — Human Needed is already the right state;
promotion changes the audience, not the machine).

**Promotion writes the inbox directly (GH-2218, the topology-J amendment).**
`board inbox` Tier 1 withholds a lead-routed escalation still inside its
window as a counted `with leads` line — never a decision row, never dropped
(the GH-2108 rule) — and a promotion, the lead's or the TTL's, is the
admission. One arbitration hop total: worker → lead → inbox. Dispatch reads
the inbox like the human does and is messageable, but adjudicates nothing by
default — reachable, never a rung. An unreadable trail admits the row:
failing toward visibility, the same direction as auto-promotion.

**The TTL bound is computed at read time, never by a cron**: `board
escalations` classifies every Human Needed item, and a lead-routed escalation
unadjudicated for `RALPH_LOCK_TTL_MIN` renders auto-promoted — same shape as
claim staleness, no tracking state to drift; a dead lead costs latency, never
a stranded worker (an unparseable route timestamp fails the same direction).

Promotion deliberately validates no C9 shape: the TTL path cannot validate by
construction, so a stricter manual path would train leads to wait out the
clock; `board contract validate ralph.escalation` stays the deliberate check.
