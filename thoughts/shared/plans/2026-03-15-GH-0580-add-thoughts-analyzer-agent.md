---
date: 2026-03-15
status: draft
type: plan
tags: [agents, thoughts-analyzer, skills, research]
github_issue: 580
github_issues: [580]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/580
primary_issue: 580
---

# Add thoughts-analyzer Agent to Ralph-Hero Plugin

## Prior Work

- builds_on:: [[2026-02-18-GH-0060-research-skill-missing-agents]]
- builds_on:: [[2026-02-22-group-GH-0343-interactive-skills-port]]

## Overview

Add a `thoughts-analyzer` agent to the ralph-hero plugin and integrate it into 6 skills that work with thought documents. Currently, `thoughts-locator` finds documents but the main context must read and synthesize them — consuming context window. The analyzer offloads extraction of decisions, constraints, and actionable insights to a dedicated sub-agent, keeping the main context lean.

## Current State Analysis

- `thoughts-locator` exists in the plugin at `plugin/ralph-hero/agents/thoughts-locator.md` (model: haiku, tools: Grep, Glob, Bash, knowledge_search, knowledge_traverse)
- `thoughts-analyzer` exists only at workspace level (`~/projects/.claude/agents/thoughts-analyzer.md`) — not in the plugin
- Previous planning (GH-0343) decided to "drop thoughts-analyzer" and have main context synthesize. This was a pragmatic shortcut that we're now reversing.
- `codebase-analyzer` is dispatched in 8 skills — it's the pattern to follow for thoughts-analyzer
- 5 skills currently dispatch `thoughts-locator`: form, iterate, plan, research, ralph-research
- 1 skill dispatches `codebase-analyzer` + `thoughts-locator` but not `thoughts-analyzer`: ralph-plan

### Key Discoveries:
- `plugin/ralph-hero/agents/codebase-analyzer.md:1-6` — Plugin agent convention: tools use `Bash` not `LS`, descriptions are concise
- `plugin/ralph-hero/skills/research/SKILL.md:76-77` — Current pattern: locator finds docs, then "Read and synthesize the returned documents yourself in the main context"
- `plugin/ralph-hero/skills/plan/SKILL.md:92-95` — After research tasks complete, skill reads ALL files into main context
- `plugin/ralph-hero/skills/ralph-research/SKILL.md:148` — "Populate from thoughts-locator results gathered during the research phase" — synthesis happens in main context

## Desired End State

- A `thoughts-analyzer` agent definition exists at `plugin/ralph-hero/agents/thoughts-analyzer.md`
- 6 skills dispatch `thoughts-analyzer` after `thoughts-locator` finds relevant documents
- Skills no longer instruct the main context to read and synthesize thought documents directly — the analyzer handles extraction
- The agent is listed in the README agent table

### How to verify:
- `grep -r "thoughts-analyzer" plugin/ralph-hero/agents/` returns the agent definition
- `grep -r "thoughts-analyzer" plugin/ralph-hero/skills/` returns dispatch lines in all 6 skills
- `grep -r "thoughts-analyzer" README.md` returns a row in the agent table

## What We're NOT Doing

