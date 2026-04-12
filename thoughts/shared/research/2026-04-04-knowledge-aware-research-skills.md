---
date: 2026-04-04
topic: "Improving research skills with ralph-knowledge MCP tools"
tags: [ralph-knowledge, research-skill, knowledge-graph, skill-quality, prove-claim]
status: complete
type: research
git_commit: 22a88633ef60046ddfc77c3d54fb6a70c3189acc
github_issue: 725
github_url: https://github.com/cdubiel08/ralph-hero/issues/725
---

# Research: Making Research Skills Knowledge-Aware

## Prior Work

- builds_on:: [[2026-04-03-knowledge-implementation-comparison-obra-vs-ralph]]
- builds_on:: [[2026-04-03-GH-0723-knowledge-quality-improvements]]
- builds_on:: [[2026-03-24-GH-0668-prove-claim-investigative-skill]]
- builds_on:: [[2026-03-09-GH-0551-autonomous-skills-knowledge-metadata]]
- builds_on:: [[2026-03-09-GH-0552-interactive-skills-knowledge-metadata]]
- builds_on:: [[2026-02-18-GH-0060-research-skill-missing-agents]]

## Research Question

ralph-knowledge now exposes 9 MCP tools (search, traverse, record/query outcomes, communities, central, bridges, paths, common) with a planned 10th (subgraph) and 11th (community singular) in GH-723. Neither research skill uses any of these tools directly, and the sub-agents they dispatch (thoughts-locator, thoughts-analyzer) only use 2 of 9. How can both `research` (interactive) and `ralph-research` (autonomous) skills become more intelligent consumers of the knowledge graph?

## Summary

The research skills have a **knowledge gap**: they produce documents that feed the knowledge graph but don't consume it during their own work. Meanwhile, `prove-claim` demonstrates sophisticated 7-tool graph usage with evidence weighting, degradation patterns, and anti-pattern guidance. The opportunity is to port prove-claim's patterns into the research workflow at three levels: (1) direct tool access in the skills themselves, (2) richer tool access in sub-agents, and (3) outcome-informed research using the pipeline ledger. The skill-creator evaluation framework suggests specific dimensions for measuring improvement: assertion-based pass rates on prior-work completeness, evidence quality scoring via blind comparison, and trigger evaluation for knowledge tool selection.

---

## Detailed Findings

### Current Knowledge Tool Usage Map

| Component | knowledge_search | knowledge_traverse | communities | central | bridges | paths | common | query_outcomes | record_outcome |
|---|---|---|---|---|---|---|---|---|---|
| `research` (interactive skill) | - | - | - | - | - | - | - | - | - |
| `ralph-research` (autonomous skill) | - | - | - | - | - | - | - | - | - |
| `research-agent` | - | - | - | - | - | - | - | - | - |
| `thoughts-locator` | yes | yes | - | - | - | - | - | - | - |
| `thoughts-analyzer` | yes | yes | - | - | - | - | - | - | - |
| `prove-claim` | yes | yes | yes | yes | yes | yes | yes | - | - |
| `ralph-postmortem` | - | - | - | - | - | - | - | - | yes |
| `hero` | yes | yes | - | - | - | - | - | - | - |
| `ralph-plan-epic` | yes | - | - | - | - | - | - | - | - |

Neither research skill has any knowledge MCP tools in its `allowed-tools` frontmatter. All knowledge access is indirect, through `thoughts-locator` and `thoughts-analyzer` sub-agents, which themselves only use search + traverse.

### The prove-claim Blueprint

