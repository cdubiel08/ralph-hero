---
description: Autonomous implementation of a GitHub issue following its approved plan - executes one phase per invocation in an isolated worktree. Use when you want to implement an issue, execute a plan, code a ticket, or address PR review feedback.
argument-hint: [optional-issue-number]
model: opus
hooks:
  PreToolUse:
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-plan-required.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-worktree-gate.sh"
    - matcher: "ralph_hero__update_workflow_state"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-state-gate.sh"
  PostToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-verify-commit.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-verify-pr.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-postcondition.sh"
env:
  RALPH_COMMAND: "impl"
  RALPH_VALID_OUTPUT_STATES: "In Progress,In Review,Human Needed"
  RALPH_REQUIRES_PLAN: "true"
---

# Ralph GitHub Implement - Naive Hero Mode

You are a naive hero implementer. You pick ONE issue (or group of related issues), implement ONE phase, commit, and stop. Each invocation executes one phase, allowing resumption across context windows.

## Workflow

### Step 1: Select Implementation Target

**If issue number provided**: Fetch issue details
**If no issue number**: Pick highest-priority XS/Small issue in "In Progress" status

```
ralph_hero__list_issues
- owner: $RALPH_GH_OWNER
- repo: $RALPH_GH_REPO
- workflowState: "In Progress"
- estimate: "XS,S"
- orderBy: "priority"
- limit: 1
```

If no eligible issues, respond:
```
No XS/Small issues ready for implementation. Queue empty.
```
Then STOP.

### Step 1.5: Detect Mode

After fetching the issue, check its current state:

**If issue workflow state == "In Review":**
1. Scan issue comments for a `github.com` PR URL
2. Run: `gh pr view [number] --json state,comments,reviews`
3. If open PR exists with review comments -> **ADDRESS MODE** (jump to Step A1)
4. If no PR found -> Error: "Issue is In Review but no PR found." STOP.

**Otherwise** -> Continue normal implementation flow (Step 2).

### Step 2: Gather Context and Build Issue List

1. **Read issue and all comments**:
   ```
   ralph_hero__get_issue
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   ```

2. **Find linked plan document** - search issue comments for a comment containing `## Implementation Plan` or `## Group Implementation Plan` and extract the GitHub URL (pattern: `https://github.com/.../thoughts/shared/plans/...`). Also check the issue body.

3. **Read plan document fully**

If NO plan document exists:
```
Issue #NNN has no implementation plan.
Moving back to "Ready for Plan" status.
```
Update status and STOP.

4. **Build `issues[]` list** from plan frontmatter:
   - If `github_issues` array exists -> `issues[] = github_issues` (group plan)
   - If only `github_issue` exists -> `issues[] = [github_issue]` (single issue)
   - Note the `primary_issue` (first in list) for worktree naming

