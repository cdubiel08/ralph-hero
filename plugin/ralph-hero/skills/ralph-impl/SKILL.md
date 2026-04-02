---
description: Autonomous implementation — executes ONE phase per invocation in an isolated worktree, then stops for resumability. Called by hero/team orchestrators, not directly by users. Also handles PR review feedback in Address Mode. Unlike the interactive impl skill (human verification pauses), this runs fully autonomously with strict hooks enforcing plan compliance, worktree isolation, and staging constraints.
user-invocable: false
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
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/drift-tracker.sh"
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-verify-commit.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-postcondition.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lock-release-on-failure.sh"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
  - Task
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

# Ralph GitHub Implement - Naive Hero Mode

You are a naive hero implementer. You pick ONE issue (or group of related issues), implement ONE phase, commit, and stop. Each invocation executes one phase, allowing resumption across context windows.

## Workflow

### Step 1: Select Implementation Target

**If issue number provided**: Fetch issue details
**If no issue number**: Pick highest-priority XS/Small issue in "In Progress" status

```
ralph_hero__list_issues
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
   - number: [issue-number]
   ```

2. **Find linked plan document**:

   **Knowledge graph shortcut**: If `knowledge_search` is available, try it first:
   ```
   knowledge_search(query="implementation plan GH-${number} [issue title keywords]", type="plan", limit=3)
   ```
   If a high-relevance result is returned, read that file directly and skip steps 1-8 below. If `knowledge_search` is not available or returns no results, continue with standard Artifact Comment Protocol discovery below.

   **Artifact shortcut**: If `--plan-doc` flag was provided in args and the file exists on disk, read it directly and skip steps 1-8 below. If the file does not exist, log `"Artifact flag path not found, falling back to discovery: [path]"` and continue with standard discovery.

   Find the plan using the Artifact Comment Protocol:
   1. Search issue comments for these headers (in priority order):
      a. `## Implementation Plan` or `## Group Implementation Plan` — direct plan ownership
      b. `## Plan Reference` — parent-planned atomic (backreference to parent plan + phase anchor)
   2. If multiple matches of same type, use the **most recent** (last) match.
   3. Extract the GitHub URL from the line after the header
   4. Convert to local path: strip `https://github.com/OWNER/REPO/blob/main/` prefix
   5. If resolved via `## Plan Reference`: extract phase anchor from URL (e.g., `#phase-1`), read parent plan, extract specific phase + `## Shared Constraints` section. Set `RALPH_PLAN_REFERENCE` env var.
   6. Read the plan document fully
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
   - **Phase selection (dependency-aware)**:
     1. Find all unchecked phases.
     2. For each unchecked phase, check its `- **depends_on**:` annotation.
     3. If `depends_on` is `null` or absent, the phase is **unblocked**.
     4. If `depends_on` references other phases (e.g., `[phase-1]`), check whether
        those referenced phases are complete (all automated verification items checked).
     5. Select the **first unblocked unchecked phase** (by phase number).
     6. If NO unchecked phase is unblocked, STOP and report:
        "All remaining phases have unsatisfied dependencies. Blocked on: [list]."
        The orchestrator will resume after blocking phases complete.
   - **Backward compat**: Phases without `depends_on` annotations are treated as
     sequential — Phase N depends on Phase N-1.

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

**Base branch detection**: If the task description or plan frontmatter contains a `base_branch` value (set by the team lead via stream detection), store it:
- `BASE_BRANCH_ARG="$base_branch"` (e.g., `feature/GH-42`)
- If no `base_branch` found: `BASE_BRANCH_ARG=""` (default to origin/main)

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
    "$GIT_ROOT/scripts/create-worktree.sh" "$WORKTREE_ID" "" "$BASE_BRANCH_ARG"
    cd "$WORKTREE_PATH"
fi
```

**6.3a. Rebase onto main if predecessor merged**

When `BASE_BRANCH_ARG` is set (stacked branch), check if the predecessor branch has been merged to main:
```bash
if [[ -n "$BASE_BRANCH_ARG" ]]; then
  git fetch origin main
  # Check if predecessor's commits are already in main
  if git merge-base --is-ancestor "origin/$BASE_BRANCH_ARG" origin/main 2>/dev/null; then
    echo "Predecessor branch $BASE_BRANCH_ARG merged to main. Rebasing..."
    git rebase origin/main
  fi
