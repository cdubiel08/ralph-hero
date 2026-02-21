# Task List Guide

Reusable guidance for task list usage in ralph-hero's GitHub workflow. Referenced by both the team lead skill and agent definitions.

## Task Description Protocol

Task descriptions are the primary channel for passing context to teammates. When the lead creates tasks, descriptions should include relevant context that helps the worker start quickly.

**GitHub context** (when available):
- Issue URL: `https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN`
- Workflow state at time of task creation
- Estimate (XS/S)

**Artifact paths** (when the prior phase produced them):
- Research doc: `thoughts/shared/research/YYYY-MM-DD-GH-NNNN-description.md`
- Plan doc: `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-description.md`
- Worktree: `worktrees/GH-NNN/`

**Group context** (when IS_GROUP is true):
- Group primary: GH-NNN
- Group members: GH-AAA, GH-BBB, GH-CCC
- Phase ordering from dependencies

**Structured format example**:
```
Research GH-42: Add caching support.
Issue: https://github.com/owner/repo/issues/42
State: Research Needed | Estimate: S
```

## Task Metadata Conventions

Standard metadata keys that teammates and hooks can rely on:

```json
{
  "issue_number": "42",
  "issue_url": "https://github.com/owner/repo/issues/42",
  "command": "research",
  "phase": "research",
  "estimate": "S",
  "group_primary": "42",
  "group_members": "42,43,44",
  "artifact_path": "thoughts/shared/research/...",
  "worktree": "worktrees/GH-42/"
}
```

- `group_primary` and `group_members`: only for group issues
- `artifact_path`: only when a prior phase produced an artifact
- `worktree`: only when a worktree exists or should be created

## TaskUpdate as Results Channel

Workers report completion via `TaskUpdate(description=...)` using the Result Format Contracts from `conventions.md`. The lead reads results via `TaskGet`. This is the primary communication channel -- prefer it over SendMessage for structured results.

## Checking for Existing Tasks

Before creating tasks, check TaskList to avoid duplicates. When resuming after a crash or restart, existing tasks may cover the current phase. Only create tasks for work not already tracked.

## Task ID Conventions

| Entity | Prefix | Example | Scope |
|--------|--------|---------|-------|
| Task list item | `T-` | T-7 | Session-local, ephemeral |
| GitHub issue | `GH-` | GH-49 | Repository-scoped, permanent |

Task subjects use `GH-NNN` when referencing GitHub issues (e.g., `"Research GH-42"`). Task list IDs (`T-N`) are used in lead messages and instructions.

## Blocking Patterns

Use `addBlockedBy` when tasks have genuine dependencies:
- "Merge PR for GH-42" should be blocked by "Create PR for GH-42"
- Review tasks should be blocked by their corresponding plan tasks

Avoid blocking for sequential-preference -- the bough model (create tasks only for the current phase) handles phase ordering naturally.

## Task List Propagation Patience

When spawned, your task may not appear in TaskList immediately. If you call TaskList and don't see a task matching your role, wait a few seconds and try again rather than assuming there's no work. The lead creates tasks and assigns them, but there can be a brief delay before they're visible to teammates.
