---
date: 2026-03-03
github_issue: 451
github_url: https://github.com/cdubiel08/ralph-hero/issues/451
topic: "Toolspace consolidation status, get_issue enrichment, list_groups design, and Linear MCP reference patterns"
tags: [research, codebase, mcp-tools, toolspace, consolidation, linear-mcp, get_issue, list_groups]
status: complete
type: research
git_commit: 24f82a77c7b381ea92751b2e689c53d754e4ecc8
---

# Research: Toolspace Consolidation Status, Enrichment Patterns, and Linear MCP Reference

## Research Question

There was previous work related to reducing the toolspace for ralph-hero. As examples: `get_issue` could have group info, `list_groups` should have an algorithm to list parents and children. Also examine the Linear MCP as a reference example for tool surface design.

## Summary

The MCP toolspace consolidation (GH-451) is **fully implemented**: 53 tools → 25 (+ 2 debug). All 6 phases landed in PRs #458–#462 and merged to main on 2026-02-27. The one remaining planned addition is `list_groups` (GH-431), which has research and an implementation plan but no code yet.

`get_issue` already supports two enrichment flags (`includeGroup: true` by default, `includePipeline: false` by default) that fold in what used to be separate `detect_group`, `detect_pipeline_position`, and `check_convergence` tools. Linear MCP implementations follow a similar pattern of unified read enrichment + unified update tools.

## Detailed Findings

### 1. Consolidation Implementation Status

All 6 phases of GH-451 are **DONE** and merged to main.

