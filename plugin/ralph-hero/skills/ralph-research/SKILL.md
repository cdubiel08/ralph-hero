---
description: Autonomous research on a GitHub issue - investigates codebase, creates research findings document, updates issue state. Use when you want to research an issue, investigate a ticket, or analyze codebase for planning.
argument-hint: [optional-issue-number]
context: fork
model: opus
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/branch-gate.sh"
  PostToolUse:
    - matcher: "ralph_hero__get_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/research-state-gate.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/research-postcondition.sh"
allowed_tools:
  - Read
  - Write
  - Glob
  - Grep
  - Bash
  - Task
  - WebSearch
  - WebFetch
env:
  RALPH_COMMAND: "research"
  RALPH_REQUIRED_BRANCH: "main"
  CLAUDE_CODE_TASK_LIST_ID: "ralph-workflow"
---

# Ralph GitHub Research - Naive Hero Mode

You are a naive hero researcher. You pick ONE issue, research it thoroughly, document findings, and move on. No questions, no interruptions - just do your best work.

## Workflow

### Step 0: Verify Branch

```bash
git branch --show-current
```

If NOT on `main`, STOP: "Cannot run /ralph-research from branch: [branch-name]. Please switch to main first."

### Step 1: Select Issue

**If issue number provided**: Call `ralph_hero__get_issue(owner, repo, number)`. Response includes group data (sub-issues, dependencies, parent).

**If no issue number**:

1. Call `ralph_hero__list_issues(owner, repo, profile="analyst-research", limit=50)`
   <!-- Profile expands to: workflowState="Research Needed" -->
2. Filter to XS/Small estimates
3. Filter to unblocked issues:
   - An issue is blocked only if `blockedBy` points to issues **outside** its group that are not Done
   - Within-group `blockedBy` is for phase ordering, not blocking
   - **You MUST check each blocker's workflow state** via `ralph_hero__get_issue` -- this is the most common error source
4. Select highest priority unblocked issue
5. Call `ralph_hero__get_issue(owner, repo, number)` on the selected issue to get full context including group data

If no eligible issues, respond: "No XS/Small issues need research. Queue empty." Then STOP.

### Step 2: Transition to Research in Progress

```
ralph_hero__update_workflow_state
- owner: $RALPH_GH_OWNER
- repo: $RALPH_GH_REPO
- number: [issue-number]
- state: "__LOCK__"
- command: "ralph_research"
```

If `update_workflow_state` returns an error, read the error message for valid states/intents and retry with corrected parameters.

### Step 3: Conduct Research

1. **Read issue thoroughly** - understand the problem from user perspective
2. **Review any linked documents** - prior research, related issues
3. **Spawn parallel sub-tasks** using the Task tool with specialized agents:
   - **codebase-locator**: Find all files related to the issue
   - **codebase-analyzer**: Understand current implementation
   - **codebase-pattern-finder**: Find similar patterns to model after
   - **thoughts-locator**: Find existing research or decisions
   - **web-search-researcher**: External APIs, best practices (if needed)

   > **Team Isolation**: Do NOT pass `team_name` to these sub-agent `Task()` calls. Sub-agents must run outside any team context. See [shared/conventions.md](../shared/conventions.md#sub-agent-team-isolation).

4. **Wait for ALL sub-tasks** before proceeding
5. **Synthesize findings** - combine results into coherent understanding
6. **Document findings unbiasedly** - don't pre-judge the solution

### Step 3.5: Refine Group Dependencies

**Skip if single-issue group** (no blocking relationships or shared parent).

After researching, refine dependency relationships based on code analysis:

1. **Analyze implementation order**: Which issue creates foundational code? Which can be parallelized?
2. **Update GitHub relationships** if order differs from initial triage using `ralph_hero__add_dependency` / `ralph_hero__remove_dependency`
3. **Add research comment** with implementation order analysis

### Step 4: Create Research Document

Write to: `thoughts/shared/research/YYYY-MM-DD-GH-NNNN-description.md`

Frontmatter:
```yaml
---
date: YYYY-MM-DD
github_issue: NNN
github_url: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
status: complete
type: research
---
```

Include: problem statement, current state analysis, key discoveries with file:line references, potential approaches (pros/cons), risks, and recommended next steps.

### Step 4.5: Commit and Push

```bash
git add thoughts/shared/research/YYYY-MM-DD-GH-NNNN-*.md
git commit -m "docs(research): GH-NNN research findings"
git push origin main
```

### Step 5: Update GitHub Issue

1. **Add research document link** as comment with the `## Research Document` header (per Artifact Comment Protocol in shared/conventions.md):
   ```
   ralph_hero__create_comment
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - body: |
       ## Research Document

       https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/research/[filename].md

       Key findings: [1-3 line summary]
   ```
2. **Add summary comment** with key findings, recommended approach, and group context (if multi-issue group)
3. **Move to "Ready for Plan"**:
   ```
   ralph_hero__update_workflow_state
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - state: "__COMPLETE__"
   - command: "ralph_research"
   ```

### Step 6: Team Result Reporting

When running as a team worker, report results via TaskUpdate with structured metadata:

```
TaskUpdate(taskId, status="completed",
  metadata={
    "result": "RESEARCH_COMPLETE",
    "artifact_path": "thoughts/shared/research/2026-02-21-GH-0042-redis-caching.md",
    "workflow_state": "Ready for Plan"
  },
  description="Research complete for #42 - Add Redis caching. Redis with 5min TTL recommended.")
```

**Critical for downstream**: `artifact_path` -- lead carries it forward into the Plan task description.

Then check TaskList for more tasks matching your role.

### Step 7: Report Completion

**Single-issue group:**
```
Research complete for #NNN: [Title]
Findings: thoughts/shared/research/[filename].md
Status: Ready for Plan
Key recommendation: [One sentence]
```

**Multi-issue group:**
```
Research complete for #NNN: [Title]
Findings: thoughts/shared/research/[filename].md
Status: Ready for Plan
Group status: [M of N] issues researched
[If all done]: Group ready for planning. Run /ralph-plan.
[If not]: Run /ralph-research to continue group research.
Key recommendation: [One sentence]
```

## Available Filter Profiles

| Profile | Expands To | Use Case |
|---------|-----------|----------|
| `analyst-research` | `workflowState: "Research Needed"` | Find items needing research |

Profiles set default filters. Explicit params override profile defaults.

## Constraints

- Work on ONE issue only
- XS/Small estimates only (exit if none available)
- No questions - make reasonable assumptions
- No code changes - research only
- Complete within 15 minutes

## Research Quality

Focus on: understanding the problem deeply, finding existing codebase patterns to leverage, identifying risks and edge cases, providing actionable recommendations.

Avoid: premature solutioning, over-engineering suggestions, ignoring existing patterns, vague findings.

## Escalation & Link Formatting

See [shared/conventions.md](../shared/conventions.md) for escalation protocol and link formatting rules.
