# Bulk field editing on the board CLI — design record (GH-2125)

- **Date**: 2026-08-23
- **Unit**: GH-2125 — Design a bulk field-edit surface for the board CLI (no multi-issue mutation exists today)
- **Provenance**: research session, driving agent, 2026-08-23. The unit's body gated implementation on exactly this record and asks for a recommendation, "including *do nothing, the shell loop is correct*, if that is where the evidence lands." Costs below are measured on this board, not estimated.
- **Status**: decided (implementation pending; see "Implementation units")

## The gap being asked about

Every mutation verb in `board help` is single-item. Correcting the Priority of ten
mis-filed items is ten invocations, each paying its own config read, scope gate and
item resolution. The ask: does a bulk surface belong in this CLI, and if so what
shape inherits the guarantees the single-item verbs already carry.

Two premises in the ask turn out to be false, and each one changes the answer. They
are stated here before the decisions, because the decisions are downstream of them.

### False premise 1 — "a second spelling of a rule that currently has one"

True for Priority. **False for Estimate, which has no spelling at all.**

`--estimate` exists only on `create` (board.ts:6793-6795). There is no
`estimate NNN <option>` verb — the switch at board.ts:9569-10787 has no `case
"estimate"`, and the `MUTATING` set (board.ts:9501-9505) does not list one. Its only
writer is `setSingleSelect(ctx, cache, itemId, ESTIMATE_FIELD, …)` inside
`createIssue`, and that call's own failure hint tells the operator to "set it in the
board UI" (board.ts:6850) — because there is no CLI verb to name.

This is not cosmetic. `backlogReadinessGaps` (board.ts:6337-6344) requires Priority
**and** Estimate, and it gates both the `Intake → Backlog` approval edge
(board.ts:2449) and `create --backlog` (board.ts:6647). So an item that reaches
Backlog by a path that does not run the bar — `adopt` and `reopen` both land Backlog
by design — is unsized, ranked, and **unfixable from the sanctioned mutation path.**

The population is live, not hypothetical. Of the 13 open board items on 2026-08-23,
**6 carry no Estimate** (#1965, #2067, #2105, #2107, #2112, #2113); 0 lack Priority.

That inverts the ask for one of its two fields. You cannot design a bulk spelling of
a rule that has no single spelling — the bulk form would be the *first* spelling, and
it would be the only way to set a field the approval bar demands.

### False premise 2 — "every correction on this board posts a comment"

Not for the field class this unit is about. `setPriority` (board.ts:6583-6602) never
calls `addComment`; the path is `fetchIssue` → `requireItem` → `mutationCache` →
`setSingleSelect` → `fetchIssue` read-back, and nothing else. Confirmed empirically:
`board priority 2125 P3` was run twice while researching this, and #2125 carried zero
machine comments afterward.

Contrast `setDefer` (board.ts:6609-6633), which posts a comment before *every* write,
`--clear` included. So the repo's actual rule, read off the code rather than asserted:

> A write posts a comment when it changes what a reader will **do** — `defer` parks an
> item out of ranking, a `transition` moves the machine. It posts nothing when it is
> an **advisory ranking input**.

That dissolves the "fifty comments is noise, zero is unauditable" dilemma the ask
poses. It is already answered, in the direction of zero, by the verb the bulk form
would be made of.

## The measurement

The "fewer round trips" argument is worth exactly what it measures, so it was measured.
Idempotent `board priority 2125 P3` (P3 → P3), `RALPH_GQL_COST=1`, run twice, 3 s apart:

```
[gql-cost] repository      cost=6  nodes=26730     ← fetchIssue        (board.ts:6584)
[gql-cost] repositoryOwner cost=1  nodes=50        ← forced refreshCache (board.ts:1787)
[gql-cost] repository      cost=6  nodes=26730     ← fetchIssue read-back (board.ts:6601)
                                    + the unlogged field mutation
rate-limit counter: 263 → 277 = 14 points.  wall 2.06 s.
```

The second run was identical (277 → 291). Nothing amortizes: mutating commands force
`itemCacheTtlSec: 0` (board.ts:9527), and `fetchIssue` is a point read that the walk
cache never covered anyway. So a shell loop over N items costs **~14N points and ~2N
seconds**, and 12 of every 14 points is the same board read twice per item.

What that buys, against the budget: 5000 points/hour, which this repo has driven to
0/5000 once already (GH-1817). Ten items is ~140 pts; fifty is ~700 pts, 14% of the
hourly budget spent on fifty advisory field writes.

What is **already invocation-scoped** and gets re-paid N times by the loop:

| cost | scope today | line |
|---|---|---|
| scope gate (`git remote get-url origin`) | once per invocation, before dispatch | board.ts:9533-9541 |
| forced schema refresh (live option validation) | once per `mutationCache` call | board.ts:1787-1788 |
| `fetchIssue` resolution | **per item** | board.ts:6584 |
| `fetchIssue` read-back | **per item** | board.ts:6601 |

`mutationCache`'s own comment says "One extra schema read **per priority write** is the
price of validating against truth" (board.ts:1776). A batched verb validates N values
against **one** live read of that same truth: the guarantee is identical and the price
is divided. Batching does not weaken this guard — it is the guard's best case.

## Prior art: v1 shipped exactly this, and it is the argument for Decision 2

The unit says bulk mutation "is NOT unprecedented" and points at `prune` /
`sweep-non-issues` / `reap-leases`. The real precedent is closer than that. **v1's MCP
server shipped a bulk field-edit tool with this unit's exact scope**, and its history is
the most useful evidence available here.

`ralph_hero__batch_update` — "bulk-updating project fields (**workflow state, estimate,
priority**) across multiple issues in a single tool call"
(`thoughts/shared/plans/2026-02-16-GH-0021-batch-operations.md`). It shipped in
`689898f1`, absorbed `archive_items` in `75d125a5` (GH-1611), and was deleted in
`65ec3f56` — "GH-1662 Phase 4 — delete the MCP server and its release treadmill."

