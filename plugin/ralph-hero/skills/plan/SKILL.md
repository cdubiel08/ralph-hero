---
description: Interactive implementation planning with human collaboration. Researches codebase, asks clarifying questions, proposes approaches, iterates on structure with the user, then writes a phased plan document. Use this skill when you want to plan interactively, create a spec collaboratively, or need human input during planning. This is the human-in-the-loop planner — unlike ralph-plan (autonomous, no questions), this skill works WITH the user through research, design options, and incremental approval.
argument-hint: "[optional: #NNN issue number, file path, or description]"
model: opus
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - Agent
  - WebSearch
  - WebFetch
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

# Implementation Plan

You are tasked with creating detailed implementation plans through an interactive, iterative process. You should be skeptical, thorough, and work collaboratively with the user to produce high-quality technical specifications.

## Initial Response

When this command is invoked:

1. **Check if parameters were provided** (via `ARGUMENTS`):
   - If a file path, `#NNN` issue reference, or description was provided, skip the default message
   - If `#NNN` is provided, fetch the issue: `ralph_hero__get_issue(number=NNN)` — read title, body, and comments for full context
   - Immediately read any provided files FULLY
   - Begin the research process

2. **If no parameters provided**, respond with:
```
I'll help you create a detailed implementation plan. Let me start by understanding what we're building.

Please provide:
1. The task/ticket description (or reference to a GitHub issue like #123)
2. Any relevant context, constraints, or specific requirements
3. Links to related research or previous implementations

I'll analyze this information and work with you to create a comprehensive plan.

Tip: You can also invoke this command with an issue directly: `/ralph-hero:plan #123`
Or with a research doc: `/ralph-hero:plan thoughts/shared/research/2026-01-21-GH-0123-feature.md`
```

Then wait for the user's input.

## Process Steps

### Step 1: Context Gathering & Initial Analysis

1. **Read all mentioned files immediately and FULLY**:
   - Research documents (e.g., `thoughts/shared/research/YYYY-MM-DD-GH-NNNN-*.md`)
   - Related implementation plans
   - Any JSON/data files mentioned
   - **IMPORTANT**: Use the Read tool WITHOUT limit/offset parameters to read entire files
   - **CRITICAL**: DO NOT spawn sub-tasks before reading these files yourself in the main context
   - **NEVER** read files partially - if a file is mentioned, read it completely

   **Knowledge graph shortcut**: If `knowledge_search` is available, try it first to find related research:
   ```
   knowledge_search(query="research [topic keywords]", type="research", limit=5)
   ```
   If results are returned, read the top matches for context. This supplements (not replaces) the issue comment check and thoughts-locator search below.

2. **If a `#NNN` issue was provided**, fetch it directly:
   ```
   ralph_hero__get_issue(number=NNN)
   ```
   Read the full response including comments. Check comments for linked research documents (look for `## Research Document` header per Artifact Comment Protocol).

3. **Spawn initial research tasks to gather context**:
   Before asking the user any questions, use specialized agents to research in parallel:

   - `Agent(subagent_type="ralph-hero:codebase-locator", prompt="Find all files related to [task topic]")`
   - `Agent(subagent_type="ralph-hero:codebase-analyzer", prompt="Understand how [component] currently works")`
   - `Agent(subagent_type="ralph-hero:thoughts-locator", prompt="Find existing thoughts documents about [feature]")` (if relevant)

   > **Team Isolation**: Do NOT pass `team_name` to these sub-agent `Agent()` calls (per ADR-001 in shared/conventions.md).

   After locator agents return, dispatch analyzers on the most relevant findings:
   - `Agent(subagent_type="ralph-hero:thoughts-analyzer", prompt="Extract key decisions, constraints, and specs from thoughts documents about [feature]")`

   These agents will:
   - Find relevant source files, configs, and tests
   - Identify the specific directories to focus on
   - Trace data flow and key functions
   - Return detailed explanations with file:line references

