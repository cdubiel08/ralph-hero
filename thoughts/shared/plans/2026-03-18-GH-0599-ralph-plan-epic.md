---
date: 2026-03-18
status: draft
type: plan
tags: [ralph-plan-epic, plan-of-plans, wave-orchestration]
github_issue: 599
github_issues: [599]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/599
primary_issue: 599
parent_plan: docs/superpowers/specs/2026-03-15-superpowers-ralph-hero-quality-integration-design.md
---
[]()
# ralph-plan-epic (New Skill) — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a new `ralph-plan-epic` skill for strategic planning of 3+ tier work. Writes plan-of-plans documents, creates feature children via `ralph-split`, and orchestrates feature-level planning in dependency waves using `Skill("ralph-hero:ralph-plan")`.

**Architecture:** New skill directory with SKILL.md. The skill is invoked by orchestrators (hero/team) or directly by users for complex epics. It delegates detailed planning to `ralph-plan` via `Skill()` calls — one per feature, in dependency wave order. No new TypeScript code — this is pure skill definition.

**Tech Stack:** Markdown (SKILL.md), YAML frontmatter

**Spec:** `docs/superpowers/specs/2026-03-15-superpowers-ralph-hero-quality-integration-design.md` Section 3

---

## Chunk 1: Create Skill Directory and Frontmatter

### Task 1: Create ralph-plan-epic skill directory and SKILL.md

**Files:**
- Create: `plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md`

- [ ] **Step 1: Create skill directory**

```bash
mkdir -p plugin/ralph-hero/skills/ralph-plan-epic
```

- [ ] **Step 2: Write SKILL.md with frontmatter**

```yaml
---
name: ralph-plan-epic
description: Strategic planning for complex multi-tier work. Writes plan-of-plans, creates feature children, orchestrates feature planning in dependency waves. Use when an issue requires 3+ tiers of decomposition (epic → features → atomics).
user-invocable: false
argument-hint: <issue-number> [--research-doc path]
context: fork
model: opus
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Agent
  - Skill
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_sub_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__decompose_feature
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search
hooks:
  - event: SessionStart
    command: "\"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh\" RALPH_COMMAND=plan_epic RALPH_REQUIRED_BRANCH=main RALPH_REQUIRES_RESEARCH=true RALPH_PLAN_TYPE=plan-of-plans"
    async: false
  - event: PreToolUse
    matcher: "Bash"
    command: "\"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/branch-gate.sh\""
    async: false
  - event: PreToolUse
    matcher: "Write"
    command: "\"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-research-required.sh\""
    async: false
  - event: PreToolUse
    matcher: "ralph_hero__save_issue"
    command: "\"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-tier-validator.sh\""
    async: false
  - event: Stop
    command: "\"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lock-release-on-failure.sh\""
    async: false
---
```

- [ ] **Step 3: Commit frontmatter**

```bash
git add plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md
git commit -m "feat(ralph-plan-epic): create skill directory with frontmatter and hooks"
```

---

## Chunk 2: Skill Process Definition

### Task 2: Write the skill process steps

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md`

- [ ] **Step 1: Write the full skill body**

Append after the frontmatter:

````markdown
# ralph-plan-epic — Strategic Planning for Multi-Tier Work

## Overview

This skill creates plan-of-plans documents for 3+ tier work (epic → features → atomics). It researches the full problem space, decomposes into M-sized features, defines shared constraints and integration strategy, then orchestrates feature-level planning in dependency waves.

**Time limit**: 30 minutes
**Scope**: L/XL issues with complex decomposition needs

## Constraints

- ONE issue at a time
- Must be on main branch
- Research document must exist
- Produces `type: plan-of-plans` documents (enforced by plan-tier-validator hook)
- Does NOT write task-level detail — that is each feature's `ralph-plan` job

## Process

### Step 1: Issue Selection

If issue number provided as argument:
1. Fetch via `ralph_hero__get_issue(number=NNN)`
2. Verify estimate is L/XL
3. Verify state is "Ready for Plan"

If no issue number:
1. `ralph_hero__list_issues(profile="builder-planned")` — finds "Ready for Plan" issues
2. Filter for L/XL estimates
3. Select highest priority

### Step 2: Context Gathering

1. **Research discovery**: Same chain as `ralph-plan` — knowledge_search → --research-doc → Artifact Comment Protocol → glob
2. **Codebase research**: Spawn parallel subagents:
   - `Agent(subagent_type="ralph-hero:codebase-pattern-finder", prompt="Find patterns for [topic]")`
   - `Agent(subagent_type="ralph-hero:codebase-analyzer", prompt="Understand [component] architecture")`
3. **Verification tooling**: Discover build/test/lint commands from project config

### Step 3: Lock Issue

Transition issue to `__LOCK__` with `command="ralph_plan_epic"`:
```
ralph_hero__save_issue(number=NNN, workflowState="__LOCK__", command="ralph_plan_epic")
```
This moves the issue to "Plan in Progress".

### Step 4: Write Plan-of-Plans Document

Filename: `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-epic-name.md`

Document structure:

```markdown
---
date: YYYY-MM-DD
status: draft
type: plan-of-plans
tags: [relevant, tags]
github_issue: NNN
github_issues: [NNN]
github_urls:
  - https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
primary_issue: NNN
child_plans: []
---

# [Epic Name] — Plan of Plans