Three things follow, and each one is load-bearing.

**1. It was not ruled against; it was collateral.** The commit that removed it removed the
whole 20.7k-line server. No record in `thoughts/` argues bulk field editing was wrong.
So this design is not re-proposing something the repo rejected — but neither may it claim
v1 as an endorsement. The question is genuinely open, which is why it is being decided here.

**2. Its generic-field shape let bulk state writes ship unguarded — the precise failure
Decision 2 forecloses.** `batch_update` took Workflow State because a tool with a "which
fields?" parameter naturally does. Its own plan treats the guard as someone else's
dependency: *"If #19 has not landed, `batch_update` uses direct state names **without
transition validation**"* (GH-0021 plan, Implementation Approach). It shipped that way,
and the fix needed its own unit a year later — `a352a7c4`, GH-1615, which enforced
"transition legality ahead of ALL mutation … per-issue in `batch_update` (**with its own
fail-closed current-state fetch, distinct from the pre-existing fail-open**
`skipIfAtOrPast` optimization)", and in passing found `create_issue` to be "the sixth,
previously-unvalidated Workflow State writer."

Six writers of one field, one of them bulk and fail-open, retrofitted with a guard by a
dedicated unit. That is the GH-1843 shape and the bulk-`move` hazard, both realized, in
this repo, from this exact feature. Decision 2 is not a hypothetical precaution — it is
the one structural difference that would have prevented it, because a verb that names its
field in the verb has no parameter for Workflow State to arrive through.

**3. Its cost model does not survive the v2 rewrite, and copying it would be the GH-1807
mistake.** GH-0021 planned aliased *mutations* — `u1:`/`u2:` `updateProjectV2ItemFieldValue`
in one document — quoting "10 issues × 2 fields: ~22 points vs ~60 points (63% savings)",
on a v1 where each single update cost 3 API calls. On v2's measured split the mutation is
roughly 1 of 14 points and the two `fetchIssue` calls are 12. Batching the writes would buy
about a point an item and introduce a document shape that exists nowhere in `board.ts`;
batching the *reads* is where the measured waste actually is. Same conclusion the plan
reached about caching — "cache invalidation happens once per batch, not per-item" — which
v2 gets from `mutationCache` for free.