4. **Read code files identified by research tasks**:
   - After research tasks complete, read code files they identified as relevant
   - Read them FULLY into the main context
   - For thought documents, rely on thoughts-analyzer output rather than reading raw docs
   - This keeps the main context focused on code while leveraging structured insight extraction

5. **Analyze and verify understanding**:
   - Cross-reference the requirements with actual code
   - Identify any discrepancies or misunderstandings
   - Note assumptions that need verification
   - Determine true scope based on codebase reality

6. **Present informed understanding and focused questions**:
   ```
   Based on the issue and my research of the codebase, I understand we need to [accurate summary].

   I've found that:
   - [Current implementation detail with file:line reference]
   - [Relevant pattern or constraint discovered]
   - [Potential complexity or edge case identified]

   Questions that my research couldn't answer:
   - [Specific technical question that requires human judgment]
   - [Business logic clarification]
   - [Design preference that affects implementation]
   ```

   Only ask questions that you genuinely cannot answer through code investigation.

### Step 2: Research & Discovery

After getting initial clarifications:

1. **If the user corrects any misunderstanding**:
   - DO NOT just accept the correction
   - Spawn new research tasks to verify the correct information
   - Read the specific files/directories they mention
   - Only proceed once you've verified the facts yourself

2. **Spawn parallel sub-tasks for comprehensive research**:
   - Create multiple Task agents to research different aspects concurrently
   - Use the right agent for each type of research:

   **For deeper investigation:**
   - `Agent(subagent_type="ralph-hero:codebase-locator", prompt="Find files related to [specific aspect]")`
   - `Agent(subagent_type="ralph-hero:codebase-analyzer", prompt="Understand implementation details of [component]")`
   - `Agent(subagent_type="ralph-hero:codebase-pattern-finder", prompt="Find similar features we can model after for [feature]")`

   **For historical context:**
   - `Agent(subagent_type="ralph-hero:thoughts-locator", prompt="Find research, plans, or decisions about [area]")`

   After locator agents return, dispatch analyzers on the most relevant findings:
   - `Agent(subagent_type="ralph-hero:thoughts-analyzer", prompt="Analyze decisions and constraints from [area] documents")`

   **For existing issues:**
   - Use `ralph_hero__list_issues(query=...)` to find related issues directly

   > **Team Isolation**: Do NOT pass `team_name` to sub-agent `Agent()` calls.

3. **Wait for ALL sub-tasks to complete** before proceeding

4. **Present findings and design options**:
   ```
   Based on my research, here's what I found:

   **Current State:**
   - [Key discovery about existing code]
   - [Pattern or convention to follow]

   **Design Options:**
   1. [Option A] - [pros/cons]
   2. [Option B] - [pros/cons]

   **Open Questions:**
   - [Technical uncertainty]
   - [Design decision needed]

   Which approach aligns best with your vision?
   ```

### Step 3: Plan Structure Development

Once aligned on approach:

1. **Create initial plan outline**:
   ```
   Here's my proposed plan structure:

   ## Overview
   [1-2 sentence summary]

   ## Implementation Phases:
   1. [Phase name] - [what it accomplishes]
   2. [Phase name] - [what it accomplishes]
   3. [Phase name] - [what it accomplishes]

   Does this phasing make sense? Should I adjust the order or granularity?
   ```

2. **Get feedback on structure** before writing details

### Step 4: Detailed Plan Writing

After structure approval:

1. **Write the plan** to `thoughts/shared/plans/`
   - Format (with issue): `YYYY-MM-DD-GH-NNNN-description.md` (zero-padded to 4 digits)
   - Format (without issue): `YYYY-MM-DD-description.md`
   - Group plan: `YYYY-MM-DD-group-GH-NNNN-description.md`
   - Examples:
     - With issue: `2026-01-21-GH-0146-ticket-resolution.md`
     - Without issue: `2026-01-21-improve-error-handling.md`
     - Group: `2026-01-21-group-GH-0042-redis-caching.md`
   - **Note**: If no issue exists yet, write without GH-NNNN. The file will be renamed when linked in Step 6.

2. **Use this template structure**:

