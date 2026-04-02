---
description: Crystallize draft ideas or research findings into structured GitHub issues, implementation plans, or research topics. Reads idea files or research documents, researches codebase context, finds duplicates, and creates well-scoped tickets.
argument-hint: "<idea-path-or-research-doc-or-description>"
model: opus
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
  - WebSearch
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_sub_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_dependency
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - WebFetch
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

# Form Idea

You are tasked with taking rough ideas and crystallizing them into actionable artifacts - GitHub issues, implementation plans, or research topics. This command bridges the gap between a quick thought and structured project work.

## Initial Response

When this command is invoked:

1. **If an idea file path was provided** (e.g., `thoughts/shared/ideas/2026-02-21-feature.md`):
   - Read the file FULLY
   - Set `INPUT_TYPE = "idea"`
   - Proceed to Step 1

2. **If a research doc path was provided** (e.g., `thoughts/shared/research/2026-03-14-GH-0564-topic.md`):
   - Read the file FULLY
   - Set `INPUT_TYPE = "research"`
   - Extract the research question, summary, detailed findings, and code references
   - If the research doc has `github_issue` in frontmatter, set `LINKED_ISSUE` to that value (the research is already linked to an issue -- the form skill should be aware)
   - Proceed to Step 1

   **Detection logic**: A path is a research doc if it matches `thoughts/shared/research/*.md` or has `type: research` in its frontmatter.

3. **If a raw description was provided** (not a file path):
   - Treat it as an inline idea
   - Set `INPUT_TYPE = "idea"`
   - Proceed to Step 1

4. **If no parameters provided**:
   ```
   I'll help you crystallize an idea into something actionable.

   Provide one of:
   1. A path to a draft idea: `/ralph-hero:form thoughts/shared/ideas/2026-02-21-feature.md`
   2. A research document: `/ralph-hero:form thoughts/shared/research/2026-03-14-topic.md`
   3. A description of the idea: `/ralph-hero:form we should add operator comparison charts`
   4. Just run `/ralph-hero:form` and I'll show you recent drafts to pick from

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

**If `INPUT_TYPE` is "research"** (input was a research document):
- The research document already contains codebase analysis, code references, and architectural context
- **Skip** the codebase-locator and codebase-analyzer sub-tasks (the research doc is the investigation)
- **Still run** the following (these provide project-management context the research doc may lack):
  - `Agent(subagent_type="ralph-hero:thoughts-locator", prompt="Find related ideas, research, and plans about [topic from research doc]")` -- to find related work
  - `ralph_hero__list_issues(query=...)` -- to find duplicate or overlapping issues
- This avoids re-investigating what the research doc already covers while still grounding the idea in the project context

**If `INPUT_TYPE` is "idea"** (input was an idea file or inline description):
- Proceed with full research as currently defined:

1. **Codebase context** - Spawn parallel sub-tasks:
   - `Agent(subagent_type="ralph-hero:codebase-locator", prompt="Find where [idea topic] would live in the codebase")`
   - `Agent(subagent_type="ralph-hero:codebase-analyzer", prompt="What already exists related to [idea topic]? What patterns to build on?")`

2. **Existing work** - `Agent(subagent_type="ralph-hero:thoughts-locator", prompt="Find related ideas, research, and plans")` to find:
   - Related ideas in `thoughts/shared/ideas/`
   - Related research in `thoughts/shared/research/`
   - Related plans in `thoughts/shared/plans/`

   Then analyze the most relevant findings:
   - `Agent(subagent_type="ralph-hero:thoughts-analyzer", prompt="Extract key decisions and prior art from documents about [idea topic]")`

3. **Existing issues** - Use `ralph_hero__list_issues(query=...)` to find:
   - Duplicate or overlapping issues
   - Related work already planned or in progress
   - Parent epics this might fit under

4. **Wait for ALL research to complete** before proceeding

**Important**: Do NOT pass `team_name` to any `Agent()` calls for sub-agents.

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
2. **Implementation plan** - Create a plan document (via /ralph-hero:plan)
3. **Research topic** - Create a research document to explore the idea deeper (via /ralph-hero:research)
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
   ```

   If `INPUT_TYPE` is "research", also include a Research section in the issue body:
   ```
   ## Research
   See [research doc](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/research/[filename].md)
   ```

   Then present for approval:
   ```
   **Labels**: [suggested labels]
   **Estimate**: [XS/S/M/L/XL]
   **Priority**: [suggested priority]

   Shall I create this issue, or would you like to adjust anything?
   ```

