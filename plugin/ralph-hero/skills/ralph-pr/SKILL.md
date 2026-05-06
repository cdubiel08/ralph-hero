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
    - matcher: "ralph_hero__save_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/pr-state-gate.sh"
allowed-tools:
  - Read
  - Glob
  - Bash
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues
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
args: "NNN --worktree path/to/dir"    -> issue_number=NNN, worktree=path
args: ""                              -> issue_number=nil, queue-pick (see below)
```

Export: `export RALPH_TICKET_ID="GH-NNN"`

**If no issue number** is provided, run the queue-picking branch:

1. Query `list_issues(workflowState: "In Progress", limit: 10)` for candidates whose implementation has completed.
2. For each candidate (in returned order), check BOTH conditions:
   - `worktrees/GH-NNN` exists relative to the git root (`git rev-parse --show-toplevel`).
   - No open PR exists for the candidate's branch:
     ```bash
     gh pr list --head feature/GH-NNN --json number --jq '.[0]'
     ```
     A `null` (or empty) result means no PR exists yet — eligible.
3. The first candidate matching BOTH conditions is the selected issue.
4. If no candidate matches, output the literal line and STOP:

   ```
   Queue empty.
   ```

   This is the token the loop runner greps for to detect an empty PR queue (`grep -qiE "Queue empty|Triage complete"`).
5. Otherwise, set `issue_number` to the selected candidate and continue with Step 2 as if the number had been passed in as an argument.

This branch mirrors the queue-picking pattern in `ralph-impl/SKILL.md` Step 1 so the loop runner can invoke `just pr` argument-less.

## Step 2: Fetch Issue

Fetch the full issue details for issue NNN.

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

Build the PR body using the enriched template below. The template reads the plan document (located via Artifact Comment Protocol — see Step 2 issue comments for `## Implementation Plan` link) so reviewers (human and the `code-review` skill) have full context.

```bash
gh pr create \
  --title "GH-NNN: [issue title]" \
  --body "$(cat <<'PREOF'
## Summary

[1-3 sentences describing what this PR does, sourced from the issue body or plan Overview.]

## Plan

[Link to the implementation plan, e.g.: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/plans/YYYY-MM-DD-GH-NNN-*.md]

Phases shipped: N of M (group issues only — omit for standalone)

## Test plan

- [ ] Automated verification per plan Success Criteria
- [ ] Manual verification per plan Success Criteria
- [ ] Cross-phase integration check (multi-phase plans only)

[Replace bullets with the actual checklist items from the plan's Success Criteria sections.]

Closes #NNN
[For group issues, add one Closes line per sub-issue:]
[Closes #NNN_child1]
[Closes #NNN_child2]
PREOF
)" \
  --head feature/GH-NNN \
  --base main
```

For group issues, include `Closes #NNN` for each sub-issue in the body. Determine sub-issues via `list_sub_issues` (see Step 6).

Capture the PR URL from the output. If `gh pr create` returns malformed output (no URL on stdout), report the failure and stop — do not silently continue.

> **Follow-up**: The Link Formatting in PR Bodies subsection in Step 3a duplicates the Link Formatting table in ralph-merge and ralph-impl. Extraction to a shared fragment is tracked in #840 — do not extract here.

## Step 6: Move Issues to In Review

Determine whether the issue is **standalone** or **group** before advancing:

```
list_sub_issues(number=NNN)
```

- **Standalone** (no children): update the issue's own workflow state to "In Review" via `save_issue` with `command: "ralph_pr"`.
- **Group** (has children): advance every child returned by `list_sub_issues` to "In Review" via `save_issue`. Do NOT also advance the parent here — parent advancement is handled server-side by the `advance-parent` workflow when children reach the gate state.

## Step 7: Post Comment

Post a comment on the issue with the PR URL:
```markdown
## Pull Request

PR created: [PR URL]

Issue moved to In Review.
```

## Step 8: Report Result

Output the PR URL for the caller:

```
PR CREATED
Issue: #NNN
PR: https://github.com/owner/repo/pull/NNN
State: In Review
```
