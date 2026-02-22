---
description: Iterate on an existing implementation plan - reads the linked plan, understands your feedback, confirms approach, and makes surgical updates. Use when you want to refine, extend, or correct an approved plan.
argument-hint: "[#NNN or plan-path] [optional: feedback]"
model: opus
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - WebSearch
  - WebFetch
env:
  RALPH_GH_OWNER: "${RALPH_GH_OWNER}"
  RALPH_GH_REPO: "${RALPH_GH_REPO}"
  RALPH_GH_PROJECT_NUMBER: "${RALPH_GH_PROJECT_NUMBER}"
---

# Iterate Implementation Plan

You are tasked with updating existing implementation plans based on user feedback. You should be skeptical, thorough, and ensure changes are grounded in actual codebase reality.

## Plan Resolution

When given an argument, resolve it to both a **plan file** and a **GitHub issue**:

### Step 1: Parse the Argument

**If first argument matches `#\d+` pattern** (e.g., `#347`):
1. Query GitHub for the issue:
   ```
   ralph_hero__get_issue
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   ```
2. Search issue comments for `## Implementation Plan` header. If multiple matches, use the **most recent** (last) match.
3. Extract the GitHub URL from the line immediately after the header.
4. Convert to local path: strip `https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/` prefix.
5. Read the local plan file.
6. **Fallback** if no comment found: glob for plan doc:
   - `thoughts/shared/plans/*GH-${number}*`
   - `thoughts/shared/plans/*GH-$(printf '%04d' ${number})*`
   Use the most recent match if multiple found.
7. **Self-heal**: If plan found via glob but not linked via comment, post the missing comment:
   ```
   ralph_hero__create_comment
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - body: "## Implementation Plan\n\nhttps://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/[path]\n\n(Self-healed: artifact was found on disk but not linked via comment)"
   ```
8. **If no plan found**: STOP with "No implementation plan found for #NNN. Run /ralph-hero:create-plan first."
9. Remaining arguments after the issue number are the feedback/requested changes.

**If first argument is a file path**:
1. Verify file exists
2. Read frontmatter for `github_issue` or `github_issues` field
3. Remaining arguments are the feedback

### Step 2: State Transition (Conditional)

If issue is in "Plan in Review" or "Ready for Plan", offer to transition:
```
ralph_hero__update_workflow_state
- owner: $RALPH_GH_OWNER
- repo: $RALPH_GH_REPO
- number: [issue-number]
- state: "Plan in Progress"
- command: "iterate_plan"
```

If issue is already in "Plan in Progress", skip this step.

### Step 3: Proceed with Iteration

Continue to "Initial Response" section with the resolved plan path and feedback.

---

## Initial Response

When this command is invoked:

1. **Parse the input to identify**:
   - Plan file path (e.g., `thoughts/shared/plans/2026-02-22-GH-0347-feature.md`)
   - Requested changes/feedback

2. **Handle different input scenarios**:

   **If NO plan file provided**:
   ```
   I'll help you iterate on an existing implementation plan.

   Which plan would you like to update? Provide either:
   - A GitHub issue number: `/ralph-hero:iterate-plan #347`
   - A plan file path: `/ralph-hero:iterate-plan thoughts/shared/plans/2026-02-22-GH-0347-feature.md`

   Tip: You can list recent plans with `ls -lt thoughts/shared/plans/ | head`
   ```
   Wait for user input, then re-check for feedback.

   **If plan file provided but NO feedback**:
   ```
   I've found the plan at [path]. What changes would you like to make?

   For example:
   - "Add a phase for migration handling"
   - "Update the success criteria to include performance tests"
   - "Adjust the scope to exclude feature X"
   - "Split Phase 2 into two separate phases"
   ```
   Wait for user input.

   **If BOTH plan file AND feedback provided**:
   - Proceed immediately to Step 1
   - No preliminary questions needed

## Process Steps

### Step 1: Read and Understand Current Plan

1. **Read the existing plan file COMPLETELY**:
   - Use the Read tool WITHOUT limit/offset parameters
   - Understand the current structure, phases, and scope
   - Note the success criteria and implementation approach

2. **Understand the requested changes**:
   - Parse what the user wants to add/modify/remove
   - Identify if changes require codebase research
   - Determine scope of the update

3. **Check for GitHub issue link**:
   - Note if `github_issue` or `github_issues` field exists in frontmatter
   - This determines whether to offer GitHub update at end

### Step 2: Research If Needed

**Only spawn research tasks if the changes require new technical understanding.**

If the user's feedback requires understanding new code patterns or validating assumptions:

1. **Spawn parallel sub-tasks for research**:
   Use the right agent for each type of research:

   **For code investigation:**
   - **ralph-hero:codebase-locator** - To find relevant files
   - **ralph-hero:codebase-analyzer** - To understand implementation details
   - **ralph-hero:codebase-pattern-finder** - To find similar patterns

   **For historical context:**
   - **ralph-hero:thoughts-locator** - To find related research or decisions

   **Be EXTREMELY specific about directories**:
   - Include full path context in prompts
   - Specify which directories to focus on

   **Important**: Do NOT pass `team_name` to any `Task()` calls for sub-agents.

2. **Read any new files identified by research**:
   - Read them FULLY into the main context
   - Cross-reference with the plan requirements

3. **Wait for ALL sub-tasks to complete** before proceeding

### Step 3: Present Understanding and Approach

Before making changes, confirm your understanding:

```
Based on your feedback, I understand you want to:
- [Change 1 with specific detail]
- [Change 2 with specific detail]

