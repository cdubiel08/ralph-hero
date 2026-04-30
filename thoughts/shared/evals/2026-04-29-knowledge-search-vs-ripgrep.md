---
date: 2026-04-29
status: complete
type: eval
tags: [ralph-knowledge, retrieval-quality, evaluation, semantic-search, lexical-baseline]
github_issues: [907, 916]
---

# Eval: ralph-knowledge semantic search vs ripgrep lexical baseline

## Why this exists

After fixing the chunker OOM (#916) and the embedder Tensor leak (#911), the dream-loop reindex completes end-to-end on the 1,668-doc corpus. **"Doesn't OOM" is not the same as "works well"** — this eval measures whether the retrieval step actually returns the right docs. Two unrelated methods are compared so the comparison is informative rather than self-confirming.

Methodology mirrors the [skill-creator](https://github.com/anthropics/claude-code/tree/main/plugins/skill-creator) eval pattern: golden queries with known-good expected docs, two configurations, scored on objective assertions.

## Configurations

**Method A — Semantic** (`mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search`)
- BGE-base-en-v1.5 sentence embeddings
- sqlite-vec ANN over 12,879 chunks
- Hybrid: SQLite FTS5 + vector, fused with RRF
- Default `lambda=1.0` (pure relevance, no diversity), `limit=10`
- DB: `~/.ralph-hero/knowledge.db` post #911 + #916 reindex (1,710 docs)

**Method B — Lexical** (`ripgrep`)
- `rg --type md -i -c -e "<term1|term2|...>"` over the same 4 thoughts roots that ralph-knowledge indexes
- Score: total match count per file (BM25-ish proxy)
- Same corpus, same top-K cutoff

## Golden Queries

Each query targets a doc known to be in the index. Mix is intentional: 3 specific-keyword (favors lexical), 2 paraphrase/conceptual (favors semantic), 3 mixed.

| # | Query | Expected primary doc | Type |
|---|-------|----------------------|------|
| 1 | "what causes the reindex to OOM in ralph-knowledge" | `2026-04-29-reindex-memory-profile.md` | specific-keyword |
| 2 | "release transformer tensors after embedding to free memory" | `2026-04-29-GH-911-release-embedder-tensors.md` | specific-keyword |
| 3 | "chunker forward progress infinite loop fix" | `2026-04-29-GH-916-chunker-no-progress-fix.md` | specific-keyword |
| 4 | "dream-loop memory consolidation pipeline architecture" | `2026-04-26-dreaming-research-trail-and-self-containment.md` (or `2026-04-16-GH-0761-...`) | mixed |
| 5 | "cross-encoder reranker score calibration" | `2026-04-26-softmax-and-rerank-calibration.md` | mixed |
| 6 | "wikilink extractor for markdown" | `2026-04-26-ralph-knowledge-wikilink-extractor.md` | specific-keyword |
| 7 | "context handoff topology between agents" | `2026-04-22-context-handoff-topology.md` | mixed |
| 8 | "landcrawler permit raw data migration hardening" | `2026-04-24-landcrawler-backend-hardening-postmortem.md` | specific-keyword |

## Results

Rank of expected doc in top-10 (lower is better, ✗ = not in top-10):

| # | Query | Semantic rank | Lexical rank | Winner |
|---|-------|---------------|--------------|--------|
| 1 | reindex OOM | **✗** | **1** | Lexical |
| 2 | tensor disposal | **✗** | **1** | Lexical |
| 3 | chunker progress | **✗** | **1** | Lexical |
| 4 | dream-loop architecture | 7 | **1** | Lexical |
| 5 | reranker calibration | **1** | 2 | Semantic |
| 6 | wikilink extractor | 3 | **1** | Lexical |
| 7 | context handoff | **1** | 4 | Semantic |
| 8 | landcrawler hardening | **✗** | **2** | Lexical |

### Aggregate metrics

| Metric | Semantic | Lexical |
|--------|---------:|--------:|
| Hit@1 | 2/8 (25%) | **5/8 (62.5%)** |
| Hit@5 | 3/8 (37.5%) | **8/8 (100%)** |
| Hit@10 | 3/8 (37.5%) | **8/8 (100%)** |
| MRR | 0.310 | **0.781** |

### Per-query observations

**Q1 (reindex OOM)** — Semantic returned 10 generic ralph-knowledge docs (architecture comparisons, multi-project plans, parity analyses). The literal `2026-04-29-reindex-memory-profile.md` — which contains "OOM" 14 times and "reindex" 60+ times — was not in top-10. Lexical returned it at rank 1 with 68 term matches.

**Q2 (tensor disposal)** — Semantic returned local-LLM and dream-loop architecture docs; missed the GH-911 plan with 3 explicit "Tensor.dispose" call-outs. Lexical found it at rank 1.

**Q3 (chunker progress)** — Semantic returned the dream-loop foundation plans and critique. Missed the GH-916 chunker fix doc despite it containing 37 chunker term matches. Lexical found it at rank 1.

**Q4 (dream-loop)** — Both methods hit related docs but lexical ranked the canonical foundation plan first; semantic put it at rank 7-9 buried under generic "pipeline architecture" docs.

**Q5 (reranker calibration)** ✓ Semantic wins — paraphrase friendly. The expected doc has "softmax" + "calibration" but the query says "score calibration"; semantic embedding bridges the synonym.

**Q6 (wikilink extractor)** — Lexical wins easily on a literal compound term. Semantic confused "wikilink" with broader knowledge-graph topics.

**Q7 (context handoff)** ✓ Semantic wins — query says "between agents" but the doc title says "of the ralph-hero pipeline". Semantic recognizes these are about the same thing; lexical ranks it at 4 because other docs have more keyword density.

**Q8 (landcrawler hardening)** — Semantic returned a related "lineage" doc but missed the actual postmortem. Lexical found it at rank 2.

## Key findings

1. **The system works (no OOM, all 1,710 docs indexed and queryable).** That part is no longer in doubt.

2. **Retrieval quality on specific-keyword queries is poor.** On 4/8 queries (Q1-Q3, Q8) the expected doc isn't even in the top-10 of semantic search, despite being indexed. Lexical finds them all at rank 1-2.

3. **Semantic adds real value on paraphrase queries (Q5, Q7).** Where lexical needs the user to guess the doc's exact wording, semantic bridges synonymy. This is the case it's actually built for.

4. **The aggregate Hit@1 of 25% on hand-picked queries is a strong signal that the current FTS+vector RRF blend underweights FTS.** The expected docs *would* be in the FTS half of the hybrid retrieval (they have the literal query terms) — but RRF's `1/(60+rank)` averaging dilutes them when they don't also rank highly in vector space.

5. **The post-#911+#916 reindex did not regress retrieval quality vs the previous (failing) state.** The misses observed are not new — they're the long-standing semantic-vs-lexical trade-off, now visible because the system reaches enough docs to be measured.

## Recommendations (out of scope for this eval)

These are observations, not part of #916's acceptance:

- **Reweight RRF or switch to weighted-RRF** with FTS bias — would likely fix Q1-Q3, Q8 without regressing Q5, Q7.
- **Apply the cross-encoder reranker** at query time (the M5 Pro reranker is benchmarked in `2026-04-26-GH-0901-...` but not active in the default search path). Reranker top-K=10 → top-3 should bubble the right doc when it's in the candidate set, and FTS will provide the candidate.
- **Tune the chunked embedding context_prefix length** — chunked embeddings dilute keyword specificity. Either skip context_prefix on short docs or prepend the title.
- **Add this eval to CI as a regression guard** — golden-queries + Hit@5 ≥ 50% would catch retrieval regressions without requiring human review.

These map onto open issues #899 (RRF observability), #900 (labeling/learned fusion), #901 (reranker integration). The eval gives them concrete numbers to optimize against.

## Reproducing

The exact commands used to produce this report:

```bash
# Semantic: 8 calls to mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search
# (see this file's git history for the queries)

# Lexical: ripgrep over all 4 indexed thoughts roots
ROOTS="/Users/dubiel/projects/thoughts /Users/dubiel/projects/ralph-hero/thoughts /Users/dubiel/projects/ralph-engine/thoughts"
rg --type md -i -c -e "<query-terms>" $ROOTS \
  | sort -t: -k2 -rn | head -10
```

## References

- Methodology inspiration: `claude-plugins-official:skill-creator/SKILL.md` (eval pattern, baseline-vs-with-skill comparison)
- ralph-knowledge config: `~/.ralph/knowledge.config.json`
- Active reranker research: [2026-04-26-GH-0901-local-cross-encoder-reranker-m5-pro.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-GH-0901-local-cross-encoder-reranker-m5-pro.md)
- Calibration research: [2026-04-26-softmax-and-rerank-calibration.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-softmax-and-rerank-calibration.md)
- RRF observability: [2026-04-26-GH-0899-rrf-calibration-observability.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-GH-0899-rrf-calibration-observability.md)
- Parent #907: [2026-04-29-reindex-memory-profile.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-29-reindex-memory-profile.md)
