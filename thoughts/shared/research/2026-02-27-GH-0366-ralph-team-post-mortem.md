---
date: 2026-02-27
github_issue: 366
github_url: https://github.com/cdubiel08/ralph-hero/issues/366
status: complete
type: research
---

# GH-366: Add Post-Mortem Reflection Step to ralph-team Shutdown

## Problem Statement

When `ralph-team` completes, the shutdown is a single prose instruction: "When all tasks are complete, shut down each teammate and delete the team." (`ralph-team/SKILL.md:63`). No durable artifact captures what happened: which issues were processed, what PRs were created, what errors occurred, which workers were involved. This makes it impossible to debug failed sessions or improve skill behavior across sessions.

## Current State Analysis

### Shutdown Sequence

The team lead's shutdown flow has three stages:

1. **Worker shutdown**: Lead sends message to each worker. Workers attempt to stop, triggering `worker-stop-gate.sh`, which forces one final TaskList check before allowing exit.
2. **Team stop gate**: Lead itself attempts to stop, triggering `team-stop-gate.sh`, which scans GitHub for processable issues. If none exist, lead is allowed to stop.
3. **TeamDelete**: Lead calls `TeamDelete()` — the terminal action. After this, the task list and team config are deleted.

**Critical constraint**: Post-mortem data collection must happen BEFORE `TeamDelete()` since that call destroys the task list.

### Data Available at Shutdown Time

#### TaskList + TaskGet (richest source)

The lead has access to `TaskList` and `TaskGet` throughout execution. At shutdown, all tasks are completed, so their metadata is fully populated. Per `shared/conventions.md:26-27`, standard task metadata includes:

| Field | Content |
|-------|---------|
| `issue_number` | GitHub issue number processed |
| `issue_url` | GitHub issue URL |
| `command` | Which ralph command ran (triage, research, plan, impl, etc.) |
| `phase` | Phase number within group |
| `estimate` | Issue size (XS/S) |
| `artifact_path` | Path to output document (plan, research, PR) |
| `worktree` | Worktree path for implementation tasks |
| `result` | Worker outcome (APPROVED/NEEDS_ITERATION for reviews) |

Workers write results back via `TaskUpdate`. For review tasks, the verdict is stored in both task `description` and `metadata`. For integrator tasks, the PR URL is written to the task (`ralph-integrator.md:27`).

#### team-task-completed.sh (fires on each completion)

Hook captures `.task_subject` and `.teammate_name` at each task completion (`team-task-completed.sh:17-18`). These are logged to stderr but not aggregated.

#### What's NOT available

- **No timestamps**: No hook captures start/end times. Duration cannot be computed from task metadata alone. Could be approximated from git log of commits created during the session.
- **No error log**: Failed tasks or retries are not captured in task metadata. Escalations would show as "Human Needed" workflow state on GitHub, detectable via a quick GitHub query.

### Existing Report Patterns

#### thoughts/shared/reports/ format

Two existing report types provide templates:

1. **Weekly ship report** (`2026-02-21-weekly-ship-report.md`): High-level metrics at top (releases, commits, PRs), then narrative sections per feature with issue references.

2. **Idea-hunt diagnostic** (`2026-02-25-idea-hunt-team-diagnostic.md`): Tool call timelines organized by phase, structured as markdown tables. Per-agent breakdown with counts.

#### ralph-report skill

`ralph-report/SKILL.md` generates project-level pipeline status and posts via `create_status_update`. Key reusable patterns:
- `ralph_hero__create_status_update(status, body)` — posts markdown to GitHub Projects V2
- Status enum: `ON_TRACK | AT_RISK | OFF_TRACK`
- Only current user of `create_status_update` in the codebase

### Key Discoveries

#### `plugin/ralph-hero/skills/ralph-team/SKILL.md:63`
Shutdown is a single line. The implementation point for the post-mortem step is immediately before this line.

#### `plugin/ralph-hero/hooks/scripts/team-task-completed.sh:17-18`
`.task_subject` and `.teammate_name` are available in each TaskCompleted hook event — could be accumulated by the lead as events fire, but not persisted across the session currently.

#### `plugin/ralph-hero/agents/ralph-integrator.md:27`
Integrator writes PR URL to task metadata — this is the source for "PRs created" in the post-mortem.

#### `plugin/ralph-hero/skills/ralph-report/SKILL.md:123`
`create_status_update` takes `status` + `body` markdown. Reusable for the optional GitHub post.

