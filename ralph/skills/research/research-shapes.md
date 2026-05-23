# Research shapes

Sub-agent palette + dispatch patterns for `/ralph:research`. Consulted by Step 3 (default flow), Step 4 (autonomous flow), and Step 2 of `--mode prove` (only the knowledge-graph subset).

## Sub-agent palette

| Agent | Role | When to dispatch |
|---|---|---|
| `ralph-hero:codebase-locator` | Find WHERE files / components for a topic live | Always, when the question touches code |
| `ralph-hero:codebase-analyzer` | Understand HOW a specific component works (no critique) | Always, when the question is "how does X work" |
| `ralph-hero:codebase-pattern-finder` | Find similar implementations to model after | When researching a feature or refactor that needs precedent |
| `ralph-hero:thoughts-locator` | Discover existing research / plans / reviews / ideas | Always — historical context matters |
| `ralph-hero:thoughts-analyzer` | Extract key decisions / constraints / open questions from prior docs | When `thoughts-locator` returns documents worth deep-reading |
| `ralph-hero:web-search-researcher` | External documentation, best practices, APIs | Only when the user explicitly asks for external research; instruct the agent to return LINKS |

## Parallel dispatch rule

Dispatch all relevant agents **in a single message** via multiple `Agent()` tool calls. They run in parallel. Wait for ALL to complete before synthesizing — never proceed on partial results.

Do NOT pass `team_name` to any sub-agent call. Sub-agents must run outside any team context (ADR-001 — team isolation).

## Documentarian-not-critic constraint

Sub-agents document what IS, not what SHOULD BE. The agents themselves are coded to follow this rule, but restate the constraint in the dispatch prompt whenever you suspect the model might drift (e.g., when researching a known-problematic component the model might be tempted to flag instead of describe).

Phrasing that works: *"Document the current implementation without suggesting improvements or identifying issues. Map what exists, where it lives, and how it connects."*

## Knowledge-graph dispatch shape

When the ralph-knowledge MCP tools are available, run prior-art discovery before the parallel sub-agent dispatch (Step 2 in default flow, Step 3c/3d in autonomous flow). Brief-first pattern keeps context tight.

```
knowledge_recall(query="<topic>", role="researcher", type="research", brief=true)
knowledge_recall(query="<topic>", role="researcher", type="plan",     brief=true)
knowledge_query_outcomes(component_area="<area>", aggregate=true)  # if a component area is identifiable
knowledge_expert(domain="<domain>", issue_number=<NNN>, limit=5, recency_window_days=30)  # autonomous mode only; save the returned query_id for Step 8 outcome recording
```

Use results to:

- Skip dispatching `thoughts-locator` for topics already comprehensively covered by prior research.
- Target `thoughts-analyzer` at gap areas not covered by prior-art results.
- Include outcome trends in the research doc's Prior Work / Pipeline History sections.

If knowledge tools return zero results, broaden search terms (remove qualifiers, drop component prefixes), then fall back to `thoughts-locator` filesystem scan. Do NOT skip sub-agent dispatch on the basis of an empty knowledge result alone — the graph may be stale or sparsely indexed.

## Cross-repo addendum

If `.ralph-repos.yml` exists at the repo root, the issue may span multiple repos. Read the file (via `Read`, not `decompose_feature`) and parse the YAML for `localDir` paths and `pattern` definitions.

Signals that the issue is cross-repo:

- The issue body references files in other repos (e.g., "update the MCP server" when researching a skill issue).
- The body mentions repo names from the registry.
- Import paths or package references map to other repos.

When cross-repo scope is detected:

1. Pass the additional repo directories to sub-agents in their spawn prompts. Example:
   ```
   Additional repo directories to search:
   - ralph-hero: ~/projects/ralph-hero
   - landcrawler-ai: ~/projects/landcrawler-ai
   ```
2. Sub-agents use standard `Read`, `Grep`, `Glob` against those paths — no new tooling.
3. For autonomous mode: also run a cross-repo dependency-detection pass. Grep for import/require statements referencing each repo's package name across the other repos. Compare against the registry's `dependency-flow` edges. Flag discrepancies in the research doc under `## Dependency Discrepancy`.
4. File paths in the doc's `## Files Affected` section use the repo-qualified form (`ralph-hero:src/...`, `landcrawler-ai:src/...`) per `findings-format.md`.

If `.ralph-repos.yml` does not exist, proceed in single-repo mode — no special handling.

## Graceful degradation

| Failure mode | Fallback |
|---|---|
| Knowledge MCP unavailable | Skip Step 2 / Step 3c entirely; rely on `thoughts-locator` filesystem scan. Add footnote to doc Prior Work: *"Knowledge graph unavailable — prior work discovery via file scan only."* |
| `knowledge_recall` returns zero results | Broaden terms; fall back to grep over `thoughts/`. Do NOT skip sub-agent dispatch. |
| `knowledge_expert` unavailable or no domain extractable | Skip silently. Note in doc if recurring per-domain gaps emerge. |
| Web research requested but `web-search-researcher` agent unavailable | Run `WebSearch` / `WebFetch` directly from the main session; ensure links are captured in the doc. |
