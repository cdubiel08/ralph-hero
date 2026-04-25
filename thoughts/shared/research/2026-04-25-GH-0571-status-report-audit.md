---
date: 2026-04-25
github_issue: 571
github_url: https://github.com/cdubiel08/ralph-hero/issues/571
status: complete
type: research
tags: [skill-audit, dashboard, pipeline, reporting, read-only-skills]
---

# Audit: status and report skills — eval dashboard and reporting quality

## Prior Work

- builds_on:: None identified.
- tensions:: None identified.

## Problem Statement

Phase 2 of the skill audit (#566) requires a deep audit of the `status` and `report` skills — the two read-only ops skills that surface pipeline information to users and stakeholders. Phase 1 (PR #565) fixed systemic issues (missing MCP tools, `Task()` → `Agent()` rename, interactive/autonomous description confusion). This audit evaluates output format quality, triggering differentiation from `hello`, and the report skill's auto-status logic.

## Current State Analysis

### status Skill (plugin/ralph-hero/skills/status/SKILL.md)

**Frontmatter:**
- `description`: "Display pipeline status dashboard with health indicators. Shows issue counts per workflow phase, identifies stuck issues, WIP violations, and blocked dependencies. First read-only skill - no state changes."
- `user-invocable`: not set (defaults to true — the skill file does not have this key)
- `argument-hint`: `"[optional: markdown|ascii|json]"`
- `context`: fork
- `model`: haiku
- `allowed-tools`: `Read`, `Bash`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard`

**Workflow (4 steps):**
1. Parse argument for output format (default: markdown)
2. Fetch pipeline dashboard with `format` and `includeHealth: true`
3. Display the `formatted` field (for markdown/ascii) or structured data (for json)
4. Highlight critical health warnings prominently

**Assessment:** The skill is remarkably lean — 35 lines total including frontmatter. It correctly uses `pipeline_dashboard` with `includeHealth: true`. The instruction to "not add additional commentary" is a good constraint. The `Bash` tool is listed in `allowed-tools` but the skill body never uses it — this is dead weight.

### report Skill (plugin/ralph-hero/skills/report/SKILL.md)

**Frontmatter:**
- `description`: "Generate and post a project status report. Queries pipeline dashboard with velocity metrics, composes a markdown report, auto-determines health status (ON_TRACK/AT_RISK/OFF_TRACK), and posts via GitHub Projects V2 status updates."
- `argument-hint`: `"[optional: --dry-run] [optional: --window N] [optional: --status ON_TRACK|AT_RISK|OFF_TRACK]"`
- `context`: fork
- `model`: sonnet
- `allowed-tools`: `Read`, `Bash`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_status_update`

**Workflow (6 steps):**
1. Parse arguments: `--dry-run`, `--window N`, `--status ON_TRACK|AT_RISK|OFF_TRACK`
2. Fetch pipeline dashboard with `format: "json"`, `includeHealth: true`, `includeMetrics: true`, `doneWindowDays`, `velocityWindowDays`
3. Handle metrics fallback (if `metrics` field absent, derive from `health.ok`)
4. Compose markdown report from template
5. Determine final status (manual override or from metrics)
6. Post via `create_status_update` or display if `--dry-run`

**Assessment:** Well-structured with clear fallback logic. The report template is explicit in the skill body. The `Read` and `Bash` tools are listed but never used — dead weight.

### hello Skill (plugin/ralph-hero/skills/hello/SKILL.md)

For differentiation comparison:
- `description`: explicitly lists trigger phrases ("what should I work on", "what needs attention", session-start greetings)
- Uses `pipeline_dashboard` with `format: "json"`, `includeHealth: true`, `includeMetrics: false`, `issuesPerPhase: 3`
- Also reads memory and fetches open PRs
- Conversational tone; explicitly forbidden from rendering dashboard output
- Routes to autonomous agents

## Key Discoveries

### 1. Triggering Differentiation — Partially Clear but Gaps Exist

The `hello` skill description is exhaustive in listing triggers. By contrast:

- `status` description says "Display pipeline status dashboard" — accurate but doesn't state WHEN to use it vs `hello`. A user asking "what's on the board?" could trigger either skill.
- `report` description correctly distinguishes by mentioning "post via GitHub Projects V2 status updates" — this is write behavior that distinguishes it from `status`.
- The three-way differentiation between `hello` (conversational orient), `status` (raw dashboard view), and `report` (stakeholder report + post) is conceptually sound but only `hello` documents its triggers explicitly.

**Gap:** `status` SKILL.md has no "Use when" guidance. A user saying "show me the pipeline" or "what's the board status?" should trigger `status`, not `hello`. This should be disambiguated in the description or as a `## Use When` note in the body.

### 2. Dashboard Output Quality — status Skill

The `pipeline_dashboard` MCP tool returns:
- `formatted` field for markdown/ascii: a markdown table with phase | count | points | issues columns
- Health warnings section with `[CRITICAL]`, `[WARNING]`, `[INFO]` tags
- Archive eligibility section (eligible count, recently completed, eligible items table)
- Optional per-project, per-repo breakdowns

The `status` skill instruction to "Display the `formatted` field directly" is correct — the MCP tool generates the formatted output and the skill surfaces it unchanged. The "Do not add additional commentary unless there are critical health warnings" constraint is good for signal-to-noise.

**Finding:** The `status` skill correctly delegates formatting to the MCP layer. No quality issue here.

**Observation on `includeMetrics`:** `status` does NOT pass `includeMetrics: true`. This is intentional — the status skill is a snapshot view, not a trend analysis. Metrics belong to `report`. This is the correct separation.

### 3. Dashboard Output Quality — report Skill

The `report` skill fetches with `includeMetrics: true` which invokes `calculateMetrics()` in `plugin/ralph-hero/mcp-server/src/lib/metrics.ts`. The metrics library computes:
- `velocity`: count of Done items within `velocityWindowDays`
- `riskScore`: sum of health warning severity weights (critical=3, warning=1, info=0)
- `status`: ON_TRACK (riskScore < 2), AT_RISK (2 ≤ riskScore < 6), OFF_TRACK (≥ 6)
- `highlights.recentlyCompleted`: Done phase items (already time-filtered)
- `highlights.newlyAdded`: Backlog items with ageHours within window

The report template in the skill body is well-structured and directly maps to what the MCP tool returns.

**Anti-pattern found — GH-139 reference in skill body:**

The skill body references "the metrics library from GH-139 is not yet deployed" as the condition for metrics fallback. However, the `metrics.ts` library IS deployed in the current codebase. This is stale documentation — the fallback logic for missing metrics was appropriate during development but is now an orphaned comment. The fallback path remains correct behavior if `includeMetrics` were unexpectedly false, but the GH reference creates confusion.

### 4. pipeline_dashboard MCP Tool Integration

Both skills use `pipeline_dashboard` correctly:

| Parameter | status | report | hello |
|-----------|--------|--------|-------|
| `format` | `markdown` (arg-driven) | `json` | `json` |
| `includeHealth` | `true` | `true` | `true` |
| `includeMetrics` | (not passed) | `true` | `false` |
| `issuesPerPhase` | (not passed, default 10) | (not passed) | `3` |
| `doneWindowDays` | (not passed) | `--window` arg | (not passed) |
| `velocityWindowDays` | (not passed) | `--window` arg | (not passed) |

**Finding:** `status` could benefit from passing `issuesPerPhase` as a sensible limit — the default of 10 may produce very long output for large boards. `hello` explicitly limits to 3 for token efficiency. `status` has no such guard.

**Finding:** `blockedBy` is hardcoded to `[]` in `toDashboardItems()` in `dashboard-tools.ts` with the comment "blockedBy requires separate queries; omit for now." This means the `blocked` warning type in `detectHealthIssues()` is never triggered via the dashboard. Both `status` and `report` display "blocked" as a possible health warning type but it will always be absent. This is an MCP tool limitation, not a skill limitation.

### 5. report Auto-Status Determination Logic

The auto-determination uses three thresholds (defaults):
- ON_TRACK: riskScore < 2
- AT_RISK: 2 ≤ riskScore < 6
- OFF_TRACK: riskScore ≥ 6

Weights: critical=3, warning=1, info=0

This means:
- 0 warnings → ON_TRACK
- 1 warning → ON_TRACK (score=1)
- 2 warnings → AT_RISK (score=2)
- 2 critical warnings → OFF_TRACK (score=6)
- 1 critical + 3 warnings → OFF_TRACK (score=6)

The `--status` override allows manual designation, which is the right escape hatch.

**Issue found:** `pipeline_gap` warnings fire for every empty non-terminal, non-Backlog state in the pipeline — and an active board will typically have many empty states (e.g., "Plan in Review" is often empty). A board with 6 empty pipeline gap warnings accumulates info-score=0 (info warnings have weight=0). So pipeline gaps do NOT inflate risk scores. This is correct behavior.

**Issue found:** `lock_collision` (multiple issues in same lock state) fires as `critical` severity. On a typical board, this is an unusual but valid situation. Two critical lock_collision warnings = riskScore=6 → OFF_TRACK. This threshold feels appropriate.

**Issue found:** The fallback logic in the skill body (Step 3) references "GH-139" which is stale. The metrics library was shipped; the fallback path is now dead code in terms of the GH-139 condition, though the technical fallback (using `health.ok` for status) remains correct if `includeMetrics=false` or if metrics is unexpectedly absent.

### 6. Anti-Patterns and Duplication

**Dead allowed-tools:**
- `status` lists `Bash` and `Read` but uses neither
- `report` lists `Bash` and `Read` but uses neither

**Stale GH reference:** `report` SKILL.md Step 3 references "the metrics library from GH-139 is not yet deployed" — GH-139 is closed/delivered. The condition should be rephrased to describe the technical condition: "If the response does not contain a `metrics` field."

**Missing `subIssueCount` in DashboardItem conversion:** `toDashboardItems()` sets `subIssueCount: r.content.subIssues?.totalCount ?? 0` but the GraphQL query doesn't include `subIssues { totalCount }` in the Issue fragment of `DASHBOARD_ITEMS_QUERY`. This means `subIssueCount` is always 0 in dashboard output, preventing the `oversized_in_pipeline` health check from correctly filtering out parent issues (which have sub-issues and shouldn't be flagged as oversized). This is an MCP tool bug that affects both skills indirectly.

