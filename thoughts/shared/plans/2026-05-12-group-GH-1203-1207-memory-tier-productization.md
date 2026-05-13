---
date: 2026-05-12
status: draft
type: plan
github_issue: 1203
github_issues: [1203, 1204, 1205, 1206, 1207]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1203
  - https://github.com/cdubiel08/ralph-hero/issues/1204
  - https://github.com/cdubiel08/ralph-hero/issues/1205
  - https://github.com/cdubiel08/ralph-hero/issues/1206
  - https://github.com/cdubiel08/ralph-hero/issues/1207
primary_issue: 1203
tags: [memory-tier, dream-loop, ralph-knowledge, ralph-engine, embedder, mcp, hooks, launchd]
---

# Memory-Tier Productization (GH-1201) - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-29-reindex-memory-profile]]
- builds_on:: [[2026-04-26-dreaming-research-trail-and-self-containment]]
- builds_on:: [[2026-04-16-local-llm-delivery-truth-personal-dreams-team-memory]]

## Overview

5 related issues for atomic implementation across two repositories. Issues 1203-1206 land in `ralph-hero`; issue 1207 spans both `ralph-hero` (`scripts/dream/config.yaml`) and `ralph-engine` (`packages/knowledge/`).

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1203 | Fix reindex OOM with embedder micro-batching; verify 4 tiers populated | S |
| 2 | GH-1204 | Role-based retrieval — `knowledge_recall(query, role)` + wire 6 skills | S |
| 3 | GH-1205 | Agent write loop — `knowledge_remember` MCP tool + Stop hook | S |
| 4 | GH-1206 | One-command bootstrap — extend `/ralph-knowledge:setup` + templated plist | S |
| 5 | GH-1207 | Port `memory_tier` column + chunk table to ralph-engine knowledge package | S |

**Why grouped**: All five are children of GH-1201 (memory-tier productization epic). Phase 1 is the unblocker — Phases 2-5 are mock value unless reflections actually index. Phases 2, 3, 4 can technically execute in parallel after Phase 1 lands (they touch disjoint files), but the plan keeps them sequential so each phase's verification can confirm tier counts grow as expected. Phase 5 only depends on Phase 1's schema being stable, not on Phases 2-4.

## Shared Constraints

These apply to every phase. Inherited from the GH-1201 epic discussion and prior research:

1. **Embedding model is fixed**: stay on `Xenova/all-MiniLM-L6-v2`. Do NOT swap models — vectors must remain interoperable across ralph-knowledge and ralph-engine surfaces.
2. **Tier values are a fixed enum**: `doc | raw | reflection | wiki`. The SQL CHECK constraint is the hard guard; parser coerces invalid values to `'doc'` with a warning. Adding a fifth tier requires a separate migration plan.
3. **Engine schema diverged**: ralph-engine deliberately keeps `metadata` JSON instead of typed columns. This work is **additive only** — do not migrate engine away from `metadata` JSON.
4. **Dream loop scripts stay in Python**: shared between surfaces. Engine becomes another raw source (config.yaml `git_repos` list), not a separate ingest pipeline.
5. **Stop-hook blast radius starts narrow**: matcher initially `ralph-impl|ralph-research|ralph-plan` only. Expand only after one week of clean signal.
6. **No LLM calls inside hooks**: hooks must complete in <500ms. The dream-loop's reflection synthesis is the only LLM-using path.
7. **Idempotence is required for bootstrap and ingest**: `bootstrap.sh` second-run must report "already configured" and exit 0. ingest.py filenames are SHA-1 hashes — same source produces byte-identical files.
8. **No `parsedDocs[]` accumulator regression**: `reindex.ts:97` gates accumulation behind `generate=true`. Phase 1's batching changes must not reintroduce unbounded retention.
9. **Tier filter is already supported** in `knowledge_search`: Phase 2's `knowledge_recall` is a **policy wrapper**, not a schema change. The plumbing exists.

## Current State Analysis

The dream-loop pipeline is wired end-to-end but produces zero reflection rows in the DB on the live corpus. Verified state (from research and direct file reads):

