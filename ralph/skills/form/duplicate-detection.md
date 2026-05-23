# Duplicate detection

This reference is consulted by `/ralph:form` Step 3 of the default flow. It carries the dedup strategy: codebase locator, codebase analyzer, thoughts locator, thoughts analyzer, issue keyword search, and optional knowledge-search.

## Strategy: parallel sub-task dispatch

Spawn the sub-tasks below in parallel, then wait for ALL to complete before synthesizing. The skill's allowed-tools includes the relevant `Agent` types and MCP tools.

### Codebase context (skip for `INPUT_TYPE == "research"`)

The research-doc input path already covers this in the doc itself; running these for research inputs duplicates work and bloats context.

- `Agent(subagent_type="ralph-hero:codebase-locator", prompt="Find where [idea topic] would live in the codebase")` — pinpoints the relevant area without reading full files.
- `Agent(subagent_type="ralph-hero:codebase-analyzer", prompt="What already exists related to [idea topic]? What patterns to build on?")` — identifies existing patterns and code to extend.

### Existing work (always)

- `Agent(subagent_type="ralph-hero:thoughts-locator", prompt="Find related ideas, research, and plans about [topic]")` — surfaces overlapping documents in `thoughts/shared/{ideas,research,plans}/`.
- `Agent(subagent_type="ralph-hero:thoughts-analyzer", prompt="Extract key decisions and prior art from documents about [topic]")` — dispatch on the top thoughts-locator findings.

### Existing issues (always)

Call `list_issues` with the idea topic as the `query` parameter:

- Duplicate or overlapping issues
- Related work already planned or in progress
- Parent epics this might fit under

### Knowledge-search dedup (optional)

If the `knowledge_search` MCP tool is available, search for matching ideas:

```
knowledge_search(query="[idea topic]", type="idea", limit=3)
```

If close matches are returned, surface them to the user with a build-on-or-new prompt: *"There's an existing idea that may overlap: `[path]` — [title]. Want to continue with a new idea or build on that one?"*

If `knowledge_search` is not available (no ralph-knowledge plugin installed), skip silently.

## Team isolation

**Do NOT pass `team_name` to any `Agent()` call.** This is the ADR-001 team-isolation convention — sub-agents start fresh and inherit only the prompt + tool list, not the parent's team context.

## Synthesis

After all sub-tasks complete, synthesize for Step 4 of the default flow:

- **Related existing work** — pull from thoughts-analyzer + list_issues output.
- **Potential duplicates** — surface high-confidence overlaps; mention the source (issue / plan / research).
- **Natural home** — name the epic or initiative this aligns with (from list_issues parent-epic search).
- **Complexity assessment** — XS / S / M / L / XL based on scope discovered in the codebase-analyzer findings.
