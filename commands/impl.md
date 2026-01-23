---
name: impl
description: Autonomous implementation of highest-priority ticket ready for development
argument-hint: [optional-ticket-id]
model: opus
---

# Ralph Implement - Naive Hero Mode

You are a naive hero implementer. You pick ONE ticket (or group of related tickets), implement ONE phase, commit, and stop. Each invocation executes one phase, allowing resumption across context windows.

## Configuration Loading

Before proceeding, load Ralph configuration:

1. **Check configuration exists**:
   ```bash
   if [ ! -f ".ralph/config.json" ]; then
     echo "Ralph not configured. Run /ralph:setup first."
     exit 1
   fi
   ```

2. **Load configuration values**:
   Read `.ralph/config.json` and extract:
   - `LINEAR_TEAM_NAME` from `linear.teamName`
   - `LINEAR_STATE_TODO` from `linear.states.todo`
   - `LINEAR_STATE_IN_PROGRESS` from `linear.states.inProgress`
   - `LINEAR_STATE_IN_REVIEW` from `linear.states.inReview`
   - `LINEAR_STATE_HUMAN_NEEDED` from `linear.states.humanNeeded`
   - `GITHUB_REPO_URL` from `github.repoUrl`
   - `GITHUB_DEFAULT_BRANCH` from `github.defaultBranch`
   - `WORKTREE_BASE` from `paths.worktreeBase`
   - `PLANS_DIR` from `paths.plansDir`

## Workflow

### Step 1: Select Implementation Target

**If ticket ID provided**: Check if it's part of a group plan
**If no ticket ID**: Pick highest-priority XS/Small ticket/group in "Todo" or "In Progress" status

```
Use /ralph:linear pick "Todo" OR "In Progress"
```

If no eligible tickets, respond:
```
No XS/Small tickets ready for implementation. Queue empty.
```
Then STOP.

### Step 2: Gather Context and Detect Group Plan

1. **Read ticket and all comments**
2. **Find linked plan document** - check ticket attachments for plan URL
3. **Read plan document fully**

If NO plan document exists:
```
Ticket ENG-XXX has no implementation plan.
Moving back to "Ready for Plan" status.
```
Update status and STOP.

4. **Check if this is a group plan** by examining frontmatter:
   - If `linear_tickets` array exists with >1 entries, this is a **group plan**
   - Note the `primary_ticket` for worktree naming
   - If single ticket or no array, proceed as normal single-ticket implementation

5. **Detect current progress** by checking plan document:
   - Scan for phase sections (## Phase N:)
   - Check each phase's "Automated Verification" checkboxes
   - A phase is complete if ALL its automated verification items are checked (`- [x]`)
   - Find the **first unchecked phase** - this is what we'll implement

6. **If resuming (ticket already "In Progress")**:
   - Check if worktree exists: `ls [WORKTREE_BASE]/ENG-XXX`
   - If exists, use it; if not, create it

### Step 3: Verify Group Readiness (Group Plans Only)

**For group plans starting fresh (no phases complete yet)**:

Verify all group tickets are ready:
```
mcp__plugin_linear_linear__get_issue
- id: [each-ticket-id]
```

All tickets in `linear_tickets` array must be in "Todo" or "In Progress" status.

If any ticket is in wrong status, STOP and report:
```
Group implementation blocked.

Not ready:
- ENG-YYY: [current status] (expected: Todo or In Progress)

All group tickets must be in "Todo" or "In Progress" before implementation can proceed.
```

### Step 4: Transition to In Progress

**Skip if ticket(s) already "In Progress".**

**For single ticket:**
```
mcp__plugin_linear_linear__update_issue
- id: [ticket-id]
- state: "In Progress"
```

**For group plan (first phase only)** - move ALL tickets to "In Progress":
```
For each ticket in linear_tickets:
  mcp__plugin_linear_linear__update_issue
  - id: [ticket-id]
  - state: "In Progress"
```

### Step 5: Set Up or Reuse Worktree

**Check if worktree exists:**
```bash
if [ -d "[WORKTREE_BASE]/ENG-XXX" ]; then
  echo "Reusing existing worktree"
  cd [WORKTREE_BASE]/ENG-XXX
else
  ./scripts/create-worktree.sh ENG-XXX
fi
```

For group plans, use the `primary_ticket` from frontmatter for the worktree name.

**IMPORTANT**: All subsequent file operations must be in the worktree directory.

### Step 6: Implement ONE Phase

Identify the current phase (first unchecked phase from Step 2.5).

1. **Announce phase start**:
   ```
   Starting Phase [N]: ENG-XXX - [Title]
   ```

2. **Read the phase requirements** from the plan document

3. **Make the specified changes**

4. **Run the automated verification commands**

5. **If phase fails**, STOP immediately:
   ```
   Phase [N] failed: ENG-XXX - [Title]

   Error: [error details]

   Worktree preserved at: [WORKTREE_BASE]/ENG-XXX
   Fix the issue and re-run /ralph:impl to retry this phase.
   ```

6. **If phase succeeds**:
   - Update the plan document to mark automated verification items as complete (`- [x]`)
   - Announce: `Phase [N] complete: ENG-XXX - [Title]`

### Step 7: Commit Phase Progress

Commit the changes for this phase:

```bash
git add -A
git commit -m "feat(component): [phase description]

Phase [N] of [M]: ENG-XXX - [Title]

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

Push to preserve progress:
```bash
git push -u origin [branch-name]
```

### Step 8: Check if All Phases Complete

**Determine if this was the final phase:**
- Re-read the plan document
- Check if ALL phases have their automated verification items checked
- If any phase remains unchecked, this is NOT the final phase

**If NOT final phase**, report and STOP:
```
Phase [N] of [M] complete: ENG-XXX - [Title]

Progress: [N]/[M] phases complete
Next phase: Phase [N+1]: ENG-YYY - [Title]

Worktree: [WORKTREE_BASE]/ENG-XXX
Branch: [branch-name]

Run /ralph:impl ENG-XXX to continue with next phase.
```
Then STOP. Do not proceed to PR creation.

**If final phase**, continue to Step 9.

### Step 9: Create PR (Final Phase Only)

Only execute this step when ALL phases are complete.

**For single ticket:**
```bash
gh pr create --title "[Title from ticket]" --body "$(cat <<'EOF'
## Summary
Implements ENG-XXX: [Title]

## Changes
- [Change 1]
- [Change 2]

## Testing
- [ ] Automated tests pass
- [ ] Manual verification complete

## Linear Ticket
[Linear URL]

---
Generated with Claude Code (Naive Hero Mode)
EOF
)"
```

**For group plan:**
Create single PR referencing all tickets with "Closes" format:
```bash
gh pr create --title "[Group description]" --body "$(cat <<'EOF'
## Summary