- **Phase 1 surface (`plugin/ralph-knowledge/src/embedder.ts:23-43`)**: `embed()` already calls `output.dispose()` per GH-911. The per-chunk `await embed(...)` loop in `embedDocument()` (lines 110-139) still serializes one ONNX call per chunk. On the live corpus (1,668 files / ~12,879 chunks), the GH-911 fix reaches end-to-end at the **default** 4 GB heap (478 s wall clock, peak 81 MB heap_used). However, current `package.json` reindex script (line 17) does NOT set `--max-old-space-size` at all and does NOT enable `--expose-gc`, so the heap-cap depends on Node's default. The issue body asks to make this explicit at 4096 with `--expose-gc`.
- **`embedder.ts` does not export a batch primitive**. There's only `embed(text)` (single string) and `embedDocument(title, tags, content, opts)` (single doc, per-chunk loop). Phase 1 must add `embedChunks(texts: string[])` (or similar) that calls the transformer pipeline with an array input — transformers.js v3 `pipeline()` accepts `string[]` and returns a `Tensor` whose `.data` flattens all embeddings.
- **`reindex.ts` per-doc loop** (lines 101-256) calls `embedDocument` once per file, which internally loops one `await embed()` per chunk. There's no cross-doc batch boundary today — the chunk-buffer that GH-1203 calls for must be added at the reindex layer.
- **`ingest.py:597`** logs WARNING and returns the reindex exit code (which propagates), but the caller in `main()` only does `log.warning("Reindex exited with code %d", rc)`. The function returns `rc` so the process exits non-zero — BUT the issue body says it currently "logs WARNING and exits 0, hiding the OOM". Inspecting line 596-599 reveals that **the function does return `rc`**, so a non-zero `rc` propagates to `sys.exit(main())`. However, the issue's actual ask is to print the last 50 lines of stderr on non-zero exit — that observability gap is real. The reindex subprocess at line 475 uses `subprocess.run(cmd, shell=True, check=False)` without capturing stderr, so the OOM stack is lost.
- **Phase 2 surface**: `knowledge_search` MCP tool (`index.ts:95-197`) already accepts `memory_tier` enum (lines 105-109). Six target skills (`research`, `ralph-research`, `plan`, `ralph-plan`, `ralph-impl`, `retro`) all call `knowledge_search(type=...)` without tier. There's no `knowledge_recall` tool yet.
- **Phase 3 surface**: No `knowledge_remember` tool exists. The `~/projects/thoughts/dream-memories/agent/` directory does not exist. ralph-unblock's Stop hook is a proven precedent (configured at the plugin level).
- **Phase 4 surface**: `plugin/ralph-knowledge/skills/setup/SKILL.md` does NOT write `~/.ralph/knowledge.config.json`, does NOT probe Gemma, does NOT render the launchd plist. `scripts/dream/launchd/com.dubiel.dream-loop.plist.template` (verified) currently hard-codes `/Users/dubiel/...` — must be templated to `__HOME__`/`__PROJECTS_DIR__`. No `scripts/dream/bootstrap.sh` exists.
- **Phase 5 surface**: `ralph-engine/packages/knowledge/src/sqlite-knowledge-store.ts` has no `memory_tier` column. Engine's `parser.ts` does not extract `memory_tier` frontmatter. `fts-search.ts` and `vector-search.ts` accept search options that do NOT include a tier filter. Engine and ralph-knowledge already share the embedder model.

## Desired End State

### Verification

- [ ] `npm --prefix plugin/ralph-knowledge run reindex` completes at default 4 GB heap on the live 1,668-file corpus
- [ ] `sqlite3 ~/.ralph-hero/knowledge.db "SELECT memory_tier, COUNT(*) FROM documents GROUP BY memory_tier"` returns non-zero counts for all four tiers (`doc`, `raw`, `reflection`, `wiki` — wiki may legitimately be 0 if no curated entries exist; doc/raw/reflection must be non-zero)
- [ ] `knowledge_memory_stats` MCP call returns non-null `last_reflection_timestamp`
- [ ] `/ralph-hero:research` returns at least one `raw` or `reflection` result on a paraphrase query
- [ ] `/ralph-hero:plan` returns mostly `wiki`+`reflection`+`doc` results; no `raw` leak
- [ ] `/ralph-hero:impl` returns only `wiki`+`doc` results
- [ ] A new `~/projects/thoughts/dream-memories/agent/$(date +%Y/%m/%d)/<hash>.md` file appears after running `/ralph-hero:retro`
- [ ] A fresh-machine simulation (`rm -rf ~/.ralph/knowledge.config.json ~/Library/LaunchAgents/com.*.dream-loop.plist`) followed by `/ralph-knowledge:setup` recreates them and the next 03:00 launchd fire runs successfully
- [ ] `cd ralph-engine && npm test -- packages/knowledge` passes; `apps/wiki` still loads; engine query with `memoryTier: "reflection"` returns reflections written by ralph-hero's dream-loop

## What We're NOT Doing

- Embedding model swap — staying on `Xenova/all-MiniLM-L6-v2`
- Auto-promotion from `reflection` to `wiki` — wiki stays manually gated via `/ralph-knowledge:curate`
- Migrating engine schema to drop the `metadata` JSON column
- Porting reflection synthesis (Gemma-driven clustering) natively to TypeScript
- Expanding the Stop hook matcher beyond the initial three skills
- Per-project DB isolation — single-user, single-DB stays
- screenpipe ambient capture (deferred per GH-0761)
- Refactoring `parser.ts` or `db.ts` Phase 1 — the parser/DB wiring is correct as-is

## Implementation Approach

Phase 1 ships first because Phases 2-5 are mock-value until reflections actually index. After Phase 1, Phases 2, 3, 4 produce additive surface area (new MCP tools, new hooks, new setup automation) that can be implemented in any order; the plan presents them sequentially so each phase's verification produces incremental signal. Phase 5 ports the schema cross-repo and depends only on Phase 1's schema being stable.

**Phase dependency annotations** — Phase 2-4 depend on Phase 1 because they all want to verify against a healthy 4-tier DB. Phase 5 depends only on Phase 1.

---

## Phase 1: GH-1203 — Reindex OOM fix with micro-batching + verify all 4 tiers
- **depends_on**: null

### Overview

The GH-911 fix landed `output.dispose()` and the `parsedDocs[]` accumulator gate, taking the live corpus from per-chunk OOM at chunk 150 to a clean 1,668-doc reindex with peak ~81 MB heap_used at default 4 GB. The remaining work in GH-1203 hardens that path: replace the per-chunk `await` loop with a batched primitive, dispose every intermediate tensor (not just the top-level `output`), explicitly set `NODE_OPTIONS` to `--max-old-space-size=4096 --expose-gc` in the reindex script, hint `global.gc()` every 8 batches, and make `ingest.py` surface reindex stderr on non-zero exit.

### Tasks

