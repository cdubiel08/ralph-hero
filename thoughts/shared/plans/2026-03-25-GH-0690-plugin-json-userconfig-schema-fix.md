---
date: 2026-03-25
status: draft
type: plan
github_issue: 690
github_issues: [690]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/690
primary_issue: 690
tags: [plugin-manifest, userconfig, validation, bug-fix]
---

# Fix plugin.json userConfig Schema — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-25-userconfig-manifest-schema-validation]]
- builds_on:: [[2026-03-25-group-GH-0685-userconfig-health-check-setup]]

## Overview

1 issue: add two missing required fields (`title` and `type`) to the `userConfig.github_token` entry in `plugin/ralph-hero/.claude-plugin/plugin.json`.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-690 | Fix plugin.json userConfig schema — missing required `type` and `title` fields | XS |

## Shared Constraints

- `plugin/ralph-hero/.claude-plugin/plugin.json` is pure JSON — no TypeScript, no build step.
- Valid `type` values for `userConfig` entries: `"string"`, `"number"`, `"boolean"`, `"directory"`, `"file"`.
- `github_token` is a string value, so `"type": "string"`.
- `title` must be a non-empty string shown to the user in `claude plugin configure` prompts. Use `"GitHub Token"`.
- Ordering of keys within the JSON object does not matter; follow existing style (alphabetical or `title`, `type`, `description`, `sensitive` sequence).
- Do NOT touch any other file — this is a pure JSON patch.
- No build step is required. Verification is `node -e "JSON.parse(...)"` (valid JSON) plus `claude plugin validate plugin/ralph-hero` (schema compliance).

## Current State Analysis

`plugin/ralph-hero/.claude-plugin/plugin.json` (lines 25-30) currently defines:

```json
"userConfig": {
  "github_token": {
    "description": "GitHub Personal Access Token with 'repo' and 'project' scopes...",
    "sensitive": true
  }
}
```

The Claude Code plugin validator requires `title` (string) and `type` (one of the five allowed values) on every `userConfig` entry. Both fields are missing, causing two validation errors:

```
userConfig.github_token.type: Invalid option: expected one of "string"|"number"|"boolean"|"directory"|"file"
userConfig.github_token.title: Invalid input: expected string, received undefined
```

## Desired End State

### Verification

- [ ] `claude plugin validate plugin/ralph-hero` passes with no errors for `userConfig.github_token`
- [ ] `node -e "JSON.parse(require('fs').readFileSync('plugin/ralph-hero/.claude-plugin/plugin.json','utf8'))"` exits 0
- [ ] The `github_token` entry has exactly four keys: `title`, `type`, `description`, `sensitive`

## What We're NOT Doing

- Fixing the pre-existing YAML parse errors in `skills/ralph-plan/SKILL.md`, `skills/ralph-impl/SKILL.md`, and `skills/ralph-postmortem/SKILL.md` — those are separate issues and out of scope here.
- Changing the `description` text or `sensitive` value.
- Modifying `.mcp.json` or any MCP server source.

## Implementation Approach

Single task: open `plugin.json`, insert `"title": "GitHub Token"` and `"type": "string"` into the `github_token` object, verify JSON is still valid.

---

## Phase 1: GH-690 — Fix plugin.json userConfig Schema
- **depends_on**: null

### Overview

Add the two required `userConfig` fields (`title` and `type`) to the `github_token` entry in `plugin.json` so `claude plugin validate` passes without errors.

### Tasks

#### Task 1.1: Patch userConfig.github_token in plugin.json
- **files**: `plugin/ralph-hero/.claude-plugin/plugin.json` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `plugin/ralph-hero/.claude-plugin/plugin.json` is valid JSON (exits 0 with `node -e "JSON.parse(...)"`)
  - [ ] `userConfig.github_token` contains `"title": "GitHub Token"`
  - [ ] `userConfig.github_token` contains `"type": "string"`
  - [ ] `userConfig.github_token` retains the original `description` and `"sensitive": true` fields unchanged
  - [ ] No other fields or files are modified

The corrected `userConfig` block must look exactly like:

```json
"userConfig": {
  "github_token": {
    "title": "GitHub Token",
    "type": "string",
    "description": "GitHub Personal Access Token with 'repo' and 'project' scopes. Create one at https://github.com/settings/tokens. Required scopes: repo (full control of private repos) and project (read:project + write:org). Your token will be stored securely in your system keychain or credentials file.",
    "sensitive": true
  }
}
```

### Phase Success Criteria

#### Automated Verification:
- [ ] `node -e "JSON.parse(require('fs').readFileSync('plugin/ralph-hero/.claude-plugin/plugin.json','utf8'))"` — exits 0, no errors
- [ ] `claude plugin validate plugin/ralph-hero` — passes with no `userConfig.github_token` errors

#### Manual Verification:
- [ ] Open `plugin/ralph-hero/.claude-plugin/plugin.json` and confirm `userConfig.github_token` has `title`, `type`, `description`, and `sensitive` keys in that order

**Creates for next phase**: N/A — standalone fix.

---

## Integration Testing

- [ ] `claude plugin validate plugin/ralph-hero` returns clean output (no `userConfig` errors)
- [ ] `just doctor` (run from `plugin/ralph-hero/`) shows `OK: .claude-plugin/plugin.json (valid JSON)`

## References

- Research: [thoughts/shared/research/2026-03-25-userconfig-manifest-schema-validation.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-25-userconfig-manifest-schema-validation.md)
- Related issues: [https://github.com/cdubiel08/ralph-hero/issues/690](https://github.com/cdubiel08/ralph-hero/issues/690)
- Prior PR that introduced the broken schema: #689
