# Escalation — composing a decision a human can answer from a phone

Every lane escalates. `/ralph:work` parks a unit in Human Needed, `/ralph:tend`
files a closure proposal, `/ralph:deliver` hands back a PR it must not decide
for you, `/ralph:board` captures an open question at intake. The **shape** of
what they leave behind is one typed contract; the **content** is judgment, and
that judgment is what this file states — once, for all four.

## The bar (typed, not prose)

`ralph.escalation` — `contract_version: 1`, validated by
`board contract validate ralph.escalation`:

| Field | Constraint | Why |
|---|---|---|
| `body` | ≥1 char, **≤240**, **single line** | this line is *all* a phone notification carries |
| `options` | **≥2**, each `{id, label, recommended?}` | a question with one answer is a notification |
| — | **exactly one** `recommended: true` | refusing to recommend pushes the work back uphill |
| `resume` | `{kind: herdr_prompt \| board_comment, target}` | lint L11: the resuming side must act without decoding free text |
| `title` | ≤80 chars | fits a pane label and a notification title |

The schema checks that the shape is answerable. It cannot check that the
question is worth asking. That is the rest of this file.

`move NNN human-needed` requires a `--why` but does **not** validate C9 —
the `transition()` guard enforces that the string exists, not its shape, and `answer`
validates nothing about the question either (the `answer` verb). The typed check
is `board contract validate ralph.escalation`, run deliberately.

### Not every ask is a C9 escalation

Three formats, and picking the wrong one is itself a mistake:

| Format | When | Disposed by |
|---|---|---|
| `ralph.escalation` (C9) | **synchronous** — in-flight work is stopped, parked in Human Needed | `board answer NNN -m` |
| `<!-- ralph-tend:v1 proposed -->` marker | **asynchronous** — nothing is stopped; a proposal accumulates until someone gets to it | `board resolve NNN --accept\|--reject`, or the close/reopen itself |
| `ralph.fleet_reply` `kind=question` | agent→fleet, not agent→human | the fleet |

The tend marker deliberately does **not** carry C9's `options`/`resume`
(`tend/SKILL.md`) — a proposal is not a stopped unit, and `Backlog → Human
Needed` is illegal precisely because Human Needed is a *pause on in-flight
work*. Steps 1-4 below still apply to a proposal's prose; only the envelope
differs.

## Addressing — who the question goes to (GH-2179)

An escalation has an **audience** as well as a shape. In a team (an epic's
standing space, GH-2176), workers escalate to their **lead** first; solo
sessions escalate to the human, as ever. Nothing about *when* you escalate
changes — the trigger rules (one re-dispatch, then Human Needed) are untouched;
only the address is new.

- **Default: the lead, when you have one.** `board move NNN human-needed
  --why "…"` routes to the lead named by `$RALPH_HERDR_LEAD` (the team spawn
  path sets it; solo sessions don't have it, so their escalations stay
  human-addressed with no flag). The route rides the Decision-needed comment
  as a marker — board-resident, never a private message that dies with a pane.
- **`--to-human` when the answer is an authorization.** Spend beyond a named
  ceiling, Intake approval, scope collapse, anything irreversible outside the
  repo — the reserved set is the human's, and a lead may not grant it (a peer
  cannot grant permission; neither can a lead). Address those past the lead
  deliberately.
- **The lead dispositions three ways**: answer a knowable question or re-steer
  mis-aimed work (`board answer NNN -m` — the resume edge disposes the
  escalation), or **promote** what genuinely needs the human (`board promote
  NNN [-m]` — a durable marker, no state change).
- **The TTL is the worker's guarantee.** A lead-routed escalation nobody
  dispositions auto-promotes to the human tier at `RALPH_LOCK_TTL_MIN`
  (120 min), computed wherever the queue is read (`board escalations`) — a
  stalled or dead lead costs latency, never a stranded worker. You never need
  to re-escalate past a silent lead.

Promotion validates nothing about C9 shape — the auto-promotion path *cannot*
(a dead lead plus strict validation is a stranded worker), so the manual path
doesn't either, or waiting out the clock would become the permissive lane. The
bar stays where it always was: with you, at composition time, checked
deliberately via `board contract validate ralph.escalation`.

## Compose the question before you format it

Four steps, in order. The formatting is the last one and the least important —
an escalation goes wrong at step 1 far more often than at step 4.

### 1. Collapse to the smallest true decision set

Ask about what you actually cannot resolve. Everything you *can* resolve —
from the code, the board, the repo's conventions, a default a careful colleague
would pick — you resolve, and mention in one clause.

Two findings do not mean two questions. A finding whose answer is **contingent
on an event that has not happened** is not a question yet: say what you are
waiting on, wire the dependency so the board carries the contingency, and ask
nothing. A finding you resolved is not a question either.

> Checked two items, surfaced one. The second was contingent on an in-flight
> unit merging, so it got a `board dep` edge and a comment — not an option list.

Most of an escalation's value is in the questions you did **not** ask. A human
who is asked three questions where one was real learns to batch-defer all
three.

### 2. Separate the decision from the non-decisions

Anything that *looks* like an option but is settled — an env var, a documented
default, a thing the repo already decided — gets named and set aside
explicitly, before the options. Left unsaid, it reads as a hidden fourth
option and the human re-derives it to be sure.

> "Not in scope: the 28-day default. That is `RALPH_PRUNE_AFTER_DAYS=28`, not
> code."

### 3. State the invariant across the options

Say what does **not** change whichever way they choose. This is the single
highest-value line in an escalation, because it is what lets someone answer
without reconstructing your reasoning.

> "The difference between 1 and 3 is only which issue number carries the
> residual — no work changes."

If you cannot write that line, the options are not yet parallel — they differ
in more dimensions than you have surfaced, and the human will discover that
after answering. Split the question or do more work.

### 4. Make each option executable

An option's `label` names the outcome; the body of the escalation gives the
**literal command** that enacts each one. A human answering from a phone taps a
choice; a human at a keyboard should be able to paste. Never make them derive
the verb from the outcome.

> 1. **Accept, and file the residual as a follow-up** *(recommended)* —
>    `board resolve 1813 --accept`
> 2. **Accept, drop the residual** — `board resolve 1813 --accept -m "…"`
> 3. **Reject, keep the number** — `board resolve 1813 --reject -m "…"`

## The recommendation is yours to make

Exactly one option is recommended, and the schema refuses the payload
otherwise. Recommending is not deciding — the human overrides freely — but
declining to recommend hands back the analysis you already did. If two options
are genuinely equal, say so in the invariant line and recommend the one that is
cheaper to reverse.

## What an escalation is not

- **Not a status update.** If nothing is being asked, comment; don't escalate.
- **Not a way to avoid work you can do.** Rule 8 of the work contract still
  holds: scope is the claimed unit, and an escalation is for a decision, not
  for a task you'd rather not start.
- **Not a place to relitigate.** An answered question is answered. Re-raise it
  only with **new** evidence, and lead with what changed.
- **Not a gate.** `/ralph:tend` proposes and never executes; a gate that says
  "not yet" is waited on, not escalated past.