#### Task 1.1: Add `embedChunks(texts: string[], opts?)` batch primitive in `embedder.ts`
- **files**: `plugin/ralph-knowledge/src/embedder.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] New exported function `embedChunks(texts: string[]): Promise<Float32Array[]>` returns one embedding per input text in input order
  - [ ] Internally calls the transformer pipeline ONCE per batch (verified by `vi.fn()` counting pipeline invocations in tests)
  - [ ] Disposes the batch-output tensor exactly once after copying data into per-text `Float32Array`s
  - [ ] When `texts.length === 0`, returns `[]` without invoking the pipeline
  - [ ] Embeddings produced by `embedChunks([t1, t2, t3])` are numerically equal (within Float32 epsilon) to sequential `embed(t1), embed(t2), embed(t3)` for the mock pipeline (verifies data slicing math)
  - [ ] Each returned `Float32Array` has length 384

#### Task 1.2: Buffer chunk texts across documents in `reindex.ts`, flush at `EMBED_BATCH_SIZE`
- **files**: `plugin/ralph-knowledge/src/reindex.ts` (modify), `plugin/ralph-knowledge/src/embedder.ts` (read)
- **tdd**: true
- **complexity**: high
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `EMBED_BATCH_SIZE` constant reads from `process.env.EMBED_BATCH_SIZE`, defaulting to 16
  - [ ] Reindex loop accumulates `(docId, chunkIndex, embedText, chunkMeta)` tuples into a buffer; flushes via `embedChunks(buffer.map(b => b.embedText))` when buffer length reaches `EMBED_BATCH_SIZE` or when all docs are exhausted
  - [ ] Each flush writes results to BOTH the `chunks` table and the `documents_vec` virtual table — preserving today's per-chunk insert semantics, just batched
  - [ ] Every 8 flushes (8 × `EMBED_BATCH_SIZE` = 128 chunks by default), if `global.gc` exists, call it (guarded by `typeof global.gc === 'function'`)
  - [ ] When `RALPH_CONTEXTUAL_RETRIEVAL` is on and `llm` is set, per-chunk `contextualize()` calls still happen BEFORE buffering (the prefix becomes part of `embedText`); the cache fast-path still applies
  - [ ] Streaming behavior: the buffer never holds more than `EMBED_BATCH_SIZE` × (max chunk size) = ~32 KB texts; total reindex retention bounded by buffer size + current parsedDocs gate
  - [ ] A unit test asserts the pipeline is invoked `ceil(N_chunks / EMBED_BATCH_SIZE)` times for a synthetic 50-doc / 150-chunk corpus (vs 150 invocations today)
  - [ ] Existing single-doc path still works when `embedDocument` is called externally (preserve backward compat — `embedDocument` keeps its existing signature/behavior; the batch path is internal to the reindex loop)

#### Task 1.3: Dispose every intermediate tensor in batch path
- **files**: `plugin/ralph-knowledge/src/embedder.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `embedChunks` calls `dispose()` on the batch-output tensor before returning
  - [ ] If the underlying pipeline call produces a `last_hidden_state` intermediate accessible via output (transformers.js v3 may attach it), it is also disposed; if not accessible, document this in a code comment
  - [ ] Unit test using the mock pipeline asserts `disposeCalls.length === batchCount` (one dispose per pipeline invocation), not `disposeCalls.length === text.length`
  - [ ] Test asserts the returned `Float32Array`s are independent of the source buffer (mutating one does not mutate another and does not throw post-dispose)

#### Task 1.4: Set `NODE_OPTIONS=--max-old-space-size=4096 --expose-gc` in reindex script
- **files**: `plugin/ralph-knowledge/package.json` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `scripts.reindex` value is exactly: `cross-env NODE_OPTIONS=\"--max-old-space-size=4096 --expose-gc\" node dist/reindex.js` (or equivalent platform-portable form; if `cross-env` is not already a dep, use `NODE_OPTIONS=\"...\" node ...` since the project is mac-first)
  - [ ] If a cross-platform wrapper is required, add `cross-env` to devDependencies; otherwise leave deps unchanged
  - [ ] `npm --prefix plugin/ralph-knowledge run reindex --help` (or equivalent dry probe) does not error on the new script
  - [ ] `package.json` validates as JSON (no trailing comma, no unquoted keys)

#### Task 1.5: ingest.py surfaces last 50 lines of reindex stderr on non-zero exit
- **files**: `scripts/dream/ingest.py` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] `_run_reindex` (line 471-479) captures stderr via `subprocess.run(..., capture_output=True, text=True)` (currently it does not capture)
  - [ ] On non-zero return code, the last 50 lines of stderr are printed to the caller's stderr via `print(..., file=sys.stderr)` and logged at ERROR level
  - [ ] The function continues to return `rc` so `main()` exits non-zero (currently `main()` already returns `rc` at line 599 — preserve that)
  - [ ] When stderr is empty on non-zero exit (e.g., killed signal), the log message indicates "reindex exited non-zero with no stderr"
  - [ ] Unit test stubs `subprocess.run` to return a `CompletedProcess(returncode=1, stderr="line1\nline2\n... 100 lines")` and asserts the last 50 lines are emitted
  - [ ] Existing dry-run / no-reindex flags are unchanged

#### Task 1.6: Tier-count verification harness
- **files**: `plugin/ralph-knowledge/scripts/verify-tiers.ts` (create), `plugin/ralph-knowledge/package.json` (modify — add `verify:tiers` script)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2, 1.4]
- **acceptance**:
  - [ ] New script `npm --prefix plugin/ralph-knowledge run verify:tiers` reads `~/.ralph-hero/knowledge.db` (or `RALPH_KNOWLEDGE_DB`), prints `memory_tier=X count=N` lines for all four tiers
  - [ ] Exits 0 iff `doc > 0 AND raw > 0 AND reflection > 0` (wiki is allowed to be 0)
  - [ ] Exits non-zero with a clear message when any required tier is 0
  - [ ] Script uses `better-sqlite3` (already a dep) — no new deps

