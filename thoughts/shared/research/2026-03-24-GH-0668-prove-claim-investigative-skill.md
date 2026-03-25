---
date: 2026-03-24
github_issue: 668
github_url: https://github.com/cdubiel08/ralph-hero/issues/668
status: complete
type: research
tags: [ralph-knowledge, prove-claim, skill-definition, graph-tools, evidence-reasoning, mcp-tools]
---

# Research: ralph-knowledge prove-claim investigative skill

## Prior Work

- builds_on:: [[2026-03-24-knowledge-graph-plugin-comparison]]

## Problem Statement

Issue #668 asks for a `prove-claim` skill that uses graph tools (available after #666 lands) to do structured evidence-based reasoning through the research corpus. The skill should decompose a claim into entities, find them via search, trace connections via graph tools, read evidence content, and report with verdict, confidence, and caveats. The core design insight comes from obra's `prove-claim` pattern: *"Do not stop at 'a path exists' — read the content to verify the connection is semantically relevant."*

This is a pure skill definition task. No MCP server code changes are required — the skill drives existing and planned tools (`knowledge_search`, `knowledge_paths`, `knowledge_common`, `knowledge_communities`, `knowledge_bridges`, `knowledge_traverse`) through prose instructions.

## Current State Analysis

### Available MCP Tools (already in ralph-knowledge)

The `plugin/ralph-knowledge/src/index.ts` exposes four tools:

- `knowledge_search` — hybrid RRF search (FTS5 + vector), accepts `query`, `type`, `tags`, `limit`, `includeSuperseded`
- `knowledge_traverse` — recursive CTE traversal of typed relationships (`builds_on`, `tensions`, `superseded_by`), accepts `from`, `type`, `depth`, `direction`
- `knowledge_record_outcome` — writes pipeline outcome events
- `knowledge_query_outcomes` — reads pipeline outcome events

### Tools That Will Exist After Sibling Issues Land