**Duplication with hello:** Both `hello` and `status` fetch the pipeline dashboard. But `hello` synthesizes conversationally, while `status` displays raw dashboard output. The duplication is intentional — different consumers, different models, different output philosophies. No consolidation needed.

**No `user-invocable` key in status SKILL.md:** The `status` skill omits the `user-invocable` key (defaults to true based on the plugin system). Since it is user-invocable, this is fine — but the skill should be consistent with other user-invocable skills that explicitly set this.

## Potential Approaches

### Option A: Minimal targeted fixes (recommended)

1. Remove `Bash` and `Read` from `allowed-tools` in both skills
2. Remove GH-139 reference from `report` SKILL.md Step 3, replace with technical condition description
3. Add a `## Use When` or "Use this skill when" inline note to `status` SKILL.md to differentiate from `hello`
4. Add `issuesPerPhase: 5` or similar limit to `status` skill invocation for large-board output control
5. Add `user-invocable: true` to `status` SKILL.md for consistency

### Option B: Also fix MCP tool bugs (broader scope)

Option A, plus:
- Fix `blockedBy` not being populated in `toDashboardItems()` (requires additional GraphQL queries — out of scope for this audit)
- Fix `subIssues { totalCount }` not being fetched in `DASHBOARD_ITEMS_QUERY` (simpler fix — add the field to the query)

