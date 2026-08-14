# Flat agent-to-agent messaging — spec

**Date:** 2026-08-14
**Issue:** GH-1890
**Status:** decided
**Decision:** The sibling edge is real and is sanctioned for one payload class — newly-created
knowledge. It is prohibited for state notification and for assignment. No inbox, no new
contract, no new namespace.

---

## 0. Provenance of this spec, which is also its evidence

A first draft of this spec rejected the sibling edge outright, on the strength of the v1
messaging record and the data-plane axiom. It included, in §5.3, a deliberately falsifiable
reopening condition: *a case that is (i) not discoverable from the board, (ii) actionable by
the recipient, and (iii) not a mutual-exclusion problem.*

While the draft was being written, two live peer sessions — the fleet orchestrator for
tonight's work and the investigator session — independently sent field evidence **through the
very edge under review**, and that evidence cleared the condition. The draft was wrong, in a
specific and interesting way (§2.4), and is revised rather than defended.

This is recorded at the top because the mechanism that produced the revision *is the subject
matter*: a peer correction, travelling an edge that a hub-and-spoke topology would have taxed
or dropped. A spec that rejected the sibling edge while being corrected by one would have been
refuted by its own footnotes.

The two accounts were sent independently and were **not** reconciled with each other before
reaching me — deliberately, so that disagreement between them would carry information. They
agree on every load-bearing fact. §12 records the evidence; §13 records what the sessions
proposed that this spec declines to adopt.

---

## 1. The decision

A general peer *message transport* — agent addressing, an inbox, delivery semantics, an unread
policy, dead-peer handling — is **rejected** (§5.3). A peer *edge* is **accepted**, scoped by
**payload class rather than by topology**:

| Payload | Lane | Why |
|---|---|---|
| **State** — "I moved to In Review", "I claimed this", "I'm still working" | **Do not send** | Already in the data plane. The axiom applies at full strength. |
| **Assignment** — "take this unit", "go do X" | **Do not send** | The measured v1 failure (§5.4). Work is claimed from the board, never pushed. |
| **Newly-created knowledge** — a reproducer, lineage evidence, a correction, a design objection | **Direct peer message** — or a board comment where the artifact should outlive the session | Not in the data plane *by definition*: it did not exist until a sibling made it. §2.4. |
| **A question a peer might answer** | **Board** — `board answer NNN -m` | Durable, already typed as C9, degrades to a human answer for free. §2.3, §8. |

Everything else in this spec follows from that table.

The six questions GH-1890 required be decided:

| Question | Decision |
|---|---|
| Should a sibling edge exist at all? | **Yes**, for one payload class. §2.4 |
| Addressing model | **None introduced.** Reply-to-sender and enumerate; do not construct. §9 |
| Which transport | Cross-session `SendMessage` for knowledge; the board for questions and for anything durable. §5 |
| What a message may authorize | **Nothing.** Zero write authority; a peer cannot grant permission. §6 |
| Backpressure | Bounded by scope, not by an unread policy. §7 |
| Same surface as the phone-answerable escalation path? | **The question path, yes. The knowledge path, no.** §8 |

---

## 2. The cases, walked through the axiom

The curated axiom `dont-notify-about-state-visible-through-data-plane` is not a flat
prohibition. Its line 26 leaves an aperture:

> Reserve push notifications for cases where polling is too slow, unobservable, or genuinely
> actionable for the recipient.

GH-1890 named three candidate cases. All three fail the aperture. A fourth, which the issue did
not name and the first draft did not consider, passes it — and that asymmetry is the finding.

### 2.1 "A deliver lane and a work lane touching the same branch"

Observable in board state, the claim field, and git refs. But this case does not fail on
observability — it fails on being a **mutual exclusion** problem, and messaging cannot provide
mutual exclusion. §3.

### 2.2 "Two work agents whose units share a file"

Genuinely not recorded anywhere: nothing on the board says unit A and unit B both touch
`src/x.ts`. But it fails the aperture's *third* clause — **not actionable by the recipient**.
Two work agents are structurally in two worktrees on two branches (one-writer design,
`:19-26`). Neither can prevent the other's edit; neither has authority over the other's tree. A
message here tells an agent "we may conflict" when its only available response is to keep
working. The conflict is adjudicated where it already is: at rebase and at the merge gate,
deterministically, by a tool that reads both trees.

