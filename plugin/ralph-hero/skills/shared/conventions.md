# Shared Conventions

Common protocols referenced by all Ralph skills. Skills should link here rather than duplicating this content.

## Escalation Protocol

When encountering complexity, uncertainty, or states that don't align with protocol, **escalate via GitHub issue comment** by @mentioning the appropriate person.

**Escalation priority** (use first available):
1. **Assigned individual** - If the issue has an assignee
2. **Project owner** - If the issue belongs to a project with a lead
3. **Team lead** - Default escalation target

**When to escalate:**

| Situation | Action |
|-----------|--------|
| Issue scope larger than estimated | @mention: "This is [M/L/XL] complexity, not [XS/S]. Needs re-estimation or splitting." |
| Missing context/requirements | @mention: "Cannot proceed effectively. Need clarification on: [specific questions]." |
| Architectural decision needed | @mention: "Multiple valid approaches found: [A vs B]. Need architectural guidance." |
| External dependency discovered | @mention: "This requires [external API/service/team]. Need confirmation before proceeding." |
| Conflicting existing patterns | @mention: "Found conflicting patterns: [pattern A] vs [pattern B]. Which to follow?" |
| Plan doesn't match codebase | @mention: "Plan assumes [X] but found [Y]. Need updated plan." |
| Tests fail unexpectedly | @mention: "Tests fail: [error]. Not a simple fix - need guidance." |
| Breaking changes discovered | @mention: "Implementation would break [component]. Scope larger than planned." |
| Security concern identified | @mention: "Potential security issue: [description]. Need review before proceeding." |

**How to escalate:**

1. **Move issue to "Human Needed"**:
   ```
   ralph_hero__update_workflow_state
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - state: "__ESCALATE__"
   - command: "[current-command]"
   ```
   For group plans, move ALL group issues to "Human Needed".

2. **Add comment with @mention**:
   ```
   ralph_hero__create_comment
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - body: "@$RALPH_GH_OWNER Escalation: [issue description]"
   ```

3. **STOP and report**:
   ```
   Escalated to @[person]: [brief reason]

   Issue: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
   Status: Human Needed

   Waiting for guidance before proceeding.
   ```

## Link Formatting

When referencing code in documents, PRs, or GitHub comments, use GitHub links with environment variables:

| Reference type | Format |
|---------------|--------|
| File only | `[path/file.py](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py)` |
| With line | `[path/file.py:42](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42)` |
| Line range | `[path/file.py:42-50](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42-L50)` |

## Common Error Handling

**Tool call failures**: If `update_workflow_state` returns an error, read the error message -- it contains valid states/intents and a specific Recovery action. Retry with the corrected parameters.

**State gate blocks**: Hooks enforce valid state transitions at the tool level. If a hook blocks your action, the state machine requires a different transition. Check the current workflow state and re-evaluate.

**Postcondition failures**: Stop hooks verify expected outputs (research doc, plan doc, commits). If a postcondition fails, check the specific requirement and satisfy it before retrying.

## Pipeline Handoff Protocol

Workers hand off to the next pipeline stage via peer-to-peer SendMessage, bypassing the lead for routine progression. The lead only handles exceptions and intake.

### Pipeline Order

| Current Role (agentType) | Next Stage | agentType to find |
|---|---|---|
| `ralph-analyst` | Builder | `ralph-builder` |
| `ralph-builder` (plan done) | Validator | `ralph-validator` (if `RALPH_REVIEW_MODE=interactive`) |
| `ralph-builder` (impl done) | Lead (PR creation) | `team-lead` |
| `ralph-validator` (approved) | Builder | `ralph-builder` |
| `ralph-validator` (rejected) | Builder (re-plan) | `ralph-builder` |

### Handoff Procedure (after completing a task)

1. Check `TaskList` for more tasks matching your role
2. If found: self-claim and continue (no handoff needed)
3. If none available: hand off to the next-stage peer:
   - Read team config at `~/.claude/teams/[TEAM_NAME]/config.json`
   - Find the member whose `agentType` matches your "Next Stage" from the table above
   - SendMessage using the member's `name` field:
     ```
     SendMessage(
       type="message",
       recipient="[name from config]",
       content="Pipeline handoff: check TaskList for newly unblocked work",
       summary="Handoff: task unblocked"
     )
     ```
4. If the next-stage teammate is NOT found in the config (role not spawned):
   ```
   SendMessage(
     type="message",
     recipient="team-lead",
     content="No [next-role] teammate exists. Unblocked tasks may need a new worker.",
     summary="No peer for handoff"
   )
   ```

### Rules

