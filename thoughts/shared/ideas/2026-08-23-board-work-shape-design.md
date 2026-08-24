---
date: 2026-08-23
topic: the shape of the work the board carries — units, sizing, ordering, and the freshness question
type: design
status: proposed
extends: 2026-07-31-ralph-v2-minimal-harness.md, 2026-08-01-agent-readiness-guide.md
provenance: design session 2026-08-23; merge-surface measurements on this repo and one host repo
---

# The shape of the work — a design record for what the board carries

This repo documents at length why the board *machine* is shaped the way it is —
the seven states, the three write lanes, the claim protocol, the gates
(CLAUDE.md; the v2 design record; the intake-tier record). It documents almost
nothing about the shape of the *work* the machine carries. This record closes
that gap, and it is normative: where it conflicts with informal practice, this
record wins until superseded.

## 1. The gap, measured

Three measurements from the design session establish that the work-shape rules
exist today only as folklore:

- **`Estimate` is five option strings with one semantic consumer.** board.ts
  defines the field (`ESTIMATE_FIELD`, options `XS S M L XL`, board.ts:1639)
  and `backlogReadinessGaps` requires it to enter Backlog — but the only place
  in the entire tree where an estimate *value* changes anything is one sentence
  in work/SKILL.md: "XS/S singles never touch frontier." A field every filing
  must carry, whose meaning is defined nowhere, is a field agents will fill by
  vibes — and they do.