fi
```

This handles the case where the team lead created a stacked task but the predecessor merged before implementation started. The worktree was created from the predecessor branch, but since that's now in main, rebase to avoid a redundant merge base.

**6.4. Handle Merge Conflict Escalation**

If `git pull` fails with merge conflicts: use `__ESCALATE__` state, comment with conflicted files list, STOP.

**CRITICAL**: After `cd "$WORKTREE_PATH"`, ALL subsequent file operations (Read, Write, Edit, Bash)
must use paths relative to the worktree OR absolute paths within the worktree.
The impl-worktree-gate hook will BLOCK any Write/Edit outside the worktree directory.

### Step 6a: Multi-Repo Worktree Setup

If the research document includes a "Cross-Repo Scope" section:

1. **Identify repos:** Read the research doc's cross-repo scope to get the list of repos and their `localDir` paths.

2. **Create worktrees in each repo:**
   For each repo in the cross-repo scope:
   ```bash
   cd {localDir}
   git worktree add worktrees/GH-{issue_number} -b feature/GH-{issue_number}
   ```

   Example for GH-601 spanning ralph-hero and landcrawler-ai:
   ```
   ~/projects/ralph-hero/worktrees/GH-601/
   ~/projects/landcrawler-ai/worktrees/GH-601/
   ```

3. **Set `RALPH_WORKTREE_PATHS`:** Export a colon-separated list of all active worktree **absolute** paths (tilde expanded) so the impl-worktree-gate hook allows writes to any of them:
   ```bash
   # IMPORTANT: Expand ~ to absolute paths — the hook uses string prefix matching
   export RALPH_WORKTREE_PATHS="/home/user/projects/ralph-hero/worktrees/GH-601:/home/user/projects/landcrawler-ai/worktrees/GH-601"
   ```
   > **Tilde expansion:** `localDir` values in the registry may use `~`. Always expand to absolute paths before setting `RALPH_WORKTREE_PATHS`, since the hook compares against `file_path` which is always absolute.

4. **Pass worktree mapping to builder:** Include in the builder spawn prompt:
   ```
   Worktree directories:
   - ralph-hero: ~/projects/ralph-hero/worktrees/GH-601
   - landcrawler-ai: ~/projects/landcrawler-ai/worktrees/GH-601

   Make changes to each repo in its respective worktree directory.
   ```

**Single-repo (default):** If no cross-repo scope, behavior is unchanged — one worktree in the current repo.

### Step 6.5: Extract Tasks and Build Dependency Graph

Current phase = first **unblocked** unchecked phase from Step 5 (dependency-aware selection).

1. Parse the phase's `### Tasks` section for `#### Task N.M:` blocks
2. For each task, extract: `files`, `tdd`, `complexity`, `depends_on`, `acceptance`
3. Build dependency graph from `depends_on` fields
4. Identify parallel groups: tasks with `depends_on: null` AND no shared files

**Note on cross-phase task deps**: If a task has `depends_on: [1.3]` where `1.3` is in a different phase, this is informational within `ralph-impl` — the orchestrator (hero/team) handles cross-phase ordering by only dispatching `ralph-impl` once blocking phases are complete. `ralph-impl` only evaluates within-phase task dependencies.
5. Set `RALPH_TASK_FILES` env var to union of all task file paths

**If the phase has no `### Tasks` section** (legacy plan format): fall back to monolithic implementation — read phase requirements and implement directly without subagent dispatch. Skip Steps 7 and 7.5.

### Step 7: Task Execution Loop (Controller Pattern)

Announce: `Starting Phase [N]: #NNN - [Title] — [count] tasks, [parallel_count] parallelizable`

For each task group (parallel where independent, sequential where dependent):

**7a. Build context packet** — Read `implementer-prompt.md`, substitute:
- `{{TASK_DEFINITION}}` → full task block text
- `{{SHARED_CONSTRAINTS}}` → from plan header
- `{{DRIFT_LOG}}` → accumulated DRIFT: entries (or "None")
- `{{IF_TDD_TRUE/FALSE}}` → conditional sections based on task's tdd flag

