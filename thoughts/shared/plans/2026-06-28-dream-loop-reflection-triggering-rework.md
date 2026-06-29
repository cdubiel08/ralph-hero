---
date: 2026-06-28
topic: "Rework the dream-loop reflection stage: accumulation-gated triggering + degrade-safe clustering, informed by web research on agent-memory consolidation SOTA and a GBrain pivot evaluation"
tags: [plan, ralph-knowledge, dream-loop, reflection, clustering, memory-tier, gbrain]
status: formed
type: plan
github_epic: 1509
github_url: https://github.com/cdubiel08/ralph-hero/issues/1509
github_children: [1510, 1511, 1512, 1513]
---

# Plan: Dream-loop reflection triggering & clustering rework

## Prior Work

- builds_on:: [[2026-06-28-dream-loop-reflection-sparsity-and-window]] (research — root-cause: fixed 24h window + hardcoded `HDBSCAN(min_cluster_size=5)` ⇒ 0 clusters/day)
- builds_on:: [[2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop]] (plan — original `--since 24h` daily-clustering design intent)
- builds_on:: [[2026-05-12-group-GH-1203-1207-memory-tier-productization]] (plan — 4-tier system + role retrieval; OOM-hardened reindex)
- builds_on:: [[2026-05-06-personal-wiki-curator-design]] (research — wiki tier needs ~150 reflections before useful)
- tensions:: [[2026-05-10-vertex-memory-bank-ralph-hero-integration]] (research — external managed-backend alternative)
- informed_by:: web research 2026-06-28 (workflow `wf_95825728-57d`, 6 legs + synthesis) — Generative Agents (Park 2023), mem0, Zep/Graphiti, MemGPT/Letta, Cognee, LangMem, Vertex/Bedrock/Azure memory, GBrain, and clustering-for-sparse-streams literature.

## The decision (what this plan commits to)

**Keep the stack; fix the pipeline. Do not pivot to GBrain.** Borrow proven idioms in-place.

Three independent research legs converged on the same conclusion: the "0 reflections/day"
defect is a **triggering + clustering calibration bug in the pipeline**, not a storage problem.
Every surveyed system — including GBrain — locates the fix in the consolidation logic, so a
backend swap does not fix it.

### GBrain verdict: No (borrow, don't adopt)

GBrain (garrytan/gbrain) is a knowledge-graph-first MCP memory server (PGLite/Postgres + pgvector,
hybrid vector+BM25+typed-graph retrieval, 30+ MCP tools). It is genuinely impressive, **but it does
not solve our problem**:

- **No automatic cluster-based reflection.** Its "dream cycle" Synthesize/Patterns/Consolidate
  phases are *operator-authored skill invocations gated by a whole-brain health score* — not
  unsupervised synthesis over a raw-memory stream. There is no "N new raw memories since last
  reflection" trigger. The 0-reflections defect would **survive the pivot**.
- **Wrong shape for a sparse single-source stream.** Its value mechanism is mention-count tier
  escalation (3 cross-source mentions → Tier 2, 8 → Tier 1). On ~7–10 memories/day from one source
  (Claude Code), nearly everything stays permanently at stub tier.
- **High cost, lost properties.** Postgres (vs SQLite), an external embedding API (vs our fully-local
  zero-cost ONNX all-MiniLM), a TypeScript/PLpgSQL rewrite of `ingest.py`/`reflect.py`, and loss of
  role-based tier-mixing retrieval and the persisted reflection/wiki tiers (GBrain has neither).

**What to borrow from GBrain (in-place):** SHA-256 content-hash dedup at ingest; recurrence/count
triggering as a complement to clustering; query-time synthesis with explicit gap reporting
(`gbrain think` → a local `ralph think` tool). These are folded into the phases below.

### Chosen path: Hybrid, sequenced

Ship **Keep-and-fix** first (the core defect), then add **two** selectively-borrowed capabilities.
Defer any graph-retrieval (Graphiti) evaluation until entity density justifies it.

| Option | Verdict | Why |
|---|---|---|
| **Keep-and-fix** (rewrite triggering+clustering in `reflect.py`/`ingest.py`) | **Adopt — Phases 0–3** | Directly removes the 3 fatal mechanics; M effort; stays fully local |
| **Pivot to GBrain** | **Reject** | XL effort, doesn't fix the defect, loses local embeddings + tiers |
| **Hybrid extras** (`ralph think` tool; weekly meta-reflection) | **Adopt — Phases 4–5, gated** | Closes the 2 capability gaps research flagged as genuinely valuable |