- **"epic" and "feature" appear only as informal adjectives.** work/SKILL.md
  says "frontier … only as in-session bookends on feature/epic units" — and no
  document says what makes a unit either. Meanwhile board.ts *computes* an epic
  (rankNext's demoted-root logic) with no field and no label. The code has a
  definition; the prose has a mood.
- **There is no written rule for when `board dep` applies versus `board link`.**
  Both verbs exist (board.ts:10408, 10416); tend/SKILL.md tells agents to wire
  both "where it obviously belongs" — and GH-2109 measured, on this board on
  2026-08-22, that roughly half of open items carried a body reference no edge
  recorded. "Obviously" is not a rule, and the fleet's dependency guard is
  exactly as complete as the graph agents were never told how to build.

Agent readiness IS documented (2026-08-01, three levels, recommendations never
gates) and is not re-litigated here — section 7 extends it.

## 2. The vocabulary

This section becomes the repo-root CONTEXT.md verbatim. It is a glossary and
nothing else: no implementation detail, no thresholds, no rationale. The
rationale is this record; the operative rules are the skill reference (§7).

- **unit** — one issue whose completion is one PR that is independently
  mergeable. The atom of board work.
- **independently mergeable** — no other PR must land before this one can. A
  property of the decomposition, decided when the work is cut.
- **fresh** — the branch's merge-base is the current head of the default
  branch. A property of a moment; it decays on every merge to main.
- **verified-as-landed** — the tree that actually lands was tested in the
  state it will land in. A property of verification.
- **epic** — a board item with open board-resident descendants (children,
  transitively — a closed intermediate item passes through). Derived from the
  parent edges, never declared.
- **frontier** — the set of mutually unblocked, eligible units the ranker
  offers for concurrent pickup.
- **blocked-by** — the ordering edge (`board dep`): this unit's diff cannot be
  written or verified until the blocking unit has merged.
- **parent** — the rollup edge (`board link`): drives priority inheritance and
  parent-check. Asserts nothing about ordering.
- **estimate** — the unit's agent context budget (XS–XL): how much of one
  session's context window the unit consumes, not how long a human would take.
- **apply unit** — a unit whose completion is a deploy, not a merge; closes on
  evidence, never on a closing keyword.
- **feature** — prose about a user-visible outcome. Not a board concept; no
  rule keys on it.

## 3. Three properties conflated under "pointed at HEAD of main" — the spine

Every argument about rebasing, stacking, and merge order in every repo we have
watched collapses three distinct properties into one phrase. Named apart, most
of the argument dissolves:

1. **Independently mergeable** — no other PR must land first. Decided at
   decomposition time; nothing that happens on main afterward changes it.
2. **Fresh** — the branch's merge-base *is* current HEAD. Shared by every
   branch cut from the current HEAD, and falsified for all of them by the next
   merge — which is why a fleet spawning a frontier produces N fresh branches
   at every spawn and zero a merge later.
3. **Verified-as-landed** — the tree that lands was tested in the state it
   lands in. The only one of the three that is a safety property.

**This record requires verified-as-landed and explicitly declines to require
freshness.** The reasoning: freshness is only ever a *proxy* for
verified-as-landed, and it is a proxy that silently fails to deliver the real
thing. A rebase-for-freshness buys verification only if CI reruns after the
rebase and someone waits for it; a rebase without a rerun is theatre — the
branch now *claims* main's context while having been tested in none of it —
and that is the most common version of the policy in the wild. Meanwhile the
real property can be bought without freshness at all (§8, the merge queue).

**When freshness earns its cost.** Two real hazards hide behind the proxy:
*semantic conflicts* — A and B share no lines, but B relies on an invariant A
changed; textually clean, broken main, and only running the combined tree
catches it — and *shared lockfiles and generated artifacts*, where
serialization is the only resolution because the merge driver cannot reason
about the file. The risk scales roughly with (surface overlap × main velocity
× PR lifetime). All three inputs are measurable, which is why the right policy
is a function of measurements (§7, the readiness recommendation), not a
constant anyone writes into doctrine.

**When freshness is actively bad — the cost this repo specifically pays.**

First, the mechanical cost is O(n²): with n PRs open, each merge dirties the
other n−1, and a fleet holding several PRs open pays it continuously.

Second — the cost that matters here, and it is structural, not incidental: **in
a repo running these gates, a rebase destroys the evidence the gates are built
on.** Each claim verified against the current tree:

- The attestation binds `head_sha` (`me_attestation_status` in
  scripts/lib/merge-evidence.sh returns `stale` the moment the recorded head
  is not the PR head, merge-evidence.sh:143) — so a rebase forces
  `attest-pr.sh` to run again.
- Gate 5 requires the policy reviewer's answer *at the current head*
  (scripts/codex-review-evidence.sh; CLAUDE.md's gate-5 contract) — so the
  reviewer must be re-requested and must re-answer.
- `advisory-findings.sh` reports `reviewed` per head, and `pr-gate-watch.sh`
  renders an unreviewed head as `NO ADVISORY REVIEW AT THIS HEAD — nobody
  looked; zero findings is not a clean PR` (pr-gate-watch.sh:839) — the GH-1971
  rule that an unreadable read must never render like a clean one, now working
  *against* the rebase.
- `review-convergence.sh` counts the fresh request as a round against
  `RALPH_REVIEW_ROUND_CAP` (default 5; unattended lanes set 2) — the cap that
  exists to stop non-converging reviews now consumed by a diff nobody changed.

So one freshness rebase costs a full re-attestation and a full review round
for identical content. The evidence model and the freshness policy are in
direct tension, and this record resolves it in the evidence model's favor:
the gates bind to heads *on purpose* (GH-1841 chose `base_ref` over base SHA
precisely so that routine merges to main would NOT invalidate open
attestations — binding to the base SHA would have made every merge a
repo-wide re-attestation, "churn, not a gate"). A freshness convention
re-creates by hand the exact churn GH-1841's design deliberately declined.

**Derived rule (normative): never rebase for freshness alone.** Rebase to
resolve a real conflict, or when re-verification is the point — those are the
two cases where the rebase buys the safety property rather than the proxy.
This rule lives in this record and travels in the skill reference, not only in
CLAUDE.md, because a host repo that installs the gate kit (GH-2083) inherits
the same evidence model and therefore the same cost.

## 4. Work shape

### The unit

**One issue = one PR that is independently mergeable.** This is the definition
that makes "acceptable issue size" observable instead of a matter of taste:
you can look at a filed issue and ask "can the diff this describes land
without any other open PR landing first?" — and the answer is checkable at
review time, because a PR that needed another PR is either stacked (visible)
or broken (caught). Every alternative definition we considered ("one logical
change", "one reviewable diff", "one day of work") grounds out in the judgment
of whoever is arguing, which is exactly the property a doctrine for autonomous
filing cannot have.

### Sizing — Estimate measures agent context budget

The dimension on which units actually fail here is not calendar time. It is a
unit outrunning one context window: the session compacts, loses the thread,
re-reads what it already read, and ships a worse diff slower. So Estimate is
redefined (same five options, no field change — the *meaning* is what was
missing) as the unit's context budget:

- **XS** — one session, no plan artifact. Read, change, verify, ship.
- **S** — one session, with a plan artifact worth writing first.
- **M** — one session at the edge. Expect a handoff artifact; a second session
  finishing it is normal, not a failure.
- **L** — decompose before working. A claim on it is probably a mistake.
- **XL** — decomposition is the only action the item admits.

This retroactively explains the one existing semantic consumer instead of
leaving it an orphan constant: "XS/S singles never touch frontier"
(work/SKILL.md:50) was always a statement about context budget — a unit small
enough to fit comfortably in one sonnet session has nothing for a frontier
bookend to add. The rule was right; its dimension was unnamed.

Rejected: human-time semantics (the natural reading of XS–XL, and wrong on the
failure dimension — a 3-day human task that is mechanically repetitive is a
fine XS for an agent, and a 2-hour human task requiring whole-tree context is
an L); and a numeric token-count field (false precision — nobody can estimate
tokens, everyone can rank "fits / fits with a plan / at the edge / doesn't").

### Epic is derived, never declared

board.ts already computes it: rankNext classifies an eligible item with open
board-resident descendants as a root and demotes it — "its eligible leaves
carry the epic forward" (board.ts:505) — with no field and no label. So the
doctrine simply names what the code does: **epic = has open board-resident
descendants; unit = has none; and an item stops being an epic the moment its
last descendant closes.** Descendants, not children: a Done phase between a
root and its live grandchildren is pass-through topology the ranker resolves
on purpose (`closedTreeEdges`, GH-1814), so a glossary that said "children"
would misstate the code it claims to merely name. And the derivation is
already richer than any declared field could stay: rankNext's predicate
encodes approval semantics — an unapproved descendant in Intake does *not*
demote its root, because that would hide the root behind work nobody has
approved and name an in-flight holder that cannot exist (the GH-2077 comment,
board.ts:511–515). A `Type` field would have to re-learn both of those rules
by hand, and would drift on each.

A `Type` field is rejected: it would be a second spelling of a fact the parent
edge already carries — the GH-1843 drift shape, a rule living in two places
held together by nothing — and it fails in a specific way: the field says
"epic" after the children close (or before they are filed), the edges say
otherwise, and every reader must pick a winner. The Intake tier won on exactly
this argument (GH-2077: a state over a field, because exclusion is by
construction and there is no reader to forget). **Feature is not a board
concept at all** — it is prose about a user-visible outcome, useful in an
issue body, keyed on by no rule anywhere. §9's plan includes retiring the
word from work/SKILL.md's model-tier line.

### What a good issue looks like

A good unit issue states an *outcome* and its *verification*: what is true
after the PR merges that was not true before, and how the session will know.
It carries a Priority and an Estimate (the Backlog bar, unchanged — see
below). It names its blockers as edges, not prose. It does not enumerate
implementation steps — the session's plan artifact does that, sized by the
Estimate.

A bad issue, in the shapes this board has actually accumulated: an issue that
is secretly two PRs ("do A, and also the follow-up B that depends on A" — two
units, one edge); an issue whose body names its blocker in prose with no edge
(§5 — a defect, not a style choice); an XL claimed directly (§6); an issue
whose only verification is "it works" (unverifiable is undeliverable); and an
issue restating another's scope with different words (tend's dedup exists
because this happens; the dep-candidates selector in §5 makes the overlap
visible at filing).

### When work is disjoint — what the merge measurements actually say

Sixty first-parent merges on this repo: the most-touched file is CLAUDE.md at
16/60 (27%), then the herdr version stamps (herdr-plugin-version and
herdr-plugin.toml, 11 each), board.ts (10), CHEATSHEET.md (10). The top of
the collision surface is append-heavy prose and generated version stamps —
two agents on perfectly disjoint *domains* still both append a rationale
paragraph to CLAUDE.md and both bump a version file, and conflict every time.
**That is not a decomposition failure, and no amount of domain separation
fixes it.** The remedy for that class is mechanical (merge drivers,
append-anywhere formats, generated-file regeneration on merge), not better
issue-cutting — which bounds what this doctrine can honestly promise: good
decomposition minimizes *semantic* overlap; the residual textual conflicts on
shared prose and stamps are a property of the repo's substrate.

A host repo consuming this plugin (~48 active agent worktrees), same
measurement: top file is its lockfile at 7/60 (12%), then a package manifest,
then infra, then one shared dispatcher module, then per-domain CLAUDE.md files
already fragmented by domain. Its surface is *flatter* than ours — domain
separation there is working — and the residual is lockfiles and shared infra,
neither of which better decomposition removes. Two repos, same conclusion
from opposite directions.

## 5. Ordering

### blocked-by vs parent — the rule that did not exist

**parent (`board link`) is rollup only.** It drives priority inheritance
(rankNext's `effRank` walks it) and parent-check's all-children-closed
promotion. It asserts *nothing* about ordering — children of one epic are
routinely worked concurrently, and the ranker is built on that.

**blocked-by (`board dep`) asserts ordering, and for exactly one reason: B's
diff cannot be written or verified until A has merged.** The test is about the
diff, not about comfort. Explicitly NOT blocked-by:

- *"touches the same file."* File overlap is a property of a moment, not of
  the work — it changes every time anything merges, so an edge recording it is
  stale on write. This is the same argument GH-1841 already settled for
  `base_ref` vs base SHA: bind to the thing that changes on the event you care
  about and on no other. A file-overlap edge changes on events nobody cares
  about and survives events everybody does.
- *"easier to review after A."* Reviewer convenience is not a dependency; it
  is a sequencing preference the driver can honor without an edge that the
  fleet guard will then enforce as fact.
- *"same author."* Sessions are fungible by design; an edge encoding who
  should work something is a claim wearing a dependency's clothes, and the
  claim field already exists.

The failure directions differ, which is why the rule is strict: a missing
true edge causes a wrong parallel spawn — a claim, a branch, a worktree, and a
whole session spent before anyone notices (dep-refs.sh's own header names the
cost) — while a false edge silently serializes work that could have been
concurrent, invisibly, forever, because nothing ever audits an edge for being
unnecessary. Both directions are expensive; only the second is undetectable.
So the doctrine biases the *edge* toward necessity and puts recall in the
*selector* (below), which never writes.

### An unwired prose dependency is a defect

**blocked-by is the only sanctioned spelling of ordering.** GH-2109 measured
the alternative: with ordering allowed to live in prose, roughly half of open
items carried a body reference no edge recorded, and the fleet guard is
exactly as complete as the wired graph. dep-refs.sh stays as a fail-open
*backstop* — it over-reports by design ("see GH-2060 for the design" is not
"blocked by GH-2060") and its caller refuses with a named override rather
than filtering silently — but a scanner at every consumer is N copies of a
rule, and GH-2120 is open right now because refill.sh and work-next.sh share
the blind spot work-fleet.sh's scanner covers. Making the edge the only
spelling means the graph converges; leaving prose sanctioned means the
scanners multiply, each a copy that can drift (GH-1843, again).

### The backlog-wide check — one selector, two write points

A new issue's dependencies are not only on its siblings. The session
established the gap concretely: a decomposition validated in isolation can be
internally consistent and still land a unit whose real blocker is an
*existing* unclaimed Backlog item nobody re-read. So the check must run
against the live backlog, and it must run at **both** write points, calling
the **same** selector — the filing path (every `board create`, epic
decomposition included) and tend's dependency-wiring work. Two spellings of
one rule is the drift shape this repo has paid for twice (GH-1843 across five
gate scripts; GH-2058 across four hook funnels); it does not get a third
instance. A doctor advisory line rides beside them because tend is capped at
`RALPH_TEND_BATCH` (default 5) items a pass, so an unwired candidate can sit
for many passes without ever being the item under judgment — the advisory
names the backlog-level fact no per-item pass surfaces. It rides doctor's
info rules in full, the way `intake-stale`, `board-volume` and `gate-kit`
already do: never strict-escalated, never acted on by `--fix` (the only
remedy is a judgment an agent or human makes), and a read that throws
degrades to *not evaluated* rather than touching the exit code.

### The mechanism — `board dep-candidates NNN`

A typed selector returning scored candidates from the **unclaimed Backlog**
by term overlap on title and body, which an agent then *judges*. Feasibility
is already paid for: the unclaimed Backlog is exactly the population the
issues-rooted read returns — GH-1814 moved the ranking lanes onto
`repository.issues(states: OPEN)` at a measured 30 → 13 points and 47 s → 5 s
— so the selector reads a surface that exists rather than adding a walk.

Rejected: a bare skill instruction ("list the backlog and judge it") — a
convention that degrades silently as the backlog grows, which is precisely
how the prose-refs gap reached half the board; and a semantic index over open
issues — a new subsystem for a problem term overlap probably solves.
Honestly: no semantic index over board items exists today — ralph-knowledge
indexes markdown by path segment (`PATH_TYPE_MAP` in
plugin/ralph-knowledge/src/parser.ts: research/plans/ideas/reviews/reports),
not issues — so that alternative is not "reuse the index", it is "build one",
and it stays rejected until term overlap is measured insufficient.

**The selector is biased toward recall, and says so in its output.** The
asymmetry runs opposite to dep-refs.sh, and the record states both directions
so nobody "fixes" one into the other: dep-refs is biased toward *silence*
because its caller treats a hit as a refusal, so a false positive blocks real
work; dep-candidates feeds a *judgment*, so a missed candidate costs a wrong
parallel spawn and a rebase cascade while a false candidate costs one
judgment call an agent was already making. Three bounds carry it: the
selector **never writes an edge** (the agent judges; the edge is the agent's
act, on the record); a **candidate cap** so it cannot dump the backlog into a
context window; and an unreadable read prints **NOT CHECKED, never none** —
GH-1971's rule, load-bearing here because a filing path that silently skipped
the check would render exactly like a filing with no dependencies.

### tend gets `deps-unwired`

A third sibling in the existing deps-* family (`deps-cleared`,
`deps-truncated`, board.ts:6135), fed by the same selector. Rejected: folding
it into `unformed`, which means "missing Priority or Estimate"
(tend/SKILL.md) — a different question, and collapsing them would make one
category mean two things, so a clean sweep of formation work would silently
assert dependency hygiene nobody checked.

## 6. What ralph enforces, where — three loci, honestly split

Ralph cannot fix a host repo's substrate: the readiness principle (2026-08-01)
is that the plugin adapts to the repo, never the reverse, and a lockfile-heavy
monorepo stays one no matter how its issues are cut. So this doctrine acts at
exactly three places, and only one of them is enforcement:

**(a) FILING — doctrine that travels, never gates.** The decomposition rules
(§4, §5) live in a skill reference under ralph/skills/*/references/, cited by
the work and tend filing surfaces — because a rule only humans read cannot
change how agents file issues, and a convention held by prose alone drifts.
This is deliberately advisory: **the filing bar does not grow.**
`backlogReadinessGaps` stays exactly Priority + Estimate (board.ts:6335). An
earlier draft proposed "an XL cannot land in Backlog" and it was rejected as
Bitter Lesson territory: there are legitimate reasons to file an XL for later
decomposition, and decomposition itself may stop being something we do —
encoding a structural assumption about model capability into the filing bar
is hard-coded human-shaped scaffolding that will age badly, and unlike a
threshold it cannot be un-set without rewriting doctrine. Nothing about size
or shape is encoded at filing.

**(b) DISPATCH — ralph's own surface, the only real enforcement.** Two
mechanisms:

*The claim-time ceiling.* `RALPH_CLAIM_MAX_ESTIMATE` (default XL): a claim on
an item at or above the ceiling **refuses**; L warns. No override flag — "no
`--force` exists anywhere" is this repo's standing rule, and the escape hatch
is the same shape `--steal` gave stale claims: the explicit assertion that an
item is not really XL is *re-estimating it* — one command, one visible field
change, on the record. The ceiling is an **environment fact, not doctrine**,
and making it configurable rather than constant is load-bearing: context
windows move, and a hard-coded "too big to work" constant is a claim about
harness capability that will age. If decomposition stops being necessary, the
ceiling is set to nothing and no doctrine needs rewriting. Every other
threshold in this repo already works this way — `RALPH_LOCK_TTL_MIN`,
`RALPH_VOLUME_MAX_ITEMS`, `RALPH_REVIEW_ROUND_CAP` — facts about a machine, a
board, a reviewer, never rules about work.

The ceiling's failure direction, stated because estimate-less Backlog items
exist *on purpose*: **no Estimate, or an unreadable field read → not
evaluated, never refused.** State-guard adoption deliberately lands Backlog
without the Priority + Estimate bar (an auto-adopted release-failure filing,
GH-1952, must reach a driver unattended — CLAUDE.md states the exemption),
so the population the ceiling cannot read is exactly the population an
unattended loop claims. The ceiling gates what the field *says*; a field
nobody set is not evidence the item is oversize, and refusing on absence
would strand every auto-adopted filing behind a guard whose only remedy
(re-estimate) no unattended session can run. Same shape as the session
binding ("no session id → not evaluated, never refused") and the worktree
guard ("no repo root → not evaluated, never guessed at").

*The in-flight surface print.* At spawn time nobody knows which files a unit
will touch, so predicted overlap is a guess dressed as a measurement. What IS
knowable is what the fleet currently holds open: the files touched by every
currently-open fleet PR, grouped by unit, printed at spawn — no scoring, no
prediction, no refusal. Rejected: predicting from history (wrong for any unit
doing something new, which is most of them) and a declared-surface field on
the issue (unset exactly when it matters, and stale the moment the session
diverges from its plan). Advisory by construction, following the fleet
guard's own discipline (GH-2109): it never refuses a spawn and never
substitutes work — SKIP, never backfill — and it fails OPEN, loudly: an
unreadable PR list prints that it could not be read, and the spawn proceeds.

*Serial dependent work is a queue, not a branch stack.* The fleet spawns a
frontier of mutually unblocked units (work-fleet.sh reads `board frontier
--json`); a chain of blocked-by edges is worked as consecutive claims, each
PR landing on main before the next begins. GitHub stacked PRs are allowed
only as a narrow exception — the same agent owning the whole stack in one
session and landing it in one sequence — because general stacking collides
with the evidence model head-on: the gates bind evidence to `head_sha` and
`base_ref`, a stack retargets on every merge, and a retarget invalidates the
attestation *by design* (GH-1841's `base-changed` reason code exists to catch
exactly this). A fleet of stacked PRs would spend its entire review budget
re-attesting topology. (And a stacked base merged with `--delete-branch`
closes its dependent PR outright, with no retarget — observed on this repo —
which turns a routine merge into recovery work.)

**(c) MEASUREMENT — reads the host, recommends, gates nothing.** §7.

## 7. Host repos: what travels, what is recommended, what is never imposed

**What travels:** the skill reference (loaded into agent context wherever the
plugin runs — vocabulary and filing doctrine ride with the skills), the
dispatch mechanisms (ceiling, surface print, selector — they act on ralph's
own surfaces), and, for kit repos, the never-rebase-for-freshness-alone rule,
because the installed gate family carries the same head-bound evidence model
and therefore the same rebase cost.

**What is recommended:** the readiness report grows Level-3 concurrency
checks. Level 3 is the right home — readiness is already the
recommendations-never-gates surface (three levels; `return 0; // advisory by
design`, board.ts:10497), and concurrency policy only becomes a question once you are
running the autonomous loop, which is what Level 3 *is*. Rejected: its own
verb (a surface nobody discovers — the discovery problem is real; CHEATSHEET
§ pointers exist because measured sessions burned 5–15 tool calls
re-deriving known paths) and a doctor line (doctor sweeps board invariants;
"what integration policy suits this repo" is a host-repo property, not a
board invariant).

**The report outputs a recommended policy, not a table.** Measured inputs:
collision surface across recent merges, main velocity, median PR lifetime,
whether the ruleset sets strict ("require branches up to date"), whether a
merge queue exists. It emits a recommended integration policy *with the
reasoning*, the way readiness already emits one-line recommendations per
miss. The rationale is stated honestly: a report that outputs a DECISION gets
read; a report that outputs a TABLE joins the twelve unread dependabot PRs —
GH-2048's own honest limit ("making orphans visible does not make anyone
look") applies to every measurement surface this repo builds, including this
one, and the only mitigation we know is to make the output an actionable
sentence instead of data.

**The org-standard case: recommend a merge queue.** When an org standard says
"PRs must be up to date with main" — and note the measured host repo's
ruleset does NOT set strict, so its observed rebase churn is convention or
genuine conflict, not policy; the org-standard case is the *other* repo —
the answer is a merge queue, not rebasing and not stacking. A merge queue
delivers verified-as-landed (the real property, §3) without any human or
agent rebasing: it rebases and tests speculatively at merge time, exactly
once, at the only moment freshness is worth anything. Strict mode without a
queue forces a rebase after every merge whether or not anything conflicts —
the O(n²) cost plus, in a kit repo, the evidence-destruction cost, for a
property the queue buys for free. **Non-goal, stated:** ralph does not
implement a merge queue; it recommends one. GitHub ships this; building a
second one inside a board CLI would be a subsystem with an owner elsewhere.

**What is never imposed:** a host repo does not get a CONTEXT.md. ralph-hero
gets one (the §2 glossary — this is our repo and our vocabulary). The plugin
never writes a glossary into a host tree — that is precisely the imposition
the readiness principle forbids — and the vocabulary travels only as the
skill reference the agent loads into context. Readiness does not recommend
adopting one either: a glossary is not an agent-readiness property of the
host repo; it is ours.

**The ADR question, settled:** this repo's convention IS a design record in
thoughts/ summarized into CLAUDE.md; docs/adr/ does not exist here and is not
proposed. This record is the ADR.

## 8. Honest limits

- **Ralph cannot fix a host repo's substrate.** A lockfile at the top of the
  collision surface stays there under perfect decomposition (§4's
  measurements, both repos). The doctrine bounds semantic overlap; textual
  overlap on shared artifacts is the repo's property.
- **Term overlap is a heuristic and will both over- and under-report.** Two
  issues about the same subsystem in different vocabulary are invisible to
  it; two issues sharing boilerplate phrasing look related and are not. The
  selector's recall bias and never-writes rule are the containment, not a
  fix; if measured insufficient, the semantic-index rejection in §5 is the
  first thing to revisit.
- **The in-flight surface print is a fact about now and stale the moment it
  is read.** A session that pivots mid-work invalidates it silently. It is
  printed at spawn because that is when the routing decision happens, and it
  claims nothing beyond that instant.
- **The filing doctrine is advisory at filing and unenforceable there by
  design** (§6a). An agent can file a two-PR issue and nothing refuses it;
  the ceiling catches oversize at claim, tend catches shape drift on its
  cadence, and the residue is caught at review or not at all. This is the
  price of not growing the filing bar, paid knowingly.
- **The ceiling keys on Estimate, and Estimate is self-reported.** A
  mis-estimated M that is really an XL sails under the ceiling. The remedy is
  the same visible re-estimate the ceiling's escape hatch uses — and the
  session that discovers mid-work that it holds an XL escalates rather than
  grinding, which is work/SKILL.md's existing discipline, not this record's.
- **The readiness recommendation is computed from a window of history** and a
  repo changing its behavior (a new fleet arriving, a monorepo split) makes
  it wrong until the window rolls. It says what it measured and when; it
  cannot say what the repo is about to become.
- **A recommendation read by no one changes nothing** (GH-2048's limit,
  inherited by every advisory surface in this record).

## 9. Implementation plan

Each unit below is independently mergeable, sized on the §4 scale, with its
blocked-by edges named — the record obeys its own doctrine, and a plan that
could not be decomposed under its own rules would be a self-refuting
document. **All are filed as INTAKE, not Backlog:** approving a design
session's own output for autonomous pickup is exactly what the intake tier
exists to prevent (GH-2077 — filing is not approving).

1. **This record + root CONTEXT.md** (the §2 glossary, verbatim, terms only).
   XS. No blockers.
2. **The work-shape skill reference** under ralph/skills/*/references/, cited
   by the work and tend filing surfaces: the unit definition, the Estimate
   semantics, blocked-by vs parent, never-rebase-for-freshness-alone. S.
   Blocked by 1 (it cites the record's vocabulary; its diff cannot be
   verified against a glossary that has not landed).
3. **`RALPH_CLAIM_MAX_ESTIMATE`** in board.ts's claim path: refuse at/above
   the ceiling (default XL), warn at L, no override flag, refusal names the
   re-estimate remedy; no Estimate or an unreadable field read → not
   evaluated, never refused (§6b — the auto-adopted population claims
   estimate-less by design). S. **Blocked by GH-2126** (`board estimate NNN`),
   found on filing: the refusal names re-estimating as its remedy, and
   `--estimate` exists only on `create` — shipping this first would add a
   third instance of the class GH-2129 names (a gate acquiring enforcement
   weight on a field with no CLI write surface).
4. **`board dep-candidates NNN`** — the typed selector: unclaimed-Backlog
   population from the issues-rooted read, term-overlap scoring, candidate
   cap, NOT CHECKED on unreadable, never writes. M. No blockers.
5. **`deps-unwired` tend category + doctor advisory line**, fed by the
   selector. S. Blocked by 4.
6. **Filing-path dependency check** — `board create` calls the same selector
   and prints candidates (advisory; filing proceeds). S. Blocked by 4.
7. **Readiness Level-3 concurrency checks** emitting a recommended
   integration policy (inputs: collision surface, main velocity, PR
   lifetime, strict flag, merge-queue presence). M. No blockers.
8. **The fleet in-flight surface print** in work-fleet.sh spawn output:
   files touched by open fleet PRs, grouped by unit, fails open loudly. S.
   No blockers.
9. **work/SKILL.md model-tier amendment.** The current line reads "Frontier
   (`fable`, else `opus`) only as in-session bookends on feature/epic units"
   (work/SKILL.md:50) — and after this record, "feature" names nothing.
   Reword to key on the derived epic and the Estimate scale: frontier
   bookends for epic roots and M units; XS/S singles never touch frontier
   (the second half is already right). Deliberately not "M+": L and XL are
   units the doctrine says to decompose before working — L warns and XL
   refuses at claim under unit 3 — so they reach a frontier bookend only
   after decomposition, as the M-or-smaller units they become. XS. Blocked
   by 2.

Units 4, 7, 8 are mutually unblocked — a frontier of three (unit 3 joined
the blocked set when filing surfaced the GH-2126 edge) — which is the
smallest evidence that the doctrine describes work that can actually be cut
this way. That an edge was FOUND at filing, by checking the plan against the
live board, is the record's own §5 doctrine doing its job on its own plan.

Filed 2026-08-24, all as Intake: units 1–9 are GH-2132 through GH-2140 in
order, edges wired (2133←2132, 2134←2126, 2136←2135, 2137←2135, 2140←2133).
