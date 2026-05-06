---
date: 2026-04-26
topic: "The softmax function from first principles, and the broader landscape of techniques for calibrating and re-ranking search results beyond softmax/temperature scaling"
tags: [research, softmax, calibration, reranking, retrieval, hybrid-search, rrf, cross-encoders, learning-to-rank, llm-rerank, ralph-knowledge]
status: complete
type: research
github_issue: 898
github_url: https://github.com/cdubiel08/ralph-hero/issues/898
---

# Research: Softmax + Re-Rank Calibration Landscape

## Prior Work

- builds_on:: [[2026-04-03-knowledge-implementation-comparison-obra-vs-ralph]]
- builds_on:: [[2026-03-28-ralph-knowledge-multi-project-architecture]]
- builds_on:: [[2026-04-19-group-GH-762-ralph-knowledge-chunked-embeddings-dream-loop]]
- builds_on:: [[2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop]]
- builds_on:: [[2026-04-16-local-llm-delivery-truth-personal-dreams-team-memory]]

## Research Question

Two parts:

1. Document the softmax function — its formula, the temperature parameter, where it appears in machine learning, where it appears (and doesn't) in retrieval/ranking, and its known calibration pitfalls.
2. Survey other production-grade and research-grade techniques for improving the calibration and quality of search re-ranking, beyond softmax + temperature scaling. Pay particular attention to techniques compatible with a hybrid BM25 + dense-vector pipeline, since `ralph-knowledge` already uses RRF over FTS5 + sqlite-vec.

## Summary

Softmax converts an arbitrary real-valued vector of "logits" into a probability distribution over K classes. It is the dominant choice for multi-class classifier output layers, transformer attention, RL policy heads, and language-model token sampling. In retrieval, softmax is the underlying loss for several listwise learning-to-rank formulations, but **it is not the dominant production choice for combining or normalizing hybrid-retrieval scores** — RRF (Reciprocal Rank Fusion, k=60) holds that role across Elasticsearch, OpenSearch, Weaviate, Qdrant, and Azure AI Search. The broader landscape of re-rank quality improvements falls into seven categories: cross-encoder rerankers, LLM-as-reranker, post-hoc score calibration (Platt, isotonic, beta), learned linear/GBDT fusion, query-side techniques (HyDE, LLM rewriting), diversity reranking (MMR, DPP), and a handful of newer specialty techniques (LiPO, Lost-in-the-Middle mitigations, multi-stage cross-encoder fine-tuning).

A practical decision heuristic at the end of this document maps common scenarios (small-corpus cold start, large-corpus with click logs, regulated domain, latency-sensitive, batch quality) to a first-line technique to consider.

## Part 1 — The Softmax Function

### Definition

Given a vector **z** of K real numbers (logits):

```
σ(z)_i = exp(z_i) / Σ_j exp(z_j)
```

Outputs lie strictly in (0, 1) and sum to exactly 1, yielding a valid probability distribution over K categories. The exponential maps arbitrary real inputs to positive values (required before normalization) and amplifies differences between logits — larger logits get disproportionately more probability mass, the source of softmax's "soft argmax" character.

**Numerical stability.** The raw formula overflows for large logits since `exp(800)` exceeds float64 range. The standard fix subtracts the maximum logit before exponentiating:

```
σ(z)_i = exp(z_i − max(z)) / Σ_j exp(z_j − max(z))
```

Mathematically identical, but all exponentials are bounded by 1. See [Softmax — Wikipedia](https://en.wikipedia.org/wiki/Softmax_function).

The function was named and given its probabilistic interpretation by John S. Bridle in 1990 ([Springer chapter](https://link.springer.com/chapter/10.1007/978-3-642-76153-9_28)). The standard textbook treatment is Goodfellow et al., *Deep Learning*, [Section 6.2](https://www.deeplearningbook.org/contents/mlp.html).

### Temperature parameter

Dividing logits by a scalar T before softmax controls distributional sharpness:

```
σ(z/T)_i = exp(z_i / T) / Σ_j exp(z_j / T)
```

- T → 0 collapses onto the highest-logit class (argmax), deterministic.
- T = 1 uses the trained distribution as-is.
- T → ∞ approaches uniform.

Three contexts where temperature is load-bearing:

- **Reinforcement learning** (Boltzmann policy): T controls exploration vs. exploitation.
- **Language-model sampling**: T = 0.7–0.9 typical for creative generation, T < 0.5 for factual tasks.
- **Calibration**: Guo et al. (ICML 2017) showed post-hoc temperature scaling — fitting a single scalar T on a held-out set — is one of the simplest and most effective recalibration methods for modern neural networks. [On Calibration of Modern Neural Networks — arXiv:1706.04599](https://arxiv.org/abs/1706.04599) | [AWS Prescriptive Guidance — Temperature Scaling](https://docs.aws.amazon.com/prescriptive-guidance/latest/ml-quantifying-uncertainty/temp-scaling.html).

### Common uses in ML

- **Multi-class classification.** Canonical final-layer activation when classes are mutually exclusive; pairs with cross-entropy loss. Softmax enforces inter-class competition that sigmoid does not.
- **Transformer attention.** [Vaswani et al. 2017](https://arxiv.org/abs/1706.03762) define `Attention(Q, K, V) = softmax(QKᵀ / √d_k) · V`. The `√d_k` divisor is itself a temperature-like stabilization.
- **RL policy heads.** Softmax converts Q-values or advantage estimates into action probabilities.
- **LM token sampling.** Logit vector over vocabulary → softmax (with temperature) → sample. Top-k and top-p truncate before/after.

### Use in retrieval, ranking, and score normalization

**Listwise learning-to-rank.** Softmax cross-entropy serves as a listwise loss in ListNet (Cao et al. 2007) and successors. A SIGIR 2019 paper, ["An Analysis of the Softmax Cross Entropy Loss for Learning-to-Rank"](https://dl.acm.org/doi/10.1145/3341981.3344221), shows the softmax CE loss analytically bounds MRR and NDCG.

**Hybrid search (BM25 + dense vectors): the score-normalization problem.** BM25 scores are unbounded non-negative reals; cosine similarity sits in [−1, 1] (typically [0, 1] after L2 normalization). Distributions differ in range, shape, and per-query spread. Naive options have known failure modes:

- **Min-max normalization**: outlier-sensitive. One anomalous high BM25 score compresses the rest into a narrow band, letting that retriever dominate regardless of mixing weight α. See [Avchauzov on hybrid retrieval](https://avchauzov.github.io/blog/2025/hybrid-retrieval-rrf-rank-fusion/).
- **Z-score normalization**: addresses outliers but still produces query-dependent distributions that don't necessarily match across retrievers.
- **Softmax as normalization**: forces outputs into (0,1) summing to 1, but inherits min-max's outlier sensitivity (one high logit produces a near-degenerate distribution) and adds query-dependent scaling. Not standard in any documented production hybrid pipeline.
- **Convex combination after normalization**: [Macdonald et al. 2023, arXiv:2210.11934](https://arxiv.org/abs/2210.11934) shows weighted sum outperforms RRF in-domain and out-of-domain when even a small labeled set exists for tuning α.
- **Reciprocal Rank Fusion (RRF, k=60)**: [Cormack, Clarke, Büttcher, SIGIR 2009](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf): `RRF_score(d) = Σ_r 1 / (k + rank_r(d))`. Score-agnostic, no tuning required, robust across LETOR 3. The tradeoff: discards score magnitude — a 0.99 cosine and a 0.52 cosine at the same rank are treated identically.

The literature has converged on RRF as the robust no-tuning default and convex combination as the higher-ceiling option when labeled data exists. Softmax-based score normalization remains research-level rather than production-standard for hybrid retrieval.

### Pitfalls

- **Overconfidence.** Modern deep networks trained with softmax + cross-entropy routinely emit probabilities of 0.99+ on inputs that are ambiguous or out-of-distribution. Guo et al. document this systematically across ResNets, DenseNets, LSTMs.
- **No epistemic uncertainty.** Softmax models *aleatoric* uncertainty (inherent class overlap) but cannot express *epistemic* uncertainty (input outside training domain). [Ulmer et al. 2021 — Understanding Softmax Confidence](https://ar5iv.labs.arxiv.org/html/2106.04972): "there is no reason to trust them outside of the training distribution."
- **Probabilities are relative, not absolute.** Outputs sum to 1 across the K candidate classes seen during training. Adding/removing a class changes all probabilities; outputs are not portable as standalone confidence scores.
- **Calibration is fixable but not automatic.** Temperature scaling is the simplest remedy; Platt, isotonic, and Dirichlet calibration exist for cases where T alone is insufficient.

## Part 2 — Re-Rank Calibration and Quality Beyond Softmax

### Cross-encoder rerankers (the dominant production cascade)

**Why the cascade exists.** Bi-encoders (dense retrievers) embed query and document independently, enabling ANN search but losing token-level interaction. Cross-encoders concatenate (query, document) and run them through a full transformer — much more accurate but O(n) forward passes per candidate. The standard production answer: bi-encoder retrieves ~100–500 candidates, cross-encoder reranks the shortlist.

- **MonoBERT, MonoT5, DuoT5.** MonoBERT scores via BERT `[CLS]` head as binary classification. MonoT5 ([Nogueira et al. 2020](https://arxiv.org/pdf/2101.05667)) reframes ranking as seq2seq: feed `"Query: … Document: … Relevant:"` and score the log-prob of `true`. DuoT5 does pairwise comparisons (O(n²), used only on top ~50). The Castorini *Expando-Mono-Duo* pipeline is canonical.
- **ColBERT / ColBERTv2 (late interaction).** Retains per-token embeddings for query and document; scores via MaxSim (each query token's nearest document token, summed). Sits between bi-encoder and cross-encoder in compute and quality. ColBERTv2 adds residual compression; PLAID adds centroid-based pruning (7× faster GPU, 45× faster CPU). [ColBERT explainer](https://medium.com/@2nick2patel2/colbert-and-friends-re-ranking-that-feels-instant-6c09102b7526).
- **Commercial offerings (2024–2026).** All API-accessible, send (query, documents[]) → ranked list:
  - [Cohere Rerank v3/v4](https://cohere.com/rerank) — multilingual, strong BEIR, ~600ms p50.
  - [Voyage AI Rerank-2/2.5](https://blog.voyageai.com/2024/09/30/rerank-2/) — instruction-following, 13.9% NDCG lift over Cohere v3 on their eval set.
  - [Jina Reranker v3](https://jina.ai/models/jina-reranker-v3/) — open-weight, 61.94 nDCG@10 on BEIR, sub-200ms.
  - BGE-Reranker-v2-m3 (BAAI) — open-source, self-hostable, competitive on MTEB.
  - [AnswerAI/rerankers](https://github.com/AnswerDotAI/rerankers) — unified Python API across the above.

*Use when:* quality matters more than marginal API cost and 200ms–2s rerank latency on top-100 is acceptable. For sub-50ms SLAs, prefer ColBERT late interaction.

### LLM-as-reranker

**Three prompting paradigms.** *Pointwise* (rate each doc independently — cheap, scale-biased), *pairwise* ("which is more relevant?" — better signal, O(n²)), *listwise* (rank a window of K, output a permutation — highest fidelity).

- **RankGPT (Sun et al. 2023).** Sliding window of ~20 docs, GPT outputs numbered permutation, window slides bottom-up. Zero-shot.
- **RankZephyr / RankVicuna.** Open-source 7B fine-tuned variants. Toolkit: [castorini/rank_llm](https://github.com/castorini/rank_llm).
- **Failure mode — Lost in the Middle.** [Liu et al. 2023, arXiv:2307.03172](https://arxiv.org/abs/2307.03172): LLMs preferentially attend to start/end of context. Mitigations: interleave window orderings, multi-pass aggregation, or use position-robust architectures like ListT5.
- **Cost reality.** Adds 4–6s latency vs cross-encoders, 10–100× cost per query at GPT-4o prices. Open-source models on vLLM/SGLang reach ~1–2s.

*Use when:* batch reranking (offline), domain-specific corpora with subtle relevance signals, no labeled data for cross-encoder fine-tuning.

### Score calibration techniques (post-hoc)

These adjust raw scores to produce well-calibrated probabilities. Goal isn't to change ranking order — it's to make scores meaningful across queries and systems for fusion or thresholding.

- **Platt scaling.** Logistic regression (sigmoid with parameters A, B) fit on validation (raw_score, binary_label) pairs. Strictly monotonic — preserves AUC exactly. *Use when:* small labeled set (<500), score is roughly sigmoidal, must preserve exact rank metrics. [scikit-learn calibration docs](https://scikit-learn.org/stable/modules/calibration.html) | [Platt scaling — Wikipedia](https://en.wikipedia.org/wiki/Platt_scaling).
- **Isotonic regression.** Piecewise-constant monotonic non-decreasing function. More powerful than Platt for non-sigmoid curves, requires ≥1000 samples to avoid overfitting. May introduce ties (flat steps). *Use when:* ample labeled data, calibration accuracy is the priority, downstream is thresholding/display rather than fine-grained ranking within ties.
- **Beta calibration.** Generalizes Platt to handle scores that cluster near 0 or 1 (common for BM25 on short docs). [abzu.ai calibration intro](https://www.abzu.ai/data-science/calibration-introduction-part-2/).
- **Histogram / equal-frequency binning.** Partition score range into K bins, assign each bin the mean observed relevance rate. Interpretable, audit-friendly. Needs even more data than isotonic. *Use when:* regulated domain where "show your work" is required.

**Comparison to temperature scaling.** Temperature only sharpens or flattens an existing softmax; it cannot fix a badly-shaped calibration curve. For non-softmax outputs (BM25, raw cosine), Platt or isotonic generally outperform temperature scaling because they're not constrained to the softmax functional form.

### Learned fusion / weighted combination

- **Weighted convex combination.** `score = α·score_dense + (1−α)·score_sparse` with α tuned on a labeled dev set. Simple, interpretable. Vulnerable to query-type distribution shift.
- **LambdaMART / GBDT on retrieval scores as features.** Treat each retrieval signal — BM25, dense score, field-weighted TF-IDF, CTR, document age — as a feature; gradient-boosted trees with the LambdaRank objective directly optimize NDCG. [LambdaMART explained — Shaped](https://www.shaped.ai/blog/lambdamart-explained-the-workhorse-of-learning-to-rank) | [XGBoost LTR tutorial](https://xgboost.readthedocs.io/en/stable/tutorials/learning_to_rank.html) | [LightGBM LGBMRanker](https://lightgbm.readthedocs.io/en/latest/pythonapi/lightgbm.LGBMRanker.html). Elasticsearch ships a native LTR plugin. *Use when:* thousands+ of click logs or judgments, heterogeneous signals with non-linear interactions, can afford periodic retraining. Remains a strong baseline against neural models in e-commerce and web search.
- **DPR + cross-encoder distillation.** Train the bi-encoder using soft labels from a cross-encoder teacher; the retriever learns to mimic the cross-encoder's score distribution. PairDistill (2024) extends to pairwise signals. [arXiv:2410.01383](https://arxiv.org/html/2410.01383). *Use when:* you want to bake reranker quality into retrieval and reduce reranker invocations at inference.

### Pseudo-relevance feedback and query-side techniques

- **RM3 / Rocchio.** Classic PRF: top-K docs → expand query with top-M terms. Rarely used in classical form today.
- **HyDE — Hypothetical Document Embeddings ([Gao et al. 2022, arXiv:2212.10496](https://arxiv.org/abs/2212.10496)).** Prompt LLM for a hypothetical ideal document, encode that, retrieve by similarity to the hypothetical embedding. nDCG@10 of 61.3 on TREC-DL20 vs 44.5 for Contriever — ~38% relative improvement, no labels needed. [Haystack HyDE docs](https://docs.haystack.deepset.ai/docs/hypothetical-document-embeddings-hyde). *Use when:* zero-shot/cold-start, short ambiguous queries, vocabulary mismatch between query and corpus. Adds 25–60% latency.
- **LLM query rewriting.** Generate paraphrases / entity expansions / sub-question decompositions, retrieve for each, fuse. Stays in query space — easier to audit than HyDE.

### Diversity / MMR re-ranking

- **Maximal Marginal Relevance (Carbonell & Goldstein 1998).** Greedy iterative: pick doc maximizing `λ·relevance − (1−λ)·max_similarity_to_already_selected`. Native in [Elasticsearch](https://www.elastic.co/search-labs/blog/maximum-marginal-relevance-diversify-results) and [OpenSearch](https://docs.opensearch.org/latest/vector-search/specialized-operations/vector-search-mmr/). *Use when:* near-duplicate clustering, or diversity is a stated product goal.
- **Determinantal Point Processes (DPPs).** Probabilistic model where set probability ∝ determinant of a kernel matrix encoding pairwise similarity. Greedy MAP is O(Nk³). Joint reasoning over global diversity, vs MMR's local greedy view. *Use when:* you can afford the compute and need set-level diversity guarantees.
- **Sampled MMR (SIGIR 2025).** Adds randomness for better relevance-diversity tradeoff with logarithmic speedup. [ACM DL — SMMR](https://dl.acm.org/doi/10.1145/3726302.3730250).

### Newer / specialty techniques (2024–2026)

- **ColBERT as a reranker substrate (mid-cascade).** Late interaction between bi-encoder retrieval and full cross-encoder; better quality than bi-encoder, lower cost than cross-encoder. PLAID makes it production-feasible.
- **LiPO — Listwise Preference Optimization ([NAACL 2025](https://aclanthology.org/2025.naacl-long.121.pdf)).** Applies LambdaLoss as a fine-tuning objective for LLMs, directly optimizing DCG. RLPO ([arXiv:2601.07449](https://arxiv.org/html/2601.07449v1)) adds a lightweight set-encoder for list-conditioned residuals.
- **Lost-in-the-Middle mitigations.** For listwise LLM rerankers: place high-relevance candidates at window boundaries, multi-permuted-pass aggregation, or position-robust architectures like ListT5.
- **CombSUM / CombMNZ / weighted RRF.** Beyond plain RRF: CombSUM sums normalized scores; CombMNZ multiplies by the count of systems retrieving the doc (rewards consensus); weighted RRF allows per-list weights. Both score-based variants need normalization first. [OpenSearch RRF intro](https://opensearch.org/blog/introducing-reciprocal-rank-fusion-hybrid-search/) | [Risk-reward in rank fusion (Benham)](https://rodgerbenham.github.io/bc17-adcs.pdf).
- **Multi-stage cross-encoder fine-tuning ([arXiv:2503.22672](https://arxiv.org/html/2503.22672v1)).** Pretraining on a general corpus then domain-adapting consistently outperforms single-stage fine-tuning across retrieval benchmarks.

### Decision rubric

| Scenario | First technique to consider |
|---|---|
| Small corpus, no labels, cold start | HyDE + cross-encoder via API (Cohere/Jina), no training |
| Large corpus + click logs | LambdaMART with BM25/dense + click features; bi-encoder distilled from cross-encoder |
| Regulated domain, interpretable calibration required | Platt scaling or equal-frequency histogram on reranker outputs; MMR for diversity; avoid opaque LLM reranking |
| Latency-sensitive (< 200ms SLA) | ColBERT late interaction or Jina Reranker v3 (sub-200ms); avoid LLM-as-reranker |
| Batch / offline quality, latency unconstrained | LLM listwise reranking (RankGPT/RankZephyr) with Lost-in-the-Middle mitigation; DPP for diversity |
| Fusion calibration across heterogeneous retrievers | Platt-scale each retriever on a labeled dev set before fusing; weighted RRF or LambdaMART-fusion over raw CombSUM |

## Code References

No softmax or post-hoc calibration code currently lives in `ralph-knowledge`. Hybrid ranking goes through `hybrid-search.ts` using RRF over FTS5 (`search.ts`) and sqlite-vec (`vector-search.ts`) outputs. This research surveys techniques external to the current implementation.

## Architecture Documentation

`ralph-knowledge` currently sits at "Stage 1" of the cascade — bi-encoder + BM25 fused via RRF, with no reranker stage. Adopting any technique from Part 2 above would mean inserting a Stage 2 reranker between RRF and the MCP tool surface, or replacing RRF with a learned fusion. Both are architectural changes; both require a labeled dev set or click signal that doesn't currently exist in this corpus.

## Historical Context (from thoughts/)

- `thoughts/shared/research/2026-04-03-knowledge-implementation-comparison-obra-vs-ralph.md` — confirms RRF is the current ranker ("ralph-knowledge is ahead: Hybrid search with Reciprocal Rank Fusion").
- `thoughts/shared/research/2026-03-28-ralph-knowledge-multi-project-architecture.md` — MCP tool surface table marking `knowledge_search` as "FTS5 + sqlite-vec RRF."
- `thoughts/shared/plans/2026-04-19-group-GH-762-ralph-knowledge-chunked-embeddings-dream-loop.md` — Task 4.3 modifies hybrid search to bucket by `doc_id` for chunk-level dedup; doesn't change ranker math.
- `thoughts/shared/plans/2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop.md` — vector search join logic and chunk-to-document aggregation, including snippet generation.
- `thoughts/shared/research/2026-04-16-local-llm-delivery-truth-personal-dreams-team-memory.md` — dream-loop seed, also cites RRF as the substrate.
- No prior thoughts mention softmax, Platt scaling, isotonic regression, cross-encoders, ColBERT, RankGPT, HyDE, MMR, or LambdaMART. Net-new territory for this corpus.

## Open Questions

1. **Score-magnitude observability.** The current `knowledge_search` returns RRF scores in the 0.01–0.03 range with no obvious cutoff between relevant and incidental hits. Would any of the post-hoc calibration techniques (Platt, isotonic) work well on RRF output, or do they require the underlying retriever scores instead?
2. **Labeled data feasibility.** Most learned-fusion and calibration approaches need a labeled dev set (clicks, judgments, or self-annotations). What's the minimum-viable labeling effort that would unlock LambdaMART or convex-combination-with-tuned-α for this corpus size (~75+ docs and growing)?
3. **Local cross-encoder feasibility.** A local cross-encoder rerank stage (e.g., BGE-Reranker-v2-m3 or a small Qwen-based reranker) on M5 Pro hardware could complement the existing local-LLM stack. Latency and quality at the corpus scale would need a small benchmark.
4. **Diversity without labels.** MMR is label-free and could be added immediately as a Stage 2. Whether the current corpus exhibits enough near-duplicate clustering to make this worthwhile would need a quick measurement.

## Sources

- [Softmax function — Wikipedia](https://en.wikipedia.org/wiki/Softmax_function)
- [Bridle 1990 — Springer](https://link.springer.com/chapter/10.1007/978-3-642-76153-9_28)
- [Goodfellow et al., Deep Learning, Ch. 6](https://www.deeplearningbook.org/contents/mlp.html)
- [Vaswani et al. 2017, Attention Is All You Need](https://arxiv.org/abs/1706.03762)
- [Guo et al. 2017, On Calibration of Modern Neural Networks](https://arxiv.org/abs/1706.04599)
- [Ulmer et al. 2021, Understanding Softmax Confidence](https://ar5iv.labs.arxiv.org/html/2106.04972)
- [Cormack et al. 2009, RRF (SIGIR)](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf)
- [Macdonald et al. 2023, Fusion Functions for Hybrid Retrieval](https://arxiv.org/abs/2210.11934)
- [Softmax Cross-Entropy Loss for Learning-to-Rank — SIGIR 2019](https://dl.acm.org/doi/10.1145/3341981.3344221)
- [Avchauzov on hybrid retrieval and RRF](https://avchauzov.github.io/blog/2025/hybrid-retrieval-rrf-rank-fusion/)
- [Baeldung — Softmax temperature](https://www.baeldung.com/cs/softmax-temperature)
- [AWS — Temperature scaling](https://docs.aws.amazon.com/prescriptive-guidance/latest/ml-quantifying-uncertainty/temp-scaling.html)
- [Pradeep, Nogueira et al. — Expando-Mono-Duo](https://arxiv.org/pdf/2101.05667)
- [ColBERT and Friends — Re-ranking that feels instant](https://medium.com/@2nick2patel2/colbert-and-friends-re-ranking-that-feels-instant-6c09102b7526)
- [Cohere Rerank](https://cohere.com/rerank)
- [Voyage AI Rerank-2](https://blog.voyageai.com/2024/09/30/rerank-2/)
- [Jina Reranker v3](https://jina.ai/models/jina-reranker-v3/)
- [AnswerAI/rerankers — unified API](https://github.com/AnswerDotAI/rerankers)
- [LLMs as Pairwise Rankers](https://arxiv.org/html/2306.17563v2)
- [castorini/rank_llm — RankGPT/Zephyr/Vicuna toolkit](https://github.com/castorini/rank_llm)
- [Lost in the Middle (Liu et al. 2023)](https://arxiv.org/abs/2307.03172)
- [ListT5 — Listwise Reranking with Fusion-in-Decoder](https://arxiv.org/html/2402.15838v2)
- [scikit-learn — Probability Calibration](https://scikit-learn.org/stable/modules/calibration.html)
- [Platt scaling — Wikipedia](https://en.wikipedia.org/wiki/Platt_scaling)
- [Beta calibration — abzu.ai](https://www.abzu.ai/data-science/calibration-introduction-part-2/)
- [LambdaMART — Shaped](https://www.shaped.ai/blog/lambdamart-explained-the-workhorse-of-learning-to-rank)
- [XGBoost — Learning to Rank](https://xgboost.readthedocs.io/en/stable/tutorials/learning_to_rank.html)
- [LightGBM — LGBMRanker](https://lightgbm.readthedocs.io/en/latest/pythonapi/lightgbm.LGBMRanker.html)
- [PairDistill](https://arxiv.org/html/2410.01383)
- [HyDE — arXiv:2212.10496](https://arxiv.org/abs/2212.10496)
- [HyDE — Haystack docs](https://docs.haystack.deepset.ai/docs/hypothetical-document-embeddings-hyde)
- [MMR — Elasticsearch Labs](https://www.elastic.co/search-labs/blog/maximum-marginal-relevance-diversify-results)
- [MMR — OpenSearch](https://docs.opensearch.org/latest/vector-search/specialized-operations/vector-search-mmr/)
- [DPP for diversity — Medium](https://medium.com/data-science-collective/diversity-in-recommendations-determinantal-point-processes-dpp-2427bf1b6324)
- [SMMR — SIGIR 2025](https://dl.acm.org/doi/10.1145/3726302.3730250)
- [LiPO — NAACL 2025](https://aclanthology.org/2025.naacl-long.121.pdf)
- [RLPO](https://arxiv.org/html/2601.07449v1)
- [Multi-stage cross-encoder fine-tuning](https://arxiv.org/html/2503.22672v1)
- [Introducing RRF — OpenSearch](https://opensearch.org/blog/introducing-reciprocal-rank-fusion-hybrid-search/)
- [Risk-Reward Tradeoffs in Rank Fusion (Benham)](https://rodgerbenham.github.io/bc17-adcs.pdf)
