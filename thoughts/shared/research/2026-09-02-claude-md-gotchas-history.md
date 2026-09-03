---
date: 2026-09-02
issue: GH-1811, GH-1814, GH-1891, GH-1896, GH-2050, GH-1817
topic: Gotchas — full incident and measurement history behind the short rules in CLAUDE.md
status: shipped
---

# Gotchas — full history

`CLAUDE.md`'s Gotchas section states each rule in one or two sentences; this
file carries the incidents and measurements behind the ones that had them.
Companion reads: `thoughts/shared/research/2026-08-11-graphql-cost-measurement.md`
(GH-1801/1811 raw numbers) and
`thoughts/shared/research/2026-08-12-GH-1803-lean-query-measured.md` (per-caller
query shape).

## `sweep-non-issues` verification (GH-2050)

`board sweep-non-issues` is the one-time removal of PR/draft board items —
a separate verb, deliberately not an arm on `prune`. Prune's predicate is a
fail-closed argument about *issues other readers still need* (closedDrift,
tend's Done audit, the apply-evidence sweep, tree edges); a PR or draft item
has no such reader, because `board.ts` cannot see it at all. Teaching one
predicate to reason about two kinds of subject is how a fail-closed
guarantee erodes (GH-1821 and GH-1889 both said so). It is also *safe in a
way prune is not*: removing a board item destroys its Workflow State and
Claim values, which for a PR item were never written and never read — so
unlike prune's one-way half, nothing is lost.

Same bounds as prune (dry run until `--apply`, `--limit` 200, 5-consecutive-
failure breaker), and the removal loop is now literally shared code
(`removeProjectItems`) rather than a second copy. Its walk is its own:
`listItemsFull` drops every non-issue node before returning, so the items
this sweep exists to find are invisible to it; one connection, the 1-pt
floor.

**The verification gate is printed, never asserted** — the ProjectV2 API
cannot read a built-in workflow's filter, so the newest non-issue item's
`createdAt` and creator are the only observable of whether the auto-add
source is still depositing, and the operator compares that against a PR
they know was opened after the filter edit. A timestamp threshold in the
tool would be a coin flip wearing a gate's clothes: a board with no recent
PRs cannot distinguish "the filter was fixed" from "nobody opened a PR."

The predicate is an **allowlist** (`SWEEPABLE_ITEM_KINDS` =
`PULL_REQUEST`, `DRAFT_ISSUE`), never "anything that is not ISSUE" —
because `ProjectV2ItemType` also has `REDACTED`, which is what GitHub
returns when the viewer cannot see an item's content, and a redacted item
may perfectly well be an **issue** whose Workflow State and Claim values are
real. By-exclusion would remove it and destroy them, which is exactly the
one-way loss this sweep's safety argument claims cannot happen here. An
absent `type`, a `REDACTED` one, and any kind GitHub adds to the enum later
all land on the retained side by default — the direction a sweep with no
undo has to fail. `board-volume` is deliberately unchanged: it already
breaks `nonIssue` out as its own term, and it measures the walk's real
cost, which is the honest number whether or not the items are prunable.

## Starvation is a property of the token, and an exhausted write fails silently (GH-1817)

Two defects that look alike and are not, so they get opposite failure
directions in one shared reader, `scripts/lib/gh-budget.sh`.

**(A)** `gh pr comment` printed `GraphQL: API rate limit already exceeded`
and **exited 0** into a background job's output file; the comment never
posted and nothing surfaced until that file was read by hand. Exit code is
not a reliable signal for `gh` under rate limiting — the *output* is, on
**either stream** (a guard watching only the one it expected reproduces the
defect on the other). `gb_gh` searches both and returns a distinct **exit
4**, which the write sites map onto the repo's existing EX_TEMPFAIL 75:
"wait for the reset" and "this request is malformed" are different
remedies, and a rate limit `gh` *already* failed on is still typed as 4
rather than passed through. It **fails closed** — a write we cannot confirm
landed is a failure, and a false positive costs one re-run of an idempotent
post. Wired at the writes nobody re-reads in-invocation: `attest-pr.sh`
(announcing `ATTESTATION POSTED` over a comment that never existed leaves
the driver waiting on a gate that can never go green) and
`apply-evidence.sh` (its comment *is* the close gate's evidence, so a
phantom post makes `board move N done` refuse for a reason the operator was
just told is satisfied).

**(B)** Bounding each consumer (#1785, #1803, #1814) caps one surface's
cost; only a pre-spend check caps the *aggregate* — the loop that actually
drove the budget to 0/5000 on 2026-08-12 was `gh pr view --json reviews`
every 45 s and read no board data at all, so no amount of board-read
bounding would have prevented it. `gb_backoff_seconds` is read before each
poll in `pr-gate-watch.sh --watch` (the repo's one sanctioned poll loop),
naps toward the reset — capped at 300 s so a watcher stays interruptible
rather than going dark until the top of the hour — and **narrates it on
stderr**, because a backoff nobody can see is the same silent degradation
#1787 fixed in the cockpit; stdout stays the verdict stream a Monitor
parses. It **fails open**: an unreadable budget must never block work,
since reading a transient outage as starvation is strictly worse than the
starvation it guards against — and unreadable is exit 3, never a zero,
because "cannot read" and "exhausted" must not read alike.

`board.ts` is deliberately untouched: `ghGraphQL` already throws on any
`body.errors` including `RATE_LIMITED` (board.ts:1289), so it is not the
surface that fails quietly. The budget authority is GraphQL's own
`rateLimit` field, never REST `rate_limit`'s `graphql` sub-bucket — full
measurement in
`thoughts/shared/research/2026-09-01-GH-2278-rest-rate-limit-graphql-bucket-mirrors-core.md`.

Honest limit: this sees a *current* exhaustion, never a coming one — a long
pass can still be starved after it starts, which is what `ghGraphQL`'s own
`RATE_LIMITED → 75` and `pr-gate-watch`'s observed-error path (GH-2276) are
for.

## GraphQL cost is per nested CONNECTION (GH-1811)

Cost tracks `nodeCount`, which is the **product of the `first:`/`last:`
values down each nesting**. Trimming a nested `first:` is worth exactly
zero *on the item walk* (measured, twice) — a fact about the walk's shape,
not about GitHub's cost function: the walk's connections all hang under one
`items(first:100)` page, so their products land in the same buckets and
trimming moves nothing.

Nest one level deeper and the same trim is worth hundreds of points:
`deliver-queue`'s `refs(first:10) × associatedPullRequests(first:10) ×
contexts(first:100)` was 10,000 nodes for ONE alias, and the query measured
**607 pts, not the 100 recorded in GH-1801** — over-generalizing the "zero
on the walk" finding is exactly how GH-1807 added 55 pts/candidate
believing it had added 1. The fix (607 → 8) is structural: per-PR facts
hang off top-level `node(id:)` aliases, never inside a linkage connection,
and `board.test.ts` asserts that shape. Probe the document actually sent
(`RALPH_GQL_COST=1`) rather than deriving a number from either measurement.

## The ranking lanes no longer walk the project (GH-1814)

`next`/`frontier`/`deliver-queue` join `list` on the issues-rooted read
(`repository.issues(states: OPEN)`, GH-1785), so their page count tracks
open work instead of the 1443 items the board has ever held — measured
30 → 13 pts and **47 s → 5 s**, the wall time being the half that matters
(the cockpit's `boardTimeout` is 25 s).

What kept them on the scan was the *closed* half: a Done phase between an
epic root and its live grandchildren is pass-through topology the ranker
needs. `closedTreeEdges()` resolves exactly those by walking UPWARD from
the open set — usually zero round trips, because most parents are open —
instead of paging every closed item to find the few that matter. Off-board
and foreign parents leave the tree severed, as the scan did. On this read
`projectItems` is a **second** nesting level with `fieldValues` under it, so
its `first:` is the whole price (20 → 21 pts, 10 → 11, and `fieldValues`
moves nothing) — the exception GH-1811's rule predicts, and pinned by a
test.

## `tend-queue` joined them (GH-1891)

47 pts / 22 queries → 17 / 6. It was the last lane on the scan, because the
Done audit needs *closed* items. Those now come from a bounded
`repository.issues(states: CLOSED, orderBy: UPDATED_AT DESC)` read that
stops at the first node older than the audit window. That cut is
**complete, not a heuristic**: closing an issue is an update, so
`updatedAt >= closedAt` always and an in-window close cannot sort below an
out-of-window one — the one property the whole optimization rests on.

With the scan gone the *trail fetch* became the biggest term, so tend uses
`fetchCommentTrails` (comments only, batched 100) instead of
`fetchHistories` (batched 20): `projectItems × fieldValues` was ~200 of the
~280 nodes charged per issue and tend reads neither, which is also why the
larger batch bills **less** than the smaller one did. Doctor's smells keep
`fetchHistories` — a comments-only read may not claim `stateUpdatedAt:
null`, since that would assert something it never asked for. Both are
pinned in `board.metrics.test.ts`, including the invariance that matters:
cost is identical on a board with 300 long-closed items and one with none.

## The project scan can silently drop a live item (GH-1896)

Observed on 2026-08-14: `#1873` (open board item, not archived, closed that
morning) was reproducibly absent from `listItemsFull`'s `closed` half while
the issues-rooted read returned it — GitHub's `items(first:100, after:)`
cursor is not stable across a board that is being mutated under the walk.
So the scan under-reported the Done audit, and the GH-1891 rewrite is a
**completeness** fix as much as a cost one.

Everything still entering through `listItemsFull` (doctor's sweeps,
`prune`, `list`) inherited the hazard, so the walk now **detects its own
truncation**: it reads the connection's `totalCount` and compares it
against the nodes it actually paged, retries once, and raises a named error
on a second short read rather than serving a board with a hole in it. A
drop silently fails *open* in doctor's sweeps — a missing item reads as
"none" — which is the one outcome this repo refuses everywhere else. The
check is a field, not a nested connection, so it costs nothing; it stays
inert if GitHub answers without a `totalCount`, since an unasked question
may not fail a walk.
