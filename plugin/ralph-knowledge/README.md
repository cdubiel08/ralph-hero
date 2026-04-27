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
    "~/projects/landcrawler-ai/thoughts",
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

## Environment variables

| Variable | Purpose |
|----------|---------|
| `RALPH_KNOWLEDGE_CONFIG` | Override path to `knowledge.config.json` (tilde expanded). |
| `RALPH_KNOWLEDGE_DIRS` | Comma-separated list of roots. Beats config, loses to CLI. |
| `RALPH_KNOWLEDGE_DB` | Override SQLite path. Beats `config.dbPath`, loses to a CLI `.db` positional. |

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
