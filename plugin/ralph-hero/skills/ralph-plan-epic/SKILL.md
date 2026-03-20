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
  - ralph_hero__get_issue
  - ralph_hero__list_issues
  - ralph_hero__save_issue
  - ralph_hero__create_comment
  - ralph_hero__add_sub_issue
  - ralph_hero__list_sub_issues
  - ralph_hero__decompose_feature
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search
---

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
1. Fetch via `ralph_hero__get_issue(number=NNN)`
2. Verify estimate is L or XL
3. Verify state is "Ready for Plan"
4. If estimate is not L/XL, STOP: "Issue #NNN is not L/XL — use /ralph-plan for M/S/XS issues."
5. If state is not "Ready for Plan", STOP: "Issue #NNN is not in Ready for Plan state (current: [state])."

**If no issue number:**
1. `ralph_hero__list_issues(profile="builder-planned")` — finds "Ready for Plan" issues
2. Filter for L or XL estimates only
3. Select highest priority
4. If no L/XL issues in "Ready for Plan", respond "No L/XL issues ready for planning. Queue empty." then STOP.

### Step 2: Context Gathering

1. **Research discovery**: Same chain as `ralph-plan` — try each source in order, stop when found:
   a. `knowledge_search(query="research GH-${number} [title keywords]", type="research", limit=3)` — if high-relevance result, read that file
   b. `--research-doc` flag — if provided and file exists, read it directly
   c. Artifact Comment Protocol — search issue comments for `## Research Document` header; extract URL; convert to local path; read file
   d. Glob fallback — `thoughts/shared/research/*GH-${number}*` (try padded and unpadded)
   e. If none found: STOP — "Issue #NNN has no research document. Run /ralph-research first."

   If found via glob (fallback), self-heal: post missing comment on issue:
   ```
   ralph_hero__create_comment(number=NNN, body="## Research Document\n\nhttps://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/[path]\n\n(Self-healed: artifact was found on disk but not linked via comment)")
   ```

2. **Codebase research**: Spawn parallel subagents for full problem space understanding:
   - `Agent(subagent_type="ralph-hero:codebase-pattern-finder", prompt="Find patterns for [topic] in [relevant dirs]")`
   - `Agent(subagent_type="ralph-hero:codebase-analyzer", prompt="Understand [component] architecture. Return file:line refs.")`

   > **Team Isolation**: Do NOT pass `team_name` to these `Agent()` calls. Subagents must run outside any team context.

3. **Wait for subagents** before proceeding.

4. **Verification tooling**: Discover build/test/lint commands from project config (same as `ralph-plan` Step 3.5) — these will appear in each feature plan's phase success criteria.

### Step 3: Lock Issue

Transition epic to `__LOCK__` with `command="ralph_plan_epic"`:
```
ralph_hero__save_issue(number=NNN, workflowState="__LOCK__", command="ralph_plan_epic")
```
This moves the issue to "Plan in Progress".

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

Post the plan link as a comment on the epic issue:
```
ralph_hero__create_comment(number=NNN, body="## Plan of Plans\n\nhttps://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/[plan-path]\n\nStrategic decomposition complete. Feature children will be created next.")
```

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

After all children are created and moved to "Ready for Plan", update the epic's plan-of-plans `## Feature Sequencing` section with the actual GH issue numbers assigned to each feature.

### Step 7: Orchestrate Feature Planning in Waves

Process waves sequentially. Within a wave, features with no shared dependencies can be planned in parallel (via parallel `Skill()` calls).

**For each wave**:

```
features_in_wave = [features from plan-of-plans Feature Sequencing, this wave only]

For each feature in wave (parallel where independent):
  # Build sibling context from completed plans in prior waves
  sibling_context = ""
  for each completed_sibling_plan in prior_waves:
    sibling_context += extract_sibling_context(sibling_plan)
    # Extract: ## Overview section, interface contracts (type names, function sigs, file paths)

  # Invoke ralph-plan for this feature
  Skill("ralph-hero:ralph-plan",
    "GH-{feature_number} --parent-plan {plan_of_plans_path} --sibling-context {sibling_context}")

# Wave completion verification
For each feature in wave:
  issue = ralph_hero__get_issue(number=feature_number)
  verify issue has exited Plan in Progress
  # Expected states: Plan in Review, In Progress, or Human Needed
  # If still Plan in Progress: wave is not complete — wait or investigate

# Next wave readiness check
For each feature in next_wave:
  verify all blocked_by features have completed plans (are in Plan in Review, In Progress, or Done)
```

**Wave completion detection**: Each `Skill()` call blocks until the feature plan is written. After all `Skill()` calls in a wave return, verify via `ralph_hero__get_issue` that all features have exited `Plan in Progress`.

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

**Plan revision during waves**: If a feature planner discovers a sibling's plan doesn't provide what's needed:
- **Minor** (missing field, easily added): planner notes in its plan, posts `## Plan Revision Request` on the sibling issue
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

Move epic to "In Progress": `ralph_hero__save_issue(number=NNN, workflowState="In Progress")`

Post completion comment on epic:
```
## Plan of Plans Complete

All feature plans created:
- Wave 1:
  - #NNN — [feature A name] — plan at [path]
  - #NNN — [feature C name] — plan at [path]
- Wave 2:
  - #NNN — [feature B name] — plan at [path]

Epic is now In Progress. Feature implementations will be orchestrated by hero/team.
```

### Step 10: Report (team context)

If running in a team, report via `TaskUpdate`. Include in metadata:
- `artifact_path`: path to plan-of-plans document
- `feature_count`: number of feature children created
- `wave_count`: number of planning waves completed
- `workflow_state`: "In Progress"

Human-readable summary: "Plan-of-plans for GH-NNN complete. [N] features across [W] waves. Epic now In Progress."

## Escalation

| Situation | Action |
|-----------|--------|
| Research document missing | STOP: "Issue #NNN has no research document. Run /ralph-research first." |
| Issue not L/XL | STOP: "Issue #NNN is not L/XL — use /ralph-plan for M/S/XS issues." |
| Feature dependency cycle detected | Escalate to Human Needed: post `## Dependency Cycle Detected` comment with cycle details |
| Wave planning fails — feature planner reports BLOCKED (major drift) | Escalate: `ralph_hero__save_issue(number=NNN, workflowState="Human Needed")`; post `## Escalation` comment with BLOCKED feature number and drift details |
| Feature not exiting Plan in Progress after Skill() returns | Investigate: check if feature went to Human Needed; if so, pause and escalate epic |
