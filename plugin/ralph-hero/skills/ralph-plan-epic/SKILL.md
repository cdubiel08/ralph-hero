---
name: ralph-plan-epic
description: Strategic planning for complex multi-tier work. Writes plan-of-plans, creates feature children, orchestrates feature planning in dependency waves. Use when an issue requires 3+ tiers of decomposition (epic -> features -> atomics).
user-invocable: false
argument-hint: <issue-number> [--research-doc path]
context: fork
model: opus
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=plan_epic RALPH_PLAN_TYPE=plan-of-plans RALPH_REQUIRED_BRANCH=main RALPH_REQUIRES_RESEARCH=true"
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/branch-gate.sh"
    - matcher: "Write"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-research-required.sh"
    - matcher: "ralph_hero__save_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-tier-validator.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lock-release-on-failure.sh"
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
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__sync_plan_graph
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

# ralph-plan-epic — Strategic Planning for Multi-Tier Work

## Overview

This skill creates plan-of-plans documents for 3+ tier work (epic -> features -> atomics). It researches the full problem space, decomposes into M-sized features, defines shared constraints and integration strategy, then orchestrates feature-level planning in dependency waves.

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

**If issue number provided as argument:**
1. Fetch the full issue details for issue NNN.
2. Verify estimate is L or XL
3. Verify state is "Ready for Plan"
4. If estimate is not L/XL, STOP: "Issue #NNN is not L/XL — use /ralph-plan for M/S/XS issues."
5. If state is not "Ready for Plan", STOP: "Issue #NNN is not in Ready for Plan state (current: [state])."

**If no issue number:**
1. List issues using profile "builder-planned" to find "Ready for Plan" issues.
2. Filter for L or XL estimates only
3. Select highest priority
4. If no L/XL issues in "Ready for Plan", respond "No L/XL issues ready for planning. Queue empty." then STOP.

### Step 2: Context Gathering

1. **Research discovery**: Same chain as `ralph-plan` — try each source in order, stop when found:
   a. If a knowledge search tool is available, search for "research GH-${number} [title keywords]" with type "research", limit 3 — if high-relevance result, read that file
   b. `--research-doc` flag — if provided and file exists, read it directly
   c. Artifact Comment Protocol — search issue comments for `## Research Document` header; extract URL; convert to local path; read file
   d. Glob fallback — `thoughts/shared/research/*GH-${number}*` (try padded and unpadded)
   e. If none found: STOP — "Issue #NNN has no research document. Run /ralph-research first."

   If found via glob (fallback), self-heal: post a comment on the issue with header `## Research Document` and the file URL (noting it was self-healed).

2. **Codebase research**: Spawn parallel subagents for full problem space understanding:
   - `Agent(subagent_type="ralph-hero:codebase-pattern-finder", prompt="Find patterns for [topic] in [relevant dirs]")`
   - `Agent(subagent_type="ralph-hero:codebase-analyzer", prompt="Understand [component] architecture. Return file:line refs.")`

   > **Team Isolation**: Do NOT pass `team_name` to these `Agent()` calls. Subagents must run outside any team context.

3. **Wait for subagents** before proceeding.

4. **Verification tooling**: Discover build/test/lint commands from project config (same as `ralph-plan` Step 3.5) — these will appear in each feature plan's phase success criteria.

### Step 3: Lock Issue

Update the epic issue: set `workflowState` to `"__LOCK__"` with `command="ralph_plan_epic"`. This moves the issue to "Plan in Progress".

### Step 4: Write Plan-of-Plans Document

**Filename**: `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-epic-name.md`

**Document structure**:

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

### Feature A: [name] (GH-NNN)
- **depends_on**: null
- **produces**: [interfaces, files, capabilities other features depend on]
- **Estimated atomics**: N

### Feature B: [name] (GH-NNN)
- **depends_on**: [GH-NNN]
- **produces**: [interfaces, files, capabilities]
- **consumes**: [interfaces from Feature A]
- **Estimated atomics**: N

## Integration Strategy

[How features compose — shared interfaces, integration tests, deployment order]

## Feature Sequencing

Feature execution order is derived from the `depends_on` graph in the Feature Decomposition above.
Features with `depends_on: null` can be planned in parallel.
Features with `depends_on: [GH-NNN]` wait until the referenced feature's plan is complete before planning begins.

No separate wave section is needed — the dependency graph IS the sequencing.

After committing the plan-of-plans document, sync feature-level `depends_on` edges to GitHub `blockedBy` relationships using the sync plan graph tool.

## What We're NOT Doing

[Explicit scope boundaries]
```

**`github_issue`** must match `primary_issue` — the knowledge indexer uses this field to link plans to issues.

Include 2-5 tags describing key concepts (lowercase, hyphenated). Reuse existing tags from prior documents when applicable.

The `## Prior Work` section uses wikilink targets (filenames without extension):
- `builds_on::` for documents this plan extends or was informed by (especially the research doc)
- `tensions::` for documents whose conclusions conflict with this plan's approach

### Step 5: Commit Plan-of-Plans

