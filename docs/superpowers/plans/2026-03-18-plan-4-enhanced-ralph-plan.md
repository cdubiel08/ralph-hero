# Enhanced ralph-plan — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance `ralph-plan` to produce task-level metadata (tdd, complexity, depends_on, acceptance) within each phase, support `--parent-plan` and `--sibling-context` flags for tiered planning, and integrate with `ralph-split` to create children from plans.

**Architecture:** `ralph-plan/SKILL.md` is the autonomous planning skill. It's a markdown document with YAML frontmatter that Claude follows as instructions. Changes are primarily to the skill prose — adding new plan output format, new flags, and split integration. The existing hook chain (branch-gate, plan-research-required, plan-state-gate, plan-postcondition) remains unchanged. New hooks from Plan 2 (plan-tier-validator) are added to frontmatter.

**Tech Stack:** Markdown (SKILL.md), YAML frontmatter

**Spec:** `docs/superpowers/specs/2026-03-15-superpowers-ralph-hero-quality-integration-design.md` Sections 1 and 3

---

## Chunk 1: Plan Output Format Enhancement

### Task 1: Add task metadata format to ralph-plan output template

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-plan/SKILL.md:216-269`

The current plan template has phases with "### Changes Required" and "### Success Criteria". The enhanced format adds "### Tasks" with structured metadata blocks inside each phase.

- [ ] **Step 1: Read current SKILL.md to verify line numbers**

Run: `grep -n "## Phase" plugin/ralph-hero/skills/ralph-plan/SKILL.md | head -5`
Expected: Line numbers for phase template sections

- [ ] **Step 2: Replace phase template with enhanced task-level format**

In the plan document template section (around lines 216-269), replace the per-phase structure. The new format for each phase:

```markdown
## Phase N: [Atomic Issue GH-NNN — title]

### Overview
[What this phase accomplishes — 1-2 sentences]

### Tasks

#### Task N.1: [descriptive name]
- **files**: `path/to/file.ts` (create|modify|read)
- **tdd**: true | false
- **complexity**: low | medium | high
- **depends_on**: null | [N.M, ...]
- **acceptance**:
  - [ ] [Specific verifiable criterion with concrete values]
  - [ ] [Another criterion]

#### Task N.2: [descriptive name]
- **files**: `path/to/other.ts` (create), `path/to/file.ts` (read)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [N.1]
- **acceptance**:
  - [ ] [Criterion]

### Phase Success Criteria

#### Automated Verification:
- [ ] `[test command]` — all passing
- [ ] `[build command]` — no errors

#### Manual Verification:
- [ ] [Human-testable criterion]

**Creates for next phase**: [what this phase produces that the next needs]
```

- [ ] **Step 3: Add TDD flag guidelines to the planning instructions**

After the plan template, add a section the planner must follow when deciding TDD flags:

```markdown
### TDD Flag Decision Guide

When setting `tdd` on each task, follow these rules:

Set `tdd: true` when:
- Task creates or modifies functions/methods with testable behavior
- Task adds error handling paths
- Task implements business logic
- Task creates data transformations or parsers

Set `tdd: false` when:
- Pure wiring/configuration (imports, exports, config files)
- Type-only changes (interfaces, type definitions without logic)
- Migration/scaffolding
- Build/CI configuration changes
- Re-exports or barrel files

### Complexity Decision Guide

- **low**: touches 1 file, clear spec, mechanical implementation → haiku model
- **medium**: touches 2-3 files, requires pattern matching or integration → sonnet model
- **high**: multi-file coordination, design judgment, broad codebase understanding → opus model
```

- [ ] **Step 4: Add dispatchability self-check instruction**

Add to the planning instructions (after writing the plan, before committing):

```markdown
### Dispatchability Self-Check

Before committing the plan, verify each task passes the dispatchability test:

For every `#### Task` block, confirm:
1. A subagent reading ONLY this task block + shared constraints could implement it
2. `files` lists every file the subagent needs to touch
3. `acceptance` criteria are specific enough to verify mechanically
4. `depends_on` correctly identifies prerequisite tasks
5. No task requires reading the full plan to understand its scope

If any task fails this check, add more detail until it passes.
```

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-plan/SKILL.md
git commit -m "feat(ralph-plan): add task-level metadata format with TDD flags and dispatchability"
```

---

## Chunk 2: Parent Plan and Sibling Context Flags

### Task 2: Add --parent-plan flag support

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`

- [ ] **Step 1: Update argument-hint in frontmatter**

Change the `argument-hint` line to:

```yaml
argument-hint: [optional-issue-number] [--research-doc path] [--parent-plan path] [--sibling-context text]
```

- [ ] **Step 2: Add child plan mode detection to Step 2 (issue selection)**

After the existing issue selection logic, add:

```markdown
### Child Plan Mode