- Not adding thoughts-analyzer to ralph-split, ralph-review, or ralph-impl (they don't work with thought documents for context gathering)
- Not changing the thoughts-locator agent itself
- Not modifying hooks or the MCP server
- Not removing the workspace-level thoughts-analyzer (that's a separate cleanup)

## Implementation Approach

Follow the established locator → analyzer pattern from the codebase agents. The locator finds documents (fast, haiku), then the analyzer extracts high-value insights from the most relevant ones (deeper, sonnet). Skills synthesize the analyzer's structured output rather than raw document content.

## Phase 1: Create the Agent Definition

### Overview
Port the workspace thoughts-analyzer to the plugin, adapting to plugin conventions.

### Changes Required:

#### 1. New agent definition
**File**: `plugin/ralph-hero/agents/thoughts-analyzer.md`
**Changes**: Create new file based on workspace version with plugin conventions applied

Key adaptations from workspace version:
- Replace `LS` with `Bash` in tools (plugin convention)
- Keep `sonnet` model (deep analysis warrants it, matches codebase-analyzer)
- Keep ralph-knowledge MCP tools in allowlist
- Keep the 4-step analysis strategy (discover context, read with purpose, extract strategically, filter ruthlessly)
- Keep the structured output format (Document Context, Key Decisions, Critical Constraints, etc.)

```markdown
---
name: thoughts-analyzer
description: Extracts key decisions, constraints, and actionable insights from thought documents. Use for deep analysis of research docs, plans, and prior decisions.
tools: Read, Grep, Glob, Bash, mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search, mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_traverse
model: sonnet
---
```

### Success Criteria:

#### Automated Verification:
- [ ] File exists: `ls plugin/ralph-hero/agents/thoughts-analyzer.md`
- [ ] Frontmatter has correct tools: `grep "tools:" plugin/ralph-hero/agents/thoughts-analyzer.md`
- [ ] No `LS` tool reference: `grep -c "LS" plugin/ralph-hero/agents/thoughts-analyzer.md` returns 0

#### Manual Verification:
- [ ] Agent can be spawned: `Agent(subagent_type="ralph-hero:thoughts-analyzer", prompt="test")`

---

## Phase 2: Update Skills to Dispatch thoughts-analyzer

### Overview
Add thoughts-analyzer dispatch to 6 skills, replacing the "main context reads and synthesizes" pattern.

### Changes Required:

#### 1. research/SKILL.md
**File**: `plugin/ralph-hero/skills/research/SKILL.md`
**Changes**: Add thoughts-analyzer dispatch after thoughts-locator. Replace line 77's instruction to "Read and synthesize the returned documents yourself in the main context".

Current (lines 75-77):
```markdown
**For thoughts directory:**
- `Agent(subagent_type="ralph-hero:thoughts-locator", prompt="Discover what documents exist about [topic]")`
- Read and synthesize the returned documents yourself in the main context
```

Replace with:
```markdown
**For thoughts directory:**
- `Agent(subagent_type="ralph-hero:thoughts-locator", prompt="Discover what documents exist about [topic]")`
- `Agent(subagent_type="ralph-hero:thoughts-analyzer", prompt="Extract key decisions, constraints, and technical specs from [documents found by locator]")`
```

Also update Step 4 (line 101-108) to reference analyzer output instead of instructing main context to read thought docs:

Current (line 103):
```markdown
- Use thoughts/ findings as supplementary historical context
```

Replace with:
```markdown
- Use thoughts-analyzer findings as supplementary historical context (decisions, constraints, open questions)
```

#### 2. form/SKILL.md
**File**: `plugin/ralph-hero/skills/form/SKILL.md`
**Changes**: Add thoughts-analyzer after thoughts-locator dispatch in Step 2.

Current (line 84):
```markdown
2. **Existing work** - `Agent(subagent_type="ralph-hero:thoughts-locator", prompt="Find related ideas, research, and plans")` to find:
```

Add after the locator dispatch (after line 87):
```markdown
   Then analyze the most relevant findings:
   - `Agent(subagent_type="ralph-hero:thoughts-analyzer", prompt="Extract key decisions and prior art from documents about [idea topic]")`
```

#### 3. plan/SKILL.md
**File**: `plugin/ralph-hero/skills/plan/SKILL.md`
**Changes**: Add thoughts-analyzer in both Step 1 (line 82) and Step 2 (line 140). Update Step 1.4 (lines 92-95) to use analyzer output instead of reading all files into main context.

In Step 1 (after line 82, the thoughts-locator dispatch):
```markdown
   - `Agent(subagent_type="ralph-hero:thoughts-analyzer", prompt="Extract key decisions, constraints, and specs from thoughts documents about [feature]")` (dispatch after locator returns)
```

Update Step 1.4 (lines 92-95) from:
```markdown
4. **Read all files identified by research tasks**:
   - After research tasks complete, read ALL files they identified as relevant
   - Read them FULLY into the main context
   - This ensures you have complete understanding before proceeding
```
To:
```markdown
4. **Read code files identified by research tasks**:
   - After research tasks complete, read code files they identified as relevant
   - Read them FULLY into the main context
   - For thought documents, rely on thoughts-analyzer output rather than reading raw docs
   - This keeps the main context focused on code while leveraging structured insight extraction
```

In Step 2 (after line 140, the thoughts-locator dispatch):
```markdown
   - `Agent(subagent_type="ralph-hero:thoughts-analyzer", prompt="Analyze decisions and constraints from [area] documents")` (dispatch after locator returns)
```

#### 4. iterate/SKILL.md
**File**: `plugin/ralph-hero/skills/iterate/SKILL.md`
**Changes**: Add thoughts-analyzer after thoughts-locator in Step 2 research block.

After line 158 (the thoughts-locator dispatch):
```markdown
   - `Agent(subagent_type="ralph-hero:thoughts-analyzer", prompt="Extract relevant decisions and constraints from [area] documents")`
```

#### 5. ralph-research/SKILL.md
**File**: `plugin/ralph-hero/skills/ralph-research/SKILL.md`
**Changes**: Add thoughts-analyzer after thoughts-locator in Step 4 research block. Update line 148 to reference analyzer output.

After line 100 (the thoughts-locator dispatch):
```markdown
   - `Agent(subagent_type="ralph-hero:thoughts-analyzer", prompt="Extract key findings and decisions from existing research about [topic]")`
```

Update line 148 from:
```markdown
- Populate from thoughts-locator results gathered during the research phase
```
To:
```markdown
- Populate from thoughts-locator and thoughts-analyzer results gathered during the research phase
```

#### 6. ralph-plan/SKILL.md
**File**: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`
**Changes**: Add both thoughts-locator and thoughts-analyzer to the research block around line 147-148, alongside the existing codebase agent dispatches.

After line 148 (the codebase-analyzer dispatch):
```markdown
   - `Agent(subagent_type="ralph-hero:thoughts-locator", prompt="Find existing research, plans, or decisions about [topic]")`
   - `Agent(subagent_type="ralph-hero:thoughts-analyzer", prompt="Extract key decisions and constraints from thought documents about [topic]")`
```

### Success Criteria:

#### Automated Verification:
- [ ] All 6 skills reference thoughts-analyzer: `grep -rl "thoughts-analyzer" plugin/ralph-hero/skills/` returns 6 files
- [ ] No "Read and synthesize the returned documents yourself" remains: `grep -r "synthesize the returned documents yourself" plugin/ralph-hero/skills/` returns nothing
- [ ] Build passes: `cd plugin/ralph-hero/mcp-server && npm run build`
- [ ] Tests pass: `cd plugin/ralph-hero/mcp-server && npm test`

#### Manual Verification:
- [ ] Run `/ralph-hero:research` and confirm thoughts-analyzer is dispatched after locator
- [ ] Verify analyzer output is structured (decisions, constraints, specs) not raw doc content

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Update Documentation

### Overview
Add thoughts-analyzer to the README agent table.

### Changes Required:

#### 1. README agent table
**File**: `README.md`
**Changes**: Add a row for thoughts-analyzer in the agents table, near the existing thoughts-locator row.

Add after the thoughts-locator row:
```markdown
| `thoughts-analyzer` | Extract key decisions, constraints, and insights from thought documents |
```

### Success Criteria:

#### Automated Verification:
- [ ] README contains thoughts-analyzer: `grep "thoughts-analyzer" README.md`

#### Manual Verification:
- [ ] Agent table reads correctly with both thoughts-locator and thoughts-analyzer listed

---

## Testing Strategy

### Smoke Tests:
- Spawn thoughts-analyzer directly and verify it returns structured output
- Run a skill (e.g., `/ralph-hero:research`) on a topic with existing thought documents and verify the analyzer is dispatched

### Integration:
- Verify the locator → analyzer flow works: locator finds docs, analyzer extracts insights
- Confirm skills use analyzer output for synthesis rather than reading raw docs

## References

- Workspace thoughts-analyzer: `~/projects/.claude/agents/thoughts-analyzer.md`
- Plugin codebase-analyzer (pattern to follow): `plugin/ralph-hero/agents/codebase-analyzer.md`
- GH-0060 research on missing agents: `thoughts/shared/research/2026-02-18-GH-0060-research-skill-missing-agents.md`
- GH-0343 interactive skills port (original "drop analyzer" decision): `thoughts/shared/plans/2026-02-22-group-GH-0343-interactive-skills-port.md`