```bash
git add thoughts/shared/plans/[filename].md
git commit -m "docs(plan-of-plans): GH-NNN [epic name] strategic decomposition"
git push origin main
```

Post a comment on the epic issue with header `## Plan of Plans`, the plan URL, and a note that strategic decomposition is complete and feature children will be created next.

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
2. Move child to "Ready for Plan": update the child issue's workflow state to "Ready for Plan".

After all children are created and moved to "Ready for Plan", update the epic's plan-of-plans `## Feature Sequencing` section with the actual GH issue numbers assigned to each feature.

### Step 7: Orchestrate Feature Planning by Dependency Graph

Plan features in dependency order. Features with `depends_on: null` can be planned in parallel (via parallel `Skill()` calls). Features with `depends_on: [GH-NNN]` wait until the referenced feature's plan is complete.

**Execution loop**:

```
# Identify all unplanned features
unplanned = [all features from plan-of-plans Feature Decomposition]

While unplanned is not empty:
  # Find features whose depends_on are all satisfied (planned or depends_on: null)
  ready = [f for f in unplanned if all deps in f.depends_on are planned or f.depends_on is null]

  For each feature in ready (parallel where independent):
    # Build sibling context from completed plans of dependencies
    sibling_context = ""
    for each completed_dep_plan in feature.depends_on:
      sibling_context += extract_sibling_context(dep_plan)
      # Extract: ## Overview section, interface contracts (type names, function sigs, file paths)

    # Invoke ralph-plan for this feature
    Skill("ralph-hero:ralph-plan",
      "GH-{feature_number} --parent-plan {plan_of_plans_path} --sibling-context {sibling_context}")

  # Completion verification
  For each feature in ready:
    Fetch the issue details for feature_number.
    verify issue has exited Plan in Progress
    # Expected states: Plan in Review, In Progress, or Human Needed
    # If still Plan in Progress: not complete — wait or investigate
    move feature from unplanned to planned
```

**Completion detection**: Each `Skill()` call blocks until the feature plan is written. After all `Skill()` calls in a round return, verify by fetching each feature issue that all features have exited `Plan in Progress`.

**Sibling context extraction**: From a completed feature plan, extract:
- The `## Overview` section (what it produces)
- Task acceptance criteria that define interfaces (type names, function signatures, file paths)
- Format as a concise "Sibling Context" block:
  ```
  Sibling Context: Feature A (GH-NNN) — PLANNED

  Produces:
  - src/types.ts: [TypeName] interface, [EnumName] enum
  - [other produced files]

  Interface contract:
    [TypeName] { field: type, ... }
  ```

**Plan revision during planning**: If a feature planner discovers a dependency's plan doesn't provide what's needed:
- **Minor** (missing field, easily added): planner notes in its plan, posts `## Plan Revision Request` on the dependency issue
- **Major** (fundamentally wrong interface): planner stops with BLOCKED status; escalate to Human Needed on the epic issue

### Step 8: Update Plan-of-Plans

After all waves complete:
1. Update `child_plans` array in plan-of-plans frontmatter with paths to all feature plans:
   ```yaml
   child_plans:
     - thoughts/shared/plans/YYYY-MM-DD-GH-NNN-feature-a.md
     - thoughts/shared/plans/YYYY-MM-DD-GH-NNN-feature-b.md
   ```
2. Update `status: draft` to `status: complete`
3. Commit and push:
   ```bash
   git add thoughts/shared/plans/[epic-plan-filename].md
   git commit -m "docs(plan-of-plans): GH-NNN update child plans and mark complete"
   git push origin main
   ```

### Step 9: Transition Epic

Move epic to "In Progress": update the epic issue's workflow state to "In Progress".

Post completion comment on epic:
```
## Plan of Plans Complete

All feature plans created:
- #NNN — [feature A name] (no deps) — plan at [path]
- #NNN — [feature C name] (no deps) — plan at [path]
- #NNN — [feature B name] (depends on #NNN) — plan at [path]

Epic is now In Progress. Feature implementations will be orchestrated by hero/team.
```

### Step 10: Report (team context)

If running in a team, report via `TaskUpdate`. Include in metadata:
- `artifact_path`: path to plan-of-plans document
- `feature_count`: number of feature children created
- `planning_rounds`: number of dependency-ordered planning rounds completed
- `workflow_state`: "In Progress"

Human-readable summary: "Plan-of-plans for GH-NNN complete. [N] features across [W] waves. Epic now In Progress."

## Escalation

| Situation | Action |
|-----------|--------|
| Research document missing | STOP: "Issue #NNN has no research document. Run /ralph-research first." |
| Issue not L/XL | STOP: "Issue #NNN is not L/XL — use /ralph-plan for M/S/XS issues." |
| Feature dependency cycle detected | Escalate to Human Needed: post `## Dependency Cycle Detected` comment with cycle details |
| Wave planning fails — feature planner reports BLOCKED (major drift) | Escalate: update epic issue workflow state to "Human Needed"; post `## Escalation` comment with BLOCKED feature number and drift details |
| Feature not exiting Plan in Progress after Skill() returns | Investigate: check if feature went to Human Needed; if so, pause and escalate epic |
