---
date: 2026-07-19
status: draft
type: plan-of-plans
tags: [form, capture, enrichment, ways-of-working, split]
github_issue: 1554
github_issues: [1554, 1559, 1560]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1554
primary_issue: 1559
estimate: M
---

# Capture custody chain — polymorphic brain-dump capture + background enrichment

## Prior Work

- builds_on:: [[2026-07-19-GH-1550-ways-of-working-action-surfaces]] — the research and epic plan-of-plans this feature (Feature D) belongs to.

## Strategic Context

GH-1550 Feature D is the J1 custody chain: **capture → enrich → remind** (the reminder is Feature C's daily brief, #1553). The issue body already names two independently-shippable pieces — polymorphic capture on `/ralph:form --mode draft`, and a background enrichment pass folded into the existing `caretake --mode all` heartbeat — so this split follows that boundary rather than inventing one. The "idea-file contract" mentioned in the parent body is not a third deliverable: it's the frontmatter interface capture defines and enrichment extends, so it's scoped inside each child rather than split out on its own (an artificial split per split-decomposition.md §When to split).

Capture must ship first: enrichment reads `status: draft` idea files and their `captured` timestamp, both written by capture. This is a linear dependency, not a fan-out.

## Shared Constraints

- **Capture never starts work** — no board/project mutation as a side effect of either child.
- **GH-706 principle** — extraction happens before confirmation; capture must not demand a design session at write time.
- **Enrichment is cheap and non-committal** — locator sweep + `knowledge_search` + related-issues, never a full research doc per thought.
- **No new scheduler** — enrichment folds into the existing `caretake --mode all` fan-out.
- **No new verb** — both children extend existing surfaces (`/ralph:form --mode draft`, `caretake --mode all`).
- **Frontmatter contract is shared, not duplicated** — capture writes `status`/`captured`; enrichment extends the same file with `## Enrichment` and `status: forming` + `enriched`. Feature C (#1553) is the sole downstream reader.

## Feature Decomposition

### Feature: Polymorphic brain-dump capture — /ralph:form --mode draft extension (#1559, S)
Extend `/ralph:form --mode draft` to accept thoughts at any maturity, splitting a single dump into N idea files when it contains multiple distinct thoughts (extraction first, confirmation after — GH-706). Defines the idea-file frontmatter contract (`status: draft`, `captured` timestamp). Never mutates board state; the default completion flow may offer an optional, declinable "kick off?" prompt (interactive only).

### Feature: Background enrichment pass for captured idea files — caretake --mode all fan-out step (#1560, S)
New step in the `caretake --mode all` heartbeat fan-out: globs `status: draft` idea files, runs one locator sweep + one `knowledge_search` prior-art query + one related-issues lookup per file, appends findings under `## Enrichment`, and flips `status: draft → forming` with an `enriched` timestamp. Idempotent — already-`forming`-or-later files are skipped.

## Integration Strategy

- **Capture → Enrichment** is the load-bearing contract: enrichment only ever reads `status: draft` files and the `captured` field capture writes. No second capture path, no enrichment-side re-definition of the frontmatter shape.
- Both children are soft inputs to Feature C (#1553), which reads the full frontmatter contract (`status`, `captured`, `enriched`, `## Enrichment`) to present incubating thoughts — Feature C is out of scope for this split.
- These two children batch-plan as ONE group plan and ship as ONE PR (GH-1538) — the estimates above size plan phases, not separate PR-sized deliverables.

## Feature Sequencing

1. **Polymorphic brain-dump capture** (#1559) — no dependencies within this split.
2. **Background enrichment pass** (#1560) — blocked by #1559 (reads the frontmatter contract capture defines).

Dependency edge on the board: #1559 → #1560.

## What We're NOT Doing

- No new verb — capture stays on `/ralph:form --mode draft`; enrichment stays inside `caretake --mode all`.
- No full `/ralph:research` doc per captured thought — enrichment is bounded to three cheap lookups.
- No auto-advancement of captured or enriched thoughts into the pipeline — mobilization stays human-initiated (the brief's "kick off?" offer, Feature C, is out of scope here).
- No new scheduler or cron wiring for enrichment — it rides the existing heartbeat.

## References

- Parent (split source): https://github.com/cdubiel08/ralph-hero/issues/1554
- Children: #1559, #1560
- Epic: https://github.com/cdubiel08/ralph-hero/issues/1550
- Plan: `thoughts/shared/plans/2026-07-19-GH-1550-epic-ways-of-working-surfaces.md`
- Research: `thoughts/shared/research/2026-07-19-ways-of-working-action-surfaces.md`
- Principle: GH-706 (capture before context evaporates; extract first, confirm after)
