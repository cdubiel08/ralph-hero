# The investigation-and-curation loop: not a lane, mostly not a skill

**Status:** design record. Input was
`thoughts/shared/ideas/2026-08-14-investigation-curation-loop-brief.md`, written
first-hand by the session that made the observations. This record verifies that
brief against the live tree, runs the four-dimension lane test, and reaches a
recommendation.

**Verdict in one paragraph.** The loop is real and recurs, but it is not one
thing. Its three halves resolve differently, and none of them is a lane. The
**curation** half is already `/ralph:tend` — same signal source, same write lane,
same pacing signal, same permissions; building a second surface for it would be
a duplicate. The **investigation** half fails the lane test on two dimensions
and, as a skill, would encode this operator's knowledge of this codebase rather
than a transferable contract — it is practice, and should stay documentation.
The **dispatch** half (fleet composition) is `tick.sh`'s territory plus a human
judgment the brief itself calls the least automated part; it stays human, named
as such. What survives as shippable product is one small, generalizable defect
that this session's own artifacts prove: **evidence dies between observation and
curation**, and there is a 7-day window in which nothing sees it. That is
board-side, typed, and advisory — and it is the only thing here worth code.

---

## 1. Verification of the brief against the live tree

The brief's pattern 3 says issue bodies decay and must be checked against the
code. Holding the brief to its own standard produced the sharpest finding in
this record.

| Brief's claim | Live tree (checked 2026-08-14) | Verdict |
|---|---|---|
| #1891 "states plainly that 15 of its 22 queries are unattributed" | **body is empty (1 byte), 0 comments** — title only | **false** |
| #1891 "now says so explicitly" that `fetchHistories` already batches | same — nothing says anything | **false** |
| #1888 records the fail-open/fail-closed detection reasoning | **body is empty (1 byte), 0 comments** — title only | **false** |
| #1878 documents the spawn-window watcher defect | full body, observed run id, mechanism, consequence | **true** |
| #1813 resolved as stale | `CLOSED / COMPLETED`, residual #1883 open and detailed | **true** |
| #1821 resolved as subsumed | `CLOSED / NOT_PLANNED`, full body | **true** |
| #1800 carries a measured correction | comment 2026-08-14T12:05:28Z: "delivered ~3.2x, not the projected 15-18x", with the `RALPH_GQL_COST=1` method and the rejected `rate_limit`-delta method | **true** |

Four of seven check out, and the three that fail all fail the same way: **the two
issues the brief credits with its best epistemic behaviour are title-only.**
`gh issue view 1891 --json body` returns a newline. The careful statement of
what was *not* measured, and the note that the batching already exists, live
only in the brief and in a session transcript.

This is not a small correction to the brief. Patterns 5 and 6 — "record what you
did NOT measure" and "check whether the thing is already built" — are the two
patterns whose evidence does not exist. The judgment happened; the artifact did
not. That distinction drives the whole recommendation below, because **a skill
that grants judgment cannot fix an omission that was never a judgment failure.**

Everything else in the brief holds. The #1800 correction comment is exemplary
and contains, in its own text, the method-is-part-of-the-finding argument
(pattern 2) verbatim.

---

## 2. The four-dimension lane test, run explicitly

From `ralph/CLAUDE.md`: a lane is a **typed selector + judgment skill + goal**,
and a new lane is justified *only when signal source, write lane, pacing signal,
and permission set all four differ simultaneously* from every existing lane.
The pacing signal is the observable the lane derives its next wake from.

The loop must be split before it can be tested — tested whole it would trivially
"differ" from everything by being a union of three things.

### A. Investigation (observe anomaly → investigate to confidence)

| Dimension | Finding | Differs? |
|---|---|---|
| Signal source | measurements (`RALPH_GQL_COST=1`), the live tree, running processes. All three existing lanes read the board; this reads none of it. | **yes** |
| Write lane | none. It writes no state field at all — not `transition`, not `reconcile`, not `parent-check`. | **no — absent, not different** |
| Pacing signal | none available. There is no queue to drain and no observable that says "an anomaly exists". A 30-hour orphaned cockpit was found by a human looking; a 36-minute mis-declared session was found by a human reading a pane. The trigger is *a person noticing*. | **no — undefined** |
| Permission set | Read/Grep/Glob plus read-only Bash (`gh api`, `herdr pane`, process inspection). Narrower than work, wider than tend. | **yes** |

