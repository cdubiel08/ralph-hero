---
date: 2026-08-11
issue: GH-1801
parent: GH-1800
status: measured
routed_to: [GH-1803, GH-1804, GH-1811]
---

# Real GraphQL cost per board query (measured, not derived)

Every number here is GitHub's own `rateLimit { cost }` for the query as `board.ts`
actually sends it, against the live ralph-hero board (~14 pages of items) on
2026-08-11. Nothing in this document is computed from the documented formula.

## How it was measured

`RALPH_GQL_COST=1` (added to `ghGraphQL`, `ralph/scripts/board.ts`) injects
`__ralphGqlCost: rateLimit { cost remaining limit used resetAt nodeCount }` into
the operation's selection set, logs cost + a running session total to stderr,
and deletes only that alias from the returned data — so no `--json` path
re-emits the probe, and a caller that selects `rateLimit` itself keeps its own
value. Queries only: `rateLimit` is a field on the Query root, so mutations and
subscriptions are skipped by construction.

The insertion point is found by scanning for the first `{` at paren depth zero,
outside strings and comments — not `indexOf("{")`, which a variable default
value (`query($f: Input = { state: OPEN })`) would capture, producing an invalid
document. Aliasing costs nothing: cost is charged per connection and `rateLimit`
is not one, which the measurements confirm (`get` = 6 points before and after).

```bash
RALPH_GQL_COST=1 ./ralph/scripts/board deliver-queue 2>&1 >/dev/null | grep gql-cost
```

### Measurement #1 — the probe is cost-neutral (verified)

| Query | `used` delta |
|---|---|
| `query { viewer { login } }` | 1 |
| same + `rateLimit { ... }` | 1 |

The instrumented query self-reports `cost: 1`. Adding the probe does not change
what is charged, so every number below is the cost of the real query.

## The cost table

| Command | GraphQL calls | **Observed points** | Estimate in #1801 | |
|---|---|---|---|---|
| `list` | 14 | **42** | ~42 | ✅ exact |
| `next` | 14 | **42** | — | |
| `frontier` | 14 | **42** | — | |
| `tend-queue` | 18 | **53** | — | walk + 4 issue reads |
| `get NNN` | 1 | **6** | ~1–2 | ❌ 4x under |
| `deliver-queue` | 15 | **142** | "several/chunk" | ❌ 25x under |

Per-call shape:

- **`listItemsFull` walk** — 14 identical `node` calls, `cost=3`, `nodeCount=20100`
  each. The 3 pts/page model in #1800 is confirmed exactly.
- **`fetchIssue`** (`get`) — one `repository` call, `cost=6`, `nodeCount=26730`.
- **`fetchDeliverCandidates`** — one `repository` call, **`cost=100`**, per chunk
  of 10 In Review items, *on top of* the 42-point walk.

## Finding 1 — `deliver-queue` is the most expensive query in the system

A single `fetchDeliverCandidates` call costs **100 points** — 2.4x an entire
14-page board walk, in one request. It is charged per chunk of 10 In Review
items, so it grows stepwise with review depth while the walk stays flat.

This matters for the epic's plan: #1800 scopes the fix to collapsing the
cockpit's 3 walks into 1. That leaves the single largest query in the codebase
untouched. A board with 30 In Review items pays 300 points for one
`deliver-queue`, and the deliver lane polls.

The cost lives in the connection count (`board.ts:2582-2592`, `:2650-2661`), not
the page sizes — see Finding 2. Filed as **GH-1811**.

## Finding 2 — nested `first:` saves nothing; dropping connections is the whole lever

#1800 asserted this as settled. Mid-measurement I suspected it was wrong, because
`deliver-queue`'s 100 points looked like nested `first:` multiplying. **The A/B
refutes my suspicion and confirms #1800.** Same hot query, only the nested page
sizes varied:

| Variant | `labels` / `blockedBy` / `fieldValues` | nodeCount | **cost** |
|---|---|---|---|
| production | 100 / 50 / 20 | 17100 | **3** |
| trimmed | 10 / 10 / 20 | 4100 | **3** |
| trimmed-all | 10 / 10 / 10 | 3100 | **3** |
| minimal | 1 / 1 / 5 | 800 | **3** |

`nodeCount` falls 21x. Cost does not move. **Trimming nested `first:` values is
worth exactly zero points.** Do not spend a PR on it.

Dropping whole connections, on the same query, is worth everything:

| Connections under `items(first: 100)` | **cost** |
|---|---|
| items only | **1** |
| items + fieldValues | **1** |
| items + labels + fieldValues | **2** |
| items + labels + blockedBy + fieldValues (**production**) | **3** |

Exactly the documented model, now observed: `1 (items) + 100 (labels) + 100
(blockedBy) + 100 (fieldValues) = 301 requests → 3 points`. Each nested
connection over a 100-item page costs 100 requests = 1 point, flat, regardless
of its page size.

### The concrete lever for #1800

