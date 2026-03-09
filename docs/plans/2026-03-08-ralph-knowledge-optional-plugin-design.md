# ralph-knowledge as Optional Plugin

Design for making the knowledge-index a standalone, opt-in plugin separate from ralph-hero.

## Problem

The knowledge-index MCP server is currently wired into ralph-hero's `.mcp.json`, meaning it starts (or fails to start) for every ralph-hero user whether they want it or not. The ~80MB embedding model download and native C++ dependency (better-sqlite3) shouldn't be forced on users who don't need semantic search.

## Goals

- Users explicitly opt in to knowledge graph features by installing a second plugin
- ralph-hero works identically without ralph-knowledge installed
- When ralph-knowledge IS installed, existing agents and skills transparently get better search results
- One repo, one marketplace, two independently installable plugins

## Plugin Structure

```
ralph-hero/
├── .claude-plugin/marketplace.json    # lists both plugins
├── plugin/
│   ├── ralph-hero/                    # unchanged core plugin
│   │   ├── .mcp.json                  # ralph-github only
│   │   ├── agents/thoughts-locator.md # enhanced with "if available" pattern
│   │   └── skills/                    # Tier 1 skills enhanced
│   └── ralph-knowledge/              # NEW standalone plugin
│       ├── .claude-plugin/plugin.json
│       ├── .mcp.json                  # ralph-knowledge server only
│       ├── package.json
│       ├── tsconfig.json
│       ├── .gitignore
│       └── src/                       # all existing knowledge-index code
```

## Opt-in Mechanism

No env vars or toggles. **Tool presence is the toggle.**

Every skill/agent that can benefit from knowledge tools uses this pattern:

```markdown
If `knowledge_search` is available, use it to find related documents.
Otherwise, fall back to [current grep/glob/thoughts-locator behavior].
```

Claude sees available tools in context. If ralph-knowledge is installed, the tools appear. If not, existing behavior runs unchanged. This is the only cross-plugin pattern that exists in the Claude Code ecosystem — there is no formal dependency declaration system.

### User flow

```bash
# Install ralph-hero (works without knowledge graph)
/install ralph-hero@ralph-hero

# Optionally install knowledge graph features
/install ralph-knowledge@ralph-hero
```

## Enhancement Inventory

### Tier 1 — Artifact Discovery (5 skills, direct change)

These skills have a fragile multi-step pattern for finding plan documents: search issue comments → extract GitHub URL → strip prefix → glob fallback → more glob fallbacks. When `knowledge_search` is available, replace with a single semantic query.

| Skill | File | Current | Enhanced |
|-------|------|---------|----------|
| ralph-plan | `skills/ralph-plan/SKILL.md` | Comment parse → glob fallback chain | `knowledge_search(query, type="plan")` with glob fallback |
| plan | `skills/plan/SKILL.md` | Same pattern | Same enhancement |
| ralph-impl | `skills/ralph-impl/SKILL.md` | Glob patterns for group/stream plans | Same enhancement |
| ralph-review | `skills/ralph-review/SKILL.md` | Glob patterns | Same enhancement |
| iterate | `skills/iterate/SKILL.md` | Comment parse → glob fallback | Same enhancement |

### Tier 2 — thoughts-locator Agent Enhancement (1 agent, transparent to callers)

The thoughts-locator sub-agent serves as a **context window firewall**: it reads N large documents, ranks them, and returns a compact summary so the caller's context stays clean. Four skills spawn it (ralph-research, form, research, plan) — none of those skills need to change.

The enhancement is internal to thoughts-locator:

| Enhancement | Current | With ralph-knowledge |
|---|---|---|
| Document discovery | Grep/glob patterns in thoughts/ | `knowledge_search` for semantic matching, fall back to grep |
| Relationship walking | Grep for `builds_on::`/`tensions::` wikilinks | `knowledge_traverse` for typed graph traversal, fall back to grep |

**Calling skills are unchanged.** They still spawn thoughts-locator, still get a compact summary back, still keep their context clean. They just get better results transparently.

### Tier 3 — Optional Dedup & Context (2 skills, low priority)

| Skill | File | Enhancement |
|-------|------|-------------|
| ralph-triage | `skills/ralph-triage/SKILL.md` | If `knowledge_search` available, check for conceptually similar research before marking duplicates |
| draft | `skills/draft/SKILL.md` | If `knowledge_search` available, check if similar idea already exists |

## Changes Required

| Change | Scope |
|--------|-------|
| Move `plugin/ralph-hero/knowledge-index/` → `plugin/ralph-knowledge/` | File move |
| Create `plugin/ralph-knowledge/.claude-plugin/plugin.json` | New manifest |
| Create `plugin/ralph-knowledge/.mcp.json` | New config (ralph-knowledge server only) |
| Remove `ralph-knowledge` entry from `plugin/ralph-hero/.mcp.json` | Revert to ralph-github only |
| Update `.claude-plugin/marketplace.json` | Add ralph-knowledge plugin entry |
| Update thoughts-locator agent | Add "if knowledge tools available" before grep patterns |
| Update 5 Tier 1 skills | Add "if knowledge_search available" artifact discovery with glob fallback |
| Update 2 Tier 3 skills (optional) | Add dedup check when tools available |

## What We're NOT Building

- No env var toggles or feature flags
- No cross-plugin dependency declarations (ecosystem doesn't support them)
- No wrapper scripts or graceful-exit shims
- No changes to the knowledge-index TypeScript code (just file moves + plugin packaging)
- No changes to the 4 skills that spawn thoughts-locator (they benefit transparently)

## Decisions

- **Separate plugin over conditional MCP startup** — composability and explicit user buy-in over implicit behavior
- **Tool presence as toggle** — the only working pattern in the Claude Code plugin ecosystem; no formal dependency system exists
- **Enhance thoughts-locator internally, not callers** — preserves context window isolation; calling skills get better results without any changes
- **Tier 1 skills change directly** — artifact discovery is inline in those skills (not delegated to thoughts-locator), so the "if available" pattern goes there
- **Same repo, same marketplace** — `marketplace.json` catalogs both plugins; users install each independently