One v1 decision is deliberately **not** inherited: GH-0021 chose "not adding rollback
semantics (field updates are idempotent; partial results are acceptable)" and reported
per-issue status instead. That is right for a tool a model calls and can re-read; it is
wrong for a CLI a human types, where a mistyped number that silently does nothing is
discovered later or never. Hence fail-closed resolution before the first write (Decision 4).

## Decision 1 — Give `Estimate` a single-item verb, before anything bulk

`board estimate NNN <option> [--clear]`, built as `setEstimate` in the exact shape of
`setPriority` (board.ts:6583-6602): `fetchIssue` → `requireItem` → `mutationCache(…,
liveOptionFields: [ESTIMATE_FIELD])` → `setSingleSelect`/`clearField` → read-back.
Options come from the live field, not a hardcoded `XS..XL`, for the reason `priority`
already gives — a host repo owns its scheme.

The deciding property is that **this is the whole fix for the population that
motivated the ask.** Six unsized Backlog items exist because no verb can size them,
not because sizing them one at a time was tedious. A bulk surface built while
`estimate` is missing would be shipping the optimization and skipping the feature.

It also removes the false-premise asymmetry: once both fields have a single-item verb,
"is bulk a second spelling?" is one question about two symmetric verbs, instead of two
different questions wearing one name.

Rejected alternatives:

- **Skip it; bulk `estimate` alone is enough.** Rejected because it makes the bulk
  form load-bearing for a guarantee the approval bar depends on. `move N backlog`
  refuses without an Estimate, so the *only* path to approval would run through a
  verb whose whole justification is convenience. A gate's precondition must be
  reachable by the plainest verb there is.
