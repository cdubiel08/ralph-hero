---
description: Implement an approved plan for a GitHub issue, phase by phase with manual verification pauses. Finds plan via Artifact Comment Protocol, sets up worktree, tracks progress. Use when you want to implement a planned issue interactively.
argument-hint: "<#NNN issue number or plan-path>"
model: opus
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - WebSearch
  - WebFetch
env:
  RALPH_GH_OWNER: "${RALPH_GH_OWNER}"
  RALPH_GH_REPO: "${RALPH_GH_REPO}"
  RALPH_GH_PROJECT_NUMBER: "${RALPH_GH_PROJECT_NUMBER}"
---

# Implement Plan

You are tasked with implementing an approved technical plan from `thoughts/shared/plans/`. These plans contain phases with specific changes and success criteria. You implement phase by phase, pausing for human verification between phases.

## Step 1: Parse Argument

When given an argument, resolve it to both a **plan file** and a **GitHub issue**:

**If argument matches `#NNN` or is a number** (e.g., `#348`, `348`):
1. Fetch the issue:
   ```
   ralph_hero__get_issue(number=NNN)
   ```
2. Search issue comments for `## Implementation Plan` header (use the **most recent** match if multiple)
3. Extract the GitHub URL from the first line after the header
4. Convert to local path: strip `https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/` prefix
5. If no comment found, fall back to glob:
   - `thoughts/shared/plans/*GH-${NNN}*`
   - `thoughts/shared/plans/*GH-$(printf '%04d' ${NNN})*`
   - If still not found, try group fallback: `thoughts/shared/plans/*group*GH-*` and check frontmatter for the issue number
   - If exactly one match, use it
   - If multiple matches, list them and ask user to specify
   - If no matches, error: "No plan found for #NNN. Create one with `/ralph-hero:create-plan`"
6. If found via glob fallback only, self-heal by posting the missing comment:
   ```
   ralph_hero__create_comment(number=NNN, body="## Implementation Plan\n\nhttps://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/[path]\n\n(Self-healed: artifact was found on disk but not linked via comment)")
   ```

**If argument is a file path**:
1. Verify file exists
2. Read frontmatter for `github_issue` or `github_issues` field
3. If issue exists, fetch it for status updates
4. If no issue linked, proceed without GitHub integration

## Step 2: Read and Understand the Plan

1. Read the plan document completely
2. Read the original issue and all files mentioned in the plan
3. **Read files fully** - never use limit/offset parameters, you need complete context
4. Check for any existing checkmarks (`- [x]`) to detect resumption
5. Identify the first unchecked phase - this is where to start
6. Build context: understand which issue(s) the plan covers (single `github_issue` or group `github_issues`)

## Step 3: Setup

### 3.1 Suggest Worktree (Optional)

Suggest setting up an isolated worktree for the implementation:

```
Would you like me to set up an isolated worktree for this implementation?

This will create a separate working directory so your main branch stays clean:
  scripts/create-worktree.sh GH-NNN

The worktree will be at: worktrees/GH-NNN/ (branch: feature/GH-NNN)

Or we can implement directly in the current directory if you prefer.
```

If the user agrees:
```bash
GIT_ROOT=$(git rev-parse --show-toplevel)
"$GIT_ROOT/scripts/create-worktree.sh" GH-NNN
cd "$GIT_ROOT/worktrees/GH-NNN"
```

If a worktree already exists at that path, reuse it:
```bash
cd "$GIT_ROOT/worktrees/GH-NNN"
git pull origin "$(git branch --show-current)" --no-edit
```

### 3.2 Transition to In Progress

If a linked issue exists and is not already "In Progress":

```
ralph_hero__update_workflow_state(number=NNN, state="In Progress", command="implement_plan")
```

### 3.3 Post Start Comment

```
ralph_hero__create_comment(number=NNN, body="## Implementation Started\n\nBeginning implementation of [plan title].")
```

## Step 4: Implement Phase by Phase

For each unchecked phase in the plan:

### 4.1 Read Phase Requirements
- Read the phase section from the plan
- Understand what files need to be created/modified
- Read all referenced files fully

### 4.2 Implement Changes
- Follow the plan's intent while adapting to what you find
- Implement each change specified in the phase
- Use sub-agents sparingly - mainly for targeted exploration of unfamiliar areas
- Do NOT pass `team_name` to any internal `Task()` calls (sub-agent team isolation per conventions)

### 4.3 Run Automated Verification
- Read the phase's success criteria for verification commands
- Run the automated checks specified in the plan
- Fix any issues before proceeding
- Update checkboxes in the plan file for automated items that pass: `- [ ]` → `- [x]`

### 4.4 Pause for Human Verification

After completing all automated verification for a phase, pause and inform the human:

```
Phase [N] Complete - Ready for Manual Verification

Automated verification passed:
- [List automated checks that passed]

Please perform the manual verification steps listed in the plan:
- [List manual verification items from the plan]

Let me know when manual testing is complete so I can proceed to Phase [N+1].
```

Do NOT check off manual verification items until confirmed by the user.

If instructed to execute multiple phases consecutively, skip the pause until the last phase.

### 4.5 Handle Mismatches

When things don't match the plan exactly:
- STOP and think deeply about why the plan can't be followed
- Present the issue clearly:
  ```
  Issue in Phase [N]:
  Expected: [what the plan says]
  Found: [actual situation]
  Why this matters: [explanation]

  How should I proceed?
  ```

## Step 5: Complete

When all phases are complete and verified:

### 5.1 Create PR

Create a pull request using `gh pr create`:

```bash
gh pr create --title "[Plan title or issue title]" --body "$(cat <<'EOF'
## Summary
Implements #NNN: [Title]

- Closes #NNN

## Changes
- [Bullet list of changes from plan]

## Test Plan
- [From plan document - automated verification + integration testing]

---
Generated with Claude Code (Ralph GitHub Plugin)
EOF
)"
```

PR body must use `Closes #NNN` syntax (bare `#NNN` per GitHub convention, not `GH-NNN`).

### 5.2 Transition to In Review

```
ralph_hero__update_workflow_state(number=NNN, state="In Review", command="implement_plan")
```

### 5.3 Post Completion Comment

```
ralph_hero__create_comment(number=NNN, body="## Implementation Complete\n\nPR: [PR URL]\nBranch: [branch-name]\n\nAll phases implemented and verified. Ready for code review.")
```

### 5.4 Report to User

```
Implementation complete for #NNN: [Title]

PR: [PR URL]
Issue: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
Status: In Review

Next steps:
- Review the PR
- Or iterate with /ralph-hero:iterate-plan
```

## Resuming Work

If the plan has existing checkmarks:
- Trust that completed work is done
- Pick up from the first unchecked item
- Verify previous work only if something seems off

## Implementation Philosophy

Plans are carefully designed, but reality can be messy. Your job is to:
- Follow the plan's intent while adapting to what you find
- Implement each phase fully before moving to the next
- Verify your work makes sense in the broader codebase context
- Update checkboxes in the plan as you complete sections

Remember: You're implementing a solution, not just checking boxes. Keep the end goal in mind and maintain forward momentum.

## Important Notes
- **CRITICAL**: You and all sub-agents are documentarians, not evaluators
- **File reading**: Always read mentioned files FULLY (no limit/offset) before implementing
- **Verification**: Read verification commands from the plan's success criteria - do not hardcode any specific commands
- **Frontmatter consistency**: Plan files use `github_issue`/`github_issues` frontmatter fields
- **Link formatting**: See `shared/conventions.md` for GitHub link format patterns
- **Sub-agent isolation**: Do NOT pass `team_name` to internal `Task()` calls
