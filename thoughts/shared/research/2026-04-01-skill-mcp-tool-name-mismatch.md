---
date: 2026-04-01
github_issue: 714
github_url: https://github.com/cdubiel08/ralph-hero/issues/714
topic: "Skill SKILL.md files reference MCP tools by short names that ToolSearch cannot resolve"
tags: [research, skills, mcp, tool-names, toolsearch, bug]
status: complete
type: research
git_commit: 77b675ae380ea1524d8273d9eb858067bbf09317
---

# Research: Skill MCP Tool Name Mismatch Causes ToolSearch Failures

## Prior Work

None found.

## Research Question

When `/ralph-hero:plan` is invoked (ingesting from a plan file), it fails to call MCP tools. Claude uses ToolSearch to resolve the deferred tools but gets no hits because the tool name literals in SKILL.md don't match the actual deferred tool names. What is the mismatch, and how widespread is it?

## Summary

Every ralph-hero skill that references MCP tools uses **short-form** names (e.g., `ralph_hero__get_issue`) in both the `allowed-tools` frontmatter and inline body text. However, the actual deferred tool names visible to ToolSearch use the **fully-qualified** form: `mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue`. When Claude reads the skill body and tries to call a tool by its short name, ToolSearch cannot find it because the deferred tool list only contains long-form names.

## The Name Construction

Claude Code constructs deferred MCP tool names using this formula:

```
mcp__plugin_{plugin-name}_{server-key}__{registered-tool-name}
```

For ralph-hero tools:
- Plugin name: `ralph-hero` (from `plugin.json`)
- Server key: `ralph-github` (from `.mcp.json`)
- Registered name: `ralph_hero__get_issue` (from `server.tool()` in MCP server)
- **Result**: `mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue`

For ralph-knowledge tools:
- Plugin name: `ralph-knowledge`
- Server key: `ralph-knowledge`
- Registered name: `knowledge_search`
- **Result**: `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search`

## Detailed Findings

### The Failure Scenario

1. Skill is invoked, its SKILL.md content is injected into the conversation
2. `allowed-tools` gates which tools the skill can use (permission check only -- does not load deferred tools)
3. Claude reads the skill body and sees instructions like `ralph_hero__get_issue(number=NNN)`
4. Claude tries to call this tool, but it's deferred (not yet loaded into the conversation)
5. Claude uses ToolSearch to resolve it, searching for `ralph_hero__get_issue`
6. ToolSearch looks at the deferred tool list which contains `mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue`
7. **No match** -- the short name doesn't resolve to the long-form deferred name
8. Claude concludes the tool doesn't exist and skips the MCP call entirely

### Affected Skills (ralph-hero tools referenced by short name)

Every ralph-hero skill that calls MCP tools is affected. The `allowed-tools` frontmatter and inline body references all use the short form `ralph_hero__*`:

| Skill | Tools Referenced (short form) |
|-------|-------------------------------|
| `plan` | `ralph_hero__get_issue`, `create_comment`, `save_issue`, `create_issue`, `list_issues` |
| `hero` | 13 ralph-hero tools (all short form) |
| `team` | `get_issue`, `pipeline_dashboard`, `detect_stream_positions`, `pick_actionable_issue`, `create_issue` |
| `impl` | `get_issue`, `list_issues`, `save_issue`, `create_comment`, `list_sub_issues` |
| `ralph-impl` | same as `impl` |
| `ralph-plan` | `get_issue`, `list_issues`, `save_issue`, `create_comment`, `sync_plan_graph` |
| `ralph-plan-epic` | 8 ralph-hero tools (short form) |
| `ralph-triage` | 8 ralph-hero tools |
| `ralph-split` | 8 ralph-hero tools |
| `ralph-research` | 6 ralph-hero tools |
| `ralph-review` | 4 ralph-hero tools |
| `ralph-merge` | 6 ralph-hero tools |
| `ralph-pr` | 5 ralph-hero tools |
| `ralph-val` | 2 ralph-hero tools |
| `ralph-hygiene` | 3 ralph-hero tools |
| `form` | 6 ralph-hero tools |
| `research` | 3 ralph-hero tools |
| `iterate` | 3 ralph-hero tools |
| `bridge-artifact` | 2 ralph-hero tools |
| `hello` | `pipeline_dashboard` |
| `status` | `pipeline_dashboard` |
| `report` | `pipeline_dashboard`, `create_status_update` |
| `setup` | `health_check`, `get_project`, `setup_project` |
| `setup-repos` | 5 ralph-hero tools |
| `record-demo` | 2 ralph-hero tools |
| `prove-claim` | 0 ralph-hero tools (knowledge only) |