Option B involves touching MCP server code, which requires a separate test run and version bump. The skill-only fixes in Option A are safe to ship without touching the MCP server.

## Risks

- Removing `Bash`/`Read` from allowed-tools: low risk (they were unused anyway)
- Adding `issuesPerPhase` limit to `status`: minor risk of truncating useful data; default of 5-10 is safe
- Fixing `subIssues` query gap: requires MCP server rebuild and publish; not appropriate for a skill-only audit

## Recommended Next Steps

1. Plan should target `status/SKILL.md` and `report/SKILL.md` for skill-only changes (Options A)
2. Raise a separate issue for the MCP tool bugs (blockedBy empty, subIssues missing from query) — these are backend fixes that belong in a different audit track
3. The GH-139 fallback path should be rephrased but kept — it provides correct fallback if `metrics` is absent for any reason

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/status/SKILL.md` - Remove dead allowed-tools (Bash, Read), add use-when guidance, add issuesPerPhase, add user-invocable: true
- `plugin/ralph-hero/skills/report/SKILL.md` - Remove dead allowed-tools (Bash, Read), rephrase stale GH-139 fallback condition

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` - pipeline_dashboard tool implementation and parameter spec
- `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` - DashboardData structure, health warning types, formatMarkdown/formatAscii
- `plugin/ralph-hero/mcp-server/src/lib/metrics.ts` - calculateMetrics, determineStatus, risk scoring thresholds
- `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts` - create_status_update tool spec
- `plugin/ralph-hero/skills/hello/SKILL.md` - hello skill for triggering differentiation comparison
- `plugin/ralph-hero/mcp-server/src/__tests__/metrics.test.ts` - metrics test coverage validation
