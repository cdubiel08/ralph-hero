---
date: 2026-02-21
status: draft
github_issues: [248]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/248
primary_issue: 248
---

# Add Tree-Aware Assessment Before SPLIT Phase - Implementation Plan

## Overview
1 issue for prompt-only changes to orchestrator skill files:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-248 | fix(orchestrator-skills): add tree-aware assessment before SPLIT phase | XS |

## Current State Analysis

Three layers of defense-in-depth protect against re-splitting already-split issues:

| Layer | Component | Defense | Status |
|-------|-----------|---------|--------|
| Tool | `detect_pipeline_position` | Skip SPLIT for `subIssueCount > 0` | GH-246 (in progress) |
| Orchestrator | `ralph-hero/SKILL.md`, `ralph-team/SKILL.md` | Check children before spawning split tasks | GH-248 (this plan) |
| Skill | `ralph-split/SKILL.md` Step 2.25 | Discover existing children, reuse/skip | Already implemented |

### ralph-hero SKILL.md Current State

The SPLIT phase section ([`plugin/ralph-hero/skills/ralph-hero/SKILL.md:100-112`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-hero/SKILL.md#L100-L112)) blindly spawns split tasks for all M/L/XL issues without checking for existing sub-issues:

```markdown
## PHASE: ANALYST - SPLIT

Split all M/L/XL issues until only XS/S leaves remain.

For each M/L/XL issue, spawn a background split task:
```

No pre-check. No awareness of `subIssueCount` in the `detect_pipeline_position` response.

### ralph-team SKILL.md Current State

Section 3 ([`plugin/ralph-hero/skills/ralph-team/SKILL.md:84-106`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L84-L106)) trusts `detect_pipeline_position` output but does not mention the tool's automatic handling of already-split issues.

Section 4.2 ([`plugin/ralph-hero/skills/ralph-team/SKILL.md:124-140`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L124-L140)) creates tasks based on pipeline position without filtering already-split issues from SPLIT task creation.

### ralph-split SKILL.md (No Changes Needed)

Step 2.25 ("Discover Existing Children") at [`plugin/ralph-hero/skills/ralph-split/SKILL.md:111-127`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-split/SKILL.md#L111-L127) already calls `list_sub_issues` and compares existing children against proposed splits. This is the last line of defense and is correctly implemented.

## Desired End State

### Verification
- [ ] ralph-hero SKILL.md SPLIT phase includes pre-check instruction to inspect `subIssueCount` from `detect_pipeline_position` response and skip issues that already have children
- [ ] ralph-hero SKILL.md SPLIT phase references `list_sub_issues(depth=2)` for deeper tree inspection when needed
- [ ] ralph-team SKILL.md Section 3 notes that `detect_pipeline_position` automatically excludes already-split issues from SPLIT phase
- [ ] ralph-team SKILL.md Section 4.2 notes that SPLIT tasks should only target issues without existing children (`subIssueCount === 0`)
- [ ] No changes to ralph-split SKILL.md (confirmed Step 2.25 already handles this)

## What We're NOT Doing
- MCP server code changes (handled by GH-246 and GH-247)
- Changes to ralph-split SKILL.md (Step 2.25 already correct)
- Adding new MCP tools or parameters
- Test changes (prompt-only modifications)

## Implementation Approach

All changes are prompt-only (markdown edits to SKILL.md files). Two files are modified: `ralph-hero/SKILL.md` and `ralph-team/SKILL.md`. The edits add references to tool capabilities delivered by GH-246 (`subIssueCount` in `detect_pipeline_position`) and GH-247 (`depth` parameter in `list_sub_issues`).

---

## Phase 1: GH-248 - Add tree-aware assessment to orchestrator SKILL.md files
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/248 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0248-orchestrator-skills-tree-aware-split.md

### Changes Required

#### 1. Update SPLIT phase in ralph-hero SKILL.md
**File**: [`plugin/ralph-hero/skills/ralph-hero/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-hero/SKILL.md)

**Location**: Lines 100-112, the "PHASE: ANALYST - SPLIT" section

**Changes**: Insert a pre-check block between the section header (line 102) and the "For each M/L/XL issue" instruction (line 104). The new text instructs the orchestrator to:

1. Check the `issues` array from the `detect_pipeline_position` response for `subIssueCount`
2. Only spawn split tasks for issues where `subIssueCount === 0`
3. For issues that already have children, note that children will be processed by later phases based on their workflow state
4. Optionally call `list_sub_issues(number=NNN, depth=2)` if deeper tree inspection is needed

**Exact edit** -- replace the current SPLIT phase section (lines 100-112):

```markdown
## PHASE: ANALYST - SPLIT

Split all M/L/XL issues until only XS/S leaves remain.

**Pre-check**: The `detect_pipeline_position` response's `issues` array includes `subIssueCount` for each issue. Only split issues where `subIssueCount === 0`. Issues that already have children have been split previously -- their children will be picked up by later phases (RESEARCH, PLAN, etc.) based on their own workflow state.

If you need to inspect the existing tree before deciding, call:
```
ralph_hero__list_sub_issues(owner=$RALPH_GH_OWNER, repo=$RALPH_GH_REPO, number=NNN, depth=2)
```

For each M/L/XL issue **with `subIssueCount === 0`**, spawn a background split task:
```
Task(subagent_type="general-purpose", run_in_background=true,
     prompt="Use Skill(skill='ralph-hero:ralph-split', args='NNN') to split issue #NNN.",
     description="Split #NNN")
```

Wait for all splits, then re-call `detect_pipeline_position` to check if more splitting is needed. Loop until no M/L/XL issues remain.
```

#### 2. Update Section 3 in ralph-team SKILL.md
**File**: [`plugin/ralph-hero/skills/ralph-team/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md)

**Location**: Lines 86-92, after the bullet list of `detect_pipeline_position` return fields

**Changes**: Insert a note after the `recommendation` bullet (line 91) and before the "Use `phase` to determine tasks" sentence (line 92). The note explains that the tool automatically handles already-split issues.

**Exact edit** -- insert after line 91 (`- \`recommendation\`: Suggested next action`):

```markdown

**Already-split detection**: The tool automatically accounts for existing sub-issues. Issues with `subIssueCount > 0` are excluded from SPLIT phase triggering. When the response includes `phase: "SPLIT"`, the `issues` array only lists issues that still need splitting (`subIssueCount === 0`).
```

#### 3. Update Section 4.2 in ralph-team SKILL.md
**File**: [`plugin/ralph-hero/skills/ralph-team/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md)

**Location**: Lines 124-140, the "Create Tasks for Remaining Phases" section

**Changes**: Add a note about SPLIT task filtering after the "Subject patterns" list (line 129) and before the "Review task creation" note (line 131). The note clarifies that SPLIT tasks should only be created for issues without existing children.

**Exact edit** -- insert after line 130 (`- \`"Research GH-NNN"\` / \`"Plan GH-NNN"\` / ...`):

```markdown

**SPLIT tasks**: Only create split tasks for issues without existing children (`subIssueCount === 0` in the `detect_pipeline_position` response). Issues that already have sub-issues are automatically excluded from the SPLIT phase by the detection tool, so they should not appear in the `issues` array. This is defense-in-depth -- verify before creating tasks.
```

### Success Criteria
- [x] Manual: Read `plugin/ralph-hero/skills/ralph-hero/SKILL.md` and confirm the SPLIT phase section includes the pre-check instruction referencing `subIssueCount` and `list_sub_issues(depth=2)`
- [x] Manual: Read `plugin/ralph-hero/skills/ralph-team/SKILL.md` Section 3 and confirm it mentions automatic already-split detection
- [x] Manual: Read `plugin/ralph-hero/skills/ralph-team/SKILL.md` Section 4.2 and confirm it notes SPLIT task filtering by `subIssueCount`
- [x] Manual: Confirm `plugin/ralph-hero/skills/ralph-split/SKILL.md` is unchanged (Step 2.25 already handles existing children)

---

## Integration Testing
- [ ] Read all three SKILL.md files and verify consistency: ralph-hero references `subIssueCount` from `detect_pipeline_position`, ralph-team references same, ralph-split unchanged
- [ ] Verify no contradictory instructions between the three files
- [ ] Verify the pre-check in ralph-hero SKILL.md does not conflict with the existing loop logic ("Wait for all splits, then re-call `detect_pipeline_position`")

## References
- Research GH-248: [thoughts/shared/research/2026-02-21-GH-0248-orchestrator-skills-tree-aware-split.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0248-orchestrator-skills-tree-aware-split.md)
- Research GH-246: [thoughts/shared/research/2026-02-21-GH-0246-pipeline-detection-skip-split-sub-issues.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0246-pipeline-detection-skip-split-sub-issues.md)
- Research GH-247: [thoughts/shared/research/2026-02-21-GH-0247-list-sub-issues-recursive-depth.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0247-list-sub-issues-recursive-depth.md)
- Sibling plan (GH-246 + GH-247): [thoughts/shared/plans/2026-02-21-group-GH-0246-pipeline-skip-split-sub-issues.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-21-group-GH-0246-pipeline-skip-split-sub-issues.md)
- Parent epic: [GH-202](https://github.com/cdubiel08/ralph-hero/issues/202)