| Phase | Issue | Title | Status | PR |
|-------|-------|-------|--------|-----|
| 1 | GH-452 | Build unified `save_issue` tool | Merged | #458 |
| 2 | GH-453 | Remove 5 old mutation tools | Merged | #459 |
| 3 | GH-454 | Collapse redundant read tools + merge archive | Merged | #460 |
| 4 | GH-455 | Remove admin tools + merge advance_issue | Merged | #461 |
| 5 | GH-456 | Update skills, agents, justfile | Merged | #462 |
| 6 | — | Update CLAUDE.md and documentation | Merged (within #462) | — |

Session report: [`thoughts/shared/reports/2026-02-27-ralph-team-GH-451.md`](https://github.com/cdubiel08/ralph-hero/blob/24f82a77/thoughts/shared/reports/2026-02-27-ralph-team-GH-451.md)

### 2. Current Tool Inventory (25 Tools + 2 Debug)

#### Issue Operations (6 tools)
| Tool | File | Line |
|------|------|------|
| `list_issues` | `issue-tools.ts` | :57 |
| `get_issue` | `issue-tools.ts` | :456 |
| `create_issue` | `issue-tools.ts` | :876 |
| `save_issue` | `issue-tools.ts` | :1096 |
| `create_comment` | `issue-tools.ts` | :1435 |
| `pick_actionable_issue` | `issue-tools.ts` | :1497 |

#### Relationship Operations (5 tools)
| Tool | File | Line |
|------|------|------|
| `add_sub_issue` | `relationship-tools.ts` | :126 |
| `list_sub_issues` | `relationship-tools.ts` | :207 |
| `add_dependency` | `relationship-tools.ts` | :302 |
| `remove_dependency` | `relationship-tools.ts` | :380 |
| `advance_issue` | `relationship-tools.ts` | :452 |

#### Project Operations (2 tools)
| Tool | File | Line |
|------|------|------|
| `setup_project` | `project-tools.ts` | :171 |
| `get_project` | `project-tools.ts` | :415 |

#### Draft Issue Operations (4 tools)
| Tool | File | Line |
|------|------|------|
| `create_draft_issue` | `project-management-tools.ts` | :44 |
| `update_draft_issue` | `project-management-tools.ts` | :145 |
| `convert_draft_issue` | `project-management-tools.ts` | :201 |
| `get_draft_issue` | `project-management-tools.ts` | :267 |

#### Project Management (2 tools)
| Tool | File | Line |
|------|------|------|
| `create_status_update` | `project-management-tools.ts` | :478 |
| `archive_items` | `project-management-tools.ts` | :566 |

#### Dashboard & Reporting (2 tools)
| Tool | File | Line |
|------|------|------|
| `pipeline_dashboard` | `dashboard-tools.ts` | :252 |
| `detect_stream_positions` | `dashboard-tools.ts` | :478 |

#### Batch & Hygiene (2 tools)
| Tool | File | Line |
|------|------|------|
| `batch_update` | `batch-tools.ts` | :221 |
| `project_hygiene` | `hygiene-tools.ts` | :37 |

#### Debug (2 tools, conditional on RALPH_DEBUG=true)
| Tool | File | Line |
|------|------|------|
| `collate_debug` | `debug-tools.ts` | :258 |
| `debug_stats` | `debug-tools.ts` | :398 |

### 3. `get_issue` Enrichment Flags

`get_issue` ([`issue-tools.ts:456`](https://github.com/cdubiel08/ralph-hero/blob/24f82a77/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L456)) currently supports two enrichment flags:

| Parameter | Default | What It Does |
|-----------|---------|-------------|
| `includeGroup` | `true` | Runs `detectGroup()` — returns parent/sibling context, group membership, primary issue detection. Subsumes the former `detect_group` tool. |
| `includePipeline` | `false` | Runs `detectPipelinePosition()` — returns phase, convergence, member states, remaining phases. Auto-enables `includeGroup`. Subsumes the former `detect_pipeline_position` and `check_convergence` tools. |

**Base response** (always included): `number`, `title`, `body`, `state`, `stateReason`, `url`, `createdAt`, `updatedAt`, `closedAt`, `labels`, `assignees`, `parent`, `subIssuesSummary`, `subIssues`, `blocking`, `blockedBy`, `comments` (last 10), `workflowState`, `estimate`, `priority`, `iteration`.

**With `includeGroup: true`** (default): adds `group` object with `isGroup`, `primary`, `members[]`, `totalTickets`.

**With `includePipeline: true`**: adds `pipeline` object with `phase`, `reason`, `remainingPhases`, `convergence`, `memberStates`, `suggestedRoster`.

### 4. `list_groups` — Planned but Not Implemented

GH-431 has both research and an implementation plan:
- Research: [`thoughts/shared/research/2026-03-01-GH-0431-list-groups-tool.md`](https://github.com/cdubiel08/ralph-hero/blob/24f82a77/thoughts/shared/research/2026-03-01-GH-0431-list-groups-tool.md)
- Plan: [`thoughts/shared/plans/2026-03-02-GH-0431-list-groups-tool.md`](https://github.com/cdubiel08/ralph-hero/blob/24f82a77/thoughts/shared/plans/2026-03-02-GH-0431-list-groups-tool.md)

**Key design**: Single-pass algorithm that reuses the `list_issues` pagination pattern but extends the GraphQL content fragment with `subIssuesSummary`. Filters to parents (`subIssuesSummary.total > 0`), builds a lookup map for child `workflowState` resolution (zero extra API calls), and optionally expands children with `showChildren: true`.

**Parameters**: `state` (default OPEN), `showChildren` (default false), `workflowState`, `estimate`, `priority`, `limit` (default 50).

**Return shape**: `{ totalGroups, groups: [{ parent, childCount, completedCount, percentCompleted, children?, hasMore? }] }`

**Placement**: `relationship-tools.ts` alongside `list_sub_issues`.

### 5. Linear MCP Reference Analysis

Three community implementations and one official server were examined:

| Implementation | Tools | Architecture |
|----------------|-------|-------------|
| jerhadf/linear-mcp-server | 5 | Minimal, single-file, deprecated |
| tacticlaunch/mcp-linear | ~40 | Comprehensive, domain-organized |
| floodfx/mcp-server-linear | 1 | Very early |
| Official Linear MCP (linear.app) | Unknown | Proprietary, actively growing |

#### Unified Update Pattern

Both community implementations use a **unified `updateIssue` tool** with optional fields — not separate per-field tools.

- **jerhadf**: 4 optional fields (title, description, priority, status)
- **tacticlaunch**: 17 optional fields (title, description, stateId, priority, projectId, assigneeId, cycleId, estimate, dueDate, labelIds, addedLabelIds, removedLabelIds, parentId, subscriberIds, teamId, sortOrder)

tacticlaunch also provides **ergonomic shortcut tools** alongside the unified update: `assignIssue`, `setIssuePriority`, `addIssueLabel`, `removeIssueLabel`. This hybrid approach — unified save + atomic shortcuts — is similar to how ralph-hero's `save_issue` coexists with `advance_issue`.

Ralph-hero's `save_issue` ([`issue-tools.ts:1096`](https://github.com/cdubiel08/ralph-hero/blob/24f82a77/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1096)) handles: title, body, labels, assignees, issueState, workflowState (with semantic intents), estimate, priority — plus auto-close on terminal workflow states. This is comparable in breadth to tacticlaunch's `updateIssue`.

#### Search/Filter Pattern

Both use a **single search tool** for all filtered queries: `searchIssues` (tacticlaunch) / `linear_search_issues` (jerhadf). Filters include text query, team, status, assignee, labels, priority, estimate — all in one tool with a flat `limit` parameter.

Ralph-hero's `list_issues` follows the same pattern with richer filtering: workflowState, estimate, priority, state, label, assignee, date-math ranges, profiles, exclusions.

#### Read Enrichment

tacticlaunch's approach:
- **List endpoints** (`getIssues`, `searchIssues`) return enriched objects inline: team, assignee, project, cycle, parent, labels — avoiding N+1 fetches by the LLM.
- **Single-item endpoint** (`getIssueById`) adds comments (with creator data) on top.
- **Update endpoints** return minimal data (`id`, `identifier`, `title`, `url`).

Ralph-hero's pattern is analogous:
- `list_issues` returns enriched objects: workflowState, estimate, priority, labels, assignees, state.
- `get_issue` returns the full issue + comments + relationships + optional group/pipeline enrichment.
- `save_issue` returns minimal confirmation: number, url, changes applied.

#### Parent-Child / Sub-Issue Support

- **jerhadf**: None.
- **tacticlaunch**: Three paths — `convertIssueToSubtask`, `updateIssue.parentId`, `createIssueRelation`. No "list children of parent" tool. `getIssueById` includes a nested `parent` object but no children expansion.
- **Ralph-hero**: Full infrastructure — `add_sub_issue`, `list_sub_issues` (with depth 1–3), `get_issue` includes `parent`, `subIssues`, `subIssuesSummary`. Group detection is built into `get_issue`. The planned `list_groups` would add project-wide group enumeration — a capability none of the Linear MCPs offer.

#### Tool Count Comparison

| System | Total Tools | Ratio (tools : domain concepts) |
|--------|------------|-------------------------------|
| jerhadf/linear-mcp | 5 | Very minimal |
| tacticlaunch/mcp-linear | ~40 | 1 tool per operation |
| ralph-hero (current) | 25 (+2 debug) | Consolidated primitives |
| ralph-hero (with list_groups) | 26 (+2 debug) | — |

Ralph-hero sits between the extremes: fewer tools than tacticlaunch's 40 (thanks to consolidation) but more than jerhadf's minimal 5. The `save_issue` + enriched `get_issue` + filter-rich `list_issues` pattern closely mirrors the design principles visible in the more mature Linear implementations.

## Code References

- `get_issue` tool registration and enrichment flags: [`issue-tools.ts:456–484`](https://github.com/cdubiel08/ralph-hero/blob/24f82a77/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L456)
- `save_issue` unified mutation tool: [`issue-tools.ts:1095–1430`](https://github.com/cdubiel08/ralph-hero/blob/24f82a77/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1095)
- `advance_issue` merged tool: [`relationship-tools.ts:451`](https://github.com/cdubiel08/ralph-hero/blob/24f82a77/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L451)
- `archive_items` merged tool: [`project-management-tools.ts:566`](https://github.com/cdubiel08/ralph-hero/blob/24f82a77/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L566)
- Consolidation parent plan: [`thoughts/shared/plans/2026-02-27-mcp-toolspace-consolidation.md`](https://github.com/cdubiel08/ralph-hero/blob/24f82a77/thoughts/shared/plans/2026-02-27-mcp-toolspace-consolidation.md)
- list_groups plan: [`thoughts/shared/plans/2026-03-02-GH-0431-list-groups-tool.md`](https://github.com/cdubiel08/ralph-hero/blob/24f82a77/thoughts/shared/plans/2026-03-02-GH-0431-list-groups-tool.md)

## Architecture Documentation

### Design Principle (from consolidation plan)

> MCP tools are for runtime workflow operations that LLMs call frequently. One-time setup, project administration, and operational tasks belong in shell scripts or `gh` CLI — not in the tool surface that agents scan on every invocation.

### Tool Surface Organization (8 source files)

```
tools/
├── issue-tools.ts              # 6 tools — list, get, create, save, comment, pick
├── relationship-tools.ts       # 5 tools — sub-issues, dependencies, advance
├── project-tools.ts            # 2 tools — setup, get_project
├── project-management-tools.ts # 6 tools — draft issues (4), status_update, archive
├── dashboard-tools.ts          # 2 tools — pipeline_dashboard, stream_positions
├── batch-tools.ts              # 1 tool  — batch_update
├── hygiene-tools.ts            # 1 tool  — project_hygiene
└── debug-tools.ts              # 2 tools — conditional on RALPH_DEBUG
```

Deleted during consolidation: `sync-tools.ts`, `routing-tools.ts`, `view-tools.ts`.

### Enrichment Pattern: "Flags on Get, Not Separate Tools"

The consolidation established a pattern where read-time enrichment is controlled by boolean flags on `get_issue` rather than separate tools:

- `includeGroup: true` (default) → group detection inline
- `includePipeline: false` (opt-in) → pipeline position inline

This avoids the N+1 problem where an LLM must call `get_issue` then `detect_group` then `detect_pipeline_position` as separate round-trips. tacticlaunch's Linear MCP follows the same pattern: `getIssueById` returns team, assignee, project, cycle, parent, labels, and comments all in one response.

### Update Pattern: "Unified Save, Not Per-Field Tools"

5 separate mutation tools collapsed into 1 `save_issue` that handles:
- Issue-object fields (title, body, labels, assignees, open/close)
- Project-field values (workflowState, estimate, priority)
- Semantic intents (__LOCK__, __COMPLETE__, __ESCALATE__, __CLOSE__, __CANCEL__)
- Auto-close on terminal workflow states

This matches the Linear MCP pattern where `updateIssue` is the single mutation entry point.

## Historical Context (from thoughts/)

### Consolidation Plan
- [`thoughts/shared/plans/2026-02-27-mcp-toolspace-consolidation.md`](https://github.com/cdubiel08/ralph-hero/blob/24f82a77/thoughts/shared/plans/2026-02-27-mcp-toolspace-consolidation.md) — Master plan documenting the 53 → 26 reduction. All phases executed.

### list_groups
- [`thoughts/shared/research/2026-03-01-GH-0431-list-groups-tool.md`](https://github.com/cdubiel08/ralph-hero/blob/24f82a77/thoughts/shared/research/2026-03-01-GH-0431-list-groups-tool.md) — Research confirming single-pass architecture is viable using `subIssuesSummary` in the project items content fragment.
- [`thoughts/shared/plans/2026-03-02-GH-0431-list-groups-tool.md`](https://github.com/cdubiel08/ralph-hero/blob/24f82a77/thoughts/shared/plans/2026-03-02-GH-0431-list-groups-tool.md) — Implementation plan ready for execution.

## Related Research
- [`thoughts/shared/reports/2026-02-27-ralph-team-GH-451.md`](https://github.com/cdubiel08/ralph-hero/blob/24f82a77/thoughts/shared/reports/2026-02-27-ralph-team-GH-451.md) — Session report for the consolidation execution.

## Open Questions

1. **Should `list_issues` also gain `subIssuesSummary`?** The `list_groups` plan adds it only to the new tool's GraphQL query. Adding it to `list_issues` would let callers identify parents without a separate `list_groups` call, but increases response size for all queries.

2. **Should `get_issue` gain an `includeChildren` flag** that returns child issues with their workflowState (similar to `list_groups`'s `showChildren`)? Currently `get_issue` returns `subIssues` with basic info (number, title, state) but not project field values (workflowState, estimate). The `includePipeline` flag partially covers this but focuses on pipeline phase detection rather than child enumeration.

3. **Tool count target**: At 25 (+2 debug) tools, ralph-hero is well below tacticlaunch's ~40 and well above jerhadf's 5. Adding `list_groups` would bring it to 26. Is there further consolidation potential in the draft issue tools (4 tools) or dashboard tools (2 tools)?

## Linear MCP External References
- [jerhadf/linear-mcp-server](https://github.com/jerhadf/linear-mcp-server) — 5 tools, minimal, deprecated
- [tacticlaunch/mcp-linear](https://github.com/tacticlaunch/mcp-linear) — ~40 tools, comprehensive, [TOOLS.md](https://github.com/tacticlaunch/mcp-linear/blob/main/TOOLS.md)
- [floodfx/mcp-server-linear](https://github.com/floodfx/mcp-server-linear) — 1 tool, very early
- [Official Linear MCP docs](https://linear.app/docs/mcp) — proprietary, actively maintained
