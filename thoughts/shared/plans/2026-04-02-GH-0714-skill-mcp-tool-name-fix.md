---
date: 2026-04-02
status: draft
type: plan
tags: [skills, mcp, tool-names, bug-fix]
github_issue: 714
github_issues: [714]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/714
primary_issue: 714
---

# Fix Skill MCP Tool Name Resolution Implementation Plan

## Prior Work

- builds_on:: [[2026-04-01-skill-mcp-tool-name-mismatch]]

## Overview

All 26 skills that reference ralph-hero MCP tools use short-form names (`ralph_hero__get_issue`) that ToolSearch cannot resolve to the actual deferred names (`mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue`). This plan fixes the `allowed-tools` frontmatter (mechanical) and rewrites inline body references from tool-name literals to natural language (durable, improves with model capability).

## Current State Analysis

- **26 skills** have `allowed-tools` entries using short-form ralph-hero tool names
- **1 skill** (`ralph-postmortem`) uses a bare knowledge tool name (`knowledge_record_outcome`) with no prefix at all
- **3 skills** (`prove-claim`, `hero`, `ralph-plan-epic`) correctly use long-form names for ralph-knowledge tools
- **Agent definitions** already use correct fully-qualified names in `tools:` frontmatter and natural language in body text — this is the target pattern
- **Inline body references** use 4 syntactic patterns across all skills, totaling 200+ occurrences

### Key Discoveries:
- The `allowed-tools` frontmatter is a permission gate only — it does not auto-load deferred tools
- ToolSearch indexes tools by fully-qualified name; short names produce no matches
- Agent bodies already demonstrate the natural language approach works well — agents reference tools by intent, not by name
- Pattern D (pseudo-YAML labeled-list) is the most common inline pattern in autonomous skills (`ralph-impl`, `ralph-triage`, `ralph-split`, `ralph-review`, `ralph-research`)

## Desired End State

Every skill file follows this convention:
1. **`allowed-tools` frontmatter** uses fully-qualified MCP tool names (e.g., `mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue`)
2. **Body text** uses natural language to describe actions, carrying critical parameter values (workflow states, commands, profiles) but never tool name literals
3. **No `ralph_hero__*` or bare `knowledge_*` literals** appear anywhere in body text

### Verification:
- `grep -r "ralph_hero__" plugin/ralph-hero/skills/` returns hits only in `allowed-tools:` frontmatter lines
- `grep -r "knowledge_search\|knowledge_traverse\|knowledge_record_outcome" plugin/ralph-hero/skills/` returns zero hits (all moved to long-form in frontmatter, natural language in body)
- Invoking `/ralph-hero:plan #714` in a fresh session (no pre-loaded MCP tools) successfully calls MCP tools via ToolSearch

## What We're NOT Doing

- Not changing agent definitions — they already use correct names
- Not changing MCP server tool registration names (`ralph_hero__*` prefix stays)
- Not changing hook `matcher:` fields — hooks receive the short name in their JSON payload
- Not changing the `specs/skill-permissions.md` document (informational, not functional)
- Not adding any new tools or changing tool behavior

## Implementation Approach

Two phases editing SKILL.md files only. Phase 1 is a mechanical find-and-replace of frontmatter. Phase 2 is a creative rewrite of inline body text guided by clear principles and pattern-specific examples. Both phases edit the same files in `plugin/ralph-hero/skills/` (and one file in `plugin/ralph-knowledge/skills/`).

All skill files live at: `plugin/ralph-hero/skills/{skill-name}/SKILL.md`

## Phase 1: Update `allowed-tools` Frontmatter

### Overview
Mechanical replacement of short-form tool names with fully-qualified names in `allowed-tools` arrays across all 26 affected skills (plus 1 ralph-knowledge skill).

### Tool Name Mapping

Apply these substitutions to every `allowed-tools` entry:

**ralph-hero tools** — prefix `ralph_hero__` becomes `mcp__plugin_ralph-hero_ralph-github__ralph_hero__`:
```
ralph_hero__get_issue          → mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
ralph_hero__list_issues        → mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
ralph_hero__create_issue       → mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_issue
ralph_hero__save_issue         → mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
ralph_hero__create_comment     → mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
ralph_hero__add_sub_issue      → mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_sub_issue
ralph_hero__list_sub_issues    → mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues
ralph_hero__add_dependency     → mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_dependency
ralph_hero__remove_dependency  → mcp__plugin_ralph-hero_ralph-github__ralph_hero__remove_dependency
ralph_hero__list_dependencies  → mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_dependencies
ralph_hero__advance_issue      → mcp__plugin_ralph-hero_ralph-github__ralph_hero__advance_issue
ralph_hero__decompose_feature  → mcp__plugin_ralph-hero_ralph-github__ralph_hero__decompose_feature
ralph_hero__detect_stream_positions → mcp__plugin_ralph-hero_ralph-github__ralph_hero__detect_stream_positions
ralph_hero__pick_actionable_issue   → mcp__plugin_ralph-hero_ralph-github__ralph_hero__pick_actionable_issue
ralph_hero__pipeline_dashboard → mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard
ralph_hero__project_hygiene    → mcp__plugin_ralph-hero_ralph-github__ralph_hero__project_hygiene
ralph_hero__archive_items      → mcp__plugin_ralph-hero_ralph-github__ralph_hero__archive_items
ralph_hero__create_status_update → mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_status_update
ralph_hero__health_check       → mcp__plugin_ralph-hero_ralph-github__ralph_hero__health_check
ralph_hero__get_project        → mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_project
ralph_hero__setup_project      → mcp__plugin_ralph-hero_ralph-github__ralph_hero__setup_project
ralph_hero__sync_plan_graph    → mcp__plugin_ralph-hero_ralph-github__ralph_hero__sync_plan_graph
```

