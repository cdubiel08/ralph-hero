---
date: 2026-08-11
issue: GH-1801
parent: GH-1800
status: measured
---

# Real GraphQL cost per board query (measured, not derived)

Every number here is GitHub's own `rateLimit { cost }` for the query as `board.ts`
actually sends it, against the live ralph-hero board (~14 pages of items) on
2026-08-11. Nothing in this document is computed from the documented formula.

## How it was measured

`RALPH_GQL_COST=1` (added to `ghGraphQL`, `ralph/scripts/board.ts`) injects
`rateLimit { cost remaining limit used resetAt nodeCount }` at the operation's
selection set, logs cost + a running session total to stderr, and deletes the
probe from the returned data so no `--json` path re-emits it. Injection happens
at the first `{`, which closes the operation header — GraphQL variable
declarations never contain one. Queries only: `rateLimit` is a field on the
Query root, so mutations are skipped by construction.

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

The cost lives in the nesting (`board.ts:2582-2592`, `:2650-2661`):
`statusCheckRollup.contexts(first: 100)` and `reviewThreads(last: 50)` sit under
two `first: 10` PR connections, under 10 issue aliases.

## Finding 2 — nested `first:` values

> **A/B result pending the rate-limit reset; this section is filled in below.**

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