### Phase Success Criteria

#### Automated Verification:
- [x] `npm run build --prefix plugin/ralph-knowledge` — no TS errors
- [x] `npm test --prefix plugin/ralph-knowledge -- embedder` — embedder tests pass including new `embedChunks` cases (38/38 pass)
- [x] `npm test --prefix plugin/ralph-knowledge -- reindex` — reindex tests pass (38/38 pass, includes 5 new GH-1203 scenarios)
- [x] `cd scripts/dream && uv run pytest` — ingest.py tests pass including new stderr-capture case (26/26 ingest, 51/51 total)
- [ ] `npm --prefix plugin/ralph-knowledge run reindex` on live corpus completes at default heap (no `NODE_OPTIONS` override needed beyond what package.json sets); peak RSS under 4 GB per `/usr/bin/time -l` (deferred — live-corpus run is manual verification)
- [ ] `npm --prefix plugin/ralph-knowledge run verify:tiers` exits 0 (deferred — depends on live reindex + reflection synthesis pass)

#### Manual Verification:
- [ ] `sqlite3 ~/.ralph-hero/knowledge.db "SELECT memory_tier, COUNT(*) FROM documents GROUP BY memory_tier"` shows `reflection` count > 0 (≥ 4 given the 4 known reflection files on disk)
- [ ] `knowledge_search("dream loop", memory_tier="reflection")` returns ≥ 1 result
- [ ] `dream-now` surfaces at least 1 new reflection in `~/projects/thoughts/dream-memories/reflections/2026/05/*/` after running

**Creates for next phase**: a healthy 4-tier DB. Phases 2-4 use this as their verification substrate.

---

## Phase 2: GH-1204 — Role-based retrieval `knowledge_recall` + wire 6 skills
- **depends_on**: [phase-1]

### Overview

Wrap `knowledge_search` in a policy layer keyed by agent role. Add `knowledge_recall(query, role, ...)` MCP tool that fans out one rerank-enabled `hybrid.search()` per tier in the role's policy, then merges and re-ranks. Wire it into 6 skills so agents get tier-appropriate memory automatically without each skill having to declare tier mappings.

### Tasks

#### Task 2.1: Add `knowledge_recall` MCP tool in `index.ts`
- **files**: `plugin/ralph-knowledge/src/index.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] New tool registered after the existing `knowledge_search` block (around `index.ts:198`)
  - [ ] Input schema: `query: string` (required), `role: enum("researcher","planner","implementer","reviewer","triager")` (required), `limit?: number` (default 10), `type?: string` (optional)
  - [ ] Internal role-to-tier policy map: researcher → `[raw, reflection, doc]`; planner → `[reflection, wiki, doc]`; implementer → `[wiki, doc]`; reviewer → `[wiki, doc]`; triager → `[doc, wiki]`
  - [ ] Implementation fans out one `hybrid.search(query, { memoryTier: tier, rerank: true, limit })` per tier in the policy, then merges all results and re-ranks by `rerankScore` (or `score` fallback), de-duping by `id`
  - [ ] Returns the same shape as `knowledge_search` (uses `formatSearchResults`) with up to `limit` results
  - [ ] On any tier sub-query throwing, the tool logs the error to stderr but continues with the remaining tiers (degraded but not failed)
  - [ ] Unit test: stubs `hybrid.search` to return tier-tagged results, asserts each role triggers fan-out matching the policy map (e.g., `role="implementer"` → exactly two `hybrid.search` calls, both with `memoryTier` in `["wiki","doc"]`)
  - [ ] Unit test: asserts merge order (rerank-score-descending) and dedup by `id`

#### Task 2.2: Wire `knowledge_recall` into 6 skills
- **files**: `plugin/ralph-hero/skills/research/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-research/SKILL.md` (modify), `plugin/ralph-hero/skills/plan/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-plan/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-impl/SKILL.md` (modify), `plugin/ralph-hero/skills/retro/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] Each of the 6 SKILL.md files lists `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_recall` in its `tools:` frontmatter (alongside the existing `knowledge_search` entry — keep `knowledge_search` for the power-user/explicit path)
  - [ ] `research` and `ralph-research` SKILL.md replace the existing `knowledge_search(type="research", ...)` step with `knowledge_recall(role="researcher", type="research", ...)` (preserving the existing description of when to skip)
  - [ ] `plan` and `ralph-plan` SKILL.md add a `knowledge_recall(role="planner", ...)` call in the context-gather step (alongside any existing `knowledge_search` calls; do not delete the explicit `knowledge_search(type="research", ...)` artifact lookup the planner uses)
  - [ ] `ralph-impl` SKILL.md adds a `knowledge_recall(role="implementer", ...)` call as pre-implementation context (specifically: before reading the plan, gather wiki/doc tier context)
  - [ ] `retro` SKILL.md changes the dedup check from `knowledge_search(type="research", ...)` to `knowledge_recall(role="researcher", type="research", ...)`
  - [ ] Grep verification: `grep -l "knowledge_recall" plugin/ralph-hero/skills/{research,ralph-research,plan,ralph-plan,ralph-impl,retro}/SKILL.md | wc -l` returns 6

#### Task 2.3: Update ralph-knowledge README "Choosing search vs recall" section
- **files**: `plugin/ralph-knowledge/README.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] New section explains `knowledge_search` is the power-user / explicit-tier path; `knowledge_recall` is the role-aware default
  - [ ] Documents the role-to-tier policy table verbatim
  - [ ] Notes that `knowledge_recall` always passes `rerank=true` and incurs ~0.5-1s on cold-start

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build --prefix plugin/ralph-knowledge` — no errors (new tool registration type-checks)
- [ ] `npm test --prefix plugin/ralph-knowledge -- recall` — new policy-fanout tests pass
- [ ] `grep -r "knowledge_recall" plugin/ralph-knowledge/src/index.ts` returns a match
- [ ] `grep -l "knowledge_recall" plugin/ralph-hero/skills/{research,ralph-research,plan,ralph-plan,ralph-impl,retro}/SKILL.md | wc -l` returns 6