**2 of 4. Fails.** And it fails on the two that matter most for autonomy. A
lane with no pacing signal cannot be scheduled, which means it cannot be a lane
in ralph's sense — `examples/README.md`'s whole transport story is *derive the
next wake from the queue*. There is no queue here. This is the answer to the
brief's question 2: **the typed selector does not exist, and not because nobody
has written it — because the inputs are not on the board.**

### B. Curation (file / correct / close, with evidence)

| Dimension | Finding | Differs from `tend`? |
|---|---|---|
| Signal source | the board's issues | **no — identical** |
| Write lane | metadata only, closures proposed via `ralph-tend:v1 proposed` markers, human answers with `board resolve` | **no — identical, by the inherited constraint** |
| Pacing signal | accumulation age | **no — identical** |
| Permission set | board CLI + read tools | **no — identical** |

**0 of 4. Fails maximally.** This is not a near miss; it is `/ralph:tend`
described in different words. `/ralph:tend`'s own description already claims
the exact behaviour — *"forms observations into tracked issues with provenance,
detects stale bodies against the live tree"* — and `tendQueue()` in
`board.ts:4129` already emits `unformed`, `stale-body`, `done-audit`. The brief
did not find a missing surface here. It found an under-used one.

### C. Dispatch (what runs next, how many agents in parallel)

| Dimension | Finding | Differs? |
|---|---|---|
| Signal source | `board next` ranking, plus file-surface analysis of candidate diffs. The ranking half is identical to the work lane; the diff-surface half is not on the board at all. | **partly** |
| Write lane | claims, via `transition`/`claim` | **no — the work lane's** |
| Pacing signal | worker liveness and free fleet slots — but `tick.sh` and the scheduler already own spawn cadence, and `ralph/CLAUDE.md` is explicit that cadence is scheduler-owned, not lane-owned | **no** |
| Permission set | must spawn work — identical to the work lane | **no** |