**26 skills** reference ralph-hero MCP tools by short name.

### Skills That Already Use Correct Long-Form Names

Three skills reference **ralph-knowledge** tools using the correct fully-qualified form in `allowed-tools`:

| Skill | Knowledge Tools (long form in frontmatter) |
|-------|---------------------------------------------|
| `prove-claim` | 7 knowledge tools, all `mcp__plugin_ralph-knowledge_ralph-knowledge__*` |
| `hero` | `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search`, `knowledge_traverse` |
| `ralph-plan-epic` | `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search` |

These work correctly because they match the deferred tool name format.

### Inconsistency in Knowledge Tool References

Even within skills that use long-form names in `allowed-tools` for knowledge tools, the **inline body** text often uses bare names:
- `knowledge_search(query="...")` -- bare, no prefix
- `knowledge_traverse(...)` -- bare, no prefix

This means even knowledge tools may fail ToolSearch when referenced inline.

Skills that reference knowledge tools as bare names in body text only:
`form`, `ralph-impl`, `ralph-plan`, `ralph-review`, `ralph-triage`, `research`, `ralph-postmortem`, `ralph-plan-epic`

### The `ralph-postmortem` Special Case

`ralph-postmortem` lists `knowledge_record_outcome` as a **bare name** in `allowed-tools` -- neither short form (`ralph_hero__` prefix) nor long form (`mcp__plugin_*` prefix). This is a third naming variant.

## Code References

- MCP server tool registration: `plugin/ralph-hero/mcp-server/src/index.ts:133` (health_check), `src/tools/issue-tools.ts:61` (list_issues), etc.
- Plugin name: `plugin/ralph-hero/.claude-plugin/plugin.json:2` -- `"name": "ralph-hero"`
- Server key: `plugin/ralph-hero/.mcp.json:3` -- `"ralph-github": { ... }`
- Knowledge server key: `plugin/ralph-knowledge/.mcp.json:3` -- `"ralph-knowledge": { ... }`
- Skill permissions spec: `specs/skill-permissions.md:36` -- documents `ralph_hero__*` pattern

## Architecture Documentation

### Three Naming Layers

| Layer | Name Format | Example |
|-------|------------|---------|
| MCP server registration | `ralph_hero__get_issue` | `server.tool("ralph_hero__get_issue", ...)` |
| Skill `allowed-tools` | `ralph_hero__get_issue` (short) | Only a permission gate |
| Deferred tool list (ToolSearch) | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue` | What ToolSearch indexes |

The gap is between layers 2 and 3. Skills use layer-1 names, but ToolSearch only knows layer-3 names.

### Agent Definitions Already Use Long Form

Agent definitions in `plugin/ralph-hero/agents/` correctly use fully-qualified tool names:
- `agents/ralph-analyst.md` line 3: `mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue`, etc.
- `agents/ralph-builder.md` line 3: same pattern

This confirms the long-form names are the correct ones for tool resolution.

## Open Questions

1. **Does `allowed-tools` ever trigger tool loading?** If it's purely a permission gate (likely), then even fixing frontmatter won't help -- the inline body references also need updating. If `allowed-tools` does trigger loading, then updating frontmatter to long-form names would be sufficient.
2. **ToolSearch query strategy**: Does Claude use `select:ralph_hero__get_issue` (exact match, guaranteed fail) or keyword search like `"ralph_hero get_issue"` (might partially match)? The exact ToolSearch behavior determines whether this is a total failure or intermittent.
3. **Why do some invocations succeed?** If tools were loaded earlier in the session (e.g., by a prior skill or agent call), they remain available. The bug only manifests when the tools are still deferred at the time the skill tries to use them.