````markdown
---
date: YYYY-MM-DD
status: draft
type: plan
tags: [relevant, component, tags]     # 2-5 tags describing the plan's subject matter
github_issue: NNN               # singular integer — for the knowledge indexer (same as primary_issue)
github_issues: [NNN]           # optional until linked to an issue
github_urls:                    # optional until linked to an issue
  - https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
primary_issue: NNN              # optional until linked to an issue
---

# [Feature/Task Name] Implementation Plan

## Prior Work

- builds_on:: [[research-doc-filename]]

## Overview

[Brief description of what we're implementing and why]

## Current State Analysis

[What exists now, what's missing, key constraints discovered]

## Desired End State

[A Specification of the desired end state after this plan is complete, and how to verify it]

### Key Discoveries:
- [Important finding with file:line reference]
- [Pattern to follow]
- [Constraint to work within]

## What We're NOT Doing

[Explicitly list out-of-scope items to prevent scope creep]

## Implementation Approach

[High-level strategy and reasoning]

## Phase 1: [Descriptive Name]

### Overview
[What this phase accomplishes]

### Changes Required:

#### 1. [Component/File Group]
**File**: `path/to/file.ext`
**Changes**: [Summary of changes]

```[language]
// Specific code to add/modify
```

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Type checking passes: `npm run build`
- [ ] Linting passes

#### Manual Verification:
- [ ] Feature works as expected when tested
- [ ] No regressions in related features

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: [Descriptive Name]

[Similar structure with both automated and manual success criteria...]

---

## Testing Strategy

### Unit Tests:
- [What to test]
- [Key edge cases]

### Integration Tests:
- [End-to-end scenarios]

### Manual Testing Steps:
1. [Specific step to verify feature]
2. [Another verification step]

## Performance Considerations

[Any performance implications or optimizations needed]

## Migration Notes

[If applicable, how to handle existing data/systems]

## References

- Original issue: #NNN
- Related research: `thoughts/shared/research/[relevant].md`
- Similar implementation: `[file:line]`
````

### Step 5: Review

1. **Present the draft plan location**:
   ```
   I've created the initial implementation plan at:
   `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-description.md`

   Please review it and let me know:
   - Are the phases properly scoped?
   - Are the success criteria specific enough?
   - Any technical details that need adjustment?
   - Missing edge cases or considerations?
   ```

2. **Iterate based on feedback** - be ready to:
   - Add missing phases
   - Adjust technical approach
   - Clarify success criteria (both automated and manual)
   - Add/remove scope items

3. **Continue refining** until the user is satisfied

### Step 6: GitHub Integration (Optional)

After the plan is finalized and the user is satisfied:

1. **Offer to link to a GitHub issue**:
   ```
   Would you like to link this plan to a GitHub issue?

   Options:
   1. Link to existing issue (provide issue number like #123)
   2. Create new issue from this plan
   3. Skip GitHub integration
   ```

2. **If linking to existing issue**:
   - Verify issue exists using `ralph_hero__get_issue(number=NNN)`
   - **Rename file if needed**: If the filename doesn't contain `GH-NNNN`, rename it:
     ```bash
     # Example: 2026-03-06-improve-error-handling.md -> 2026-03-06-GH-0542-improve-error-handling.md
     mv thoughts/shared/plans/YYYY-MM-DD-description.md thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-description.md
     ```
     Use zero-padded 4-digit issue number. Insert `GH-NNNN-` after the date prefix.
   - Post plan link comment using the Artifact Comment Protocol (use the **new** filename):
     ```
     ralph_hero__create_comment(number=NNN, body="## Implementation Plan\n\nhttps://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/plans/[filename].md\n\nSummary: [1-3 line summary of the plan]")
     ```
   - Update plan frontmatter with issue reference:
     ```yaml
     github_issue: NNN              # singular — for the knowledge indexer
     github_issues: [NNN]
     github_urls:
       - https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
     primary_issue: NNN
     ```
     Set `github_issue` to the same value as `primary_issue` (singular integer for the knowledge indexer).
   - Offer to advance the issue:
     ```
     Would you like to advance #NNN?
     1. Move to "Plan in Review" (for later autonomous review via /ralph-review)
     2. Move to "In Progress" (you've reviewed the plan interactively — ready for implementation)
     3. Skip state transition
     ```
     If option 1: `ralph_hero__save_issue(number=NNN, workflowState="Plan in Review")`
     If option 2: `ralph_hero__save_issue(number=NNN, workflowState="In Progress")`

3. **If creating new issue**:
   - Use `ralph_hero__create_issue(title=..., body=...)` with plan summary as body
   - Use `ralph_hero__save_issue(number=..., estimate="XS|S|M|L|XL")` to set estimate
   - **Rename file** to include the new issue number (same rename pattern as option 2)
   - Post plan link comment (same Artifact Comment Protocol as above, using renamed filename)
   - Update plan frontmatter with new issue reference (including `github_issue: NNN` for the knowledge indexer)
   - Offer to advance the issue (same 3 options as above)

4. **Report result**:
   ```
   Plan linked to GitHub issue: #NNN
   URL: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
   ```
   If moved to "In Progress": `Ready for implementation. Use /ralph-hero:impl #NNN to start.`
   If moved to "Plan in Review": `The plan is ready for review. Use /ralph-hero:ralph-review #NNN or /ralph-hero:impl #NNN after approval.`

## Important Guidelines

1. **Be Skeptical**:
   - Question vague requirements
   - Identify potential issues early
   - Ask "why" and "what about"
   - Don't assume - verify with code

2. **Be Interactive**:
   - Don't write the full plan in one shot
   - Get buy-in at each major step
   - Allow course corrections
   - Work collaboratively

3. **Be Thorough**:
   - Read all context files COMPLETELY before planning
   - Research actual code patterns using parallel sub-tasks
   - Include specific file paths and line numbers
   - Write measurable success criteria with clear automated vs manual distinction

4. **Be Practical**:
   - Focus on incremental, testable changes
   - Consider migration and rollback
   - Think about edge cases
   - Include "what we're NOT doing"

5. **No Open Questions in Final Plan**:
   - If you encounter open questions during planning, STOP
   - Research or ask for clarification immediately
   - Do NOT write the plan with unresolved questions
   - The implementation plan must be complete and actionable
   - Every decision must be made before finalizing the plan

## Success Criteria Guidelines

**Always separate success criteria into two categories:**

1. **Automated Verification** (can be run by execution agents):
   - Commands that can be run: `npm test`, `npm run build`, etc.
   - Specific files that should exist
   - Code compilation/type checking
   - Automated test suites

2. **Manual Verification** (requires human testing):
   - UI/UX functionality
   - Performance under real conditions
   - Edge cases that are hard to automate
   - User acceptance criteria

**Format example:**
```markdown
### Success Criteria:

#### Automated Verification:
- [ ] All unit tests pass: `npm test`
- [ ] No linting errors: `npm run build`
- [ ] API endpoint returns 200: `curl localhost:8080/api/new-endpoint`

#### Manual Verification:
- [ ] New feature appears correctly in the UI
- [ ] Performance is acceptable with 1000+ items
- [ ] Error messages are user-friendly
```

## Common Patterns

### For New Features:
- Research existing patterns first
- Start with data model
- Build backend logic
- Add API endpoints
- Implement UI last

### For Refactoring:
- Document current behavior
- Plan incremental changes
- Maintain backwards compatibility
- Include migration strategy

## Sub-task Spawning Best Practices

When spawning research sub-tasks:

1. **Spawn multiple tasks in parallel** for efficiency
2. **Each task should be focused** on a specific area
3. **Provide detailed instructions** including:
   - Exactly what to search for
   - Which directories to focus on
   - What information to extract
   - Expected output format
4. **Be specific about directories** — include the full path context in your prompts
5. **Request specific file:line references** in responses
6. **Wait for all tasks to complete** before synthesizing
7. **Verify sub-task results** — if findings seem incorrect, spawn follow-up tasks
8. **Team Isolation** — never pass `team_name` to sub-agent Task calls (per ADR-001)
