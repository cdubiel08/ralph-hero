# ralph-knowledge

Semantic search over a personal knowledge corpus (`thoughts/` plus any other
markdown roots). Uses SQLite + `sqlite-vec` for local embeddings and exposes
a stdio MCP server to Claude Code.

## Quick start

```bash
cd plugin/ralph-knowledge
npm install
npm run build
npm run reindex                     # index default root (../../thoughts)
npm run reindex -- /path/to/roots   # CLI override, see "Configuration"
```

A SQLite file is written to `~/.ralph-hero/knowledge.db` by default.

## Skills

| Skill | Purpose |
|-------|---------|
| `/ralph-knowledge:setup` | First-time index build, roots configuration, optional dream-loop bootstrap. |
| `/ralph-knowledge:capture` | In-flow memory capture — "remember this" distills the current insight/session into raw memories via `knowledge_remember`. |
| `/ralph-knowledge:dream-loop` | On-demand memory consolidation: ingest raw activity (Gemma lab logs, git history, llm-cli transcripts, Claude Code sessions), synthesize reflections. |
| `/ralph-knowledge:curate` | Human-gated promotion of recurring insights into the wiki tier. |
| `/ralph-knowledge:setup-obsidian` | Configure `thoughts/` as an Obsidian vault for browsing. |

The memory path is: **capture/ingest (raw) → dream-loop (reflection) → curate (wiki)**.

## Configuration

ralph-knowledge reads configuration from four sources. Each source can be
missing; later sources fill in only what earlier sources did not provide. The
precedence for **roots** (directories to index), from highest to lowest, is:

1. CLI positional arguments (`npm run reindex -- /a /b /c`)
2. `RALPH_KNOWLEDGE_DIRS` environment variable (comma-separated)
3. `roots[]` in `~/.ralph/knowledge.config.json`
4. Fallback: `../../thoughts` (relative to the current working directory)

`dbPath` precedence is independent:

1. CLI positional argument ending in `.db`
2. `RALPH_KNOWLEDGE_DB` environment variable
3. `dbPath` in `~/.ralph/knowledge.config.json`
4. Default: `~/.ralph-hero/knowledge.db`

### `~/.ralph/knowledge.config.json`

Create this file to persist multi-root setups and global ignore patterns.
The path can be overridden via the `RALPH_KNOWLEDGE_CONFIG` env var.

```json
{
  "roots": [
    "~/projects/ralph-hero/thoughts",
    "~/projects/acme-crawler/thoughts",
    "~/notes"
  ],
  "ignorePatterns": [
    "**/drafts/**",
    "**/worktrees/**",
    "*.bak"
  ],
  "dbPath": "~/.ralph-hero/knowledge.db"
}
```

All fields are optional. Tilde (`~`) prefixes in `roots[]` and `dbPath` are
expanded to the user's home directory at load time. Malformed JSON, non-object
top levels, and non-string entries are ignored with a warning.

On startup, ralph-knowledge logs which source provided the roots, e.g.:

```
Using roots from: config
```

## Ignoring files

Per-root `.ralphignore` files use full gitignore syntax and are layered on
top of the config's `ignorePatterns` and the following default globals (always
applied):

- `.claude/`
- `node_modules/`
- `dist/`
- `.git/`
- `*.log`

Example `.ralphignore` at the top of a root directory:

```gitignore
# Skip a whole subtree
.claude/worktrees/**

# Skip drafts but keep the index
drafts/**
!drafts/INDEX.md

# Skip anything ending in .bak
*.bak
```

Patterns behave exactly like `.gitignore`:

- `**/name/**` matches `name/` at any depth.
- A leading `!` negates an earlier match, re-including a path.
- A trailing `/` makes the pattern directory-only.

Directories whose names start with `.` or `_` are also always skipped, as a
fast-path before any matcher is consulted.

## Choosing between `knowledge_search` and `knowledge_recall`

ralph-knowledge exposes two retrieval MCP tools that wrap the same underlying
hybrid search. They differ on **who decides the tier policy**:

