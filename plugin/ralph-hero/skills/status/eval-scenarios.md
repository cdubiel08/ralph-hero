---
type: eval-scenarios
skill: status
date: 2026-04-25
---

# Eval Scenarios — status skill

These scenarios define grading criteria for the `status` skill. Each scenario specifies an Input, the Expected Behavior, and explicit Assertions a reviewer (human or automated grader) can check. Execution of these scenarios is tracked separately; this file is the rubric.

## Scenario A: Markdown default render

### Input

User invokes the skill with no argument:

```
/status
```

The pipeline contains a typical mix of issues across multiple workflow phases (e.g., 3 in Backlog, 2 in In Progress, 1 in Done) with no critical health warnings.

### Expected Behavior

1. Skill parses no argument and defaults to `format: "markdown"`.
2. Skill calls `pipeline_dashboard` with `format: "markdown"`, `includeHealth: true`, `issuesPerPhase: 5`.
3. Skill displays the `formatted` field from the response unchanged.
4. No additional commentary beyond the rendered dashboard.

### Assertions

- [ ] Output contains a markdown table with columns for Phase, Count, Points, Issues.
- [ ] Output does NOT include a "Critical health warnings" section (none present in input).
- [ ] Output does NOT include free-form prose, summaries, or recommendations from the agent.
- [ ] At most 5 issue rows appear under any single phase (the `issuesPerPhase: 5` cap is honored at the MCP layer).
- [ ] No Bash or Read tool calls were attempted (only the `pipeline_dashboard` MCP tool was used).

## Scenario B: JSON format with explicit argument

### Input

User invokes the skill with the JSON format argument:

```
/status json
```

### Expected Behavior

1. Skill parses the argument as `format: "json"`.
2. Skill calls `pipeline_dashboard` with `format: "json"`, `includeHealth: true`, `issuesPerPhase: 5`.
3. Skill displays the structured JSON response (the `formatted` field is not the rendered markdown in JSON mode — the structured data takes its place).
4. No additional commentary.

### Assertions

- [ ] Output is valid JSON (or a markdown code block containing valid JSON).
- [ ] JSON contains top-level keys for phases, counts, and health (matching the dashboard schema).
- [ ] No prose narration of the JSON contents.

## Scenario C: Critical health warnings highlighted

### Input

User invokes the skill (no argument). The pipeline state includes at least one critical-severity health warning — for example, a `lock_collision` with two issues simultaneously in `In Progress` claimed by different agents.

### Expected Behavior

1. Skill parses no argument and defaults to `format: "markdown"`.
2. Skill calls `pipeline_dashboard` with the standard parameters.
3. Skill displays the `formatted` field.
4. Skill **adds** a prominent callout for the critical warnings (the only acknowledged exception to the "no commentary" rule).

### Assertions

- [ ] The critical warning text appears in the rendered output, either as part of the dashboard's health section or as a separate prominent callout.
- [ ] If the agent adds an explicit callout (e.g., a heading like `## Critical health warnings`), it summarizes the critical-severity items only (not warning or info-severity ones).
- [ ] The agent does NOT recommend remediation actions — surfacing the warning is sufficient. (Remediation belongs to `ralph-hygiene` or follow-up triage, not `status`.)
