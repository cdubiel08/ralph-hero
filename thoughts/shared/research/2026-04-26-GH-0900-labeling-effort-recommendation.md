---
date: 2026-04-26
github_issue: 900
github_url: https://github.com/cdubiel08/ralph-hero/issues/900
status: complete
type: research
tags: [learning-to-rank, labeling, ralph-knowledge, hybrid-search, calibration]
---

# Minimum-Viable Labeling Effort for Learned Fusion — Recommendation Note (GH-900)

## Prior Work

- builds_on:: [[2026-04-26-GH-0900-minimum-viable-labeling-learned-fusion]]
- builds_on:: [[2026-04-26-softmax-and-rerank-calibration]]
- builds_on:: [[2026-04-26-GH-0899-rrf-calibration-recommendation]]

## Recommendation

**Pursue convex-combination-with-tuned-alpha as the MVP labeled-fusion path; defer
LambdaMART until the corpus and labeled set both grow by an order of magnitude.**

The investigation in `2026-04-26-GH-0900-minimum-viable-labeling-learned-fusion.md`
established two facts that drive this choice:

1. The corpus is **1,453 documents** (not the ~75 estimated in the issue body) —
   large enough that a single global alpha is meaningful, but still small enough
   that sample-efficient methods dominate.
2. The `outcome_events` table has **zero rows** — `knowledge_record_outcome` has
   never been called for search events. There are no implicit click/dwell signals
   to repurpose, so the labeled set has to be built from scratch.

Convex combination tunes a single scalar alpha against held-out NDCG@10. Per
Macdonald et al. (2023) and the LlamaIndex alpha-tuning guidance, **50-100
labeled queries (300-1000 query-doc grade pairs) suffice** — well within reach
of a 3-4-hour self-annotation effort. LambdaMART, by contrast, has a **soft
floor of 500+ distinct labeled queries (2,500-5,000 pair judgments)** — 10-100x
more labeling work. At the corpus's current query-rate (effectively zero
production search-feedback events), LambdaMART cannot be attempted without a
multi-week dedicated labeling effort. Defer it until the gap closes.

## Target labeling counts

| Method | Queries | Grades per query | Total grades | Labeling time |
|---|---|---|---|---|
| **Alpha tuning (MVP)** | 60 | 10 | 600 | ~3-4 hours |
| LambdaMART (deferred) | 500+ | 5-10 | 2,500-5,000 | ~25-40 hours |

