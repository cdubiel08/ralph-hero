---
date: 2026-02-21
github_issue: 248
github_url: https://github.com/cdubiel08/ralph-hero/issues/248
status: complete
type: research
---

# GH-248: Add Tree-Aware Assessment Before SPLIT Phase in Orchestrator Skills

## Problem Statement

The orchestrator SKILL.md files (`ralph-hero/SKILL.md` and `ralph-team/SKILL.md`) do not instruct the agent to check for existing sub-issues before entering the SPLIT phase. When `detect_pipeline_position` returns SPLIT, the orchestrator blindly spawns split tasks for all oversized issues without considering whether they already have children. This can cause duplicate sub-issue creation or wasted processing.

While GH-246 adds `subIssueCount` awareness to the `detect_pipeline_position` tool itself (so it no longer returns SPLIT for already-split issues), GH-248 adds a complementary defense-in-depth check at the orchestrator prompt level, and ensures the skill instructions reference the new tool capabilities.

## Current State Analysis

### ralph-hero SKILL.md (Hero Orchestrator)

**File**: [`plugin/ralph-hero/skills/ralph-hero/SKILL.md:100-112`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-hero/SKILL.md#L100-L112)

The SPLIT phase section currently reads:

```markdown
## PHASE: ANALYST - SPLIT

Split all M/L/XL issues until only XS/S leaves remain.

For each M/L/XL issue, spawn a background split task:
Task(subagent_type="general-purpose", run_in_background=true,
     prompt="Use Skill(skill='ralph-hero:ralph-split', args='NNN') to split issue #NNN.",
     description="Split #NNN")

Wait for all splits, then re-call detect_pipeline_position to check if more splitting is needed.
Loop until no M/L/XL issues remain.
```

Issues:
1. No instruction to call `list_sub_issues` before splitting
2. No awareness that some M/L/XL issues may already have children
3. No routing logic for children based on their workflow state
4. The loop relies entirely on `detect_pipeline_position` re-evaluation, which after GH-246 will correctly skip already-split issues -- but the orchestrator should also be aware of this behavior for logging/efficiency

### ralph-team SKILL.md (Team Orchestrator)

**File**: [`plugin/ralph-hero/skills/ralph-team/SKILL.md:84-106`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L84-L106)

Section 3 (State Detection) calls `detect_pipeline_position` and trusts its phase output. There is no mention that the tool now handles already-split issues automatically.

Section 4.2 (Create Tasks for Remaining Phases) creates SPLIT tasks without checking for existing children:

```markdown
**Subject patterns** (workers match on these to self-claim):
- "Research GH-NNN" / "Plan GH-NNN" / ...
```

There is no SPLIT subject pattern listed (it uses analyst worker with the ralph-split skill), but the task creation logic doesn't filter out already-split issues when creating split tasks.

### ralph-split SKILL.md (Split Skill)

**File**: [`plugin/ralph-hero/skills/ralph-split/SKILL.md:111-127`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-split/SKILL.md#L111-L127)

Step 2.25 ("Discover Existing Children") already checks for existing sub-issues before splitting. This is the last line of defense and is correctly implemented. No changes needed here per the issue description.

### detect_pipeline_position Tool (After GH-246)

After GH-246 is implemented, `detect_pipeline_position` will include `subIssueCount` in the `IssueState` and skip SPLIT for oversized issues with `subIssueCount > 0`. This means:

1. For M/L/XL issues that already have children, the tool will NOT return SPLIT
2. The `issues` array in the response will include `subIssueCount` for each issue
3. The orchestrator can use this data to make informed routing decisions

### list_sub_issues Tool (After GH-247)

After GH-247 is implemented, `list_sub_issues` accepts an optional `depth` parameter (1-3) for recursive traversal. This enables the orchestrator to fetch the full tree structure in a single call when needed for routing decisions.

## Key Discoveries

### 1. Three Layers of Defense

The fix spans three layers, each providing defense-in-depth:

| Layer | Component | Defense | Status |
|-------|-----------|---------|--------|
| Tool | `detect_pipeline_position` | Skip SPLIT for `subIssueCount > 0` | GH-246 (in progress) |
| Orchestrator | `ralph-hero/SKILL.md`, `ralph-team/SKILL.md` | Check children before spawning split tasks | GH-248 (this issue) |
| Skill | `ralph-split/SKILL.md` Step 2.25 | Discover existing children, reuse/skip | Already implemented |

### 2. Orchestrator Changes Are Prompt-Only

GH-248 is entirely about updating markdown skill instructions. No TypeScript code changes. This makes it a clean XS task with zero risk of breaking existing functionality.

### 3. ralph-hero SKILL.md Changes Needed

The SPLIT phase section needs to instruct the agent to:
1. Before spawning split tasks, call `list_sub_issues(number=NNN, depth=2)` for each oversized issue
2. Skip issues that already have children (don't spawn a split task for them)
3. Route existing children based on their workflow state:
   - Children in Backlog/Research Needed -> they will be picked up by RESEARCH phase naturally
   - Children already in later states -> no action needed
4. Reference that `detect_pipeline_position` now handles this automatically (after GH-246), so this check is defense-in-depth

### 4. ralph-team SKILL.md Changes Needed

Two sections need updates:
1. **Section 3** (State Detection): Add a note that `detect_pipeline_position` now handles already-split detection automatically via `subIssueCount` in the response. The lead can trust the tool's phase decision.
2. **Section 4.2** (Create Tasks for Remaining Phases): When creating SPLIT tasks, note that the `detect_pipeline_position` response's `issues` array includes `subIssueCount`. Only create split tasks for issues where `subIssueCount === 0`. Issues with existing children should be skipped.

### 5. Interaction with detect_pipeline_position Response

After GH-246, the `detect_pipeline_position` response includes:
```json
{
  "phase": "SPLIT",
  "issues": [
    { "number": 42, "title": "...", "estimate": "M", "subIssueCount": 0 },
    { "number": 43, "title": "...", "estimate": "L", "subIssueCount": 3 }
  ]
}
```

Issue #43 would NOT trigger SPLIT at the tool level (GH-246 handles this). But if both are in the same group and #42 still needs splitting, the phase will be SPLIT. The orchestrator needs to know to only spawn a split task for #42, not #43.

### 6. No Changes Needed to ralph-split SKILL.md

Confirmed: Step 2.25 already handles existing children discovery. The issue body explicitly states "No changes needed here."

## Potential Approaches

### Approach A: Minimal Prompt Update (Recommended)

Add a brief instruction block to the SPLIT phase in `ralph-hero/SKILL.md` and a note to Section 3 and 4.2 in `ralph-team/SKILL.md`. Reference the `detect_pipeline_position` tool's automatic handling and the `list_sub_issues` tool for deeper inspection.

**Pros:**
- Minimal change to existing skill instructions
- Defense-in-depth without duplicating tool-level logic
- Leverages existing tools (list_sub_issues, detect_pipeline_position)

**Cons:**
- Slightly more verbose SPLIT phase section

### Approach B: Detailed State Routing Table

Add a full state routing table in the SPLIT phase that maps each possible child state to an action.

**Pros:**
- Comprehensive coverage of edge cases
- Self-documenting behavior

**Cons:**
- Over-engineering for a defense-in-depth check
- The ralph-split skill already handles child routing in Step 2.25
- More text to maintain

### Recommended: Approach A

The orchestrator-level check should be lightweight. The heavy lifting is done by `detect_pipeline_position` (GH-246) and `ralph-split` Step 2.25. The orchestrator just needs to know: "If an issue already has children, skip the split task for it."

## Specific Changes

### 1. ralph-hero SKILL.md: SPLIT Phase Update

In the "PHASE: ANALYST - SPLIT" section (lines 100-112), insert after the header and before the "For each M/L/XL issue" instruction:

```markdown
**Pre-check**: The `detect_pipeline_position` tool automatically skips SPLIT for issues
that already have sub-issues (subIssueCount > 0 in the response). If the phase is SPLIT,
only issues with `subIssueCount === 0` in the `issues` array need splitting. Skip any
issue that already has children -- its children will be picked up by later phases
(RESEARCH, PLAN, etc.) based on their own workflow state.

If you need to inspect the existing tree before deciding, call:
```
ralph_hero__list_sub_issues(owner=$RALPH_GH_OWNER, repo=$RALPH_GH_REPO, number=NNN, depth=2)
```
```

### 2. ralph-team SKILL.md: Section 3 Update

In Section 3 (State Detection & Pipeline Position), after the bullet list of return fields, add:

```markdown
**Already-split detection**: The tool automatically accounts for existing sub-issues.
Issues with `subIssueCount > 0` are excluded from SPLIT phase triggering. When the
response includes `phase: "SPLIT"`, only issues in the `issues` array with
`subIssueCount === 0` need split tasks.
```

### 3. ralph-team SKILL.md: Section 4.2 Update

In Section 4.2, in the "Subject patterns" area or in the Groups section, add a note about SPLIT tasks:

```markdown
**SPLIT tasks**: Only create split tasks for issues without existing children
(`subIssueCount === 0` in the `detect_pipeline_position` response). Issues that already
have sub-issues are automatically excluded from the SPLIT phase by the detection tool.
```

## Risks

1. **No risk of breaking changes**: All modifications are prompt-only (markdown). No TypeScript code changes.
2. **Low risk of behavior regression**: The instructions add a pre-check that is defense-in-depth. Even without it, GH-246 and ralph-split Step 2.25 handle the already-split case.
3. **Dependency risk**: These changes reference `subIssueCount` in the `detect_pipeline_position` response, which is added by GH-246. If GH-248 is implemented before GH-246, the instructions will reference a field that doesn't exist yet. **Mitigation**: GH-248 depends on GH-246 being merged first.

## Recommended Next Steps

1. Wait for GH-246 and GH-247 to be merged (they provide the tool-level changes)
2. Update `ralph-hero/SKILL.md` SPLIT phase section with pre-check instruction
3. Update `ralph-team/SKILL.md` Section 3 with already-split detection note
4. Update `ralph-team/SKILL.md` Section 4.2 with SPLIT task filtering note
5. No test changes needed (prompt-only changes)
