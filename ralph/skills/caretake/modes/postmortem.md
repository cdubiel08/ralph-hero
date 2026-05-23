# `--mode postmortem`

Generate a structured post-mortem report at the end of a ralph team session. Collects task data via `TaskList` + `TaskGet`, classifies blockers and impediments, writes an Obsidian-ready doc, optionally patches associated plan documents with `post_mortem::` edges, and auto-creates GitHub issues for blockers.

```bash
export RALPH_SUBCOMMAND=postmortem
```

`postmortem-completeness.sh` (Stop hook) gates on `RALPH_SUBCOMMAND=postmortem` and verifies the written doc carries the required frontmatter + section headings.

## §Step 1: Collect session data

Call `TaskList` to get all tasks. For each task, call `TaskGet` to read full metadata and description. Extract:

- **Issues processed** — `issue_number`, `issue_url`, `estimate` from task metadata; final `workflowState` from the last integrator task result; PR number from the PR-creation task result.
- **Worker assignments** — task `owner` → task `subject` mapping.
- **Session events** — corrective actions, errors, notable observations from task descriptions / results.

If `TaskList` is unavailable or returns nothing, emit `POSTMORTEM SKIPPED no-session-data` and STOP.

## §Step 2: Find associated plans

For each issue number processed, glob for the associated plan document:

```
Glob: thoughts/shared/plans/*GH-{issue_number}*
```

Collect the filename stem (without `.md`) of each matched plan — this becomes the `builds_on::` target. If no plan is found, skip the link for that issue.

## §Step 3: Classify events

Apply these rules to the session events from §Step 1:

**Blocker** (goes in `## Blockers`, auto-creates a `process-improvement` issue):

- A recovery task was created during the session (NEEDS_ITERATION re-plan, failed-validation re-implement).
- A task result or description contains an explicit error, escalation, or Human Needed state.
- The team lead sent a corrective `SendMessage` to redirect a worker mid-task.

**Impediment** (goes in `## Impediments` only, no issue created):

- Workarounds that self-resolved without creating a new task.
- Slow-downs from idle message spam or delayed task unblocking.
- Plan gaps fixed inline without retry.
- Validation run against wrong path, self-corrected after a message.

### Step 3.5: Record outcome events

For each **blocker**: `event_type="blocker_recorded"`, `verdict="blocker"`, payload `{ blocker_type, description, created_issue_number }`.

For each **impediment**: `event_type="impediment_recorded"`, `verdict="impediment"`, payload `{ impediment_type, description, self_resolved, workaround }`.

If `knowledge_record_outcome` is unavailable, log to stderr and continue — do not block classification.

## §Step 4: Write post-mortem

Path: `thoughts/shared/reports/YYYY-MM-DD-ralph-team-{team-name}.md` (today's date).

Template:

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
|--------|-----------------|
{worker_rows}

## Blockers

{blocker_items or "None."}

## Impediments

{impediment_items or "None."}
```

Where:

- `{primary_issue_number}`: first issue number in the session (lowest if multiple).
- `{all_issue_numbers}`: comma-separated list.
- `{owner}` / `{repo}`: from `RALPH_GH_OWNER` / `RALPH_GH_REPO`, or extract from collected `issue_url`s.
- `{builds_on_links}`: one `- builds_on:: [[plan-slug]]` per plan found in §Step 2; omit content (keep heading) if none.
- Blocker items: `- [issue created: #NNN] Description of what failed and the retry cost`.
- Impediment items: `- Description of friction observed`.

`postmortem-completeness.sh` requires the frontmatter block, all `##` section headings, and a non-empty `## Blockers` and `## Impediments` body (`None.` is acceptable).

### Step 4.5: Record session_completed + postmortem_completed

After the report file is written, record:

- `event_type="session_completed"`, `issue_number=<primary>`, `verdict="completed"`, payload `{ issues_processed, issues_completed, workers, total_tokens }`.
- `event_type="postmortem_completed"`, `issue_number=<primary>`, `verdict="filed"`, payload `{ postmortem_path, blocker_count, impediment_count }`.

If either call fails, log to stderr and continue.

## §Step 5: Patch plan documents

For each plan found in §Step 2:

1. Read the plan file.
2. Find the `## Prior Work` section.
   - If present: append `- post_mortem:: [[{report-slug}]]` as the last line of that section.
   - If absent: insert `## Prior Work\n\n- post_mortem:: [[{report-slug}]]\n` immediately after `## Overview` (or as the first `##` section if `## Overview` is absent).
3. Write the updated content back.

`{report-slug}` is the filename stem of the post-mortem written in §Step 4 (without `.md`).

## §Step 6: Auto-create blocker issues

For each entry in `## Blockers` (skip if "None."):

- `title`: `process: {brief description of the blocker}`
- `body`: fuller description (what failed, retry cost, prevention).
- `labels`: `["process-improvement"]`
- `workflowState`: `"Backlog"`

Update the blocker entry to include the created issue number: `[issue created: #NNN]`.

## §Step 7: Drive push (iOS mode)

iOS-mode is active when `${TMPDIR:-/tmp}/ralph-ios-mode` exists OR when `RALPH_IOS_MODE` is non-empty. The `push-artifact.sh` helper checks both. Best-effort:

```bash
DRIVE_URL=$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/lib/push-artifact.sh" \
    "${REPORT_PATH}" \
    "Postmortem: ${SESSION_SUMMARY}" 2>/dev/null || true)
```

If `DRIVE_URL` is non-empty, include a `Drive: <URL>` line in any `## Postmortem` comment posted on blocker issues.

## §Step 8: Commit and push

```bash
git add thoughts/shared/reports/YYYY-MM-DD-ralph-team-{team-name}.md
git add thoughts/shared/plans/  # patched plan files
git commit -m "docs(report): {team-name} session post-mortem"
git push origin main
```

## §Step 9: Emit terminal token

```
POSTMORTEM <path>
```

Where `<path>` is the absolute path written in §Step 4. On the no-session-data short-circuit:

```
POSTMORTEM SKIPPED no-session-data
```

`postmortem-completeness.sh` greps the transcript for one of these tokens.

## §Constraints

- **Inline by design** — invoked at the end of a team session that still holds `TaskList` data. A forked invocation has no task list to work with.
- **Best-effort outcome recording.** All `knowledge_record_outcome` calls degrade silently if the tool is unavailable.
- **Auto-created blockers are XS** — they describe process improvements, not features; the size-gate accepts XS unconditionally.
- **Section heading invariants.** `postmortem-completeness.sh` verifies the frontmatter + all six `##` section headings (`Artifacts`, `Issues Processed`, `Worker Summary`, `Blockers`, `Impediments`).
