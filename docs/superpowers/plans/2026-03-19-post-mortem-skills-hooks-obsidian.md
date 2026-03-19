# Post-Mortem Skills, Hooks & Obsidian Config — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the `ralph-postmortem` skill, update the team skill's shutdown section, add a completeness hook, and add `type:report` color coding to the Obsidian setup skill.

**Architecture:** Four targeted changes to `plugin/ralph-hero/` (new skill, team skill update, new hook script) plus one change to `plugin/ralph-knowledge/` (Obsidian setup skill). No TypeScript compilation needed — these are markdown skills and bash scripts.

**Tech Stack:** Markdown (skill frontmatter), Bash, YAML skill hooks, JSON (Obsidian config)

**Spec:** `docs/superpowers/specs/2026-03-19-post-mortem-obsidian-feedback-loop-design.md`

**Prerequisite:** Complete `docs/superpowers/plans/2026-03-19-post-mortem-knowledge-parser.md` first — the `post_mortem` relationship type must be in `parser.ts` before the skill can write documents that use it.

---

## File Map

| File | Role | Change |
|------|------|--------|
| `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md` | New skill | Create |
| `plugin/ralph-hero/skills/team/SKILL.md` | Team orchestrator | Update allowed-tools + shutdown section + hook registration |
| `plugin/ralph-hero/hooks/scripts/team-postmortem-completeness.sh` | New hook | Create |
| `plugin/ralph-knowledge/skills/setup-obsidian/SKILL.md` | Obsidian setup | Add `type:report` color group |

---

## Task 1: Create `ralph-postmortem` skill

**Files:**
- Create: `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md`

This skill is invoked inline by the team lead at shutdown. It does not run as a sub-agent. It collects session data, classifies blockers vs. impediments, writes the post-mortem, patches plan documents, and auto-creates blocker issues.

- [ ] **Step 1: Create skill directory and file**

```bash
mkdir -p plugin/ralph-hero/skills/ralph-postmortem
```

Create `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md`:

```markdown
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
```

- [ ] **Step 2: Verify file was created**

```bash
ls plugin/ralph-hero/skills/ralph-postmortem/SKILL.md
```

Expected: file exists

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-postmortem/SKILL.md
git commit -m "feat(ralph-hero): add ralph-postmortem skill for Obsidian-ready session reports"
```

---

## Task 2: Update `team/SKILL.md` — allowed-tools, shutdown section, hook registration

**Files:**
- Modify: `plugin/ralph-hero/skills/team/SKILL.md`

Three targeted edits.

- [ ] **Step 1: Add `ralph_hero__create_issue` to allowed-tools**

In `plugin/ralph-hero/skills/team/SKILL.md` lines 5–22, add `ralph_hero__create_issue` to the `allowed-tools` list (after `ralph_hero__pick_actionable_issue`):

```yaml
  - ralph_hero__pick_actionable_issue
  - ralph_hero__create_issue    # ← add this line
```

- [ ] **Step 2: Replace the Shut Down section**

Replace lines 207–255 (the `## Shut Down` → `### 1. Write Post-Mortem` block through the commit/push block) with:

```markdown
## Shut Down

When all tasks are complete:

### 1. Write Post-Mortem

Invoke the `ralph-hero:ralph-postmortem` skill. It handles:
- Data collection from TaskList/TaskGet
- Blocker vs. impediment classification
- Writing the Obsidian-ready report with full frontmatter
- Patching plan documents with `post_mortem::` edges
- Auto-creating GitHub issues for blockers
- Committing and pushing the report

### 2. Shut Down Teammates

Send shutdown to each teammate. Wait for all to confirm.

### 3. Delete Team

Call `TeamDelete()`. This removes the task list and team config.
```

- [ ] **Step 3: Register the new completeness hook**

In the `PreToolUse` hooks block of `team/SKILL.md` (lines 28–40), add the new hook after the existing `TeamDelete` matcher:

```yaml
    - matcher: "TeamDelete"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/team-shutdown-validator.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/team-postmortem-completeness.sh"
```

Note: both hooks fire on `TeamDelete`. They run in order — existence check first, completeness check second.

- [ ] **Step 4: Verify the frontmatter parses correctly**

```bash
head -50 plugin/ralph-hero/skills/team/SKILL.md
```

