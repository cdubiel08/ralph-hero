---
date: 2026-07-19
status: draft
type: plan-of-plans
tags: [catch-up, brief, ways-of-working, split]
github_issue: 1553
github_issues: [1553, 1557, 1558]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1553
primary_issue: 1557
estimate: M
---

# catch-up --mode brief — the daily sitting that empties the human queue

## Prior Work

- builds_on:: [[2026-07-19-GH-1550-ways-of-working-action-surfaces]] — the research and epic plan-of-plans this feature (Feature C) belongs to.
- builds_on:: [[2026-07-17-GH-1544-decision-gated-plan-approval-merge-auto]] — the `Decision:`-header picker + fold-in contract the interactive walk reuses.

## Strategic Context

GH-1550 Feature C is the daily sitting that empties the human queue in one pass: Decision Requests, Unblock Requests, incubating thoughts, plus a read-only flagged tail. The issue body already names two independently-shippable surfaces — an interactive walk-through and a headless `--prepare` variant used by the scheduled trigger (#1555) — so this split follows the artifact boundary already in the body rather than inventing one.

The headless variant is a thin, prompt-free wrapper around the interactive mode's enumeration path (auto-mode-is-end-to-end axiom); it must not duplicate queue-reading logic, which is why it ships as a separate, smaller, dependent child rather than a phase folded into the first.

## Shared Constraints

- **No new verb** — both children add a mode (and a mode flag) to `/ralph:catch-up` only.
- **Reuse the answer contracts as-is** — GH-1544 `Decision:` pickers + fold-in (`ralph/skills/plan/plan-review.md:91-130`), unblock Q&A + state-return confirmation (`ralph/skills/caretake/modes/unblock.md:22-142`). Neither child reimplements these.
- **Single enumeration source** — both children consume the `next_actions` human-queue enumeration (#1551); no second scan, no skill-side re-ranking.
- **Auto-mode-is-end-to-end** — the headless child must never prompt or post issue comments.
- **Data-plane notification axiom** — the headless child fires at most one `PushNotification` per day, counts only.
- **Hardened render rules** — no editorializing, estimate honesty, matching existing catch-up render conventions.

## Feature Decomposition

### Feature: catch-up --mode brief (interactive) — narrative + human-queue walk + flagged tail (#1557, S)
Narrative header (reusing narrative-synthesis + `pipeline_status_summary` (#1552) when available) → enumerate the full human queue via #1551 → walk Decision Requests (GH-1544 pickers), Unblock Requests (unblock Q&A), and incubating thoughts (#1554 contract: flesh-out / promote via form / keep / drop) → read-only flagged tail (blocked PRs, stale locks) → one-line "queue emptied / N deferred" summary. New mode body + one reference sibling (`brief-composition.md`).

### Feature: catch-up --mode brief --prepare (headless) — daily prep + push notification (#1558, XS)
`--prepare` flag on the mode built in the sibling feature: runs the same enumeration with zero prompts and zero mutations, fires exactly one `PushNotification` ("Daily brief ready: N decisions, M unblocks, K thoughts") per day, idempotent via a last-prepared-date marker. Depends on the interactive mode's enumeration path existing first.

## Integration Strategy

- The headless child (#1558) calls into the interactive child's (#1557) enumeration/walk-selection code path directly — it does not re-read the queue itself. This is the load-bearing reuse contract for this split.
- Both children are consumed downstream by #1555 (scheduled trigger, invokes `--prepare`) and by the epic's Feature C acceptance as a whole — neither child is independently useful without the other landing.
- These two children batch-plan as ONE group plan and ship as ONE PR (GH-1538) — the estimates above size plan phases, not separate PR-sized deliverables.

## Feature Sequencing

1. **catch-up --mode brief (interactive)** (#1557) — no dependencies within this split.
2. **catch-up --mode brief --prepare (headless)** (#1558) — blocked by #1557 (reuses its enumeration/walk path).

Dependency edge on the board: #1557 → #1558.

## What We're NOT Doing

- No new verb — everything lives on `/ralph:catch-up --mode brief`.
- No reimplementation of the `Decision:` picker, unblock Q&A, or `next_actions` enumeration contracts — both children consume them as-is.
- No scheduling/cron wiring here — that's #1555, which depends on this split's output.
- No richer J2 progress reporting — `pipeline_status_summary` (#1552) is a soft, optional input to the narrative header, not a hard dependency.

## References

- Parent (split source): https://github.com/cdubiel08/ralph-hero/issues/1553
- Children: #1557, #1558
- Epic: https://github.com/cdubiel08/ralph-hero/issues/1550
- Plan: `thoughts/shared/plans/2026-07-19-GH-1550-epic-ways-of-working-surfaces.md`
- Research: `thoughts/shared/research/2026-07-19-ways-of-working-action-surfaces.md`
- Contracts consumed: `ralph/skills/plan/plan-review.md` (decision pickers), `ralph/skills/caretake/modes/unblock.md` (unblock Q&A)
