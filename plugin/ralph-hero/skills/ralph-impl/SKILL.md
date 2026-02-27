---
description: Autonomous implementation of a GitHub issue following its approved plan - executes one phase per invocation in an isolated worktree. Use when you want to implement an issue, execute a plan, code a ticket, or address PR review feedback.
argument-hint: [optional-issue-number] [--plan-doc path]
context: fork
model: opus
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=impl RALPH_VALID_OUTPUT_STATES='In Progress,In Review,Human Needed' RALPH_REQUIRES_PLAN=true"
  PreToolUse:
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-plan-required.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-worktree-gate.sh"
    - matcher: "ralph_hero__save_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-state-gate.sh"
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-staging-gate.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-branch-gate.sh"
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
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
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
- profile: "builder-active"
# Profile expands to: workflowState: "In Progress"
- orderBy: "priority"
- limit: 1
```

If no eligible issues, respond:
```
No XS/Small issues ready for implementation. Queue empty.
```
Then STOP.

### Step 2: Detect Mode

After fetching the issue, check its current state:

**If issue workflow state == "In Review":**
1. Scan issue comments for a `github.com` PR URL
2. Run: `gh pr view [number] --json state,comments,reviews`
3. If open PR exists with review comments -> **ADDRESS MODE** (jump to Step A1)
4. If no PR found -> Error: "Issue is In Review but no PR found." STOP.

**Otherwise** -> Continue normal implementation flow (Step 3).

### Step 3: Gather Context and Build Issue List

1. **Read issue and all comments**:
   ```
   ralph_hero__get_issue
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   ```

2. **Find linked plan document**:

   **Artifact shortcut** (see [Artifact Passthrough Protocol](../shared/conventions.md#artifact-passthrough-protocol)): If `--plan-doc` flag was provided in args and the file exists on disk, read it directly and skip steps 1-8 below. If the file does not exist, log `"Artifact flag path not found, falling back to discovery: [path]"` and continue with standard discovery.

   Per Artifact Comment Protocol in shared/conventions.md:
   1. Search issue comments for `## Implementation Plan` or `## Group Implementation Plan` header. If multiple matches, use the **most recent** (last) match.
   2. Extract the GitHub URL from the line after the header
   3. Convert to local path: strip `https://github.com/OWNER/REPO/blob/main/` prefix
   4. Read the plan document fully
   5. **Fallback**: If no comment found, glob for the plan doc. Try both padded and unpadded:
      - `thoughts/shared/plans/*GH-${number}*`
      - `thoughts/shared/plans/*GH-$(printf '%04d' ${number})*`
      Use the most recent match if multiple found.
   6. **Group fallback**: If standard glob fails, try `thoughts/shared/plans/*group*GH-{primary}*` where `{primary}` is the primary issue number from the issue's group context.
   6b. **Stream fallback**: If group fallback also fails, try `thoughts/shared/plans/*stream*GH-{number}*` to find stream plans containing this issue.
   7. **If fallback found, self-heal**: Post the missing comment to the issue:
      ```
      ralph_hero__create_comment(owner, repo, number, body="## Implementation Plan\n\nhttps://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/[path]\n\n(Self-healed: artifact was found on disk but not linked via comment)")
      ```
   8. **If neither found**: STOP with "Issue #NNN has no implementation plan. Run /ralph-plan first."

3. **Read plan document fully**

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
   - Resolve git root: `GIT_ROOT=$(git rev-parse --show-toplevel)`
   - Check if worktree exists: `ls "$GIT_ROOT/worktrees/GH-NNN"`
   - If exists, use it; if not, create it

### Step 4: Verify Readiness (First Phase Only)

For each issue in `issues[]`, verify workflow state is "In Progress" via `get_issue`.
If any issue is in wrong state, STOP: "Implementation blocked. #NNN: [state] (expected: In Progress)"

### Step 5: Transition to In Progress

