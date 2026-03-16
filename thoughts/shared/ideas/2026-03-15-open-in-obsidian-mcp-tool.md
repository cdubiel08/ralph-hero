---
date: 2026-03-15
status: draft
type: idea
author: user
tags: [ralph-knowledge, obsidian, mcp-tool, developer-experience]
github_issue: null
---

# MCP Tool: Open in Obsidian

## The Idea

Add an `open_in_obsidian` tool to ralph-knowledge's MCP server that launches Obsidian pointed at a specific document or the vault root. When invoked from a Claude Code conversation, it opens the relevant thought document in Obsidian's editor — bridging the gap between searching knowledge programmatically and browsing it visually.

## Why This Matters

- Currently there's no way to go from a `knowledge_search` result to viewing it in a rich UI — you'd have to manually open Obsidian and navigate
- Obsidian's graph view, backlinks, and Dataview queries add context that plain markdown can't show
- Reduces friction for the primary use case: Claude finds something relevant, user wants to explore it visually

## Rough Shape

- New MCP tool `open_in_obsidian` registered alongside `knowledge_search` and `knowledge_traverse`
- Parameters: optional `doc_id` (opens specific doc) or no args (opens vault root / `_index.md`)
- Detects Obsidian install: check `which obsidian` (Linux/WSL) and common paths
- Uses `obsidian://open?vault=...&file=...` URI scheme for precise document targeting
- Elegant degradation when setup is suboptimal:
  - No Obsidian installed → "Install with `sudo dpkg -i ...` or download from obsidian.md"
  - Obsidian installed but vault not configured → "Run `/ralph-knowledge:setup-obsidian` to set up your vault"
  - Vault exists but no generated indexes → "Run reindex to generate navigational indexes"
  - All good → opens the document
- Resolves `doc_id` to file path via the knowledge DB (already has `path` column)

## Open Questions

- Should it use `obsidian://` URI scheme (works cross-platform) or direct CLI launch (`obsidian /path`)?
- On WSL2, does `obsidian://` URI work from Linux side, or do we need `wslview`/`xdg-open`?
- Should it also support opening issue hubs (`_issues/GH-0564.md`) by issue number?

## Related

- `plugin/ralph-knowledge/src/index.ts` — where the tool would be registered (currently has `knowledge_search` and `knowledge_traverse`)
- `docs/superpowers/plans/2026-03-14-ralph-knowledge-obsidian-integration.md` — the broader Obsidian integration plan (index generation, setup skill)
- `plugin/ralph-knowledge/skills/setup-obsidian/SKILL.md` — planned setup skill that this tool would reference when vault isn't configured
