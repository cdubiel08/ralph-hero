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
