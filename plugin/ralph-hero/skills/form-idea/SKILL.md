---
description: Crystallize draft ideas into structured GitHub issues, implementation plans, or research topics. Reads idea files, researches codebase context, finds duplicates, and creates well-scoped tickets.
argument-hint: "<idea-path-or-description>"
model: opus
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - WebSearch
  - WebFetch
---

# Form Idea

You are tasked with taking rough ideas and crystallizing them into actionable artifacts - GitHub issues, implementation plans, or research topics. This command bridges the gap between a quick thought and structured project work.

## Initial Response

When this command is invoked:

1. **If an idea file path was provided** (e.g., `thoughts/shared/ideas/2026-02-21-feature.md`):
   - Read the file FULLY
   - Proceed to Step 1

2. **If a raw description was provided** (not a file path):
   - Treat it as an inline idea
   - Proceed to Step 1

3. **If no parameters provided**:
   ```
   I'll help you crystallize an idea into something actionable.

   Provide one of:
   1. A path to a draft idea: `/ralph-hero:form-idea thoughts/shared/ideas/2026-02-21-feature.md`
   2. A description of the idea: `/ralph-hero:form-idea we should add operator comparison charts`
   3. Just run `/ralph-hero:form-idea` and I'll show you recent drafts to pick from

   Recent ideas:
   ```
   Then list files from `thoughts/shared/ideas/` sorted by date (most recent first, max 10).

   Wait for user input.

## Process Steps

### Step 1: Understand the Idea

1. **Read the idea** (from file or inline)
2. **Identify the core intent**:
   - What problem does this solve?
   - Who benefits?
   - What's the scope?

3. **Present your understanding**:
   ```
   Here's what I understand:

   **Core idea**: [one sentence]
   **Problem it solves**: [brief]
   **Scope**: [small/medium/large]

   Does this capture it correctly?
   ```

   Wait for confirmation before proceeding.

### Step 2: Research & Contextualize

Spawn parallel research to ground the idea in the codebase and project context:

1. **Codebase context** - Use **ralph-hero:codebase-locator** and **ralph-hero:codebase-analyzer** to find:
   - Where this idea would live in the codebase
   - What already exists that's related
   - Existing patterns to build on

2. **Existing work** - Use **ralph-hero:thoughts-locator** to find:
   - Related ideas in `thoughts/shared/ideas/`
   - Related research in `thoughts/shared/research/`
   - Related plans in `thoughts/shared/plans/`

3. **Existing issues** - Use `ralph_hero__list_issues(query=...)` to find:
   - Duplicate or overlapping issues
   - Related work already planned or in progress
   - Parent epics this might fit under

4. **Wait for ALL research to complete** before proceeding

**Important**: Do NOT pass `team_name` to any `Task()` calls for sub-agents.

### Step 3: Present the Larger Context

```
Here's how this idea fits into the bigger picture:

**Related existing work:**
- [Issue/plan/research that overlaps or connects]
- [Existing code that would be affected]

**Potential duplicates:**
- [Any issues that cover similar ground]

**Natural home:**
- [Where this fits in the project structure]
- [Which epic or initiative it aligns with]

**Complexity assessment:**
- Estimated size: [XS/S/M/L/XL]
- Key dependencies: [what this builds on]
- Risk areas: [what could be tricky]
```

### Step 4: Choose Output Format

```
How would you like to shape this idea?

1. **GitHub issue** - Create a well-scoped issue ready for the backlog
2. **Implementation plan** - Create a plan document (via /ralph-hero:create-plan)
3. **Research topic** - Create a research document to explore the idea deeper (via /ralph-hero:research-codebase)
4. **Ticket tree** - Break into multiple related issues (parent + children)
5. **Keep as refined idea** - Update the draft with context but don't create issues yet
```

Wait for user choice.

### Step 5a: Create GitHub Issue

If the user chose "GitHub issue":

1. **Draft the issue interactively**:
   ```
   Here's the proposed issue:

   **Title**: [concise, actionable title]
   **Description**:
   ## Summary
   [What and why]

   ## Acceptance Criteria
   - [ ] [Specific, testable criterion]
   - [ ] [Another criterion]

   ## Context
   - Related: [links to related issues/docs]
   - Idea source: [link to draft idea file]

   **Labels**: [suggested labels]
   **Estimate**: [XS/S/M/L/XL]
   **Priority**: [suggested priority]

   Shall I create this issue, or would you like to adjust anything?
   ```

