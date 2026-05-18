---
date: 2026-05-08
git_commit: eb84ae80a33ba8bac181f299dcc9d21434503e54
branch: main
topic: "How ralph-hero shorthand discovery/inventory tools count, filter, and surface project state — a consistency audit"
tags: [research, mcp-tools, next_actions, pipeline_dashboard, list_issues, project_hygiene, hygiene, recent_activity, hello, status, catch-up, consistency, tpm-ergonomics, ralph-hero]
status: complete
type: research
---

# Research: How ralph-hero shorthand discovery/inventory tools count, filter, and surface project state

## Prior Work

- builds_on:: [[2026-05-07-GH-1129-list-issues-totalcount-misleading]] (research — primary evidence; documents the `totalCount` vs `filteredCount` semantic mismatch in `list_issues` that this audit re-confirms)
- builds_on:: [[2026-05-07-GH-1129-list-issues-totalcount-misleading]] (plan — describes intent for fixing the count, may not yet be implemented)
- builds_on:: [[2026-04-30-group-GH-0921-hello-directions-implementation]] (plan — defines the canonical ranking spec used by `next_actions`)
- builds_on:: [[2026-05-02-hello-composable-rewrite]] (research — covers audience filtering and `next_actions` integration into the `hello` skill)
- builds_on:: [[2026-04-25-GH-0572-ralph-hygiene-audit]] (research — board cleanup effectiveness audit)
- builds_on:: [[2026-04-25-GH-0571-status-report-audit]] (research — audits `status` and `report` skill output quality)
- builds_on:: [[2026-03-14-hygiene-pipeline-multi-repo-aggregation]] (research — compares `project_hygiene` vs `pipeline_dashboard` multi-repo aggregation)
- builds_on:: [[2026-02-19-GH-0115-archive-stats-pipeline-dashboard]] (research — defines `doneWindowDays` and archive-stats counts)
- builds_on:: [[2026-02-20-GH-0139-velocity-metrics-auto-status]] (research — defines velocity / auto-status thresholds in dashboard metrics)
- builds_on:: [[2026-02-20-GH-0142-exclude-negation-filters-list-issues]] (research — defines silent filtering semantics of `exclude*` filters)
- builds_on:: [[2026-02-16-GH-0026-workflow-visualization-pipeline-dashboard]] (research — original pipeline_dashboard implementation spec)
- builds_on:: [[2026-02-21-GH-0114-project-hygiene-reporting-tool]] (research — defines `project_hygiene` category rules)
- builds_on:: [[2026-03-03-GH-0480-hello-session-briefing]] (research — original `hello` skill design)

**Evidence weighting**: research entries are primary evidence (verified findings). Plan entries describe intent — `GH-1129` plan exists but may not yet be merged; treat as weaker evidence about current behavior.

## Research Question

How do ralph-hero "shorthand" tools and skills (`next_actions`, `pipeline_dashboard`, `list_issues`, `project_hygiene`, `hello_directions`, `recent_activity`, `pick_actionable_issue`, `hello`, `status`, and related surfaces) return counts and lists of issues? From a TPM/PO/tech-lead perspective, which states are filtered vs surfaced, what do the various count fields actually count, when are items silently dropped, and where do the surfaces disagree with each other?

This audit was triggered by a concrete observation on 2026-05-08: `next_actions` reported `totalCandidates: 292` but emitted only one direction (a stale PR) — because `ACTIONABLE_PHASES` excludes `Backlog` and items with `workflowState=null`. The user asked whether this same kind of structural mismatch exists across the other shorthand surfaces.

## Summary

The ralph-hero MCP server exposes **13 primary discovery/inventory tools** wrapped by **5 skills** (`/hello`, `/status`, `/trends`, `/catch-up`, `/ralph-hygiene`). Each tool independently decides:

1. **what to count** (project items vs issues vs PRs vs activity events vs snapshots),
2. **what to filter** (workflow state, time window, repo, draft-status, blocked-status),
3. **what to silently drop** (items with `workflowState=null`, items not on the project board, items outside `doneWindowDays`),
4. **what default thresholds to apply** (`24h`, `48h`, `7d`, `14d` — overlapping units and meanings),
5. **how to expose the count** (`totalCandidates`, `totalIssues`, `filteredCount`, per-category scalars, or no count at all).

The result: **the same project board, queried by different tools, returns different views of "how many" and "which" items exist.** A TPM asking "how many issues need attention" gets a different answer from `pipeline_dashboard.totalIssues` (raw item count, includes PRs and Done items within the window) than from `next_actions.totalCandidates` (raw item count, all states) than from `list_issues.filteredCount` (post-filter, post-limit) than from `project_hygiene.summary` (per-category scalars).

The most consequential single finding: **`next_actions`'s `ACTIONABLE_PHASES` filter is hardcoded to four states and does not change with `audience`.** Items in `Backlog` and items with no workflow state are structurally invisible to the "next actions" picker. A board with 292 items but no items in those four states will yield zero issue-kind directions — even when there are obvious actionable items in `Backlog`.

A secondary consequential finding: **all four major shorthands (`list_issues`, `pipeline_dashboard`, `next_actions`, `project_hygiene`) query the GitHub Projects V2 board, NOT the repo issues API.** Issues that exist in the repo but have not been added to the project board are invisible to every shorthand simultaneously, with no warning. On 2026-05-08 this manifested as 35 OPEN repo issues but only 4 on the project board — 31 issues were unreachable by any discovery tool.

This document maps what exists today. It does not propose changes.

## Detailed Findings

### Inventory: 13 tools + 5 skills