The real defect it points at is **decomposition** — two units sharing a file were mis-split —
and the board already has the instrument (`board dep`, the tend lane's dedup pass). A message
would let a bad split keep running while narrating its own collision.

### 2.3 "An agent that knows the answer another one is blocked on"

Fails the aperture on **observability**, and it fails in an instructive direction. For a push to
happen, the knowing sibling must already know that its peer is blocked and on what. It learns
that by reading the Human Needed queue. **The push path contains the pull path as a prefix**,
then adds a transport on top of it.

What this case actually demands is *permission and a reader*, not a channel — and the write verb
already exists, typed:

> `board answer NNN -m "..."` is comment-first, makes the Human Needed → In Progress
> transition, and `--any-state` posts comment-only on an item outside Human Needed. A peer
> answering a peer is one already-sanctioned call. What was never written down is that a peer
> is allowed to make it.

### 2.4 The case the issue did not name: **newly-created knowledge**

The three cases above are all *state* — facts about what is happening, which the board either
records or should. The axiom is about state, and against state it is decisive.

The traffic that actually flowed tonight was not state. It was:

- a **live reproducer** for a bug, constructed by an investigator, sent to the session fixing it;
- **lineage evidence** read out of the ledgers and handed to the session that needed it;
- a **design objection** from a worker, arguing its fix should not absorb another issue — which
  changed what shipped;
- **three corrections**, each travelling from the party who could falsify a claim to the party
  who had made it.

None of this is discoverable by polling, for a reason that is not incidental: **it did not exist
until a sibling made it.** The data plane cannot contain a finding that has not been written
yet, and the agent best positioned to write it is frequently not the agent who needs it. The
axiom's test — "could the recipient learn this by checking the primary store?" — returns *no*,
and not because the store is slow.

So the first draft's error was a category error. It walked three state cases through a
state-notification axiom, got three noes, and generalized. Knowledge transfer is a different
payload and the axiom does not reach it.

### 2.5 The strongest single argument: falsification needs a return path

One case deserves separate statement because it is the load-bearing rationale, and it is
epistemic rather than about latency.

The investigator told the orchestrator that retiring a workspace "should have closed a lineage
record and didn't". The peer session read the actual ledgers, found one spawn event and no
`state` events, and demonstrated that the framing was the dramatic reading rather than the
supported one. The investigator retracted; the orchestrator, which had already repeated the
claim to the user, propagated the correction.

That correction exists **only because a flat reply path existed**. Routed through the hub, it is
one session's claim against another's, arriving at a busy coordinator as two reports — and the
cheap resolution is to believe whichever came first.

The value was not speed. It was that **the peer who could falsify a claim could reach the peer
who made it.** A hub topology is not merely a slower path for this; it is a *lossy* one, because
it converts a refutation into a competing opinion and then arbitrates it by priority. This is
the argument for the sibling edge, and it is stronger than the round-trip-cost argument GH-1890
opened with.

---

## 3. The one hazard a message cannot fix

The loop-agent-lanes spec admits, in its own weakest-points section (`:490-499`):

> **Work/deliver exclusion is probabilistic, not typed.** … an interactive `/ralph:work`
> session … never holds `tick.pid`; if it sits idle longer than `RALPH_SETTLE_MIN`, deliver can
> rebase and push a branch that live session still considers its own.

This is GH-1890's case 2.1, and it is the sharpest limit on the whole idea.

**Messaging cannot establish mutual exclusion.** Mutual exclusion needs an atomic operation with
a winner and a loser. A message has no winner. If deliver announces "I am about to rebase" and
work replies "don't", the two writes have already interleaved by the time the reply lands — the
out-of-order hazard v1 measured directly (`GH-0353:63`). Adding a channel here does not close
the race; it makes the race *harder to see*, because the trail then shows a warning that was
sent, which reads like a mitigation and is not one.

The fix for a probabilistic exclusion is a **typed exclusion** — the mechanism the fleet already
uses three times over (1:1 branch topology, the server-side agent-name mutex, the read-back-
verified board claim). This is filed as its own unit (§14), because a session that concluded
"build a channel" would have shipped the channel and left this race open behind it — which is
exactly the v1 pattern, where every fix was a message discipline and none was a mechanism.

**Evidential status: no data, which is not the same as no problem.** Asked whether tonight's
fleet produced a near-miss, the orchestrator checked rather than recalled and reported that **no
deliver lane ran at all** — the selector was read every tick but never acted on, and every unit
was spawned serially, one issue per branch. The race needs an enabled deliver loop concurrent
with an interactive work session idle past `RALPH_SETTLE_MIN`; that configuration never existed.
A clean night under conditions that never exercised the race is worth nothing as evidence in
either direction. **The hazard stands on the lanes spec's own text, not on observation** — and
letting "nothing happened" render identically to "nothing could have happened" is the exact
defect class this repo shipped three fixes for on the same day (#1878/#1907/#1909).

---

## 4. Why this does not reverse the lanes non-goal

The lanes spec declares (`:70-71`):

> **No lane-to-lane messaging, lane priorities, scheduler-side routing, or orchestrator agent.**
> Lanes coordinate only through board state and durable marker comments.

This spec **narrows that clause rather than reversing it**, and names the narrowing explicitly,
as GH-1890 required:

- *Coordination* between lanes still happens only through board state. Unchanged. No lane learns
  what to do next from a peer; no lane's pacing, priority, or work selection is influenced by
  one. The disjoint-write-lane partition is untouched — which is the property the non-goal was
  protecting.
- What is now permitted is **evidence transfer**, which is not coordination. A reproducer does
  not tell a lane what to work on; it makes the work the lane already claimed cheaper.

The four-dimension lane test (`:42-50`) is not tripped, because **no new lane is proposed**. A
peer that sends a finding is not a lane; it is a thing an existing lane may do.

The honest statement of the change: the non-goal said lanes *do not need to talk*. That remains
true for coordination and is now false for evidence. The lanes spec should carry a pointer here
rather than being read as still-absolute (§14).

---

## 5. Transports — chosen and refused

### 5.1 Cross-session `SendMessage` — chosen for knowledge transfer

Chosen on one property the first draft got wrong and the field evidence corrected:

> Messages arriving mid-tool-call are **queued and delivered cleanly at the next round**,
> without disrupting the turn in progress.

This matters more than it sounds. The v1 catastrophe was *interruption*: "the worker reads the
message, acknowledges it, goes idle — and never runs the actual task"
(`2026-02-22-orchestrator-no-message-on-task-assign.md:19`), which produced the nudge loop —
sender reads idle as "not delivered", nudges, consumes another turn. **A queued message
delivered at a turn boundary does not have this property.** The recipient finishes what it was
doing and reads the message as context on its next round.

So the v1 record does *not* transfer wholesale to this transport. What transfers is the part
about **payload**: v1's volume was assignments and status pings (30+ messages across 14 issues),
which §1 prohibits outright. The failure was never "agents exchanged information"; it was
"agents pushed each other facts that were already in the task store, and paid a turn each time."

Costs that remain real and are accepted: a message consumes recipient *context* and *attention*,
even queued. This is why the payload table is a whitelist and not a guideline.

### 5.2 The board — chosen for questions, and for anything that must be durable

Durable, single-source-of-truth, already the write plane, already typed (C9 for the question,
`board answer` for the reply), already has a reader (`board list --state human`), and already
has doctor sweeps that notice an item sitting unanswered.

**Durability is the discriminator between §5.1 and §5.2, and the field evidence supplies the
proof by counterexample.** The investigator's reply to the #1888 session bounced —
`connect ENOENT` — because the workspace had been retired. The finding in that reply was lost to
the session and to the record. Posted as a board comment on the issue, it would have survived
the session that was going to read it, which is the entire reason the board is authoritative.

**Rule:** if the artifact would still be worth having tomorrow, it goes on the board, and a peer
message may at most point at it. The direct lane is for the in-the-moment case where the peer is
live and the artifact is scaffolding.

### 5.3 A per-run inbox (`~/.ralph/runs/<id>/inbox`) — refused

The shape GH-1890 anticipated, and a forward-looking Phase 3 bullet in the v2 implementation
plan. Still refused, and the field evidence strengthens rather than weakens the refusal.

An inbox exists to solve *delivery to an absent peer*: hold the message, deliver when it
returns. But the observed failure was not a peer that was temporarily away — it was a peer that
was **retired by a third party and never coming back** (§9.2). An inbox for a dead session is a
file nobody opens. The case that motivates the mechanism is the case the mechanism does not fix,
while the board — which already outlives every session — fixes it exactly.

An inbox would buy: latency on facts that are durable anyway. It would charge: a second source
of truth, an addressing model, a delivery-failure model, an unread policy, and a dead-peer
policy. Five mechanisms for a shorter poll.

**Reopening condition** (kept falsifiable, since the last one fired): if peers are found
routinely needing to hand artifacts to siblings that are *temporarily* unavailable and *reliably
return* — a real "away" state distinct from "retired" — the inbox is the right shape and this
section is wrong.

### 5.4 Assignment over any transport — refused permanently

Not a transport choice; a payload prohibition, and the one v1 finding that transfers in full.
Work is claimed from the board, by the agent doing it, through `board claim`. Nothing pushes
work to an agent. This is what produced the measured 30+ messages / 2–4 nudges per task, and it
is prohibited regardless of how good the transport becomes.

### 5.5 `herdr agent prompt` — refused for sibling use

The transport that already physically exists: any agent can inject text into any other agent's
stdin. Used today in exactly one direction — the scheduler→agent hub call at
`ralph/examples/tick-herdr.sh:260`.

Wrong for a sibling edge for two reasons that survive §5.1's correction:

1. **It injects into the turn stream rather than queueing at a boundary.** This is precisely the
   property that distinguishes it from cross-session `SendMessage`, and precisely the v1
   turn-consumption failure.
2. **It leaves no durable record**, so a decision that crossed it is invisible to the board, to
   doctor, and to the next session.

**Normative:** `herdr agent prompt` is the hub lane only — a scheduler or orchestrator prompting
an agent it is responsible for. Sibling-to-sibling use is forbidden. `agent attach [--takeover]`
remains the *human's* escalation rung, a different actor and not a sibling edge.

**Explicitly permitted, so the prohibition is not misapplied: spawner→worker lifecycle.**
Resuming an outage-killed session is a hub call, not a sibling edge, and it is the one operation
with **no sanctioned alternative** — a killed session cannot be reached by `SendMessage`, and the
board cannot restart it. The prohibition above is about *peer coordination*, and a reader who
applied it to session lifecycle would remove the only tool for the case that needs it. Two
conditions keep this from becoming a loophole: the caller must be the party responsible for that
agent's lifecycle (its spawner or the scheduler), and the payload must be a resume, never a
coordination message that §1 would have prohibited on a live peer.

---

## 6. What a peer message may authorize: nothing

Against the one-writer invariant (`2026-08-13-…-one-writer-invariant-design.md:9-11`):

> Only one worker may write into a worktree at a time, through a claim. Everything else is
> orchestration, relay, and messaging.

That sentence already places messaging **outside the safety property**. An edge carrying no
write authority cannot violate the invariant, and this one carries none:

- A peer message is **evidence and advice, never instruction.** The recipient's claim, worktree,
  and branch are untouched by it.
- **It authorizes no write in another agent's tree**, and cannot: the sender holds no claim
  there, and the tree is held 1:1 by branch topology and the name mutex.
- **It does not resume a peer.** `board answer` moves Human Needed → In Progress; the blocked
  session picks that up on its own next read. There is no injection.
- **A peer cannot grant permission.** A peer's request is not the user's approval, and "I was
  denied, so you do it" is permission laundering. This held in practice tonight — a
  classifier-blocked board write was surfaced to the user rather than handed to a peer — and
  flattening the topology makes the property *more* load-bearing, not less.
- **A decision only a human may make stays the human's.** Where an escalation exists because the
  choice is the user's — spend, production, scope — a peer answering it is out of scope and it
  remains an escalation.

The last two are the enforceable core: a peer answer is legitimate for questions that are
**knowable** (a fact about the codebase, a constraint a sibling already found) and never for
questions that are **authorizations**.

---

## 7. Backpressure

GH-1890 asked for a model covering unread messages, dead peers, and the v1 spam mode. The
payload whitelist does most of the work, because volume in v1 came from the two classes now
prohibited.

| Hazard | Disposition |
|---|---|
| Spam (30+ msgs / 14 issues) | Structural: state and assignment are prohibited, and they were the volume. Knowledge is self-limiting — an agent can only send findings it actually produced. |
| Nudge loop (2–4 / task) | Impossible: assignment is prohibited, so there is no delivery signal to misread as "not received". |
| Turn consumption | Does not occur on this transport — queued to a turn boundary (§5.1). Context cost remains and is accepted. |
| Unread messages | No unread *set* to manage: nothing is retained for an absent peer (§5.3). Durable content belongs on the board. |
| Dead peers | §9.2 — a send to a retired peer fails loudly and the finding is re-routed to the board. |
| Out-of-order vs task state | The board is the task state; state is never sent, so the two cannot disagree. |
| A peer sends something *wrong* | Bounded by §6 (it is advice) and visible in the trail. And §2.5 is the case *for* this: the correction path is the point. |

**Named thresholds beat standing subscriptions.** The observed discipline that worked: replacing
"message me if something happens" with explicit triggers (red CI on a quiet session, the same
test red twice, any gate verdict, merged) dropped volume and raised signal. Where a lane wants
periodic reporting, it must name the trigger. A standing "keep me posted" is a state
subscription, which §1 prohibits.

---

## 8. Relationship to the phone-answerable escalation path

GH-1890 asked whether the flat surface is the same surface as the escalation path. **Split
answer, and the split falls exactly on the payload boundary.**

**The question path: the same surface, deliberately.** C9 `ralph.escalation` already forces a
question into a form answerable *without the asker's context* — ≤240-char single line, ≥2
enumerated options, exactly one recommended, a machine-actionable `resume`. That form was built
for a human with a phone, but the property it encodes is **context-independence**, which is
exactly what a sibling needs, for the same reason: a sibling does not have the blocked agent's
context either. So a well-formed escalation is already a well-formed peer question, the two
readers are interchangeable by construction, and a peer answer degrades to a human answer for
free — if no sibling knows, the item is already in the form the phone reads. No second contract;
a distinct one would have re-derived C9 and then drifted from it.

**The knowledge path: a different surface, and it must stay different.** An escalation is a
request for a decision, addressed to whoever has authority. A finding is an unsolicited artifact,
addressed to whoever can use it. Routing findings through the escalation surface would put
non-decisions in the human's decision queue — the exact degradation GH-1550's inbox framing
exists to prevent.

---

## 9. Addressing — two defects found, neither solved here

### 9.1 One session, two identities, two namespaces

Observed independently by both sessions, and confirmed directly from this one: a session carries
a **herdr agent name** (`w1890-design-flat-agent`, GH-1807's derived grammar) and a **peer
address** (`feat-1890-design-flat-agent-01`, branch-derived with an unpredictable suffix), and
they are not the same string. Addressing this session by its herdr name fails with *"No agent
named … is reachable"* — an error that names neither the other namespace nor the lookup that
would resolve it. `ListAgents` from here returns eight peers, none in the `w<issue>-<slug>`
grammar. A third form exists: the orchestrator is addressed by socket path
(`uds:/tmp/cc-socks/68662.sock`), copied from a message's `from`.

Consequence: **an address cannot be constructed, only enumerated.** Knowing the issue, the
branch, and the workspace is not sufficient; `ListAgents` is mandatory every time.

GH-1807 established "names derived once, one grammar" for branch and agent names. A second
ungoverned namespace is that defect recurring. But it is **adjacent to GH-1890, not inside it** —
this issue is about the message path; that is about the name — so it is filed separately (§14)
rather than absorbed.

*Provenance:* found by tripping over it, not proposed in the abstract — the orchestrator hit the
collision live while sending the message that produced §12, addressing this session by its herdr
agent name and bouncing. That is the stronger provenance and it is why the defect is stated as
observed rather than suspected.

**Interim rule, which needs no fix to be safe:** reply to the sender's `from` address; enumerate
with `ListAgents` when initiating; never construct a peer address, and never assume a herdr
agent name resolves.

### 9.2 Address validity is bounded by session lifetime, and a third party ends it

Observed: a reply bounced with `connect ENOENT` on a socket that was valid when the message
arrived and dead when it was used. Three properties, the third being the sharp one:

- validity is bounded by **pane/session lifetime**, not by the conversation;
- it is discoverable **only by sending** — there is no liveness probe short of a failed write;
- **a third party ended it.** A coordinator retired the workspace. Neither endpoint of the edge
  did anything wrong or knew it had happened.

GH-1890 asked whether a dead address is an error to the sender, an event to subscribers, or
prevented by construction. **Decision: an error to the sender, loudly — which is what already
happens, and it is correct.** Not an event to subscribers: that is a state subscription, which §1
prohibits, and it would require a liveness plane this design deliberately lacks. Not prevented by
construction: preventing it means an inbox or a lease, and §5.3 refuses the inbox.

The existing error behaviour is in-repo precedent worth citing: it named the stale socket and
directed the caller to re-run `ListAgents` rather than failing silently.

**The invalidating party should know it is invalidating.** Reported by the orchestrator against
itself: it retired the workspace with no sense that it was ending a live channel between two
other parties. This is not an argument for an inbox — it is the observation that **retirement is
a lifecycle event with a second-order effect that is currently invisible to the actor causing
it.** Nothing in this spec depends on fixing that, because §6 keeps the loss bounded to advice.
It is recorded because the asymmetry is real: the sender learns the address died, the party that
killed it never does.

**What a holder is entitled to assume: nothing beyond the moment.** An address is valid until it
isn't, and the sender finds out by sending. This is acceptable *only because* the payload class
is bounded — a lost finding is a lost optimization, not a lost decision, and §5.2's durability
rule routes anything worse to the board. If a peer message could ever carry something whose loss
mattered, this answer would be wrong; §6 is what keeps it from doing so.

### 9.3 Delivery acknowledgement is a conflated signal

`SendMessage` returning success means **the transport accepted it**, not that it entered the
peer's context. A sender has no ack, no receipt, no read state. In the observed case a
reproducer was sent, reported success, and the sender never learned whether it was read before
that session merged.

This is the same defect class as the three bugs merged in this repo tonight (#1878/#1907/#1909):
a signal whose benign reading is the default, so absence of evidence reads as evidence of
success.

**Decision: do not build a read-receipt.** A receipt is a state subscription (§1), it needs a
liveness plane (§9.2), and it re-creates the v1 loop directly — an unacknowledged message is
what the lead nudged about. Instead, two rules that need no mechanism:

1. **A sender may not depend on a peer message being read.** If the work requires that it lands,
   it goes on the board, where a reader can be verified by state.
2. **`sent` may never be reported as `delivered` or `considered`** — in prose, in a report, or in
   a close-out comment. The honest statement is "sent; unknown whether read."

---

## 10. What was decided

| | |
|---|---|
| Sibling edge | **Accepted**, scoped to newly-created knowledge — §2.4 |
| State notification between peers | **Prohibited** — §1 |
| Assignment between peers | **Prohibited**, permanently — §5.4 |
| Peer inbox / addressing model | **Rejected** — §5.3 |
| Transport for knowledge | Cross-session `SendMessage`; board comment when durable — §5.1, §5.2 |
| Transport for questions | The board, `board answer` — §2.3 |
| `herdr agent prompt` sibling use | **Prohibited** (new normative line) — §5.5 |
| New payload contract | **None.** C9 already carries the question — §8 |
| Write authority conferred | **Zero**; a peer cannot grant permission — §6 |
| Dead address | Loud error to the sender; no receipt, no subscription — §9.2, §9.3 |
| Lanes non-goal | **Narrowed**, explicitly: coordination no, evidence yes — §4 |
| Missing today | Permission for a peer to answer; two ungoverned namespaces — §2.3, §9.1 |
| Hazard surfaced, not solved | Work/deliver exclusion needs a typed lock, not a channel — §3 |

---

## 11. Preconditions — what made this work, and what it needs to keep working

Reported consistently by both sessions, and load-bearing rather than incidental. A flat surface
without these is the broadcast storm the v1 record describes.

1. **Explicit role contracts.** Each session was told what it owns and what it must route rather
   than decide. This is what makes §5.4 hold under pressure: an agent that knows it does not
   assign work does not send assignments.
2. **Named escalation thresholds, not standing subscriptions.** §7.
3. **Read-only capability where the role is read-only.** The investigator drove four edges and
   could not have written a tree if it tried — `tools:` is hard runtime enforcement, not prose.
   This is what makes an unsolicited peer message safe to *receive*: the sender's authority is
   bounded by an allowlist, not by its own restraint.
4. **Delivery at a turn boundary.** §5.1. A peer surface that interrupts is one people stop
   using — and one that reproduces the v1 failure exactly.

---

## 12. Field evidence

Two independent accounts, unreconciled before sending, agreeing on every load-bearing fact.
Four edges observed on 2026-08-14:

| Edge | Outcome |
|---|---|
| investigator → `feat-1878-…` | Live reproducer sent. Transport success; **never confirmed read** (§9.3). |
| investigator → `feat-1888-…` | Hazards and evidence sent; **unprompted reply corrected the investigator's own claim**, which was retracted and propagated (§2.5). |
| investigator → `feat-1888-…`, minutes later | `connect ENOENT` — workspace retired by a third party (§9.2). |
| worker `#1878` → orchestrator | Unprompted design objection — argued its fix should not absorb #1907, **and changed what shipped**. |

Also observed: the orchestrator→peer address failure that revealed the dual namespace (§9.1);
mid-tool-call messages queued and delivered cleanly at the next round (§5.1); a
classifier-blocked write surfaced to the user rather than routed to a peer (§6).

---

## 13. Proposals from the field accounts that this spec declines

Recorded because both sessions have a stake, and a spec that silently dropped their asks would
be the hub failure it is arguing against.

- **A distinguishing ack (`accepted by transport` vs `entered the peer's context`).** Declined as
  a mechanism, adopted as a rule — §9.3. The distinction is correct and the diagnosis is
  correct; the fix is that senders may not depend on delivery, because a receipt needs a liveness
  plane and re-creates the v1 nudge loop.
- **Reconciling the two namespaces.** Agreed, and agreed it is adjacent rather than inside —
  filed as its own unit (§14.2) exactly as the investigator proposed.
- **"Route design decisions to me."** Declined as a standing rule. The design decision for
  GH-1890 is recorded on the board, which is where the next session will look; a peer-directed
  routing rule would be precisely the second source of truth §5.2 refuses. Both sessions are
  notified, and the reasoning is here.

---

## 14. Follow-ups this decision creates

1. **Type the work/deliver exclusion** (§3). The only safety-relevant finding. A lease or marker
   with an atomic winner, evaluated by the same code both lanes run — not a warning message.
2. **Reconcile the peer/herdr namespaces** (§9.1). One session, two identities, and an error that
   names neither. GH-1807's "derived once, one grammar" applied to the peer address, or at
   minimum a resolver so that holding one name is enough.
3. **State the peer-answer permission** (§2.3, §6). One rule in the skill contract: an agent may
   answer a peer's Human Needed item via `board answer` when the question is *knowable*, never
   when it is an *authorization*.
4. **Write the payload whitelist into the work skill** (§1). The whole design is a payload rule;
   it is worth nothing unless it is where agents read.
5. **Point the lanes spec's non-goal here** (§4), so it is not read as still-absolute.

None is claimed as done. This spec decides; it builds nothing, per the issue's non-goals.

---

## Sources

- `thoughts/shared/plans/2026-08-13-ralph-herdr-one-writer-invariant-design.md:9-11,19-26,71-84,96-102`
- `thoughts/shared/specs/2026-08-07-loop-agent-lanes-spec.md:42-50,70-71,106-123,490-499` (in the `~/projects/ralph-hero` checkout)
- `thoughts/wiki/dont-notify-about-state-visible-through-data-plane.md:18-27` (personal corpus)
- `thoughts/ideas/2026-02-22-orchestrator-no-message-on-task-assign.md:14-31,56-69`
- `thoughts/shared/research/2026-02-23-GH-0353-communication-discipline.md:12-13,63`
- `thoughts/shared/research/2026-03-01-GH-0466-idle-notification-spam.md:30-99`
- `thoughts/shared/research/2026-08-09-herdr-runtime-ralph-addon.md:78-83,101`
- `thoughts/shared/plans/2026-08-10-ralph-herdr-v2-implementation.md:14,27,30,33`
- `ralph/scripts/contracts.ts` — C3:545-572, C4:584-601, C9:869-890, L11:1177-1196
- `ralph/examples/tick-herdr.sh:260` — the sole existing `agent prompt` call site
- `board help` — `answer NNN -m`, `--any-state`, `--comment-only`
- Field evidence, 2026-08-14: two independent live peer-session accounts (§12)
