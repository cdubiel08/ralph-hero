---
date: 2026-03-24
status: draft
type: plan
github_issue: 668
github_issues: [668]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/668
primary_issue: 668
tags: [ralph-knowledge, prove-claim, skill-definition, graph-tools, evidence-reasoning]
---

# Prove-Claim Investigative Skill - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-24-GH-0668-prove-claim-investigative-skill]]
- builds_on:: [[2026-03-24-knowledge-graph-plugin-comparison]]

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-668 | ralph-knowledge: prove-claim investigative skill | S |

## Shared Constraints

- **Pure skill definition**: This is a SKILL.md file only -- no MCP server code changes, no TypeScript, no build artifacts. The skill drives existing and planned MCP tools through prose instructions.
- **Skill location convention**: All ralph-hero skills live at `plugin/ralph-hero/skills/{skill-name}/SKILL.md` with YAML frontmatter for model selection, allowed-tools, and hooks.
- **MCP tool naming**: Knowledge tools use the `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_*` prefix in allowed-tools frontmatter (matching the pattern in [hero/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/hero/SKILL.md)).
- **Dependency on #666**: The skill references graph tools (`knowledge_communities`, `knowledge_central`, `knowledge_bridges`, `knowledge_paths`, `knowledge_common`) that will be added by #666. The skill can be authored and committed before those tools exist -- skills are allowed to reference tools that are not yet deployed.
- **Soft dependency on #667**: Brief mode for `knowledge_search` and `knowledge_traverse` is planned in #667. The skill should instruct the model to use brief mode when available but degrade gracefully when it is not.
- **obra prove-claim as reference**: The 5-step pattern (decompose, find entities, find connections, read evidence, report) from [obra/knowledge-graph](https://github.com/obra/knowledge-graph) is the structural foundation, adapted for our structured document types and typed relationships.
- **Document type evidence weighting**: Our corpus uses structured document types with different evidentiary value: `research` (primary evidence, findings and decisions) > `review` (post-implementation observations) > `plan` (intended future state, not current truth) > `idea` (unvetted proposals, weakest evidence).

## Current State Analysis

The ralph-knowledge plugin currently exposes 4 MCP tools: `knowledge_search` (hybrid RRF search), `knowledge_traverse` (recursive CTE traversal of typed relationships), `knowledge_record_outcome`, and `knowledge_query_outcomes`. The `relationships` table stores 3 typed edge types (`builds_on`, `tensions`, `superseded_by`).

After sibling issues in the #663 group land, the knowledge plugin will gain dense untyped edges (#664), incremental indexing (#665), graphology algorithms (#666: `knowledge_communities`, `knowledge_central`, `knowledge_bridges`, `knowledge_paths`, `knowledge_common`), and brief/full mode (#667). The prove-claim skill is the primary consumer of these graph tools.

No `prove-claim` skill exists today. The closest existing patterns are skills that use `knowledge_search` for document discovery (e.g., `ralph-research`, `hero`, `ralph-plan-epic`), but none perform structured multi-step evidence reasoning through the knowledge graph.

## Desired End State

### Verification
- [ ] `plugin/ralph-hero/skills/prove-claim/SKILL.md` exists with valid YAML frontmatter
- [ ] Skill defines a 5-step workflow: decompose, find entities, find connections, read evidence, report
- [ ] Allowed-tools list includes all current and planned knowledge tools
- [ ] Anti-patterns section warns against community co-membership as evidence, hub node path weakness, and plan-doc-as-truth errors
- [ ] Document type evidence weighting is documented in the skill prose
- [ ] Report format includes verdict, confidence, evidence chains with quotes, and caveats

## What We're NOT Doing

- Not modifying the ralph-knowledge MCP server (no TypeScript changes)
- Not implementing the graphology tools (#666) -- the skill references them but does not create them
- Not implementing brief mode (#667) -- the skill instructs the model to use it when available
- Not creating tests (SKILL.md files are not testable via automated suites)
- Not adding hooks for this skill in the initial version (can be added later if misuse patterns emerge)
- Not building a CLI or invocation wrapper -- the skill is invoked through the standard skill system

## Implementation Approach

This is a single-phase implementation: create the SKILL.md file with the complete skill definition. The skill is self-contained prose that instructs the LLM on how to conduct structured evidence reasoning using knowledge graph tools. The implementation is mechanical -- translating the research findings into the skill frontmatter + markdown template.

The skill adapts obra's 5-step prove-claim pattern with three key additions: (1) document-type-aware evidence weighting, (2) dual path finding using both graph algorithms and typed relationship traversal, and (3) graceful degradation when graph tools are not yet deployed.

---

## Phase 1: Create prove-claim skill definition (GH-668)

### Overview

Create the complete SKILL.md for the prove-claim investigative skill, including YAML frontmatter with model selection and tool allowlists, the 5-step investigation workflow, evidence weighting rules, anti-patterns, and the structured report format.

### Tasks

#### Task 1.1: Create SKILL.md with frontmatter
- **files**: `plugin/ralph-hero/skills/prove-claim/SKILL.md` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/skills/prove-claim/SKILL.md`
  - [ ] YAML frontmatter includes `description` field explaining the skill's purpose (evidence-based reasoning through knowledge graph)
  - [ ] `model: opus` is set (investigative reasoning requires strong model)
  - [ ] `user-invocable: true` is set (this is a user-facing skill)
  - [ ] `argument-hint` is set to `"<claim to investigate>"` or similar
  - [ ] `context: fork` is set (skill runs in a forked context to avoid polluting main conversation)
  - [ ] `allowed-tools` list includes all of these tools:
    - `Read` (for reading document files directly)
    - `Glob` (for finding documents on disk)
    - `Grep` (for searching document content)
    - `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search`
    - `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_traverse`
  - [ ] `allowed-tools` list also includes these planned tools (will be available after #666):
    - `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_communities`
    - `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_central`
    - `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_bridges`
    - `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_paths`
    - `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_common`
  - [ ] No ralph_hero project management tools are included (this skill is read-only, investigative)

#### Task 1.2: Write the 5-step investigation workflow
- **files**: `plugin/ralph-hero/skills/prove-claim/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Step 1 (Decompose): Instructs the model to accept a claim string and decompose it into 2-5 key entities and the relationship(s) to investigate. Entities should be concept names, document topics, or technical terms that map to documents in the knowledge base.
  - [ ] Step 2 (Find Entities): Calls `knowledge_search` for each entity with appropriate type filters. Uses brief mode when available (`brief: true` parameter from #667). Instructs the model to try both semantic query and exact term search if semantic returns no results. Records the best-matching document IDs for each entity.
  - [ ] Step 3 (Find Connections): Calls `knowledge_paths` between entity document pairs to find graph paths. Also calls `knowledge_traverse` from each entity document (both `outgoing` and `incoming` directions, typed relationships). Optionally calls `knowledge_common` for shared connections between entity pairs. Instructs the model to assess path quality -- a path through relevant summary documents is stronger than a path through generic hub nodes.
  - [ ] Step 4 (Read Evidence): Selects the top 3-5 documents on the strongest paths. Reads full content (via `knowledge_search` with the document ID or via `Read` tool on the file path). Extracts specific quotes that support or contradict the claim.
  - [ ] Step 5 (Report): Produces a structured report with: verdict (`supported`, `contradicted`, `insufficient`, `partial`), confidence (0.0-1.0), evidence chains with document citations and quotes, document-type qualifications, and caveats.

#### Task 1.3: Write evidence weighting and anti-patterns sections
- **files**: `plugin/ralph-hero/skills/prove-claim/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] Evidence weighting section documents the hierarchy: `research` docs are primary evidence (findings, prior art, decisions); `review` docs are secondary evidence (post-implementation observations that may contradict plans); `plan` docs describe intended future state and should NOT be treated as evidence of current truth; `idea` docs are proposals with the weakest evidentiary value.
  - [ ] Anti-patterns section includes at minimum:
    - Community co-membership alone is NOT evidence of a relationship (two documents in the same community may have no relevant connection)
    - Paths through high-degree hub nodes (documents linked to many others) are weaker evidence than paths through topically relevant documents
    - A `plan` document describing Feature X does NOT prove Feature X exists or works -- plans describe intent, not reality
    - Path existence alone is insufficient -- the model must read the documents along the path and verify the connection is semantically relevant to the claim
    - Attribution requires checking provenance fields and quotes, not just co-occurrence of terms
  - [ ] A note is included stating: "This skill requires graph algorithm tools from #666. Steps 3 will partially fail if those tools are not deployed. In that case, fall back to `knowledge_traverse` for typed relationship chains and `knowledge_search` for broader discovery."

#### Task 1.4: Write graceful degradation and edge case handling
- **files**: `plugin/ralph-hero/skills/prove-claim/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] Skill instructs the model on graceful degradation when graph tools are unavailable: if `knowledge_paths` returns a tool-not-found error, fall back to `knowledge_traverse` with `builds_on` type at depth 3 from each entity, supplemented by `knowledge_search` queries combining entity terms
  - [ ] Skill instructs the model on graceful degradation when brief mode is unavailable: if `brief: true` parameter is not accepted, proceed with full content results but limit entity search to 5 results per query to manage context
  - [ ] Skill handles the case where entity decomposition produces terms that match zero documents: instruct the model to broaden the search terms, try related concepts, and if still no matches, report "insufficient evidence" with an explanation of what was searched
  - [ ] Skill handles the case where paths exist but all intermediate documents are unrelated to the claim: instruct the model to report this as weak/insufficient evidence rather than treating path existence as confirmation
  - [ ] Skill includes a "Confidence Calibration" subsection explaining what drives confidence levels: high (0.8-1.0) requires multiple corroborating research documents with direct quotes; medium (0.5-0.7) has some supporting evidence but gaps or only indirect connections; low (0.2-0.4) has sparse evidence, mostly from weak document types or long indirect paths; insufficient (0.0-0.1) means no meaningful evidence found

### Phase Success Criteria

#### Automated Verification:
- [ ] `ls plugin/ralph-hero/skills/prove-claim/SKILL.md` -- file exists (no build/test commands apply to skill definitions)

#### Manual Verification:
- [ ] YAML frontmatter parses correctly (valid YAML with expected fields)
- [ ] All 5 workflow steps are present and clearly described
- [ ] Evidence weighting hierarchy is documented
- [ ] At least 4 anti-patterns are documented
- [ ] Graceful degradation instructions cover missing graph tools and missing brief mode
- [ ] Report format includes all required fields (verdict, confidence, evidence chains, caveats)
- [ ] Allowed-tools list includes both current and planned knowledge tools

---

## Integration Testing

- [ ] YAML frontmatter is valid and parseable (no syntax errors)
- [ ] All tool names in `allowed-tools` use the correct `mcp__plugin_ralph-knowledge_ralph-knowledge__` prefix matching the convention in `plugin/ralph-hero/skills/hero/SKILL.md`
- [ ] Skill prose references tool names consistently with frontmatter allowed-tools (e.g., `knowledge_search` in prose maps to the full MCP tool name in frontmatter)
- [ ] No references to tools not in the allowed-tools list
- [ ] Skill file follows the same structural pattern as existing skills (frontmatter, title, purpose, workflow steps)

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-24-GH-0668-prove-claim-investigative-skill.md
- Parent research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-24-knowledge-graph-plugin-comparison.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/668
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/663
- obra prove-claim pattern: https://github.com/obra/knowledge-graph
- Existing skill reference: [plugin/ralph-hero/skills/hero/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/hero/SKILL.md) (knowledge tool naming)
- Knowledge plugin tools: [plugin/ralph-knowledge/src/index.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts)