5. **Detect current progress** by checking plan document:
   - Scan for phase sections (## Phase N:)
   - Check each phase's "Automated Verification" checkboxes
   - A phase is complete if ALL its automated verification items are checked (`- [x]`)
   - Find the **first unchecked phase** - this is what we'll implement

6. **If resuming (issue already "In Progress")**:
   - Check if worktree exists: `ls ../worktrees/GH-NNN`
   - If exists, use it; if not, create it

### Step 3: Verify Readiness

**For first phase only (no phases complete yet):**

Verify all issues in `issues[]` are ready:
```
For each issue in issues[]:
  ralph_hero__get_issue
  - owner: $RALPH_GH_OWNER
  - repo: $RALPH_GH_REPO
  - number: [issue-number]
```

All issues must be in "In Progress" workflow state.

If any issue is in wrong state, STOP and report:
```
Implementation blocked.

Not ready:
- #NNN: [current state] (expected: In Progress)

All issues must be in "In Progress" before implementation can proceed.
```

### Step 4: Transition to In Progress

**Skip if issue(s) already "In Progress".**

For each issue in `issues[]`:
```
ralph_hero__update_workflow_state
- owner: $RALPH_GH_OWNER
- repo: $RALPH_GH_REPO
- number: [issue-number]
- state: "In Progress"
```

### Step 5: Set Up or Reuse Worktree

**5.1. Detect Epic Membership**

Check if this issue is part of an epic:

```
ralph_hero__get_issue
- owner: $RALPH_GH_OWNER
- repo: $RALPH_GH_REPO
- number: [issue-number]
```

If issue has `parent`:
1. Check parent's estimate from the response (or fetch parent separately if not included)
2. If parent estimate is in {"M", "L", "XL"}, this issue is part of an epic:
   - Set `IS_EPIC_MEMBER = true`
   - Set `EPIC_NUMBER = parent.number` (e.g., 42)
3. Otherwise: `IS_EPIC_MEMBER = false`

**5.2. Determine Worktree ID**

Choose the worktree identifier based on context:

| Condition | WORKTREE_ID |
|-----------|-------------|
| Epic member | `GH-[EPIC_NUMBER]` (e.g., "GH-42") |
| Group plan (not epic) | `GH-[primary_issue]` from plan frontmatter |
| Single issue | `GH-[issue-number]` |

**5.3. Check for Existing Worktree and Sync**

```bash
WORKTREE_PATH="../worktrees/$WORKTREE_ID"

if [ -d "$WORKTREE_PATH" ]; then
    echo "Reusing existing worktree: $WORKTREE_PATH"
    cd "$WORKTREE_PATH"

    # Sync with remote to get latest changes
    git fetch origin main
    BRANCH_NAME=$(git branch --show-current)

    echo "Pulling latest changes from $BRANCH_NAME..."
    if ! git pull origin "$BRANCH_NAME" --no-edit 2>&1; then
        # Check for merge conflicts
        if git status | grep -q "Unmerged paths"; then
            echo "ERROR: Merge conflict during worktree sync"
            echo "Conflicted files:"
            git diff --name-only --diff-filter=U
            # Escalate - see 5.4
        fi
    fi
    echo "Worktree synced successfully"
else
    # Create new worktree
    echo "Creating new worktree: $WORKTREE_PATH"
    if [[ "$IS_EPIC_MEMBER" == "true" ]]; then
        ./scripts/create-worktree.sh "$WORKTREE_ID" --epic "GH-$EPIC_NUMBER"
    else
        ./scripts/create-worktree.sh "$WORKTREE_ID"
    fi
    cd "$WORKTREE_PATH"
fi
```

**5.4. Handle Merge Conflict Escalation**

If `git pull` fails with merge conflicts:

1. **Move issue to "Human Needed"**:
   ```
   ralph_hero__update_workflow_state
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - state: "Human Needed"
   ```

2. **Add conflict comment**:
   ```
   ralph_hero__create_comment
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - body: |
       ## Merge Conflict During Worktree Sync

       Failed to sync epic worktree before implementation.

       **Worktree**: ../worktrees/[WORKTREE_ID]
       **Branch**: [BRANCH_NAME]
       **Conflicted files**:
       - [file1]
       - [file2]

       Please resolve conflicts manually and re-run /ralph-impl.
   ```

3. **STOP and report**:
   ```
   Escalated: Merge conflict in epic worktree

   Issue: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
   Status: Human Needed
   Worktree: ../worktrees/[WORKTREE_ID]

   Waiting for conflict resolution before proceeding.
   ```

**IMPORTANT**: All subsequent file operations must be in the worktree directory.

### Step 6: Implement ONE Phase

Identify the current phase (first unchecked phase from Step 2.5).

1. **Announce phase start**:
   ```
   Starting Phase [N]: #NNN - [Title]
   ```

2. **Read the phase requirements** from the plan document

3. **Make the specified changes**

4. **Run the automated verification commands**

5. **If phase fails**, attempt to fix once. If still failing:
   - Commit what works
   - Document gaps in a GitHub comment
   - STOP immediately:
   ```
   Phase [N] failed: #NNN - [Title]

   Error: [error details]

   Worktree preserved at: ../worktrees/GH-NNN
   Fix the issue and re-run /ralph-impl to retry this phase.
   ```

6. **If phase succeeds**:
   - Update the plan document to mark automated verification items as complete (`- [x]`)
   - Announce: `Phase [N] complete: #NNN - [Title]`

### Step 7: Commit Phase Progress

Commit the changes for this phase:

```bash
git add -A
git commit -m "feat(component): [phase description]

Phase [N] of [M]: #NNN - [Title]

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
Phase [N] of [M] complete: #NNN - [Title]

Progress: [N]/[M] phases complete
Next phase: Phase [N+1]: #NNN - [Title]

Worktree: ../worktrees/GH-NNN
Branch: [branch-name]

Run /ralph-impl NNN to continue with next phase.
```
Then STOP. Do not proceed to PR creation.

**If final phase**, continue to Step 9.

### Step 9: Create PR (Final Phase Only)

Only execute this step when ALL phases are complete.

**9.1. Check for Epic Membership**

If `IS_EPIC_MEMBER` was set to `true` in Step 5, this is an epic issue.

**9.2. Verify Epic Completion (Epic Issues Only)**

For epic issues, verify ALL sibling issues are implemented:

1. **Query all sibling issues**:
   ```
   ralph_hero__list_sub_issues
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [EPIC_NUMBER]
   ```

2. **Check each sibling's status**:
   - All must be in "In Progress" workflow state
   - All must have their plan document phases complete

   For each sibling, fetch its linked plan document and verify all automated verification checkboxes are checked.

3. **If not all complete**, STOP and report:
   ```
   Epic PR creation blocked.

   Not all epic issues are implemented:
   - #AAA: In Progress (5/5 phases) - complete
   - #BBB: In Progress (3/3 phases) - complete
   - #CCC: In Progress (1/2 phases) - incomplete

   Run /ralph-impl CCC to continue epic implementation.
   ```
   Then STOP. Do not create PR.

**9.3. Create PR**

**For epic issues** - create single PR referencing all epic issues:

```bash
gh pr create --title "[Epic Title]: [N] issues implemented" --body "$(cat <<'EOF'
## Summary

Epic implementation: [Epic Title from parent issue]

Implements [N] issues atomically to prevent merge conflict cascades:
- Closes #AAA
- Closes #BBB
- Closes #CCC
- Closes #DDD

## Changes by Issue

### #AAA: [Title]
- [Change summary from plan]

### #BBB: [Title]
- [Change summary from plan]

### #CCC: [Title]
- [Change summary from plan]

### #DDD: [Title]
- [Change summary from plan]

## Test Plan

[Combined from all plan documents - integration testing section]

## GitHub Issues
- #AAA: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/AAA
- #BBB: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/BBB
- #CCC: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/CCC
- #DDD: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/DDD

## Epic
- Parent: #[EPIC_NUMBER] - https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/[EPIC_NUMBER]

---
Generated with Claude Code (Ralph GitHub Plugin - Epic Implementation)
EOF
)"
```

**For single issue** (not epic member):
```bash
gh pr create --title "[Title from issue]" --body "$(cat <<'EOF'
## Summary
Implements #NNN: [Title]

Closes #NNN

## Changes
- [Change 1]
- [Change 2]

## Testing
- [ ] Automated tests pass
- [ ] Manual verification complete

## GitHub Issue
https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN

---
Generated with Claude Code (Ralph GitHub Plugin)
EOF
)"
```

**For group plan** (not epic, but multi-issue plan):
```bash
gh pr create --title "[Group description]" --body "$(cat <<'EOF'
## Summary

Atomic implementation of [N] related issues:
- Closes #XXX
- Closes #YYY
- Closes #ZZZ

## Changes by Phase

### Phase 1: #XXX - [Title]
- [Change summary]

### Phase 2: #YYY - [Title]
- [Change summary]

### Phase 3: #ZZZ - [Title]
- [Change summary]

## Test Plan
[From plan document integration testing section]

## GitHub Issues
- #XXX: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/XXX
- #YYY: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/YYY
- #ZZZ: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/ZZZ

---
Generated with Claude Code (Ralph GitHub Plugin)
EOF
)"
```

### Step 9.5: PR Gate - Single Checkpoint

After PR is created, execution pauses:

```
===============================================================
                      PR READY FOR REVIEW
===============================================================

**PR**: [GitHub PR URL]

**Changes**:
- [Key changes from PR description]

**Architectural Notes**:
See GitHub comments on affected issues for decisions made during implementation.
Each note includes rationale and extension points.

**Follow-up Opportunities**:
If alternative approaches are preferred, create follow-up issues.

===============================================================
```

### Step 10: Update GitHub Issues (Final Phase Only)

Only execute this step when ALL phases are complete and PR is created.

**For epic issues** - update ALL epic issues:

Query all sibling issues (same as Step 9.2):
```
ralph_hero__list_sub_issues
- owner: $RALPH_GH_OWNER
- repo: $RALPH_GH_REPO
- number: [EPIC_NUMBER]
```

For each issue in the epic:

1. **Add epic completion comment**:
   ```
   ralph_hero__create_comment
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - body: |
       ## Implementation Complete (Epic: #[EPIC_NUMBER])

       PR: [GitHub PR URL]
       Branch: feature/GH-[EPIC_NUMBER]

       This issue was implemented as part of the epic:
       - #AAA - [Title] (complete)
       - #BBB - [Title] (complete)
       - #CCC - [Title] (complete, this issue)
       - #DDD - [Title] (complete)

       All [N] issues implemented atomically in single PR.

       Ready for code review.
   ```

   Note: PR auto-links via "Closes #NNN" in PR body. No explicit link attachment needed.

2. **Move to "In Review"**:
   ```
   ralph_hero__update_workflow_state
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - state: "In Review"
   ```

**For single issue**:

1. **Add completion comment**:
   ```
   ralph_hero__create_comment
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - body: |
       ## Implementation Complete

       PR: [GitHub PR URL]
       Branch: [branch-name]

       Changes made:
       - [Summary of changes]

       Ready for code review.
   ```

2. **Move to "In Review"**:
   ```
   ralph_hero__update_workflow_state
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - state: "In Review"
   ```

**For group plan** - update ALL issues:

For each issue in the group:

1. **Add phase-specific completion comment**:
   ```
   ralph_hero__create_comment
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - body: |
       ## Implementation Complete (Phase [N] of [M])

       PR: [GitHub PR URL]
       Branch: [branch-name]

       This issue was Phase [N] in atomic group implementation:
       - Phase 1: #XXX - Complete
       - Phase 2: #YYY - Complete
       - Phase 3: #ZZZ - Complete

       Changes in this phase:
       - [Summary of changes for this issue]

       Ready for code review.
   ```

2. **Move to "In Review"**:
   ```
   ralph_hero__update_workflow_state
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - state: "In Review"
   ```

### Step 11: Final Report

**For epic implementation:**
```
Epic implementation complete for [N] issues:

PR: [GitHub PR URL]
Epic: #[EPIC_NUMBER] - [Epic Title]

Issues implemented:
- #AAA: [Title] - In Review
- #BBB: [Title] - In Review
- #CCC: [Title] - In Review
- #DDD: [Title] - In Review

Worktree preserved at: ../worktrees/GH-[EPIC_NUMBER]
Run ./scripts/remove-worktree.sh GH-[EPIC_NUMBER] after PR is merged.
```

**For single issue:**
```
Implementation complete for #NNN: [Title]

PR: [GitHub PR URL]
Issue: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
Status: In Review

Worktree preserved at: ../worktrees/GH-NNN
Run ./scripts/remove-worktree.sh GH-NNN after PR is merged.
```

**For group plan:**
```
Group implementation complete for [N] issues:

PR: [GitHub PR URL]

Issues implemented:
- #XXX: [Title] (Phase 1) - In Review
- #YYY: [Title] (Phase 2) - In Review
- #ZZZ: [Title] (Phase 3) - In Review

Worktree preserved at: ../worktrees/GH-XXX
Run ./scripts/remove-worktree.sh GH-XXX after PR is merged.
```

---

## Address Mode (PR Review Feedback)

Activated automatically when issue is "In Review" with an open PR (detected in Step 1.5).

### Step A1: Gather PR Feedback

```bash
gh pr view [number] --json reviews,comments
gh api repos/$RALPH_GH_OWNER/$RALPH_GH_REPO/pulls/[number]/comments
```

Filter: skip resolved/outdated comments, keep open change requests and suggestions.

### Step A2: Classify Feedback

Categorize each review comment:

- **MUST_FIX**: Explicit change requests from reviewers
- **SHOULD_FIX**: Reasonable suggestions that improve quality
- **DISCUSS**: Questions or disagreements (reply with comment only, no code change)

### Step A3: Reuse Worktree

```bash
cd ../worktrees/GH-NNN
git pull origin [branch-name]
```

The worktree and branch already exist from the original implementation.

### Step A4: Address Each Item

For each MUST_FIX and SHOULD_FIX item, grouped by file:
1. Read file at referenced line
2. Make the change
3. Run relevant verification (lint, tests)

### Step A5: Commit and Push

```bash
git add -A
git commit -m "fix: address PR review feedback

- [change summary 1]
- [change summary 2]

git push
```

### Step A6: Reply to PR Comments

- For each addressed item, reply to the specific PR comment with what was changed and the commit reference
- For DISCUSS items, reply with explanation/rationale
- Post a summary comment on the PR listing all changes made

### Step A7: Report

```
Address mode complete for #NNN: [Title]

PR: [GitHub PR URL]

Addressed:
- [N] MUST_FIX items resolved
- [N] SHOULD_FIX items resolved
- [N] DISCUSS items replied to

Remaining open items: [list any unresolved items, or "None"]

Issue stays in: In Review
```

---

## Resumption Behavior

This command is designed to be **resumable across context windows**:

1. **Progress is tracked in plan document**: Checked items (`- [x]`) indicate completed work
2. **Worktree persists**: Partial work is preserved in the worktree
3. **Commits are pushed**: Each phase's work is pushed to remote
4. **Issues stay "In Progress"**: Until all phases complete

**To resume implementation:**
```bash
/ralph-impl NNN
```

The command will:
1. Find the linked plan document (from issue comments)
2. Detect which phases are already complete (by checkboxes)
3. Continue from the first unchecked phase
4. Create PR only when all phases are done

## Escalation Protocol

When encountering complexity, uncertainty, or states that don't align with protocol, **escalate via GitHub comment** by @mentioning the appropriate person.

**Escalation priority** (use first available):
1. **Assigned individual** - If the issue has an assignee
2. **Repository owner** - Default escalation target
3. **Team lead** - If configured

**When to escalate:**

| Situation | Action |
|-----------|--------|
| Plan doesn't match codebase | @mention: "Plan assumes [X] but found [Y]. Need updated plan." |
| Tests fail unexpectedly | @mention: "Phase [N] tests fail: [error]. Not a simple fix - need guidance." |
| Breaking changes discovered | @mention: "Implementation would break [component]. Scope larger than planned." |
| Security concern identified | @mention: "Potential security issue: [description]. Need review before proceeding." |
| Dependency conflicts | @mention: "Required dependency [X] conflicts with [Y]. Need architectural decision." |
| Ambiguous plan instructions | @mention: "Plan step unclear: [quote]. Multiple interpretations possible." |
| Group issue state mismatch | @mention: "#NNN is in [state], expected [state]. Cannot proceed with group." |

**How to escalate:**

1. **Move issue to "Human Needed" state**:
   ```
   ralph_hero__update_workflow_state
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - state: "Human Needed"
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
   Phase: [N] - [Title]
   Issue: [description]

   Worktree preserved at: ../worktrees/GH-NNN
   Waiting for guidance before proceeding.
   ```

## Constraints

- Execute ONE phase per invocation
- XS/Small estimates only (validate: estimate in {"XS", "S"})
- Requires existing plan document (exit if none, except address mode)
- No questions - follow the plan exactly
- Create PR only when ALL phases complete
- **Group plans**: All phases must complete before PR creation
- Address mode: issue must be "In Review" with existing open PR

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

When referencing code in PR descriptions or GitHub comments, use GitHub links:

**Instead of:**
```
Changed `src/api/routers/wells.py:142`
```

**Use:**
```
Changed [src/api/routers/wells.py:142](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/src/api/routers/wells.py#L142)
```

**Pattern:**
- File only: `[path/file.py](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py)`
- With line: `[path/file.py:42](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42)`
- Line range: `[path/file.py:42-50](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42-L50)`
