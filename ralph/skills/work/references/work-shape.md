# Work shape — the filing rules

Operative rules for cutting, sizing, and ordering board work. The vocabulary
is the repo-root CONTEXT.md glossary; the argument for every rule is the
work-shape design record (`thoughts/shared/ideas/2026-08-23-board-work-shape-design.md`,
normative). This file states what to do; the record states why. These rules
are advisory at filing by design — nothing refuses a badly-shaped issue at
`board create` — which is exactly why they must live where filing happens.

## The unit

**One issue = one PR that is independently mergeable** — no other PR must
land before this one can. A property of the decomposition, decided when the
work is cut, and checkable at review time: a PR that needed another PR first
is either stacked (visible) or broken (caught). Rejected: "one logical
change", "one reviewable diff", "one day of work" — each grounds out in the
judgment of whoever is arguing, which a doctrine for autonomous filing
cannot have.

An issue that is secretly two PRs — "do A, and also the follow-up B that
depends on A" — is two units and one `board dep` edge. File it that way.

A good unit issue states an **outcome** and its **verification**: what is
true after the merge that was not before, and how the session will know. An
issue whose only verification is "it works" is unverifiable and therefore
undeliverable. It does not enumerate implementation steps — the session's
plan artifact does that, sized by the Estimate.

## Which lane — the filer's confidence, not the filer's identity

`board create` has no default landing state, and the choice between its two
lanes is a statement about the *unit*, not about who is typing:

- **`--backlog`** — the filer is confident the unit is formed: an outcome,
  its verification, the evidence that makes it real (a measurement, a
  `file:line`, a reproducer), and a Priority and Estimate it can be ranked
  on. An agent filing a well-evidenced follow-up mid-work belongs here.
- **`--intake`** — the filer is *not sure it is fully fleshed out*: a symptom
  with no located cause, a scope that cannot be bounded yet, an observation
  suspected of being two units. Intake is where a human decides; it is not
  a courtesy step for work that already meets the bar above.

Both errors cost. A careless `--backlog` puts an unformed item in the
approved queue, indistinguishable by state from an approved one, until
someone reads it — `board defer` is the park: it drops the item out of
`next`/`frontier`, and the fleet's spawn path refuses it even when named by
number. It is not a lock — an explicit `board claim` lifts it, deliberately,
since taking the unit asserts its precondition now holds. Routing every filing
through Intake costs the other way: the fleet stalls on approvals nobody
needed (measured 2026-08-29, both directions in one night).

**The board cannot tell a considered `--backlog` from a careless one** — no
state history distinguishes an item created in Backlog from one promoted
out of Intake, and a session binding marks the sanctioned follow-up path,
not a smell (GH-2284, decided: no check ships). A reader tells them apart
by the body against the bar above. That is why the bar lives here, where
filing happens, and why a Backlog item whose body cannot answer "what is
true after the merge, and how will the session know" is the thing to park.

## Estimate — agent context budget

Estimate measures how much of one session's context window the unit
consumes — not how long a human would take. Rejected: human-time semantics
(wrong on the failure dimension — a 3-day mechanically-repetitive human task
is a fine XS for an agent; a 2-hour task needing whole-tree context is an L)
and a numeric token field (false precision — nobody can estimate tokens,
everyone can rank the tiers below).

- **XS** — one session, no plan artifact. Read, change, verify, ship.
- **S** — one session, with a plan artifact worth writing first.
- **M** — one session at the edge. A handoff artifact, and a second session
  finishing it, is normal — not a failure.
- **L** — decompose before working. A claim on it is probably a mistake.
- **XL** — decomposition is the only action the item admits.

Estimate is self-reported, so a session that discovers mid-work it holds a
mis-sized unit re-estimates it visibly — one field change, on the record —
and escalates rather than grinding.

## Approval-gated hosts — size to the reviewer sitting

Estimate above measures agent context; on a host where a human approves
every PR, a second, independent cost sits on top of it: **per-PR review is
fixed and paid by a person**, not by the session. That cost does not shrink
when the diff is small, and it does not scale with a fleet — three XS PRs
queued on one reviewer cost that reviewer three sittings, not one. Where
that is true, the unit that fits one agent session is no longer the right
target; **the unit grows until it fits one reviewer sitting instead** — batch
what a human would otherwise review three times into one pass. `board
readiness` names the host where this applies (required approvals ≥ 1 and no
bot reviewer wired to share the cost) and recommends the two knobs that
follow from it: `RALPH_CLAIM_MAX_ESTIMATE=` (empty, lifting the size
ceiling) and `RALPH_HERDR_FLEET=1` — advisory only, never imposed.

The shape this doctrine reaches for already exists: the **one-agent-one-stack
exception** (`board-work-shape-design.md:438-447`) — one session owning a
whole dependent chain and landing it in one sequence, because stacked PRs
retarget on every merge and the gates bind evidence to `head_sha`/`base_ref`
(GH-1841). On an approval-gated host that shape is not a narrow exception
for stacking mechanics — it is the holistic answer to a human reviewer
sitting down once: one session, one sequence, one sitting, instead of the
same person re-approving a chain of fragments.

## blocked-by vs parent

**parent (`board link`) is rollup only.** It drives priority inheritance and
parent-check's all-children-closed promotion. It asserts *nothing* about
ordering — children of one epic are routinely worked concurrently, and the
ranker is built on that.

**blocked-by (`board dep`) asserts ordering, for exactly one reason: this
unit's diff cannot be written or verified until the blocking unit has
merged.** The test is about the diff, not about comfort. Explicitly NOT
blocked-by:

- *"touches the same file."* File overlap is a property of a moment — it
  changes every time anything merges, so an edge recording it is stale on
  write.
- *"easier to review after A."* A sequencing preference the driver can honor
  without an edge the fleet guard will then enforce as fact.
- *"same author."* Sessions are fungible by design; who works something is
  the claim field's business, not a dependency's.

The bias is deliberate: a false edge silently serializes work that could
have been concurrent, forever, because nothing audits an edge for being
unnecessary — while a missing edge costs one wrong parallel spawn, which is
visible. Keep edges necessary.

**An ordering dependency spelled only in prose is a defect, not a style
choice.** blocked-by is the only sanctioned spelling of ordering — wire the
edge the moment a body names a blocker. And check beyond siblings: a
decomposition validated in isolation can still land a unit whose real
blocker is an *existing* unclaimed Backlog item nobody re-read.

## Never rebase for freshness alone

Rebase to resolve a real conflict, or when re-verification is the point —
nothing else. Freshness is a proxy for verified-as-landed, and a proxy that
silently fails to deliver it: a rebase without a CI rerun *claims* main's
context while having been tested in none of it. In a repo running the merge
gates, one freshness rebase additionally costs a full re-attestation and a
full review round for a diff nobody changed — the gates bind evidence to
heads on purpose (GH-1841). Rejected: "keep branches up to date" as
standing policy — where an org requires it, the answer is a merge queue
(verified-as-landed bought exactly once, at merge time), not routine
rebasing and not stacking.
