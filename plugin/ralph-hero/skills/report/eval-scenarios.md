---
type: eval-scenarios
skill: report
date: 2026-04-25
---

# Eval Scenarios — report skill

These scenarios define grading criteria for the `report` skill. Each scenario specifies an Input, the Expected Behavior, and explicit Assertions a reviewer (human or automated grader) can check. Execution of these scenarios is tracked separately; this file is the rubric.

## Scenario A: ON_TRACK auto-status

### Input

User invokes the skill with no arguments:

```
/report
```

The pipeline contains a healthy mix: a few open issues in non-terminal states, several recently-completed Done items within the 7-day window, and at most one info-severity health warning. The `metrics` block is present in the dashboard response with `metrics.status === "ON_TRACK"` and `metrics.riskScore < 2`.

### Expected Behavior

1. Skill parses arguments (none) and defaults to: 7-day window, auto-determined status, post mode (not dry-run).
2. Skill calls `pipeline_dashboard` with `format: "json"`, `includeHealth: true`, `includeMetrics: true`, `doneWindowDays: 7`, `velocityWindowDays: 7`.
3. Metrics block is present, so the fallback path is NOT taken — `velocity`, `status`, `highlights`, `riskScore` come from `metrics`.
4. Skill composes a markdown report following the template, including a Pipeline Summary table, Velocity line, Health Indicators block, Highlights, and final `## Status: ON_TRACK` heading.
5. Skill calls `create_status_update` with `status: "ON_TRACK"` and `body: <composed markdown>`.
6. Skill prints success confirmation including status update ID.

### Assertions

- [ ] `create_status_update` is called exactly once with `status: "ON_TRACK"`.
- [ ] The composed markdown body contains all of: `# Project Status Report`, `## Pipeline Summary` table, `## Velocity` line, `## Health Indicators` block, `## Status: ON_TRACK`.
- [ ] The Auto-determination note appears (e.g., "Auto-determined from risk score (X)") and the score matches `metrics.riskScore`.
- [ ] No GH-139 reference appears in the agent's reasoning or output (the stale ticket reference must not leak through).
- [ ] Skill does not call any tool other than `pipeline_dashboard` and `create_status_update`.

## Scenario B: OFF_TRACK auto-status with multiple critical warnings

### Input

User invokes the skill with no arguments. The pipeline state has multiple critical-severity health warnings (e.g., 2x `lock_collision` plus 1x `oversized_in_pipeline`) and the `metrics.riskScore` is >= 6, so `metrics.status === "OFF_TRACK"`.

### Expected Behavior

1. Same parsing and dashboard-fetch as Scenario A.
2. `metrics.status === "OFF_TRACK"` is used directly.
3. Composed markdown includes all critical warnings under `## Health Indicators` with `[CRITICAL]` tags.
4. Final heading is `## Status: OFF_TRACK`.
5. `create_status_update` is called with `status: "OFF_TRACK"`.

### Assertions

- [ ] `create_status_update` is called with `status: "OFF_TRACK"`.
- [ ] Each critical warning appears in the report body with the `[CRITICAL]` severity tag.
- [ ] The `## Status: OFF_TRACK` line includes the auto-determination note with the actual `metrics.riskScore` value.
- [ ] Skill does not invent additional severity tags or rephrase the warning messages — they pass through from the dashboard verbatim.
- [ ] Empty pipeline phases are omitted from the Pipeline Summary table (the template instruction "Only include non-empty phases" is honored).

## Scenario C: --status override + --dry-run

### Input

User invokes the skill with both an explicit status override and dry-run mode:

```
/report --dry-run --status AT_RISK
```

The actual computed `metrics.status` would be `ON_TRACK`, but the user wants to override.

### Expected Behavior

1. Skill parses both `--dry-run` and `--status AT_RISK` from the argument string.
2. Skill calls `pipeline_dashboard` (same parameters as Scenario A — `--dry-run` does not skip the fetch, only the post).
3. Step 5 (Determine Final Status) uses the manual override `AT_RISK` instead of `metrics.status`.
4. Step 6 (Post or Display) takes the dry-run branch: displays the full composed report body, displays the determined status, prints "Dry run complete. No status update posted.", and STOPS.
5. `create_status_update` is **NOT** called.

### Assertions

- [ ] `create_status_update` is NOT called (verified via tool-call log inspection).
- [ ] Output contains the full composed markdown report (not just a summary).
- [ ] Final status heading reads `## Status: AT_RISK` and includes a "Manually set to AT_RISK" note (the manual-override branch of the template).
- [ ] Output ends with the literal string "Dry run complete. No status update posted."
- [ ] Skill correctly parses both flags from a single argument string (does not treat `--dry-run --status AT_RISK` as one token).
