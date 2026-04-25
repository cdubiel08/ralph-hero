---
type: eval-scenarios
skill: ralph-hygiene
date: 2026-04-25
---

# Eval Scenarios — ralph-hygiene skill

These scenarios define grading criteria for the `ralph-hygiene` skill. Each scenario specifies an Input, the Expected Behavior, and explicit Assertions a reviewer (human or automated grader) can check. Execution of these scenarios is tracked separately; this file is the rubric.

## Scenario A: Dry-run with archive candidates present

### Input

Orchestrator dispatches the skill with default configuration:

```
RALPH_HYGIENE_DRY_RUN=true (default)
RALPH_HYGIENE_THRESHOLD=10 (default)
RALPH_HYGIENE_WIP_LIMITS=<unset>
```

The project board contains a mix of items including 3 archive candidates (Done items more than 14 days old), 2 stale In-Progress items, 1 orphaned Backlog ticket, and no health warnings.

### Expected Behavior

1. Skill reads resolved configuration: dry_run=true, threshold=10, no wipLimits.
2. Skill calls `project_hygiene` with `format: "markdown"`, `archiveDays: 14`, `staleDays: 7`, `orphanDays: 14`, no `wipLimits`.
3. Skill reports the seven hygiene categories from the response. WIP category is reported as empty (or "skipped — RALPH_HYGIENE_WIP_LIMITS not set").
4. Skill calls `pipeline_dashboard` with `includeHealth: true`, finds no warnings, and omits the Health Warnings section.
5. Skill takes the dry-run branch in Step 4: does NOT call `archive_items`, reports "0 - dry run mode" in the archived count.
6. Skill outputs the final summary block.

### Assertions

- [ ] `project_hygiene` is called exactly once with `wipLimits` absent (NOT passed as `null` or `{}`).
- [ ] `pipeline_dashboard` is called exactly once with `includeHealth: true`.
- [ ] `archive_items` is NOT called.
- [ ] Output contains all seven hygiene category headings: Archive Candidates, Stale Items, Orphaned Items, Field Gaps, WIP Violations, Duplicate Candidates, Summary.
- [ ] WIP Violations section explicitly notes the unset `RALPH_HYGIENE_WIP_LIMITS` (does not silently report "0 violations").
- [ ] Final summary line contains "Archived: 0 - dry run mode".
- [ ] No GH-158 reference appears anywhere in the output (the stale fallback must not leak through).

## Scenario B: Auto-archive when threshold exceeded

### Input

Orchestrator dispatches with auto-archive enabled:

```
RALPH_HYGIENE_DRY_RUN=false
RALPH_HYGIENE_THRESHOLD=5
```

The project board has 12 archive-eligible items (Done/Canceled, more than 14 days stale).

### Expected Behavior

1. Skill calls `project_hygiene` and reports all sections (including 12 archive candidates).
2. Skill calls `pipeline_dashboard` for health warnings.
3. Step 4 evaluates: dry_run is "false" AND eligible count (12) exceeds threshold (5) — archive proceeds.
4. Skill calls `archive_items` in bulk mode with:
   - `workflowStates: ["Done", "Canceled"]`
   - `updatedBefore`: ISO date 14 days ago
   - `dryRun: false`
5. Skill reports archived count from the `archive_items` response in the final summary.

### Assertions

- [ ] `archive_items` is called exactly once with `dryRun: false`.
- [ ] The `workflowStates` argument is the array `["Done", "Canceled"]` (not a string).
- [ ] The `updatedBefore` argument is an ISO-format date string approximately 14 days before the run timestamp.
- [ ] Final summary "Archived: N" reflects the actual response count from `archive_items`, not the pre-call eligibility count.
- [ ] If threshold (5) is met but `archive_items` returns an error, skill surfaces the error and does NOT claim a successful archive in the summary.

## Scenario C: project_hygiene returns full report with WIP limits provided

### Input

Orchestrator dispatches with WIP limits set and a complex board:

```
RALPH_HYGIENE_DRY_RUN=true
RALPH_HYGIENE_WIP_LIMITS={"In Progress": 3, "In Review": 2}
```

The board has: 4 stale items, 2 orphaned tickets, 5 items missing estimate or priority, "In Progress" state contains 5 items (violates limit of 3), and 2 duplicate-candidate pairs detected.

### Expected Behavior

1. Skill parses `RALPH_HYGIENE_WIP_LIMITS` as JSON and passes the parsed object to `project_hygiene` as `wipLimits`.
2. `project_hygiene` returns all seven categories populated, including the WIP violation for "In Progress: 5 items (limit: 3)".
3. Skill reports each category with the actual data from the response — does not invent items, does not collapse near-empty sections.
4. Duplicate Candidates section lists the 2 pairs with title similarity scores (or just the pair listing).
5. Skill is dry-run, so no archive call is made.

### Assertions

- [ ] `project_hygiene` is called with `wipLimits` as a parsed object (NOT a JSON string).
- [ ] WIP Violations section in the output lists "In Progress: 5 items (limit: 3)" (or equivalent rendering from the tool response).
- [ ] All four populated categories (Stale, Orphaned, Field Gaps, Duplicates) appear in the report with the actual item counts.
- [ ] If `RALPH_HYGIENE_WIP_LIMITS` JSON parsing fails, skill surfaces the parse error and falls back to omitting `wipLimits` (does not crash, does not pass the raw string).
- [ ] Skill does not attempt to compute its own duplicate-detection logic — the pairs come from `project_hygiene` output.