Visually confirm: `ralph_hero__create_issue` is in `allowed-tools`, both hooks are under the `TeamDelete` matcher.

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/skills/team/SKILL.md
git commit -m "feat(ralph-hero): update team skill — ralph-postmortem invocation, completeness hook, create_issue permission"
```

---

## Task 3: Create `team-postmortem-completeness.sh` hook

**Files:**
- Create: `plugin/ralph-hero/hooks/scripts/team-postmortem-completeness.sh`

This hook fires on `TeamDelete` when `RALPH_COMMAND=team`. It checks exactly one thing: the post-mortem file has required frontmatter fields and body sections. It delegates file-existence checking entirely to `team-shutdown-validator.sh`.

- [ ] **Step 1: Read `team-shutdown-validator.sh` to understand the file-finding pattern**

```bash
cat plugin/ralph-hero/hooks/scripts/team-shutdown-validator.sh
```

Note the `find` commands at lines 41 and 46 — replicate the same logic to locate the post-mortem file.

- [ ] **Step 2: Read `hook-utils.sh` to understand available helpers**

```bash
cat plugin/ralph-hero/hooks/scripts/hook-utils.sh
```

Note: `read_input`, `get_tool_name`, `get_project_root`, and `block` are available.

- [ ] **Step 3: Create the hook script**

```bash
cat > plugin/ralph-hero/hooks/scripts/team-postmortem-completeness.sh << 'SCRIPT'
#!/bin/bash
# ralph-hero/hooks/scripts/team-postmortem-completeness.sh
# PreToolUse: Validate post-mortem content before TeamDelete
#
# Checks that the post-mortem file contains required frontmatter fields
# and body sections. File existence is checked by team-shutdown-validator.sh
# which runs first — this hook assumes the file exists.
#
# Only active when RALPH_COMMAND=team.
#
# Exit codes:
#   0 - All required content present, or not in team command context
#   2 - Missing required fields/sections, block TeamDelete

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Only enforce for team command
if [[ "${RALPH_COMMAND:-}" != "team" ]]; then
  exit 0
fi

read_input > /dev/null
TOOL=$(get_tool_name)

if [[ "$TOOL" != "TeamDelete" ]]; then
  exit 0
fi

PROJECT_ROOT=$(get_project_root)
REPORTS_DIR="${PROJECT_ROOT}/thoughts/shared/reports"
TEAM_MARKER="/tmp/ralph-team-created-$(echo "$(get_project_root)" | md5sum | cut -d' ' -f1)"
TODAY=$(date +%Y-%m-%d)

# Locate the post-mortem file (same logic as team-shutdown-validator.sh)
POSTMORTEM=""
if [[ -d "$REPORTS_DIR" ]]; then
  if [[ -f "$TEAM_MARKER" ]]; then
    POSTMORTEM=$(find "$REPORTS_DIR" -name "*ralph-team*" -newer "$TEAM_MARKER" -type f 2>/dev/null | head -1)
  fi
  if [[ -z "$POSTMORTEM" ]]; then
    POSTMORTEM=$(find "$REPORTS_DIR" -name "${TODAY}-ralph-team*" -type f 2>/dev/null | head -1)
  fi
fi

# If no file found, team-shutdown-validator.sh will block — exit cleanly here
if [[ -z "$POSTMORTEM" ]]; then
  exit 0
fi

# Check required frontmatter fields
MISSING_FIELDS=()
for field in "type:" "status:" "github_issue:" "team_name:"; do
  if ! grep -q "^${field}" "$POSTMORTEM" 2>/dev/null; then
    MISSING_FIELDS+=("$field")
  fi
done

# Check required body sections
MISSING_SECTIONS=()
for section in "## Artifacts" "## Blockers" "## Impediments" "## Issues Processed" "## Worker Summary"; do
  if ! grep -qF "$section" "$POSTMORTEM" 2>/dev/null; then
    MISSING_SECTIONS+=("$section")
  fi
done