If `--parent-plan` was provided:
1. Read the parent plan-of-plans document fully
2. Extract the `## Shared Constraints` section — these apply to ALL tasks
3. Extract THIS feature's scope from the `## Feature Decomposition` section
4. Set `RALPH_PLAN_TYPE=plan` (not plan-of-plans)
5. Skip full codebase research — do targeted research only for gaps not covered by parent plan

The parent plan's shared constraints are inherited verbatim into this plan's `## Shared Constraints` section, extended with any feature-specific constraints discovered during targeted research.
```

- [ ] **Step 3: Add sibling context injection to research step**

In the context gathering step, add:

```markdown
### Sibling Context (if --sibling-context provided)

When planning a Wave 2+ feature, the epic planner provides concrete interface definitions from completed sibling plans:

```
Sibling Context: Feature A (GH-201) — PLANNED
Produces:
- src/types.ts: StreamConfig interface, StreamState enum
Interface contract: StreamConfig { name: string, sources: Source[] }
```

Use sibling context to:
- Reference concrete type names in task acceptance criteria
- Import from sibling-produced files in `depends_on` chains
- Validate that this feature's plan is compatible with sibling interfaces
```

- [ ] **Step 4: Add parent_plan frontmatter field to plan template**

Update the plan document frontmatter template to include:

```yaml
parent_plan: thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-epic.md  # if child of plan-of-plans
```

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-plan/SKILL.md
git commit -m "feat(ralph-plan): add --parent-plan and --sibling-context flags for tiered planning"
```

---

## Chunk 3: Split Integration for M Issues

### Task 3: Add split-after-plan for M issues with children

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`

- [ ] **Step 1: Expand valid_input_estimates**

Update the constraints section to accept M estimates in addition to XS/S:

```markdown
- Estimates: XS, S, or M (M issues produce plans with per-child phases)
```

- [ ] **Step 2: Add split integration step after plan commit**

After the existing Step 6 (commit and push), add a new conditional step:

```markdown
### Step 6.5: Split Integration (M issues only)

If the issue estimate is M and the plan has multiple phases mapping to atomic children:

1. Invoke `Skill("ralph-hero:ralph-split", "GH-NNN")` to create atomic child issues
2. For each child issue created:
   - Post `## Plan Reference` comment:
     ```
     ## Plan Reference

     https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/[plan-path]#phase-N

     Parent: #NNN
     Phase: N of M
     Shared constraints inherited from parent plan.
     ```
3. Move each child to "In Progress" via `ralph_hero__save_issue(number=child, workflowState="In Progress")`
4. Move parent to "In Progress" via `ralph_hero__save_issue(number=NNN, workflowState="In Progress")`

If the issue is XS/S (standalone), skip this step — the plan goes through normal `Plan in Review` flow.
```

- [ ] **Step 3: Update state transition table**

Update the skill's state transition documentation:

```markdown
### State Transitions

| Issue Size | Entry | Lock | Exit |
|------------|-------|------|------|
| XS/S (standalone) | Ready for Plan | Plan in Progress | Plan in Review |
| M (with children) | Ready for Plan | Plan in Progress | In Progress (after split) |
```

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-plan/SKILL.md
git commit -m "feat(ralph-plan): add split integration for M issues with automatic child creation"
```

---

## Chunk 4: Hook Registration

### Task 4: Add plan-tier-validator to skill frontmatter

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-plan/SKILL.md` (frontmatter)

- [ ] **Step 1: Add plan-tier-validator hook to frontmatter**

In the hooks section of the frontmatter, add:

```yaml
  - event: PreToolUse
    matcher: "ralph_hero__save_issue"
    command: "\"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-tier-validator.sh\""
    async: false
```

- [ ] **Step 2: Add RALPH_PLAN_TYPE to SessionStart env**

Update the `set-skill-env.sh` call in the SessionStart hook to include:

```yaml
  - event: SessionStart
    command: "\"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh\" RALPH_COMMAND=plan RALPH_REQUIRED_BRANCH=main RALPH_REQUIRES_RESEARCH=true RALPH_PLAN_TYPE=plan"
```

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-plan/SKILL.md
git commit -m "feat(ralph-plan): register plan-tier-validator hook and RALPH_PLAN_TYPE env"
```

---

## Final Verification

- [ ] **Verify SKILL.md is well-formed YAML frontmatter**

Run: `head -40 plugin/ralph-hero/skills/ralph-plan/SKILL.md`
Expected: Valid YAML frontmatter with updated hooks and argument-hint

- [ ] **Run MCP server tests**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: ALL PASS

---

## Summary of Changes

| File | What Changed |
|------|-------------|
| `skills/ralph-plan/SKILL.md` | Task-level metadata format, TDD flag guidelines, dispatchability self-check, --parent-plan/--sibling-context flags, split integration for M issues, plan-tier-validator hook, RALPH_PLAN_TYPE env |