## Principles we are currently violating (SOTA → our gap)

The dream-loop violates the consolidation principles that every surveyed system shares. Each maps
to a concrete change below.

1. **Trigger on accumulated signal, not the clock.** Generative Agents fires when cumulative
   importance crosses a threshold over the last *N records regardless of age*; we reset a fixed 24h
   window nightly (`--since 24h`). → **Phase 1 (trigger) + Phase 2 (importance)**
2. **Never hard-skip on raw count.** mem0/LangMem/Letta/Cognee process whatever arrives; we abort the
   whole run at `reflect.py:307` (`if len(memories) < 6`). → **Phase 1**
3. **Don't use density clustering on tiny diverse batches.** HDBSCAN(min_cluster_size=5) needs
   N ≈ 10–20× that to fire and was worst-in-class on text-embedding benchmarks; we hardcode it at
   `reflect.py:338`. → **Phase 1 (agglomerative / LLM-as-clusterer)**
4. **Expose thresholds as configuration.** We hardcode every knob. → **Phase 0 + Phase 1**
5. **Decouple ingest cadence from reflection cadence; accumulate across runs.** We tie reflection to
   a 24h slice with no rolling accumulation. → **Phase 1 (candidate query by `reflected_at IS NULL`)**
6. **Make consolidation idempotent (already-processed marker / content hash).** We have a per-cluster
   sha256 slug (`reflect.py:472`) but no `reflected_at` marker, so a wide re-reflect duplicates.
   → **Phase 0 (`reflected_at` column) + Phase 2 (ingest content-hash)**
7. **Provide a degenerate fallback so sparse runs still produce output.** We emit zero. → **Phase 1**
8. **Build a multi-level hierarchy on a longer cadence to seed the top tier.** We are single-level
   (raw→reflection), so wiki can never be auto-seeded — the catch-22. → **Phase 5**

## Current code (anchors for the edits)

- `scripts/dream/reflect.py:214` — `fetch_recent_raw_memories(db_path, since)`: `WHERE memory_tier='raw' AND date >= ?`, no `reflected_at` filter.
- `scripts/dream/reflect.py:293` — `cluster_memories()`: UMAP → HDBSCAN.
- `scripts/dream/reflect.py:307` — hard skip `if len(memories) < 6`.
- `scripts/dream/reflect.py:338-339` — `HDBSCAN(min_cluster_size=5, min_samples=3)` literals.
- `scripts/dream/reflect.py:472`, `:783` — per-cluster sha256 slug.
- `scripts/dream/reflect.py:832` — `write_reflection()`.
- `scripts/dream/reflect.py` `--since` default `24h`; `ingest.py` `--since` default `24h`.
- `model-gate/bin/dream-now:40-42` — hardcoded `--since 24h` for both scripts.
- `scripts/dream/config.yaml` — sources + `reindex_cmd`.
- Tests: `scripts/dream/tests/test_reflect.py`, `test_ingest.py`, `conftest.py`.

## Implementation phases

> Cadence stays nightly via launchd. The change is that triggering becomes accumulation-gated and
> clustering can no longer return zero on a non-empty batch. Each phase is independently testable
> against the existing pytest suite.

### Phase 0 — Schema + config scaffolding (idempotency primitive)

**Files:** `reflect.py` (or a small `db_migrate` helper), `config.yaml`, `tests/test_reflect.py`

1. Add a `reflected_at TIMESTAMP NULL` column to the `documents` table (additive migration; guard
   with `ALTER TABLE ... ADD COLUMN` wrapped in a try/except on "duplicate column"). This is the
   idempotency marker (Zep/Cognee/GBrain pattern).