#### Manual Verification:
- [ ] `/ralph-hero:research` on a topic with known raw/reflection memory returns results from `raw` and `reflection` tiers
- [ ] `/ralph-hero:plan` on the same topic returns results biased toward `wiki`+`reflection`+`doc`
- [ ] `/ralph-hero:impl` on the same topic returns ONLY `wiki`+`doc` results (no `raw` leak)

**Creates for next phase**: agents reliably retrieve tier-appropriate memory. Phase 3 builds the write half of the loop.

---

## Phase 3: GH-1205 — Agent write loop: `knowledge_remember` + Stop hook
- **depends_on**: [phase-2]

### Overview

Close the write half of agent memory. Add a `knowledge_remember(text, source, tier='raw', ...)` MCP tool agents can call explicitly. Add a passive Stop hook that captures the last assistant message + last user message per turn into `~/projects/thoughts/dream-memories/agent/YYYY/MM/DD/<hash>.md`. Both feed into the next reflection synthesis pass so agent work becomes long-term memory automatically.

### Tasks

#### Task 3.1: Register `knowledge_remember` MCP tool in `index.ts`
- **files**: `plugin/ralph-knowledge/src/index.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] New tool registered after `knowledge_recall`
  - [ ] Input schema: `text: string` (required), `source: string` (required, e.g. `"agent:impl"`), `tags?: string[]`, `github_issue?: number`, `tier?: enum("raw","doc")` (default `"raw"`; `"reflection"` and `"wiki"` are not writable via this tool to preserve manual-curation invariants)
  - [ ] Implementation: SHA-1 hashes `${source}:${text}` for a 12-char digest; writes markdown frontmatter (`memory_tier`, `date`, `source`, optional `github_issue`, `tags`) plus body to `~/projects/thoughts/dream-memories/agent/YYYY/MM/DD/<source-hash>.md` (year/month/day from current UTC time)
  - [ ] After writing the file, calls the SAME reindex entry point that `reindex.ts` exports but scoped to a single path (incremental). If a single-path reindex API does not exist, this task adds a minimal `reindexPath(path: string)` helper to `reindex.ts` and calls it. The helper reuses the existing parser/db/embedder code paths.
  - [ ] Returns `{ path, indexed: true | false }` to the caller
  - [ ] Unit test: stubs file write + reindex helper, asserts the tool produces the expected path and frontmatter shape
  - [ ] Unit test: asserts the tool rejects `tier: "reflection"` or `tier: "wiki"` with a clear error message
  - [ ] Frontmatter is byte-stable across invocations with the same `text` + `source` (deterministic key order)

#### Task 3.2: Create Stop hook script `remember-turn.sh`
- **files**: `plugin/ralph-hero/hooks/scripts/remember-turn.sh` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Script reads `$CLAUDE_AGENT_TRANSCRIPT` (an env var pointing at a JSONL transcript file) and extracts the last user message and last assistant message using `jq` (already commonly available in plugin scripts)
  - [ ] If `$CLAUDE_AGENT_TRANSCRIPT` is unset or the file is missing, exits 0 silently (no Stop blast radius)
  - [ ] If combined message length is below threshold (default 200 chars; configurable via `RALPH_REMEMBER_MIN_CHARS` env), exits 0 without writing
  - [ ] Otherwise writes a `memory_tier: raw` markdown file to `~/projects/thoughts/dream-memories/agent/$(date +%Y/%m/%d)/agent-$(echo -n "...uniq-id..." | shasum | cut -c1-12).md`
  - [ ] Includes `source: agent:$AGENT_TYPE` in frontmatter (agent type taken from `$CLAUDE_AGENT_TYPE` env var; falls back to `agent:unknown`)
  - [ ] Runs a secret regex scrub before write: redacts `gh[ps]_[a-zA-Z0-9]{20,}`, `sk-[a-zA-Z0-9]{32,}`, `ghp_[a-zA-Z0-9]{36,}`, `xoxb-[a-zA-Z0-9-]+` → replaces with `[REDACTED]`
  - [ ] Script is executable: `chmod +x` on creation
  - [ ] Total runtime under 500 ms for a 4 KB transcript (no LLM calls, no network)

#### Task 3.3: Register Stop hook with narrow matcher in `plugin.json`
- **files**: `plugin/ralph-hero/.claude-plugin/plugin.json` (modify, or whichever hooks declaration file exists; verify by reading the existing ralph-unblock Stop hook registration before editing)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.2]
- **acceptance**:
  - [ ] Stop hook registered with matcher `ralph-impl|ralph-research|ralph-plan` (narrow blast radius per shared constraints)
  - [ ] Hook command points at `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/remember-turn.sh`
  - [ ] No other matcher patterns are widened
  - [ ] Registration mirrors the structure of the existing ralph-unblock Stop hook (verify by reading that registration before editing)

#### Task 3.4: Add `dream-memories/agent/` to ingest.py scan paths
- **files**: `scripts/dream/ingest.py` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] ingest.py recognizes `dream-memories/agent/` as an additional scan source OR documents that the existing config (which writes everything under `base_dir`) already covers it
  - [ ] If a code change is needed (e.g., file-scanner adds the path), unit test asserts a fake `~/projects/thoughts/dream-memories/agent/2026/05/12/test-abc.md` file is included in the next ingest pass
  - [ ] If no code change is needed (the directory is already covered by reindex's root-walking), note this in a code comment and add a test asserting the path is reachable via the existing reindex root

### Phase Success Criteria

#### Automated Verification:
- [x] `npm test --prefix plugin/ralph-knowledge -- remember` — new tests pass (12 tests in remember.test.ts; 516/516 in full suite)
- [x] `npm run build --prefix plugin/ralph-knowledge` — no errors
- [x] `test -x plugin/ralph-hero/hooks/scripts/remember-turn.sh` — executable bit set
- [x] `cd scripts/dream && uv run pytest` — ingest.py tests pass (52/52, includes new TestAgentMemoryPathCoverage)
- [x] `bash -n plugin/ralph-hero/hooks/scripts/remember-turn.sh` — script parses
- [x] Synthetic transcript test: 22/22 pass in `__tests__/remember-turn.test.sh`; covers no-transcript silent no-op, missing file silent no-op, short-turn skip, long-turn write, GitHub PAT redaction, stdin transcript_path fallback, idempotent re-fire, latency budget (<500ms; actual ~75ms)

#### Manual Verification:
- [ ] Run `/ralph-hero:retro` end-to-end and grep for new file in `~/projects/thoughts/dream-memories/agent/$(date +%Y/%m/%d)/`
- [ ] `sqlite3 ~/.ralph-hero/knowledge.db "SELECT COUNT(*) FROM documents WHERE path LIKE '%dream-memories/agent%'"` returns non-zero after next reindex
- [ ] Spot-check 5 random agent memories — no API keys / tokens captured
- [ ] After running `dream-now`, a reflection cites agent memory in its `## Sources`

