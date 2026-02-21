---
date: 2026-02-21
github_issue: 152
github_url: https://github.com/cdubiel08/ralph-hero/issues/152
status: complete
type: research
---

# GH-152: Document Multi-Project Configuration in CLAUDE.md

## Problem Statement

Multi-project support shipped across 3 sibling issues (#144 cache/config, #150 config parsing, #151 tool overrides), but the documentation in `CLAUDE.md` still only covers single-project configuration. Users managing multiple GitHub Projects V2 boards from one Ralph instance have no guidance on setup.

## Current Documentation State

### `CLAUDE.md` Environment Variables Section (lines 67-94)

The current table documents 7 environment variables. `RALPH_GH_PROJECT_NUMBER` (singular) is listed as required. There is no mention of:
- `RALPH_GH_PROJECT_NUMBERS` (comma-separated list for multi-project)
- The `projectNumber` override parameter available on 28+ tools
- The `projectNumbers` array parameter on `pipeline_dashboard`
- How single vs multi-project modes interact

### `.mcp.json` (13 lines)

Only configures the single-project default:
```json
"RALPH_GH_PROJECT_NUMBER": "${RALPH_GH_PROJECT_NUMBER:-3}"
```

No `RALPH_GH_PROJECT_NUMBERS` key exists in `.mcp.json`. This is correct -- multi-project config belongs in `settings.local.json` since it's user-specific.

## Implementation Inventory

### What shipped in #144, #150, #151

1. **`GitHubClientConfig.projectNumbers?: number[]`** (`types.ts:269`): Optional array of project numbers for cross-project operations.

2. **`resolveProjectNumbers()`** (`types.ts:284-288`): Returns `projectNumbers` array, falling back to `[projectNumber]`.

3. **`RALPH_GH_PROJECT_NUMBERS` env var parsing** (`index.ts:75-80`): Comma-separated string parsed to `number[]`, e.g., `"3,5,7"` becomes `[3, 5, 7]`.

4. **`resolveFullConfig` extension** (`helpers.ts:479-497`): Accepts optional `projectNumber` in args with resolution priority: `args.projectNumber ?? client.config.projectNumber`.

5. **`projectNumber` override on 28+ tools**: Every tool using `resolveFullConfig` accepts optional `projectNumber` parameter to target a specific project per-call.

6. **`projectNumbers` array on `pipeline_dashboard`** (`dashboard-tools.ts:255-260`): Accepts array of project numbers, defaults to `RALPH_GH_PROJECT_NUMBERS` or single configured project. Fetches items from all projects and aggregates.

7. **`FieldOptionCache` keyed by project number** (`cache.ts`): Cache is project-aware, supporting concurrent field lookups across multiple projects.

### Configuration Modes

| Mode | Env vars | Behavior |
|------|----------|----------|
| Single project (default) | `RALPH_GH_PROJECT_NUMBER=3` | All tools target project 3 |
| Multi-project | `RALPH_GH_PROJECT_NUMBER=3` + `RALPH_GH_PROJECT_NUMBERS=3,5,7` | Dashboard aggregates across 3, 5, 7. Individual tools default to project 3 unless `projectNumber` override is passed. |
| Per-call override | Any mode + `projectNumber: 5` in tool args | That specific call targets project 5, regardless of defaults |

### Key Interactions

- `RALPH_GH_PROJECT_NUMBER` remains required as the default/primary project
- `RALPH_GH_PROJECT_NUMBERS` is optional; when set, `resolveProjectNumbers()` returns this array (for cross-project tools like dashboard)
- Individual tool calls always use `RALPH_GH_PROJECT_NUMBER` unless overridden via `projectNumber` arg
- The dashboard's `projectNumbers` arg overrides `RALPH_GH_PROJECT_NUMBERS`

## Documentation Plan

### 1. Add `RALPH_GH_PROJECT_NUMBERS` to env var table

Add one row to the existing table in CLAUDE.md (after the `RALPH_GH_PROJECT_NUMBER` row):

```markdown
| `RALPH_GH_PROJECT_NUMBERS` | No | `settings.local.json` | Comma-separated project numbers for cross-project operations (e.g., `"3,5,7"`) |
```

### 2. Add multi-project config example

Add a second example block after the existing `settings.local.json` example (lines 71-80):

```json
{
  "env": {
    "RALPH_HERO_GITHUB_TOKEN": "ghp_xxx",
    "RALPH_GH_OWNER": "cdubiel08",
    "RALPH_GH_REPO": "ralph-hero",
    "RALPH_GH_PROJECT_NUMBER": "3",
    "RALPH_GH_PROJECT_NUMBERS": "3,5,7"
  }
}
```

### 3. Add "Multi-Project Configuration" subsection

After the env var table, add a brief subsection explaining:
- When to use multi-project (managing multiple boards, cross-project dashboards)
- `RALPH_GH_PROJECT_NUMBER` is the default; `RALPH_GH_PROJECT_NUMBERS` is for aggregation
- Per-call `projectNumber` override is available on all project-aware tools
- Dashboard auto-aggregates when `RALPH_GH_PROJECT_NUMBERS` is set

### 4. Files to modify

| File | Change |
|------|--------|
| `CLAUDE.md` | Add env var row, multi-project example, and subsection (~20 lines) |

### 5. What NOT to document

- Internal implementation details (`resolveFullConfig`, `FieldOptionCache` keying)
- Per-tool schema details (the `projectNumber` parameter is self-documenting in tool descriptions)
- `.mcp.json` changes (none needed -- multi-project config belongs in `settings.local.json`)

## Risks

1. **Minimal risk**: This is a docs-only change to an existing file. No code changes.
2. **Accuracy**: All 3 sibling issues (#144, #150, #151) are CLOSED and their implementations are verified in the current codebase.

## Recommendation

Straightforward XS task. Add one env var row, one example block, and a 10-line subsection to CLAUDE.md. No other files need changes.
