---
date: 2026-04-26
git_commit: 257a3db0651d3059b23aa4d1c439ff38eae66cfb
branch: main
topic: "Did we create research/docs about 'dreaming', and is the dream-loop implementation self-contained inside ralph-hero?"
tags: [research, ralph-knowledge, dream-loop, dreaming, memory-tier, self-containment, audit, gemma, hdbscan, contextual-retrieval]
status: complete
type: research
github_issues:
  - 906  # bug(ralph-knowledge): parser drops memory_tier frontmatter
  - 907  # bug(ralph-knowledge): reindex OOMs Node heap on ~1.7k-doc corpus
  - 908  # bug(dream-loop): ingest.py auto-reindex hook surfaces OOM as silent warning
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/906
  - https://github.com/cdubiel08/ralph-hero/issues/907
  - https://github.com/cdubiel08/ralph-hero/issues/908
---

# Research: Dreaming Research Trail and Self-Containment Audit

## Prior Work

- builds_on:: [[2026-04-16-local-llm-delivery-truth-personal-dreams-team-memory]]
- builds_on:: [[2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop]]
- builds_on:: [[2026-04-19-group-GH-762-ralph-knowledge-chunked-embeddings-dream-loop]]
- builds_on:: [[2026-04-19-GH-762-critique]]
- builds_on:: [[2026-04-26-softmax-and-rerank-calibration]]
- builds_on:: [[2026-04-26-ralph-knowledge-wikilink-extractor]]

## Research Question

Did we create a doc / research / thought about *dreaming*? It seems like we didn't fully implement it and the implementation is not fully self-contained.

Two-part question:
1. **Document trail** — what writing exists about the dreaming concept, and where does it live?
2. **Self-containment audit** — does the implementation run from a clean clone of `ralph-hero` alone, or does it depend on machine-local state, external repos, and out-of-band manual setup?

## Summary

**Documentation trail: yes, the writing exists — but the seed research lives in another repo, not in ralph-hero.** The foundational research doc (`2026-04-16-local-llm-delivery-truth-personal-dreams-team-memory.md`) was moved to `/Users/dubiel/projects/thoughts/shared/research/`, the user's *global* thoughts repo. Two ralph-hero documents (`thoughts/shared/plans/2026-04-16-GH-0761-...md` and `thoughts/shared/research/2026-04-26-softmax-and-rerank-calibration.md`) `builds_on::` link to that filename, so from inside ralph-hero those wikilinks resolve to phantom nodes — the ralph-knowledge graph would treat them as unresolved targets unless the global thoughts root is added to the indexer's roots config.

The seed research (now reachable at the global path) explicitly frames dreaming as one of three converging consumers of a shared retrieval substrate: *delivery truth* (day-job ADO/GitHub reconciliation), *personal dreams* (nightly memory consolidation loop), and *team memory* (governance-wrapped MCP retrieval service). Prototype A in the research doc — the personal dream loop — is what got built.

**Implementation: shipped and merged to `main`, but only the *plugin* code is self-contained.** The TypeScript ralph-knowledge plugin (`plugin/ralph-knowledge/src/`) has zero hard-coded `/Users/` paths and degrades to safe defaults (cwd-relative `../../thoughts` fallback, `~/.ralph/knowledge.config.json` via `homedir()`, `http://localhost:8000` for the LLM with fail-open semantics). The Python dream-loop scripts and launchd template are not self-contained — they hard-code five absolute paths in `scripts/dream/config.yaml` and three in the launchd plist template, and assume sibling repos (`gemma-lab`, `ralph-engine`) plus a global `thoughts/dream-memories/` directory that lives outside ralph-hero entirely.

**Runtime state: the dream-loop has never executed against this configuration.** The launchd agent is not loaded; the user-level `~/.ralph/knowledge.config.json` does not exist; the Gemma server at `http://localhost:8000` is not currently running; and `/Users/dubiel/projects/thoughts/dream-memories/` (the configured `base_dir`) has not been created. The code exists and tests pass — but no nightly memory has been ingested and no reflection has been synthesized on this machine.