| Tool | When to use | Tier handling |
|------|-------------|---------------|
| `knowledge_search` | Power-user / explicit path. You know the tier and want full control over `rerank`, `lambda`, `return_diagnostics`, chunk metadata, etc. | You pass `memory_tier` explicitly (`doc`, `raw`, `reflection`, `wiki`, or `any` — default `any`). |
| `knowledge_recall` | Default for agents and skills. You declare your role and the tool picks the right tiers. | A role-keyed policy fans out one rerank-enabled `hybrid.search()` per tier in the role's list, then merges and re-ranks. |
| `knowledge_think` | You want a *synthesized, sourced answer* to a question, not a result list. Retrieves the top-K excerpts, then asks the local model for a **cited** answer + an explicit **gaps** report ("what the bank does NOT know"). Optional `role` biases the tier mix. | Fail-open: returns the retrieved sources even when the local model is offline. Borrowed from the `gbrain think` idiom (GH-1512). |

### Role -> tier policy

`knowledge_recall(query, role, ...)` follows this fixed policy map:

| Role | Tiers (priority order) | Intent |
|------|------------------------|--------|
| `researcher` | `raw`, `reflection`, `doc` | Recovery of unfiltered observations + synthesized insights + curated research. Excludes wiki (we are looking for things the wiki does not already cover). |
| `planner` | `reflection`, `wiki`, `doc` | Bias toward synthesized insights + canonical curated knowledge; excludes raw observations to keep the planning frame stable. |
| `implementer` | `wiki`, `doc` | Only canonical references — never raw memory or speculative reflections. Keeps implementations grounded in agreed-upon truth. |
| `reviewer` | `wiki`, `doc` | Same constraints as implementer — review against the canonical surface, not the raw or speculative tiers. |
| `triager` | `doc`, `wiki` | Doc-first for issue context, wiki as fallback. |

### Cost notes

- `knowledge_recall` always runs the cross-encoder reranker (`rerank=true`)
  because role-aware retrieval is the most context-sensitive call path in the
  surface. Expect a one-time ~0.5-1 s cold-start (ONNX model load on the first
  call after process boot) and ~25-45 ms per (query, doc) pair on warm calls.
- Each tier sub-query targets <50 ms; a 3-tier fanout totals <150 ms before
  reranking.
- If a tier sub-query throws (e.g., transient DB lock), `knowledge_recall`
  logs the error to stderr and continues with the remaining tiers — degraded
  results rather than a hard failure.

### Power-user override

Skills can mix both tools. For example, `/ralph-hero:plan` calls
`knowledge_recall(role="planner", ...)` for the default tier-balanced context
gather, and ALSO calls `knowledge_search(type="research", ...)` for an explicit
artifact lookup where it needs a precise type filter. Keeping both tools in a
skill's allowlist is the recommended pattern.

## `knowledge_expert` — domain-keyed memory bundles

`knowledge_expert(domain, issue_number, ...)` returns a curated context bundle
for a named domain — wiki entries, recent reflections, and prior outcomes — so
sub-agents become per-domain experts via memory rather than per-domain prompts.
It is the **domain-keyed** companion to `knowledge_recall`'s **role-keyed**
retrieval: role decides which tiers to surface; domain decides which slice of
the corpus.

### Signature

```
knowledge_expert(
  domain: string,             // Tag to match (e.g. "auth", "memory-tiers", "ralph-knowledge")
  issue_number: number,       // GitHub issue on whose behalf this call is made — required for telemetry
  limit?: number,             // Max entries per bucket. Default 5.
  recency_window_days?: number, // Reflection age cutoff in days. Default 30.
  path_prefix?: string,       // Optional secondary filter: only docs whose path starts with this prefix.
  session_id?: string,        // Team/hero session ID — passed through to the outcome event.
)
```

Domain matching uses the `tags` table (frontmatter `tags:` arrays are the
primary signal). `path_prefix` is a secondary narrowing filter — not a
replacement for tags. Pass `"thoughts/shared/"` to restrict to the shared
corpus, for example.

### Return shape

```json
{
  "query_id": "uuid-v4",
  "domain": "auth",
  "wiki": [ ...DocumentRow ],
  "reflections": [ ...DocumentRow ],
  "prior_outcomes": [ ...OutcomeEventRow ],
  "warning": null
}
```

| Field | Description |
|-------|-------------|
| `query_id` | UUID generated per call. Save this and pass it to `knowledge_record_outcome` as `query_id` to correlate downstream outcomes back to this expert call. |
| `domain` | Echo of the requested domain. |
| `wiki` | Up to `limit` documents with `memory_tier = 'wiki'` tagged with `domain`, ordered by date descending. |
| `reflections` | Up to `limit` documents with `memory_tier = 'reflection'` tagged with `domain` and dated within `recency_window_days`. |
| `prior_outcomes` | Up to `limit` `outcome_events` rows whose `payload` JSON contains `domain` — pipeline history for this domain. |
| `warning` | Non-null string when both `wiki` and `reflections` are empty, suggesting the caller tag existing docs or broaden the domain term. `null` on a successful hit. |

