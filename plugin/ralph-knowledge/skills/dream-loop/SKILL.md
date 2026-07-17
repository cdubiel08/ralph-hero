---
description: Run, bootstrap, or verify the dream-loop — the nightly memory-consolidation pipeline that ingests the last window of raw activity (Gemma lab logs, git history, llm-cli transcripts, Claude Code sessions) as memory_tier=raw documents, then clusters them and synthesizes one memory_tier=reflection per cluster. This is the memorykeepers surface that orchestrates the existing scripts/dream/ infra (ingest.py + reflect.py + logrotate.sh). Use when the user mentions "dream", "dream-loop", "dream-now", "consolidate memories", "run reflection", "memorykeepers", "ingest raw memories", or wants to manually trigger the memory tiers (raw to reflection) without waiting for the 03:00 launchd fire. Also use for machine wiring and health checks — "bootstrap the dream loop", "set up dream-loop", "install the nightly schedule", "check dream-loop status", "verify the dream loop ran", "did the dream loop ingest anything" — via --mode bootstrap and --mode verify.
argument-hint: "[--since 24h | --mode bootstrap|verify]"
---

# Dream-Loop — Memory Consolidation (memorykeepers)

The dream-loop is the memory-consolidation pipeline for ralph-knowledge. It pulls raw activity into `memory_tier=raw` documents, then clusters them (UMAP/HDBSCAN) and asks a local model to synthesize one `memory_tier=reflection` per cluster. This skill is the memorykeepers surface for the pipeline: a manual run entrypoint by default, plus `--mode bootstrap` (first-time machine wiring) and `--mode verify` (post-run health checks).

## Modes

| Mode | When | What it does |
|------|------|--------------|
| *(default)* run | "run the dream loop", "consolidate memories" | Steps 1–6 below: ingest → reflect → logrotate → report |
| `--mode bootstrap` | first run on a machine, "bootstrap the dream loop" | Delegates to `scripts/dream/bootstrap.sh`; see **Bootstrap** |
| `--mode verify` | "did it run?", "check dream-loop status" | Read-only health checks; see **Verify** |

Resolve the mode from intent, not just the flag — "set up the dream loop on this machine" is bootstrap, "did last night's run work?" is verify, even without `--mode`.

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

If any prerequisite is missing, that is a bootstrap problem, not a run problem — switch to **Bootstrap** below rather than surfacing a bare error.

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

## Bootstrap (`--mode bootstrap`)

`scripts/dream/bootstrap.sh` is the single source of truth for machine wiring — it idempotently provisions `~/.ralph/knowledge.config.json`, renders + loads the templated launchd plist for the 03:00 nightly fire, and smoke-tests ingest. Never re-implement its steps inline; when wiring logic changes, it changes in `bootstrap.sh`.

```bash
cd <repo>/scripts/dream && uv sync          # python deps (one-time)
cd <repo>/plugin/ralph-knowledge && npm install && npm run build   # indexer (one-time)
bash <repo>/scripts/dream/bootstrap.sh      # config + launchd + smoke ingest
```

After it completes, run the **Verify** checks to confirm the wiring took. `/ralph-knowledge:setup` Step 4 invokes the same script — either surface is fine; they cannot drift because both delegate.

**Machine conventions (optional):** if the machine has a model-gate checkout (`~/projects/model-gate`), prefer its surfaces for anything model-adjacent: `model-up <name>` to load the reflection model safely (stop-before-start on :8000), and the gate-aware `dream-now` zsh function as the shell-side equivalent of a full run. Registry of valid model names: `~/projects/models.yml`; setup details: `model-gate/README.md`. Absent model-gate, any OpenAI-compatible server at `RALPH_LLM_URL` works.

## Verify (`--mode verify`)

Read-only. Run what applies, report as facts with counts and paths:

```bash
# DB schema + tier breakdown
sqlite3 ~/.ralph-hero/knowledge.db "SELECT * FROM meta WHERE key='schema_version'"
sqlite3 ~/.ralph-hero/knowledge.db "SELECT memory_tier, COUNT(*) FROM documents GROUP BY memory_tier"

# Files on disk vs indexed (stale index if these diverge)
echo "On disk:  $(find ~/projects/thoughts/dream-memories -name '*.md' | wc -l)"
echo "Indexed:  $(sqlite3 ~/.ralph-hero/knowledge.db 'SELECT COUNT(*) FROM documents WHERE path LIKE "%dream-memories%"')"

# Local model reachability
curl -fsS http://localhost:8000/v1/models | jq '.data[].id'

# launchd nightly job (if installed): PID "-" when idle, exit status 0 after a clean run
launchctl list | grep dream-loop
```

Interpretation notes:
- `schema_version=3` is **correct, not stale** — the `wiki`-tier CHECK-constraint change is labeled "Migration v4" in `db.ts` but deliberately does not bump the meta stamp.
- Four tiers exist: `doc` (curated), `raw` (dream ingest), `reflection` (synthesized), `wiki` (human-curated via `/ralph-knowledge:curate`; not writable by the record tool). A healthy post-run breakdown shows raw and reflection counts growing.
- Zero reflections with nonzero raws usually means the model was unreachable at run time (the pipeline fails open) — check reachability above, then re-run reflect for the window.

## Relationship to other surfaces

- **Nightly schedule** — `scripts/dream/launchd/com.dubiel.dream-loop.plist.template`, installed by `bootstrap.sh` (directly or via `/ralph-knowledge:setup`). Fires at 03:00 daily. This skill is the manual on-demand counterpart.
- **`dream-now`** — a model-gate zsh function that is gate-aware (loads the model first, then ingest + reflect + logrotate). Owned by model-gate, not this plugin. The default run mode here invokes the scripts directly; point users at `dream-now` when they want the gate-managed shell path.
- **`/ralph-knowledge:curate`** — the human-gated promotion of reflections into the personal wiki tier. The dream-loop produces reflections; curate (not this skill) decides what becomes canonical.