Atomic implementation of [N] related tickets:
- Closes #ENG-XXX
- Closes #ENG-YYY
- Closes #ENG-ZZZ

## Changes by Phase

### Phase 1: [ENG-XXX Title]
- [Change summary]

### Phase 2: [ENG-YYY Title]
- [Change summary]

### Phase 3: [ENG-ZZZ Title]
- [Change summary]

## Test Plan
[From plan document integration testing section]

## Linear Tickets
- [ENG-XXX Linear URL]
- [ENG-YYY Linear URL]
- [ENG-ZZZ Linear URL]

---
Generated with Claude Code (Naive Hero Mode)
EOF
)"
```

### Step 10: Update Linear Tickets (Final Phase Only)

Only execute this step when ALL phases are complete and PR is created.

**For single ticket:**

1. **Add PR link** to ticket:
   ```
   mcp__plugin_linear_linear__update_issue
   - id: [ticket-id]
   - links: [{"url": "[GitHub PR URL]", "title": "Pull Request"}]
   ```

2. **Add completion comment**:
   ```markdown
   ## Implementation Complete

   PR: [GitHub PR URL]
   Branch: [branch-name]

   Changes made:
   - [Summary of changes]

   Ready for code review.
   ```

3. **Move to "In Review"** status:
   ```
   mcp__plugin_linear_linear__update_issue
   - id: [ticket-id]
   - state: "In Review"
   ```

**For group plan** - update ALL tickets:

For each ticket in the group:

1. **Add PR link**:
   ```
   mcp__plugin_linear_linear__update_issue
   - id: [ticket-id]
   - links: [{"url": "[GitHub PR URL]", "title": "Pull Request (Group Implementation)"}]
   ```

2. **Add phase-specific completion comment**:
   ```markdown
   ## Implementation Complete (Phase [N] of [M])

   PR: [GitHub PR URL]
   Branch: [branch-name]

   This ticket was Phase [N] in atomic group implementation:
   - Phase 1: ENG-XXX - Complete
   - Phase 2: ENG-YYY - Complete
   - Phase 3: ENG-ZZZ - Complete

   Changes in this phase:
   - [Summary of changes for this ticket]

   Ready for code review.
   ```

3. **Move to "In Review"**:
   ```
   mcp__plugin_linear_linear__update_issue
   - id: [ticket-id]
   - state: "In Review"
   ```

### Step 11: Final Report

**For single ticket:**
```
Implementation complete for ENG-XXX: [Title]

PR: [GitHub PR URL]
Ticket: [Linear URL]
Status: In Review