2. Introduce env/CLI knobs with `config.yaml` defaults (env overrides CLI overrides config):
   - `RALPH_DREAM_WINDOW_DAYS` (default **30**) — outer bound on the candidate query.
   - `RALPH_DREAM_MIN_UNREFLECTED` (default **15**) — below this, defer-and-exit-clean.
   - `RALPH_DREAM_CLUSTER_THRESHOLD` (default **0.40**) — cosine *distance* for agglomerative.
   - `RALPH_DREAM_MIN_CLUSTER_SIZE` (default **2**), `RALPH_DREAM_MIN_SAMPLES` (default **1**).
   - `RALPH_DREAM_IMPORTANCE_TRIGGER` (default **40**), `RALPH_DREAM_COUNT_TRIGGER` (default **20**).

**Verify:** migration is idempotent (run twice, no error); knobs resolve in precedence order; a
unit test asserts defaults match `config.yaml`.

### Phase 1 — Triggering & clustering rewrite (`reflect.py`)

This is the core fix. All four sub-changes land together.

1. **Candidate query → unreflected, not 24h window.** Change `fetch_recent_raw_memories` to
   `WHERE memory_tier='raw' AND reflected_at IS NULL AND date >= (now − RALPH_DREAM_WINDOW_DAYS)`.
   Spans quiet periods automatically (Park's count-based pool, adapted).
2. **Remove the hard `<6` skip; replace with size-dispatch** (`reflect.py:307`):
   - `N < RALPH_DREAM_MIN_UNREFLECTED` → defer, exit clean (nothing to do yet — not a failure).
   - `MIN_UNREFLECTED ≤ N < 30` → **LLM-as-clusterer**: one grouping prompt to the local gate model
     ("group these N memories into coherent themes; return JSON groups"). Degrades to N=2.
   - `N ≥ 30` → **algorithmic clustering** (next item).
3. **Swap default clusterer to agglomerative** (`reflect.py:293,338`):
   `sklearn.cluster.AgglomerativeClustering(metric='cosine', linkage='average',
   distance_threshold=RALPH_DREAM_CLUSTER_THRESHOLD, n_clusters=None)`. No `min_cluster_size`; works
   at N=2. Keep HDBSCAN only as an opt-in `N ≥ 200` path with
   `(min_cluster_size=2, min_samples=1, cluster_selection_method='leaf')` and UMAP `n_neighbors`
   capped at `min(5, N//3)`.
4. **Degenerate fallback.** If clustering yields 0 groups on a non-empty batch, synthesize one
   "miscellaneous activity" reflection over the whole batch rather than emitting nothing (mark it so
   it can be expired/down-weighted — see Open Questions).
5. **Idempotency on write.** In the same SQLite transaction as the reflection `INSERT`, set
   `reflected_at = now` on every contributing raw doc id. Re-runs and overlapping windows then skip
   already-reflected raws. (Decide interaction with the existing per-cluster sha256 slug — see Open
   Questions; the `reflected_at` marker is the primary mechanism, slug stays for filename stability.)

**Verify:** new `test_reflect.py` cases — (a) N=2 produces ≥1 group via agglomerative; (b) N=20 hits
LLM-as-clusterer path (mock the LLM); (c) 0-cluster input yields the misc fallback; (d) re-running
over the same raws produces no new reflections (all `reflected_at` set). Run the full `uv run pytest`
suite.

### Phase 2 — Ingest-side importance scoring + content-hash dedup (`ingest.py`)

1. **Cumulative importance scoring at ingest** (cheapest gate is at write time; Park's trigger
   adapted to our volume). Lightweight heuristic, **no LLM call**: e.g. git commit = 2, Claude
   session = 3, llm log = 1; bump for keywords (decision/chose/switched +2, error/exception +2).
   Persist per-doc importance + maintain a running unreflected sum.
2. **Trigger gate.** `dream-now` (or `reflect.py` on entry) fires the reflection pass when
   `cumulative_unreflected_importance > RALPH_DREAM_IMPORTANCE_TRIGGER`
   **OR** `unreflected_count > RALPH_DREAM_COUNT_TRIGGER`, whichever first. Self-calibrates cadence to
   signal density instead of the clock. (Launchd still wakes nightly; the gate decides whether to
   synthesize.)
3. **SHA-256 content-hash dedup at ingest** (GBrain/Cognee idiom). Before inserting a raw doc, check
   the raw tier for a content-hash match; skip identical re-emits. Makes re-running `ingest.py` over
   an overlapping/wider window safe (enables rolling accumulation without duplicate explosion).

**Verify:** `test_ingest.py` — re-running ingest over the same window inserts 0 new raws (hash
dedup); importance sum accumulates and resets after a reflection run; trigger fires at threshold.

### Phase 3 — One-time backfill (break the wiki-starvation catch-22)

1. Run a one-shot backfill over the ~900-doc raw backlog in **90-day agglomerative batches** to seed
   ~50+ reflections immediately. (The 180d manual re-reflect already done this session got us to
   reflection tier = 84; this phase is the *repeatable, idempotent* version using `reflected_at` so
   it won't duplicate.)
2. Because Phase 1 sets `reflected_at`, the backfill is naturally idempotent and re-runnable.

**Verify:** reflection-tier count jumps and stops growing on a second run (idempotent); spot-check 5
reflections for coherence; confirm reindex lands them (`memory_tier='reflection'` count in the DB).

### Phase 4 — `ralph think` query-time synthesis MCP tool (borrowed from GBrain) — *gated: ship after Phases 0–3 verified*

A new MCP tool in `plugin/ralph-knowledge`: retrieve top-K raws/reflections for a query, ask the
local LLM to synthesize a **cited** answer **with explicit gap reporting** ("what the bank does NOT
know"). Bridges usefulness for the planner/researcher roles *before* the reflection tier is fully
populated; decouples user value from pipeline backlog. Prompt must be designed to not duplicate
role-based retrieval (see Open Questions).

**Verify:** tool returns cited synthesis + a gaps section; integration test against a seeded test DB.

### Phase 5 — Weekly reflection→wiki-candidate meta-reflection — *gated: only once reflection tier > ~50*

TiMem-style second cadence (the missing hierarchy level). A weekly job synthesizes recent
*reflections* (not raws) into higher-order wiki **candidates** ("3 most salient patterns in your
work"). Output is staged as wiki *candidates* for the human-gated `/ralph-knowledge:curate` skill —
**never auto-written to the wiki tier** (preserves the human gate). This is what finally seeds the
wiki tier and resolves the catch-22.

**Verify:** weekly job produces N candidates from the reflection tier; candidates surface in
`curate`; nothing lands in `wiki` without human action.

## Out of scope / deferred

- **GBrain / Zep pivot** — rejected (see verdict). Re-evaluate only if the corpus becomes
  entity-dense (people/companies/meetings) rather than episodic.
- **Graphiti (open-source library) layered over the store** for graph retrieval — optional future
  upgrade, deferred until entity density justifies it.
- **Park-style 3-signal retrieval scoring** (recency × importance × relevance) in `knowledge_recall`
  — valuable but separable; track as a follow-up, not in this plan.
- **LLM-based importance scoring** — Phase 2 uses a regex/keyword heuristic; reserve LLM rating for
  long memories only if the heuristic proves too coarse.

## Open questions (resolve during implementation / tuning)

1. **Importance threshold + heuristic weights** for this specific single-user stream — Park's 150 was
   for a 25-agent sim; our `>40 / >20` defaults are educated guesses needing empirical calibration.
2. **Cosine `distance_threshold`** that maximizes cluster quality on our topically-diverse all-MiniLM
   embeddings — literature suggests 0.35–0.45 for diverse streams; measure against the real ~900-doc
   corpus.
3. **LLM-as-clusterer quality** at N=15–30 with the local gate model (qwen3.6-27b) — zero-shot good
   enough, or few-shot examples needed?
4. **Does the misc-activity fallback** add signal or noise? It guarantees non-zero output but may
   pollute retrieval — needs a quality gate or an expire/down-weight marker.
5. **`reflected_at` vs the existing per-cluster sha256 slug** (`reflect.py:472`) — avoid two competing
   idempotency mechanisms; define which is authoritative (proposal: `reflected_at` is authoritative
   for "don't re-synthesize"; slug stays only for filename stability).
6. **Wiki's ~150-reflection prerequisite** — hard requirement or estimate? At what reflection-tier
   size does `curate` start surfacing genuinely promotable axioms?

## Suggested issue breakdown (if formed into GH issues)

- **GH-A (M):** Phase 0+1+2 — triggering & clustering rewrite + ingest importance/dedup (the core fix).
- **GH-B (S):** Phase 3 — idempotent backfill script.
- **GH-C (M):** Phase 4 — `ralph think` MCP tool.
- **GH-D (M):** Phase 5 — weekly meta-reflection → wiki candidates.

GH-A is the critical path; B depends on A; C and D are independent and gated on A landing.

## Resolved during implementation (GH-1510, Phase 0+1+2 — landed)

Decisions taken while implementing the core fix; deviations from the plan-as-written
are deliberate and noted with rationale.

1. **Idempotency = reflection `source_ids` ledger, NOT a `reflected_at` DB column
   (resolves OQ#5).** The markdown files are the source of truth; the SQLite DB is a
   derived index (reindex.ts upserts by id, full-wipes on rebuild). A DB-only
   `reflected_at` column would be lost on rebuild and would need three cross-language
   edits (createSchema, the `documents_v4` migration's INSERT…SELECT, upsertDocument).
   Instead `already_reflected_ids()` derives the "already synthesized" set from every
   reflection file's `source_ids:` frontmatter — DB-rebuild-proof, keeps `reflect.py`
   read-only on the DB, single authoritative mechanism. The per-cluster sha256 slug
   stays only for filename stability.
2. **Window widening instead of editing model-gate `dream-now`.** `reflect.py` computes
   `effective_since = earliest(--since, now − window_days)` — it always looks back ≥
   `window_days`. So `dream-now`'s hardcoded `--since 24h` auto-widens to 30d with **no
   cross-repo edit**; an explicit wider `--since` (backfill) is still honored.
3. **Importance computed at reflect-time, not stamped at ingest.** The derive-from-
   source_ids design removes the need for a persisted running importance sum, so the
   gate recomputes cumulative importance over the candidate set each run via a shared
   pure `importance_score(source, content)`. (Phase 2 still ships content-hash dedup at
   ingest: `dedup_memories()` + `content_sha256()`.)
4. **Config precedence = env > config.yaml(`reflection:`) > default** (no per-knob CLI
   flags — nine flags would be noise; env is the operational override).
5. **`cluster_threshold` 0.40 kept (resolves OQ#2).** Measured against the live ~53-
   candidate corpus: 0.40 keeps the two real multi-session themes sharp; ≥0.65
   over-merges 47–52/53 into one giant cluster. Knob is configurable for future tuning.
6. **Singleton coalescing (new, real-data tuning; OQ#4-adjacent).** A diverse stream
   leaves many lone sessions as size-1 clusters at any sane threshold; each raw session
   is already a distilled summary, so `_coalesce_singletons()` merges ≥2 singletons into
   one "assorted" reflection (marks their ids → no churn) instead of flooding the tier.
   On live data: 53 candidates → 8 clean clusters (15/14/12/4/2/2/2/2), 0 singletons,
   where the old pipeline produced **0** reflections.
7. **Degenerate fallback shipped (principle 7); explicit expire/down-weight marker for
   the misc/assorted tier deferred** (OQ#4 — still a tuning follow-up).
8. **`scikit-learn` added as a direct dependency** (was transitive via umap-learn).

## Hardened after independent review (post-merge audit of GH-1509)

An independent multi-agent audit (5 reviewers, one per PR + an epic-coherence
pass) graded the shipped code against this plan. Verdict: epic COHERENT, all 3
fatal mechanics removed, all 8 principles addressed, no GBrain pivot. It found
two completeness gaps in the load-bearing `source_ids` idempotency ledger
(principle 6) that could break the "re-run produces no new reflections" verify
criterion; both fixed under GH-1510:

9. **`source_ids` ledger is now authoritative = cluster membership** (was: the
   LLM's echoed list, with a fallback only when that list was *entirely*
   empty). A subset echo leaked the dropped raws back into the next run
   (duplicate reflections); a hallucinated id would mark an unrelated raw as
   reflected (silent loss). `synthesize_reflection` now records
   `[m.id for m in cluster]` and logs any LLM/cluster mismatch.
10. **HDBSCAN noise points are captured, not dropped** (the N≥`hdbscan_min`
    path). `_group_labels_with_noise()` emits each `-1` point as a singleton so
    `_coalesce_singletons` folds them in and every id is marked — without this
    the Phase 3 backfill of the ~900-doc backlog (which hits the ≥200 buckets)
    was not single-run idempotent. The `think()` MCP tool (Phase 4) was also
    made self-contained fail-open against a *throwing* completion fn.