Skip if already "In Progress". For each issue in `issues[]`:
```
ralph_hero__save_issue
- number: [issue-number]
- workflowState: "__LOCK__"
- command: "ralph_impl"
```
On error: read message for valid states/recovery action, retry with corrected parameters.

### Step 6: Set Up or Reuse Worktree

**6.1. Detect Epic Membership** (from Step 3's `get_issue` response)

If issue has `parent` with estimate in {"M", "L", "XL"}:
- `IS_EPIC_MEMBER = true`, `EPIC_NUMBER = parent.number`
Otherwise: `IS_EPIC_MEMBER = false`

**6.2. Determine Worktree ID**

Choose the worktree identifier based on context:

| Condition | WORKTREE_ID |
|-----------|-------------|
| Stream member (epic) | `GH-[EPIC_NUMBER]-stream-[SORTED-ISSUES]` (e.g., "GH-40-stream-42-44") |
| Epic member | `GH-[EPIC_NUMBER]` (e.g., "GH-42") |
| Group plan (not epic) | `GH-[primary_issue]` from plan frontmatter |
| Single issue | `GH-[issue-number]` |

Stream detection: if plan frontmatter contains `stream_id`, use the stream worktree naming. This takes precedence over the generic epic member row.

**6.3. Check for Existing Worktree and Sync**

```bash
# Resolve paths from git root (works from any directory)
GIT_ROOT=$(git rev-parse --show-toplevel)
WORKTREE_PATH="$GIT_ROOT/worktrees/$WORKTREE_ID"

if [ -d "$WORKTREE_PATH" ]; then
    cd "$WORKTREE_PATH"
    git fetch origin main && git pull origin "$(git branch --show-current)" --no-edit
    # If merge conflict -> escalate (6.4)
else
    "$GIT_ROOT/scripts/create-worktree.sh" "$WORKTREE_ID"
    cd "$WORKTREE_PATH"
fi
```

**6.4. Handle Merge Conflict Escalation**

If `git pull` fails with merge conflicts: escalate per `shared/conventions.md` (use `__ESCALATE__` state, comment with conflicted files list, STOP).

**CRITICAL**: After `cd "$WORKTREE_PATH"`, ALL subsequent file operations (Read, Write, Edit, Bash)
must use paths relative to the worktree OR absolute paths within the worktree.
The impl-worktree-gate hook will BLOCK any Write/Edit outside the worktree directory.

### Step 7: Implement ONE Phase

Current phase = first unchecked phase from Step 3.

1. Announce: `Starting Phase [N]: #NNN - [Title]`
2. Read phase requirements from plan
3. Make the specified changes
4. Run automated verification commands
5. **If fails**: attempt fix once. If still failing, commit what works, comment on issue, STOP with error details.
6. **If succeeds**: mark plan checkboxes as `- [x]`

### Step 8: Commit and Push

1. Review all changes in the working directory:
   ```bash
   git status --porcelain
   ```

2. Compare against this phase's expected files from the plan's **File Ownership Summary** table (or the **Changes Required** file list for this phase). Stage ONLY the expected files:
   ```bash
   git add <file1> <file2> ...
   ```

3. If `git status` shows unexpected modified/new files NOT in this phase's ownership, do NOT stage them. Warn:
   ```
   WARNING: Unexpected files not in Phase [N] ownership:
   - path/to/unexpected-file
   Skipping. These may belong to another agent or phase.
   ```

4. If the plan has no File Ownership Summary, stage only files you explicitly created or modified in this phase. Never use `git add -A`, `git add .`, or `git add --all`.

5. Commit and push:
   ```bash
   git commit -m "feat(component): [phase description]

   Phase [N] of [M]: #NNN - [Title]"
   git push -u origin [branch-name]
   ```

### Step 9: Check if All Phases Complete

Re-read plan. If ALL automated verification checkboxes are checked -> continue to Step 10.

**If NOT final phase**, STOP:
```
Phase [N]/[M] complete. Next: Phase [N+1]. Run /ralph-impl NNN to continue.
```

### Step 10: Create PR (Final Phase Only)

Only execute this step when ALL phases are complete.

**10.1. Check for Epic Membership**

If `IS_EPIC_MEMBER` was set to `true` in Step 6, this is an epic issue.

**10.2. Verify Epic Completion (Epic Issues Only)**

Query siblings via `ralph_hero__list_sub_issues` on the epic. For each sibling: verify "In Progress" state AND all plan checkboxes checked. If any incomplete, STOP: list status per issue, suggest `/ralph-impl [incomplete-issue]`.

**10.3. Create PR** (single template, adapt sections by context)

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

[If stream, add:]
## Stream Context
- Epic: #[EPIC_NUMBER]
- Stream: [STREAM_ID] ([N] of [TOTAL_STREAMS] streams)
- Stream issues: [list of #NNN]

[If epic (non-stream), add:]
## Epic
- Parent: #[EPIC_NUMBER]

---
Generated with Claude Code (Ralph GitHub Plugin)
EOF
)"
```

### Step 11: PR Gate

Output PR URL and key changes summary. Execution pauses for review.

### Step 12: Update GitHub Issues (Final Phase Only)

Only execute when ALL phases are complete and PR is created.

For each issue in `issues[]` (single: just one; group/epic: all issues):

1. **Add completion comment** (per Artifact Comment Protocol in shared/conventions.md):
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
   ralph_hero__save_issue
   - number: [issue-number]
   - workflowState: "__COMPLETE__"
   - command: "ralph_impl"
   ```

Note: PR auto-links via "Closes #NNN" in PR body. No explicit link attachment needed.

### Step 13: Team Result Reporting

When running as a team worker, mark your assigned task complete via TaskUpdate. Include key results in metadata (worktree path, test status, commit, files changed) and a human-readable summary in the description. Then check TaskList for more work matching your role.

### Step 14: Final Report

```
Implementation complete.

PR: [GitHub PR URL]
[List all issues with titles and "In Review" status]

Worktree preserved at: $GIT_ROOT/worktrees/[WORKTREE_ID]
Run ./scripts/remove-worktree.sh [WORKTREE_ID] after PR is merged.
```

---

## Address Mode (PR Review Feedback)

Activated when issue is "In Review" with an open PR (detected in Step 2).

**A1. Gather feedback**: `gh pr view [number] --json reviews,comments` + `gh api repos/$RALPH_GH_OWNER/$RALPH_GH_REPO/pulls/[number]/comments`. Skip resolved/outdated comments.

**A2. Classify** each comment:
- **MUST_FIX**: Explicit change requests
- **SHOULD_FIX**: Quality improvements
- **DISCUSS**: Reply only, no code change

**A3. Reuse worktree**: `GIT_ROOT=$(git rev-parse --show-toplevel) && cd "$GIT_ROOT/worktrees/GH-NNN" && git pull origin [branch-name]`

**A4. Address items** grouped by file: read, fix, verify (lint/tests).

**A5. Commit and push**:

Stage only files you modified to address feedback. Use the PR's existing file list as your staging constraint — files already in the PR diff plus any new files explicitly requested by reviewers.

```bash
git add <file1> <file2> ...
git commit -m "fix: address PR review feedback

- [change summaries]"
git push
```

Do NOT use `git add -A`, `git add .`, or `git add --all`.

**A6. Reply to PR comments**: Reply to each addressed item with change + commit ref. For DISCUSS items, reply with rationale. Post summary comment.

**A7. Report**: List MUST_FIX/SHOULD_FIX/DISCUSS counts resolved. Issue stays "In Review".

---

## Available Filter Profiles

| Profile | Expands To | Use Case |
|---------|-----------|----------|
| `builder-active` | `workflowState: "In Progress"` | Find active implementation work |

Profiles set default filters. Explicit params override profile defaults.

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