**Active discovery/inventory tools** ([source: `src/index.ts`](https://github.com/cdubiel08/ralph-hero/blob/eb84ae80a33ba8bac181f299dcc9d21434503e54/plugin/ralph-hero/mcp-server/src/index.ts)):

| Tool | Source file | Lines | One-line purpose |
|---|---|---|---|
| `next_actions` | `src/tools/directions-tools.ts` | 457-520 | Ranked next actions for session guidance (the canonical "what's next" picker) |
| `pipeline_dashboard` | `src/tools/dashboard-tools.ts` | 52-150 | Phase-by-phase issue counts + health indicators + optional metrics/streams |
| `list_issues` | `src/tools/issue-tools.ts` | 63-510 | Filtered issue list by workflow state, estimate, priority, iteration, labels, query |
| `project_hygiene` | `src/tools/hygiene-tools.ts` | 42-120 | Six categories of board-cleanup signals (archives, stale, orphans, field gaps, WIP, duplicates) |
| `recent_activity` | `src/tools/activity-tools.ts` | 14-40 | Reads local JSONL activity log since cursor |
| `metrics_trends` | `src/tools/trends-tools.ts` | 131-180 | 1d/7d/30d deltas + sparklines from snapshots |
| `capture_snapshot` | `src/tools/trends-tools.ts` | 45-130 | Append point-in-time project snapshot to JSONL |
| `detect_stream_positions` | `src/tools/dashboard-tools.ts` | 294-350 | Work-stream detection from file ownership + tree |
| `health_check` | `src/index.ts` | 214-310 | Validate auth, token permissions, repo+project access |
| `list_sub_issues` | `src/tools/relationship-tools.ts` | 239 | Children of a parent issue with completion summary |
| `list_dependencies` | `src/tools/relationship-tools.ts` | 514 | `blocking` / `blockedBy` graph for an issue |
| `list_groups` | `src/tools/relationship-tools.ts` | 1063 | Discover all parents with child counts |

**Deprecated, scheduled for 2.7.0 removal** (still registered today):

| Tool | Source | Line | Migration |
|---|---|---|---|
| `hello_directions` | `src/tools/directions-tools.ts` | 391-455 | `next_actions(audience="human")` |
| `pick_actionable_issue` | `src/tools/issue-tools.ts` | 1680-1800 | `next_actions(audience="agent", limit=1)` |

**Debug-only (when `RALPH_DEBUG=true`)**:

| Tool | Source | Line |
|---|---|---|
| `debug_stats` | `src/tools/debug-tools.ts` | 399-445 |
| `collate_debug` | `src/tools/debug-tools.ts` | 259-360 |

**Skills wrapping the above**:

| Skill | Path | Tools called | Render |
|---|---|---|---|
| `/hello` | `skills/hello/SKILL.md` | `next_actions(limit=3, audience="human")` + delegates to `/catch-up` + `gh pr list` shell-out | Prose briefing ≤40 lines |
| `/status` | `skills/status/SKILL.md` | `pipeline_dashboard(format="markdown", issuesPerPhase=5)` | Renders `formatted` field verbatim |
| `/trends` | `skills/trends/SKILL.md` | `capture_snapshot` then `metrics_trends` | Markdown stdout |
| `/catch-up` | `skills/catch-up/SKILL.md` | `recent_activity(category="work", limit=200)` | 2-4 sentence prose narrative |
| `/ralph-hygiene` | `skills/ralph-hygiene/SKILL.md` | `pipeline_dashboard` + `project_hygiene` + `archive_items` | Autonomous board-cleanup orchestration |

### `next_actions` — the canonical "what's next" picker

**Source**: `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts:457-520`, `plugin/ralph-hero/mcp-server/src/lib/directions.ts` (979 lines).

**What it counts**:
- `totalCandidates` (`directions-tools.ts:371`) = `allItems.length` after `toDashboardItems()` conversion. Counts every project item across every configured project number, pre-filter. Includes issues in any state (`Backlog`, `Done`, `Canceled`, `Human Needed`, lock states, all). Does NOT include caller-supplied PRs (which are passed via `openPRs` and counted separately into the merged result).
- `directions.length` post-filter = at most `config.limit` entries (default `3`). Sliced from the merged sorted candidate list at `directions.ts:909`.
- **There is no `filteredCount` field**. The response shape returns no field tracking how many candidates were dropped between `totalCandidates` and the final list.

**Filtering pipeline (in order)** — every filter that runs between raw items and final emitted directions:

1. **Phase filter** (`directions.ts:826-833`): drops items whose `workflowState` is not in `ACTIONABLE_PHASES` UNLESS the item is lock-stale OR has an unblock signal.
   - `ACTIONABLE_PHASES = {"Plan in Review", "In Review", "Ready for Plan", "Research Needed"}` (`directions.ts:221-226`).
   - Items with `workflowState=null` fail `isCandidatePhase()` at `directions.ts:781-782` (silent drop).
2. **Open-blockers filter** (`directions.ts:840`): items whose `blockedBy` contains any non-Done/non-Canceled entry are removed from the unblocked pool.
3. **Blocker fallback** (`directions.ts:839-850`): if every phase-passing item is blocked, the full blocked set is restored as candidates. There is **no analogous fallback for the phase filter** — if zero items pass `ACTIONABLE_PHASES`, `directions[]` is empty.
4. **PR filters** (only invoked when `openPRs` is non-empty):
   - `isDraft === true` → excluded (`directions.ts:627-629`).
   - `reviewDecision === "APPROVED"` → excluded (`directions.ts:633-634`).
   - "Score === 0" gate (`directions.ts:655`) — fresh PRs without `REVIEW_REQUIRED` and within `prStaleHours` produce score 0 and are excluded as "work-in-progress noise".
   - `reviewDecision === "REVIEW_REQUIRED"` → kept with `PR_REVIEW_REQUIRED_BOOST=-200`.
   - `reviewDecision === "CHANGES_REQUESTED"` → kept only if also stale; fresh CHANGES_REQUESTED is silenced via the score-0 gate.
5. **Limit slice** (`directions.ts:909`): `merged.slice(0, config.limit)`.

**State-by-state visibility table**:

| Workflow state | Visible to `next_actions`? |
|---|---|
| `Backlog` | NO — not in `ACTIONABLE_PHASES`, not a lock state |
| `Research Needed` | YES |
| `Research in Progress` | NO unless lock-stale (>`lockStaleHours=24h`) |
| `Ready for Plan` | YES |
| `Plan in Progress` | NO unless lock-stale |
| `Plan in Review` | YES |
| `In Progress` | NO unless lock-stale |
| `In Review` | YES |
| `Done` | NO |
| `Canceled` | NO |
| `Human Needed` | NO unless `unblockSignals[issue]` is set (item has a fresh `## Unblock Request` comment) |
| `null` (no workflow state) | NO — silently dropped at `directions.ts:781` |

**Audience parameter behavior** (`directions.ts:318-323`):
- `audience="human"` (default): `audiencePenalty()` returns 0 for all items. No effect.
- `audience="agent"`: applies estimate-based penalty. M=+20, L=+40, XL=+60, unknown/null=+30, XS/S=0. The penalty is added to the score at `directions.ts:496` and recorded in `signals.estimateWeight` when non-zero (`directions.ts:590-592`).
- **Audience does NOT change the candidate set.** The phase filter, blocker filter, lock-stale check, and unblock-signal check are audience-independent. Audience exclusively modifies the numeric score.

**PR direction emission depends on caller**:
- `openPRs` defaults to `[]` (`directions-tools.ts` schema). Empty input means **no PR-kind directions can ever be emitted regardless of board state.**
- The caller (e.g., the `/hello` skill) is responsible for fetching `gh pr list` and passing the result.

**Output shape** (assembled from `directions-tools.ts:367-371` and `Direction` interface at `directions.ts:107-146`):

```
{
  directions: [
    {
      rank, recommended, kind,         // kind ∈ {"issue", "pr", "tree-continue", "lock-stale", "human-needed-unblock"}
      issue: {...} | null,
      pr: {...} | null,
      signals: { tags, staleDays?, staleThresholdDays?, tiedAtScore?, estimateWeight?, ... },
      reason,                          // @deprecated, removed in 2.7.0
      tags,                            // @deprecated, removed in 2.7.0 (use signals.tags)
      score
    }
  ],
  fetchedAt,
  totalCandidates                      // pre-filter count of all DashboardItems
}
```

### `pipeline_dashboard` — phase-by-phase counts

**Source**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`, `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`.

**What it counts**:
- `totalIssues` (`dashboard.ts:805`) = `items.length` raw — every project item fetched via pagination, **with no pre-filtering**. Includes open issues, closed issues, draft issues, AND PRs that are on the project board. This count is NOT filtered by workflow state, open/closed status, or any time window.
- `phase.count` (per-state count): set in `buildSnapshot` at `dashboard.ts:296-318` to `sorted.length` of the (possibly window-filtered) bucket.

**`doneWindowDays` (default 7) caps both count AND list for Done/Canceled phases** (`dashboard.ts:251-263`):
- Done and Canceled buckets are filtered to items where `closedAt ?? updatedAt` is within the window BEFORE `buildSnapshot` is called.
- Both `phase.count` and `phase.issues[]` are post-filter for these phases.
- `totalIssues` is NOT affected by `doneWindowDays` — it is set on the unfiltered input array.
- **Implication**: a board with 200 Done items closed >7 days ago will report `Done.count = 0` but `totalIssues = 200+`. The two numbers describe different sets.

**`workflowState=null` handling** (`dashboard.ts:243`):
- `const state = item.workflowState ?? "Unknown"` — null items go into an "Unknown" bucket.
- The Unknown bucket is emitted as a `PhaseSnapshot` with state `"Unknown"` after named phases (`dashboard.ts:276-280`).
- Unknown items ARE counted in `totalIssues` (since that field is just `items.length`).
- The Unknown bucket is NOT subject to `doneWindowDays` (only "Done" and "Canceled" are filtered).

**`archiveThresholdDays` (default 14)** (`dashboard.ts:520-563`):
- Used ONLY by `computeArchiveStats` to populate `dashboard.archive.eligibleItems` and `eligibleForArchive`.
- Does NOT affect phase counts or phase issue lists.

**Format options** (`json` / `markdown` / `ascii`) — count semantics are identical across formats. Differences:
- `markdown` reapplies `issuesPerPhase` (default 10) as a display-only slice when rendering the per-phase issue table at `dashboard.ts:843-857`. Does NOT recompute `count`.
- `ascii` renders bar chart and summary counts only.
- `json` returns the structured object with all sub-sections.

**Parameters and effects**:

| Param | Default | Effect |
|---|---|---|
| `owner` | env | GitHub owner |
| `projectNumbers` | env | If multiple, items merged and `projectBreakdowns` emitted when ≥2 |
| `format` | `"json"` | json / markdown / ascii |
| `includeHealth` | `true` | When false, replaces `health` with `{ ok: true, warnings: [] }` |
| `stuckThresholdHours` | `48` | Warning-level stuck threshold; critical = 2× this |
| `wipLimits` | `{}` | Per-state caps for WIP / lock-collision warnings |
| `doneWindowDays` | `7` | Caps Done/Canceled `count` AND `issues[]`; "recent" window in archive stats |
| `issuesPerPhase` | `10` | Slices `phase.issues[]` AFTER `buildDashboard` (`dashboard-tools.ts:214-217`); does NOT affect `count` |
| `includeMetrics` | `false` | Appends `metrics` from `calculateMetrics` |
| `velocityWindowDays` | `7` | Velocity computation window |
| `atRiskThreshold` / `offTrackThreshold` | `2` / `6` | Risk score thresholds |
| `archiveThresholdDays` | `14` | `archive.eligibleItems` only — no effect on phase counts |
| `streams` | none | When provided, adds `streams` section |
| `groupBy` | none | `"repo"` returns a per-repo sub-dashboard |

### `list_issues` — filtered issue list

**Source**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:63-510`.

**Counts**:
- `filteredCount` (`issue-tools.ts:496`) = `formattedItems.length` — count AFTER all client-side filters AND AFTER the `limit` slice (`issue-tools.ts:467`).
- `items.length` always equals `filteredCount` in the same response.
- **`filteredCount` does NOT represent the pre-limit pool size.** This is the central confusion that `GH-1129` already documents.

**Default state filter**: `"OPEN"` (`issue-tools.ts:116-117`). Valid: `"OPEN"`, `"CLOSED"`. CLOSED issues are silently filtered out by default.

**Default limit**: `50` (`issue-tools.ts:187`). No upper bound declared in schema, but pagination ceiling is 500 items (`issue-tools.ts:266`).

**Filter parameters and semantics**:

| Param | Type | Semantics |
|---|---|---|
| `state` | enum | Default `OPEN`. Filters `content.state`. |
| `reason` | enum | Filters `content.stateReason`. |
| `workflowState` | string | Exact match on `Workflow State` field. |
| `estimate` / `priority` | string | Exact match. |
| `iteration` | string | Resolves `@current` / `@next` / sprint title to iterationId. If no iteration field exists or the token can't resolve, **result is forced to empty** (silent zero-result). |
| `label` | string | Match any label name. |
| `repoFilter` | string | Case-insensitive. Slash-form matches `nameWithOwner`; bare matches `name`. |
| `has[]` / `no[]` | enum array | Field non-empty / empty checks (workflowState, estimate, priority, labels, assignees). |
| `excludeWorkflowStates[]` / `excludeEstimates[]` / `excludePriorities[]` / `excludeLabels[]` | array | Exclusion lists. Independent of `has`/`no`. |
| `query` | string | Case-insensitive substring on title OR body. |
| `updatedSince` / `updatedBefore` | string | Date-math (`@today-7d`, `@now-24h`) or ISO date. |
| `orderBy` | enum | `CREATED_AT` (default) / `UPDATED_AT` / `COMMENTS`. **`COMMENTS` falls through to `createdAt`** since the implementation only special-cases `UPDATED_AT` (`issue-tools.ts:460`). |
| `limit` | number | `.slice(0, args.limit || 50)` after filters and sort. |
| `profile` | string | Named filter profile, expanded as defaults; explicit params override (`issue-tools.ts:194-197`). |

**Profiles** (`src/lib/filter-profiles.ts:29-53`):

| Profile | Sets |
|---|---|
| `analyst-triage` | `workflowState: "Backlog"` |
| `analyst-research` | `workflowState: "Research Needed"` |
| `analyst-unblock` | `workflowState: "Human Needed"` |
| `builder-active` | `workflowState: "In Progress"` |
| `builder-planned` | `workflowState: "Plan in Review"` |
| `review-queue` | `workflowState: "Plan in Review"` |
| `integrator-merge` | `workflowState: "In Review"` |

**Repo scope**: `list_issues` queries the GitHub Projects V2 API (`client.projectQuery`), not the repo issues API (`issue-tools.ts:215-216`). It paginates `ProjectV2.items` and filters to `type === "ISSUE"`. **Orphaned repo issues not on the board are invisible.**

**No `assignees` filter parameter exists** (the schema lacks one despite `has=["assignees"]` and `no=["assignees"]` being valid).

### `project_hygiene` — six cleanup signal categories

**Source**: `plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts:42-120`, `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts`.

**Six categories** (`hygiene.ts:70-86`):

1. **`archiveCandidates`** (`hygiene.ts:116-130`): `workflowState` in `TERMINAL_STATES` (`Done` or `Canceled`) AND `subIssueCount === 0` AND `closedAt ?? updatedAt` age exceeds `archiveDays` (default 14). **Silent rule**: parents with sub-issues are excluded — no parameter controls this.

2. **`staleItems`** (`hygiene.ts:135-147`): NOT in `TERMINAL_STATES` AND `updatedAt` age exceeds `staleDays` (default 7). **Includes `workflowState=null` items** (the check is `if (ws && TERMINAL_STATES.includes(ws)) return false`).

3. **`orphanedItems`** (`hygiene.ts:152-164`): `workflowState === "Backlog"` (strict) AND `assignees.length === 0` AND `updatedAt` age exceeds `orphanDays` (default 14). **Only Backlog is checked** — items in other non-terminal states with no assignee are NOT flagged.

4. **`fieldGaps`** (`hygiene.ts:169-186`): non-terminal items (null-inclusive). Two independent sub-lists: `missingEstimate` (estimate=null), `missingPriority` (priority=null). Items can appear in both.

5. **`wipViolations`** (`hygiene.ts:191-221`): only checked for states explicitly in the `wipLimits` parameter. **Default `wipLimits={}` means this list is always empty.**

6. **`duplicateCandidates`** (`hygiene.ts:283-317`): non-terminal items (null-inclusive). Pairwise normalized Levenshtein. Pairs whose normalized lengths differ by >50% are skipped before similarity computation. Pairs ≥ `similarityThreshold` (default 0.8) returned.

**`fieldCoveragePercent`** (`hygiene.ts:404-416`): % of non-terminal items with BOTH estimate AND priority. Terminal items excluded from numerator and denominator.

**Counts and lists**: both. `summary` field has scalar counts; each category also returns full item lists with `number`, `title`, `workflowState`, `ageDays`, optionally `repository`.

**Per-repo breakdowns** are emitted automatically when items span ≥2 repos (`hygiene.ts:421`) — no parameter needed.

### `recent_activity` — local JSONL log, NOT GitHub

**Source**: `plugin/ralph-hero/mcp-server/src/tools/activity-tools.ts`, `plugin/ralph-hero/mcp-server/src/lib/activity.ts`.

**This is not GitHub data.** It reads from `~/.ralph-hero/activity/YYYY/MM/DD.jsonl` (configurable via `RALPH_ACTIVITY_DIR`). The log is written by harness hooks (`record-activity.sh`) — `kind`, `category`, `target` are hook-defined.

**Output**: `events: ActivityEvent[]` sorted ascending by `ts`, sliced to `limit` (default 100). Plus `cursor_advanced_to` (last ts) and `skipped_lines` (parse errors). **No aggregate counts.**

**Time window default**: `since=null` → epoch zero (all history). `until=null` → `Number.MAX_SAFE_INTEGER`. There is no implicit "today only" default.

**Workflow-state filters**: NONE. The activity log has no concept of workflow state. Filters are: time range, event `kind`, `category` (`work` / `meta` / `all`), `project` string. **Default `category="work"` silently excludes `meta` events.**

### `pick_actionable_issue` (deprecated) — strict subset of `next_actions`

**Source**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1680-1800`.

Wraps `runDirections` with `audience="agent"`, then post-filters:
- Keeps only `kind === "issue"` (`issue-tools.ts:1772-1774`) — drops PR, lock-stale, tree-continue, human-needed-unblock kinds.
- Optional `workflowState` filter (caller-supplied).
- Optional `maxEstimate` filter (default `S` — drops M/L/XL).
- Drops items with the `"blocked"` tag (`issue-tools.ts:1795-1797`).

Returns `{ found: false, issue: null, alternatives: 0 }` when zero issue-kind candidates remain.

**Effective candidate set**: strict subset of `next_actions(audience="agent")`, with three additional filters layered on top.

### `hello_directions` (deprecated) — `next_actions(audience="human")` alias

**Source**: `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts:391-455`.

Hardcodes `audience: "human"` (`directions-tools.ts:452`). No way to override. Deprecation noted in tool description: `"[DEPRECATED — use ralph_hero__next_actions instead. Removed in 2.7.0.]"` (`directions-tools.ts:392`).

### `metrics_trends` and `capture_snapshot` — point-in-time JSONL

**Source**: `plugin/ralph-hero/mcp-server/src/tools/trends-tools.ts`, `src/lib/trends.ts`, `src/lib/snapshots.ts`.

`capture_snapshot` appends one row to `~/.ralph-hero/snapshots/<owner>/<projectNumber>.jsonl`. Schema-versioned via `SNAPSHOT_SCHEMA_VERSION` — rows with mismatched version are skipped on read with a warning (CLAUDE.md confirms this).

`metrics_trends` reads the JSONL and computes 1d/7d/30d deltas over `velocity`, `riskScore`, `wipTotal`, `leadTimeP50Hours`. Renders Unicode 8-bucket sparklines. Markdown or JSON output.

**Counts at the snapshot level** are point-in-time totals; trends are computed from the JSONL, not from a fresh GitHub query. **A board change since the last snapshot is invisible to `metrics_trends` until the next `capture_snapshot`.**

### `health_check` — separate concern, no item counts

**Source**: `plugin/ralph-hero/mcp-server/src/index.ts:214-310`. Validates auth token, scopes, repo access, project access, field schema. Returns status + details. Not a discovery surface.

### Skill: `/hello`

**Source**: `plugin/ralph-hero/skills/hello/SKILL.md`.

Step 1 (parallel):
- `Skill("ralph-hero:catch-up")` — delegates to catch-up skill (which calls `recent_activity`).
- `gh pr list` via `Bash`.

Step 2:
- `ralph_hero__next_actions(limit=3, audience="human", openPRs=<parsed>)`.

**Does NOT surface counts.** `totalCandidates` returned by `next_actions` is not rendered. Briefing capped at ≤40 lines prose.

**Picker**: `next_actions` returns directions with one marked `recommended: true`. The skill presents `AskUserQuestion` placing the recommended direction first.

### Skill: `/status`

**Source**: `plugin/ralph-hero/skills/status/SKILL.md`. Pure `pipeline_dashboard(format="markdown", includeHealth=true, issuesPerPhase=5)` wrapper. Renders the `formatted` field verbatim. Default format `markdown`.

### Skill: `/catch-up`

**Source**: `plugin/ralph-hero/skills/catch-up/SKILL.md`. Calls `recent_activity(category="work", limit=200)`. Synthesizes 2-4 sentence prose narrative. Cursor advanced via PostToolUse hook (`cursor-advance-catch-up.sh`).

### Skill: `/trends`

Calls `capture_snapshot` then `metrics_trends`. Markdown stdout. Read-only; does not post to GitHub.

### Skill: `/ralph-hygiene`

Autonomous wrapper around `pipeline_dashboard` + `project_hygiene` + `archive_items`.

## Cross-Tool Consistency Matrices

These matrices document where the surfaces agree, where they diverge, and what's silently invisible.

### Matrix 1 — "Counts" mean different things

| Tool | Count field | What it counts | Pre/post filter? |
|---|---|---|---|
| `next_actions` | `totalCandidates` | All `DashboardItem`s across all configured projects | Pre-filter (raw) |
| `pipeline_dashboard` | `totalIssues` | `items.length` of fetched project items (incl. PRs) | Pre-filter (raw) |
| `pipeline_dashboard` | `phase.count` | Items in that phase | Post-filter (Done/Canceled subject to `doneWindowDays`) |
| `list_issues` | `filteredCount` | Items in response | Post-filter AND post-limit |
| `project_hygiene` | `summary.<category>` | Items matching that category's rule | Post-filter |
| `recent_activity` | (none) | — | Returns events, no count |
| `metrics_trends` | (per snapshot field) | Totals at snapshot time | Snapshot-time |

**Three different "totals" can disagree on the same board:**
- `next_actions.totalCandidates` and `pipeline_dashboard.totalIssues` should be equal (both raw item counts) — but they query independently and can diverge if one includes draft issues / PRs differently.
- `list_issues.filteredCount` will always be smaller because it post-filters and post-limits.
- `pipeline_dashboard.totalIssues` is NOT the sum of `phase.count` values, because Done/Canceled `count` fields are window-clamped and `totalIssues` is not.

### Matrix 2 — Workflow state visibility per tool

Y = surfaced; N = silently dropped; ★ = conditionally surfaced.

| State / condition | `next_actions` | `pipeline_dashboard` | `list_issues` | `project_hygiene` |
|---|---|---|---|---|
| `Backlog` | N | Y | Y | only `orphanedItems` (assignees=0, age>14d); not in `staleItems`/`fieldGaps` rules' state filter but included if conditions match |
| `Research Needed` | Y | Y | Y | Y (non-terminal) |
| `Research in Progress` | ★ if lock-stale (>24h) | Y | Y | Y |
| `Ready for Plan` | Y | Y | Y | Y |
| `Plan in Progress` | ★ if lock-stale | Y | Y | Y |
| `Plan in Review` | Y | Y | Y | Y |
| `In Progress` | ★ if lock-stale | Y | Y | Y |
| `In Review` | Y | Y | Y | Y |
| `Done` | N | Y, capped by `doneWindowDays=7` | Y if `state=CLOSED` | only `archiveCandidates` |
| `Canceled` | N | Y, capped by `doneWindowDays=7` | Y if `state=CLOSED` | only `archiveCandidates` |
| `Human Needed` | ★ if `unblockSignals` set | Y | Y | Y |
| `workflowState=null` | N (silent drop) | Y as "Unknown" bucket | Y | Y in `staleItems` / `fieldGaps` / `duplicates`; N in `orphanedItems` |

### Matrix 3 — Threshold defaults overlap and disagree

| Concept | Where used | Default | Unit |
|---|---|---|---|
| Lock-state staleness | `next_actions.lockStaleHours` | 24 | hours |
| PR staleness | `next_actions.prStaleHours` | 24 | hours |
| Stuck non-lock items | `next_actions.stuckThresholdHours` / `pipeline_dashboard.stuckThresholdHours` | 48 | hours |
| "Recent" window for Done/Canceled | `pipeline_dashboard.doneWindowDays` | 7 | days |
| Tree-continue recency | `next_actions.treeRecentDoneDays` | 7 | days |
| `staleItems` age | `project_hygiene.staleDays` | 7 | days |
| Archive eligibility | `pipeline_dashboard.archiveThresholdDays` / `project_hygiene.archiveDays` | 14 | days |
| Orphaned Backlog age | `project_hygiene.orphanDays` | 14 | days |
| Velocity window | `pipeline_dashboard.velocityWindowDays` | 7 | days |

Same number, different name (`archiveThresholdDays` vs `archiveDays`). Same number, different meaning (`doneWindowDays` vs `staleDays` vs `treeRecentDoneDays` are all 7 but apply to different things). Different units in adjacent params (`stuckThresholdHours=48h` vs `doneWindowDays=7d`).

### Matrix 4 — Repo / board scope

| Tool | Queries | Sees orphan repo issues? |
|---|---|---|
| `next_actions` | Project board (via `DASHBOARD_ITEMS_QUERY`) | NO |
| `pipeline_dashboard` | Project board (`fetchDashboardItems`) | NO |
| `list_issues` | Project board (`projectQuery`) | NO |
| `project_hygiene` | Project board | NO |
| `recent_activity` | Local JSONL log | N/A |
| `health_check` | Both (auth + repo + project) | Reports access status |
| `gh issue list` (shell) | Repo issues API | YES |

**Hidden constraint**: a repo issue not added to the project board is invisible to every shorthand. On 2026-05-08 this manifested as 35 OPEN repo issues but only 4 on the project board — the other 31 were unreachable by any discovery tool.

### Matrix 5 — Audience parameter effect

| Tool | Has `audience`? | Effect when `audience="agent"` |
|---|---|---|
| `next_actions` | YES | Adds estimate penalty to score (M=+20, L=+40, XL=+60, unknown=+30). Candidate set unchanged. |
| `hello_directions` | NO (hardcoded "human") | N/A |
| `pick_actionable_issue` | NO (hardcoded "agent") | Plus `kind="issue"`-only filter, default `maxEstimate=S`, drops blocked items. |
| `pipeline_dashboard` / `list_issues` / `project_hygiene` / `recent_activity` | NO | N/A |

**Audience never widens the candidate set in any tool.** It is a scoring lever only.

### Matrix 6 — PR direction emission

`next_actions` PR handling:

| PR state | Emitted as direction? |
|---|---|
| `isDraft=true` | NO |
| `reviewDecision="APPROVED"` | NO ("waiting on merge, not user attention") |
| `reviewDecision="REVIEW_REQUIRED"` | YES (boost -200) |
| `reviewDecision="CHANGES_REQUESTED"`, fresh (≤24h) | NO (score-0 gate) |
| `reviewDecision="CHANGES_REQUESTED"`, stale (>24h) | YES (stale boost) |
| `reviewDecision=null`, fresh | NO (score-0 gate) |
| `reviewDecision=null`, stale | YES (stale boost) |

**`openPRs=[]` (the schema default) silences ALL PR direction emission.** Caller must fetch and pass PRs.

### Matrix 7 — Skills surface different subsets, no unified view

| Question a TPM/PO might ask | Which skill answers it? |
|---|---|
| "What should I work on next?" | `/hello` (calls `next_actions`) |
| "What's the state of the board?" | `/status` (calls `pipeline_dashboard`) |
| "What changed since I last looked?" | `/catch-up` (reads activity log) |
| "How are velocity / risk / WIP trending?" | `/trends` (snapshots + metrics_trends) |
| "What needs cleanup?" | `/ralph-hygiene` (calls `pipeline_dashboard` + `project_hygiene`) |
| "How many items are in Backlog?" | None — `/status` shows the Backlog phase but `/hello` filters it out, and there's no skill that shows Backlog with action prompts |
| "How many issues are not on the project board?" | None — no skill compares repo issues to project board |
| "Are there issues with no workflow state?" | `/status` (Unknown bucket) — but only if you read the JSON, the markdown often deemphasizes it |

## Code References

Primary implementation files referenced in this audit:

- `plugin/ralph-hero/mcp-server/src/lib/directions.ts:221-226` — `ACTIONABLE_PHASES` definition
- `plugin/ralph-hero/mcp-server/src/lib/directions.ts:318-323` — `audiencePenalty()` (the only audience-specific code)
- `plugin/ralph-hero/mcp-server/src/lib/directions.ts:781-782` — `isCandidatePhase(null)` returns false
- `plugin/ralph-hero/mcp-server/src/lib/directions.ts:826-833` — phase + lock-stale + unblock-signal filter
- `plugin/ralph-hero/mcp-server/src/lib/directions.ts:839-850` — blocker fallback (no analogous phase fallback)
- `plugin/ralph-hero/mcp-server/src/lib/directions.ts:909` — `merged.slice(0, config.limit)` final slice
- `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts:367-371` — `totalCandidates` assignment
- `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts:392` — `hello_directions` deprecation marker
- `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:243` — null-state items bucketed as "Unknown"
- `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:251-263` — `doneWindowDays` filter for Done/Canceled
- `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:805` — `totalIssues = items.length` (raw, pre-filter)
- `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts:116-130` — `archiveCandidates` rule (silent `subIssueCount=0` filter)
- `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts:152-164` — `orphanedItems` rule (Backlog-only)
- `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts:283-317` — `duplicateCandidates` Levenshtein
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:116-117` — `list_issues` default `state="OPEN"`
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:215-216` — `list_issues` queries Project board (not repo)
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:496` — `filteredCount = formattedItems.length` (post-filter, post-limit)
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1680-1800` — `pick_actionable_issue` deprecated wrapper
- `plugin/ralph-hero/mcp-server/src/lib/filter-profiles.ts:29-53` — `list_issues` named profiles
- `plugin/ralph-hero/mcp-server/src/lib/activity.ts:17-25` — `ActivityEvent` shape (no workflow state)
- `plugin/ralph-hero/mcp-server/src/lib/activity.ts:89` — default `category="work"` excludes meta
- `plugin/ralph-hero/skills/hello/SKILL.md:29` / `:40-45` — Step 1 parallel + Step 2 `next_actions` call
- `plugin/ralph-hero/skills/status/SKILL.md:36-43` — `pipeline_dashboard` invocation
- `plugin/ralph-hero/skills/catch-up/SKILL.md:33-37` — `recent_activity(category="work", limit=200)` call

## Architecture Documentation

### How the surfaces compose

The discovery surface is layered:

1. **`DASHBOARD_ITEMS_QUERY`** (`src/lib/dashboard-fetch.ts`) is the canonical project-board read. It paginates project items, capped at 500 per project. Used by `next_actions`, `pipeline_dashboard`, `project_hygiene`, `list_issues` (indirectly), and `pick_actionable_issue`.
2. **`toDashboardItems()`** converts raw nodes into a typed `DashboardItem[]` shape consumed by the higher-level libraries.
3. **`src/lib/directions.ts`** scores and ranks `DashboardItem[]` for `next_actions` / `hello_directions` / `pick_actionable_issue`.
4. **`src/lib/dashboard.ts`** aggregates `DashboardItem[]` into `PhaseSnapshot[]` for `pipeline_dashboard`.
5. **`src/lib/hygiene.ts`** applies six category rules to `DashboardItem[]` for `project_hygiene`.
6. **`src/lib/activity.ts`** is independent — reads a local JSONL log, not the project board.
7. **`src/lib/snapshots.ts` / `src/lib/trends.ts`** read JSONL snapshot history.

The shared dependency on `DashboardItem[]` is what makes the audit possible: every shorthand (except `recent_activity` and `metrics_trends`) ultimately operates on the same item set. Where they diverge is **after** that boundary, in their independent filtering and aggregation logic.

### Why the surfaces diverge

Each tool was added incrementally for a specific consumer:

- `next_actions` (originally `hello_directions`) was built for the `/hello` orchestration — its filter targets "what's pickable right now," which excluded Backlog by design (Backlog requires triage first, which a different skill handles).
- `pipeline_dashboard` was built for `/status` (and snapshots) — it answers "what's the shape of the board," which means showing every state.
- `list_issues` was built as a generic filtered list — its semantics mirror GitHub's CLI patterns.
- `project_hygiene` was built for `/ralph-hygiene` — its categories target specific cleanup actions.

No shared specification governs counts, threshold names, or visibility rules. Each tool's defaults reflect its consumer's needs.

### State machine reference

From `CLAUDE.md` and `src/lib/workflow-states.ts`:

```
Backlog → Research Needed → Research in Progress → Ready for Plan
       → Plan in Progress → Plan in Review → In Progress → In Review → Done
```

- **Terminal**: `Done`, `Canceled`
- **Lock states**: `Research in Progress`, `Plan in Progress`, `In Progress` (exclusive claim)
- **Parent gate states**: `Ready for Plan`, `Plan in Review`, `In Review`, `Done` (trigger parent advancement)
- **`ACTIONABLE_PHASES`** (in `directions.ts`, NOT in `workflow-states.ts`): `Plan in Review`, `In Review`, `Ready for Plan`, `Research Needed` — a tool-specific subset, not a state-machine concept

The fact that `ACTIONABLE_PHASES` is defined in `directions.ts` rather than `workflow-states.ts` is the structural reason it can drift from the state machine without test failures: it is a private contract of one tool, not a shared definition.

## Historical Context (from thoughts/)

- **`GH-1129` (2026-05-07)** — `list_issues` totalCount misleading. Research and plan exist documenting the same `filteredCount` confusion this audit hits. Plan describes intent to add a separate `totalCount` field; status of implementation unverified against current code.
- **`GH-921` (2026-04-30)** — Hello directions implementation. Defines the deterministic ranking spec adopted by `next_actions`, including `ACTIONABLE_PHASES`.
- **`GH-572` (2026-04-25)** — ralph-hygiene audit. Evaluates board cleanup effectiveness; touches archive rules.
- **`GH-571` (2026-04-25)** — `/status` and `/report` audit. Notes `/status` is a snapshot view, `/report` includes trends.
- **`GH-115` (2026-02-19)** — Archive stats added to `pipeline_dashboard`. Defines `doneWindowDays` semantics.
- **`GH-139` (2026-02-20)** — Velocity metrics + auto-status determination. Defines the `atRiskThreshold` / `offTrackThreshold` defaults.
- **`GH-142` (2026-02-20)** — `exclude*` negation filters. Documents that exclusion filters create silent drops.
- **`GH-141` group plan (2026-02-20)** — `has` / `no` / negation filter semantics across list tools.
- **`GH-26` (2026-02-16)** — Original pipeline_dashboard spec.
- **`GH-114` (2026-02-21)** — Original `project_hygiene` spec.
- **`GH-330` (2026-02-22)** — Per-stream dashboard status.
- **`GH-520` (2026-03-04)** — Suppress `oversized_in_pipeline` for issues with sub-issues.
- **`GH-674` (2026-03-24)** — Agent-per-phase architecture. Touches tool-access consistency across phases.
- **`GH-431` (2026-03-01)** — `list_groups` tool — discovery without scanning full backlog.
- **`GH-428` (2026-02-27)** — Repo filter for `list_issues` in multi-repo projects.
- **`hygiene-pipeline-multi-repo` (2026-03-14)** — Cross-tool aggregation comparison.
- **`hello-composable-rewrite` (2026-05-02)** — Plan to recompose `/hello` as micro-skills with audience filtering.

## Related Research

- [[2026-05-07-GH-1129-list-issues-totalcount-misleading]] — direct precursor on count-field semantics
- [[2026-04-30-group-GH-0921-hello-directions-implementation]] — canonical `next_actions` ranking spec
- [[2026-05-02-hello-composable-rewrite]] — `/hello` skill composition rewrite
- [[2026-04-25-GH-0572-ralph-hygiene-audit]] — board cleanup effectiveness
- [[2026-04-25-GH-0571-status-report-audit]] — `/status` and `/report` audit
- [[2026-02-19-GH-0115-archive-stats-pipeline-dashboard]] — archive stats and `doneWindowDays`
- [[2026-02-21-GH-0114-project-hygiene-reporting-tool]] — `project_hygiene` original spec
- [[2026-03-14-hygiene-pipeline-multi-repo-aggregation]] — cross-tool aggregation
- [[2026-02-20-GH-0142-exclude-negation-filters-list-issues]] — `exclude*` filter semantics

## Open Questions

These are gaps surfaced by the audit that are NOT answered by current code or prior research; they would inform a follow-up consistency plan.

1. **Does any consumer rely on `next_actions` excluding `Backlog`?** The `/hello` skill expects an "actionable" list; widening to Backlog would change `/hello`'s behavior. Is that desired or harmful?
2. **What is the canonical answer to "how many items are on the board"?** `next_actions.totalCandidates` and `pipeline_dashboard.totalIssues` should agree, but they query independently with no shared assertion. Are there cases where they diverge in practice?
3. **Should there be a `totalCount` (pre-limit) field on `list_issues`?** `GH-1129` plan proposes one — implementation status unverified.
4. **Are there tests asserting cross-tool consistency?** Each tool has unit tests, but is there an integration test that calls `next_actions`, `pipeline_dashboard`, and `list_issues` against the same fixture and asserts the counts agree where they should?
5. **How would a TPM/PO unify these views without reading code?** Currently, no skill or doc exposes the discrepancies. Onboarding docs in `CLAUDE.md` reference state machines but not count semantics.
6. **Is the repo-vs-project-board scope mismatch documented anywhere user-facing?** `health_check` validates access but does not surface "you have N orphan repo issues not on the board."
7. **Does `pick_actionable_issue` (deprecated) still get called?** A grep for its tool name across `plugin/ralph-hero/skills/` and `agents/` would reveal whether the 2.7.0 removal is safe.
8. **What's the relationship between `recent_activity` events and project-board state?** Activity events have a `target` but no workflow-state tracking — does the activity log lose information about which board state changes happened?
9. **Are there discovery surfaces missing from this audit?** Specifically: `list_sub_issues`, `list_dependencies`, `list_groups` (relationship-tools.ts) were enumerated but not deep-audited. Also `archive_items` (project-management-tools.ts) which has its own candidate-detection logic with a 2000-item hard cap.
10. **What does `audiencePenalty` for `unknown=+30` cover?** The penalty applies to items with no estimate — same as M=+20 plus +10. This is a hidden behavior of `audience="agent"` that effectively de-prioritizes unestimated work. Is that intended?
