---
date: 2026-03-25
topic: "userConfig manifest schema validation errors in plugin.json"
tags: [research, plugin-manifest, userConfig, validation]
status: complete
type: research
---

# Research: userConfig manifest schema validation errors

## Research Question

PR #689 introduced a `userConfig` block to `plugin.json` for secure token storage. After merging, the plugin fails validation with two errors:

```
userConfig.github_token.type: Invalid option: expected one of "string"|"number"|"boolean"|"directory"|"file"
userConfig.github_token.title: Invalid input: expected string, received undefined
```

What is the correct schema for `userConfig` entries?

## Summary

The `userConfig` entry in `plugin.json` has three required fields: `title`, `type`, and `description`. The current definition only has `description` and `sensitive`, missing the two required fields. The fix is adding `"type": "string"` and `"title": "GitHub Token"` to the entry.

## Detailed Findings

### Current (broken) plugin.json userConfig

```json
"userConfig": {
  "github_token": {
    "description": "GitHub Personal Access Token with 'repo' and 'project' scopes...",
    "sensitive": true
  }
}
```

### Required userConfig entry schema

| Field         | Type    | Required | Description                                                                 |
|---------------|---------|----------|-----------------------------------------------------------------------------|
| `title`       | string  | **Yes**  | Human-readable label shown in `claude plugin configure` prompts             |
| `type`        | string  | **Yes**  | One of: `"string"`, `"number"`, `"boolean"`, `"directory"`, `"file"`        |
| `description` | string  | **Yes**  | Explanation text shown to user                                              |
| `sensitive`   | boolean | No       | If `true`, stored in system keychain (macOS) or `~/.claude/.credentials.json` (Linux). Defaults to `false` |

### Corrected plugin.json userConfig

```json
"userConfig": {
  "github_token": {
    "title": "GitHub Token",
    "type": "string",
    "description": "GitHub Personal Access Token with 'repo' and 'project' scopes...",
    "sensitive": true
  }
}
```

### How userConfig values flow

1. User runs `claude plugin configure ralph-hero`
2. Claude Code prompts for each `userConfig` field using `title` as the label
3. Sensitive values go to system keychain (macOS) or `~/.claude/.credentials.json` (Linux, mode 0600)
4. `.mcp.json` references via `${user_config.github_token}` — Claude Code substitutes the real value at MCP server startup
5. Value arrives as `RALPH_HERO_GITHUB_TOKEN` env var in the MCP server process
6. `resolveEnv()` in `index.ts` filters unresolved `${...}` templates when userConfig hasn't been configured yet

### Additional validator findings

`claude plugin validate` also flagged 3 skills with YAML frontmatter parse errors (pre-existing, not from PR #689):

- `skills/ralph-postmortem/SKILL.md` — YAML parse error
- `skills/ralph-impl/SKILL.md` — YAML parse error
- `skills/ralph-plan/SKILL.md` — YAML parse error

All three use complex nested `hooks:` structures in frontmatter. At runtime these skills load with empty metadata (all frontmatter fields silently dropped). This means hooks defined in their frontmatter are not being enforced.

## Code References

- `plugin/ralph-hero/.claude-plugin/plugin.json:25-30` — broken userConfig definition
- `plugin/ralph-hero/.mcp.json` — `${user_config.github_token}` template reference
- `plugin/ralph-hero/mcp-server/src/index.ts:34-44` — `resolveEnv()` filters unresolved templates
- `plugin/ralph-hero/mcp-server/src/__tests__/init-config.test.ts` — userConfig delivery path tests

## Open Questions

- What exactly in the `hooks:` YAML structure causes the 3 skill frontmatter parse failures? Is this a known limitation of the YAML parser used by `claude plugin validate`, or are these skills genuinely losing their hook definitions at runtime?