2. **Get approval**, then create via GitHub MCP tools:
   ```
   ralph_hero__create_issue
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - title: [title]
   - body: [description]
   ```

   Then set the estimate:
   ```
   ralph_hero__save_issue
   - number: [created issue number]
   - estimate: "XS"  (or S/M/L/XL as appropriate)
   ```

3. **Update the idea file** with issue link:
   ```yaml
   github_issue: NNN
   status: formed
   ```

4. **Report**:
   ```
   Created: #NNN - [title]
   URL: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN

   The idea at [path] has been updated with the issue reference.

   Next steps:
   - `/ralph-hero:ralph-research NNN` - Start research phase
   - `/ralph-hero:create-plan #NNN` - Jump to planning
   - `/ralph-hero:iterate-plan #NNN` - Refine if needed
   ```

### Step 5b: Create Ticket Tree

If the user chose "Ticket tree":

1. **Break down the idea** into logical sub-issues
2. **Present the tree**:
   ```
   Proposed ticket tree:

   **Parent**: [Epic title] (M/L/XL)
   ├── #??: [Sub-task 1] (XS/S)
   ├── #??: [Sub-task 2] (XS/S)
   ├── #??: [Sub-task 3] (S/M)
   └── #??: [Sub-task 4] (XS/S)

   Each sub-issue is scoped to XS/S for autonomous implementation.
   Shall I create these issues?
   ```

3. **Get approval**, then create parent + children:

   a. Create the parent issue:
   ```
   ralph_hero__create_issue(title=..., body=...)
   ralph_hero__save_issue(number=..., estimate="L")
   ```

   b. Create each child issue:
   ```
   ralph_hero__create_issue(title=..., body=...)
   ralph_hero__add_sub_issue(parentNumber=..., childNumber=...)
   ralph_hero__save_issue(number=..., estimate="XS")
   ```

   c. Add ordering dependencies between children if sequential:
   ```
   ralph_hero__add_dependency(blockedNumber=..., blockingNumber=...)
   ```

4. **Update the idea file** with parent issue link:
   ```yaml
   github_issue: NNN
   status: formed
   ```

### Step 5c: Hand Off to Another Skill

If the user chose "Implementation plan" or "Research topic":

1. **Update the idea file** with status:
   ```yaml
   status: forming
   ```

2. **Suggest the appropriate skill**:
   - For plan: Suggest the user run `/ralph-hero:create-plan` with the context gathered
   - For research: Suggest the user run `/ralph-hero:research-codebase` with the research question

   ```
   I've gathered the following context for your [plan/research]:

   **Topic**: [refined topic]
   **Key files**: [relevant files found]
   **Related work**: [issues/docs found]

   Run: `/ralph-hero:create-plan [context]` or `/ralph-hero:research-codebase [topic]`

   Or I can hand off this context directly - shall I invoke it now?
   ```

### Step 5d: Refine the Draft

If the user chose "Keep as refined idea":

1. **Update the idea file** with enriched content:
   - Add the codebase context discovered
   - Add related issues and documents
   - Refine the rough shape based on research
   - Update tags with more specific terms
   - Set `status: refined`

2. **Report**:
   ```
   Updated the idea at [path] with:
   - Codebase context and relevant file references
   - Related issues and existing work
   - Refined scope and shape
   - Updated tags for discoverability

   Come back anytime with `/ralph-hero:form-idea [path]` to take the next step.
   ```

## Guidelines

1. **Be thorough in research** - This is where ideas get grounded in reality. Use the research phase to find connections the user might not have considered.

2. **Be interactive** - Don't disappear into research. Confirm understanding, present options, get feedback at each step.

3. **Connect the dots** - The main value of this skill is seeing how an idea fits into existing work. Surface duplicates, related issues, and relevant code.

4. **Right-size the output** - A small idea should become a small issue, not an epic. Match the output format to the idea's scope.

5. **Preserve the original idea** - Always update the draft file with the outcome (issue link, status change) so there's a trail from idea to implementation.

6. **No orphaned ideas** - Every formed idea should point to its next step (issue, plan, research, or explicit "parked" status).

7. **Use existing conventions** - Follow the same issue structure, plan format, and research document format used by the other skills.

8. **No GitHub integration for pre-ticket work** - Ideas are pre-ticket. Only create issues when the user explicitly chooses that output format.