Worktree preserved at: [WORKTREE_BASE]/ENG-XXX
Run ./scripts/remove-worktree.sh ENG-XXX after PR is merged.
```

**For group plan:**
```
Group implementation complete for [N] tickets:

PR: [GitHub PR URL]

Tickets implemented:
- ENG-XXX: [Title] (Phase 1) - In Review
- ENG-YYY: [Title] (Phase 2) - In Review
- ENG-ZZZ: [Title] (Phase 3) - In Review

Worktree preserved at: [WORKTREE_BASE]/ENG-XXX
Run ./scripts/remove-worktree.sh ENG-XXX after PR is merged.
```

## Resumption Behavior

This command is designed to be **resumable across context windows**:

1. **Progress is tracked in plan document**: Checked items (`- [x]`) indicate completed work
2. **Worktree persists**: Partial work is preserved in the worktree
3. **Commits are pushed**: Each phase's work is pushed to remote
4. **Tickets stay "In Progress"**: Until all phases complete

**To resume implementation:**
```bash
/ralph:impl ENG-XXX
```

The command will:
1. Find the linked plan document
2. Detect which phases are already complete (by checkboxes)
3. Continue from the first unchecked phase
4. Create PR only when all phases are done

## Escalation Protocol

When encountering complexity, uncertainty, or states that don't align with protocol, **escalate via Linear comment** by @mentioning the appropriate person.

**Escalation priority** (use first available):
1. **Assigned individual** - If the ticket has an assignee
2. **Project owner** - If the ticket belongs to a project with a lead
3. **Team lead** - Default escalation target

**When to escalate:**

| Situation | Action |
|-----------|--------|
| Plan doesn't match codebase | @mention: "Plan assumes [X] but found [Y]. Need updated plan." |
| Tests fail unexpectedly | @mention: "Phase [N] tests fail: [error]. Not a simple fix - need guidance." |
| Breaking changes discovered | @mention: "Implementation would break [component]. Scope larger than planned." |
| Security concern identified | @mention: "Potential security issue: [description]. Need review before proceeding." |
| Dependency conflicts | @mention: "Required dependency [X] conflicts with [Y]. Need architectural decision." |
| Ambiguous plan instructions | @mention: "Plan step unclear: [quote]. Multiple interpretations possible." |
| Group ticket state mismatch | @mention: "ENG-X is in [state], expected [state]. Cannot proceed with group." |

**How to escalate:**

1. **Move ticket to "Human Needed" state**:
   ```
   mcp__plugin_linear_linear__update_issue
   - id: [ticket-id]
   - state: "Human Needed"
   ```
   For group plans, move ALL group tickets to "Human Needed".

2. **Add comment with @mention**:
   ```
   mcp__plugin_linear_linear__create_comment
   - issueId: [ticket-id]
   - body: "@[user-email-or-name] Escalation: [issue description]"
   ```

3. **STOP and report**:
   ```
   Escalated to @[person]: [brief reason]

   Ticket: [Linear URL]
   Status: Human Needed
   Phase: [N] - [Title]
   Issue: [description]

   Worktree preserved at: [WORKTREE_BASE]/ENG-XXX
   Waiting for guidance before proceeding.
   ```

**Note**: The "Human Needed" state must exist in Linear. If missing, create it in Linear Settings -> Team -> Workflow with type "started".

## Constraints

- Execute ONE phase per invocation
- XS/Small estimates only
- Requires existing plan document (exit if none)
- No questions - follow the plan exactly
- Create PR only when ALL phases complete
- **Group plans**: All phases must complete before PR creation

## Implementation Quality Guidelines

Focus on:
- Following the plan exactly for the current phase
- Running all verification steps
- Creating clean, incremental commits
- Updating plan checkboxes accurately

Avoid:
- Scope creep beyond the current phase
- Skipping verification steps
- Implementing multiple phases in one invocation
- Forgetting to push changes

## Link Formatting

When referencing code in PR descriptions or Linear comments, use GitHub links:

**Instead of:**
```
Changed `src/api/routers/wells.py:142`
```

**Use:**
```
Changed [src/api/routers/wells.py:142]([GITHUB_REPO_URL]/blob/[GITHUB_DEFAULT_BRANCH]/src/api/routers/wells.py#L142)
```

**Pattern:**
- File only: `[path/file.py]([GITHUB_REPO_URL]/blob/[GITHUB_DEFAULT_BRANCH]/path/file.py)`
- With line: `[path/file.py:42]([GITHUB_REPO_URL]/blob/[GITHUB_DEFAULT_BRANCH]/path/file.py#L42)`
- Line range: `[path/file.py:42-50]([GITHUB_REPO_URL]/blob/[GITHUB_DEFAULT_BRANCH]/path/file.py#L42-L50)`
