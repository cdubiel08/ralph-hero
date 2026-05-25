---
description: Run the dream-loop — the nightly memory-consolidation pipeline that ingests the last window of raw activity (Gemma lab logs, git history, llm-cli transcripts) as memory_tier=raw documents, then clusters them and synthesizes one memory_tier=reflection per cluster. This is the memorykeepers surface that orchestrates the existing scripts/dream/ infra (ingest.py + reflect.py + logrotate.sh) on demand. Use when the user mentions "dream", "dream-loop", "consolidate memories", "run reflection", "memorykeepers", "ingest raw memories", or wants to manually trigger the memory tiers (raw to reflection) without waiting for the 03:00 launchd fire. The launchd nightly schedule and the model-gate dream-now zsh function are separate; this skill is the in-session manual entrypoint.
argument-hint: "[--since 24h]"
---

# Dream-Loop — Memory Consolidation (memorykeepers)

The dream-loop is the memory-consolidation pipeline for ralph-knowledge. It pulls raw activity into `memory_tier=raw` documents, then clusters them (UMAP/HDBSCAN) and asks a local model to synthesize one `memory_tier=reflection` per cluster. This skill is the in-session manual entrypoint that the memorykeepers team owns.

## How you talk

You are a librarian. Cite the memory tier and the path for every operation. State promotion/synthesis decisions as facts, not recommendations, and always include the verification step that preceded the operation.

- **Bad:** "This reflection looks good enough to promote."
- **Good:** "Wrote `reflections/2026-05/cluster-7.md` (memory_tier=reflection). Verification: clustered from 3 raw sources under `dream-memories/2026/05/`, no contradictions found."

You refuse to:
- promote unverified reflections to the wiki tier (that is the human-gated `/ralph-knowledge:curate` surface, not this one)
- discard raw memories without an outcome record

## Prerequisites

1. **Dream scripts present.** The pipeline lives at the repo root in `scripts/dream/` (`ingest.py`, `reflect.py`, `logrotate.sh`). It is NOT bundled inside this plugin — this skill orchestrates the repo-root scripts.
2. **Python deps installed.** `cd <repo>/scripts/dream && uv sync` (one-time).
3. **`~/.ralph/knowledge.config.json` authored** with the `roots` to scan and `dbPath`.
4. **A local model reachable** at `RALPH_LLM_URL` (default `http://localhost:8000`) for the reflection synthesis step. If the model is unreachable, the pipeline fails open: empty reflections and a single stderr warning — raw ingest still succeeds.

If `scripts/dream/` is absent, surface a clear error and stop: the dream-loop infra has not been set up. Direct the user to `/ralph-knowledge:setup` (which installs the launchd schedule and can bootstrap the scripts).

## Workflow

### Step 1: Resolve the window

Parse `--since` from the arguments (default `24h`). This bounds how far back `ingest.py` pulls raw activity.

### Step 2: Locate the dream scripts

Find the repo root and confirm `scripts/dream/ingest.py` and `scripts/dream/reflect.py` exist. Cite the resolved path.

### Step 3: Ingest raw memories

```bash
cd <repo>/scripts/dream
uv run ingest.py --since <WINDOW>
```

`ingest.py` writes markdown under `memory_tier=raw` to `~/projects/thoughts/dream-memories/YYYY/MM/DD/`. Report the count of raw documents written and the path.

### Step 4: Synthesize reflections

```bash
uv run reflect.py --since <WINDOW>
```

`reflect.py` clusters the raw memories and writes `memory_tier=reflection` synthesis documents to `.../dream-memories/reflections/YYYY/MM/DD/`. If a local model id is known (e.g. via `RALPH_DREAM_MODEL`), pass it with `--model`. Report the number of clusters and reflections written, and each reflection path.

### Step 5: Rotate logs

```bash
./logrotate.sh
```

Caps the pipeline log files so repeated runs do not grow unbounded.

### Step 6: Report

State, as facts with paths and tiers:
- raw documents ingested (count + `dream-memories/YYYY/MM/DD/`)
- reflections synthesized (count + `reflections/YYYY/MM/DD/`)
- any clusters that crossed the recurring-failure thresholds and would warrant a `process-improvement` follow-up
- whether the local model was reachable, or whether the run failed open

## Relationship to other surfaces

- **Nightly schedule** — `scripts/dream/launchd/com.dubiel.dream-loop.plist.template`, installed by `/ralph-knowledge:setup` (or `bootstrap.sh`). Fires at 03:00 daily. This skill is the manual on-demand counterpart.
- **`dream-now`** — a model-gate zsh function that is gate-aware (loads the model first, then ingest + reflect + logrotate). Owned by model-gate, not this plugin. This skill does not call `dream-now`; it invokes the scripts directly.
- **`/ralph-knowledge:curate`** — the human-gated promotion of reflections into the personal wiki tier. The dream-loop produces reflections; curate (not this skill) decides what becomes canonical.
