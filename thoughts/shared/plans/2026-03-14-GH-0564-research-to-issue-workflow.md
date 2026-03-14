---
date: 2026-03-14
status: draft
type: plan
github_issue: 564
github_issues: [564]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/564
primary_issue: 564
tags: [skills, research, workflow, issue-creation, interactive]
---

# Add Research-to-Issue Workflow - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-14-GH-0564-research-to-issue-workflow-gap]]
- builds_on:: [[2026-03-01-hello-session-briefing]]

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-564 | Add research-to-issue workflow in the research skill | S |

## Current State Analysis

The interactive `/research` skill produces research documents but has no built-in path to create GitHub issues from findings. Three workflows exist, but none cover the "question -> research -> discover actionable work -> create issue" pattern:

- **Idea pipeline** (`draft` -> `form`): Creates issues from ideas, not from research findings
- **Interactive research** (`research`): Can link to existing issues (Step 8), but cannot create new ones
- **Autonomous research** (`ralph-research`): Consumes existing issues, never creates them

When research reveals actionable work, users must manually call `ralph_hero__create_issue`, link the research doc, and update frontmatter -- exactly as happened with GH-563. The `form` skill's Step 5a provides an excellent pattern for issue creation that we can adapt.

### Key Files

- [`plugin/ralph-hero/skills/research/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/research/SKILL.md) - Interactive research skill (target for modification)
- [`plugin/ralph-hero/skills/form/SKILL.md:129-192`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/form/SKILL.md#L129-L192) - Reference pattern for issue creation from form (Step 5a)

## Desired End State

### Verification
- [ ] The `/research` skill offers to create a GitHub issue after presenting findings, when the research reveals actionable work
- [ ] Issue creation follows the established `form` Step 5a pattern (interactive draft, approval, create, link)
- [ ] The research document is automatically renamed, frontmatter-updated, and linked to the new issue via artifact comment
- [ ] The skill remains purely interactive (asks the user, waits for confirmation at each step)
- [ ] Existing Step 8 (link to existing issue) and Step 9/10 continue to work unchanged

## What We're NOT Doing
- Adding automatic issue creation (no autonomous behavior -- this is an interactive skill)
- Supporting ticket trees from research (that's the `form` skill's domain; could be a future enhancement)
- Modifying the `form` skill to accept research docs as input (separate concern)
- Modifying the `ralph-research` autonomous skill (it already has a different workflow)
- Adding MCP tools to the `allowed-tools` frontmatter (the research skill already has access to `ralph_hero__*` tools via the plugin's MCP server)

## Implementation Approach

Insert a new **Step 8b** into the existing research skill, positioned between the current Step 8 (issue linking) and Step 9 (present findings). The new step activates only when no issue was linked in Step 8 (i.e., the research was standalone, not tied to an existing issue). It follows the proven `form` Step 5a interactive pattern: draft -> approve -> create -> link.

The step ordering matters: Step 8 handles linking to existing issues. Step 8b handles creating new issues. Only one should activate per session. Step 9 (present findings) comes after both, so the user always gets the summary regardless of whether an issue was created.

---

## Phase 1: Add Step 8b - Create Issue from Research Findings
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/564 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-14-GH-0564-research-to-issue-workflow-gap.md

### Changes Required

#### 1. Insert Step 8b after Step 8 in the research skill
**File**: `plugin/ralph-hero/skills/research/SKILL.md`
**Location**: Between current Step 8 (lines ~181-211) and Step 9 (lines ~213-220)

**Changes**: Add a new `### Step 8b: Create issue from findings (optional)` section with these elements:

1. **Activation guard**: Only offer this step if:
   - `LINKED_ISSUE` was NOT set (i.e., the user didn't provide `#NNN` at the start, AND didn't link in Step 8)
   - The research findings reveal actionable work (use judgment from the findings content)

2. **Interactive prompt** - Present the user with options:
   ```
   Your research identified actionable work. Would you like to:
   1. **Create a GitHub issue** from the findings
   2. **Link to an existing issue** (#NNN)
   3. **Skip** - keep this as a standalone research document
   ```
   Wait for user response.

3. **If "Create a GitHub issue"** - Follow the `form` Step 5a pattern:

   a. **Draft the issue interactively**:
   ```
   Here's the proposed issue:

   **Title**: [concise, actionable title derived from findings]
   **Description**:
   ## Problem
   [What the research revealed]

   ## Current State
   [Summary of how things work now]

   ## Proposed Solution
   [What needs to change, derived from findings]

   ## Key Files
   [Code references from the research]

   ## Research
   See `thoughts/shared/research/[filename].md`

   **Labels**: [suggested labels]
   **Estimate**: [XS/S/M/L/XL based on scope]
   **Priority**: [suggested priority]

   Shall I create this issue, or would you like to adjust anything?
   ```

   b. **Wait for approval**, then create via MCP tools:
   ```
   ralph_hero__create_issue(title=..., body=..., labels=..., estimate=..., priority=..., workflowState="Backlog")
   ```

   c. **Set `LINKED_ISSUE`** to the newly created issue number, then fall through to the existing Step 8 linking logic (steps 1-3 of Step 8) to:
   - Rename the research doc to include `GH-NNNN`
   - Update frontmatter with `github_issue` and `github_url`
   - Post the artifact comment linking the research doc to the new issue

   This avoids duplicating the linking logic -- the existing Step 8 already handles all three operations. The only difference is that `LINKED_ISSUE` was set by creation rather than by the user providing `#NNN`.

   d. **Report**:
   ```
   Created: #NNN - [title]
   URL: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN

   The research document has been renamed and linked to the new issue.

   Next steps:
   - `/ralph-hero:research #NNN` - Continue research on this issue
   - `/ralph-hero:plan #NNN` - Create an implementation plan
   ```

4. **If "Link to an existing issue"** - Ask for the issue number, set `LINKED_ISSUE`, and fall through to the existing Step 8 linking logic.

5. **If "Skip"** - Proceed to Step 9 with no changes.

#### 2. Update Step 8 to support fall-through from Step 8b
**File**: `plugin/ralph-hero/skills/research/SKILL.md`
**Location**: Step 8 (lines ~181-211)

**Changes**: Refactor the Step 8 conditional slightly so that:
- The existing "offer to link" prompt is skipped if `LINKED_ISSUE` was already set by Step 8b (it was just created)
- The rename/frontmatter/artifact-comment logic executes unconditionally when `LINKED_ISSUE` is set, whether it came from the user's initial `#NNN`, from Step 8b creation, or from the Step 8b "link to existing" path
- This is a minor restructuring of the existing conditional, not a rewrite

Concretely, the current Step 8 structure is:
```
If LINKED_ISSUE was set OR user asks to link:
  1. Rename file
  2. Update frontmatter
  3. Post artifact comment
```

The updated structure becomes:
```
If LINKED_ISSUE was set (from initial args, Step 8 prompt, OR Step 8b):
  1. Offer to link (skip if LINKED_ISSUE was set by Step 8b -- user already approved)
  2. Rename file
  3. Update frontmatter
  4. Post artifact comment
```

#### 3. Add `ralph_hero__create_issue` and `ralph_hero__save_issue` to the allowed-tools list (if needed)
**File**: `plugin/ralph-hero/skills/research/SKILL.md`
**Location**: Frontmatter `allowed-tools` section (lines 7-14)

**Changes**: Check whether MCP tools from the plugin's `.mcp.json` are automatically available to skills, or need explicit listing. The research skill's current `allowed-tools` lists `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `Task`, `WebSearch`, `WebFetch`. However, the skill already uses `ralph_hero__get_issue` and `ralph_hero__list_issues` in Steps 3 and 8 without listing them in `allowed-tools` -- indicating MCP tools are available implicitly. **No change needed** unless testing reveals otherwise.

### Success Criteria
- [ ] Manual: Running `/research` with a question that reveals actionable work presents the 3-option prompt after findings
- [ ] Manual: Choosing "Create a GitHub issue" drafts an issue, waits for approval, creates via MCP, renames the research doc, updates frontmatter, and posts the artifact comment
- [ ] Manual: Choosing "Link to an existing issue" behaves like the existing Step 8 flow
- [ ] Manual: Choosing "Skip" proceeds directly to Step 9 (present findings)
- [ ] Manual: Running `/research #NNN` (with an existing issue) skips Step 8b entirely (no duplicate prompt)
- [ ] Manual: The research skill's frontmatter `allowed-tools` does not need MCP tool entries (verified by testing)

---

## Integration Testing
- [ ] End-to-end: Run `/research "does X have Y?"` where findings reveal work -> choose "Create issue" -> verify issue exists in GitHub with correct labels/estimate/priority and research doc is linked via artifact comment
- [ ] End-to-end: Run `/research #NNN` -> verify Step 8b is skipped and Step 8 linking works as before
- [ ] End-to-end: Run `/research "question"` -> choose "Skip" -> verify no issue created and findings are presented normally
- [ ] Regression: Verify existing Step 10 (follow-up questions) still works after the new step

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-14-GH-0564-research-to-issue-workflow-gap.md
- Related issues: https://github.com/cdubiel08/ralph-hero/issues/563 (the session that motivated this workflow gap)
- Pattern reference: `form` skill Step 5a (issue creation from idea)