**ralph-knowledge bare names** (only in `ralph-postmortem`):
```
knowledge_record_outcome → mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
```

### Skills to Edit (26 total — `prove-claim` already correct):

bridge-artifact, form, hello, hero, impl, iterate, plan, ralph-hygiene, ralph-impl, ralph-merge, ralph-plan, ralph-plan-epic, ralph-postmortem, ralph-pr, ralph-research, ralph-review, ralph-split, ralph-triage, ralph-val, record-demo, report, research, setup, setup-repos, status, team

### Changes Required:

For each skill, replace every `ralph_hero__*` entry in the `allowed-tools:` YAML array with its fully-qualified equivalent using the mapping above. Also replace the bare `knowledge_record_outcome` in `ralph-postmortem`.

Do NOT change:
- Built-in tool names (Read, Write, Bash, etc.)
- ralph-knowledge tools that already use long form (in `hero`, `ralph-plan-epic`, `prove-claim`)

### Success Criteria:

#### Automated Verification:
- [ ] `grep -rn "^  - ralph_hero__" plugin/ralph-hero/skills/` returns zero matches
- [ ] `grep -rn "^  - knowledge_" plugin/ralph-hero/skills/` returns zero matches
- [ ] `grep -rn "mcp__plugin_ralph-hero_ralph-github__ralph_hero__" plugin/ralph-hero/skills/` returns 75+ matches (one per frontmatter entry)
- [ ] Every skill file is valid YAML frontmatter (no parse errors when the skill is invoked)

#### Manual Verification:
- [ ] Invoke one skill (e.g., `/ralph-hero:status`) in a fresh session and confirm MCP tools resolve via ToolSearch

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Rewrite Inline Body References to Natural Language

### Overview
Replace all inline MCP tool name literals in skill body text with natural language descriptions that carry critical parameter values but not tool names. This makes skills more durable — models improve at tool selection from natural language, and prose won't break if tool names change.

### Rewrite Principles

1. **Describe the intent, not the tool**: "Fetch the issue details" not "Call `ralph_hero__get_issue`"
2. **Preserve critical parameter values**: Workflow states (`"Plan in Review"`, `"__LOCK__"`), commands (`"ralph_plan"`), profiles (`"builder-active"`), and field values (`estimate: "XS"`) must appear verbatim in the rewritten text
3. **Use action verbs**: fetch, update, create, post, search, list, add, remove, advance, lock
4. **Keep structure where it helps**: Numbered steps and bullets are fine — just remove tool names from them
5. **Trust the model**: The `allowed-tools` frontmatter tells the model which tools are available. Natural language intent + available tools = correct tool selection.

### Pattern-Specific Rewrite Examples

#### Pattern A: Fenced block with call syntax → Natural language directive

**Before:**
```
   ```
   ralph_hero__get_issue(number=NNN)
   ```
```

**After:**
```
Fetch the full issue details (title, body, comments, workflow state, relationships).
```

**Before:**
```
   ```
   ralph_hero__create_comment(number=NNN, body="## Implementation Plan\n\nhttps://github.com/...")
   ```
```

**After:**
```
Post an Artifact Comment on the issue:
   ```markdown
   ## Implementation Plan

   https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/[plan-path]

   Summary: [1-3 line summary]
   ```
```

#### Pattern B: Inline backtick with params → Prose with values

**Before:**
```
- Use `ralph_hero__list_issues(query=...)` to find related issues directly
```

**After:**
```
- Search for related issues by keyword
```

**Before:**
```
If option 1: `ralph_hero__save_issue(number=NNN, workflowState="Plan in Review")`
```

**After:**
```
If option 1: Update the issue workflow state to "Plan in Review"
```

#### Pattern C: Inline backtick name-only → Action description

**Before:**
```
Query siblings via `ralph_hero__list_sub_issues` on the epic.
```

**After:**
```
Query sibling issues under the epic.
```

#### Pattern D: Pseudo-YAML labeled-list → Structured natural language

**Before:**
```
   ```
   ralph_hero__save_issue
   - number: [issue-number]
   - workflowState: "__LOCK__"
   - command: "ralph_research"
   ```
```