**~1 of 4. Fails.** Dispatch is not a lane, because the part that is genuinely
missing is not a lane-shaped thing: it is a **conflict predicate** ("would #1814
and #1821 touch the same function?"). The brief's pattern 7 is correct that
ranking says what is valuable and only the diff surface says what can run
concurrently — but the remedy for that is either a predicate or a human, not a
scheduling lane wrapped around one.

**All three fail. The four-dimension test disqualifies the loop as a lane in
every decomposition tried.** This is the finding the brief hoped for and it is
worth more than a forced design would have been.

---

## 3. The four options, with the argument against my own favourite

### (a) A new skill, `/ralph:investigate`

**For.** Investigate-to-confidence with recorded uncertainty is real, repeatable
judgment. `/ralph:work`'s contract presumes a unit already exists; nothing in
ralph covers producing one from an anomaly.

**Against — and this is the argument that kills it.** Three counts.

1. *A skill with no selector is a prompt template.* Every other ralph skill has
   an entry condition a machine can evaluate. This one's entry condition is "a
   human noticed something odd." Shipping it means shipping a document that a
   human must decide to invoke, which is what a documented practice already is,
   minus the pretence of being a surface.
2. *Its hardest parts do not transfer.* Pattern 2 (per-query attribution beats
   `rate_limit` deltas) is true because *this* board has a cockpit and four
   agents spending budget concurrently. Pattern 7 (file-surface conflict) needs
   the reader to know `board.ts` well enough to predict that two issues land in
   one function. A skill whose value depends on the operator already knowing the
   codebase cold is not a product — it is that operator's notes with a slash in
   front. This is precisely the risk named in the brief's question 5 and the
   operator question, and it is not hypothetical here: ralph-hero's product
   *is* board tooling, so measuring the board is this repo's domain work, not a
   general capability.
3. *It would not have prevented the observed failure.* #1888 and #1891 shipped
   title-only. That is not a lapse of investigative judgment — the judgment
   demonstrably happened, since the brief records it. It is an artifact that was
   never written. Granting more judgment does not close that gap.

I wanted this option. It does not survive its own third count.

### (b) A mode of an existing skill

Two candidates. **`/ralph:board`** already owns intake ("form this", "make a
ticket") — but adding an "investigate first" mode makes the human surface own an
open-ended activity, which is the altitude mistake `ralph/CLAUDE.md` warns about
under *no prescribed phases*. **`/ralph:tend`** already owns the curation half
outright, per §2B, so there is no mode to add — only usage.

Verdict: no mode is needed. The curation half already has its home; the
investigation half does not fit either host.

### (c) Documentation only

**For.** It matches what the lane test found, it costs nothing, it cannot rot
into a surface nobody invokes, and `ralph/CLAUDE.md` already carries exactly
this kind of hard-won, non-enforceable knowledge (the GraphQL cost bullet, the
archiving-buys-no-relief bullet) as *conventions and gotchas* rather than as
skills.

**Against.** Documentation does not fire. Nothing makes the next session read
it, and the brief's ten patterns were themselves learned the expensive way.

**Rebuttal to the against.** That objection applies to any non-enforcing
surface, including a skill — and ralph's own doctrine is that enforcement is
code at the mutation path, never prose. Prose that admits it is prose is more
honest than prose shaped like a product.

### (d) Split into three surfaces

Rejected by §2: two of the three are already owned (curation → tend, dispatch
cadence → tick.sh/scheduler) and the third has no selector. A split produces one
orphan and two duplicates.

---

## 4. Recommendation

**Four dispositions, one of them code.**

1. **Curation is `/ralph:tend`. Build nothing.** If tend is not producing
   evidence-carrying issues, that is a usage or prompt question inside an
   existing skill, not a new surface. (§2B)

2. **Investigation is practice. Document it and stop.** The transferable
   residue is four bullets, not ten patterns — several of the brief's collapse
   into each other. Proposed home: `ralph/CLAUDE.md` gotchas for the two that
   are about *this* repo, and a thoughts/ practice note for the rest.
   - Patterns 1+2+5 are one thing: **a measurement without its method and its
     stated coverage is not reusable.** This generalizes and belongs in prose.
   - Patterns 3+6 are one thing: **grep the live tree before trusting or
     filing** — already a `/ralph:tend` behaviour and already in the root
     `CLAUDE.md` history bullet.
   - Pattern 8 (**a check that only reports should not inherit the caution of a
     check that acts**) is the single most generalizable observation in the
     brief and is *not* currently written anywhere. It belongs beside the
     enforcement-layers section, because it is a rule about that section.
   - Patterns 9+10 are one thing: **things that outlive their container go
     invisible; look at what a stalled worker holds before replacing it.** This
     is herdr operational knowledge; it belongs with the herdr memories, not in
     the ralph plugin.
   - Patterns 4 and 7 are covered elsewhere: contingent proposals are already
     the marker protocol's semantics, and fleet composition is item 4 below.

3. **Fleet composition stays human — say so out loud.** This answers the
   brief's question 4. It is the least automated part of the loop, and the
   honest reason is that its input (will these two diffs collide?) is not
   derivable from the board. A future `board next --explain-conflicts` built on
   a real diff-surface predicate is a *separate* proposal that must stand on its
   own evidence; it is not this design.

4. **Ship one thing: close the evidence-decay window.** This is the only
   defect here that is board-side, typed, generalizable, and empirically proven
   by this very session.

### The one shippable defect

`tendQueue()`'s `unformed` classifier (`board.ts:4160-4172`) requires
`UNFORMED_DAYS = 7` of age before an issue is selected, plus no estimate, no
parent, no blockers. It **does not test whether the body is empty.**

So the observed sequence is: an anomaly is investigated at 12:05, an issue is
filed title-only at 12:06, the evidence exists only in a session transcript, and
**no ralph surface looks at that issue for seven days** — by which time tend can
see the issue is unformed but has no way to recover what the filer knew. The
evidence was freshest at the moment it was least protected.

**Proposal (advisory only, per the inherited constraints):**

- `board create` **warns** on an empty or near-empty body and names what a body
  should carry (what was observed, how it was measured, what was *not*
  measured). It never refuses — refusing intake is worse than a thin issue, and
  ralph recommends, never imposes.
- A doctor `i` line — working name `unformed-at-birth` — for OPEN issues with an
  empty body created within `UNFORMED_DAYS`, i.e. exactly the blind window.
  Advisory by construction: `--strict` never escalates it, `--fix` never acts on
  it, a read that throws degrades to `not evaluated`. Same rules as the four
  existing state smells and `board-volume`.

Both are recommendations to a host repo, not requirements. Neither executes a
closure. Neither is a hook.

---

## 5. The operator question, answered directly

**Does this belong in the shipped ralph plugin?**

Mostly no, and the reason is specific rather than modest. The loop's high-value
judgments are *domain* judgments about a repo whose product is board tooling.
Knowing that per-query attribution beats `rate_limit` deltas is knowing that
this machine runs a cockpit and a fleet. Knowing that #1814 and #1821 would
collide is knowing `board.ts`. A skill built from those would work here, produce
confident nonsense in a host repo, and fail in the way that is hardest to
detect: plausibly.

What ships is the part that is true regardless of who is reading: an issue filed
without its evidence loses that evidence, and ralph currently cannot see that
for seven days. That claim needs no knowledge of any codebase, which is exactly
why it is the part that belongs in the product.

---

## 6. Honest limits

1. **One session, one board.** Every pattern in the brief comes from a single
   working session on ralph-hero. `unformed-at-birth` is proposed on an n of 2
   (#1888, #1891) — real, verified, but two. If title-only filing turns out to
   be rare once measured, the doctor line is noise and should be dropped rather
   than defended.
2. **The lane test was run on my decomposition.** I split the loop into
   investigation / curation / dispatch because the brief's question 1 proposed
   that split. A different cut could score differently. I do not think it would
   score *well* — the pacing-signal failure is a property of the inputs, not of
   the cut — but the test's result is not decomposition-independent, and I have
   not proven that it is.
3. **"Curation is already tend" is an argument from tend's description and
   selector code, not from watching tend run on these issues.** I did not
   execute `board tend-queue`. If tend in practice does not produce
   evidence-carrying issues, that is a real gap and my §2B verdict is the
   optimistic reading of it.
4. **The empty-body finding is a snapshot.** #1888 and #1891 were empty at
   2026-08-14. Someone may fill them in tomorrow, which would weaken the
   illustration without touching the structural argument — the seven-day window
   exists either way.
5. **Item 4 is a proposal, not a design.** Where the warning text lives, what
   "near-empty" means as a threshold, and whether the doctor line should instead
   fold into an existing one are unanswered. A threshold picked here would be
   invented, not measured.
6. **No board items were filed and nothing was mutated** in producing this
   record, per the session constraints. The proposals below are handed back.

---

## Proposals handed back (not filed)

| # | Proposal | Kind | Confidence |
|---|---|---|---|
| P1 | `board create` warns on an empty/near-empty body; never refuses | code, advisory | high — the defect is verified |
| P2 | doctor `i` line `unformed-at-birth`: OPEN + empty body + younger than `UNFORMED_DAYS` | code, advisory | medium — n of 2; measure frequency first |
| P3 | Add pattern 8 (report-only checks must not inherit an acting check's caution) to `ralph/CLAUDE.md` beside the enforcement layers | docs | high — generalizes cleanly, written nowhere |
| P4 | Practice note in `thoughts/` for the measurement-method and stalled-worker patterns | docs | high |
| P5 | Correct the brief: patterns 5 and 6 cite evidence that does not exist on #1891/#1888 | docs | high — verified |
| P6 | `board next --explain-conflicts` / diff-surface predicate | code | **low — explicitly out of scope here**; needs its own evidence |

**Not proposed:** a `/ralph:investigate` skill, an investigation lane, a
`/ralph:board` investigate mode. Each was considered and each is argued against
above.