- **Never use TaskUpdate with `owner` parameter** to assign tasks to other teammates. Workers self-claim only.
- **SendMessage is fire-and-forget** -- no acknowledgment mechanism. The handoff wakes the peer; they self-claim from TaskList.
- **Lead gets visibility** via idle notification DM summaries -- no need to CC the lead on handoffs.
- **Multiple handoffs are fine** -- if 3 researchers complete and all message the planner, the planner wakes 3 times and claims one task each time.

## Spawn Template Protocol

### Template Location

Spawn templates live at: `${CLAUDE_PLUGIN_ROOT}/templates/spawn/{role}.md`

To resolve the path at runtime, use Bash to expand the variable first:
```
TEMPLATE_DIR=$(echo $CLAUDE_PLUGIN_ROOT)/templates/spawn
```
Then read templates via `Read(file_path="[resolved-path]/researcher.md")`.

Available templates: `triager`, `splitter`, `researcher`, `planner`, `reviewer`, `implementer`, `integrator`

### Placeholder Substitution

| Placeholder | Source | Required |
|-------------|--------|----------|
| `{ISSUE_NUMBER}` | Issue number from GitHub | Always |
| `{TITLE}` | Issue title from `get_issue` | Always |
| `{ESTIMATE}` | Issue estimate from `get_issue` | Triager, Splitter |
| `{GROUP_CONTEXT}` | See below | Planner, Reviewer (groups only) |
| `{WORKTREE_CONTEXT}` | See below | Implementer only |

### Group Context Resolution

If `IS_GROUP=true` for the issue:
```
{GROUP_CONTEXT} = "Group: #{PRIMARY} (#{A}, #{B}, #{C}). Plan covers all group issues."
```

If `IS_GROUP=false`:
```
{GROUP_CONTEXT} = ""
```

### Worktree Context Resolution

If worktree already exists:
```
{WORKTREE_CONTEXT} = "Worktree: worktrees/GH-{ISSUE_NUMBER}/ (exists, reuse it)"
```

If no worktree:
```
{WORKTREE_CONTEXT} = ""
```

### Empty Placeholder Line Removal

If a placeholder resolves to an empty string, remove the ENTIRE LINE containing that placeholder. Do not leave blank lines where optional context was omitted.

Example -- planner template before substitution:
```
Plan #42: Add caching.
{GROUP_CONTEXT}

Invoke: Skill(skill="ralph-hero:ralph-plan", args="42")
```

After substitution when IS_GROUP=false (GROUP_CONTEXT is empty):
```
Plan #42: Add caching.

Invoke: Skill(skill="ralph-hero:ralph-plan", args="42")
```
The `{GROUP_CONTEXT}` line is removed entirely.

### Resolution Procedure (for orchestrator)

1. Determine the role from the task subject (Research -> `researcher.md`, Plan -> `planner.md`, etc.)
2. Resolve template path: `Bash("echo $CLAUDE_PLUGIN_ROOT")` then append `/templates/spawn/{role}.md`
3. Read the template file via `Read` tool
4. Replace all `{PLACEHOLDER}` strings with actual values from `get_issue` response
5. If a placeholder resolves to an empty string, remove the ENTIRE LINE containing it
6. Use the result as the `prompt` parameter in `Task()`

### Template Naming Convention

Templates are named by role: `{role}.md` matching the agent type:

| Agent type | Template |
|------------|----------|
| `ralph-analyst` agent (triage mode) | `triager.md` |
| `ralph-analyst` agent (split mode) | `splitter.md` |
| `ralph-analyst` agent (research mode) | `researcher.md` |
| `ralph-builder` agent (plan mode) | `planner.md` |
| `ralph-builder` agent (implement mode) | `implementer.md` |
| `ralph-validator` agent | `reviewer.md` |
| `ralph-integrator` agent | `integrator.md` |

### Template Authoring Rules

- Templates MUST be under 15 lines
- DO NOT include: conversation history, document contents, code snippets, assignment instructions
- Teammates message the lead using `recipient="team-lead"` exactly
- Result reporting follows the agent's `.md` definition, not the spawn template

## Skill Invocation Convention

### Default: Fork via Task()

Skills should be invoked via forked subprocesses to isolate context:

```
Task(subagent_type="general-purpose",
     prompt="Skill(skill='ralph-hero:ralph-research', args='42')",
     description="Research #42")
```

This ensures:
- Skill runs in a fresh context window (no context pollution)
- Skill failures don't corrupt the caller's state
- Token usage is isolated per skill invocation
- Results are returned as a summary, not full conversation

### Exception: Team Agents

When agents are spawned as team members, the agent IS the subprocess. The agent invokes the skill inline:

```
Skill(skill="ralph-hero:ralph-research", args="42")
```

This is acceptable because the agent already has its own isolated context window via the team system.

### Exception: Direct User Invocation

Users invoking skills directly (e.g., `/ralph-research 42`) run inline in their session. This is the expected behavior for interactive use.