**After:**
```
Lock the issue (set workflowState to "__LOCK__" with command "ralph_research").
```

**Before (multi-step D blocks):**
```
   ```
   ralph_hero__create_issue
   - title: [Descriptive title]
   - body: [Scope, references, acceptance criteria]
   - labels: [inherit from parent]

   ralph_hero__add_sub_issue
   - parentNumber: [original-issue-number]
   - childNumber: [new-issue-number]

   ralph_hero__save_issue
   - number: [new-issue-number]
   - estimate: "XS"
   ```
```

**After:**
```
For each new sub-issue:
1. Create a GitHub issue with a descriptive title, scoped body, and labels inherited from the parent
2. Link it as a sub-issue of the original
3. Set the estimate to "XS"
```

#### Knowledge tool references → Natural language

**Before:**
```
   knowledge_search(query="research [topic keywords]", type="research", limit=5)
```

**After:**
```
Search the knowledge graph for related research documents on [topic keywords].
```

### Skills to Edit

Edit all 27 skills that have inline tool references. Process in this order (high-traffic interactive skills first, then autonomous pipeline skills, then supporting skills):

**Interactive skills (6):**
1. `plan` — 9 inline refs (Pattern A/B)
2. `research` — 4 inline refs (Pattern B/C)
3. `impl` — 6 inline refs (Pattern A)
4. `form` — 10 inline refs (Pattern A/B/D)
5. `hero` — 3 inline refs (Pattern A/B)
6. `iterate` — 8 inline refs (Pattern D)

**Autonomous pipeline skills (11):**
7. `ralph-impl` — 7 inline refs (Pattern A/C/D)
8. `ralph-plan` — 13 inline refs (Pattern A/B/C)
9. `ralph-research` — 7 inline refs (Pattern B/C/D)
10. `ralph-review` — 15 inline refs (Pattern A/D)
11. `ralph-triage` — 25+ inline refs (Pattern B/D) — heaviest rewrite
12. `ralph-split` — 20+ inline refs (Pattern D) — heavy rewrite
13. `ralph-merge` — 5 inline refs (Pattern A)
14. `ralph-pr` — 4 inline refs (Pattern A)
15. `ralph-val` — 2 inline refs (Pattern A/C)
16. `ralph-plan-epic` — 12 inline refs (Pattern A/B/C)
17. `ralph-postmortem` — 3 inline refs (Pattern C)

**Supporting skills (10):**
18. `hello` — 1 inline ref (Pattern A/D)
19. `status` — 2 inline refs (Pattern C)
20. `report` — 2 inline refs (Pattern C)
21. `setup` — 5 inline refs (Pattern C)
22. `setup-repos` — 7 inline refs (Pattern C)
23. `ralph-hygiene` — 3 inline refs (Pattern A/C)
24. `team` — 2 inline refs (Pattern A)
25. `bridge-artifact` — 2 inline refs (Pattern A/B)
26. `record-demo` — 2 inline refs (Pattern B)
27. `prove-claim` — 12 inline refs (Pattern C) — knowledge tools only

### Success Criteria:

#### Automated Verification:
- [ ] `grep -rn "ralph_hero__" plugin/ralph-hero/skills/` returns matches ONLY in `allowed-tools:` frontmatter lines (not in body text)
- [ ] `grep -rn "knowledge_search\|knowledge_traverse\|knowledge_record_outcome\|knowledge_paths\|knowledge_common\|knowledge_central\|knowledge_bridges\|knowledge_communities" plugin/ralph-hero/skills/` returns zero body-text matches (only frontmatter)
- [ ] No SKILL.md files have broken markdown (fenced blocks properly closed, lists properly indented)

#### Manual Verification:
- [ ] Invoke `/ralph-hero:plan` with an issue argument in a fresh session — confirm it fetches issue details and posts comments via MCP tools
- [ ] Invoke `/ralph-hero:status` in a fresh session — confirm pipeline dashboard tool is called
- [ ] Invoke `/ralph-hero:research` with a question — confirm it can search/list issues

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to commit.

---

## Testing Strategy

### Automated:
- grep verification commands listed in each phase's success criteria
- YAML frontmatter parse validation (invoke each skill and confirm no parse errors)

### Manual Testing Steps:
1. Start a fresh Claude Code session (no prior MCP tool usage in conversation)
2. Run `/ralph-hero:status` — should call `pipeline_dashboard` successfully
3. Run `/ralph-hero:plan #714` — should fetch issue #714 via MCP and proceed normally
4. Run `/ralph-hero:research "how does caching work"` — should be able to search issues if needed

### Regression Check:
- Autonomous skills (`ralph-impl`, `ralph-triage`, etc.) are tested via `/ralph-hero:hero` or `/ralph-hero:team` which invoke them as sub-skills

## References

- Research: `thoughts/shared/research/2026-04-01-skill-mcp-tool-name-mismatch.md`
- Issue: #714
- Agent definitions (correct pattern): `plugin/ralph-hero/agents/ralph-analyst.md`, `ralph-builder.md`
