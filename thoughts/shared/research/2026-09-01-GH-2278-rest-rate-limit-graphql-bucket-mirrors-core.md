---
date: 2026-09-01
issue: GH-2278
topic: REST `rate_limit`'s `graphql` sub-bucket mirrors `core`; GraphQL's own `rateLimit` is the authority
status: measured, fixed in the same unit
---

# REST `rate_limit.resources.graphql` mirrors `core` (GH-2278)

The issue asked whoever took it to re-measure and record whether the mirroring
is *always* or *intermittent*, because one contrary reading (a correct
`0/5000` at ~00:26Z on 2026-08-29) was on record — relayed second-hand, never
reproduced by its relayer.

## Measurement 5 (this unit, 2026-09-01 20:49:33Z, mid-hour, budget ~56 % spent)

Same instant, same token, no pipe between the call and the exit read:

```
$ gh api graphql -f query='{rateLimit{limit remaining used resetAt}}'
{"data":{"rateLimit":{"limit":5000,"remaining":2820,"used":2180,"resetAt":"2026-09-01T21:06:40Z"}}}   exit 0

$ gh api rate_limit --jq '{graphql:.resources.graphql, core:.resources.core}'
{"core":   {"limit":5000,"remaining":5000,"reset":1788299373,"used":0},
 "graphql":{"limit":5000,"remaining":5000,"reset":1788299373,"used":0}}
```

- `graphql` is byte-identical to `core`: `used 0`, `remaining 5000`, and the
  same `reset` epoch (1788299373 = 21:49:33Z — exactly 3600 s after the read,
  i.e. `core`'s rolling hour), while the authority's `resetAt` is a fixed wall
  at 21:06:40Z.
- 2180 points had been spent this window. The REST key reported none of them.

That is the fifth first-hand measurement (product ×2, dev, QA, this) and it
has never failed to reproduce. The second-hand contrary reading remains
unexplained; nothing in five direct measurements supports it. **Treat the
mirroring as always.** Criterion 5's wording is therefore the simple form: the
REST key cannot see GraphQL spend at all, so a guard on it could never fire.

## The authority is exempt (0 points), and answers at zero

Two consecutive `{rateLimit{cost remaining used resetAt}}` probes, back to
back:

```
{"cost":1,"remaining":2773,"used":2227,"resetAt":"2026-09-01T21:06:40Z"}
{"cost":1,"remaining":2773,"used":2227,"resetAt":"2026-09-01T21:06:40Z"}
```

`cost` prints 1 but `remaining` does not move — the field is exempt from the
budget it reports on. So reading it before every lane invocation costs
nothing, which is what lets the pre-flight fire *before* the spend. It also
means the probe **succeeds at `remaining: 0`** (observed in the issue's own
trail: a clean probe followed 30 s later by a refused `board claim`), so
"the probe returned" is never a readiness signal; only `remaining` is.

## What changed in this unit

| Reader | Before | After |
|---|---|---|
| `board.ts` lane pre-flight (`next`/`frontier`/`deliver-queue`/`tend-queue`/`dep-candidates`/`brief`/`inbox`) | `gh api rate_limit` → `.resources.graphql.remaining` | `ghGraphQL({ rateLimit { remaining limit resetAt } })` → `remaining`; a `RATE_LIMITED` refusal of the probe itself defers; transport/malformed still proceeds |
| `gb_snapshot graphql` (default) | same REST key | GraphQL `rateLimit`, `resetAt` normalised to an epoch via jq; exit 4 on an observed refusal, exit 3 on unreadable |
| `gb_snapshot core` (any non-graphql resource) | REST | REST, unchanged — `core` is reported correctly |
| `gb_backoff_seconds` on a refused probe | (could not occur) | bounded 60 s, never 0 |
| `TransientError` | `(message, resetAt)` | `+ reason: "rate-limited" \| "transport"` |

Cost accounting: the probe is one extra GraphQL round trip per lane
invocation (it replaces one REST round trip, so wall time is unchanged in
kind). The metrics suite meters it apart from the paid walk and pins it at
exactly one per lane invocation, zero on non-lane commands.

## Honest limit

The pre-flight sees a *current* exhaustion. It cannot predict one, so a long
pass can still be starved after it starts — that is what `ghGraphQL`'s own
`RATE_LIMITED → exit 75` and `pr-gate-watch.sh`'s observed-error path
(GH-2276) are for, and neither is changed here.

## Diagnostic

When a fleet looks starved: `gh api graphql -f
query='{rateLimit{remaining resetAt}}'`. `gh api rate_limit --jq
.resources.graphql` will say 5000.