## Artifact Comment Protocol

### Overview

GitHub issue comments are the **primary source of truth** for all artifacts produced by the pipeline.
Each phase posts a comment with a standardized section header. The next phase searches for that header.

### Comment Section Headers

| Phase | Header | Content |
|-------|--------|---------|
| Research | `## Research Document` | GitHub URL to research `.md` file |
| Plan | `## Implementation Plan` | GitHub URL to plan `.md` file |
| Review | `## Plan Review` | VERDICT line (APPROVED or NEEDS_ITERATION) + optional critique URL |
| Implementation | `## Implementation Complete` | PR URL, branch name, files changed |

### Comment Format

Each artifact comment MUST follow this exact format:

```
## [Section Header]

[GitHub URL to artifact file]

[Optional summary - 1-3 lines]
```

**Example - Research:**
```
## Research Document

https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/research/2026-02-17-GH-0042-auth-flow.md

Key findings: Auth flow uses Firebase JWT tokens. Current middleware validates but doesn't refresh.
Recommended approach: Add token refresh middleware.
```

**Example - Plan:**
```
## Implementation Plan

https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/plans/2026-02-17-GH-0042-auth-refresh.md

Phases: 3 (middleware -> token refresh -> integration tests)
```

**Example - Review:**
```
## Plan Review

VERDICT: APPROVED
Full critique: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/reviews/2026-02-17-GH-0042-critique.md
```

### Discovery Protocol

To find a prior-phase artifact:

1. Fetch issue with comments: `ralph_hero__get_issue(owner, repo, number)`
2. Search comments for the section header (e.g., `## Research Document`)
3. If multiple comments match the same section header, use the **most recent** (last) match
4. Extract the URL from the first line after the header
5. Convert GitHub URL to local path: strip `https://github.com/OWNER/REPO/blob/main/` prefix
6. Read the local file

**URL to local path conversion:**
```
https://github.com/OWNER/REPO/blob/main/thoughts/shared/research/FILE.md
-> thoughts/shared/research/FILE.md
```

### Deterministic File Naming

Artifacts follow this naming convention:

| Type | Pattern | Example |
|------|---------|---------|
| Research | `thoughts/shared/research/YYYY-MM-DD-GH-NNNN-description.md` | `2026-02-17-GH-0042-auth-flow.md` |
| Plan | `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-description.md` | `2026-02-17-GH-0042-auth-refresh.md` |
| Group Plan | `thoughts/shared/plans/YYYY-MM-DD-group-GH-NNNN-description.md` | `2026-02-17-group-GH-0042-auth-suite.md` |
| Review | `thoughts/shared/reviews/YYYY-MM-DD-GH-NNNN-critique.md` | `2026-02-17-GH-0042-critique.md` |

The issue number (`GH-NNNN`) in the filename makes artifacts discoverable even without comments.

**Note on zero-padding**: Filenames use zero-padded 4-digit issue numbers (e.g., `GH-0042`). When constructing glob patterns from a plain issue number, try BOTH padded and unpadded forms: `*GH-${number}*` and `*GH-$(printf '%04d' $number)*`.

### Fallback Discovery

If a comment search fails (comment was never posted, was deleted, or scrolled past the comment limit):

1. **Glob fallback**: Search `thoughts/shared/{type}/*GH-{number}*` for the artifact. Try both unpadded (`*GH-42*`) and zero-padded (`*GH-0042*`) patterns.
2. **Group glob fallback**: If the standard glob fails for a group member, try `*group*GH-{primary}*` where `{primary}` is the primary issue number from the issue's group context (parent or first blocker).
3. **If found, self-heal**: Post the missing comment to the issue using the correct section header (see Self-Healing below).
4. **If not found**: Block and report the missing artifact.

### Self-Healing

When an artifact is found via glob fallback but the expected comment is missing, post it:

```
ralph_hero__create_comment
- owner: $RALPH_GH_OWNER
- repo: $RALPH_GH_REPO
- number: [issue-number]
- body: |
    ## [Section Header]

    https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/[local-path]

    (Self-healed: artifact was found on disk but not linked via comment)
```

This ensures subsequent phases find the artifact via the primary channel.

### Known Limitations

- **10-comment limit**: `get_issue` returns only the last 10 comments. For issues with many status updates, early comments (e.g., the research document comment) may scroll off. This is why the glob fallback is essential — it provides a reliable secondary discovery path when comments are no longer visible.
- **Group glob for non-primary issues**: Group plans use the primary issue number in filenames (e.g., `group-GH-0042-*.md`). Non-primary group members (e.g., #43, #44) won't match `*GH-43*`. The comment-based path handles groups correctly since the plan skill posts to ALL group issues. The glob fallback should try `*group*GH-{primary}*` after `*GH-{number}*` fails.