## Potential Approaches

### Option A: Lead Reads TaskList at Shutdown, Writes Report (Recommended)

At shutdown time, the lead:
1. Calls `TaskList` to get all tasks
2. Calls `TaskGet` on each to collect full metadata
3. Groups tasks by issue_number (one issue = one row)
4. Collects: issue title, estimate, phases processed, PR URL (if any), outcome
5. Writes post-mortem to `thoughts/shared/reports/YYYY-MM-DD-ralph-team-{team-name}.md`
6. Optionally calls `create_status_update` with a summary
7. Then calls `TeamDelete()`

**Pros**:
- All data available in task metadata — no new infrastructure needed
- Lead already has `TaskList`/`TaskGet`/`Write` in its allowed-tools (`SKILL.md:14-16`)
- Follows idea-hunt pattern ("Read generated data → summarize → shutdown")
- Only requires adding ~30-40 lines to `ralph-team/SKILL.md` before shutdown step

**Cons**:
- No timestamps available — can't compute session duration from task data
- Must run before `TeamDelete()` — order matters

**Files to change**: Only `plugin/ralph-hero/skills/ralph-team/SKILL.md`

### Option B: Accumulate Data in team-task-completed.sh

Modify `team-task-completed.sh` to append task data to a temp file, then read it at shutdown.

**Pros**:
- Captures ordering/timing at task completion time

**Cons**:
- Requires modifying hook script (bash) + temp file management
- Still no wall-clock timestamps
- More complex — two files to change + coordination between hook and skill
- Temp file could persist across sessions if not cleaned up

### Option C: Post-Mortem as New Skill (/ralph-postmortem)

Create a standalone `/ralph-postmortem` skill that the lead invokes at shutdown time.

**Pros**:
- Reusable across different team types (ralph-team, idea-hunt, etc.)

**Cons**:
- Overkill for the scope — the data collection is straightforward
- Requires lead to know when/how to invoke it
- Adds a new skill to maintain

## Recommendation

**Option A** — Add post-mortem step to `ralph-team/SKILL.md` before the shutdown line. The lead already has all required tools and data access. The idea-hunt skill demonstrates this exact pattern (read artifacts → summarize → shutdown). The change is contained to one file.

**Post-mortem document template**:

```markdown
# Ralph Team Session Report: {team-name}
**Date**: YYYY-MM-DD
**Team**: {team-name}

## Issues Processed

| Issue | Title | Estimate | Outcome | PR |
|-------|-------|----------|---------|-----|
| #NNN | [title] | XS | ✅ Done | #PR |
| #NNN | [title] | S | ⚠️ Needs Review | — |

## Worker Summary

| Worker | Tasks Completed |
|--------|----------------|
| analyst | Triage #NNN, Research #NNN, Plan #NNN |
| builder | Implement #NNN |
| integrator | PR #NNN |

## Notes
- Escalations: [any Human Needed issues]
- Errors: [any tasks that failed or were retried]
```

**Optional GitHub post**: Call `create_status_update` with a condensed version (issue count, PR count, success/failure status). Status logic: all Done → `ON_TRACK`, any escalations → `AT_RISK`, any failed tasks → `OFF_TRACK`.

## Risks

- **TaskList may be large** for long sessions (many tasks). `TaskList` + `TaskGet` per task is O(N) API calls. For typical sessions (5-15 tasks), this is fast. For large sessions, the lead should limit to 50 tasks.
- **TeamDelete must come after**: If the lead calls `TeamDelete()` first, task data is gone. The plan's implementation must enforce this ordering explicitly.
- **create_status_update is optional**: Not all users will want a GitHub status post. The skill should make it conditional (e.g., only post if session had >0 issues processed).

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/ralph-team/SKILL.md` - Add post-mortem collection step before TeamDelete call

### Will Read (Dependencies)
- `plugin/ralph-hero/skills/ralph-report/SKILL.md` - create_status_update usage pattern
- `plugin/ralph-hero/skills/idea-hunt/SKILL.md` - Wrap Up pattern (read artifacts → summarize → shutdown)
- `plugin/ralph-hero/hooks/scripts/team-task-completed.sh` - Task completion data fields
- `thoughts/shared/reports/2026-02-21-weekly-ship-report.md` - Report format reference
- `thoughts/shared/reports/2026-02-25-idea-hunt-team-diagnostic.md` - Diagnostic format reference
