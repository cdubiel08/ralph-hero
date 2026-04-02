---
description: Create a pull request for a completed implementation — pushes branch, creates PR via gh, moves issues to In Review. Use when you want to create a PR for a completed issue.
user-invocable: false
argument-hint: <issue-number> [--worktree path]
context: fork
model: haiku
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=pr RALPH_VALID_OUTPUT_STATES='In Review,Human Needed'"
  PreToolUse:
    - matcher: "ralph_hero__save_issue|ralph_hero__advance_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/pr-state-gate.sh"
allowed-tools:
  - Read
  - Glob
  - Bash
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__advance_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

# Ralph PR

Create a pull request for a completed implementation and move issues to In Review.

## Step 1: Parse Arguments

Extract issue number and optional `--worktree` flag from args:

```
args: "NNN"                           -> issue_number=NNN, worktree=nil
args: "NNN --worktree path/to/dir"   -> issue_number=NNN, worktree=path
```

Export: `export RALPH_TICKET_ID="GH-NNN"`

## Step 2: Fetch Issue

```
ralph_hero__get_issue(number=NNN)
```

Get issue title, state, group context, and sub-issues.

## Step 3: Determine Worktree and Branch

If `--worktree` was provided, use that path directly.

Otherwise, check `worktrees/GH-NNN` relative to the git root.

For group issues (with sub-issues), use the primary issue number for the branch name.

Branch name: `feature/GH-NNN`

If no worktree exists, output an error and stop.

## Step 3a: Multi-Repo PR Detection

If the issue has cross-repo scope (multiple worktrees exist for this issue):

1. **Detect repos from worktrees:** Read `.ralph-repos.yml` from the repo root. For each repo with a `localDir`, check for worktrees:
   ```bash
   for repo_dir in {registry localDir paths}; do
     if [[ -d "$repo_dir/worktrees/GH-${ISSUE_NUMBER}" ]]; then
       echo "Found worktree in $(basename $repo_dir)"
     fi
   done
   ```

2. **Create one PR per repo:** For each repo with a worktree:
   ```bash
   cd {repo_localDir}/worktrees/GH-{issue_number}
   git push -u origin feature/GH-{issue_number}
   gh pr create --repo {owner}/{repo} \
     --title "GH-{issue_number}: {title}" \
     --body "$(cat <<'PREOF'
   ## Summary
   {summary for this repo}

   ## Cross-Repo Context
   This PR is part of GH-{issue_number}. Related PRs:
   - {other_repo} PR #{other_pr_number} ({upstream|downstream}, merge {first|after})

   Closes #{issue_number}
   PREOF
   )"
   ```

3. **Cross-reference PRs:** After creating all PRs, edit each PR body to include links to the other PRs. The merge order comes from the `dependency-flow` in the registry pattern.

**Single-repo (default):** If only one worktree exists, behavior is unchanged — continue to Step 4.

### Link Formatting in PR Bodies

When creating cross-repo PR bodies, resolve the correct owner/repo for each link:
- Links to files in the current repo: use the current repo's owner/name
- Links to files in other repos: look up the owner/name from the registry entry
- Links to related PRs: `https://github.com/{owner}/{repo}/pull/{number}`

## Step 4: Push Branch

From the worktree directory:

```bash
git push -u origin feature/GH-NNN
```

If push fails, report the error and stop.

## Step 5: Create Pull Request

```bash
gh pr create \
  --title "GH-NNN: [issue title]" \
  --body "## Summary

[Brief description from issue]

Closes #NNN" \
  --head feature/GH-NNN \
  --base main
```

For group issues, include `Closes #NNN` for each sub-issue in the body.

Capture the PR URL from the output.

## Step 6: Move Issues to In Review

```
ralph_hero__advance_issue(direction="children", number=NNN, targetState="In Review")
```

Or for a standalone issue:

```
ralph_hero__save_issue(number=NNN, workflowState="In Review", command="ralph_pr")
```

## Step 7: Post Comment

Post a comment on the issue with the PR URL:

```
ralph_hero__create_comment(number=NNN, body="## Pull Request\n\nPR created: [PR URL]\n\nIssue moved to In Review.")
```

## Step 8: Report Result

Output the PR URL for the caller:

```
PR CREATED
Issue: #NNN
PR: https://github.com/owner/repo/pull/NNN
State: In Review
```
