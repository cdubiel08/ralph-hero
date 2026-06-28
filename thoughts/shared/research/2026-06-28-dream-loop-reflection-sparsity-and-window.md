---
date: 2026-06-28
topic: "Why the dream-loop reflection stage produces 0 clusters/0 reflections day-to-day, and whether to re-reflect the accumulated raw corpus over a wider window"
tags: [research, ralph-knowledge, dream-loop, reflection, clustering, memory-tier]
status: complete
type: research
---

# Research: Dream-loop reflection sparsity — daily clustering yields 0 reflections

## Prior Work

- builds_on:: [[2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop]] (plan — original dream-loop design; specced `--since 24h` daily clustering)
- builds_on:: [[2026-05-12-group-GH-1203-1207-memory-tier-productization]] (plan — productized the 4-tier system + role retrieval; OOM-hardened reindex)
- builds_on:: [[2026-04-26-dreaming-research-trail-and-self-containment]] (research — audit that found the April parser/OOM/silent-failure bugs)
- builds_on:: [[2026-06-21-dream-loop-activity-paths]] (research — most recent; found reflection tier lags one cycle + slug-collision overwrites)
- builds_on:: [[2026-05-06-personal-wiki-curator-design]] (research — wiki tier needs ~150 reflections before useful)
- tensions:: [[2026-05-10-vertex-memory-bank-ralph-hero-integration]] (research — external Memory Bank backend as an alternative consolidation engine)

## Research Question

(verbatim) "this seems like we'll never get anything useful if we never ingest anything; surely there must be interested memory from day-to-day; then memories should be re-ingested please /ralph:research this and how the code works -- also find docs related to memory bank and how knowledge bank works"

## Summary

The dream-loop's reflection stage runs successfully every night (last end-to-end run 2026-06-28 03:16, launchd exit 0) but has written **0 reflections since 2026-06-22**. This is **not a failure** — it is a structural consequence of clustering a single 24-hour window of a thin, topically diverse activity stream against a hardcoded threshold.

Root cause, in two parts:
1. **Hardcoded clustering threshold with no override.** `cluster_memories()` hardcodes `HDBSCAN(min_cluster_size=5, min_samples=3)` and hard-skips when fewer than 6 raw memories are in the window. There is no env var or CLI flag to lower these.
2. **A 24h window is too small/too diverse to clear the bar.** `dream-now` passes a fixed `--since 24h`. On this machine ingest pulls ~7–10 raw memories/day, **all from claude-code** (gemma-lab/git/llm-cli sources are empty). HDBSCAN needs ≥5 *mutually-similar* points to form one cluster; a day of diverse sessions yields all-noise → 0 clusters.

This was the original design intent (GH-0761: daily clustering; weekly questions answered by searching *across* daily reflections; reflection-of-reflections explicitly deferred), so it was never treated as a defect. But on a low-activity, single-source corpus the daily window essentially never fires.

The user's instinct is correct, with one clarification: the fix is **re-reflect over a wider window**, not "re-ingest." The 878 raw memories are already in the DB; `reflect.py` filters `memory_tier='raw' AND date >= since` with no dedup against existing reflections, so re-running with `--since 180d` re-clusters the whole back-catalog without re-ingesting anything.

Downstream consequence: the `reflection` tier (35 rows) starves the `wiki` tier (11 rows), which by its own curator design needs ~150 reflections before it's useful. The stalled reflect stage is the bottleneck for the entire knowledge bank.

## Detailed Findings

### Clustering logic — `reflect.py`
- `cluster_memories()` — `scripts/dream/reflect.py:293-352`. UMAP (`n_neighbors=min(15, n-1)`, `min_dist=0.1`, `n_components=min(50, max(n-2,2))`, `random_state=42`) → `HDBSCAN(min_cluster_size=5, min_samples=3)` → drop noise (label `-1`).
- **Hard guard:** `if len(memories) < 6: return []` (`reflect.py:307-313`) — a quiet day silently produces nothing (log INFO only).
- **No knob:** `min_cluster_size`/`min_samples` are literals (`reflect.py:337-339`); confirmed by grep there is no env var or CLI flag. `RALPH_DREAM_PROCESS_IMPROVEMENT_MIN_CLUSTER` (`reflect.py:76-85`) is a *separate* constant gating GitHub-issue emission, not HDBSCAN.