**7b. Dispatch implementer subagent** — Model from complexity: low→haiku, medium→sonnet, high→opus.
```
Agent(subagent_type="general-purpose", model=selected, prompt=rendered, description="Implement task N.M: [name]")
```
For independent tasks: dispatch multiple `Agent()` calls in one turn.

**7c. Handle status:**
- `DONE` → proceed to review
- `DONE_WITH_CONCERNS` → evaluate, then review
- `NEEDS_CONTEXT` → provide context, re-dispatch
- `BLOCKED` → assess drift (minor: adapt+log, major: pause+escalate, weak model: upgrade once)
- Max 3 retries per task. After 3: escalate to Human Needed.

**7d. Dispatch task reviewer** — Read `task-reviewer-prompt.md`, substitute task spec + report + tdd flag.
```
Agent(subagent_type="general-purpose", model="haiku", prompt=rendered, description="Review task N.M")
```
- `COMPLIANT` → mark complete, next task
- `ISSUES` → implementer fixes, re-review (max 3 loops)

**7e. Update drift log** — Aggregate DRIFT: commits for phase summary.

### Step 7.5: Phase-Level Code Quality Review

After ALL tasks pass review:

1. `git diff [phase-start]..HEAD`
2. Read `phase-reviewer-prompt.md`, substitute phase overview + diff + constraints
3. `Agent(subagent_type="general-purpose", model="opus", prompt=rendered, description="Review phase N quality")`
4. `APPROVED` → proceed. `NEEDS_FIXES` → dispatch fix subagent (Critical blocks, Important gets fixed, Minor logged)
5. Post `## Phase N Review` comment on issue
6. Post `## Drift Log — Phase N` comment if drift occurred
7. Run phase success criteria (automated verification)
8. If fails: fix once, if still failing commit what works + STOP
9. If succeeds: mark plan checkboxes `- [x]`

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

5. **Multi-repo commits:** When changes span multiple repos, commit and push separately in each worktree. **Never use `git add -A` or `git add .`** — stage specific files only:

   ```bash
   # ralph-hero changes
   cd ~/projects/ralph-hero/worktrees/GH-601
   git add path/to/changed-file1.ts path/to/changed-file2.ts
   git commit -m "feat: [description of ralph-hero changes]"
   git push -u origin feature/GH-601

   # landcrawler-ai changes
   cd ~/projects/landcrawler-ai/worktrees/GH-601
   git add path/to/changed-file.ts
   git commit -m "feat: [description of landcrawler-ai changes]"
   git push -u origin feature/GH-601
   ```

6. Commit and push (single-repo):
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

1. **Add completion comment**:
   ```
   ralph_hero__create_comment
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
Worktree will be cleaned up automatically during merge.
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

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/escalation-steps.md

Use `command="ralph_impl"` in state transitions.

**Impl-specific triggers:**

| Situation | Action |
|-----------|--------|
| Merge conflict on git pull | Escalate: "Merge conflict in [files]. Cannot proceed automatically." |
| Plan phase verification fails twice | Escalate: "Phase [N] verification failing: [error]. Need guidance." |
| Unexpected files outside phase scope | Warn and skip; do not stage. Report in commit message. |

## Constraints

- ONE phase per invocation. XS/Small estimates only.
- Requires plan document (exit if none, except address mode)
- Follow plan exactly - no scope creep, no skipped verification
- PR only when ALL phases complete
- Always push after commit. Always update plan checkboxes.

## Link Formatting

**Single-repo (default):**

| Reference type | Format |
|---------------|--------|
| File only | `[path/file.py](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py)` |
| With line | `[path/file.py:42](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42)` |
| Line range | `[path/file.py:42-50](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42-L50)` |

**Cross-repo:** Resolve owner/repo from the registry entry for each file:
- `[repo-name:path/file.py](https://github.com/{owner}/{repo}/blob/main/path/file.py)`

When operating on a cross-repo issue, look up each file's repo in the registry to get the correct `owner` and repo name for link URLs. Do NOT hardcode `$RALPH_GH_OWNER/$RALPH_GH_REPO` for files in other repos.
