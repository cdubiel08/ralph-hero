---
date: 2026-08-12
issue: GH-1803
parent: GH-1800
status: measured
follows: 2026-08-11-graphql-cost-measurement.md
---

# Lean query variant, measured before and after

Same harness as #1801 (`RALPH_GQL_COST=1`, GitHub's own `rateLimit { cost }`),
same live ralph-hero board (14 pages of project items), same session.

## The change

`listItemsFull` / `listOwnOpenItems` take a `QueueSelect` — which of the two
optional nested connections (`labels`, `blockedBy`) the document asks for.
Callers request only what they read:

| Caller | `labels` | `blockedBy` | why |
|---|---|---|---|
| `next`, `frontier` | ✗ | ✓ | eligibility = dependency edges + field values |
| `tend-queue` | ✗ | ✓ | `deps-cleared` / `deps-truncated` |
| `deliver-queue` | ✗ | ✗ | filters on board state, hands `{number, title}` onward |
| `doctor` | ✓ | ✓ | apply-kind sweep (open **and** closed items) |
| `list` | ✓ | ✓ | `--json` publishes both; contract kept |

## Observed cost

| Command | before | after | walk (before → after) |
|---|---|---|---|
| `next` | **42** | **28** | 3 → 2 pts/page |
| `frontier` | **42** | **28** | 3 → 2 pts/page |
| `tend-queue` | **53** | **39** | 3 → 2 pts/page (+11 pts of history reads, unchanged) |
| `deliver-queue` | **120** | **70** | 3 → **1** pt/page — the floor |

Exactly the model #1801 measured: one connection dropped = one point per
100-item page = 14 points per walk on this board.

**One number is not mine.** `deliver-queue`'s per-chunk candidate fetch read
78 points before and 56 after — that call is charged per chunk of 10 *In
Review* items and the board's In Review population changed between the two
runs. Its shape is untouched by this PR; it is #1811's problem. The walk half
(42 → 14) is the deterministic part: 14 pages, 1 point each, both times.

## What the types buy

An unselected connection is **absent from the item**, never `[]` with
`truncated: false`. That flag is GitHub telling us the list was complete, and
every fail-closed check in `board.ts` treats it that way (`blockersTruncated`
→ item is blocked; `labelsTruncated` → item counts as apply-kind). A read that
never asked must not be able to assert it. `QueueItemWithBlockers` /
`QueueItemAny` make the group optional, so `tsc` — not review attention —
refuses the unguarded read, and the JSON boundary carries absence through as a
missing key rather than a fabricated `false`.

`board contract validate ralph.board_queue` follows: `labels` /
`labelsTruncated` are now `.optional()`, never nullable and never defaulted, so
a consumer can still tell "this read did not fetch labels" from "this issue has
none".

## Deliberately not done

- **`list` stays full.** Its `--json` is a published shape (the cockpit's three
  column reads go through it) and its default path is the bounded
  `repository.issues` read (~2 pts), so the lever is ~1 point against a
  contract change. Not worth it.
- **Nested `first:` untouched.** #1801 measured this at exactly zero points
  (nodeCount fell 21x, cost did not move). Re-confirmed incidentally here:
  `nodes=20100 → 10100` on the `next` walk while cost went 3 → 2 — the drop in
  nodes tracks the dropped connection, not any saving of its own.
