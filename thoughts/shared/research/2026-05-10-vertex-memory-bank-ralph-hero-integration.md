---
date: 2026-05-10
git_commit: a56ea7c0c103f24b0fd3a5cc7a784e016f2daeb7
branch: main
topic: "Vertex AI Agent Engine Memory Bank as an optional managed backend for ralph-hero research/planning/transcripts"
tags: [research, ralph-knowledge, memory-bank, vertex-ai, gemini-enterprise-agent-platform, activity-log, dream-loop, profiles, scope, embeddings]
status: complete
type: research
---

# Research: Vertex AI Agent Engine Memory Bank as an Optional Backend for ralph-hero

## Prior Work

- builds_on:: [[2026-04-16-local-llm-delivery-truth-personal-dreams-team-memory]] (research — primary evidence; locks ralph-knowledge as retrieval backend, names MCP as the stable contract, defines the "institutional knowledge service" framing for regulated deployment)
- builds_on:: [[2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop]] (plan — describes intent for memory_tier taxonomy, chunking, and dream-loop consolidation pipeline)
- builds_on:: [[2026-03-28-ralph-knowledge-multi-project-architecture]] (research — primary evidence; documents current 500-char truncation, global DB design, and the multi-project scoping question)
- builds_on:: [[2026-05-04-bq-vs-llm-ops-defense-brief]] (research — primary evidence; characterizes Gemini Enterprise Agent Platform's surface, the April 22, 2026 rebrand, and the "Langfuse layered on Vertex" pattern)
- builds_on:: [[2026-04-04-knowledge-aware-research-skills]] (research — primary evidence; documents how research/plan skills currently consume the knowledge graph through sub-agents)
- builds_on:: [[2026-04-26-dreaming-research-trail-and-self-containment]] (research — primary evidence; captures current dream-loop implementation status and the memory_tier parser write-path bug)
- builds_on:: [[2026-04-21-dark-factory-ontology-vertex-ai-iterate-until-good]] (research — secondary evidence; precedent for Claude + Vertex layering via `AnthropicVertex` client)
- builds_on:: [[2026-02-17-plan-4-memory-layer-state-coherence]] (plan — weak evidence; signals memory layer as a roadmap component for ralph-hero v3)

**Evidence weighting note**: `research` cites are primary evidence about what exists; `plan` cites describe intent and may diverge from shipped reality. Where this document refers to live behavior (e.g., the `memory_tier` taxonomy), it grounds claims in `db.ts` + parser source, not just the plan's CHECK constraint.

## Research Question

> Right now, whenever I use ralph-hero, I do feel like having a significant amount of research or planning docs within the repo allows ralph-hero to be more effective, but I would like to see how I could make this system, as an optional swap-in, more effective at scale.
>
> Could it be possible to have Claude Code transcripts be turned into a class-based format? Could it be possible to change research or plan files into memories? This would automatically vectorize them but not sure what would be the best way to handle particularly large plans or networks of related plans?

The user asked specifically about Google's Vertex AI Agent Engine Memory Bank (now branded under the Gemini Enterprise Agent Platform) as the candidate managed backend, supplying the full set of Memory Bank doc URLs.

## Summary

Memory Bank is a Vertex-managed, scope-isolated, fact-string memory store with optional schema-bound "Profile" memories. It auto-extracts facts from conversation events using Gemini, auto-vectorizes on write (embeddings are hidden), supports immutable revision history, and enforces access via IAM conditions on a scope dictionary capped at 5 key-value pairs. It has no concept of document chunking, no inter-memory links, and no local emulator — `InMemoryMemoryService` in the Agent Development Kit is a non-persistent test stub with no LLM extraction and no semantic search.

ralph-hero's research/planning system today is a local-first, file-grounded knowledge graph: markdown documents in `thoughts/shared/{research,plans,reviews,ideas}/` are indexed by the ralph-knowledge MCP server (SQLite + sqlite-vec + FTS5 + RRF + `Xenova/all-MiniLM-L6-v2` 384-dim embeddings + LLM reranker), with provenance partitioned across a `memory_tier` column (`doc` / `raw` / `reflection` / `wiki`) and relationships expressed through `builds_on::` / `tensions::` / `superseded_by::` / `post_mortem::` wikilinks. Claude Code transcripts are captured as JSONL activity-log events (`work` and `meta` categories) by a `PostToolUse` hook; dream-loop ingests gemma-lab sessions, git commits, and optional `simonw/llm` logs into `memory_tier=raw` markdown files, then clusters them with HDBSCAN and asks Gemma 4 26B to synthesize one `memory_tier=reflection` per cluster.

The two systems are not redundant — they answer different questions. Memory Bank answers "what does this agent know about this user/project across sessions?" with a managed Profile + fact-string substrate. ralph-knowledge answers "what does the codebase corpus say about this topic?" with a chunked-document graph. The prior-art corpus (specifically `2026-04-16-local-llm-delivery-truth...`) already commits to a split-seam architecture pattern with **ralph-knowledge as the retrieval backend, MCP as the stable contract, and external systems (Onyx EE in that doc) for permission-aware integration** — Memory Bank slots cleanly into the external-system role for cross-session personalization without requiring a swap-out of ralph-knowledge.

Five composition patterns are visible in the cross-product of capabilities: (1) additive feature-flagged dual-write, (2) activity-log mirror only, (3) Profile-only adoption for typed agent state, (4) nightly document-fact projection from `thoughts/shared/{research,plans}` into scoped Memory Bank memories, (5) full replacement of ralph-knowledge. The corpus's locked decisions (storage stack, MCP as stable contract, `knowledgeStore?: KnowledgeStore` optionality) rule out pattern 5 absent a superseding ADR. Patterns 1–4 are compatible with the existing decisions.

## Detailed Findings

### Area 1: Memory Bank's data model and API surface

Memory Bank is part of the Gemini Enterprise Agent Platform (GEAP), the April 22, 2026 rebrand of Vertex AI Agent Builder/Engine. Memory Bank and Sessions are enabled by default on any new Agent Platform instance — no separate provisioning step.

**Resources and operations:**

| Resource | Operations | Notes |
|---|---|---|
| Session | `CreateSession`, `AppendEvent`, `ListEvents` | All sessions require a `user_id`. |
| Event | `IngestEvents`, `direct_contents_source` | Gemini content shape: `{role: "user"|"model", parts: [{text}]}`; optional `event_id` for dedup. |
| Memory | `CreateMemory`, `GenerateMemories`, `RetrieveMemories`, `Delete`, `Purge` | `fact: string` + `scope: {k:v, ≤5}` + `topics: string[]`. |
| Profile | `RetrieveProfiles`, `Retrieve(memory_types=["STRUCTURED_PROFILE"])` | Pydantic schema; each field is a separate `STRUCTURED_PROFILE` memory under `(scope × schema_id)`. |
| Revision | `revisions.list`, `revisions.get`, `RollbackMemory` | Immutable; every mutation creates a new revision; 48h post-delete history retention. |
| IAM | `roles/aiplatform.memoryViewer|memoryEditor|memoryUser` | CEL conditions on `aiplatform.googleapis.com/memoryScope`; supports `==`, `startsWith()`, `in [...]`. |

**Scope semantics**: Scope is a dictionary capped at 5 key-value pairs; exact-match only at retrieval (no wildcards, no hierarchical scope queries). For each scope, Memory Bank maintains an isolated collection of memories. Scope is immutable post-creation — to re-scope a memory you delete and recreate.

**Retrieval shape**: `retrieve(scope, query, top_k=3, filter, metadata_filters)` returns `{memory, distance}` pairs sorted by ascending Euclidean distance against hidden embeddings. With no `query`, all matching memories for the scope are returned and `top_k` is ignored. `filter` is an EBNF expression over system fields (`create_time`, `update_time`, `fact`, `topics`); `metadata_filters` is a DNF expression over arbitrary KV metadata attached at write time. `fact=~".*allergies.*"` is keyword search inside the fact string.

**Generation pipeline**: Memory generation is asynchronous. Three source variants for `GenerateMemories`:
- `vertex_session_source` (pointer to an existing session) — Memory Bank's own LLM extracts facts.
- `direct_memories_source` — pre-extracted `{"fact": "..."}` list, bypasses extraction.
- `direct_contents_source` — raw event array, with `generation_trigger_config` controlling when extraction fires.

Trigger modes: event-count threshold, idle duration (minute granularity), fixed interval (minute granularity), force flush. If no trigger fires, all pending events are processed within 24 hours automatically. Generation is **selective** — only information matching configured memory topics is extracted; not all events produce memories.

**Consolidation**: When new extracted facts arrive, Memory Bank decides autonomously to create, update, or delete existing memories. Each operation produces a labeled `action` (`CREATED` / `UPDATED` / `DELETED`) in the response. Three metadata merge strategies are configurable: `MERGE` (default), `OVERWRITE`, `REQUIRE_EXACT_MATCH`. Consolidation resolves contradictions and deduplicates — it does not synthesize summaries across many memories into higher-level abstractions.

**Profiles**: Defined at instance configuration time using Pydantic classes with field-level descriptions. Each field becomes an independent `STRUCTURED_PROFILE` memory under the `(scope × schema_id)` identity; the union of field memories is the "profile." NL memory generation can be disabled per-instance if you want only structured output. Revisions are tracked at the field level.

**Pricing** (as of January 28, 2026, per Vertex pricing page referenced in the docs): $0.25 per 1,000 stored events or memories. Gemini inference for extraction and consolidation is billed separately at standard token rates. If agents are deployed on Agent Runtime: $0.0864 per vCPU-hour + $0.0090 per GB-hour. No stated free tier specific to Memory Bank.

**Local dev**: No emulator. `google.adk.memory.InMemoryMemoryService` is the local substitute for ADK tests: no persistence, no LLM extraction, no semantic search, basic keyword matching only. Real Memory Bank requires a live Vertex AI project with the Agent Platform API enabled and ambient cloud credentials.

**Security note**: The Memory Bank overview page explicitly calls out memory poisoning as a risk — false or malicious information injected into Memory Bank affects future agent sessions. Mitigations listed: Model Armor inspection, adversarial testing, sandboxed execution.

### Area 2: Concept map — Memory Bank vs ralph-hero (live)

| Concept | Memory Bank | ralph-hero today |
|---|---|---|
| Granular unit | Text fact string (plus `STRUCTURED_PROFILE` field memory) | Markdown document → 512-token chunks with 64-token overlap (post GH-761 Phase 1) |
| Identity / namespace | `scope: {k:v, ≤5, exact-match}` | None at retrieval layer (global `~/.ralph-hero/knowledge.db`); `memory_tier` partitions by provenance |
| Type system | Pydantic Profile schema (static schema, LLM-populated values) | `type` frontmatter (`research` / `plan` / `idea` / `review` / `report`) + `memory_tier` (`doc` / `raw` / `reflection` / `wiki`) |
| Relationships | None (memories are independent facts; `topics` is flat labeling) | Wikilink graph — `builds_on::`, `tensions::`, `superseded_by::`, `post_mortem::`, `untyped` |
| Vectorization | Automatic on write; embeddings hidden; embedding model configurable at instance creation | `Xenova/all-MiniLM-L6-v2` (384-dim) via `embedder.ts`; sqlite-vec vec0 virtual table; explicit `chunks` and `documents` tables |
| Search | Hybrid: scope-exact + semantic (Euclidean) + EBNF/DNF filters | Hybrid: FTS5 + vec0 cosine via RRF (K=60) + optional LLM reranker; MMR diversity flag |
| Conversation ingest | `IngestEvents` (Gemini turn shape); selective extraction | `record-activity.sh` → `~/.ralph-hero/activity/YYYY/MM/DD.jsonl`; `work`/`meta` category split |
| Consolidation | Built-in: extraction + merge LLM (CREATED/UPDATED/DELETED); profile field updates | Dream-loop: HDBSCAN clusters (UMAP-reduced) → Gemma 4 26B synthesizes one reflection per cluster → written to `memory_tier=reflection` markdown |
| Versioning | Immutable revision log per memory; 48h post-delete window; rollback supported | Git history of markdown files; no per-record revision table |
| Access control | IAM conditions on `memoryScope` attribute (CEL: `==`, `startsWith()`, `in [...]`) | None at retrieval layer (local single-user; OAuth/OBO scoped as Prototype C, not built) |
| Hosting | Vertex-managed; cloud-only | Local SQLite + local embeddings; runs offline; multi-project DBs are separate instances, not federated |
| Cost model | $0.25 per 1k items + Gemini tokens + runtime vCPU/hour if deployed | Laptop CPU + Gemma reflection LLM calls (also local) |

### Area 3: How Claude Code transcripts map to a class-based memory format

**Current capture pipeline** (ralph-hero):

- `plugin/ralph-hero/hooks/scripts/record-activity.sh` is wired to `PostToolUse` (matcher-less) and `SessionStart`. Each invocation appends one JSON object to `~/.ralph-hero/activity/YYYY/MM/DD.jsonl`. Events carry `ts`, `kind` (`tool_call` / `agent_dispatch` / `skill_invoke`), `tool`, `project`, `tool_input`, `tool_response`, and `category` (`work` for state-mutating tool calls, `meta` for read-only).
- `plugin/ralph-hero/mcp-server/src/lib/activity.ts` exposes pure functions (`readActivityLogSince`, `compactActivityEvent`); `plugin/ralph-hero/mcp-server/src/tools/activity-tools.ts` registers the `ralph_hero__recent_activity` MCP tool with optional `compact: true` projection (`~50%` byte reduction).
- `plugin/ralph-hero/hooks/scripts/cursor-advance-catch-up.sh` is a `PostToolUse` hook on `ralph_hero__recent_activity` that writes `~/.ralph-hero/cursors/catch-up.json` from `tool_response.cursor_advanced_to`.
- Catch-up skill at `plugin/ralph-hero/skills/catch-up/SKILL.md` reads the log, filters by `category: "work"`, synthesizes 2–4 sentence narrative.
- Retention: `plugin/ralph-hero/scripts/activity/logrotate.sh` prunes day files older than `RALPH_ACTIVITY_RETENTION_DAYS` (default 14).

**Mapping to Memory Bank**:

The translation is mechanical for the event ingest path. Each activity-log entry becomes a Memory Bank Event:

```python
# activity.jsonl entry → Memory Bank event
{
  "content": {
    "role": "user" if entry["kind"] == "user_prompt" else "model",
    "parts": [{"text": json.dumps(entry["tool_input"]) if entry["tool_input"] else entry["text"]}]
  },
  "event_id": entry["ts"]  # use timestamp for dedup
}
```

Scope encoding (5 KV cap is the design constraint to plan around):

```python
scope = {
  "user_id": "cdubiel08",
  "project": "ralph-hero",      # repo
  "github_project": "3",        # project board number
  "session_id": session_uuid    # optional; omit for cross-session memories
}
# 4 KV used; 1 slot reserved
```

`client.agent_engines.memories.ingest_events(...)` accepts the event array plus `generation_trigger_config`. With `event_count_threshold: 100` or `idle_duration_minutes: 5`, Memory Bank's extraction LLM autonomously decides what to persist. The selective extraction behavior ("only information judged valuable") means most `meta`-category activity events (Bash `ls`, Read on existing files) would likely not survive extraction — which mirrors what the activity log's own `work`/`meta` split is doing locally.

**The "class-based format"** the user asked about is the Memory Bank **Profile** primitive. A Pydantic schema declared at agent instance config time becomes the typed shape:

```python
class RalphHeroAgentProfile(BaseModel):
    current_project: Optional[str] = Field(description="GitHub project board the agent is operating on")
    active_issue: Optional[str] = Field(description="Issue currently in In Progress for the user")
    open_blockers: List[str] = Field(default_factory=list, description="Issues in Human Needed awaiting input")
    preferred_workflow_mode: Literal["interactive", "autonomous"] = Field(description="hero vs. ralph-hero:autopilot")
    last_session_summary: Optional[str] = Field(description="2-4 sentence catch-up narrative")
```

Each field becomes an independent `STRUCTURED_PROFILE` memory under `(scope × schema_id)`. The LLM keeps fields current as new events flow in; field-level revision history is queryable. The phrase "class-based format" maps precisely to this Pydantic class definition.

**Two granularity choices** for transcripts:

- **Raw event stream → Memory Bank handles extraction**: send activity-log entries through `IngestEvents`; let Memory Bank's Gemini extractor decide what becomes facts and what becomes profile field updates. Cheapest in code, most expensive in stored items (events count against the $0.25/1k storage charge before extraction filters them).
- **Pre-extracted facts → bypass extraction**: have ralph-hero's catch-up skill produce 2–4 sentence summaries (it already does this), pass them as `direct_memories_source: [{fact: "..."}]`. Profile updates would then need a separate `CreateMemory` call with `memory_types=["STRUCTURED_PROFILE"]`. More code, fewer stored items.

### Area 4: How research/plan files map to auto-vectorized memories

**Current state** (ralph-hero):

- Research docs live at `/Users/dubiel/projects/ralph-hero/thoughts/shared/research/` (project-local) and `/Users/dubiel/projects/thoughts/shared/research/` (global multi-repo corpus).
- Plan docs live at `thoughts/shared/plans/` (same dual-location pattern).
- Both follow `YYYY-MM-DD-GH-NNNN-description.md` naming and carry frontmatter with `date`, `type`, `tags`, `github_issue`, `status`.
- Body wikilinks declare relationships: `- builds_on:: [[doc-id]] — description`. Parser extracts these as `Relationship` records in `plugin/ralph-knowledge/src/parser.ts`.
- The full corpus (1,685 documents → 11,743 chunks per `2026-04-26-dreaming-research-trail-and-self-containment`) is reindexed by `plugin/ralph-knowledge/src/reindex.ts` into `~/.ralph-hero/knowledge.db`.
- Chunking is via `chunker.ts` (post-GH-761): 512-token chunks with 64-token overlap, contextual prefix injection via Anthropic's Contextual Retrieval prompt (feature-flagged on `RALPH_CONTEXTUAL_RETRIEVAL=1`).
- Search is hybrid: FTS5 (`search.ts`) + vec0 nearest-neighbor (`vector-search.ts`) combined via RRF with K=60 (`hybrid-search.ts`), then optional LLM reranker (`reranker.ts`).

**Auto-vectorization in Memory Bank**:

When you call `CreateMemory(fact="...")`, Memory Bank generates an embedding internally and stores it. Embeddings are not exposed in API responses — callers see only ranked fact strings and Euclidean distances. There is no API to retrieve raw embedding vectors.

**The structural mismatch**: Memory Bank memories are flat fact strings. Research docs are long-form (3,000–8,000 char average per `2026-03-28-ralph-knowledge-multi-project-architecture`), structured with headers, code references, and `builds_on::` wikilinks. Three mapping strategies are documented in the corpus:

1. **Doc-as-memory**: store the full doc body (or its summary) as a single fact. Compromises: facts longer than typical preserve some context but lose chunk-level retrieval; the wikilink graph collapses to `topics: ["builds_on:doc-id-1", "builds_on:doc-id-2"]` labels.

2. **Pre-process to fact statements**: extract N facts per doc (one per finding/decision/constraint). The plan GH-761 dream-loop already does this for `memory_tier=reflection` synthesis — the same LLM extraction prompt could feed Memory Bank. This pattern preserves semantic granularity but breaks doc atomicity.

3. **Hybrid (the corpus-favored pattern)**: ralph-knowledge stays as the document/graph store; Memory Bank stores **summaries** (title + abstract + key findings) with `metadata: {full_doc_url: "..."}` resolving back to ralph-knowledge for the body. This is the same split-seam pattern that `2026-04-16-local-llm-delivery-truth-personal-dreams-team-memory` already proposes (in that doc the external system is Onyx EE for SharePoint permission-sync; Memory Bank slots into the same role for cross-session personalization).

**Wikilink graph fidelity**: Memory Bank has no native concept of inter-memory links. The current relationship types — `builds_on`, `tensions`, `superseded_by`, `post_mortem`, `untyped` — would need to either (a) live in `metadata` filters and `topics` labels (lossy: filter-based traversal can find neighbors but cannot walk paths), or (b) stay in ralph-knowledge's graph (`plugin/ralph-knowledge/src/graph-builder.ts`, `traverse.ts`) with Memory Bank holding only flat facts.

The `2026-03-24-knowledge-graph-plugin-comparison` research already documents that ralph-knowledge's graph model is **not temporal** (no edge timestamps, facts append rather than update in place). Memory Bank's revision-per-mutation model is the inverse — per-fact temporal history without graph edges. The two are complementary along the time dimension.

### Area 5: How large plans and networks of related plans map

The user's question — "particularly large plans or networks of related plans" — surfaces three corpus-documented patterns:

**Pattern A — `plan-of-plans` decomposition**: large work is split into a parent plan + child plans linked via `add_sub_issue` / `add_dependency` GitHub Projects relationships. Example: `2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md` (type: `plan-of-plans`). The hierarchy lives in two places — GitHub Projects parent/child relationships, and the markdown plan documents' `builds_on::` cross-references.

**Pattern B — phased plans**: a single plan document carries multiple phases (e.g., the 11-phase GH-761 grouped plan). Phases share file ownership and verification steps. The plan is one document but its contents are intrinsically multi-phase.

**Pattern C — research-plan-review chains**: a research doc → plan doc → critique doc sequence, with `builds_on::` edges threading the chain.

**Memory Bank's affordances for these patterns**:

- **No native hierarchy primitive**. Memory Bank memories are independent. There is no parent-memory pointer, no memory tree, no recursive consolidation.
- **Topics labels can substitute for hierarchy with constraints**. A memory tagged `topics: ["plan:GH-0784", "phase:2", "component:vision"]` is findable via `filter="topics=~'.*GH-0784.*'"` — flat retrieval works, graph traversal does not.
- **Profiles can represent plan state as a typed record**. A `ProjectPlan` Profile schema could hold:
  ```python
  class ProjectPlan(BaseModel):
      plan_id: str
      current_phase: int
      total_phases: int
      child_plan_ids: List[str]
      parent_plan_id: Optional[str]
      decisions_locked: List[str]
      open_questions: List[str]
      status: Literal["draft", "in-progress", "complete", "superseded"]
  ```
  Hierarchy lives in `parent_plan_id` / `child_plan_ids` lists; traversal lives in application code. The LLM keeps fields current as session events arrive (e.g., "phase 3 complete" advances `current_phase`).
- **No reflection-of-reflections**. Memory Bank's consolidation handles dedup/contradiction within a scope, not synthesis across many memories into a higher-level abstraction. The dream-loop's `memory_tier=reflection` synthesis (`scripts/dream/reflect.py`) has no Memory Bank equivalent; it would need to run client-side, then write its output as memories via `CreateMemory` or `direct_memories_source`.

**Scope budget for plan networks**: scope is capped at 5 KV. A reasonable allocation:
```
{
  "user_id": "...",      # who
  "project": "ralph-hero",  # which repo
  "github_project": "3",    # which project board
  "epic_id": "GH-0965",     # parent of a feature tree
  "tier": "plan"            # or "research", "decision"
}
```
This forces a choice: per-plan scope (1 plan = 1 scope) gives clean isolation but breaks cross-plan retrieval; per-project scope (1 project = 1 scope) keeps cross-plan retrieval but mixes plans, research, and decisions. The corpus's `2026-04-16-local-llm-delivery-truth...` resolves this by treating the MCP shim as the unifying surface: scope choice is a backend detail, the agent sees a single retrieval API.

**A 1,685-document corpus at Memory Bank's $0.25/1k pricing**: ~$0.42/month for storage at current corpus size. If the dream-loop's reflection pass produces ~30 reflections/day, annual growth adds ~10,950 memories → ~$2.74/year of incremental storage. Cost is not the bottleneck at current scale; Gemini extraction token cost dominates if events are sent through the auto-extraction path.

### Area 6: Architectural composition patterns (documented, not recommended)

Five patterns are visible in the cross-product of Memory Bank's surface and ralph-hero's locked decisions. Listed in order of decreasing reversibility:

1. **Additive feature-flagged dual-write**. Keep all existing paths intact. Add `RALPH_MEMORY_BANK_ENABLED=true` env. When set, `record-activity.sh` (or a sidecar) also writes events to Memory Bank via `IngestEvents`. Disabling the flag is a no-op rollback. Compatible with all 6 locked decisions in `2026-04-16-local-llm-delivery-truth-personal-dreams-team-memory`'s "Prior Decisions Inventory."

2. **Activity-log mirror only**. Narrower than (1): mirror only `record-activity.sh` events, not document corpus. Profiles capture cross-session user state. Documents stay in ralph-knowledge. The wikilink graph is untouched. This is the "Memory Bank for personalization, ralph-knowledge for corpus" split-seam.

3. **Profile-only adoption**. Define 3–5 Profile schemas (`UserPreferences`, `ProjectState`, `OpenBlockers`, `SessionContext`, `WorkflowStateCache`). Memory Bank holds typed records; document corpus stays local. Useful if the user's primary pain is "the agent forgets what it knew last session" rather than "the corpus retrieval is incomplete."

4. **Nightly document-fact projection**. The dream-loop's reflection pass (`scripts/dream/reflect.py`) already extracts facts from clusters of raw memories. Add a parallel pass that extracts facts from `thoughts/shared/{research,plans}/` documents and writes them to Memory Bank with scoped tagging. Wikilinks become `topics` labels; full doc bodies stay in ralph-knowledge. Cost: one Gemini extraction call per doc per change-detected reindex pass.

5. **Full replacement of ralph-knowledge with Memory Bank**. Documented for completeness; ruled out by the corpus's locked decisions:
   - Storage stack lock: `sqlite-vec + FTS5 + RRF K=60 + all-MiniLM-L6-v2` is committed per `2026-04-16-local-llm-delivery-truth...` Prior Decisions Inventory. Swap requires a superseding ADR.
   - `knowledgeStore?: KnowledgeStore` must stay optional on `NodeContext`. Memory Bank is a remote network service; making it required breaks the offline-first guarantee.
   - Wikilink graph has no Memory Bank equivalent. Replacement loses `builds_on::` / `tensions::` traversal.
   - No emulator means offline development becomes impossible without dual-write or local fallback.

### Area 7: What the corpus's "Prior Decisions Inventory" says must be respected

From `2026-04-16-local-llm-delivery-truth-personal-dreams-team-memory` and `2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop`:

| Decision | Source | Renegotiable? |
|---|---|---|
| MCP is the stable contract; retrieval backend is replaceable | Doc 1 | No (architectural principle) |
| Storage stack locked: sqlite-vec + FTS5 + RRF K=60 + all-MiniLM-L6-v2 | Doc 1 | Requires superseding ADR |
| `knowledgeStore?: KnowledgeStore` stays optional on `NodeContext` | Doc 1 | Breaking-change guard |
| `memory_tier` CHECK is `('doc','raw','reflection')` (plan), but live schema includes `wiki` | Doc 3 + live `db.ts` | Live drift; not a hard lock |
| Per-project DB isolation: deferred, not decided | Docs 3, 4 | Open |
| OAuth / ACL: Prototype C scope, not built | Doc 3 | Open; Memory Bank's GCP IAM is one answer |
| `memory_tier=raw` files written to `thoughts/dream-memories/YYYY/MM/DD/` (fixed path) | Doc 3 | Soft (config could relax) |
| Cognee / Mem0 / Graphiti / Onyx CE: out of scope | Docs 1, 3 | Yes, by ADR |

Memory Bank is not named in the rule-out list. The corpus's stated objection to alternatives ("we extend ralph-knowledge instead") is about replacement, not about additive integration. Patterns 1–4 above are compatible with all 8 rows; pattern 5 requires renegotiating rows 1, 2, 3.

## Code References

**ralph-knowledge plugin (MCP server, indexer, search)**:
- `plugin/ralph-knowledge/src/index.ts` — entry point; registers `knowledge_search`, `knowledge_traverse`, `knowledge_memory_stats`, `knowledge_record_outcome`, `knowledge_query_outcomes`
- `plugin/ralph-knowledge/src/db.ts` — SQLite schema: `documents`, `chunks`, `doc_tags`, `relationships`; `memory_tier` column with CHECK constraint
- `plugin/ralph-knowledge/src/embedder.ts:24` — `MAX_CHARS = 500` truncation (pre-GH-761; replaced by chunker post-Phase-1)
- `plugin/ralph-knowledge/src/chunker.ts` — `RecursiveCharacterTextSplitter`, 512-token chunks, 64-token overlap
- `plugin/ralph-knowledge/src/parser.ts` — frontmatter + wikilink extraction (`builds_on::`, `tensions::`, `superseded_by::`, `post_mortem::`)
- `plugin/ralph-knowledge/src/search.ts` — FTS5 search
- `plugin/ralph-knowledge/src/vector-search.ts` — sqlite-vec cosine search
- `plugin/ralph-knowledge/src/hybrid-search.ts` — RRF (K=60) combiner
- `plugin/ralph-knowledge/src/reranker.ts` — LLM reranker (calls local OpenAI-compatible endpoint, e.g., Gemma 4 26B)
- `plugin/ralph-knowledge/src/graph-builder.ts` — graphology graph construction
- `plugin/ralph-knowledge/src/traverse.ts` — BFS/DFS along relationship edges
- `plugin/ralph-knowledge/src/reindex.ts` — full reindex orchestration

**Dream-loop pipeline**:
- `scripts/dream/ingest.py` — pulls 24h from gemma-lab, git, optional `simonw/llm`; writes `memory_tier=raw` markdown to `thoughts/dream-memories/YYYY/MM/DD/`
- `scripts/dream/reflect.py` — UMAP + HDBSCAN clustering, Gemma 4 26B synthesis, writes `memory_tier=reflection` to `thoughts/dream-memories/reflections/YYYY/MM/DD/`
- `scripts/dream/config.yaml` — dream-loop config (LLM endpoint, model, paths)
- `scripts/dream/logrotate.sh` — disk retention

**Activity log surface**:
- `plugin/ralph-hero/hooks/scripts/record-activity.sh` — PostToolUse + SessionStart writer
- `plugin/ralph-hero/hooks/scripts/cursor-advance-catch-up.sh` — cursor advance hook
- `plugin/ralph-hero/mcp-server/src/lib/activity.ts` — pure activity log functions
- `plugin/ralph-hero/mcp-server/src/tools/activity-tools.ts` — `recent_activity` tool registration; `compact: true` projection
- `plugin/ralph-hero/scripts/activity/logrotate.sh` — retention pruning (default 14d)
- `plugin/ralph-hero/skills/catch-up/SKILL.md` — narrative synthesis from activity log

**Research/plan storage and skills**:
- `thoughts/shared/research/` — research documents (31 files in global corpus; project-local copy in ralph-hero/)
- `thoughts/shared/plans/` — plan documents (10 files in global corpus; project-local copy in ralph-hero/)
- `plugin/ralph-hero/skills/form/SKILL.md` — idea → GitHub issue
- `plugin/ralph-hero/skills/plan/SKILL.md` — interactive plan author
- `plugin/ralph-hero/skills/research/SKILL.md` — interactive research author
- `plugin/ralph-hero/skills/ralph-plan/SKILL.md` — autonomous plan author
- `plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md` — epic decomposition author

**GitHub Projects V2 integration**:
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` — `save_issue`, `list_issues`, `get_issue`, `create_issue`
- `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts` — state machine; `WORKFLOW_STATE_TO_STATUS` mapping
- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts` — status sync, parent auto-advance

## Architecture Documentation

The corpus has converged on a layered architecture for memory and retrieval, articulated most clearly in `2026-04-16-local-llm-delivery-truth-personal-dreams-team-memory`:

**Layer 1: Storage** — local SQLite + sqlite-vec + FTS5. Locked. Schema versioned in `meta.schema_version`. Multi-project use is one DB per repo (no federation).

**Layer 2: Indexer** — `reindex.ts` walks configured roots, parses frontmatter + wikilinks via `parser.ts`, chunks via `chunker.ts`, embeds via `embedder.ts` (with optional contextual prefix via Anthropic Contextual Retrieval prompt), upserts into SQLite.

**Layer 3: Retrieval** — three-tier search (`search.ts` FTS5 + `vector-search.ts` vec0 + `hybrid-search.ts` RRF), optional MMR diversity, optional LLM reranker. Graph traversal via `graph-builder.ts` / `traverse.ts`.

**Layer 4: MCP surface** — five tools exposed (`knowledge_search`, `knowledge_traverse`, `knowledge_memory_stats`, `knowledge_record_outcome`, `knowledge_query_outcomes`). The MCP server is the stable contract per `2026-04-16-local-llm-delivery-truth...`.

**Layer 5: Memory tiers** — `documents.memory_tier` column partitions content by provenance: `doc` (curated `thoughts/`), `raw` (dream-loop ingest), `reflection` (dream-loop synthesis), `wiki` (curated personal entries). Tier is a retrieval-time filter, not a separate index.

**Cross-cutting: Session capture** — `record-activity.sh` writes JSONL activity log. `recent_activity` tool reads it. Catch-up skill synthesizes narratives. Cursor pattern (`~/.ralph-hero/cursors/catch-up.json`) tracks "what's new since last time I looked."

**Cross-cutting: Consolidation** — dream-loop (`scripts/dream/ingest.py` + `reflect.py`) runs nightly via launchd, produces one reflection per HDBSCAN cluster of recent raw memories.

Memory Bank, in this picture, is most naturally an **external Layer 6** (managed cross-session memory) reached through the MCP surface (Layer 4). Layers 1–3 stay local; Memory Bank handles state that benefits from being remote and shared (user prefs, cross-machine session continuity, IAM-scoped personalization).

## Historical Context (from thoughts/)

The corpus's thinking about memory layers traces back to:

- **`2026-02-17-plan-4-memory-layer-state-coherence`** (plan, feature decomposition of v3 architecture) — signaled "memory layer" as a first-class architectural component. De-prioritized per April 7 portfolio critique, but the framing persists.

- **`2026-03-22-memory-layer-wiki-inline-feedback`** (research) — explored a "wiki" tier and inline-feedback signal for ralph-engine. This is where the `memory_tier=wiki` value originated (predates the GH-761 plan's CHECK constraint, which omitted `wiki`).

- **`2026-03-24-knowledge-graph-plugin-comparison`** (research) — compared ralph-knowledge to `obra/knowledge-graph`, Graphiti, Zep. Concluded ralph-knowledge stays as the backend; Graphiti's temporal graph model was noted as a gap but not closed.

- **`2026-03-26-ralph-knowledge-architecture-for-engine-parity`** (research) — established the engine-parity targets (port to ralph-engine).

- **`2026-03-28-ralph-knowledge-multi-project-architecture`** (research) — surfaced the 500-char truncation, the global-DB design, and the open question on per-project isolation.

- **`2026-04-03-knowledge-implementation-comparison-obra-vs-ralph`** (research) — post-convergence comparison; confirmed the storage stack choice.

- **`2026-04-04-knowledge-aware-research-skills`** (research) — proposed Step 2.5 prior-art discovery using `knowledge_search` directly in research skills. The pattern shipped (it's in this very skill's instructions).

- **`2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop`** (plan, draft status) — flagship spec for chunking + memory tiers + dream-loop. The plan's CHECK constraint listed `('doc','raw','reflection')`; the live tool schema and CLAUDE.md include `wiki`. This discrepancy is noted in `2026-04-26-dreaming-research-trail-and-self-containment`.

- **`2026-04-21-dark-factory-ontology-vertex-ai-iterate-until-good`** (research) — proves precedent for Claude + Vertex layering via `AnthropicVertex` client. Memory Bank is not named, but the architectural approach (run Claude on Vertex, layer external services) is the same pattern that would host a Memory Bank integration.

- **`2026-05-04-bq-vs-llm-ops-defense-brief`** (research, 2026-05-04, most recent) — characterizes the Gemini Enterprise Agent Platform surface (Agent Studio, ADK, Agent Runtime, Agent Registry, Agent Identity, Evaluation, Observability, Optimizer). Memory Bank is not named in this doc but lives in the GEAP umbrella. The doc's central thesis — "Vertex for inference, Langfuse for the production loop, not Langfuse instead of Vertex" — is the additive-layering pattern that maps directly to a Memory Bank integration.

## Related Research

- [[2026-04-16-local-llm-delivery-truth-personal-dreams-team-memory]] — locked decisions, MCP-as-contract principle, OAuth/OBO design
- [[2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop]] — memory_tier taxonomy, dream-loop consolidation
- [[2026-03-28-ralph-knowledge-multi-project-architecture]] — current ralph-knowledge implementation
- [[2026-05-04-bq-vs-llm-ops-defense-brief]] — Gemini Enterprise Agent Platform surface
- [[2026-04-04-knowledge-aware-research-skills]] — research-skill knowledge integration
- [[2026-04-26-dreaming-research-trail-and-self-containment]] — dream-loop shipped status
- [[2026-04-21-dark-factory-ontology-vertex-ai-iterate-until-good]] — Vertex layering precedent
- [[2026-03-24-knowledge-graph-plugin-comparison]] — alternatives comparison (Graphiti, Zep)
- [[2026-02-17-plan-4-memory-layer-state-coherence]] — v3 memory layer roadmap context

## Open Questions

1. **Cost at full-corpus projection scale**. ~1,685 documents → ~$0.42/month storage at current size. Document-fact projection (Pattern 4) multiplies by N facts per doc and adds Gemini extraction token cost per change-detected reindex. A back-of-envelope estimate at expected throughput would clarify whether the cost ceiling is a constraint.

2. **Offline-first non-negotiability**. Memory Bank has no emulator; ADK's `InMemoryMemoryService` is a non-persistent test stub without semantic search. If "works on a plane" is a hard requirement (it's implied by the current local-SQLite architecture), only patterns 1 (additive dual-write) and 2 (activity-log mirror only) preserve that property without conditional code paths.

3. **Wikilink fidelity strategy**. Three options surfaced: (a) `topics` labels (lossy — filter-based neighbor finding only, no path traversal); (b) `metadata_filters` (more structured but still flat); (c) keep wikilinks in ralph-knowledge, store only flat facts in Memory Bank. Which one preserves enough graph semantics for the `prove-claim` pattern documented in `2026-04-04-knowledge-aware-research-skills`?

4. **Profile schema authorship boundary**. Pydantic schemas are defined at agent instance configuration time. Options: (a) committed to the plugin as a default schema set; (b) per-repo config in `.ralph-repos.yml`; (c) per-user config under `~/.ralph-hero/profiles/`. Each shapes who can extend the schema and how schema migrations work (Memory Bank profiles have revision history at the field level, so adding fields is non-breaking, but removing fields needs to interact with the 48h post-delete retention).

5. **Scope budget allocation**. 5 KV pairs is tight. Reasonable candidates: `user_id`, `project`, `github_project`, `epic_id`, `tier`. Per-session scoping would consume a slot; per-issue scoping would too. The choice constrains cross-X retrieval (cross-session, cross-issue, cross-project) because scope is exact-match. A scope-allocation ADR would resolve this once.

6. **Dream-loop interaction**. The dream-loop already does extraction-and-synthesis. If Memory Bank's auto-extraction is also enabled, two LLM extractors compete for what becomes durable memory. Pattern: either disable Memory Bank's auto-extraction (`direct_memories_source` only) and let the dream-loop be the single extractor, or disable the dream-loop's reflection pass on session data and let Memory Bank handle that, or run both on disjoint inputs.

7. **GEAP rebrand implications**. The "Vertex AI Agent Engine" name was rebranded to "Gemini Enterprise Agent Platform" on April 22, 2026 per `2026-05-04-bq-vs-llm-ops-defense-brief`. Memory Bank docs use the new URL path (`gemini-enterprise-agent-platform/scale/memory-bank`). Any SDK / library / Terraform reference to "agent engine" should be checked for the rebrand's effect on resource paths.

8. **Memory poisoning surface**. Memory Bank's overview docs explicitly call out memory poisoning as a risk. ralph-hero's local file-based system has lower poisoning surface (you control the disk, git tracks edits). A managed remote backend introduces a new attack vector if untrusted content enters the event stream. Worth scoping if any pattern includes ingesting third-party content (PR comments, external research links).

---

**Source URLs for Memory Bank (verified during this research)**:
- [Memory Bank Overview](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank)
- [Memory Bank Setup](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank/setup)
- [Memory Bank API Quickstart](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank/api-quickstart)
- [Memory Bank ADK Quickstart](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank/adk-quickstart)
- [Generate Memories](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank/generate-memories)
- [Ingest Events](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank/ingest-events)
- [Memory Profiles](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank/profiles)
- [Fetch Memories](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank/fetch-memories)
- [Memory Revisions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank/revisions)
- [IAM Conditions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank/iam-conditions)