**Creates for next phase**: agent turns become long-term memory. Phase 4 makes the whole pipeline trivially reproducible on a fresh machine.

---

## Phase 4: GH-1206 — One-command bootstrap `/ralph-knowledge:setup` + templated launchd
- **depends_on**: [phase-3]

### Overview

Replace the 10-step manual onboarding in `CLAUDE.md` with a single `/ralph-knowledge:setup` invocation. The skill writes `~/.ralph/knowledge.config.json` if missing, probes Gemma (non-blocking), renders the launchd plist template with the user's actual `$HOME` / `$PROJECTS_DIR`, runs a smoke ingest, and reports tier counts. A new `scripts/dream/bootstrap.sh` script is the single source of truth — idempotent, re-runnable.

### Tasks

#### Task 4.1: Template the launchd plist
- **files**: `scripts/dream/launchd/com.dubiel.dream-loop.plist.template` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] All hardcoded `/Users/dubiel/...` paths replaced with `__HOME__` / `__PROJECTS_DIR__` placeholders (5 occurrences in the current file: line 11 cwd/cmd, line 21 stdout path, line 23 stderr path, line 28 config path)
  - [ ] `__HOME__` resolves to `$HOME`; `__PROJECTS_DIR__` resolves to `$HOME/projects` by default (overridable)
  - [ ] Label key becomes `com.__USER__.dream-loop` so multiple users don't collide
  - [ ] Stdout/stderr paths move from `/tmp/dream-loop.{out,err}` to `__HOME__/Library/Logs/ralph-dream-loop.{out,err}` (more discoverable, persistent across reboots)
  - [ ] Existing CLAUDE.md instructions explaining manual `cp` + hand-edit are left in place but marked deprecated with a pointer to `/ralph-knowledge:setup`

#### Task 4.2: Create `scripts/dream/bootstrap.sh` (idempotent end-to-end setup)
- **files**: `scripts/dream/bootstrap.sh` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [4.1]
- **acceptance**:
  - [ ] Script is executable: `chmod +x` on creation
  - [ ] Steps: (1) write `~/.ralph/knowledge.config.json` with discovered `thoughts/` roots (auto-detect by globbing `~/projects/*/thoughts` and `~/projects/thoughts`), sensible default `ignorePatterns`, and `dbPath: ~/.ralph-hero/knowledge.db` — SKIP if file already exists; (2) probe `http://localhost:8000/v1/models` — if down, print `gemma-up` hint to stderr but DO NOT exit non-zero; (3) render plist template by substituting `__HOME__`/`__PROJECTS_DIR__`/`__USER__` and write to `~/Library/LaunchAgents/com.$(whoami).dream-loop.plist` — SKIP if file already exists; (4) `launchctl load ~/Library/LaunchAgents/com.$(whoami).dream-loop.plist` — silently no-op if already loaded; (5) run `uv run scripts/dream/ingest.py --since 1h` from the ralph-hero root; (6) print tier counts using `sqlite3 ~/.ralph-hero/knowledge.db "SELECT memory_tier, COUNT(*) FROM documents GROUP BY memory_tier"`; (7) print next-steps banner (`dream-now`, log paths, `launchctl list | grep dream-loop`)
  - [ ] Each step prints `OK <step>` or `SKIP <step> (already configured)` so the user can see exactly what changed
  - [ ] Exit code 0 on success; non-zero only if a step that should not skip fails (e.g., reindex crashes — but plist + config skips are not errors)
  - [ ] Second invocation: every step reports SKIP for the file-creation steps and re-prints tier counts; total exit 0
  - [ ] Total runtime under 2 minutes when reindex is a no-op (e.g., fresh dream-memories tree)