### The time window — `dream-now` and `--since`
- `dream-now` passes a **hardcoded** `--since 24h` to both scripts (`model-gate/bin/dream-now:40-42`): `uv run ingest.py --since 24h` and `uv run reflect.py --since 24h --model "$served_id"`.
- **No cursor/state file** anywhere — neither dream-now, ingest.py, nor reflect.py persists a last-run timestamp. `_parse_since("24h")` (`reflect.py:928-956`) = `now(UTC) - 24h` at script start. (The log line "Reflecting since 2026-06-27T08:16" for an 03:16-local run is exactly 24h back in UTC; Houston is UTC−5. Earlier session note of "~19h incremental" was wrong — it's a clean fixed 24h window.)
- argparse default is `"24h"` in both `reflect.py:991` and `ingest.py:796`.

### Re-reflect path over the existing corpus
- `fetch_recent_raw_memories(db_path, since)` — `reflect.py:215-285`: `SELECT ... WHERE d.memory_tier='raw' AND d.date >= ?`. **No cross-check** against existing `reflection` rows — no dedup/seen logic.
- `write_reflection()` — `reflect.py:832-865`: filename from `_slug_suffix(source_ids)` = SHA-256 of sorted member ids, truncated to 8 chars. Same cluster membership → same path (overwrite). But HDBSCAN is **non-deterministic across overlapping windows**, so re-runs mint *new* slug filenames for differently-assembled clusters and **do not clean up** prior reflection files.
- Re-running is therefore safe (no data loss to raw tier) but additive — it can leave stale/duplicate reflection files.

### Ingest is windowed + idempotent (why "re-ingest" adds nothing here)
- `ingest.py` has no cursor; `since = parse_since(args.since)` filters each source (`ingest.py:843`+). Sources: gemma-lab JSONL (`:232`), `git log --since` (`:306`), llm-cli sqlite (`:412`), claude-code transcripts by mtime (`:651`).
- `write_memory()` (`ingest.py:212-223`) is idempotent: filename = hash of `(source, source_id)`, deterministic body. A wider `--since` re-emits byte-identical files; the reindexer's mtime check then skips them. On this machine only claude-code yields memories (gemma-lab/git/llm-cli empty per the nightly logs).

### Prior bugs already fixed (context)
- **Parser dropped `memory_tier`** → everything defaulted to `doc`, 0 raw (audit: `2026-04-26-dreaming-research-trail-and-self-containment.md`; fixed by GH-1203, `plugin/ralph-knowledge/src/parser.ts:130-144`).
- **Slug collisions overwrote ~50% of reflections** + reflection tier lags one nightly cycle (research: `2026-06-21-dream-loop-activity-paths.md`; fixed GH-1504/1505).
- **Reindex OOM** → batched `embedChunks()` (`EMBED_BATCH_SIZE=4`), `--max-old-space-size=4096 --expose-gc` (GH-1203 / GH-910).

## Code References
- `scripts/dream/reflect.py:293-352` — `cluster_memories()` UMAP→HDBSCAN, hardcoded params
- `scripts/dream/reflect.py:307-313` — `n < 6` short-circuit guard
- `scripts/dream/reflect.py:337-339` — `HDBSCAN(min_cluster_size=5, min_samples=3)` literals (no override)
- `scripts/dream/reflect.py:215-285` — `fetch_recent_raw_memories()`; no reflection dedup
- `scripts/dream/reflect.py:832-865` — `write_reflection()` slug = SHA-256(source_ids)
- `scripts/dream/reflect.py:928-956`, `:991` — `_parse_since`, `--since` default `24h`
- `scripts/dream/ingest.py:212-223`, `:796`, `:843` — idempotent `write_memory`, `--since` default, windowed main
- `model-gate/bin/dream-now:40-42` — hardcoded `--since 24h` for both scripts
- `scripts/dream/config.yaml` — sources + `reindex_cmd`

## Architecture Documentation

The knowledge bank ("memory bank") is a **4-tier** system over one SQLite + sqlite-vec store (embeddings: `Xenova/all-MiniLM-L6-v2`, 384-dim, fixed/shared across ralph-knowledge and ralph-engine):
- `doc` (curated markdown under the configured roots — 1,523 rows),
- `raw` (dream-ingest activity — 878 rows),
- `reflection` (synthesized per cluster — 35 rows),
- `wiki` (manually curated, human-gated via `/ralph-knowledge:curate`; not writable by `knowledge_remember`, which accepts only `raw`/`doc` — 11 rows).

**Role-based retrieval** (`knowledge_recall`) is a policy wrapper selecting a tier mix: researcher=`[raw,reflection,doc]`, planner=`[reflection,wiki,doc]`, implementer=`[wiki,doc]`, reviewer=`[wiki,doc]`, triager=`[doc,wiki]`. Note three of five roles weight `reflection`/`wiki` heavily — the tiers most starved by the stalled reflect stage.

The pipeline: nightly launchd (03:00) → `dream-now` → `ingest.py` (writes raw + triggers incremental `reindex`) → `reflect.py` (clusters last 24h raw → writes reflection markdown, re-indexed next cycle). Reflection-of-reflections (higher-order consolidation) is explicit future work ("What We're NOT Doing", GH-0761).

## Historical Context (from thoughts/)
- GH-0761 (2026-04-16) — design intent: `--since 24h` daily clustering; weekly retrieval = search across daily reflections, **not** a wider clustering window. No threshold-tuning guidance for larger N.
- GH-1203-1207 (2026-05-12) — productization; confirms tiers/roles; verification expects non-zero `reflection` count "after dream-now on a live corpus," not on a thin daily stream.
- 2026-05-06 personal-wiki-curator — wiki needs ~150 reflections before useful → current reflection rate cannot feed it.
- 2026-05-10 Vertex Memory Bank — external consolidation backend evaluated as additive alternative.

## Related Research
- `2026-04-26-dreaming-research-trail-and-self-containment.md`
- `2026-06-21-dream-loop-activity-paths.md`
- `2026-04-29-reindex-memory-profile.md`
- `2026-05-10-vertex-memory-bank-ralph-hero-integration.md`

## Recommendations

1. **Immediate (this session):** re-reflect the accumulated corpus — `reflect.py --since 180d` over the 878 raw memories — to backfill reflections now. (Caveats: needs `model-up qwen3.6-27b-8bit`; leaves prior reflection files in place; hardcoded params may over-merge at N≈878.)
2. **Make clustering configurable (follow-up issue):** add env/CLI overrides for `min_cluster_size`/`min_samples` (and ideally `n_neighbors`) so the window can be widened without code edits. Today these are hardcoded — the single biggest gap.
3. **Widen / decouple the cadence:** either raise `dream-now`'s `--since` (e.g. a weekly rollup pass over 7d alongside the nightly 24h pass) or add a periodic "catch-up reflect" so accumulated raw memories get a second chance to cluster. Decoupling reflect from the 24h ingest window is the durable fix.
4. **Broaden sources:** gemma-lab/git/llm-cli ingest is empty on this machine; enabling git-commit ingest across the active repos would thicken the daily stream and make even the 24h window viable.

## Open Questions
- What cluster yield do different windows actually produce (7d vs 30d vs 180d) at the current hardcoded params? (Empirical — answered by the re-reflect run.)
- At N≈878, does `min_cluster_size=5` over-merge into a few giant clusters? May need params scaled to N.
- Should reflect dedup against already-reflected raw ids to make re-runs idempotent and self-cleaning?
