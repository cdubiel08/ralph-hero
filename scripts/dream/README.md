# Dream-Loop — Nightly Memory Ingestion + Reflection

This directory contains the ralph-knowledge dream-loop: a nightly pipeline
that ingests the last 24 hours of raw activity (Gemma lab logs, git
history, `llm-cli` transcripts, Claude Code sessions), writes them as
`memory_tier=raw` documents, and then synthesizes reflection documents by
clustering accumulated unreflected raw memories + asking the local model to
describe each cluster.

> **Reflection triggering & clustering (GH-1510).** The reflect stage no
> longer clusters a fixed 24h window with `HDBSCAN(min_cluster_size=5)` (which
> produced 0 clusters/day on a thin, diverse stream). It now:
> 1. Considers all **unreflected** raws within `window_days` (default 30) —
>    "unreflected" = not yet listed in any reflection file's `source_ids`
>    (the authoritative, DB-rebuild-proof idempotency ledger). The window is
>    always **at least** `window_days` wide, so a narrow `--since` from a
>    nightly caller auto-widens (no caller change needed).
> 2. **Accumulation-gates** the run: it synthesizes only when there are
>    enough unreflected candidates (`count >= count_trigger` OR cumulative
>    `importance >= importance_trigger`, above a `min_unreflected` floor),
>    deferring quietly otherwise so signal accumulates across quiet nights.
> 3. **Size-dispatches** clustering: LLM-as-clusterer for small batches,
>    `AgglomerativeClustering` (cosine) by default, HDBSCAN only for very
>    large batches. A non-empty batch always yields ≥1 group (degenerate
>    fallback), and lone-session singletons coalesce into one "assorted"
>    reflection rather than flooding the tier.
>
> Every threshold is a knob — see **Reflection tuning** below.

Claude Code sessions are distilled, not dumped: one raw memory per
session, holding the session title, the human prompts (deduplicated,
clipped), and the final assistant outcome. Tool I/O, file contents, and
sub-agent transcripts are never ingested, and secret-shaped tokens are
redacted with the same patterns as `remember-turn.sh`. Configure the
transcript root via `claude_code_projects` in `config.yaml` (default
`~/.claude/projects`); omit the key to disable the source.

The pipeline is three scripts:

- `ingest.py` — pulls raw memories, writes markdown under `memory_tier=raw`.
  Two independent idempotency mechanisms: the filename is a hash of
  `(source, source_id)`, so re-emitting the same memory rewrites its own
  byte-identical file; and a content hash drops memories whose body already
  exists in the raw tier under a *different* source id — including one written
  by an earlier run, read by walking the tree rather than from a sidecar index
  that could drift from it.
- `reflect.py` — clusters raw memories, writes `memory_tier=reflection` synthesis docs.
- `logrotate.sh` — caps `/tmp/dream-loop.out` and `/tmp/dream-loop.err` at 1000 lines each.

On macOS they run nightly at 03:00 via launchd using the template at
`launchd/com.dubiel.dream-loop.plist.template`. The live plist lives in
`~/Library/LaunchAgents/` and is NOT committed; only the template is
in-repo.

## Manual Run

```bash
cd /Users/dubiel/projects/ralph-hero/scripts/dream
uv run ingest.py --since 24h
uv run reflect.py            # candidate window defaults to window_days (30)
uv run reflect.py --dry-run  # preview clusters without LLM calls or writes
./logrotate.sh
```

`reflect.py --since` only *widens* the candidate window; pass e.g.
`--since 180d` for a wider single pass. A narrow value (a nightly caller's
`24h`) auto-widens to `window_days`.

### Backfill the existing backlog

To seed reflections from the accumulated raw backlog (e.g. after first
enabling the loop, or after the GH-1510 rework), run a one-shot backfill —
it clusters the **entire unreflected** backlog in time buckets, bypassing
the accumulation gate:

```bash
uv run reflect.py --backfill                      # 90-day buckets (default)
uv run reflect.py --backfill --backfill-batch-days 60
```

