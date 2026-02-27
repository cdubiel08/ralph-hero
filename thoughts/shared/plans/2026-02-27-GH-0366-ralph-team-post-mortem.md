---
date: 2026-02-27
status: draft
github_issues: [366]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/366
primary_issue: 366
---

# Add Post-Mortem Reflection Step to ralph-team Shutdown - Implementation Plan

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-366 | Add post-mortem reflection step to ralph-team shutdown | S |

## Current State Analysis

`ralph-team/SKILL.md` is 63 lines. Shutdown is a single line (line 63): "When all tasks are complete, shut down each teammate and delete the team." No durable artifact is produced. The lead has `TaskList` and `TaskGet` in its allowed-tools but is missing `Write` — which must be added for post-mortem file creation. Task metadata includes `issue_number`, `artifact_path`, `result`, and worker-specific fields (PR URLs, review verdicts). The idea-hunt skill demonstrates the same pattern: "Read generated data → summarize → shutdown."

## Desired End State

### Verification
- [ ] `ralph-team/SKILL.md` includes a "Write Post-Mortem" section before shutdown
- [ ] Post-mortem template specifies `thoughts/shared/reports/` as output directory
- [ ] Post-mortem collects: issues processed, PRs created, worker summary, errors
- [ ] TeamDelete is called AFTER post-mortem is written
- [ ] `Write` tool is present in allowed-tools (must be added — not present in current version)

## What We're NOT Doing

- Not creating a new standalone `/ralph-postmortem` skill (overkill; data collection is straightforward)
- Not modifying hook scripts (`team-task-completed.sh`, `worker-stop-gate.sh`)
- Not adding timestamp tracking (no infrastructure for it; would require hook changes)
- Not making `create_status_update` mandatory (optional — not all users want GitHub posts)
- Not modifying agent definitions (`ralph-analyst.md`, `ralph-builder.md`, `ralph-integrator.md`)
- Not modifying `idea-hunt/SKILL.md` (could benefit from same pattern but out of scope)

## Implementation Approach

Single file change: replace the one-liner shutdown instruction in `ralph-team/SKILL.md` with a structured "Shut Down" section that includes post-mortem data collection before TeamDelete.

---

## Phase 1: Add post-mortem step to ralph-team SKILL.md
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/366 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0366-ralph-team-post-mortem.md

### Changes Required

#### 1. Add `Write` to allowed-tools
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Lines**: 5-17 (frontmatter allowed-tools list)
**Change**: Add `- Write` after `- Read` (line 6):

```yaml
allowed-tools:
  - Read
  - Write
  - Glob
```

This is required for the team lead to create the post-mortem report file.

#### 2. Replace shutdown instruction with structured Shut Down section
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Lines**: 63 (replace single line with new section)
**Change**: Replace:

```markdown
When all tasks are complete, shut down each teammate and delete the team.
```

With:

```markdown
## Shut Down

When all tasks are complete:

### 1. Write Post-Mortem

Before shutting down teammates or deleting the team, collect session results and write a report.

**Collect data**: Call `TaskList`, then `TaskGet` on each task. Extract from task metadata and descriptions:
- Issues processed (issue_number, title, estimate, final workflow state)
- PRs created (artifact_path or PR URLs from integrator tasks)
- Worker assignments (task owner → task subjects)
- Errors or escalations (tasks with failed results, Human Needed states)

**Write report** to `thoughts/shared/reports/YYYY-MM-DD-ralph-team-{team-name}.md`:

```markdown
# Ralph Team Session Report: {team-name}

**Date**: YYYY-MM-DD

## Issues Processed

| Issue | Title | Estimate | Outcome | PR |
|-------|-------|----------|---------|-----|
| #NNN | [title] | XS | Done | #PR |

## Worker Summary

| Worker | Tasks Completed |
|--------|----------------|
| analyst | [task subjects] |
| builder | [task subjects] |
| integrator | [task subjects] |

## Notes

[Escalations, errors, or anything notable from the session]
```

Commit and push the report:
```bash
git add thoughts/shared/reports/YYYY-MM-DD-ralph-team-*.md
git commit -m "docs(report): {team-name} session post-mortem"
git push origin main
```

### 2. Shut Down Teammates

Send shutdown to each teammate. Wait for all to confirm.

### 3. Delete Team

Call `TeamDelete()`. This removes the task list and team config.
```

### File Ownership Summary

| File | Action |
|------|--------|
| `plugin/ralph-hero/skills/ralph-team/SKILL.md` | MODIFY (frontmatter: add Write to allowed-tools; line 63: replace with Shut Down section) |

### Success Criteria

- [ ] Automated: `grep -q "Write Post-Mortem" plugin/ralph-hero/skills/ralph-team/SKILL.md` exits 0
- [ ] Automated: `grep -q "thoughts/shared/reports/" plugin/ralph-hero/skills/ralph-team/SKILL.md` exits 0
- [ ] Automated: `grep -q "TeamDelete" plugin/ralph-hero/skills/ralph-team/SKILL.md` exits 0
- [ ] Automated: `grep -c "Shut Down" plugin/ralph-hero/skills/ralph-team/SKILL.md` returns at least 1
- [ ] Automated: `grep -q "Write" plugin/ralph-hero/skills/ralph-team/SKILL.md` exits 0
- [ ] Manual: `Write` is present in the `allowed-tools` frontmatter list
- [ ] Manual: Post-mortem step appears BEFORE TeamDelete in the document
- [ ] Manual: No other skill or agent files are modified

## Integration Testing

- [ ] Verify `ralph-team/SKILL.md` is valid markdown (no broken code fences)
- [ ] Verify the post-mortem template in the plan uses standard markdown table syntax
- [ ] Verify the shutdown sequence is: Write Post-Mortem → Shut Down Teammates → Delete Team (correct ordering)

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0366-ralph-team-post-mortem.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/366
- Pattern reference: `plugin/ralph-hero/skills/idea-hunt/SKILL.md` (wrap up → summarize → shutdown)
- Report format reference: `thoughts/shared/reports/2026-02-21-weekly-ship-report.md`