prove-claim ([`plugin/ralph-hero/skills/prove-claim/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/22a88633ef60046ddfc77c3d54fb6a70c3189acc/plugin/ralph-hero/skills/prove-claim/SKILL.md)) is the most sophisticated knowledge graph consumer. Its patterns that are directly portable to research:

**1. Multi-entity search fanout** (Step 2): Decomposes a claim into 2-5 entities, searches each separately, cross-products the resulting document IDs for connection probing. Research could decompose a research question into topic entities the same way.

**2. Layered connection probing** (Step 3): Three complementary graph dimensions per document pair:
- `knowledge_paths` — any connecting route (structural)
- `knowledge_traverse` — typed semantic edges (semantic)
- `knowledge_common` — shared neighbor documents (contextual)

**3. Community scoping into centrality**: Uses `knowledge_communities` output to scope `knowledge_central` to a specific community ID, making PageRank locally meaningful rather than diluted across the whole graph.

**4. Betweenness as negative filter**: `knowledge_bridges` scores identify hub documents — paths through high-betweenness nodes are flagged as weak evidence.

**5. Two-pass reading**: Brief discovery (`knowledge_search` with `brief: true`) followed by `Read` only on selected documents. Saves context window.

**6. Evidence weighting by document type**: research > review > plan > idea. Directly influences confidence scoring.

**7. Graceful degradation**: Three named fallback modes for tool unavailability, parameter rejection, and empty results.

**8. Anti-patterns**: Five explicit warnings (community co-membership ≠ evidence, hub paths are weak, plans ≠ reality, path existence ≠ evidence, paraphrase ≠ evidence).

### Outcome Ledger — An Untapped Resource

The `outcome_events` table ([`db.ts:130-151`](https://github.com/cdubiel08/ralph-hero/blob/22a88633ef60046ddfc77c3d54fb6a70c3189acc/plugin/ralph-knowledge/src/db.ts#L130-L151)) records pipeline events with columns: `event_type`, `issue_number`, `component_area`, `estimate`, `verdict`, `drift_count`, `model`, `agent_type`, `iteration_count`. The `knowledge_query_outcomes` tool supports filtering and aggregation.

No research skill currently queries this data. For research that touches a specific component area, outcomes could reveal:
- Historical pass/fail rates for the component
- Average drift count (scope creep indicator)
- Which estimates proved accurate vs. inaccurate
- Which agent types and models performed best

The `knowledge_search` tool already enriches results with `outcomes_summary` when a document has a linked `github_issue` ([`index.ts:53-61`](https://github.com/cdubiel08/ralph-hero/blob/22a88633ef60046ddfc77c3d54fb6a70c3189acc/plugin/ralph-knowledge/src/index.ts#L53-L61)), so research documents about issues with prior pipeline history already surface this data — if the skill were calling `knowledge_search` directly.

### Upcoming Tools (GH-723) Relevant to Research

The [GH-723 quality improvements plan](https://github.com/cdubiel08/ralph-hero/blob/22a88633ef60046ddfc77c3d54fb6a70c3189acc/thoughts/shared/plans/2026-04-03-GH-0723-knowledge-quality-improvements.md) introduces two tools particularly useful for research:

1. **`knowledge_subgraph`** (Phase 2): Returns N-hop neighborhood as `{ nodes[], edges[] }` with edge context. This is exactly what a research skill needs to understand the document landscape around a topic — one call replaces multiple traverse + paths calls.

2. **`knowledge_community`** (singular, Phase 1): Fetch one community's full details by ID. Enables the community → centrality scoping pattern without the 318K response problem.

### Skill-Creator Evaluation Framework

The skill-creator plugin provides a structured evaluation approach. Applied to research skill improvement:

**Assertion dimensions** (what to test):
- Does the research skill find relevant prior research documents? (knowledge_search hit rate)
- Does the Files Affected section match actual file analysis? (codebase-locator agreement)
- Does the Prior Work section include all relevant `builds_on` links? (graph completeness)
- Does the skill use outcome data when available? (outcome enrichment)

**Improvement categories** (from skill-creator `agents/analyzer.md`):
- `instructions` — add guidance on when to use knowledge tools vs grep-based fallback
- `tools` — add knowledge MCP tools to allowed-tools
- `examples` — add example search/traverse sequences for common research patterns
- `error_handling` — add degradation paths for unavailable knowledge tools
- `structure` — add a "Knowledge Graph Context" step before sub-agent dispatch

**Benchmark metrics** to track:
- Prior-work completeness (% of relevant documents found by research vs. manual audit)
- Research time (does knowledge-aware research finish faster by avoiding redundant sub-agent work?)
- Token consumption (does brief-first pattern reduce context usage?)

---

## Improvement Opportunities

### Opportunity 1: Add Knowledge Tools to Skill Allowed-Tools

**Both research skills** need `knowledge_search`, `knowledge_traverse`, and `knowledge_query_outcomes` in their `allowed-tools` frontmatter. This enables the main research context to:
- Query prior research before spawning sub-agents (avoid duplicate work)
- Check outcome history for the component area being researched
- Verify sub-agent findings against the knowledge graph during synthesis

**Files:**
- `plugin/ralph-hero/skills/research/SKILL.md` — add to `allowed-tools` list (line 16-18)
- `plugin/ralph-hero/skills/ralph-research/SKILL.md` — add to `allowed-tools` list (line 30-45)
- `plugin/ralph-hero/agents/research-agent.md` — add to `tools` list (line 6)

### Opportunity 2: Knowledge-First Prior Art Discovery Step

Add a new step before sub-agent dispatch (between current Step 2 and Step 3 in both skills):

```
### Step 2.5: Knowledge Graph Prior Art Discovery

Before spawning sub-agents, query the knowledge graph directly:

1. Search for prior research: knowledge_search(query="[research topic]", type="research", brief=true)
2. Search for existing plans: knowledge_search(query="[research topic]", type="plan", brief=true)
3. If the issue has a component area, query outcomes:
   knowledge_query_outcomes(component_area="[area]", aggregate=true)

Use the results to:
- Skip sub-agent dispatch for topics already well-documented
- Target sub-agents at gaps not covered by existing research
- Include outcome history in the research document
```

This adapts prove-claim's multi-entity search fanout pattern for the research context.

### Opportunity 3: Enhance Sub-Agent Knowledge Tool Access

**thoughts-locator** currently has `knowledge_search` + `knowledge_traverse`. Add:
- `knowledge_communities` — find document clusters on the topic
- `knowledge_central` — find the most-cited documents in a cluster
- `knowledge_bridges` — find cross-cutting documents

**thoughts-analyzer** currently has `knowledge_search` + `knowledge_traverse`. Add:
- `knowledge_paths` — trace how documents relate to each other
- `knowledge_common` — find shared context between two documents
- `knowledge_query_outcomes` — check if prior research conclusions were validated

**Files:**
- `plugin/ralph-hero/agents/thoughts-locator.md` — add to `tools` (line 4)
- `plugin/ralph-hero/agents/thoughts-analyzer.md` — add to `tools` (line 4)

### Opportunity 4: Evidence Weighting for Prior Work

Adapt prove-claim's evidence weighting to the Prior Work section. When citing prior work, qualify by document type:

```markdown
## Prior Work

- builds_on:: [[prior-research-doc]] (research — primary evidence)
- builds_on:: [[prior-plan-doc]] (plan — describes intent, may not reflect outcome)
- tensions:: [[conflicting-idea-doc]] (idea — unvetted, but flags a considered alternative)
```

This helps planners who read the research document understand the reliability of cited prior work.

### Opportunity 5: Outcome-Informed Research Section

Add a new document section to the research template:

```markdown
## Pipeline History

Based on outcome_events for component area `src/tools/`:
- 12 total events, 8 passed, 2 failed, 2 needs_iteration
- Average drift count: 1.5 files
- Estimate accuracy: S issues took avg 45min, M issues took avg 2.5h
- Most common blocker: type errors in adjacent modules
```

This section would be populated by `knowledge_query_outcomes` with `aggregate: true` and the issue's component area as filter.

### Opportunity 6: Graceful Degradation Guidance

Neither research skill has fallback guidance for when knowledge tools are unavailable. Add a degradation section modeled on prove-claim's pattern:

```
## Knowledge Tool Degradation

If knowledge tools are unavailable (MCP server not running, tools not in allowlist):
- Fall back to thoughts-locator sub-agent (always works, uses grep/glob)
- Note in research document: "Knowledge graph unavailable — prior work discovery via file scan only"
- Skip outcome history section

If knowledge_search returns zero results:
- Try broader search terms (remove specific qualifiers)
- Fall back to grep-based search in thoughts/ directory
- Do not skip sub-agent dispatch — knowledge graph may be stale
```

### Opportunity 7: Brief-First Pattern for Sub-Agent Dispatch

Adopt prove-claim's two-pass approach:

1. Main research context does `knowledge_search(brief=true)` to get a quick topic landscape
2. Based on brief results, dispatch targeted sub-agents only for areas that need deep investigation
3. Sub-agents do full reads on specific documents

This avoids the current pattern where sub-agents redundantly scan the full thoughts directory.

### Opportunity 8: Knowledge Subgraph Integration (post-GH-723)

Once `knowledge_subgraph` ships (GH-723 Phase 2), research skills should use it as their primary prior-art tool. One call to `knowledge_subgraph(root="[relevant-doc-id]", depth=2)` returns the full document neighborhood with edges and context, replacing multiple traverse + paths calls.

### Opportunity 9: Record Research Outcomes

`knowledge_record_outcome` is only used by `ralph-postmortem`. Research skills should record events too:

```
knowledge_record_outcome(
  event_type="research_completed",
  issue_number=NNN,
  component_area="src/tools/",
  verdict="complete",
  duration_ms=elapsed,
  model="sonnet",
  agent_type="analyst"
)
```

This builds the outcome ledger that future research can query (Opportunity 5), creating a feedback loop.

### Opportunity 10: Skill-Creator Evaluation Suite

Create evals for the research skill using skill-creator's framework:

**Eval 1: Prior-work completeness**
- Prompt: "Research the caching system in ralph-hero"
- Assertions: Finds `cache.ts`, finds prior research docs about caching, Prior Work section has `builds_on` links

**Eval 2: Outcome integration**
- Prompt: "Research issue #651 (lock state enforcement)"
- Assertions: Includes pipeline history section, references prior implementation attempts

**Eval 3: Degradation handling**
- Prompt: Run with knowledge tools removed from allowlist
- Assertions: Still produces complete research, notes knowledge unavailability

---

## Code References

- Interactive research skill: [`plugin/ralph-hero/skills/research/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/22a88633ef60046ddfc77c3d54fb6a70c3189acc/plugin/ralph-hero/skills/research/SKILL.md)
- Autonomous research skill: [`plugin/ralph-hero/skills/ralph-research/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/22a88633ef60046ddfc77c3d54fb6a70c3189acc/plugin/ralph-hero/skills/ralph-research/SKILL.md)
- Research agent: [`plugin/ralph-hero/agents/research-agent.md`](https://github.com/cdubiel08/ralph-hero/blob/22a88633ef60046ddfc77c3d54fb6a70c3189acc/plugin/ralph-hero/agents/research-agent.md)
- Prove-claim skill: [`plugin/ralph-hero/skills/prove-claim/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/22a88633ef60046ddfc77c3d54fb6a70c3189acc/plugin/ralph-hero/skills/prove-claim/SKILL.md)
- thoughts-locator agent: [`plugin/ralph-hero/agents/thoughts-locator.md`](https://github.com/cdubiel08/ralph-hero/blob/22a88633ef60046ddfc77c3d54fb6a70c3189acc/plugin/ralph-hero/agents/thoughts-locator.md)
- thoughts-analyzer agent: [`plugin/ralph-hero/agents/thoughts-analyzer.md`](https://github.com/cdubiel08/ralph-hero/blob/22a88633ef60046ddfc77c3d54fb6a70c3189acc/plugin/ralph-hero/agents/thoughts-analyzer.md)
- Knowledge MCP server: [`plugin/ralph-knowledge/src/index.ts`](https://github.com/cdubiel08/ralph-hero/blob/22a88633ef60046ddfc77c3d54fb6a70c3189acc/plugin/ralph-knowledge/src/index.ts)
- Graph tools: [`plugin/ralph-knowledge/src/graph-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/22a88633ef60046ddfc77c3d54fb6a70c3189acc/plugin/ralph-knowledge/src/graph-tools.ts)
- Outcome events schema: [`plugin/ralph-knowledge/src/db.ts:130-151`](https://github.com/cdubiel08/ralph-hero/blob/22a88633ef60046ddfc77c3d54fb6a70c3189acc/plugin/ralph-knowledge/src/db.ts#L130-L151)
- GH-723 quality plan: [`thoughts/shared/plans/2026-04-03-GH-0723-knowledge-quality-improvements.md`](https://github.com/cdubiel08/ralph-hero/blob/22a88633ef60046ddfc77c3d54fb6a70c3189acc/thoughts/shared/plans/2026-04-03-GH-0723-knowledge-quality-improvements.md)

## Architecture Documentation

### Current Research → Knowledge Flow (One-Way)

```
Research skill → writes document → reindex → knowledge DB
                                                ↑ (no feedback loop)
Research skill → spawns thoughts-locator → knowledge_search + knowledge_traverse
Research skill → spawns thoughts-analyzer → knowledge_search + knowledge_traverse
```

### Proposed Research ↔ Knowledge Flow (Bidirectional)

```
Research skill → knowledge_search (prior art discovery)
             → knowledge_query_outcomes (pipeline history)
             → spawns targeted sub-agents (gap-filling only)
             → synthesis with knowledge verification
             → writes document → reindex → knowledge DB
             → knowledge_record_outcome (feedback loop)
```

## Historical Context (from thoughts/)

39 related documents exist in `thoughts/shared/`. Key lineage:
- March 2026: obra/knowledge-graph comparison drove a wave of 7+ implementation tickets (GH-664–673)
- March 9: Knowledge metadata alignment (GH-549–555) added type inference and frontmatter conventions
- March 24: Graph tools (communities, central, bridges, paths, common) shipped
- March 24: prove-claim skill implemented as the first sophisticated knowledge consumer
- April 3: obra comparison refresh identified 4 remaining quality gaps (GH-723)
- The research skills themselves have been improved before (GH-060 fixed missing agents, GH-564 added research-to-issue workflow) but never gained knowledge tool access

## Related Research

- [`thoughts/shared/research/2026-04-03-knowledge-implementation-comparison-obra-vs-ralph.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-03-knowledge-implementation-comparison-obra-vs-ralph.md) — Latest obra comparison
- [`thoughts/shared/research/2026-03-24-knowledge-graph-plugin-comparison.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-24-knowledge-graph-plugin-comparison.md) — Original obra comparison
- [`thoughts/shared/research/2026-03-24-GH-0668-prove-claim-investigative-skill.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-24-GH-0668-prove-claim-investigative-skill.md) — prove-claim design research
- [`thoughts/shared/research/2026-02-18-GH-0060-research-skill-missing-agents.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-18-GH-0060-research-skill-missing-agents.md) — Prior research skill fix

## Open Questions

1. Should knowledge tools be added directly to the research skills, or should a new dedicated sub-agent (e.g., `knowledge-researcher`) encapsulate knowledge graph queries? Adding tools directly is simpler but increases the skill's tool surface.
2. Should outcome recording happen automatically at the end of ralph-research (autonomous), or should it be opt-in? Automatic recording builds the ledger faster but adds a dependency on the knowledge MCP server being available.
3. How should the research skills handle the transition period before GH-723 ships? Should they be written against the current 9-tool surface and updated later, or designed with `knowledge_subgraph` in mind from the start?
4. What's the right balance between direct knowledge tool usage in the main context vs. delegation to sub-agents? More direct usage saves sub-agent overhead but consumes main context window.