It is idempotent: every reflection records the raw `source_ids` it consumed,
so a second `--backfill` run skips already-reflected raws and writes nothing.
Requires the local model to be up (it calls the LLM per cluster). Unlike the
nightly windowed pass it also picks up raws with no usable `date` — "everything
unreflected" is backfill's whole contract, and they cluster into a trailing
bucket of their own.

## Reflection tuning

Each knob resolves `env > config.yaml (reflection:) > built-in default`.

| Env var | config.yaml key | Default | Meaning |
|---------|-----------------|---------|---------|
| `RALPH_DREAM_WINDOW_DAYS` | `window_days` | `30` | Candidate look-back (always ≥ this). |
| `RALPH_DREAM_MIN_UNREFLECTED` | `min_unreflected` | `15` | Defer below this many candidates. |
| `RALPH_DREAM_COUNT_TRIGGER` | `count_trigger` | `20` | Fire when candidate count ≥ this. |
| `RALPH_DREAM_IMPORTANCE_TRIGGER` | `importance_trigger` | `40` | Fire when cumulative importance ≥ this. |
| `RALPH_DREAM_CLUSTER_THRESHOLD` | `cluster_threshold` | `0.40` | Agglomerative cosine *distance* threshold. |
| `RALPH_DREAM_ALGO_MIN` | `algo_min` | `30` | N < this → LLM-as-clusterer; ≥ → algorithmic. |
| `RALPH_DREAM_HDBSCAN_MIN` | `hdbscan_min` | `200` | N ≥ this → HDBSCAN density path. |
| `RALPH_DREAM_MIN_CLUSTER_SIZE` | `min_cluster_size` | `2` | HDBSCAN param (large-N path only). |
| `RALPH_DREAM_MIN_SAMPLES` | `min_samples` | `1` | HDBSCAN param (large-N path only). |

`cluster_threshold` was tuned against the live corpus: `0.40` keeps distinct
themes sharp; ≥`0.65` over-merges everything into one giant cluster.

## Install (launchd)

**Recommended:** run `/ralph-knowledge:setup` (or `bash scripts/dream/bootstrap.sh`
directly). The bootstrap script renders the templated plist with your
actual `$HOME` / `$USER`, writes it to `~/Library/LaunchAgents/`, and
loads it via `launchctl` — idempotent on re-run.

**Manual (deprecated; left for reference):** copy the template into the
user LaunchAgents directory and hand-edit the `__HOME__` /
`__PROJECTS_DIR__` / `__USER__` placeholders before loading it:

```bash
cp scripts/dream/launchd/com.dubiel.dream-loop.plist.template \
   ~/Library/LaunchAgents/com.$(whoami).dream-loop.plist
# Hand-edit __HOME__ → $HOME, __PROJECTS_DIR__ → $HOME/projects, __USER__ → $(whoami)
launchctl load ~/Library/LaunchAgents/com.$(whoami).dream-loop.plist
```

To trigger an immediate run (without waiting for 03:00):

```bash
launchctl start com.$(whoami).dream-loop
```

## Verify

After loading, `launchctl list` should show the agent with a PID column
(or `-` when idle) plus the label. The next scheduled fire is surfaced
by launchd; you can confirm the agent is registered via:

```bash
launchctl list | grep dream-loop
```

Expected output (column ordering: PID, last-exit-status, label):

```
-	0	com.dubiel.dream-loop
```

A `-` in the PID column means the agent is registered but not currently
running. The last-exit-status is `0` after a successful run.

## Logs

- `~/Library/Logs/ralph-dream-loop.out` — `ingest.py` + `reflect.py` stdout.
- `~/Library/Logs/ralph-dream-loop.err` — stderr (errors, warnings, Gemma fallbacks).