- **Drop Estimate from `backlogReadinessGaps` instead.** That weakens the approval bar
  (GH-2077's "approved *and rankable*") to avoid writing one verb. Wrong direction.

## Decision 2 — Bulk is extra **arity on the existing field verbs**, never a new `set` verb

`board priority 2105,2107,2112 P1` and `board estimate 2105,2107,2112 M`. Not
`board set <targets> --field Priority --value P1`.

The deciding property is that **`move` is then excluded by construction, not by
discipline** — which is precisely what the unit asks for, and which v1's `batch_update`
shows is not a theoretical concern (Prior art, point 2). A generic field-writing verb
is a surface with a `--field` flag on it, and `--field "Workflow State"` is one flag
away from bulk-transitioning the board past the MACHINE table, the claim protocol, the
Done-evidence gate and the approval bar — every one of which is a *per-item* argument.
Pluralizing the arity of `priority` and `estimate` creates no such surface: there is no
place to put `move`, because these verbs name their field in the verb.

It also disposes of the GH-1843 hazard the unit correctly raises. That hazard is a
second *implementation* of a rule — five scripts each re-deriving the same policy,
held together by comments asking the copies to stay in sync. Calling `setPriority`'s
guard path N times behind one resolution is not a second implementation; it is the one
implementation, invoked more than once. The drift shape only appears if the bulk path
re-derives option validation, the archived guard, or scope — so the rule that keeps it
away is: **the bulk path must call the same per-item writer, and own nothing but
resolution, iteration and reporting.** That is exactly the division `removeProjectItems`
already draws (board.ts:7518-7546), and its doc comment gives the same reason: one
answer to "when do we stop trying", because "a second copy of it is a second place for
the circuit breaker to rot" (board.ts:7513-7517).

Rejected alternatives:

- **A generic `board set` verb.** Argued above: it is the one shape that makes bulk
  `move` an increment rather than a redesign.
- **A separate `bulk-priority` verb beside `priority`.** Two verbs for one field is
  literally the two-spellings failure, and the second one exists only to hold a comma.

## Decision 3 — Targets are an explicit list on argv. There is no selector form.

`--state intake`, `--label X`, `--all-unsized` and every relative are rejected.

The unit names the hazard correctly — the set is computed at read time and acted on at
write time, so the operator approves a count and the tool acts on a different one — but
there is a sharper argument available from this repo's own code. `prune` and
`sweep-non-issues` **re-walk and re-classify inside the same invocation**
(board.ts:10500-10629, 10631-10730); no candidate set is ever carried between two
invocations, and the item cache is zeroed for every mutating command precisely so a
write-guard never evaluates against a stale read (GH-1806, board.ts:9527). A selector
with a binding dry run would need to persist a computed set across invocations — a kind
of state this CLI has nowhere, and which every existing guard is built to avoid.

With an explicit list the problem does not get managed, it **does not arise**: the set
the operator approved is the set on argv, byte for byte, and there is nothing between
check and use to diverge. That is why the dry-run question below answers the way it does.

The selector's ergonomics are not lost, only moved somewhere auditable — `board list
--json` composed into the command substitutes for it, and the operator sees the numbers.

## Decision 4 — Which of the five bulk-pattern properties it inherits, and which it must not

The unit requires an argument for each. The three-verb pattern is `prune` /
`sweep-non-issues` / `reap-leases`.

| Property | Inherited? | Why |
|---|---|---|
| **Dry run unless `--apply`** | **No** | prune's set is *computed and unbounded* — the operator cannot see it before running, so the dry run is how the set becomes visible. An explicit argv list is already visible. Defaulting to dry run would make every real use two invocations, doubling the cost the verb exists to cut, and would train `--apply` as a reflex on the one surface where it is the only guard. |
| **`--limit` (200)** | **Yes**, same default | argv is *mostly* self-limiting, but `$(seq …)` and a bad `--json | jq` composition are exactly how a list stops being hand-typed. Same number as prune, because a cap that differs per verb is a second rule. |
| **Consecutive-failure breaker (5)** | **Yes**, same constant, same code | Its reason is unchanged: a rate limit or a revoked scope mid-run must not burn the budget. This must be the *shared* helper, not a copy — see Decision 2. |
| **`--json` reports the run actually performed** | **Yes** | Non-negotiable and for the identical reason: a report that says "dry run" under a real apply is the one lie the sweeps explicitly forbid. Shape follows `PruneApplyResult` (board.ts:7484-7489): `{attempted, applied, succeeded, failed[], abortedAfterConsecutiveFailures}`. |
| **A fail-closed predicate** | **N/A — and saying so is the point** | prune needs one because removing a board item destroys Workflow State and Claim, and other readers depend on the items it might take. A Priority or Estimate write destroys nothing, is idempotent, and is advisory by the unit's own framing. There is no set to exclude. What replaces it is **fail-closed resolution**: any named issue that cannot be resolved, is archived, or is not on the board aborts the run **before the first write**, naming the number. Partial application from a typo is the failure mode here, and it is prevented up front rather than reported after. |

## Decision 5 — Audit trail: zero comments, matching the single-item verb exactly

No comment per item, and no summary comment either.

The deciding property is stated in False premise 2: the bulk form must be **neither more
nor less audited than the write it is made of**. `setPriority` posts nothing; a bulk
priority write posts nothing. A summary comment would be a rule that exists only in the
bulk path — which is the drift this design is otherwise structured to avoid, arriving
through the one door left open.

The audit trail that does exist is the one the repo already relies on for advisory
fields: the Projects V2 item's own field history, plus `--json` on the invocation. If
that is judged insufficient, the correct response is to make **`setPriority`** comment
and let the bulk form inherit it — not to special-case the plural.

## Decision 6 — What deliberately does not change

- **`move`, `claim`, `answer`, `cancel`, `reopen`, `dep`, `link` stay single-item.** Each
  is a per-item argument (guard table, claim read-back, Done evidence, approval bar).
  Decision 2 makes this structural rather than a promise.
- **The scope gate stays where it is** (board.ts:9533-9541, once per invocation before
  dispatch). A bulk verb needs no change to it — which is the point: it is already
  correct for N.
- **`fetchNodeIds` stays as it is.** It is already a generic alias-batched read
  (board.ts:6882-6914, `$n0..$nK` / `a0..aK`), called only with 2-element arrays by
  `linkParent` and `setDependency`. It returns issue `id` only, not the project-item id
  a field write needs — so it is *not* the resolution primitive here (see Honest limits).
- **No alias-batched mutation is introduced.** None exists in board.ts today; every write
  is one `ghGraphQL` call with a single-target mutation. The bulk verb keeps N mutations
  in a sequential loop, exactly as `removeProjectItems` does. Batching the *reads* is
  where the measured 12-of-14 points live; batching the writes would be an unprecedented
  document shape bought for the 1 point that is actually the mutation.

## Surfaces

| Surface | Behaviour |
|---|---|
| `next` / `frontier` | Unaffected. Ranking reads field values; it does not care how they were written. A newly-sized item ranks normally. |
| `tend-queue` | Unaffected in code, **fixed in effect**: its `unformed` category fires on `!i.estimate \|\| !i.priority` (board.ts:6189), and the comment beside it names only "one flag (`board priority NNN P2`)" as the remedy (board.ts:6174-6175) — a remedy that covers half its own predicate. Decision 1 supplies the other half. (A separate precedence effect keeps these items out of the category entirely; see Honest limits 4.) |
| `doctor` | Unaffected. No invariant reads how a field was set. |
| `deliver-queue`, `pr-orphans`, `card-signals`, `closed`, `brief`, `who` | Unaffected by construction — none reads Priority or Estimate as a gate. |
| `prune`, `sweep-non-issues`, `reap-leases` | Unaffected; they share the removal loop and breaker, which the new verbs reuse rather than copy. |
| `board help` | Two entries change: `priority` gains list arity, `estimate` is new. |

## Implementation units

This unit delivers the record only. Both units are filed:

1. **GH-2128 — `board estimate NNN <option> [--clear]`**, the missing single-item verb
   (Decision 1). P2/S. Small, independently valuable, and the whole fix for the six live
   unsized items. **Do this one first and alone**; it is worth shipping whether or not
   anything below is, because it closes a real defect rather than an inefficiency.
2. **GH-2130 — list arity on `priority` and `estimate`** (Decisions 2-5). P3/M, blocked
   by GH-2128. A shared resolve / iterate / report helper reusing the existing per-item
   writers and `removeProjectItems`'s breaker. It carries the measurement task
   (Honest limits 1) as its own first step, since the batched read document must be
   probed before its design is fixed.

The P2/P3 split is the recommendation's real shape: **the gap is worth closing, the
optimization is worth having.** If only one is ever built, GH-2128 is the one.

## Honest limits

1. **The batched cost is not measured, and must not be assumed.** The 14 pts/item
   figure is real; the batched figure is not, because the document does not exist yet.
   Resolving N issues by aliasing N `fetchIssue`-shaped selections would carry
   `projectItems × fieldValues` under *each* alias, and this repo has been wrong about
   exactly that before — GH-1807 added 55 pts/candidate believing it had added 1, because
   GraphQL cost tracks `nodeCount`, the product of the `first:` values down each nesting.
   The likely-correct primitive is instead the **open walk** (`listOwnOpenWalk`), which
   returns every open item's project-item id and field values in one connection at a cost
   flat in N. Either way the rule is the repo's own: probe the document actually being
   sent with `RALPH_GQL_COST=1`, do not derive the number from this record.
2. **A walk-based resolution is open-issues-only** (GH-1814), so a closed target would be
   invisible to it. That must be a typed refusal naming the number, never a silent skip —
   the fail-closed resolution of Decision 4. Editing an advisory field on a closed item
   has no use case, but "no use case" and "silently dropped" are not the same answer.
3. **The six unsized items are a snapshot** of one board on one day. The mechanism gap is
   permanent and verifiable in code; the population size is not, and a reader six months
   from now should re-count rather than cite this line.
4. **`tend-queue` renders none of the six as `unformed`, and the reason is category
   precedence, not the predicate.** `classifyTend` keeps a `seen` set — "one row per issue
   — first category (spec order) wins" (board.ts:6130) — and `deps-cleared` is evaluated
   before `unformed`. In the run made for this record, #1965, #2067 and #2105 each appeared
   as `deps-cleared`, which consumed their row; #1965 satisfies the `unformed` predicate on
   every clause (Backlog, created 8 days ago > `UNFORMED_DAYS` 7, no estimate, no parent, no
   blockers) and still never renders as unformed. So an item's *second* problem is never
   named while a higher-precedence one is outstanding. That is a defensible design — one
   row per issue keeps the lane readable — but it means the missing-Estimate signal is
   currently both unremediable *and* invisible for exactly the items that have it. Worth a
   separate look; it is not this unit's to fix, and the argument here does not rest on it.
5. **This record does not establish that anyone will use the bulk form.** The measured
   waste is certain; the demand is inferred from one ten-item correction described in the
   unit's own body. Unit 1 stands on its own merits. If units 2-3 are cut, nothing about
   the board is left broken — which is the honest reason they are ranked second.

## Evidence

- board.ts:9501-9505 — the `MUTATING` set; no `estimate` member.
- board.ts:9569-10787 — the full dispatch switch; no `case "estimate"`.
- board.ts:6583-6602 — `setPriority`, the whole single-item field-write path; no `addComment`.
- board.ts:6609-6633 — `setDefer`, the contrasting verb that comments on every write.
- board.ts:6793-6795, 6850 — Estimate's only writer, inside `createIssue`, whose failure hint names the board UI.
- board.ts:6337-6344, 2449, 6647 — `backlogReadinessGaps` and the two edges it gates.
- board.ts:6110, 6184-6194 — `tend-queue`'s `unformed` predicate; board.ts:6174-6175 — its comment naming only the priority remedy; board.ts:6130 — the `seen` set, first category wins.
- board.ts:1766-1796 — `mutationCache`, and why live option fields force a schema read per write.
- board.ts:9527, 9533-9541 — mutating commands zero the item cache; the scope gate runs once per invocation before dispatch.
- board.ts:6882-6914 — `fetchNodeIds`, a generic alias-batched read invoked only with N=2.
- board.ts:7484-7489, 7495-7500, 7508-7517, 7518-7546 — `removeProjectItems`: shared helper, `PruneApplyResult`, the one-copy rationale, the 5-consecutive-failure breaker.
- board.ts:7464-7482, 10500-10629, 10631-10730 — `--limit` (200), the dry-run/`--apply` split, and `--json` reporting the run performed.
- board.ts:2219-2228, 7529-7531 — every mutation is single-target; no alias-batched mutation exists.
- Measured 2026-08-23 on this board: 14 pts / 2.06 s per `board priority`, identical on repeat; 6 of 13 open items unsized.
- `thoughts/shared/plans/2026-02-16-GH-0021-batch-operations.md` — v1's `batch_update` plan: scope (state/estimate/priority), aliased mutations, and the "without transition validation" coordination note.
- `689898f1` — `batch_update` ships; `75d125a5` (GH-1611) absorbs `archive_items`; `65ec3f56` (GH-1662 Phase 4) deletes it with the whole MCP server.
- `a352a7c4` (GH-1615) — transition legality retrofitted per-issue into `batch_update`, replacing a fail-open optimization; names `create_issue` as "the sixth, previously-unvalidated Workflow State writer."
- GH-1843 — one rule in five copies; the drift shape Decision 2 is structured against.
- GH-1817 — this board's GraphQL budget driven to 0/5000; why 700 pts for 50 field writes is worth avoiding.
- GH-1807 — cost tracks `nodeCount`; why the batched document must be probed, not derived.
- GH-1806 — reads may be stale, writes see truth; why no candidate set is carried between invocations.
- GH-1814 — the ranking lanes read open issues only; the limit on walk-based resolution.
- GH-2077 — Backlog means approved *and rankable*; why the Estimate gap is a gate defect, not an ergonomic one.
