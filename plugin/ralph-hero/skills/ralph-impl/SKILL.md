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

### Step 3: Verify Readiness (First Phase Only)

For each issue in `issues[]`, verify workflow state is "In Progress" via `get_issue`.
If any issue is in wrong state, STOP: "Implementation blocked. #NNN: [state] (expected: In Progress)"

### Step 4: Transition to In Progress

Skip if already "In Progress". For each issue in `issues[]`:
```
ralph_hero__update_workflow_state
- owner: $RALPH_GH_OWNER
- repo: $RALPH_GH_REPO
- number: [issue-number]
- state: "__LOCK__"
- command: "ralph_impl"
```
On error: read message for valid states/recovery action, retry with corrected parameters.

### Step 5: Set Up or Reuse Worktree

**5.1. Detect Epic Membership** (from Step 2's `get_issue` response)

If issue has `parent` with estimate in {"M", "L", "XL"}:
- `IS_EPIC_MEMBER = true`, `EPIC_NUMBER = parent.number`
Otherwise: `IS_EPIC_MEMBER = false`

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
    cd "$WORKTREE_PATH"
    git fetch origin main && git pull origin "$(git branch --show-current)" --no-edit
    # If merge conflict -> escalate (5.4)
else
    ./scripts/create-worktree.sh "$WORKTREE_ID" [--epic "GH-$EPIC_NUMBER" if epic]
    cd "$WORKTREE_PATH"
fi
```

**5.4. Handle Merge Conflict Escalation**

If `git pull` fails with merge conflicts: escalate per `shared/conventions.md` (use `__ESCALATE__` state, comment with conflicted files list, STOP).

**IMPORTANT**: All subsequent file operations must be in the worktree directory.

### Step 6: Implement ONE Phase

Current phase = first unchecked phase from Step 2.5.

1. Announce: `Starting Phase [N]: #NNN - [Title]`
2. Read phase requirements from plan
3. Make the specified changes
4. Run automated verification commands
5. **If fails**: attempt fix once. If still failing, commit what works, comment on issue, STOP with error details.
6. **If succeeds**: mark plan checkboxes as `- [x]`

### Step 7: Commit and Push

```bash
git add -A
git commit -m "feat(component): [phase description]
Phase [N] of [M]: #NNN - [Title]"
git push -u origin [branch-name]
```

### Step 8: Check if All Phases Complete

Re-read plan. If ALL automated verification checkboxes are checked -> continue to Step 9.

**If NOT final phase**, STOP:
```
Phase [N]/[M] complete. Next: Phase [N+1]. Run /ralph-impl NNN to continue.
```

### Step 9: Create PR (Final Phase Only)

Only execute this step when ALL phases are complete.

**9.1. Check for Epic Membership**

If `IS_EPIC_MEMBER` was set to `true` in Step 5, this is an epic issue.

**9.2. Verify Epic Completion (Epic Issues Only)**

Query siblings via `ralph_hero__list_sub_issues` on the epic. For each sibling: verify "In Progress" state AND all plan checkboxes checked. If any incomplete, STOP: list status per issue, suggest `/ralph-impl [incomplete-issue]`.

**9.3. Create PR** (single template, adapt sections by context)

```bash
gh pr create --title "[Title]" --body "$(cat <<'EOF'
## Summary
[Single: "Implements #NNN: [Title]"]
[Group/Epic: "Atomic implementation of [N] related issues:"]

[For each issue:]
- Closes #NNN

## Changes
[Single: bullet list of changes]
[Group/Epic: subsection per issue with change summary from plan]

## Test Plan
[From plan document - automated verification + integration testing]

[If epic, add:]
## Epic
- Parent: #[EPIC_NUMBER]

---
Generated with Claude Code (Ralph GitHub Plugin)
EOF
)"
```

### Step 9.5: PR Gate

Output PR URL and key changes summary. Execution pauses for review.

### Step 10: Update GitHub Issues (Final Phase Only)

Only execute when ALL phases are complete and PR is created.

For each issue in `issues[]` (single: just one; group/epic: all issues):

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
       [If group/epic: list all issues and their status]
       Ready for code review.
   ```

2. **Move to "In Review"**:
   ```
   ralph_hero__update_workflow_state
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - state: "__COMPLETE__"
   - command: "ralph_impl"
   ```

Note: PR auto-links via "Closes #NNN" in PR body. No explicit link attachment needed.

### Step 11: Final Report

```
Implementation complete.

PR: [GitHub PR URL]
[List all issues with titles and "In Review" status]

Worktree preserved at: ../worktrees/[WORKTREE_ID]
Run ./scripts/remove-worktree.sh [WORKTREE_ID] after PR is merged.
```

---

## Address Mode (PR Review Feedback)

Activated when issue is "In Review" with an open PR (detected in Step 1.5).

**A1. Gather feedback**: `gh pr view [number] --json reviews,comments` + `gh api repos/$RALPH_GH_OWNER/$RALPH_GH_REPO/pulls/[number]/comments`. Skip resolved/outdated comments.

**A2. Classify** each comment:
- **MUST_FIX**: Explicit change requests
- **SHOULD_FIX**: Quality improvements
- **DISCUSS**: Reply only, no code change

**A3. Reuse worktree**: `cd ../worktrees/GH-NNN && git pull origin [branch-name]`

**A4. Address items** grouped by file: read, fix, verify (lint/tests).

**A5. Commit and push**:
```bash
git add -A
git commit -m "fix: address PR review feedback
- [change summaries]"
git push
```

**A6. Reply to PR comments**: Reply to each addressed item with change + commit ref. For DISCUSS items, reply with rationale. Post summary comment.

**A7. Report**: List MUST_FIX/SHOULD_FIX/DISCUSS counts resolved. Issue stays "In Review".

---

## Resumption Behavior

Resumable across context windows. Progress tracked by plan checkbox state (`- [x]`), worktree persists, commits pushed each phase. Run `/ralph-impl NNN` to resume from first unchecked phase.

## Escalation Protocol

See `shared/conventions.md` for full escalation protocol. Use `command: "ralph_impl"` when escalating.

## Constraints

- ONE phase per invocation. XS/Small estimates only.
- Requires plan document (exit if none, except address mode)
- Follow plan exactly - no scope creep, no skipped verification
- PR only when ALL phases complete
- Always push after commit. Always update plan checkboxes.

## Link Formatting

See `shared/conventions.md` for GitHub link format patterns.