Logs live under `~/Library/Logs/` (persistent across reboots, more
discoverable than `/tmp/`). `logrotate.sh` runs at the end of every
launchd-invoked pipeline and caps each file at the last 1000 lines via
`tail -n 1000` + atomic rename. A single night's run typically produces
well under that; the cap guards against unbounded growth over weeks of
scheduling.

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.dubiel.dream-loop.plist
rm ~/Library/LaunchAgents/com.dubiel.dream-loop.plist
```

To stop rotating logs but keep the scripts usable manually, simply
remove the `&& ./logrotate.sh` tail from the plist's `ProgramArguments`
bash string and reload.

## Environment Variables

The plist's `EnvironmentVariables` dict sets the minimum launchd needs
to reach Gemma and the knowledge config:

| Variable | Default in plist | Purpose |
|----------|------------------|---------|
| `PATH` | `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin` | Homebrew + system binaries for `uv` |
| `RALPH_KNOWLEDGE_CONFIG` | `/Users/dubiel/.ralph/knowledge.config.json` | Roots + ignore globs for scanner |
| `RALPH_LLM_URL` | `http://localhost:8000` | Gemma lab OpenAI-compatible endpoint |

If Gemma is unreachable at fire time the pipeline fails open (empty
reflections, single warning in stderr) per the shared constraint
"fail-open LLM" from the group plan.

## Weekly meta-reflection → wiki candidates

`meta_reflect.py` is the second cadence (run weekly, not nightly). It distills
recent **reflections** (not raws) into higher-order **wiki candidates** — the
salient cross-cutting patterns worth promoting to the canonical personal-wiki
tier — and stages them at `<wiki_dir>/_candidates.jsonl`:

```bash
uv run meta_reflect.py                         # last 7 days of reflections
uv run meta_reflect.py --window-days 14 --min-reflections 8
```

**Scheduling is the gate's, not ours** (GH-1519). Like the nightly loop, the
weekly cadence is owned by the sibling **model-gate** repo so ralph-hero stays
gate-agnostic: `model-gate/bin/dream-weekly` brings the model up and invokes
this script with the gate-resolved `served_id` as `--model`, and
`launchd/com.dubiel.dream-weekly.plist.template` fires it Sundays 04:00 — after
the nightly `dream-now`, so the week's last reflections are already in the DB.
Passing `--model` explicitly matters: `DEFAULT_LLM_MODEL` here is a hardcoded
name that a differently-loaded gate would 404 on, and fail-open means such a run
stages nothing while still exiting 0.

It **never writes the wiki tier**. Candidates are staged for the human-gated
`/ralph-knowledge:curate` skill (a sibling of curate's `_rejected.jsonl`),
which reads them as pre-distilled suggestions and still runs each through its
full gate. Idempotent: a candidate already staged (by normalized-axiom hash) is
skipped, so weekly re-runs don't pile up — as is one already **promoted** (an
axiom matching a wiki entry's H1) or **rejected** (a claim in `_rejected.jsonl`),
so a disposition the human already made is not put back in front of them. The
same predicate prunes consumed entries out of `_candidates.jsonl` at the start
of every run, keeping it a queue of pending candidates rather than a log. The
match is lexical (whitespace + case), so a paraphrase of a rejected axiom can
still be re-staged; curate's human gate remains the backstop. Under the weekly
schedule that limit compounds — two back-to-back runs over the same 44
reflections restaged one paraphrase of an already-pending candidate (measured
2026-08-15) — so an unreviewed queue accrues near-duplicates at up to
`RALPH_META_MAX_CANDIDATES` per week until someone runs curate. That per-week
ceiling is **enforced, not requested**: the prompt asks the model for at most
N, and `synthesize_candidates` truncates the parsed list to N (warning when it
does) at the single boundary every staging path crosses — so an over-producing
model cannot widen the bound, and since dedup only ever removes more, weekly
growth stays ≤ N. Fail-open: if the local model is
offline it stages nothing. Knobs: `RALPH_META_WINDOW_DAYS` (7),
`RALPH_META_MIN_REFLECTIONS` (5), `RALPH_META_MAX_CANDIDATES` (3). This is the
hierarchy level that finally seeds the wiki tier and resolves the
reflection→wiki catch-22.