## Detailed Findings

### Document Trail

#### Foundational research (lives outside ralph-hero)

The plans cite `[[2026-04-16-local-llm-delivery-truth-personal-dreams-team-memory]]` as the seed. This doc was *moved* to:

- `/Users/dubiel/projects/thoughts/shared/research/2026-04-16-local-llm-delivery-truth-personal-dreams-team-memory.md`

It is a complete, status-`complete` 423-line research document that frames three threads converging on one substrate:

1. **Delivery truth** — local LLM diff classification + EmbeddingGemma PR↔ticket semantic matching, on top of Apache DevLake, to surface "ADO Done with no merged PR" gaps. Ties into the day-job utility architect role.
2. **Personal dreams** — nightly clustering of last-24h memories with HDBSCAN, Gemma 4 26B writes one reflection per cluster, reflection embedded back as higher-tier memory. Source list: gemma-lab session JSONL, git commits, optional `simonw/llm` SQLite log, screenpipe events. Cites A-Mem (NeurIPS 2025, arxiv 2502.12110) and Anthropic's documented [Claude Code AutoDream pattern](https://claudefa.st/blog/guide/mechanics/auto-dream).
3. **Team memory** — same retrieval substrate exposed via MCP with OAuth 2.1 + PKCE + RFC 8707 resource binding (OBO), framed as "institutional knowledge service" for regulated-utility deployment.

The doc explicitly identifies four prerequisite gaps in ralph-knowledge that the dream-loop plan addresses: global singleton DB, worktree blindness, FTS5 rebuild, and 500-char embedding truncation.

#### Plans inside ralph-hero

- `thoughts/shared/plans/2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop.md` (887 lines, `status: draft`) — the plan-of-plans. Six phases: chunked embeddings + schema v3, contextual retrieval pre-embedding, multi-root ergonomics + `.ralphignore`, MCP tool extensions, dream-loop ingester (Python), nightly reflection loop + launchd. Frontmatter `github_issue: 761`, `primary_issue: 761`. Currently in git as untracked; staged neither for commit nor committed.
- `thoughts/shared/plans/2026-04-19-group-GH-762-ralph-knowledge-chunked-embeddings-dream-loop.md` (1,144 lines, `status: draft`) — atomic decomposition into 11 child issues (GH-762 through GH-772), each with file ownership, success criteria, and verification steps.

#### Review

- `thoughts/shared/reviews/2026-04-19-GH-762-critique.md` — `status: approved`. Verifies all technical claims against the codebase; flags discovery notes for implementers (e.g., `clearAll()` migration, vector table id scheme); confirms phase dependencies. Plan was approved as "well-researched and decomposed correctly."

#### Tangentially related research (cite the dream-loop)

- `thoughts/shared/research/2026-04-26-softmax-and-rerank-calibration.md` — `builds_on::` the missing seed; line 192 says "dream-loop seed, also cites RRF as the substrate."
- `thoughts/shared/research/2026-04-26-ralph-knowledge-wikilink-extractor.md` — documents the wikilink extraction pathway that the dream-loop reflections will use to write `builds_on::` edges back to source raw memories.
- `thoughts/shared/research/2026-04-22-context-handoff-topology.md` — context-flow architecture, indirect background.

#### Wikilink graph health

The dangling reference to `[[2026-04-16-local-llm-delivery-truth-personal-dreams-team-memory]]` from inside ralph-hero is exactly the "phantom node" condition documented in `2026-04-26-ralph-knowledge-wikilink-extractor.md` — the parser extracts the target id from prose, but no document with that id exists in any indexed root *unless the user has added* `/Users/dubiel/projects/thoughts` *to their roots config*.

### Implementation Trail (what merged, in commit order)

All commits are on `main`. PR numbers come from merge-commit messages.