# Build error message if anything is missing
if [[ ${#MISSING_FIELDS[@]} -gt 0 || ${#MISSING_SECTIONS[@]} -gt 0 ]]; then
  MSG="Post-mortem at ${POSTMORTEM} is incomplete.\n\n"
  if [[ ${#MISSING_FIELDS[@]} -gt 0 ]]; then
    MSG+="Missing frontmatter fields:\n"
    for f in "${MISSING_FIELDS[@]}"; do
      MSG+="  - ${f}\n"
    done
    MSG+="\n"
  fi
  if [[ ${#MISSING_SECTIONS[@]} -gt 0 ]]; then
    MSG+="Missing body sections:\n"
    for s in "${MISSING_SECTIONS[@]}"; do
      MSG+="  - ${s}\n"
    done
    MSG+="\n"
  fi
  MSG+="Regenerate using the ralph-hero:ralph-postmortem skill."
  block "$MSG"
fi

exit 0
SCRIPT
chmod +x plugin/ralph-hero/hooks/scripts/team-postmortem-completeness.sh
```

- [ ] **Step 4: Verify the script is executable and syntactically valid**

```bash
bash -n plugin/ralph-hero/hooks/scripts/team-postmortem-completeness.sh && echo "Syntax OK"
ls -la plugin/ralph-hero/hooks/scripts/team-postmortem-completeness.sh
```

Expected: "Syntax OK", file is executable (`-rwxr-xr-x`)

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/hooks/scripts/team-postmortem-completeness.sh
git commit -m "feat(ralph-hero): add team-postmortem-completeness.sh hook for content validation"
```

---

## Task 4: Add `type:report` color group to Obsidian setup

**Files:**
- Modify: `plugin/ralph-knowledge/skills/setup-obsidian/SKILL.md`

The current `graph.json` template in the setup-obsidian skill has color groups for `research`, `plan`, and `idea` but not `report` or `spec`. Add both.

- [ ] **Step 1: Read the current colorGroups block**

In `plugin/ralph-knowledge/skills/setup-obsidian/SKILL.md` around line 49–58, the current `graph.json` template is:

```json
{
  "colorGroups": [
    { "query": "path:_", "color": { "a": 1, "rgb": 8421504 } },
    { "query": "tag:#research OR type:research", "color": { "a": 1, "rgb": 4474111 } },
    { "query": "tag:#plan OR type:plan", "color": { "a": 1, "rgb": 4487360 } },
    { "query": "tag:#idea OR type:idea", "color": { "a": 1, "rgb": 16761095 } }
  ]
}
```

- [ ] **Step 2: Add report and spec color groups**

Replace the `colorGroups` array with:

```json
{
  "colorGroups": [
    { "query": "path:_", "color": { "a": 1, "rgb": 8421504 } },
    { "query": "tag:#research OR type:research", "color": { "a": 1, "rgb": 4474111 } },
    { "query": "tag:#plan OR type:plan", "color": { "a": 1, "rgb": 4487360 } },
    { "query": "tag:#idea OR type:idea", "color": { "a": 1, "rgb": 16761095 } },
    { "query": "type:report", "color": { "a": 1, "rgb": 16744272 } },
    { "query": "type:spec", "color": { "a": 1, "rgb": 12517631 } }
  ]
}
```

Color choices (consistent with existing palette):
- `report`: `16744272` — warm amber (distinct from plan green and research blue)
- `spec`: `12517631` — purple (distinct from all existing colors)

- [ ] **Step 3: Also update the `.obsidian/graph.json` file if it already exists in the vault**

```bash
GRAPH_JSON="thoughts/.obsidian/graph.json"
if [[ -f "$GRAPH_JSON" ]]; then
  echo "graph.json exists — update it manually or re-run /ralph-knowledge:setup-obsidian"
fi
```

If the file exists, apply the same colorGroups update to it directly. If it doesn't exist yet, it will be created correctly when `setup-obsidian` is next run.

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-knowledge/skills/setup-obsidian/SKILL.md
git commit -m "feat(ralph-knowledge): add report and spec color groups to Obsidian graph config"
```

---

## Task 5: Final integration check

- [ ] **Step 1: Verify skill file structure**

```bash
ls plugin/ralph-hero/skills/ralph-postmortem/
# Expected: SKILL.md

grep "ralph_hero__create_issue" plugin/ralph-hero/skills/team/SKILL.md
# Expected: shows the line in allowed-tools

grep "team-postmortem-completeness" plugin/ralph-hero/skills/team/SKILL.md
# Expected: shows the hook registration line

grep "ralph-postmortem" plugin/ralph-hero/skills/team/SKILL.md
# Expected: shows the skill invocation in the Shut Down section
```

- [ ] **Step 2: Verify hook structure**

```bash
grep "MISSING_FIELDS\|MISSING_SECTIONS\|block" plugin/ralph-hero/hooks/scripts/team-postmortem-completeness.sh
# Expected: shows the validation and block logic

bash -n plugin/ralph-hero/hooks/scripts/team-postmortem-completeness.sh && echo "Syntax OK"
# Expected: Syntax OK
```

- [ ] **Step 3: Verify Obsidian color groups**

```bash
grep "type:report\|type:spec" plugin/ralph-knowledge/skills/setup-obsidian/SKILL.md
# Expected: two matching lines
```

- [ ] **Step 4: Push all changes**

```bash
git push
```
