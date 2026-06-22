---
date: 2026-06-21
researcher: Claude (Opus 4.8)
topic: "Dream-loop activity paths — ingestion sources and reflection synthesis"
tags: [dream-loop, ralph-knowledge, ingest, reflect, memory-tier]
status: complete
git_commit: 750cde13d9fe028fbd6df4afe3a032cd6c694005
branch: main
last_updated: 2026-06-21
---

# Dream-loop activity paths

## Research question

How is raw activity discovered and ingested into the ralph-knowledge store, why
are two configured sources (gemma-lab, `~/.llm/logs.db`) producing nothing, and
why does the `reflection` tier appear sparse in `knowledge.db` while raw ingest
runs nightly?

## Summary / TL;DR

- The nightly loop is **healthy**. The 6/21 03:00 launchd run ingested 45 Claude
  Code sessions, clustered into 4 groups, and wrote 4 reflections (all LLM calls
  `200 OK`). "Stalled since 6/19" was a DB-query artifact, not reality.
- Of 4 configured ingest sources, only **claude-code + git-commit** flow through
  `ingest.py`, plus **agent-recorded** memories written out-of-band. **gemma-lab**
  and **llm-cli** produce zero because their *source data does not exist* on this
  machine — not a code bug. Each source fails open (`[]` + one info log).
- Two real defects found: (1) the **reflection tier lags one nightly cycle** in
  `knowledge.db` because reindex runs before reflect writes; (2) **slug collisions
  overwrite reflections** — the 6/19 run wrote 21 but ~10 unique survived.
- One risk: the gate warns qwen3.6-27b-8bit projects ~118% RAM (≈75.7 GB on 64 GB)
  at launch; it served fine but the gate itself flags Apple-Silicon panic risk.

## Detailed findings

### Source 1 — Claude Code sessions (the workhorse)

`ingest_claude_code_sessions` (`scripts/dream/ingest.py:650`) globs
`~/.claude/projects/*/*.jsonl` — depth-2, which intentionally excludes sub-agent
transcripts that live deeper. File mtime is a cheap pre-filter; the session-end
timestamp inside the transcript decides inclusion. `_distill_claude_session`
(`ingest.py:518`) keeps human prompts + the final assistant message, drops all
tool I/O and sidechain traffic, scrubs secrets (`ingest.py:471`), dedups repeated
loop-wakeup prompts, and skips sessions under 200 chars. 329 ingested total, 45
on the 6/21 run.

### Source 2 — git commits

`ingest_git_commits` (`ingest.py:305`) runs `git log --since=<iso> --patch -n 50`
across the 3 repos in `config.yaml` (ralph-hero, ralph-engine, gemma-lab), patch
clipped to `GIT_PATCH_CHAR_LIMIT = 4000`. 246 total; 0 on the 6/21 run simply
because no commits fell in the 24h window.

### Source 3 — agent-recorded memories (out-of-band)

Not produced by `ingest.py`. The `knowledge_remember` MCP tool and the
`remember-turn.sh` Stop hook write per-turn agent memories to
`<base_dir>/agent/YYYY/MM/DD/` with `memory_tier: raw` (documented at
`ingest.py:22-38`). The reindexer walks `base_dir` recursively, so they are
indexed without any ingest code path. 303 total.

### Source 4 — gemma-lab (0, expected)

`ingest_gemma_lab_sessions` (`ingest.py:231`) globs `sessions/*.jsonl`, expects
`ts`/`prompt`/`response` per line, and filters `ts >= since`. The directory holds
only `2026-04-13.jsonl` (far outside any 24h window) plus a
`2026-04-13.broken-pretty.bak` — someone pretty-printed the JSONL, which would
break line-delimited parsing if it were re-activated. No recent lab activity ⇒
nothing to ingest. Not a bug.

### Source 5 — llm-cli (0, expected)

`ingest_llm_cli_logs` (`ingest.py:411`) reads the `responses` table of
`~/.llm/logs.db` where `datetime_utc >= since`. The file does not exist
(`llm-cli log not found at /Users/dubiel/.llm/logs.db; skipping source`, observed
in the 6/21 launchd stderr). simonw/llm isn't installed. Silent skip by design.

### Reflection synthesis path

`reflect.py` `fetch_recent_raw_memories` (`reflect.py:214`) reads
`memory_tier='raw'` rows with `date >= since` from `knowledge.db`, mean-pools
chunk embeddings per doc. `cluster_memories` (`reflect.py:293`) needs ≥6 memories,
reduces with UMAP (`n_components=50`) and clusters with HDBSCAN
(`min_cluster_size=5, min_samples=3`), discarding noise (label -1). Each cluster
goes to the local LLM at `http://localhost:8000` (`synthesize_reflection`,
`reflect.py:661`); failures fail open (skip cluster). Output:
`<base_dir>/reflections/YYYY/MM/DD/<slug>.md`.

Evidence the path works (6/21 launchd stderr): "Loaded 56 raw memories" → "Found
4 clusters" → 4× `POST /v1/chat/completions 200 OK` → 4 reflections written.

### Wrapper + schedule

`model-gate/bin/dream-now` resolves the model (`RALPH_DREAM_MODEL` →
`models.yml` `defaults.dream_model` = qwen3.6-27b-8bit), runs `model-up`, then
`ingest.py --since 24h`, `reflect.py --since 24h --model <served_id>`,
`logrotate.sh`. `set -euo pipefail` means a `model-up` failure aborts before
ingest — but ingest runs nightly, confirming the model loads. launchd job
`com.dubiel.dream-loop` is installed (`~/Library/LaunchAgents/`), fires daily at
03:00, last exit status `0`.

## Defects found

### Bug 1 — reflection tier lags one nightly cycle in the DB

`dream-now` order is `ingest → reindex (inside ingest.py:903) → reflect`.
`reflect.py` writes reflection `.md` files *after* that reindex. Reflections
written at ~03:05 are not indexed into `knowledge.db` until the *next* night's
03:00 ingest reindex. Consequence: a fresh reflection is invisible to
`knowledge_search` for ~24h, and a point-in-time DB query understates the true
reflection count (6/21 files exist on disk but DB max date was 6/19 at query
time). Fix direction: run a reindex pass after `reflect.py` in `dream-now` (or
have `reflect.py` incrementally index its own output).

### Bug 2 — slug collisions overwrite reflections

`write_reflection` (`reflect.py:814`) names files `<slugify(title)>.md` with no
uniqueness suffix. The 6/19 run logged "Wrote 21 reflection(s)" but the paths
repeat — `lakehouse-silver-layer-modeling-strategy.md` ×4,
`structuring-kafka-vs-postgres-argument.md` ×3, etc. Same-theme clusters in one
run clobber each other; ~21 written collapse to ~10 unique files. Genuine data
loss. Fix direction: add a short content/cluster hash suffix to the slug.

## Risk flag

6/21 launchd stderr: the gate warned qwen3.6-27b-8bit projects a ~48.5 GB working
set + 27.2 GB OS = ~118% of 64 GB RAM, with an explicit Apple-Silicon panic
caution. It launched and served correctly this run, but nightly headroom is thin.

## Files referenced

- `scripts/dream/ingest.py` — 4-source ingester + reindex shell-out
- `scripts/dream/reflect.py` — cluster + synthesize + process-improvement emitter
- `scripts/dream/config.yaml` — source paths
- `model-gate/bin/dream-now` — gate-aware wrapper
- `model-gate/launchd/com.dubiel.dream-loop.plist.template` — nightly schedule
- `~/Library/Logs/ralph-dream-loop.{out,err}` — run evidence
