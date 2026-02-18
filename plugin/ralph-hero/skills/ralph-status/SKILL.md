---
description: Display pipeline status dashboard with health indicators. Shows issue counts per workflow phase, identifies stuck issues, WIP violations, and blocked dependencies. First read-only skill - no state changes.
argument-hint: "[optional: markdown|ascii|json]"
model: haiku
env:
  RALPH_COMMAND: "status"
---

# Ralph Pipeline Status

Display the current pipeline status dashboard.

## Usage

Call the `ralph_hero__pipeline_dashboard` tool with the requested format:

1. Parse the argument (if provided) as the output format. Default to `markdown`.
2. Call `ralph_hero__pipeline_dashboard` with:
   - `format`: parsed format or `"markdown"`
   - `includeHealth`: true
3. Display the `formatted` field (for markdown/ascii) or the structured data (for json).
4. If health warnings exist with severity `critical`, highlight them prominently.

## Output

Display the dashboard output directly. Do not add additional commentary unless there are critical health warnings.
