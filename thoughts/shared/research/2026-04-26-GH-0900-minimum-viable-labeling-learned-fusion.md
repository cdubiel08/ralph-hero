---
date: 2026-04-26
github_issue: 900
github_url: https://github.com/cdubiel08/ralph-hero/issues/900
status: complete
type: research
tags: [learning-to-rank, labeling, ralph-knowledge, hybrid-search, rrf, calibration, lambdamart]
---

# Research: Minimum-Viable Labeling for Learned Fusion (GH-900)

## Prior Work

- builds_on:: [[2026-04-26-softmax-and-rerank-calibration]]
- builds_on:: [[2026-04-26-GH-0899-rrf-calibration-observability]]
- builds_on:: [[2026-04-03-knowledge-implementation-comparison-obra-vs-ralph]]

## Problem Statement

Learned-fusion and post-hoc calibration techniques (LambdaMART, weighted convex combination with tuned alpha, Platt/isotonic) require a labeled dev set. This research scopes the minimum-viable labeling effort that unlocks these techniques for the ralph-knowledge corpus.

## Corpus Size and Growth Pattern

### Actual size (not ~75)

The issue body references "~75 docs." The corpus is significantly larger than that and has already passed any scale that makes labeling trivially cheap.

| Source | Count |
|---|---|
| Total non-stub documents in knowledge.db | 1,453 |
| Documents with path in `thoughts/shared/` | 1,434 |
| `research` type documents | 638 |
| `plan` type documents | 508 |
| `review` / `critique` type documents | 178 |
| Chunks in the chunks table | 11,644 |
| Average chunks per document | 8.3 |
| Outcome events recorded | 0 (table exists, never populated) |

The "~75 docs" figure likely referred to an early-stage estimate made when the issue was written — the corpus was growing at approximately 360 docs/month in February and ~300+ docs/month in both March and April 2026. Corpus will exceed 2,000 documents within two months at current trajectory.

This reframe matters: a 1,400-document corpus creates a larger query-doc pair space, but also means more types of document content exist to be searched, increasing the importance of getting retrieval right.

### Document type taxonomy

The existing file-path-based taxonomy (`/research/`, `/plans/`, `/reviews/`, `/ideas/`, `/reports/`) is well-established and consistently applied. Types already drive the `type` filter parameter in `knowledge_search`. This is a load-bearing dimension for labeling: relevance grades should be collected per type, not pooled across the corpus.

## Query Intent Inventory

No query log exists. The `outcome_events` table in the knowledge DB was created and is connected to `knowledge_record_outcome` MCP tool, but has zero rows — the tool has never been called in production. The `ralph-postmortem` skill has been the only consumer of `knowledge_record_outcome`, and it records pipeline-workflow events (blocker/impediment/session events), not search events.

### Observable query intents from skill and agent inspection

By reading how `knowledge_search` is invoked across the plugin:

| Intent | Caller | Query shape |
|---|---|---|
| **Prior-work lookup** | research skill (via thoughts-locator/analyzer subagents) | `"[topic]"` — topic name, free-form NL |
| **Plan retrieval by issue number** | artifact-comment-protocol | `"implementation plan GH-NNN"` — structured phrase |
| **Claim evidence search** | prove-claim skill | entity names and relationship assertions |
| **Epic context lookup** | ralph-plan-epic skill | topic + related epics |
| **Hero orientation** | hero skill | orientation queries about recent activity |

Five intent classes, with two dominant ones: (1) free-form prior-work lookup by topic, (2) structured plan-by-issue-number retrieval. The latter is almost a lookup query with a known right answer (exactly one plan doc per issue).

### Relevant documents per intent (estimated)

For free-form topic queries, a typical ralph-knowledge search returns 10 results (`limit=10` default). Based on document type distribution:
- 2-4 directly relevant documents per topic query is a reasonable estimate for a well-formed query
- Plans-by-issue-number: exactly 1 relevant document (hard-coded retrieval pattern)

## Industry Minimum Label Counts

### Convex combination (tuning alpha)

