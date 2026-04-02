---
date: 2026-04-02
status: draft
type: plan
github_issue: 717
github_issues: [717]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/717
primary_issue: 717
parent_plan: thoughts/shared/plans/2026-04-02-GH-0714-skill-mcp-tool-name-fix.md
tags: [skills, mcp, tool-names, natural-language, bug-fix, body-rewrite]
---

# Rewrite Inline Body Tool Name Literals to Natural Language - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-02-GH-0714-skill-mcp-tool-name-fix]]
- builds_on:: [[2026-04-02-GH-0716-update-allowed-tools-frontmatter]]
- builds_on:: [[2026-04-01-skill-mcp-tool-name-mismatch]]

## Overview

1 issue — creative rewrite of inline body text in 27 skill files, replacing all MCP tool name literals (`ralph_hero__*`, bare `knowledge_*`) with natural language action descriptions. Critical parameter values (workflow states, commands, profiles) are preserved verbatim. This phase depends on Phase 1 (#716) completing first.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-717 | Rewrite inline body tool name literals to natural language across 27 skills | S |

## Shared Constraints

Inherited from parent plan `2026-04-02-GH-0714-skill-mcp-tool-name-fix.md`:

- All skill files live at `plugin/ralph-hero/skills/{skill-name}/SKILL.md`
- Do NOT change built-in tool names (Read, Write, Bash, Glob, Grep, Task, Agent, etc.)
- Do NOT change `allowed-tools` frontmatter entries (already handled by Phase 1 / issue #716)
- Do NOT change hook `matcher:` fields
- Do NOT change MCP server registration code
- Do NOT change agent definitions in `plugin/ralph-hero/agents/` — already use correct natural language
- Changes are limited to **body text only** in each SKILL.md (not frontmatter)

Phase-specific constraints:

- Preserve all critical parameter values verbatim: workflow states (`"Plan in Review"`, `"__LOCK__"`, `"In Progress"`), commands (`"ralph_plan"`, `"ralph_impl"`, `"ralph_research"`, `"ralph_triage"`, `"ralph_review"`), profiles (`"builder-active"`, `"builder-planned"`), estimates (`"XS"`, `"S"`, `"M"`), and field values
- Do NOT change fenced code blocks that show example output or markdown artifacts — only change blocks that call MCP tools by name
- The rewritten text must still give the model enough context to call the correct tool with the correct parameters
- Maintain surrounding prose context, step numbering, and list structure

## Current State Analysis

27 skills have inline body text containing `ralph_hero__*` tool name literals and/or bare `knowledge_*` names. These appear in 4 syntactic patterns:

- **Pattern A**: Fenced block with call syntax: ` ```\nralph_hero__get_issue(number=NNN)\n``` `
- **Pattern B**: Inline backtick with params: `` Use `ralph_hero__list_issues(query=...)` ``
- **Pattern C**: Inline backtick name-only: `` Query siblings via `ralph_hero__list_sub_issues` ``
- **Pattern D**: Pseudo-YAML labeled-list block (most common in autonomous skills)

When Claude reads a skill body containing a Pattern A/B/C/D tool reference, it tries to call the tool by that exact name. ToolSearch fails because deferred tools are indexed under fully-qualified names only. Natural language directives let the model use its tool selection capability to match intent to the correct available tool.

Total occurrences: 200+ across 27 skills. The heaviest rewrites are `ralph-triage` (25+) and `ralph-split` (20+).

## Desired End State

Every skill body uses natural language to describe actions. No body text contains `ralph_hero__` or bare `knowledge_*` literals. Critical parameter values survive in the natural language prose.

### Verification
- [x] `grep -rn "ralph_hero__" plugin/ralph-hero/skills/` returns matches ONLY in `allowed-tools:` frontmatter lines (zero body-text matches)
- [x] `grep -rn "knowledge_search\|knowledge_traverse\|knowledge_record_outcome\|knowledge_paths\|knowledge_common\|knowledge_central\|knowledge_bridges\|knowledge_communities" plugin/ralph-hero/skills/` returns zero body-text matches
- [ ] No SKILL.md files have broken markdown (fenced blocks properly closed, lists properly indented)
- [ ] Manual: invoke `/ralph-hero:plan` with an issue argument in a fresh session — confirm MCP tools are called successfully
- [ ] Manual: invoke `/ralph-hero:status` in a fresh session — confirm pipeline dashboard tool is called
- [ ] Manual: invoke `/ralph-hero:research` with a question — confirm issue search/list tools are called

## What We're NOT Doing

- Not changing `allowed-tools` frontmatter entries (done by Phase 1 / issue #716)
- Not creating or renaming MCP tools
- Not changing hook `matcher:` fields
- Not changing MCP server registration names
- Not updating `specs/skill-permissions.md` (informational only)
- Not rewriting fenced blocks that show example output, markdown templates, or user-facing artifacts (only blocks that call tools)

## Implementation Approach

Single phase: iterate through 27 skill files applying the four rewrite patterns. The work is creative (requires judgment about intent) but guided by clear principles and concrete examples. Process interactive skills first (higher traffic, more visible), then autonomous pipeline skills (heaviest volume), then supporting skills.

The four rewrite principles:
1. Describe the intent, not the tool: "Fetch the issue details" not "Call `ralph_hero__get_issue`"
2. Preserve critical parameter values verbatim in the rewritten prose
3. Use action verbs: fetch, update, create, post, search, list, add, remove, advance, lock
4. Keep surrounding structure (numbered steps, bullets) — only remove the tool name literals

---

## Phase 1: Rewrite inline tool name literals across all 27 skills
- **depends_on**: [GH-716]

### Overview

Read each skill's SKILL.md body text and replace all Pattern A/B/C/D tool name occurrences with natural language equivalents. Parameter values that are semantically significant (workflow states, commands, field values) must survive in the rewritten prose.

### Pattern Reference

#### Pattern A: Fenced block with call syntax → Natural language directive

Before:
```
ralph_hero__get_issue(number=NNN)
```

After:
```
Fetch the full issue details (title, body, comments, workflow state, relationships).
```

Before:
```
ralph_hero__create_comment(number=NNN, body="## Implementation Plan\n\nhttps://github.com/...")
```

After:
```
Post an Artifact Comment on the issue:
   ```markdown
   ## Implementation Plan

   https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/[plan-path]

   Summary: [1-3 line summary]
   ```
```

#### Pattern B: Inline backtick with params → Prose with values

Before:
```
Use `ralph_hero__list_issues(query=...)` to find related issues directly
```

After:
```
Search for related issues by keyword
```

Before:
```
If option 1: `ralph_hero__save_issue(number=NNN, workflowState="Plan in Review")`
```

After:
```
If option 1: Update the issue workflow state to "Plan in Review"
```

#### Pattern C: Inline backtick name-only → Action description

Before:
```
Query siblings via `ralph_hero__list_sub_issues` on the epic.
```

After:
```
Query sibling issues under the epic.
```

#### Pattern D: Pseudo-YAML labeled-list block → Structured natural language

Before:
```
ralph_hero__save_issue
- number: [issue-number]
- workflowState: "__LOCK__"
- command: "ralph_research"
```

After:
```
Lock the issue (set workflowState to "__LOCK__" with command "ralph_research").
```

Before (multi-step D block):
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

After:
```
For each new sub-issue:
1. Create a GitHub issue with a descriptive title, scoped body, and labels inherited from the parent
2. Link it as a sub-issue of the original
3. Set the estimate to "XS"
```

#### Knowledge tool references → Natural language

Before:
```
knowledge_search(query="research [topic keywords]", type="research", limit=5)
```

After:
```
Search the knowledge graph for related research documents on [topic keywords].
```

### Tasks

#### Task 1.1: Rewrite interactive skills — plan, research, impl, form, hero, iterate
- **files**: `plugin/ralph-hero/skills/plan/SKILL.md` (modify), `plugin/ralph-hero/skills/research/SKILL.md` (modify), `plugin/ralph-hero/skills/impl/SKILL.md` (modify), `plugin/ralph-hero/skills/form/SKILL.md` (modify), `plugin/ralph-hero/skills/hero/SKILL.md` (modify), `plugin/ralph-hero/skills/iterate/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] `grep -n "ralph_hero__" plugin/ralph-hero/skills/plan/SKILL.md` returns zero body-text matches (frontmatter matches allowed)
  - [ ] `grep -n "ralph_hero__" plugin/ralph-hero/skills/research/SKILL.md` returns zero body-text matches
  - [ ] `grep -n "ralph_hero__" plugin/ralph-hero/skills/impl/SKILL.md` returns zero body-text matches
  - [ ] `grep -n "ralph_hero__" plugin/ralph-hero/skills/form/SKILL.md` returns zero body-text matches
  - [ ] `grep -n "ralph_hero__" plugin/ralph-hero/skills/hero/SKILL.md` returns zero body-text matches
  - [ ] `grep -n "ralph_hero__" plugin/ralph-hero/skills/iterate/SKILL.md` returns zero body-text matches
  - [ ] All workflow state values (`"Plan in Review"`, `"In Progress"`, `"__LOCK__"`) that appeared in the original tool calls are preserved in rewritten prose
  - [ ] All command values (`"ralph_plan"`, `"ralph_impl"`, etc.) that appeared in the original tool calls are preserved
  - [ ] `knowledge_search` and `knowledge_traverse` bare names removed from `form` and `hero` body text
  - [ ] Fenced code blocks representing markdown output templates (not tool calls) are left unchanged
  - [ ] No broken markdown (unclosed fenced blocks, mangled list indentation)

#### Task 1.2: Rewrite heavy autonomous pipeline skills — ralph-triage, ralph-split
- **files**: `plugin/ralph-hero/skills/ralph-triage/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-split/SKILL.md` (modify)
- **tdd**: false
- **complexity**: high
- **depends_on**: null
- **acceptance**:
  - [ ] `grep -n "ralph_hero__" plugin/ralph-hero/skills/ralph-triage/SKILL.md` returns zero body-text matches
  - [ ] `grep -n "ralph_hero__" plugin/ralph-hero/skills/ralph-split/SKILL.md` returns zero body-text matches
  - [ ] All Pattern D blocks (pseudo-YAML labeled lists) converted to structured natural language with parameter values preserved
  - [ ] All estimate values (`"XS"`, `"S"`, `"M"`, `"L"`) preserved where present
  - [ ] All workflow state transitions preserve exact state name strings
  - [ ] All command parameter values (`"ralph_triage"`, `"ralph_split"`) preserved
  - [ ] No broken markdown

#### Task 1.3: Rewrite remaining autonomous pipeline skills — ralph-impl, ralph-plan, ralph-research, ralph-review, ralph-merge, ralph-pr, ralph-val, ralph-plan-epic, ralph-postmortem
- **files**: `plugin/ralph-hero/skills/ralph-impl/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-plan/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-research/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-review/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-merge/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-val/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] `grep -n "ralph_hero__" plugin/ralph-hero/skills/ralph-impl/SKILL.md` returns zero body-text matches
  - [ ] `grep -n "ralph_hero__" plugin/ralph-hero/skills/ralph-plan/SKILL.md` returns zero body-text matches
  - [ ] `grep -n "ralph_hero__" plugin/ralph-hero/skills/ralph-research/SKILL.md` returns zero body-text matches
  - [ ] `grep -n "ralph_hero__" plugin/ralph-hero/skills/ralph-review/SKILL.md` returns zero body-text matches
  - [ ] `grep -n "ralph_hero__" plugin/ralph-hero/skills/ralph-merge/SKILL.md` returns zero body-text matches
  - [ ] `grep -n "ralph_hero__" plugin/ralph-hero/skills/ralph-pr/SKILL.md` returns zero body-text matches
  - [ ] `grep -n "ralph_hero__" plugin/ralph-hero/skills/ralph-val/SKILL.md` returns zero body-text matches
  - [ ] `grep -n "ralph_hero__" plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md` returns zero body-text matches
  - [ ] `grep -n "knowledge_search\|knowledge_traverse" plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md` returns zero body-text matches
  - [ ] `grep -n "ralph_hero__\|knowledge_record_outcome" plugin/ralph-hero/skills/ralph-postmortem/SKILL.md` returns zero body-text matches
  - [ ] `__LOCK__`, `__COMPLETE__`, and all command values preserved verbatim in rewritten prose
  - [ ] No broken markdown

#### Task 1.4: Rewrite supporting skills — hello, status, report, setup, setup-repos, ralph-hygiene, team, bridge-artifact, record-demo, prove-claim
- **files**: `plugin/ralph-hero/skills/hello/SKILL.md` (modify), `plugin/ralph-hero/skills/status/SKILL.md` (modify), `plugin/ralph-hero/skills/report/SKILL.md` (modify), `plugin/ralph-hero/skills/setup/SKILL.md` (modify), `plugin/ralph-hero/skills/setup-repos/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md` (modify), `plugin/ralph-hero/skills/team/SKILL.md` (modify), `plugin/ralph-hero/skills/bridge-artifact/SKILL.md` (modify), `plugin/ralph-hero/skills/record-demo/SKILL.md` (modify), `plugin/ralph-hero/skills/prove-claim/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] `grep -rn "ralph_hero__" plugin/ralph-hero/skills/hello/SKILL.md plugin/ralph-hero/skills/status/SKILL.md plugin/ralph-hero/skills/report/SKILL.md plugin/ralph-hero/skills/setup/SKILL.md plugin/ralph-hero/skills/setup-repos/SKILL.md plugin/ralph-hero/skills/ralph-hygiene/SKILL.md plugin/ralph-hero/skills/team/SKILL.md plugin/ralph-hero/skills/bridge-artifact/SKILL.md plugin/ralph-hero/skills/record-demo/SKILL.md` returns zero body-text matches
  - [ ] `grep -n "knowledge_search\|knowledge_traverse\|knowledge_record_outcome\|knowledge_paths\|knowledge_common\|knowledge_central\|knowledge_bridges\|knowledge_communities" plugin/ralph-hero/skills/prove-claim/SKILL.md` returns zero body-text matches (prove-claim uses knowledge tools only)
  - [ ] No broken markdown

#### Task 1.5: Run automated verification — confirm zero body-text tool name literals remain
- **files**: (read-only grep verification, no file modifications)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2, 1.3, 1.4]
- **acceptance**:
  - [ ] `grep -rn "ralph_hero__" plugin/ralph-hero/skills/` — all matches are on `allowed-tools:` frontmatter lines only (line content starts with `  - mcp__` or `  - ralph_hero__` within the frontmatter block, i.e., above the closing `---`)
  - [ ] `grep -rn "knowledge_search\|knowledge_traverse\|knowledge_record_outcome\|knowledge_paths\|knowledge_common\|knowledge_central\|knowledge_bridges\|knowledge_communities" plugin/ralph-hero/skills/` — zero matches (body and frontmatter, since Phase 1 moved these to long-form in frontmatter and natural language in body)
  - [ ] No SKILL.md file contains an unclosed fenced block (verify by checking each edited file for balanced ` ``` ` delimiters)

### Phase Success Criteria

#### Automated Verification:
- [x] `grep -rn "ralph_hero__" plugin/ralph-hero/skills/` returns matches ONLY in `allowed-tools:` frontmatter lines
- [x] `grep -rn "knowledge_search\|knowledge_traverse\|knowledge_record_outcome\|knowledge_paths\|knowledge_common\|knowledge_central\|knowledge_bridges\|knowledge_communities" plugin/ralph-hero/skills/` returns zero body-text matches

#### Manual Verification:
- [ ] Invoke `/ralph-hero:plan` with an issue argument in a fresh Claude Code session — confirm it fetches issue details and posts comments via MCP tools (no "tool not found" errors)
- [ ] Invoke `/ralph-hero:status` in a fresh session — confirm pipeline dashboard tool is called successfully
- [ ] Invoke `/ralph-hero:research` with a question — confirm it can search/list issues

---

## Integration Testing

- [ ] `/ralph-hero:plan #714` in a fresh session — all MCP tool calls succeed
- [ ] `/ralph-hero:status` in a fresh session — pipeline dashboard renders
- [ ] `/ralph-hero:research "how does caching work"` — issue search resolves
- [ ] `/ralph-hero:hero` or `/ralph-hero:team` with a simple task — autonomous sub-skill invocations succeed (regression check for `ralph-impl`, `ralph-triage`, etc.)

## References

- Parent plan: [thoughts/shared/plans/2026-04-02-GH-0714-skill-mcp-tool-name-fix.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-02-GH-0714-skill-mcp-tool-name-fix.md)
- Sibling plan (Phase 1): [thoughts/shared/plans/2026-04-02-GH-0716-update-allowed-tools-frontmatter.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-02-GH-0716-update-allowed-tools-frontmatter.md)
- Research: [thoughts/shared/research/2026-04-01-skill-mcp-tool-name-mismatch.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-01-skill-mcp-tool-name-mismatch.md)
- Parent issue: [#714](https://github.com/cdubiel08/ralph-hero/issues/714)
- This issue: [#717](https://github.com/cdubiel08/ralph-hero/issues/717)
- Sibling issue (Phase 1): [#716](https://github.com/cdubiel08/ralph-hero/issues/716)
- Agent pattern reference (correct natural language approach): `plugin/ralph-hero/agents/ralph-analyst.md`, `plugin/ralph-hero/agents/ralph-builder.md`