The 60-query alpha-tuning target stratifies as **12 queries × 5 intent classes**
(see Workflow below). At 10 results per query (default `knowledge_search` limit),
this yields **600 (query, doc, grade) triples** — comfortably above the 500-pair
floor for stable single-parameter tuning and well below the level at which LLM
self-annotation drift becomes a measurable problem (see "Self-annotation by
Claude" below).

For comparison, the lower-bound estimate of 50 queries × 3 grades = **150 pairs**
is the absolute minimum — sufficient for a coarse alpha grid search but
insufficient for a held-out validation split. The 600-pair target gives a clean
80/20 train/validation split (480 train, 120 validation).

## Workflow

Four phases, ~3.5-4 hours total. Each phase produces a verifiable artifact.

### Phase 1: Query sampling (~30 min)

Draft 60 queries spanning the **5 intent classes** identified by the source
research:

| Intent | Caller | Sample queries (pick 12 each) |
|---|---|---|
| **Prior-work topic lookup** | research skill (thoughts-locator/analyzer) | "chunked embeddings RRF", "pipeline state machine", "worktree isolation" |
| **Plan retrieval by issue number** | artifact-comment-protocol | "implementation plan GH-761", "plan GH-838" |
| **Claim evidence search** | prove-claim skill | "RRF is the default hybrid retrieval strategy", "sonnet is used for research agents" |
| **Epic context lookup** | ralph-plan-epic skill | "Stage-2 reranker calibration exploration", "dream loop architecture" |
| **Hero orientation** | hero skill | "recent research on embedding models", "token resolution gh auth" |

Stratification rule: ~10 queries with known good answers (mostly plan-retrieval
intent — see "Pre-labeled subset" below), ~50 open-ended topic/claim/context
queries. The plan-retrieval queries serve as a **validation anchor**: alpha
tuning must not degrade exact-match retrieval performance on these.

### Phase 2: Annotation (~2-3 hrs)

For each of the 60 queries:

1. Run `knowledge_search` with default settings (no `lambda`, no
   `return_diagnostics`).
2. Grade the top-10 results on a **3-point scale**:
   - **2 = directly answers the query** (the doc is what the caller wanted)
   - **1 = tangentially relevant** (related topic, different issue, useful but
     not the target)
   - **0 = not relevant** (off-topic, wrong context, hallucinated match)
3. Record each grade as a `search_feedback` outcome event (see Storage below).

Annotation discipline: do not look at retrieval scores while grading. Grade
purely on whether the returned snippet would satisfy the caller's intent.

### Phase 3: Alpha tuning (~1 hr)

1. Hold out 20% of labeled queries (12 queries, 120 grades) as the validation
   split. Stratify by intent class so each class is represented.
2. For alpha in `[0.0, 0.1, 0.2, ..., 1.0]`:
   - Re-run each training query with the candidate alpha applied to the convex
     combination of normalized FTS and vector ranks (replacing pure RRF).
   - Compute NDCG@10 against the labeled grades.
3. Pick the alpha that maximizes mean NDCG@10 on the training split **without
   degrading NDCG@5 on the plan-retrieval validation queries** (the
   exact-match anchor).
4. Report the final NDCG@10 lift vs pure RRF on the validation split.

Convex combination implementation note: the new `return_diagnostics` flag from
[GH-899 Phase 2](./2026-04-26-GH-0899-rrf-calibration-recommendation.md)
exposes the per-retriever raw scores (`fts_score`, `vec_distance`) needed to
compute a weighted-average fusion as an alternative to RRF. The notebook can
load these directly without changes to `hybrid-search.ts`.

### Phase 4: Decide on LambdaMART (~30 min review)

Decision matrix based on Phase 3's NDCG@10 lift:

| Result | Decision |
|---|---|
| Lift >3% | Commit to convex combination. File followup to wire alpha into `hybrid-search.ts` and to scale labeling toward LambdaMART (~500 queries). |
| Lift 1-3% | Marginal. File a followup to revisit after the corpus reaches 2,000+ docs OR after `outcome_events` accumulates real production signals. |
| Lift <1% | Corpus signals are too uniform for fusion tuning. Pivot to label-free alternatives (HyDE, MMR — Phase 1 of this group plan already shipped MMR). Document the learning-curve datapoint as a deferral artifact. |

In all three cases, the 600-grade dataset is preserved as `search_feedback`
outcome events for future use (calibration of [GH-899 Track A](./2026-04-26-GH-0899-rrf-calibration-recommendation.md),
benchmarking of [GH-901 cross-encoder rerankers](https://github.com/cdubiel08/ralph-hero/issues/901),
and as a seed for any future LambdaMART attempt).

## Self-annotation by Claude

The 60-query MVP is small enough to self-annotate in a single Claude session
(~2-3 hours of inference + reading time, ~600 grade decisions). Recent research
makes this the credible default rather than a last-resort fallback.

**Supporting evidence:**

- **[Leveraging LLMs for Utility-Focused Annotation (arXiv:2504.05220, 2025)](https://arxiv.org/html/2504.05220v1)**
  shows that "20% human-annotated data combined with LLM annotations via
  curriculum learning achieves performance comparable to fully human-annotated
  models." For the 60-query MVP this implies ~12 human-spot-checked queries are
  sufficient to anchor the LLM-graded majority.
- **[Can LLM Annotations Replace User Clicks for LTR? (arXiv:2511.06635, 2025)](https://arxiv.org/html/2511.06635v1)**
  reports that LLM-supervised models *outperform* click-supervised models on
  medium- and low-frequency queries — exactly the regime of a small, niche
  corpus like ralph-knowledge.
- LLMs excel at semantic matching, which is the core of the topic-lookup and
  claim-evidence intent classes (~36 of the 60 MVP queries).

**Documented risks and mitigations:**

| Risk | Mitigation |
|---|---|
| LLMs impose looser relevance thresholds → false positives on grade=1 vs grade=0 | Use the conservative 3-point scale (0/1/2) with explicit "directly answers" vs "tangentially relevant" criteria. Run a 2-shot prompt with canonical good/bad results before each query. |
| Self-annotation bias (Claude grading its own search system's output) | Include 12 **pre-labeled plan-retrieval queries** as a validation anchor; if Claude's grades disagree with the known-correct answer for these, recalibrate the prompt. |
| Project-specific structure (issue numbers, file paths, workflow states) under-weighted | Provide a 1-paragraph corpus orientation in the annotation prompt: "Documents are research notes, plans, and reviews from a Claude Code plugin project; queries are issued by skills/agents during autonomous workflow execution." |
| Inter-rater reliability cannot be measured with a single judge | For the LambdaMART deferral decision, require a 10-query human spot-check (~30 min) against Claude's grades before committing 25-40 hrs to a 500-query labeling effort. |

**Pre-labeled subset:** 584 documents have `github_issue` frontmatter, so for
the plan-retrieval intent (12 of the 60 queries) the ideal top-1 result is
implicitly known — no annotation cost, zero ambiguity. Use these as the
calibration anchor for the LLM judge.

## Storage

All grades are stored using the **existing `knowledge_record_outcome` MCP tool**
with a new event type. **No schema change required** — the `payload` column on
`outcome_events` is already `TEXT DEFAULT '{}'` and accepts arbitrary JSON.

```jsonc
// Example: knowledge_record_outcome event
{
  "event_type": "search_feedback",
  "payload": {
    "query": "implementation plan GH-761",
    "doc_id": "thoughts/shared/plans/2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop.md",
    "grade": 2,
    "intent_type": "plan_retrieval"
  }
}
```

`knowledge_query_outcomes` already supports filtering by `event_type`, so the
alpha-tuning notebook reads the labeled set with a single MCP call:

```jsonc
{
  "tool": "knowledge_query_outcomes",
  "args": { "event_type": "search_feedback", "limit": 1000 }
}
```

This keeps the 600-grade dataset queryable from any future agent or notebook
without bespoke storage.

## Followup

A followup issue tracks the actual labeling work:

**Issue:** [`ralph-knowledge: collect 60-query labeled dev set for alpha tuning` — GH-904](https://github.com/cdubiel08/ralph-hero/issues/904)

Scope: implement the 4-phase MVP labeling workflow above; persist results as
`search_feedback` outcome events; deliver a Jupyter/observable notebook that
fits alpha and reports the NDCG@10 lift vs pure RRF on the held-out validation
split.

Decision gating: the followup's outcome (lift >3% / 1-3% / <1%) drives whether
to wire alpha into `hybrid-search.ts`, whether to scale toward LambdaMART, or
whether to pivot to label-free alternatives.