### Telemetry

Every `knowledge_expert` call writes an `outcome_events` row with
`event_type = 'expert_call'`. The `payload` JSON carries `query_id`, `domain`,
`returned_doc_ids`, `limit`, `recency_window_days`, `path_prefix`, and
`warning`. This makes per-domain hit rate queryable from day one:

```
knowledge_query_outcomes({ event_type: "expert_call", aggregate: true })
```

Pass `query_id` to `knowledge_record_outcome` to tie subsequent phase/research
outcomes back to the originating expert call:

```
knowledge_record_outcome({
  event_type: "research_completed",
  issue_number: 1306,
  query_id: "<query_id from knowledge_expert>",
  verdict: "complete"
})
```

### Degradation

`knowledge_expert` degrades the same way as the other knowledge tools — return
an empty bundle with a `warning` when no matching documents exist; never throw
on a valid call. If the domain cannot be determined at call time, callers should
skip the call rather than pass an empty string.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `RALPH_KNOWLEDGE_CONFIG` | Override path to `knowledge.config.json` (tilde expanded). |
| `RALPH_KNOWLEDGE_DIRS` | Comma-separated list of roots. Beats config, loses to CLI. |
| `RALPH_KNOWLEDGE_DB` | Override SQLite path. Beats `config.dbPath`, loses to a CLI `.db` positional. |
| `RALPH_KNOWLEDGE_HANDSHAKE_DEADLINE_SEC` | How long the launcher waits for a first-run bootstrap before answering the MCP handshake with a no-tools stub and finishing the install in the background (default `15`; `0` blocks until the install completes). |
| `RALPH_KNOWLEDGE_BOOTSTRAP_WAIT_SEC` | How long to wait for *another* process's bootstrap before giving up (default `900`). Only reachable with the handshake deadline disabled. |

### First run on a slow link

The first launch for a given runtime installs ~155MB and builds — about 4.5s on
a normal connection, comfortably inside Claude Code's 30s MCP startup deadline.
On a slow link the download can outrun that deadline, and the server would be
marked failed for the whole session *and* the install killed with it, so the
next session would start just as cold.

Past `RALPH_KNOWLEDGE_HANDSHAKE_DEADLINE_SEC` the launcher instead answers the
handshake from a zero-dependency stub that reports **no tools**, and lets the
install finish in the background. The session is honestly degraded — the model
is told the toolset is unavailable and why — and a session started after the
install completes gets the full server. A bootstrap that *fails* is not a slow
one: it aborts the launch with its error, as before.

Closing that first session before the install finishes interrupts it, but npm's
cache keeps whatever was already fetched, so the next launch resumes rather than
restarting the download.

## Benchmarks

Standalone benchmarks live under [`benchmark/`](./benchmark/) — see
[`benchmark/README.md`](./benchmark/README.md) for the directory's conventions
(scripts are not part of the published npm package and are not run by
`vitest`).

### Reranker benchmark (GH-901)

[`benchmark/reranker-bench.ts`](./benchmark/reranker-bench.ts) compares two
ONNX cross-encoder rerankers loaded via the existing `@huggingface/transformers`
v3 dependency:

- `onnx-community/bge-reranker-v2-m3-ONNX` (int8 quantized) — primary candidate
- `Xenova/ms-marco-MiniLM-L-6-v2` — speed baseline

For ~44 sample queries spanning the five query intent classes (prior-work
topic, plan-by-issue lookup, claim evidence, epic context, hero orientation),
the script fetches top-20 RRF candidates, reranks each candidate set with both
models, and writes a TSV table with cold-start latency, p50/p95 per-pair
latency, batch-of-20 latency, RSS memory delta, and top-3 agreement vs
RRF-only. Results land at `benchmark/results-YYYY-MM-DD.tsv`; the most recent
run is checked into the repo.

```bash
RALPH_KNOWLEDGE_DB=~/.ralph-hero/knowledge.db \
  npx tsx plugin/ralph-knowledge/benchmark/reranker-bench.ts
```

The script does not modify `hybrid-search.ts` — production wiring of a
default reranker is a separate followup gated on the benchmark's findings.