The group (#663) includes these sibling issues that add graph tools as prerequisites:

| Issue | Adds |
|-------|------|
| #664 | All wiki links captured as untyped edges (dense graph) |
| #665 | Incremental mtime-based indexing |
| #666 | graphology algorithms: `knowledge_communities`, `knowledge_central`, `knowledge_bridges`, `knowledge_paths`, `knowledge_common` |
| #667 | `brief` mode for `knowledge_search` and `knowledge_traverse` |

Issue #668 (prove-claim) depends on #666 for graph tools — per the issue body: "Depends on graphology graph algorithms being available."

### Relationship Schema

`plugin/ralph-knowledge/src/db.ts` — `relationships` table:
```
source_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
target_id TEXT,
type TEXT CHECK(type IN ('builds_on', 'tensions', 'superseded_by'))
```

After #664 lands, untyped edges (wiki links) will also be stored — the dense graph needed for community detection and path finding.

### Parser Captures Only Typed Relationships

`plugin/ralph-knowledge/src/parser.ts` — `WIKILINK_REL_RE` matches only `builds_on::`, `tensions::`, `post_mortem::` prefixed wikilinks. All other `[[wikilinks]]` are ignored. After #664, a separate untyped-edge pass will capture the full link topology.

### Skill Location Convention

All ralph-hero skills live at `plugin/ralph-hero/skills/{skill-name}/SKILL.md`. There is currently no `prove-claim` skill. The skill system uses YAML frontmatter for tool allowlists, model selection, and hooks.

### obra prove-claim Pattern (Reference Implementation)

The obra skill uses exactly these 5 steps:
1. Decompose claim into entities and relationships
2. Find entities via `kg_search` (semantic first, then FTS for exact terms)
3. Find connections via `kg_paths`, `kg_communities`, `kg_bridges` (not just path existence — read edge context)
4. Read evidence content via `kg_node` (brief first, then full)
5. Report: verdict (supported/contradicted/insufficient/partial), evidence chains with quotes, confidence (0.0-1.0), caveats

Key anti-patterns documented in obra's skill:
- Community co-membership is not evidence
- Hub node paths are weaker than relevant summary node paths
- Attribution requires checking provenance fields, not just co-occurrence

### Our Document Types Differ From obra's Vault

obra's vault is freeform Obsidian notes (~3,300 files). Our corpus is structured:

| Path segment | Type | Semantics |
|---|---|---|
| `/research/` | research | Findings documents, prior art, decisions |
| `/plans/` | plan | Implementation plans with phases |
| `/ideas/` | idea | Unvetted proposals |
| `/reviews/` | review | Post-implementation reviews |
| `/reports/` | report | Outcome summaries |

This affects how the skill should interpret graph traversal:
- A path through `builds_on` edges is strong evidence of conceptual dependency
- A path through untyped wiki links (after #664) is moderate evidence
- Community co-membership alone is weak evidence
- `tensions` edges explicitly signal contradiction

## Key Discoveries

### 1. Skill Can Be Written Now, But Depends on #666 to Function

The SKILL.md can be authored and committed independently of the MCP server changes. However, the workflow steps that call `knowledge_paths`, `knowledge_common`, `knowledge_communities`, and `knowledge_bridges` will fail until #666 is deployed. This is acceptable — skills reference tools that may not exist yet.

The skill's `allowed-tools` frontmatter should list all graph tools including those from #666.

### 2. Our Document Types Require Adapted Verdict Logic

obra's prove-claim reports a single verdict. Our structured document types enable richer analysis:
- `research` documents are primary evidence
- `plan` documents describe intended future state (not current truth)
- `ideas` documents are proposals (weaker evidence than research)
- `reviews` may contradict plan documents (post-implementation divergence)

The skill should weight evidence by document type.

### 3. Brief Mode (#667) Is Essential for Efficient Graph Exploration

The prove-claim workflow involves potentially reading many documents to verify path quality. Without brief mode, every `knowledge_search` result returns full content, burning context. The skill should use brief mode for Step 2 (entity discovery) and Step 3 (connection finding), then switch to full reads only for confirmed evidence nodes in Step 4.

This creates a soft dependency: the skill can work without brief mode but will be significantly more expensive.

### 4. No Write Tools Needed

Unlike obra's skill which can annotate nodes, our prove-claim skill is purely investigative. It reads from the knowledge base and produces a verdict. No `knowledge_record_outcome` calls are needed in the skill itself (the caller can optionally record outcomes).

### 5. Skill Location: plugin/ralph-hero/skills/prove-claim/SKILL.md

Following the `plugin/ralph-hero/skills/{name}/SKILL.md` convention. This is a ralph-hero skill (not ralph-knowledge), since skills are defined in the hero plugin.

### 6. MCP Tool Names

After #666 lands, the expected MCP tool names (following `knowledge_*` naming convention from index.ts) will be:
- `knowledge_communities` — Louvain community detection
- `knowledge_central` — PageRank centrality
- `knowledge_bridges` — betweenness centrality for connector docs
- `knowledge_paths` — DFS all simple paths between two documents
- `knowledge_common` — shared connections between two documents

The skill should reference these exact names (they match the acceptance criteria in #666).

### 7. Relationship Type Constraints Create Sparse Graph

Currently the `relationships` table only stores 3 typed relationship types, and only when documents use the explicit `builds_on::`, `tensions::`, etc. prefixes. With ~200 documents and sparse typed links, the graph is too disconnected for meaningful path finding. After #664 captures all wiki links as untyped edges, the graph becomes dense enough for `knowledge_paths` and `knowledge_communities` to produce useful results.

This confirms the ordering: #664 (dense edges) → #666 (graph algorithms) → #668 (prove-claim skill).

## Potential Approaches

### Option A: Direct port of obra's prove-claim

Port the obra workflow verbatim, substituting `kg_*` tool names for `knowledge_*` names.

**Pros:** Proven pattern, minimal design work, quick to implement.

**Cons:** Ignores our structured document types, doesn't leverage `knowledge_traverse` for typed relationship chains, doesn't account for brief/full mode distinction.

### Option B: Adapted skill with document-type-aware evidence weighting

Write a prove-claim skill that:
1. Uses hybrid search for entity discovery (our RRF search is better than obra's split FTS/vector)
2. Uses both graph paths (`knowledge_paths`) AND typed traversal (`knowledge_traverse`) for connection finding
3. Weights evidence by document type: `research` > `review` > `plan` > `idea`
4. Uses brief mode for exploration, full reads for evidence extraction
5. Reports verdict + confidence + document-type-qualified evidence chains

**Pros:** Leverages our strengths (hybrid search, typed relationships, structured types). Produces higher-quality verdicts for our corpus.

**Cons:** More design complexity. Requires understanding the skill author to know our document semantics.

**Recommended approach.** The added complexity is contained within the SKILL.md prose instructions — implementation effort is the same as Option A.

### Option C: Two-pass skill (graph-guided reading)

Use graph tools only to generate a "reading list" (candidate documents), then have the model read each candidate and synthesize findings without graph-structured reporting.

**Pros:** Most natural for LLM reasoning, avoids forcing evidence into chain-shaped structures.

**Cons:** Less rigorous, prone to confabulation, doesn't match the structured verdict format from the acceptance criteria.

## Risk Analysis

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| #666 delayed, graph tools unavailable | Medium | Skill can reference tools that don't exist yet; it will fail gracefully with tool-not-found errors |
| Sparse graph (before #664) produces no paths | High | Skill should detect empty path results and fall back to `knowledge_traverse` typed chains |
| Context overrun from full document reads | Medium | Use brief mode (after #667) for exploration phase; full reads only for top evidence candidates |
| Claim decomposition produces entities that don't match document IDs | Medium | Use search (fuzzy) rather than direct ID lookups for entity finding |
| Document type weights are wrong for edge cases | Low | Weights are heuristics in prose; LLM can override based on content |

## Recommended Next Steps (Implementation Guide)

1. Create `plugin/ralph-hero/skills/prove-claim/SKILL.md`
2. Frontmatter: model=opus, allowed-tools includes all `knowledge_*` tools
3. Workflow steps:
   - Step 1: Accept a claim string. Decompose into 2-5 key entities and the relationship to investigate.
   - Step 2: Call `knowledge_search` for each entity. Use `brief: true` (when #667 available). Identify the best matching document IDs.
   - Step 3: Call `knowledge_paths` between entity pairs. Also call `knowledge_traverse` from each entity (outgoing + incoming typed links). Optionally call `knowledge_common` for shared connections. Review path quality.
   - Step 4: Select the top 3-5 documents on the strongest paths. Call `knowledge_search` (or direct read) with full mode to extract supporting quotes.
   - Step 5: Report — verdict (supported/contradicted/insufficient/partial), confidence (0.0-1.0), evidence chains with quotes, document type qualifications, caveats.
4. Anti-patterns section in skill prose (adapted from obra): community co-membership is not evidence; plan docs describe intent not truth; long paths through generic hubs are weak.
5. Note in skill: "Requires graphology tools from #666. Will fail at Step 3 if those tools are not deployed."

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/prove-claim/SKILL.md` - New skill definition (create)

### Will Read (Dependencies)
- `plugin/ralph-knowledge/src/index.ts` - MCP tool signatures to reference in allowed-tools
- `plugin/ralph-hero/skills/research/SKILL.md` - Structural reference for skill frontmatter pattern
- `plugin/ralph-knowledge/src/db.ts` - Document types and relationship schema
- `plugin/ralph-knowledge/src/parser.ts` - Understanding of typed vs untyped edges