The Macdonald et al. (2023) analysis of fusion functions ([arXiv:2210.11934](https://arxiv.org/abs/2210.11934)) explicitly characterizes convex combination as "sample efficient, requiring only a small set of training examples to tune its only parameter to a target domain." External commentary and LlamaIndex documentation on alpha tuning consistently cite **50 to 100 query-relevance pairs** as sufficient to detect meaningful differences and tune alpha.

The math supports this: alpha is a single scalar in [0, 1]. Tuning one parameter against NDCG@10 or Hit Rate@10 requires only enough labeled examples to produce a stable gradient. With 50 queries, each evaluated on their top-10 results, you get 500 query-doc relevance judgments — more than adequate for 1-parameter optimization without overfitting.

**Minimum for convex combination alpha tuning: 50 labeled queries, 3-10 relevance judgments each = 150-500 query-doc pairs.**

### LambdaMART (full GBDT on retrieval features)

The parent research document (softmax-and-rerank-calibration.md) cites "~500-2000 query-doc pairs as a soft floor" for LambdaMART. This aligns with the broader LTR literature, which consistently reports the following:

- LETOR benchmarks (Yahoo LTR, MSLR-WEB10K) have tens of thousands of labeled queries — LambdaMART was developed and validated at that scale
- Small-domain applications of GBDT-based LTR (enterprise search, domain-specific corpora) routinely require at least 500 distinct labeled queries to avoid overfitting to the training split
- With 5-15 retrieval features per document (BM25 rank, vector distance rank, document type, tag overlap, date recency), GBDT overfits readily at fewer than 500 training queries

For a **40-result candidate list per query** (the current `limit * 2 = 40` in hybrid-search.ts line 84), each labeled query yields up to 40 query-doc pairs. To reach 500 distinct labeled queries at ~10 relevance judgments each you need 5,000 query-doc pair judgments — roughly 100x the labeling effort for alpha tuning.

**Minimum for LambdaMART: 500+ distinct labeled queries = 2,500–5,000 query-doc pair judgments.**

## Existing Infrastructure Audit

### No query logs

`outcome_events` has zero rows. No search event is recorded when `knowledge_search` is called. There are no click logs, no dwell-time signals, no user feedback loops. The corpus starts from cold (no implicit labels).

### Explicit signals that could be repurposed

| Signal | Location | Usable for labels? |
|---|---|---|
| `builds_on::` wikilink edges | `relationships` table, 584 docs have `github_issue` | Indirect — not query-doc relevance |
| `github_issue` frontmatter on 584 docs | `documents.github_issue` column | Enables issue-number lookups to verify plan retrieval correctness |
| Issue `status: complete` in frontmatter | `documents.status` | Filters; doesn't establish relevance |
| Outcome event schema | `outcome_events` table (currently 0 rows) | Ready to record; not populated |

The `builds_on::` edges establish document-to-document relationships (doc A was informed by doc B), not query-to-document relevance. They cannot be directly repurposed as relevance labels without manual judgment: knowing doc A builds on doc B doesn't tell you "given a user query about topic X, is doc B relevant?"

One partial shortcut exists: **for the plan-retrieval intent**, the ideal top-1 result for query `"implementation plan GH-NNN"` is already known — it's the plan document with `github_issue: NNN`. This gives a small set of effectively pre-labeled pairs at no annotation cost. With ~584 issues having associated documents, this yields up to 584 labeled queries of the plan-retrieval intent type, each with one gold-standard relevant document. This intent class is however narrow (structured lookup), not representative of free-form topic search.

### MCP tool surface for labeling

`knowledge_record_outcome` (in `plugin/ralph-knowledge/src/index.ts:289`) accepts arbitrary event types and payloads. It could be repurposed to record search feedback by adding a new event type (e.g., `search_feedback`) with payload fields for `query`, `returned_doc_ids`, and `relevance_grades`. This requires no schema changes — the `payload` column is JSONB-style (`TEXT DEFAULT '{}'`) and accepts arbitrary JSON.

`knowledge_query_outcomes` already supports filtering by `event_type`, so a separate search-feedback query path is immediately available once events are recorded.

## Self-Annotation Feasibility

The question from the issue body: can Claude rating its own past `knowledge_search` outputs substitute for human labels at this scale?

### Strengths

- LLM annotation is fast and cheap at the scale needed (50-200 queries costs seconds of inference)
- Recent research ([arXiv:2504.05220](https://arxiv.org/html/2504.05220v1)) shows "20% human-annotated data combined with LLM annotations via curriculum learning achieves performance comparable to fully human-annotated models"
- LLMs excel at semantic matching — free-form topic queries are well-suited to LLM relevance judgment
- The [arXiv:2511.06635](https://arxiv.org/html/2511.06635v1) study shows LLM-supervised models outperform click-supervised models on medium- and low-frequency queries (exactly the type in a small, niche corpus)

### Risks

- LLMs impose looser relevance thresholds, increasing false positives — the study found "the proportion at label 0 drops sharply" with LLM labels
- Ralph-knowledge documents contain structured project content (issue numbers, file paths, workflow states) — a vanilla LLM judge may not correctly weight these signals
- Self-annotation bias: Claude rating outputs of a search system it also runs may exhibit confirmation bias toward its own preferences

### Mitigation

For the alpha-tuning target (50-100 queries), self-annotation is viable with a conservative relevance scale (0 = not relevant, 1 = partially relevant, 2 = highly relevant) and a 1-2 shot prompt showing canonical "good" and "bad" results. The annotation effort per query is minimal (reading 10 snippets, assigning grades). For LambdaMART (500+ queries), self-annotation alone is likely insufficient without human spot-checks on ~20% of labels.

## Recommendation

### Decision: Pursue convex-combination-with-tuned-alpha as the MVP; defer LambdaMART

**Rationale:**

1. **Convex combination is achievable with 50-100 queries.** The corpus (1,400+ docs) is large enough that a single global alpha is meaningful. The labeling effort is approximately 2-4 hours of work: draft 60 representative queries spanning the five intent classes, run `knowledge_search` for each, grade top-10 results (binary or 3-point scale), store grades as `search_feedback` outcome events.

2. **LambdaMART requires 10-100x more data.** With 500 labeled queries as the floor and zero existing logs, LambdaMART cannot be attempted without a dedicated multi-week labeling effort. The corpus query rate is too low to accumulate implicit signals passively.

3. **The plan-retrieval intent is pre-labeled.** 584 issue-number-to-plan-doc pairs exist implicitly. These can be used as a free labeled set to validate that alpha tuning does not degrade exact-match retrieval while improving topic-based search.

4. **Self-annotation is viable at the alpha-tuning scale.** A 60-query self-annotation run using Claude as a relevance judge, with spot-checks on edge cases, is a credible MVP labeling workflow.

### MVP Labeling Workflow

**Phase 1: Query sampling (30 min)**
- Draft 60 queries covering all 5 intent classes (12 per class)
  - Prior-work topic lookups: e.g., "chunked embeddings RRF", "pipeline state machine", "worktree isolation"
  - Plan-by-issue: e.g., "implementation plan GH-761", "plan GH-838"
  - Claim evidence: e.g., "RRF is the default hybrid retrieval strategy", "sonnet is used for research agents"
  - Epic context: e.g., "Stage-2 reranker calibration exploration", "dream loop architecture"
  - Hero orientation: e.g., "recent research on embedding models", "token resolution gh auth"
- Stratify: ~10 queries with known good answers (plan lookups), ~50 open topic queries

**Phase 2: Annotation (2-3 hrs)**
- Run `knowledge_search` with default settings for each query
- Grade top-10 results on a 0/1/2 scale:
  - 2 = directly answers the query
  - 1 = tangentially relevant (related topic, different issue)
  - 0 = not relevant
- Record each grade as a `search_feedback` outcome event with `payload: { query, doc_id, grade, intent_type }`

**Phase 3: Alpha tuning (1 hr)**
- Run grid search over alpha in [0.0, 0.1, ..., 1.0] on held-out 20% of labeled queries
- Evaluate with NDCG@5 and NDCG@10
- Select alpha that maximizes average NDCG@10 without degrading NDCG@5 on plan-lookup queries

**Phase 4: Decide on LambdaMART**
- If alpha tuning produces a measurable improvement (>3% NDCG@10 vs RRF), commit to convex combination and create a follow-up for the labeling infrastructure
- If improvement is flat (<1%), corpus signals are too uniform for fusion tuning and label-free alternatives (HyDE, MMR) are the better path
- Document the learning-curve data point for the LambdaMART deferral decision

## Labeling Unit

The labeling unit is **(query string, document ID, relevance grade)** — the standard pointwise LTR format. Pairwise labels (query, doc_A, doc_B, preference) could be collected during annotation as a byproduct (if a grade-2 and a grade-0 document are both returned, the preference pair is implied), and would be valuable if LambdaMART is attempted later.

- **Grades**: 3-point scale (0/1/2) is the minimum for LambdaMART; binary (0/1) is sufficient for alpha tuning
- **Per-query count**: Grade all top-10 results per query for consistency; minimum useful set is top-5
- **Minimum total**: 50 queries × 10 results = 500 grades for alpha tuning

## Follow-up Issue Needed

If the recommendation is to "label," one follow-up issue is needed:

**Title**: `ralph-knowledge: collect 60-query labeled dev set for alpha tuning`
**Scope**: Implement the MVP labeling workflow above; store results as `search_feedback` outcome events; reuse `knowledge_query_outcomes` to retrieve them for tuning

## Files Affected

### Will Modify
- None — this is scope-only research, no implementation changes in this issue

### Will Read (Dependencies)
- `plugin/ralph-knowledge/src/hybrid-search.ts` - RRF implementation and alpha injection point
- `plugin/ralph-knowledge/src/db.ts` - outcome_events schema for storing search feedback
- `plugin/ralph-knowledge/src/index.ts` - knowledge_record_outcome and knowledge_query_outcomes MCP tools

## Sources

- [An Analysis of Fusion Functions for Hybrid Retrieval — arXiv:2210.11934](https://arxiv.org/abs/2210.11934)
- [Leveraging LLMs for Utility-Focused Annotation — arXiv:2504.05220](https://arxiv.org/html/2504.05220v1)
- [Can LLM Annotations Replace User Clicks for Learning to Rank? — arXiv:2511.06635](https://arxiv.org/html/2511.06635v1)
- [LambdaMART Explained — Shaped](https://www.shaped.ai/blog/lambdamart-explained-the-workhorse-of-learning-to-rank)
- [DAT: Dynamic Alpha Tuning for Hybrid Retrieval — arXiv:2503.23013](https://arxiv.org/pdf/2503.23013)
- [Hybrid Search Alpha Tuning For RAG — LlamaIndex](https://www.llamaindex.ai/blog/llamaindex-enhancing-retrieval-performance-with-alpha-tuning-in-hybrid-search-in-rag-135d0c9b8a00)
- Parent survey: [[2026-04-26-softmax-and-rerank-calibration]]
- Sibling research: [[2026-04-26-GH-0899-rrf-calibration-observability]]
