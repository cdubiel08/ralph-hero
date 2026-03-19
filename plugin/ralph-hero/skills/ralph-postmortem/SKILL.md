---
description: Generate a structured post-mortem report at the end of a ralph-team session. Collects task data, classifies blockers and impediments, writes Obsidian-ready report with frontmatter, patches plan documents with post_mortem:: edges, and auto-creates GitHub issues for blockers. Invoked inline by the team skill — not as a sub-agent.
allowed-tools:
  - TaskList
  - TaskGet
  - Glob
  - Read
  - Edit
  - Write
  - Bash
  - ralph_hero__create_issue
---

# Ralph Post-Mortem

Generate a complete, Obsidian-ready post-mortem report for a ralph-team session.

## Step 1: Collect Session Data

Call `TaskList` to get all tasks. For each task, call `TaskGet` to read full metadata and description.

Extract:
- **Issues processed**: `issue_number`, `issue_url`, `estimate` from task metadata; final `workflowState` from the last integrator task result; PR number from the PR creation task result
- **Worker assignments**: task `owner` → task `subject` mapping
- **Session events**: any corrective actions, errors, or notable observations recorded in task descriptions or results

## Step 2: Find Associated Plans

For each issue number processed, glob for the associated plan document:

```
Glob: thoughts/shared/plans/*GH-{issue_number}*
```

Collect the filename stem (without `.md`) of each matched plan — this becomes the `builds_on::` target.

If no plan is found for an issue (e.g., the session started at Plan in Review and the plan predates the glob pattern), skip the `builds_on::` link for that issue.

## Step 3: Classify Events

Review the session events collected in Step 1. Apply these rules:

**Blocker** (goes in `## Blockers`, auto-creates an issue):
- A recovery task was created during the session (NEEDS_ITERATION re-plan, failed-validation re-implement path)
- A task result or description contains an explicit error, escalation, or Human Needed state
- You sent a corrective `SendMessage` to redirect a worker mid-task

**Impediment** (goes in `## Impediments` only, no issue created):
- Workarounds that self-resolved without creating a new task
- Slow-downs from idle message spam or delayed task unblocking
- Plan gaps fixed inline without retry
- Validation run against wrong path, self-corrected after a message

## Step 4: Write Post-Mortem

Write to `thoughts/shared/reports/YYYY-MM-DD-ralph-team-{team-name}.md` using today's date.

Use this exact template:

```markdown
---
date: YYYY-MM-DD
type: report
status: completed
tags: [ralph-team, session-report]
team_name: {team-name}
github_issue: {primary_issue_number}
github_issues: [{all_issue_numbers}]
github_urls:
  - https://github.com/{owner}/{repo}/issues/{primary_issue_number}
---

# Ralph Team Session Report: {team-name}

**Date**: YYYY-MM-DD

## Artifacts

{builds_on_links}

## Issues Processed

| Issue | Title | Estimate | Outcome | PR |
|-------|-------|----------|---------|-----|
{issues_table_rows}

## Worker Summary

| Worker | Tasks Completed |
|--------|----------------|
{worker_rows}

## Blockers

{blocker_items or "None."}

## Impediments

{impediment_items or "None."}

## Notes

{any other notable observations, or omit section if nothing to add}
```

Where:
- `{primary_issue_number}`: the first issue number in the session (lowest number if multiple)
- `{all_issue_numbers}`: comma-separated list of all issue numbers, e.g. `[611, 612]`
- `{builds_on_links}`: one `- builds_on:: [[plan-slug]]` per plan found in Step 2; omit section content (but keep heading) if no plans found
- Blocker items: `- [issue created: #NNN] Description of what failed and the retry cost`
- Impediment items: `- Description of friction observed`
- `## Notes` section is optional — include only if there is content beyond what's in Blockers/Impediments

## Step 5: Patch Plan Documents

For each plan document found in Step 2:

1. Read the plan file
2. Find the `## Prior Work` section
   - If present: append `- post_mortem:: [[{report-slug}]]` as the last line of that section
   - If absent: insert `## Prior Work\n\n- post_mortem:: [[{report-slug}]]\n` immediately after the `## Overview` heading, or as the first `##` section if `## Overview` is absent
3. Write the updated content back

Where `{report-slug}` is the filename stem of the newly written post-mortem (without `.md`).

## Step 6: Auto-Create Blocker Issues

For each entry in `## Blockers` (skip if "None."):

Call `ralph_hero__create_issue` with:
- `title`: `process: {brief description of the blocker}`
- `body`: fuller description of what failed, what the retry cost was, and what improvement would prevent recurrence
- `workflowState`: `"Backlog"`

Update the blocker entry in the post-mortem to include the created issue number: `[issue created: #NNN]`

## Step 7: Commit and Push

```bash
git add thoughts/shared/reports/YYYY-MM-DD-ralph-team-{team-name}.md
git add thoughts/shared/plans/  # patched plan files
git commit -m "docs(report): {team-name} session post-mortem"
git push origin main
```

Return to the team lead with a summary: post-mortem path, issue numbers created (if any), plans patched.