| Commit | Phase | What landed |
|---|---|---|
| `f95d958` (PR #774) | 1 | `feat(ralph-knowledge): schema v3 migration — chunks table + memory_tier` |
| `e535c98` (PR #775) | 1 | `feat(knowledge): add RecursiveCharacterTextSplitter chunker module` |
| `0633afa` (PR #776 reuse) | 1 | `feat(ralph-knowledge): chunk-aware embedder + reindex persistence` |
| `66cd9f0` (PR #779 / merge `d9c690d`) | 1 | `feat(ralph-knowledge): HybridSearch chunk-to-doc dedup + snippet` |
| `b28d757` (PR #777 / merge `9b2c540`) | 4 | `feat(ralph-knowledge): memory_tier filter + knowledge_memory_stats tool` |
| `b05b7c6` (PR #778) | 5 | `feat(dream-loop): Python uv ingester for gemma-lab + git + llm-cli` |
| `52b2226` (PR #782) | 6 | `feat(dream-loop): reflection synthesis via UMAP+HDBSCAN+Gemma` |
| `35ec45d` (PR #783) | 6 | `feat(dream-loop): launchd plist template + log rotation` |
| `c50c393` (PR #835 / merge `9f5582a`) | follow-up | `fix(ralph-knowledge): remove redundant ALTER TABLE in memory_tier tests` |

Phases 2 (contextual retrieval pre-embedding) and 3 (`.ralphignore` + config file) are also present in the codebase as `llm-client.ts`, `ignore.ts`, and `config.ts`, though their merge commits are not separately identified in this listing.

### Code Layout

#### TypeScript plugin (`plugin/ralph-knowledge/src/`)

- `db.ts` — `createSchema()` declares `documents.memory_tier TEXT NOT NULL DEFAULT 'doc' CHECK(memory_tier IN ('doc','raw','reflection'))` plus the `chunks` table with `(id, document_id, chunk_index, content, char_start, char_end, context_prefix)` and `idx_chunks_document_id`.
- `chunker.ts` (279 lines) — `RecursiveCharacterTextSplitter`-style algorithm; emits `DocumentChunk[]` with `content`, `charStart`, `charEnd`, `contextPrefix` fields.
- `embedder.ts` — chunk-aware `embedDocument(title, tags, content, opts)`; calls `opts.llm?.contextualize()` per chunk when the LLM client is provided; embeds `${context}\n${title}\n${tagLine}\n${chunk.content}`.
- `llm-client.ts:45` — `DEFAULT_BASE_URL = "http://localhost:8000"`. Probes `${baseUrl}/v1/models` with 2s timeout; `contextualize()` uses `/v1/chat/completions`. Fail-open: any error returns empty string and logs one warning.
- `vector-search.ts` — chunk ids of the form `{doc_id}#c{index}` stored in `documents_vec`, one row per chunk.
- `hybrid-search.ts` — splits chunk-id on `#c` to recover `doc_id`, deduplicates by document, returns best-scoring chunk's content as `snippet`.
- `search.ts` — accepts optional `memoryTier` filter; adds `WHERE d.memory_tier = @memoryTier` when not `'any'`; silent fallback when reading a v2 DB without the column.
- `config.ts` — `loadConfig()` reads `$RALPH_KNOWLEDGE_CONFIG` env var path or `~/.ralph/knowledge.config.json` via `homedir()`, returns empty config if missing. `expandHome()` handles tilde paths.
- `ignore.ts` (82 lines) — `loadIgnoreForRoot(rootDir, globalPatterns?)` reads `${rootDir}/.ralphignore` and combines with global patterns.
- `reindex.ts:286-367` — precedence chain `cli → env (RALPH_KNOWLEDGE_DIRS) → config → fallback (../../thoughts)`. Logs which source was selected.
- `index.ts` — MCP tools: `knowledge_search` accepts `memory_tier: 'doc'|'raw'|'reflection'|'any'` (default `'any'`) and `return_chunk_meta: boolean`; `knowledge_traverse` accepts `memory_tier` filter; new `knowledge_memory_stats` tool returns tier counts, chunk percentiles, last-reflection timestamp.

#### Python dream-loop (`scripts/dream/`)

- `ingest.py` (603 lines) — three sources: gemma-lab JSONL sessions, git commits across configured repos, optional `~/.llm/logs.db`. Idempotent filenames via SHA-1 of `(source, source_id)`. `GIT_PATCH_CHAR_LIMIT = 4000`. Writes markdown with `memory_tier=raw` frontmatter under `<base_dir>/YYYY/MM/DD/<source>-<hash12>.md`.
- `reflect.py` (767 lines) — reads embeddings directly from `knowledge.db` `documents_vec`, mean-pools chunk embeddings per document, UMAP to 50 dims (`n_neighbors=15, min_dist=0.1`), HDBSCAN (`min_cluster_size=5, min_samples=3`), discards noise. `_PROMPT_HEADER` + `_PROMPT_FOOTER` use the verbatim A-Mem-inspired prompt from the plan. `DEFAULT_LLM_URL = "http://localhost:8000"`, `DEFAULT_LLM_MODEL = "mlx-community/gemma-4-26b-a4b-it-mxfp8"`. Writes under `<base_dir>/reflections/YYYY/MM/DD/<slug>.md`.
- `logrotate.sh` — caps `/tmp/dream-loop.out` and `/tmp/dream-loop.err` at 1000 lines via `tail -n 1000` + atomic rename.
- `pyproject.toml` — `requires-python = ">=3.11"`; deps: `httpx`, `hdbscan`, `umap-learn`, `numpy`, `pyyaml`, `sqlite-vec`. Managed via `uv`.
- `tests/test_ingest.py` (14 KB) and `tests/test_reflect.py` (21 KB) with fixture `sessions/2026-04-19.jsonl`.
- `README.md` — manual run, install, verify, uninstall, env var documentation.

### Self-Containment Audit

This is the part the user flagged. Auditing every external coupling.

#### Layer 1: TypeScript plugin — self-contained ✓

- Zero `/Users/` paths in `plugin/ralph-knowledge/src/` (verified by `grep -rn "/Users/" src/`).
- Zero `/Users/` paths in `plugin/ralph-knowledge/src/__tests__/`.
- Defaults via `os.homedir()` for `~/.ralph/knowledge.config.json`.
- Final fallback: `"../../thoughts"` cwd-relative (`reindex.ts:362-367`) — works on any machine if a sibling `thoughts/` exists.
- LLM endpoint default: `http://localhost:8000`, fail-open on unreachability — does not crash a reindex if Gemma isn't running.
- Tests use `:memory:` SQLite (per CLAUDE.md convention) — no machine-local state.

**Verdict**: the plugin alone is portable. A user with no Gemma server, no config file, and no special directories can clone, `npm install && npm test`, and the system works.

#### Layer 2: `scripts/dream/config.yaml` — five hard-coded absolute paths

```yaml
base_dir: /Users/dubiel/projects/thoughts/dream-memories         # outside ralph-hero
gemma_lab_sessions: /Users/dubiel/projects/gemma-lab/sessions    # separate repo
llm_cli_db: ~/.llm/logs.db                                       # tilde-expanded; OK
git_repos:
  - /Users/dubiel/projects/ralph-hero                            # this repo
  - /Users/dubiel/projects/ralph-engine                          # separate repo
  - /Users/dubiel/projects/gemma-lab                             # separate repo
reindex_cmd: npm --prefix /Users/dubiel/projects/ralph-hero/plugin/ralph-knowledge run reindex
```

Five of the six configured paths bake in the user's specific `/Users/dubiel/projects/...` layout. Only `llm_cli_db` is portable (tilde-relative).

#### Layer 3: `scripts/dream/launchd/com.dubiel.dream-loop.plist.template` — three hard-coded paths

```xml
<string>cd /Users/dubiel/projects/ralph-hero/scripts/dream && uv run ingest.py ...</string>
<string>/Users/dubiel/projects/ralph-hero/scripts/dream/logrotate.sh</string>
...
<key>RALPH_KNOWLEDGE_CONFIG</key>
<string>/Users/dubiel/.ralph/knowledge.config.json</string>
```

Calling this a "template" is generous — no placeholder syntax (no `__HOME__`, `${USER}`, etc.). Each new user must hand-edit before `cp` into `~/Library/LaunchAgents/`.

#### Layer 4: cross-repo dependencies

The dream-loop, as configured, requires four repositories on disk in specific sibling paths:

| Path | Status today | Required for |
|---|---|---|
| `/Users/dubiel/projects/ralph-hero/` | exists | this repo (host) |
| `/Users/dubiel/projects/thoughts/` | exists | `base_dir`, foundational research, knowledge corpus |
| `/Users/dubiel/projects/gemma-lab/` | exists (1 jsonl) | gemma-lab sessions source, Gemma server runner |
| `/Users/dubiel/projects/ralph-engine/` | exists | git_repos source for ingest |

The dream-loop is fundamentally a **multi-repo** feature presented as a sub-directory of ralph-hero. The foundational research that the plans `builds_on::` lives in `/Users/dubiel/projects/thoughts/`, not in this repo.

#### Layer 5: machine-local state required, but not bootstrapped by this repo

| Resource | Required | Current state |
|---|---|---|
| `~/.ralph/knowledge.config.json` | Yes — referenced by launchd's `RALPH_KNOWLEDGE_CONFIG`; declares which roots to index, must include `/Users/dubiel/projects/thoughts/dream-memories/` for reflections to be searchable | **Missing** |
| `~/Library/LaunchAgents/com.dubiel.dream-loop.plist` | For nightly automation | **Not loaded** (`launchctl list | grep dream-loop` empty) |
| Gemma server on `http://localhost:8000` | For contextual retrieval pre-embedding (Phase 2) and reflection synthesis (Phase 6) | **Not running** today (curl failed) |
| `/Users/dubiel/projects/thoughts/dream-memories/` | Output directory for `ingest.py` and `reflect.py` | **Does not exist** — auto-created on first run |
| `~/.llm/logs.db` | Optional source for `simonw/llm` CLI logs | **Missing** — gracefully skipped per docs |
| `/Users/dubiel/projects/gemma-lab/sessions/*.jsonl` | Primary memory source | Exists with one file: `2026-04-13.jsonl` |
| `~/.ralph-hero/knowledge.db` | The chunked-embedding store the reflector reads from | Plugin auto-creates on first reindex |

#### Layer 6: undocumented manual setup steps

To go from a clean machine clone to a working nightly dream-loop, a user must (none of this is automated by `ralph-hero`):

1. Clone `ralph-hero`, `gemma-lab`, `ralph-engine`, and have a `thoughts/` corpus at `/Users/dubiel/projects/thoughts/`.
2. Install `uv`. Run `uv sync` in `scripts/dream/`.
3. Edit `scripts/dream/config.yaml` to match your machine's paths (or rely on the user-specific defaults).
4. Author `~/.ralph/knowledge.config.json` with roots that include `dream-memories/` so reflections become indexable.
5. Run `npm install && npm run build` in `plugin/ralph-knowledge/`.
6. Run `npm run reindex` (or trigger via the configured `reindex_cmd`).
7. Start a local OpenAI-compatible server on `http://localhost:8000` serving Gemma 4 26B (via `gemma-lab/scripts/start-server.sh`).
8. Hand-edit the launchd plist template to match your `$HOME` and project path.
9. `cp` the edited plist into `~/Library/LaunchAgents/`.
10. `launchctl load` it. Verify with `launchctl list | grep dream-loop`.

The README documents steps 8–10 only. Steps 1–7 are not consolidated into any setup script.

### Implementation Completeness vs Plan Acceptance Criteria

The 2026-04-16 plan listed seven success criteria. Status today:

| Plan criterion | Status | Evidence |
|---|---|---|
| 1. Chunk-level snippets returned by `knowledge_search` | Code merged | `hybrid-search.ts` chunk-id splitting; not verified against the corpus on this machine |
| 2. Schema version `"3"` with `chunks` table populated > 3× docs after reindex | Code merged | `db.ts` declares schema; corpus reindex with v3 not verified to have run |
| 3. `~/.ralph/knowledge.config.json` exists with roots + ignore patterns | Not done | File missing |
| 4. `scripts/dream-ingest.py` runs (gemma-lab + git + llm-cli) | Code merged | Script exists; never executed against this machine's sources |
| 5. `scripts/dream-reflect.py` clusters and writes reflections | Code merged | Script exists; `dream-memories/reflections/` does not exist |
| 6. `~/Library/LaunchAgents/com.dubiel.dream-loop.plist` registered with next-fire | Not done | launchctl shows nothing |
| 7. `knowledge_search ... --memory_tier reflection` returns reflections | Latent | Tool accepts the parameter; no reflections to find yet |

**Net**: criteria 1, 2, 4, 5, and 7 are *latently satisfied* (code shipped) but **not empirically verified on this machine** because the dream-loop has never run end-to-end. Criteria 3 and 6 are concretely unmet — the user-side configuration files don't exist.

## Code References

- `/Users/dubiel/projects/thoughts/shared/research/2026-04-16-local-llm-delivery-truth-personal-dreams-team-memory.md:1-423` — foundational research; lives in the global thoughts repo, not in ralph-hero
- `thoughts/shared/plans/2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop.md:17` — the dangling `builds_on::` link to the seed research
- `thoughts/shared/plans/2026-04-19-group-GH-762-ralph-knowledge-chunked-embeddings-dream-loop.md` — atomic decomposition into GH-762 through GH-772
- `thoughts/shared/reviews/2026-04-19-GH-762-critique.md` — approved plan review
- `plugin/ralph-knowledge/src/db.ts` — schema v3 with `chunks` table and `memory_tier` column
- `plugin/ralph-knowledge/src/chunker.ts` — RecursiveCharacterTextSplitter
- `plugin/ralph-knowledge/src/llm-client.ts:45` — `DEFAULT_BASE_URL = "http://localhost:8000"`
- `plugin/ralph-knowledge/src/config.ts:44` — `~/.ralph/knowledge.config.json` lookup via `homedir()`
- `plugin/ralph-knowledge/src/reindex.ts:286-367` — roots precedence chain ending in `"../../thoughts"` fallback
- `plugin/ralph-knowledge/src/index.ts` — `knowledge_search` `memory_tier`, `knowledge_memory_stats` tool registration
- `scripts/dream/ingest.py:1-60` — three-source ingester, idempotent SHA-1 filenames
- `scripts/dream/reflect.py:50-51` — `DEFAULT_LLM_URL` + `DEFAULT_LLM_MODEL` constants
- `scripts/dream/config.yaml:7-18` — five hard-coded `/Users/dubiel/projects/...` paths
- `scripts/dream/launchd/com.dubiel.dream-loop.plist.template:11,29` — three hard-coded `/Users/dubiel/...` paths
- `scripts/dream/README.md:29-43` — install/load/verify steps

## Architecture Documentation

The dreaming system as designed:

```
Sources (three repos + machine-local state)
─────────
gemma-lab/sessions/*.jsonl (24h)
git log --since=24h (ralph-hero, ralph-engine, gemma-lab)
~/.llm/logs.db (optional)
                                                                      
        │                                                             
        ▼                                                             
ingest.py (uv) ── markdown frontmatter (memory_tier=raw) ─►  thoughts/dream-memories/YYYY/MM/DD/
                                                              │
                                                              ▼
                                          npm run reindex (configured roots)
                                                              │
                                                              ▼
                          knowledge.db: documents (memory_tier=raw)
                                       chunks (one row per chunk)
                                       documents_vec (per-chunk embedding)
                                                              │
                                                              ▼
reflect.py (uv) ─ HDBSCAN on UMAP(embeddings) ─ Gemma per cluster ─►  dream-memories/reflections/YYYY/MM/DD/
                                                              │
                                                              ▼
                                          npm run reindex (next time)
                                                              │
                                                              ▼
                          knowledge.db: documents (memory_tier=reflection)
                                       builds_on:: ─► raw memories
                                                              │
                                                              ▼
                          knowledge_search (memory_tier=reflection) from Claude Code
                                                              │
                                                              ▼
                                            launchd: 03:00 daily, RunAtLoad=false
```

Three layers of "outside the repo":
1. The seed *research* lives in `/Users/dubiel/projects/thoughts/`.
2. The *output* (raw + reflections) writes to `/Users/dubiel/projects/thoughts/dream-memories/`.
3. The *user-specific config* (`~/.ralph/knowledge.config.json`, the loaded launchd plist) lives in `$HOME`, not anywhere this repo can author for you.

The plugin (Layer 1) is the only piece that runs from a clone alone.

## Historical Context (from thoughts/)

- `thoughts/shared/plans/2026-04-16-GH-0761-...md` "What We're NOT Doing" section explicitly defers per-project DB isolation, embedding model swap, screenpipe ambient capture, reflection-of-reflections, and OAuth/ACL — keeping the dream-loop scoped to single-user, single-machine, local stack.
- The 2026-04-19 critique flagged the `clearAll()` migration concern and the `documents_vec` GLOB pattern as discovery notes for implementers — both addressed in the merged code.
- The companion research at `thoughts/shared/research/2026-04-26-softmax-and-rerank-calibration.md:192` notes that the dream-loop "cites RRF as the substrate" — the same Reciprocal Rank Fusion (K=60) that hybrid-search uses for chunk-level results.
- The wikilink-extractor research (`2026-04-26-ralph-knowledge-wikilink-extractor.md`) documents that *typed* edges like `builds_on::` are extracted from prose and become graph edges; reflections will use this exact mechanism to link back to source raw memories.

## Bootstrap Findings (2026-04-26)

A live end-to-end bootstrap of the dream-loop on this machine surfaced three additional implementation bugs that the static audit did not predict. These are documented here because they directly impact the user's "not fully implemented" intuition.

### Bug 1: Parser ignores `memory_tier` frontmatter

The schema migration adds `documents.memory_tier TEXT NOT NULL DEFAULT 'doc'` and `getMemoryTier()` was added to `db.ts:481-483` to read it. But:

- `parser.ts` does not extract `memory_tier` from frontmatter (only `date`, `type`, `status`, `github_issue`, `tags`, `superseded_by`)
- `db.ts:upsertDocument()` SQL does not include the `memory_tier` column in either INSERT or UPDATE clauses

Result: every indexed document — including all 14 raw-memory markdown files written by `ingest.py` with explicit `memory_tier: raw` in their frontmatter — gets the column default `'doc'`. The promised tier-filtered retrieval (`knowledge_search memory_tier=raw|reflection`) returns zero results because the data was never written that way.

Empirical proof:

```
$ sqlite3 ~/.ralph-hero/knowledge.db "SELECT memory_tier, COUNT(*) FROM documents GROUP BY memory_tier"
doc|1685
```

All 1,685 indexed documents have `memory_tier='doc'`, including the 2 dream-memory files that did get indexed before the reindex OOM'd.

### Bug 2: Reindex OOMs the JS heap

`npm run reindex` exhausts the Node JS heap on a 1,668-document corpus. Default Node heap (~4 GB on macOS) hits `FATAL ERROR: Reached heap limit`. Even with `NODE_OPTIONS="--max-old-space-size=8192"` (8 GB), the same OOM occurs partway through processing. Of 14 raw-memory files written by ingest.py, only 2 made it into the DB before OOM.

Stack trace points at the embedder's chunk processing (Builtins_AsyncFunctionAwaitResolveClosure → PromiseFulfillReactionJob → microtask queue exhaustion). Likely root cause: the transformer model holding embedding tensors in JS heap across the full corpus without batching/release between docs, possibly compounded by sqlite-vec buffer accumulation. Not investigated to root cause in this audit.

### Bug 3: ingest.py auto-reindex inherits the OOM

`scripts/dream/config.yaml` declares `reindex_cmd: npm --prefix .../ralph-knowledge run reindex`, which `ingest.py` invokes at the end of a successful ingest. That subprocess hits the same OOM as a manual `npm run reindex`, exits with code -6 (SIGABRT), and the ingester logs:

```
WARNING ralph.dream.ingest: Reindex exited with code -6
```

The ingest itself completed successfully (14 raw-memory files on disk). The reindex hook does not.

### End-to-End Consequence

The dream-loop pipeline cannot complete on this machine in its current state:

```
ingest.py        ✓ wrote 14 git-commit raw memories
                ↓
auto-reindex     ✗ OOM at 4GB heap; -6 exit
manual reindex   ✗ OOM at 8GB heap; only 2/14 memories indexed
                ↓
parser           ✗ even the 2 indexed memories got memory_tier='doc' (frontmatter ignored)
                ↓
reflect.py       ✗ "Loaded 0 raw memories. No raw memories in window; nothing to reflect."
                  (correct query, empty result set due to upstream bugs)
```

Six of the plan's seven success criteria cannot be empirically verified until the parser and OOM are fixed. The plugin tests pass because tests use `:memory:` SQLite with hand-crafted `memory_tier='raw'` rows — they verify the *filter* works, not the *write path*.

### Bootstrap state on this machine after the audit

- `~/.ralph/knowledge.config.json` — **authored** with three thoughts roots + dream-memories root + global ignore patterns
- `~/.zshrc` shortcuts — **added** `gemma-up`, `gemma-down`, `gemma-status`, `gemma-ask`, `dream-now`
- Gemma server — **running** at `http://localhost:8000` (`mlx-community/gemma-4-26b-a4b-it-mxfp8`)
- `scripts/dream/.venv/` — **populated** via `uv sync` (umap-learn 0.5.12, hdbscan, sqlite-vec, etc.)
- `plugin/ralph-knowledge/dist/` — **built** (`npm run build` clean)
- `/Users/dubiel/projects/thoughts/dream-memories/2026/04/26/` — **created**, contains 14 `git-commit-*.md` files
- `~/.ralph-hero/knowledge.db` — schema v3, 1,685 documents, 11,743 chunks, **all `memory_tier='doc'`**
- launchd plist — **not loaded** (intentionally deferred per user)
- Reflections — **none** (blocked by Bugs 1+2)

## Open Questions

1. **Should the foundational research be copied/mirrored into `ralph-hero/thoughts/shared/research/`** so the `builds_on::` wikilinks resolve from inside this repo without depending on the global thoughts root being in the user's `~/.ralph/knowledge.config.json`?
2. **Is the dream-loop intended to be a single-user, single-machine feature** (in which case the hard-coded paths are documentation, not bugs), **or a portable feature** (in which case `config.yaml` and the launchd template need placeholder substitution + a setup script)?
3. **Should `~/.ralph/knowledge.config.json` authoring be automated** by `ralph-knowledge:setup` or a sibling skill, given that the launchd job depends on it but the README doesn't walk users through writing it?
4. **Has any nightly run actually completed end-to-end on this machine** — the absence of `dream-memories/` and the empty `launchctl list` suggest no, but a one-shot manual run (`uv run ingest.py --since 24h && uv run reflect.py --since 24h`) might have been attempted and not produced output.
5. **What is the intended host repo** for `dream-memories/`? Today it points at the global `/Users/dubiel/projects/thoughts/`, which is consistent with treating dreaming as a cross-project memory layer rather than a ralph-hero-internal concern.

## Related Research

- `thoughts/shared/research/2026-04-26-softmax-and-rerank-calibration.md` — chunk-level retrieval scoring
- `thoughts/shared/research/2026-04-26-ralph-knowledge-wikilink-extractor.md` — typed edges, phantom nodes
- `thoughts/shared/research/2026-04-22-context-handoff-topology.md` — context flow architecture
- `/Users/dubiel/projects/thoughts/shared/research/2026-04-16-local-llm-delivery-truth-personal-dreams-team-memory.md` — foundational seed (outside this repo)