2. **Get approval**, then create via GitHub MCP tools:
   ```
   ralph_hero__create_issue
   - title: [title]
   - body: [description]
   ```

   Then set the estimate:
   ```
   ralph_hero__save_issue
   - number: [created issue number]
   - estimate: "XS"  (or S/M/L/XL as appropriate)
   - workflowState: "Backlog"
   ```

3. **Update the source file** with issue link:

   **If `INPUT_TYPE` is "idea"**: Update the idea file:
   ```yaml
   type: idea
   github_issue: NNN
   status: formed
   ```

   **If `INPUT_TYPE` is "research"**: Update the research doc's frontmatter:
   ```yaml
   github_issue: NNN
   github_url: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
   ```
   Then post an artifact comment linking the research doc to the new issue (same pattern as the research skill's Step 8):
   ```
   ralph_hero__create_comment
   - number: NNN
   - body: |
       ## Research Document

       https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/research/[filename].md

       Key findings: [1-3 line summary from the research doc's Summary section]
   ```

4. **Report**:

   **If `INPUT_TYPE` is "idea"**:
   ```
   Created: #NNN - [title]
   URL: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN

   The idea at [path] has been updated with the issue reference.

   Next steps:
   - `/ralph-hero:research NNN` - Start research phase
   - `/ralph-hero:plan #NNN` - Jump to planning
   - `/ralph-hero:iterate #NNN` - Refine if needed
   ```

   **If `INPUT_TYPE` is "research"**:
   ```
   Created: #NNN - [title]
   URL: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN

   The research doc at [path] has been linked to the new issue.

   Next steps:
   - `/ralph-hero:plan #NNN` - Create an implementation plan (research is already done)
   - `/ralph-hero:iterate #NNN` - Refine if needed
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
   ralph_hero__save_issue(number=..., estimate="L", workflowState="Backlog")
   ```

   b. Create each child issue:
   ```
   ralph_hero__create_issue(title=..., body=...)
   ralph_hero__add_sub_issue(parentNumber=..., childNumber=...)
   ralph_hero__save_issue(number=..., estimate="XS", workflowState="Backlog")
   ```

   c. Add ordering dependencies between children if sequential:
   ```
   ralph_hero__add_dependency(blockedNumber=..., blockingNumber=...)
   ```

4. **Update the source file** with parent issue link:

   **If `INPUT_TYPE` is "idea"**:
   ```yaml
   type: idea
   github_issue: NNN
   status: formed
   ```

   **If `INPUT_TYPE` is "research"**: Update the research doc's frontmatter:
   ```yaml
   github_issue: NNN
   github_url: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
   ```

### Step 5c: Hand Off to Another Skill

If the user chose "Implementation plan" or "Research topic":

1. **Update the source file** with status:

   **If `INPUT_TYPE` is "idea"**:
   ```yaml
   status: forming
   ```

   **If `INPUT_TYPE` is "research"**: No status update needed (research docs don't have a `status` field).

2. **Suggest the appropriate skill**:
   - For plan: Suggest the user run `/ralph-hero:plan` with the context gathered
   - For research: Suggest the user run `/ralph-hero:research` with the research question

   ```
   I've gathered the following context for your [plan/research]:

   **Topic**: [refined topic]
   **Key files**: [relevant files found]
   **Related work**: [issues/docs found]

   Run: `/ralph-hero:plan [context]` or `/ralph-hero:research [topic]`

   Or I can hand off this context directly - shall I invoke it now?
   ```

### Step 5d: Refine the Draft

If the user chose "Keep as refined idea":

1. **Update the source file** with enriched content:
   - Add the codebase context discovered
   - Add related issues and documents
   - Refine the rough shape based on research
   - Update tags with more specific terms

   **If `INPUT_TYPE` is "idea"**:
   - Set `type: idea` if not already present
   - Set `status: refined`

   **If `INPUT_TYPE` is "research"**:
   - Do NOT overwrite `type: research` — preserve the existing type
   - Add any new context as additional sections in the research doc

2. **Report**:
   ```
   Updated the idea at [path] with:
   - Codebase context and relevant file references
   - Related issues and existing work
   - Refined scope and shape
   - Updated tags for discoverability

   Come back anytime with `/ralph-hero:form [path]` to take the next step.
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