#### Task 4.3: Extend `/ralph-knowledge:setup` SKILL.md to call `bootstrap.sh`
- **files**: `plugin/ralph-knowledge/skills/setup/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [4.2]
- **acceptance**:
  - [ ] After the existing Step 3 (reindex), add Step 4 (renumber existing Step 4 + Step 5 to Step 5 + Step 6): "Run end-to-end bootstrap" that invokes `bash $CLAUDE_PLUGIN_ROOT/../../../scripts/dream/bootstrap.sh` (or whatever absolute path resolution is correct from the plugin root)
  - [ ] Skill documents that bootstrap.sh is the source of truth — when something needs to change in setup, edit bootstrap.sh, not the skill body
  - [ ] Skill explains that the user may skip bootstrap if they only want to reindex (existing Step 3 path is unchanged)
  - [ ] Skill prints the tier-count summary as a final summary block

### Phase Success Criteria

#### Automated Verification:
- [ ] `bash -n scripts/dream/bootstrap.sh` — script parses
- [ ] `test -x scripts/dream/bootstrap.sh` — executable
- [ ] `grep -c "__HOME__\|__PROJECTS_DIR__\|__USER__" scripts/dream/launchd/com.dubiel.dream-loop.plist.template` returns ≥ 4
- [ ] `grep -c "/Users/dubiel" scripts/dream/launchd/com.dubiel.dream-loop.plist.template` returns 0
- [ ] Fresh-machine simulation: `rm ~/.ralph/knowledge.config.json && rm ~/Library/LaunchAgents/com.$(whoami).dream-loop.plist && bash scripts/dream/bootstrap.sh` exits 0 and recreates both files
- [ ] Idempotence: run bootstrap.sh twice — second run prints SKIP for each file-creation step and exits 0

#### Manual Verification:
- [ ] `launchctl list | grep dream-loop` shows the agent after setup
- [ ] On a second machine (or after `~/.ralph/*` wipe), one `/ralph-knowledge:setup` invocation yields a working dream-loop
- [ ] Smoke ingest produces ≥1 raw memory in today's `~/projects/thoughts/dream-memories/$(date +%Y/%m/%d)/`
- [ ] Next 03:00 launchd fire actually runs (verify via `~/Library/Logs/ralph-dream-loop.out`)
- [ ] Setup completes in under 2 minutes when dependencies are present

**Creates for next phase**: the dream-loop is trivially reproducible. Phase 5 brings the same tier model to ralph-engine.

---

## Phase 5: GH-1207 — Port `memory_tier` + chunk table to ralph-engine knowledge package
- **depends_on**: [phase-1]

### Overview

Additively port the `memory_tier` column and (optionally) chunk table to `ralph-engine/packages/knowledge`. Engine keeps its `metadata` JSON shape and reflection synthesis remains owned by ralph-hero; engine just consumes the same on-disk reflection corpus via its own knowledge.db.

**Important**: this phase touches `ralph-engine` (a separate repo at `~/projects/ralph-engine/`). The dream-loop `config.yaml` change is in ralph-hero; everything else is in ralph-engine.

### Tasks

#### Task 5.1: Add `memory_tier` migration + column to engine's sqlite store
- **files**: `ralph-engine/packages/knowledge/src/sqlite-knowledge-store.ts` (modify), `ralph-engine/packages/knowledge/src/__tests__/sqlite-knowledge-store.test.ts` (modify or create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] New migration adds `memory_tier TEXT NOT NULL DEFAULT 'doc' CHECK(memory_tier IN ('doc','raw','reflection','wiki'))` to engine's `documents` table
  - [ ] Migration is forward-only and additive — existing engine DBs upgrade cleanly (new rows default to 'doc')
  - [ ] INSERT statements include `memory_tier` (with default fallback)
  - [ ] SELECT statements return `memory_tier` in their row shape
  - [ ] `metadata` JSON column remains intact and untouched (additive only)
  - [ ] Unit test: creates a fresh in-memory store, inserts a doc without `memory_tier` → reads back with `memory_tier === 'doc'`
  - [ ] Unit test: inserts a doc with `memory_tier: 'reflection'` → reads back the same value
  - [ ] Unit test: rejects `memory_tier: 'invalid'` (SQL CHECK fires)

#### Task 5.2: Extend engine parser to extract `memory_tier` frontmatter
- **files**: `ralph-engine/packages/knowledge/src/parser.ts` (modify), `ralph-engine/packages/knowledge/src/types.ts` (modify), `ralph-engine/packages/knowledge/src/__tests__/parser.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [5.1]
- **acceptance**:
  - [ ] Engine's `ParsedDocument` type gains a `memoryTier: 'doc' | 'raw' | 'reflection' | 'wiki'` field (camelCase per engine convention)
  - [ ] Parser extracts `memory_tier` from frontmatter, validates against the enum, defaults to `'doc'`, coerces invalid values to `'doc'` with a warning (mirrors ralph-hero parser behavior exactly)
  - [ ] Unit test: frontmatter with `memory_tier: reflection` → `memoryTier === 'reflection'`
  - [ ] Unit test: frontmatter without `memory_tier` → `memoryTier === 'doc'`
  - [ ] Unit test: frontmatter with `memory_tier: bogus` → `memoryTier === 'doc'` AND a warning is emitted

#### Task 5.3: Add `memoryTier` filter to engine's search options
- **files**: `ralph-engine/packages/knowledge/src/fts-search.ts` (modify), `ralph-engine/packages/knowledge/src/vector-search.ts` (modify), `ralph-engine/packages/knowledge/src/hybrid-search.ts` (modify), associated tests (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [5.1]
- **acceptance**:
  - [ ] Each search module's options type accepts `memoryTier?: 'doc' | 'raw' | 'reflection' | 'wiki' | 'any'` (default `'any'` skips the clause)
  - [ ] WHERE clause appends `AND memory_tier = ?` when `memoryTier` is set to a non-`'any'` value
  - [ ] `'any'` and `undefined` produce queries byte-identical to today's queries (verified by SQL snapshot test or query-builder assertion)
  - [ ] Unit test (per file): seeded with 3 docs of varying tiers — `search("foo", { memoryTier: "reflection" })` returns only the reflection doc; `search("foo", { memoryTier: "any" })` returns all 3
  - [ ] Engine's `apps/wiki` (or any consumer) still works — no breaking signature changes; option is purely additive

#### Task 5.4: Add ralph-engine to dream-loop ingest config
- **files**: `scripts/dream/config.yaml` (modify, in ralph-hero)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `git_repos` list already contains `/Users/dubiel/projects/ralph-engine` (verified — line 12 of config.yaml). Confirm no change needed OR add documentation note explaining this is already configured
  - [ ] If a chunk table port is in scope (see Task 5.5), ensure the chunk table also picks up the engine corpus via the same ingest path

#### Task 5.5: (Optional) Port `chunks` table to engine
- **files**: `ralph-engine/packages/knowledge/src/sqlite-knowledge-store.ts` (modify), associated tests
- **tdd**: true
- **complexity**: medium
- **depends_on**: [5.1]
- **acceptance**:
  - [ ] Decision recorded in code or this plan: if engine indexes the same `~/projects/thoughts/dream-memories/` tree but does NOT need per-chunk granularity, skip this task and document the divergence
  - [ ] If chunk table IS ported: mirror ralph-hero's schema (`chunks (id, document_id, chunk_index, content, char_start, char_end, context_prefix)`) with the same `ON DELETE CASCADE` semantics
  - [ ] Engine vec index gets `chunkId` (`{docId}#c{index}`) granularity
  - [ ] If skipped, this task is closed with a note and the issue body's chunk-table reference is amended

#### Task 5.6: Update engine README
- **files**: `ralph-engine/packages/knowledge/README.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [5.1, 5.2, 5.3]
- **acceptance**:
  - [ ] README documents the new `memory_tier` column with the enum values
  - [ ] README links to ralph-hero's `scripts/dream/` as the canonical reflection-synthesis pipeline
  - [ ] README makes clear engine does NOT run reflection synthesis — engine consumes reflections written by ralph-hero's dream-loop
  - [ ] README documents the shared `~/projects/thoughts/dream-memories/` tree and how both surfaces index it independently

### Phase Success Criteria

#### Automated Verification:
- [ ] `cd ralph-engine && npm test -- packages/knowledge` — all tests pass (including new tier tests)
- [ ] `cd ralph-engine && npm run build` — no TS errors
- [ ] Engine schema migration applies cleanly: open a test DB, run migration, `sqlite3 <db> ".schema documents" | grep memory_tier` returns a match
- [ ] No regressions in existing engine tests

#### Manual Verification:
- [ ] Engine indexes a reflection produced by ralph-hero's dream-loop: write a test reflection to `~/projects/thoughts/dream-memories/reflections/2026/05/12/test.md`, run engine reindex, query engine's hybrid search with `memoryTier: "reflection"` → finds the reflection
- [ ] `apps/wiki` in engine still loads and serves (no schema-shape breakage)
- [ ] Engine and ralph-hero both index the same on-disk tree without contention (each maintains its own knowledge.db)

**Creates for next phase**: closes parent GH-1201. Engine surface gains tier-aware retrieval. The five-phase epic is complete.

---

## Integration Testing

- [ ] End-to-end smoke test: from a clean DB, run `dream-now`, verify all four tiers populate (`doc`/`raw`/`reflection` non-zero; `wiki` may be 0)
- [ ] Run `/ralph-hero:research` on a recent topic and confirm raw + reflection results appear
- [ ] Run `/ralph-hero:plan` and confirm wiki/reflection bias
- [ ] Run `/ralph-hero:impl` and confirm no raw leak
- [ ] Run `/ralph-hero:retro` end-to-end; verify agent memory file appears AND is reachable via `knowledge_search` after next reindex
- [ ] Fresh-machine simulation per Phase 4 acceptance criteria
- [ ] Cross-surface: write a reflection in ralph-hero, query it via ralph-engine

## References

- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1201
- Phase 1: https://github.com/cdubiel08/ralph-hero/issues/1203
- Phase 2: https://github.com/cdubiel08/ralph-hero/issues/1204
- Phase 3: https://github.com/cdubiel08/ralph-hero/issues/1205
- Phase 4: https://github.com/cdubiel08/ralph-hero/issues/1206
- Phase 5: https://github.com/cdubiel08/ralph-hero/issues/1207
- Prior research (reindex OOM): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-29-reindex-memory-profile.md
- Prior research (dreaming trail): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-dreaming-research-trail-and-self-containment.md
- Prior research (local LLM + embeddings): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-local-llm-delivery-truth-personal-dreams-team-memory.md
- Embedder hotspot: `plugin/ralph-knowledge/src/embedder.ts:23-43`
- Reindex loop: `plugin/ralph-knowledge/src/reindex.ts:97-256`
- Parser tier logic: `plugin/ralph-knowledge/src/parser.ts:130-144`
- DB upsert: `plugin/ralph-knowledge/src/db.ts:260-278`
- MCP tool registration pattern: `plugin/ralph-knowledge/src/index.ts:95-197`
- Ingest pipeline: `scripts/dream/ingest.py`
- Plist template: `scripts/dream/launchd/com.dubiel.dream-loop.plist.template`
- Engine knowledge store: `ralph-engine/packages/knowledge/src/sqlite-knowledge-store.ts`
- Stop hook precedent: `plugin/ralph-hero/skills/ralph-unblock/SKILL.md`
