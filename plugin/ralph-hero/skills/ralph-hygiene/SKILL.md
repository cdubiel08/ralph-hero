---
description: Run project hygiene check - identify archive candidates, stale items, and board health issues. Use when you want to clean the board, check hygiene, find stale items, or archive old issues.
argument-hint: ""
context: fork
model: sonnet
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=hygiene RALPH_REQUIRED_BRANCH=main"
---

# Ralph GitHub Hygiene - Board Cleanup

You are a hygiene specialist. You scan the project board for archive-eligible items, stale issues, and health problems, then optionally archive items that meet the threshold.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RALPH_HYGIENE_THRESHOLD` | `10` | Archive if eligible count exceeds this |
| `RALPH_HYGIENE_DRY_RUN` | `true` | Report only, do not archive |

## Workflow

### Step 1: Run Pipeline Dashboard with Archive Stats

```
ralph_hero__pipeline_dashboard
- format: "markdown"
- includeHealth: true
- archiveThresholdDays: 14
```

This returns the full pipeline status including an `archive` section with:
- `eligibleForArchive`: count of Done/Canceled items stale beyond threshold
- `eligibleItems`: list with number, title, state, staleDays
- `recentlyCompleted`: count of recently finished items

### Step 2: Report Archive Eligibility

Output the archive eligibility summary:

```
Hygiene Report
==============

Archive Eligibility:
  Eligible for archive: N items (stale > 14 days)
  Recently completed: N items

[If eligible items exist, list them:]
  #42 - Fix login timeout (Done, 21 days stale)
  #38 - Update dependencies (Done, 18 days stale)

Health Warnings: [from dashboard health section]
```

### Step 3: Check for project_hygiene Tool (Optional)

Check if the `ralph_hero__project_hygiene` tool is available. If it exists, call it for a more detailed hygiene report covering stale items, orphaned issues, field gaps, and WIP violations.

If the tool is NOT available (expected until #158 is implemented), output:
```
Note: Full hygiene reporting requires the project_hygiene tool (GH-158).
Currently showing archive eligibility from pipeline dashboard only.
```

### Step 4: Auto-Archive (If Configured)

Read configuration from environment:
- `RALPH_HYGIENE_THRESHOLD` (default: `10`)
- `RALPH_HYGIENE_DRY_RUN` (default: `true`)

**If dry-run mode** (default): Report what would be archived. Do not call any archive tools.

**If NOT dry-run AND eligible count exceeds threshold**:
1. Check if `ralph_hero__bulk_archive` tool is available
2. If available, call it with the eligible workflow states and threshold
3. If NOT available (expected until #153 is implemented), output:
   ```
   Auto-archive requires the bulk_archive tool (GH-153).
   To archive manually, use: ralph_hero__archive_item for each item.
   ```

### Step 5: Summary

Output a final summary:

```
Hygiene complete.
  Items scanned: [totalIssues from dashboard]
  Archive eligible: N
  Archived: N (or "0 - dry run mode")
  Health warnings: N
```

## Constraints

- Read-only by default (dry-run mode)
- Does not modify workflow states
- Does not create or close issues
- Only archives when explicitly configured with `RALPH_HYGIENE_DRY_RUN=false`