My research found:
- [Relevant code pattern or constraint]
- [Important discovery that affects the change]

I plan to update the plan by:
1. [Specific modification to make]
2. [Another modification]

Does this align with your intent?
```

Get user confirmation before proceeding.

### Step 4: Update the Plan

1. **Make focused, precise edits** to the existing plan:
   - Use the Edit tool for surgical changes
   - Maintain the existing structure unless explicitly changing it
   - Keep all file:line references accurate
   - Update success criteria if needed

2. **Ensure consistency**:
   - If adding a new phase, ensure it follows the existing pattern
   - If modifying scope, update "What We're NOT Doing" section
   - If changing approach, update "Implementation Approach" section
   - Maintain the distinction between automated vs manual success criteria

3. **Preserve quality standards**:
   - Include specific file paths and line numbers for new content
   - Write measurable success criteria
   - Keep language clear and actionable

### Step 5: Review Changes

1. **Present the changes made**:
   ```
   I've updated the plan at `thoughts/shared/plans/[filename].md`

   Changes made:
   - [Specific change 1]
   - [Specific change 2]

   The updated plan now:
   - [Key improvement]
   - [Another improvement]

   Would you like any further adjustments?
   ```

2. **Be ready to iterate further** based on feedback

### Step 6: Update GitHub Issue

After changes are made, update the GitHub issue if linked:

1. **Post an update comment**:
   ```
   ralph_hero__create_comment
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - body: |
       ## Plan Updated

       Changes made:
       - [Change 1]
       - [Change 2]

       Reason: [User's feedback that prompted changes]
   ```

2. **Consider state transition**:
   - If plan was in "Plan in Review" and major changes were made, offer to move back to "Plan in Progress":
     ```
     ralph_hero__update_workflow_state
     - owner: $RALPH_GH_OWNER
     - repo: $RALPH_GH_REPO
     - number: [issue-number]
     - state: "Plan in Progress"
     - command: "iterate_plan"
     ```

3. **Report result**:
   ```
   Updated GitHub issue #NNN with:
   - Comment summarizing changes
   [If state changed: - Moved back to "Plan in Progress"]

   Next steps:
   - `/ralph-hero:iterate-plan #NNN` - Make further adjustments
   - `/ralph-hero:implement-plan #NNN` - Begin implementation
   ```

## Important Guidelines

1. **Be Skeptical**:
   - Don't blindly accept change requests that seem problematic
   - Question vague feedback - ask for clarification
   - Verify technical feasibility with code research
   - Point out potential conflicts with existing plan phases

2. **Be Surgical**:
   - Make precise edits, not wholesale rewrites
   - Preserve good content that doesn't need changing
   - Only research what's necessary for the specific changes
   - Don't over-engineer the updates

3. **Be Thorough**:
   - Read the entire existing plan before making changes
   - Research code patterns if changes require new technical understanding
   - Ensure updated sections maintain quality standards
   - Verify success criteria are still measurable

4. **Be Interactive**:
   - Confirm understanding before making changes
   - Show what you plan to change before doing it
   - Allow course corrections
   - Don't disappear into research without communicating

5. **No Open Questions**:
   - If the requested change raises questions, ASK
   - Research or get clarification immediately
   - Do NOT update the plan with unresolved questions
   - Every change must be complete and actionable

## Success Criteria Guidelines

When updating success criteria, always maintain the two-category structure:

1. **Automated Verification** (can be run by execution agents):
   - Commands that can be run: `npm test`, `npm run lint`, etc.
   - Specific files that should exist
   - Code compilation/type checking

2. **Manual Verification** (requires human testing):
   - UI/UX functionality
   - Performance under real conditions
   - Edge cases that are hard to automate
   - User acceptance criteria

## Sub-task Spawning Best Practices

When spawning research sub-tasks:

1. **Only spawn if truly needed** - don't research for simple changes
2. **Spawn multiple tasks in parallel** for efficiency
3. **Each task should be focused** on a specific area
4. **Provide detailed instructions** including:
   - Exactly what to search for
   - Which directories to focus on
   - What information to extract
   - Expected output format
5. **Request specific file:line references** in responses
6. **Wait for all tasks to complete** before synthesizing
7. **Verify sub-task results** - if something seems off, spawn follow-up tasks
