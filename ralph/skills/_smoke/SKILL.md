---
description: Plan-0 smoke test. Verifies cross-plugin MCP access. Deleted after verification.
allowed-tools:
  - Bash
  - mcp__plugin_ralph-hero_ralph-github__get_issue
---

# Smoke Test

Invoke `mcp__plugin_ralph-hero_ralph-github__get_issue` with `issue_number: 1` (or any known issue in the project).

If the call returns issue data, cross-plugin MCP works. If it errors with "tool not allowed" or "tool not found", the new ralph plugin cannot reach the old plugin's MCP server, and the migration plan needs adjustment (see spec risks section).

Report:
- The issue's title
- Whether the call succeeded
- Any error messages

After verification: delete this skill (`rm -rf ralph/skills/_smoke`) and recreate the commit.