`fieldValues` is not droppable — it carries Workflow State. `labels` and
`blockedBy` are the two candidates:

- drop **both** → **1 pt/page → 14 pts/walk** (from 42)
- drop **one** → 2 pt/page → 28 pts/walk

Combined with the parent's 3-walks-to-1 collapse: **126 → 14 points per cockpit
tick, a 9x reduction** — which clears the budget with room, where the collapse
alone (126 → 42) does not. Both consumers are real (`labels` feeds apply-kind
detection, `blockedBy` feeds the ranker's blocked report), so dropping them means
fetching them another way for the few items that need them, not deleting the
feature.

### Why `deliver-queue` costs 100

Same rule, applied to its shape: ~10 connections per issue alias (`comments`,
`closedByPullRequestsReferences`, `projectItems`, nested `fieldValues`, the
`pullRequests` alias, and inside each PR `commits`, `statusCheckRollup.contexts`,
`reviews`, `reviewThreads`, nested `comments`) × 10 aliases per chunk ≈ 100
connections ≈ 100 points. So its fix is **fewer aliases per chunk or fewer
connections per alias** — chunking by 5 halves the per-call cost but doubles the
calls, i.e. buys nothing. Removing connections is again the only real lever.

## Finding 3 — the ETag oracle (#1802) sees almost nothing that matters

The parent asked what fraction of real board deltas an issue-level ETag can
observe. Measured directly on this issue:

| Event | Time | Issue `updated_at` after |
|---|---|---|
| `board claim 1801` — Claim field + Backlog→In Progress | `02:14:29Z` | `02:11:08Z` (**unmoved**) |
| timeline `project_v2_item_status_changed` | `02:14:31Z` | `02:11:08Z` (**unmoved**) |
| `blocking_added`, `cross-referenced` | `02:12:41Z`, `02:12:52Z` | `02:11:08Z` (**unmoved**) |
| issue comment posted | `02:21:14Z` | `02:21:14Z` (**moved**) |

**Project field writes are invisible to issue-level `updated_at`/ETag.** So are
dependency edges and cross-references. An issue-level oracle would miss every
state transition, claim, and blocker edge — precisely the deltas the board is
about. It catches comments, body edits, labels, and open/close.

Consequence for #1802, stated plainly:

- `state-guard.yml` corrections **are** visible, because each one posts a
  comment. That was the specific question asked, and the answer is yes.
- Agent transitions through `board.ts` — the common case by far — are **not**
  visible. An ETag oracle would report "nothing changed" across a full
  Backlog→In Progress→In Review sequence.

So an issue-level ETag is not a sound freshness oracle for board state. It is
sound for *comment-driven* signal only. If #1802 proceeds, it should either
target the comment trail specifically (a real use: the deliver lane's marker
comments) or find a project-item-level oracle, not an issue-level one.

## Finding 4 — the REST budget is separate and nearly free

Observed simultaneously: GraphQL at `0/5000 remaining` while REST showed
`4983/5000`. The two budgets are independent, and conditional REST requests
answered `304` do not count against the REST limit at all.

This is a real lever the parent issue does not consider: anything answerable
over REST costs nothing from the budget that is actually exhausted. It does not
rescue the items walk (ProjectV2 is GraphQL-only), but it does mean an oracle,
a heartbeat, or an issue-level read need not compete with the board walk.

## Note on measuring the problem

The board sat at `699/5000` remaining when this measurement began and was driven
to `0` completing the inventory — the measurement consumed the same budget the
problem consumes. Anyone re-running this table should expect to spend ~330
points, and should check `gh api rate_limit` first.

---

## Addendum, 2026-08-12 (GH-1786) — the `list` row above is stale

Re-measured the same way (`RALPH_GQL_COST=1`, live board) one day later, while
collapsing the cockpit's three column scans into one:

| Command | GraphQL calls | **Points** | Wall |
|---|---|---|---|
| `list --state "In Progress" --json` | **1** | **23** | ~2 s |
| `list --json` (whole board) | **1** | **23** | ~2 s |

**GH-1785 (#1794) landed between the two measurements** and repointed `list` at
`listOwnOpenItems` — one bounded `repository.issues(first: 100)` page, because
this repo has ~47 OPEN own-repo issues, not the 1344 all-time project items the
`listItemsFull` walk paginated. So the table's `list = 14 calls / 42 points` and
#1784's `21–23 s per column scan` describe a query `list` no longer runs.

What the collapse is actually worth, then: **69 → 23 points and ~6 s → ~2 s per
cockpit poll** (3x, as designed), which at the default 30 s interval is
**8,280 → 2,760 points/hour** against the 5,000/hr budget — the cockpit alone
was over budget continuously, and now fits. Smaller absolute numbers than the
issue predicted, same crossing of the line that mattered.

Consequences for the routed children:

- **#1803** (drop `labels` / `blockedBy` per caller): its arithmetic stands
  unchanged. See the correction below.
- **#1811** (`deliver-queue` at 100 pts/chunk) is untouched by GH-1785: it is a
  different query, and it remains the most expensive one in the system.

Measuring this cost ~46 points and required waiting out a fully exhausted
budget. The advice above stands, doubly: check `gh api rate_limit` first, and
wait for the reset rather than retrying.

### Correction to the addendum above, same day (GH-1786)

The first version of this addendum claimed #1803's per-connection arithmetic
needed re-measuring because "the walk is now one call at 23 points". **That was
wrong, and it conflated two different walks.**

GH-1785 changed **only `list`**, repointing it at `listOwnOpenItems` (the
repo's OPEN issues — one page here). Every caller #1803 is about — `next`,
`frontier`, `tend-queue`, `deliver-queue` — goes through `listItemsFull` /
`listItems`, which still paginates the whole **project** at 14 pages. GH-1785
never touched that walk, so nothing invalidated the `3 → 2 → 1 pt/page` model
those callers were sized on.

#1803 then measured it directly and it held exactly:
`next` 42 → 28, `frontier` 42 → 28, `tend-queue` 53 → 39, `deliver-queue`
120 → 70 (`thoughts/shared/research/2026-08-12-GH-1803-lean-query-measured.md`).

Both readings of "the walk" are true at once, which is what made the mistake
easy: `list` is one bounded call at 23 points, and the project walk is 14 pages
at 1–3 points each. **Name which walk before quoting a number from this
document.** `list` is the odd one out; everything else in the table above is
the project walk.

Unaffected by the correction: `list` keeps BOTH connections under #1803's
`QUEUE_SELECT_FULL` ("contract kept"), so the cockpit's one-read poll continues
to receive every field it partitions on.

---

## Addendum, 2026-08-13 (GH-1811) — Finding 2 does not generalize, and `deliver-queue` was never 100

Measured the same way, against the live repo, with the production selection set
at 10 aliases. Two things in this document need correcting before anyone sizes
another query on them.

### The number: 607, not 100

| variant (10 candidates, one document) | cost | nodeCount |
|---|---|---|
| **production, as shipped on 2026-08-13** | **607** | 237,000 |
| issue head + bare `refs` (no PR facts anywhere) | 1 | 271 |
| `closedByPullRequestsReferences` + facts (1 alias) | 6 | 2,391 |
| **`refs` → `associatedPullRequests` + facts (1 alias)** | **55** | 21,310 |

The 100 above was measured before GH-1807, which added the `refs` alias to
`fetchDeliverCandidates`. That commit's own source note reads "Costed live: +1 pt
per DELIVER_CHUNK document (1 → 2)" — true of a **bare** `refs`, and the probe
above reproduces it exactly (1 pt). But the alias that shipped carries a full
`DELIVER_PR_FACTS` inside `associatedPullRequests`, and that branch alone is
**55 of the 61 points per candidate**. The +1 was measured on a shape that was
not the one committed.

### The model: cost tracks nodeCount, not connection count

Finding 2 above is correct **for the item walk** and was over-generalized into a
property of GitHub's cost function. It is not one. Cost tracks `nodeCount`, and
`nodeCount` is the **product of the `first:`/`last:` values down each nesting**:

```text
refs(first:10) × associatedPullRequests(first:10) × contexts(first:100) = 10,000 nodes
```

...for one alias's checks alone. The walk's nested connections all sit under a
single `items(first:100)` page, so their products land in the same few
100-request buckets and trimming moves nothing — which is exactly what Finding 2
observed. Raise the nesting one level, as `deliver-queue` does, and the same
trim is worth hundreds of points. **Both are true; neither is the rule.**

Confirmed static and data-independent (10 nonexistent issue numbers cost the
identical 607) and exactly linear in alias count (1/2/5/10 → 61/121/304/607),
which re-confirms this document's "re-chunking buys nothing".

### The fix that landed

Hoisting `DELIVER_PR_FACTS` out of the nested linkage connections and onto
top-level `node(id:)` aliases — a single node multiplies nothing — measured on
the two documents `board.ts` now emits:

| | calls | cost |
|---|---|---|
| before | 1 | **607** |
| phase A — issue facts + PR linkage (`id number state`) | 1 | **2** |
| phase B — facts for the OPEN PRs only | 1 | **6** |
| **after** | 2 | **8** |

Phase B fetches by **node id, not number**: a closing reference can name a PR in
another repo, where the same number is a different PR or none. It covers only
OPEN PRs, because every signal check in `classifyDeliver` reads off the open
subset — a merged PR's checks, reviews and threads were always fetched and
discarded. A chunk with no open PRs skips phase B entirely.

**Do not re-derive the rule from either measurement.** Probe the document you
are actually sending: `RALPH_GQL_COST=1`, or `rateLimit { cost nodeCount }`
inline. `board.test.ts` now asserts the *shape* (no fact field may appear in the
linkage document), because this regression already happened once silently.