## Prior Work

- builds_on:: [[research-doc]]

## Strategic Context

[Problem space, why this exists, what success looks like]

## Shared Constraints

[Applies to ALL features — patterns, conventions, architectural decisions.
This section is inherited verbatim by every feature plan.]

## Feature Decomposition

### Feature A: [name]
- **Scope**: [what this feature covers]
- **Produces**: [interfaces, files, capabilities other features depend on]
- **Dependencies**: none
- **Estimated atomics**: N

### Feature B: [name]
- **Scope**: [what this feature covers]
- **Produces**: [interfaces, files, capabilities]
- **Dependencies**: Feature A (needs types from A)
- **Estimated atomics**: N

## Integration Strategy

[How features compose — shared interfaces, integration tests, deployment order]

## Feature Sequencing

### Wave 1 (no dependencies — plan immediately):
- Feature A: GH-NNN
- Feature C: GH-NNN

### Wave 2 (depends on Wave 1 plans):
- Feature B: GH-NNN
  - blocked_by: [GH-NNN plan complete]

### Wave 3 (depends on Wave 2):
- Feature D: GH-NNN
  - blocked_by: [GH-NNN plan complete, GH-NNN plan complete]

## What We're NOT Doing

[Explicit scope boundaries]
```

### Step 5: Commit Plan-of-Plans

```bash
git add thoughts/shared/plans/[filename].md
git push origin main
```

Commit message: `docs(plan-of-plans): GH-NNN [epic name] strategic decomposition`

### Step 6: Create Feature Children

Invoke `Skill("ralph-hero:ralph-split", "GH-NNN")` to create M-sized feature children from the plan.

For each feature child created:
1. Post `## Plan of Plans` comment on the child:
   ```
   ## Plan of Plans

   https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/[plan-path]

   Parent: #NNN (epic issue)
   Feature scope defined in parent plan-of-plans.
   ```
2. Move child to "Ready for Plan": `ralph_hero__save_issue(number=child, workflowState="Ready for Plan")`

### Step 7: Orchestrate Feature Planning in Waves

For each wave in the Feature Sequencing section:

```
For wave N:
  features_in_wave = [features with all dependencies in completed waves]

  For each feature in wave (can invoke in parallel if independent):
    # Build sibling context from completed sibling plans
    sibling_context = ""
    for each completed_sibling_plan:
      sibling_context += extract_produces_section(sibling_plan)

    # Invoke ralph-plan for this feature
    Skill("ralph-hero:ralph-plan",
      "GH-{feature_number} --parent-plan {plan_of_plans_path} --sibling-context {sibling_context}")

  # Verify wave completion
  For each feature in wave:
    issue = ralph_hero__get_issue(number=feature_number)
    verify issue exited Plan in Progress (either Plan in Review, In Progress, or Human Needed)

  # Check: next wave's dependencies crystallized?
  For each feature in next wave:
    verify all blocked_by features have completed plans
```

**Wave completion detection**: Each `Skill()` call blocks until the feature plan is written. After all `Skill()` calls in a wave return, verify via `get_issue` that all features have exited `Plan in Progress`.

**Sibling context extraction**: From a completed feature plan, extract:
- The `## Overview` section (what it produces)
- Task acceptance criteria that define interfaces (type names, function signatures, file paths)
- Format as a concise "Sibling Context" block

**Plan revision during waves**: If a feature planner discovers a sibling's plan doesn't provide what's needed:
- Minor: planner notes in its plan, posts `## Plan Revision Request` on sibling
- Major: planner stops, escalates to plan-of-plans level

### Step 8: Update Plan-of-Plans

After all waves complete:
1. Update `child_plans` array in plan-of-plans frontmatter with paths to all feature plans
2. Update `status: draft` to `status: complete`
3. Commit and push

### Step 9: Transition Epic

Move epic to "In Progress": `ralph_hero__save_issue(number=NNN, workflowState="In Progress")`

Post comment:
```
## Plan of Plans Complete

All feature plans created:
- Phase 1: #NNN — [feature A name] — plan at [path]
- Phase 2: #NNN — [feature B name] — plan at [path]
...

Epic is now In Progress. Feature implementations will be orchestrated by hero/team.
```

### Step 10: Report (team context)

If running in a team, report via `TaskUpdate`.

## Escalation

- Research document missing → STOP, run /ralph-research first
- Issue not L/XL → STOP, use /ralph-plan for M/S/XS issues
- Feature dependency cycle detected → escalate to Human Needed
- Wave planning fails (feature planner reports BLOCKED) → escalate to Human Needed
````

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md
git commit -m "feat(ralph-plan-epic): complete skill definition with wave orchestration"
```

---

## Final Verification

- [ ] **Verify skill directory exists with SKILL.md**

```bash
test -f plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md && echo "OK"
```
Expected: OK

- [ ] **Verify frontmatter parses as valid YAML**

```bash
head -50 plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md
```
Expected: Valid YAML frontmatter with hooks, allowed-tools, model: opus

- [ ] **Run MCP server tests**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: ALL PASS

---

## Summary of Changes

| File | Type | What Changed |
|------|------|-------------|
| `skills/ralph-plan-epic/SKILL.md` | Created | Full skill definition: plan-of-plans creation, feature child creation via ralph-split, wave-based feature planning orchestration via Skill("ralph-plan"), sibling context injection |
