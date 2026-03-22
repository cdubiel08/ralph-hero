# Outcome Ledger for ralph-knowledge

**Date:** 2026-03-21
**Status:** Draft
**Scope:** ralph-knowledge MCP server + ralph-hero hook infrastructure

## Problem

Ralph-hero's pipeline captures rich data at every phase — research findings, plan accuracy, validation verdicts, drift counts, implementation durations — but this data lives in prose markdown reports and GitHub issue comments. No structured, queryable record exists. Planning and research agents can't answer questions like "what's the average drift rate for plans touching `src/tools/`?" or "what estimate size correlates with validation failures?"

Autoresearch solves this with `results.tsv` — a simple append-only experiment ledger. Ralph-hero needs the equivalent: a structured outcome ledger that closes the feedback loop from post-mortem back to research and planning.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Data source | Real-time event emission (not retroactive parsing) | Clean data from the start; prose parsing is fragile |
| Storage | New table in existing `knowledge.db` | Outcomes are knowledge — should be joinable with documents |
| Schema | Typed envelope + JSON payload (hybrid) | Promoted columns for hot queries, unlimited JSON extensibility |
| Write mechanism | PostToolUse hook (`outcome-collector.sh`) | Zero skill modifications; observes existing tool calls |
| Read interface | Two new MCP tools + `knowledge_search` enrichment | Explicit queries + passive surfacing |
| Parameter breadth | Capture everything | Collection is cheap; query selectivity can come later |

## Data Model

### `outcome_events` table

Added to `knowledge.db` alongside `documents`, `tags`, `relationships`.

```sql
CREATE TABLE IF NOT EXISTS outcome_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  session_id TEXT,
  timestamp TEXT NOT NULL,

  -- Promoted columns (indexed, commonly filtered/aggregated)
  duration_ms INTEGER,
  verdict TEXT,
  component_area TEXT,
  estimate TEXT,
  drift_count INTEGER,
  model TEXT,
  agent_type TEXT,
  iteration_count INTEGER,

  -- Flexible payload
  payload TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_oe_type ON outcome_events(event_type);
CREATE INDEX IF NOT EXISTS idx_oe_issue ON outcome_events(issue_number);
CREATE INDEX IF NOT EXISTS idx_oe_component ON outcome_events(component_area);
CREATE INDEX IF NOT EXISTS idx_oe_timestamp ON outcome_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_oe_session ON outcome_events(session_id);
CREATE INDEX IF NOT EXISTS idx_oe_type_component ON outcome_events(event_type, component_area);
```

### Promoted columns

| Column | Type | Purpose |
|---|---|---|
| `id` | TEXT | UUID v4, generated server-side |
| `event_type` | TEXT | Event classification (see Event Types) |
| `issue_number` | INTEGER | GitHub issue number |
| `session_id` | TEXT | Team/hero session identifier |
| `timestamp` | TEXT | ISO 8601, generated server-side |
| `duration_ms` | INTEGER | Wall clock duration for this event |
| `verdict` | TEXT | `pass`, `fail`, `approved`, `needs_iteration`, `keep`, `discard`, `crash` |
| `component_area` | TEXT | Common path prefix of affected files (e.g., `src/tools/`) |
| `estimate` | TEXT | Issue estimate: `XS`, `S`, `M`, `L`, `XL` |
| `drift_count` | INTEGER | Files modified outside plan scope |
| `model` | TEXT | LLM model used: `opus`, `sonnet`, `haiku` |
| `agent_type` | TEXT | `analyst`, `builder`, `integrator` |
| `iteration_count` | INTEGER | Retry/review cycles |

### Payload JSON

Arbitrary per-event data. No schema enforcement. Examples per event type documented in Event Types section.

### Link to documents table

Joined via `issue_number` ↔ `documents.github_issue`. No foreign key constraint — events may reference issues with no document yet, and documents may have multiple issue numbers.

## Event Types

Duration is NOT computed at write time. The hook emits `*_started` and `*_completed` events with their own timestamps. Duration is computed at query time by pairing events on `issue_number + event_type prefix`.

| Event Type | Emitter Context | Promoted Columns | Payload Examples |
|---|---|---|---|
| `research_started` | `save_issue(__LOCK__, command=ralph_research)` | `component_area`, `model` | `{}` |
| `research_completed` | `save_issue(__COMPLETE__, command=ralph_research)` | `component_area`, `model` | `{files_identified: [], files_will_modify: [], files_will_read: [], sub_agents_spawned: 4, tokens_used: 45000}` |
| `plan_started` | `save_issue(__LOCK__, command=ralph_plan)` | `estimate`, `component_area` | `{}` |
| `plan_completed` | `save_issue(__COMPLETE__, command=ralph_plan)` | `estimate`, `component_area`, `model`, `iteration_count` | `{phase_count: 3, total_files_planned: [], total_tasks: 8, tdd_tasks: 5, verification_criteria_count: 12}` |
| `review_completed` | `save_issue` with verdict routing | `verdict`, `model`, `iteration_count` | `{review_mode: "auto", critique_path: "...", issues_found: 3, severity_breakdown: {critical: 0, major: 1, minor: 2}}` |
| `phase_started` | `save_issue(__LOCK__, command=ralph_impl)` | `component_area`, `model`, `agent_type` | `{phase_number: 1, task_count: 3, planned_files: []}` |
| `task_completed` | `TaskCompleted` event | `agent_type` | `{task_subject: "Implement GH-617", teammate_name: "builder"}` |
| `phase_completed` | `save_issue(__COMPLETE__, command=ralph_impl)` | `drift_count`, `component_area`, `verdict`, `iteration_count` | `{phase_number: 1, predicted_files: [], actual_files: [], drift_files: [], tokens_used: 80000}` |
| `validation_completed` | `save_issue` with validation verdict | `verdict`, `drift_count` | `{criteria_total: 8, criteria_passed: 7, criteria_failed: 1, failed_criteria: ["grep pattern in file.ts"]}` |
| `pr_completed` | `save_issue(__COMPLETE__, command=ralph_pr)` | `component_area` | `{pr_number: 621, files_changed: 12, lines_added: 450, lines_removed: 30, branch: "feature/GH-617"}` |
| `blocker_recorded` | `knowledge_record_outcome` (manual, from postmortem skill) | `agent_type` | `{blocker_type: "escalation", description: "...", created_issue_number: 650}` |
| `impediment_recorded` | `knowledge_record_outcome` (manual, from postmortem skill) | `agent_type` | `{impediment_type: "idle_delay", description: "...", self_resolved: true}` |
| `session_completed` | `knowledge_record_outcome` (manual, from postmortem skill) | `session_id` | `{issues_processed: 4, issues_completed: 4, workers: {analyst: 1, builder: 1, integrator: 1}, total_tokens: 500000}` |
| `merge_completed` | `save_issue(__COMPLETE__, command=ralph_merge)` | | `{pr_number: 621, merge_method: "squash", worktree_cleaned: true}` |

This list is non-exhaustive. Any event type with any payload can be recorded. The above is the expected baseline from current pipeline phases.

**Note on `task_completed`:** The `TaskCompleted` hook event only exposes `task_subject` and `teammate_name`. Promoted columns like `duration_ms`, `model`, and `tokens_used` are NOT available from the hook payload. The `agent_type` is inferred from `teammate_name` (e.g., "builder" → `agent_type: "builder"`). Richer task-level data can be recorded via `knowledge_record_outcome` if skills are later updated to emit it.

**Note on blockers/impediments/session events:** These are NOT captured by the hook (which would require fragile prose parsing of post-mortem reports). Instead, the `ralph-postmortem` skill is the single exception to "zero skill modifications" — it calls `knowledge_record_outcome` directly for these three event types, since it already has the structured data in memory during report generation.

## Write Path: `outcome-collector.sh`

### Design

A single stateless shell script. Each invocation reads tool call context, constructs one INSERT, writes to `knowledge.db` via `sqlite3` CLI, and exits. No background processes, no clocks, no state between invocations.

The DB path is read from `RALPH_KNOWLEDGE_DB` env var (same one the MCP server uses), falling back to `~/.ralph-hero/knowledge.db`.

### Hook Registration

The script is registered at two levels:

**Plugin-level (`hooks.json`):**

| Hook Event | What It Catches |
|---|---|
| `PostToolUse(ralph_hero__save_issue)` | State transitions: research/plan/review/impl/val/pr/merge start and completion |
| `PostToolUse(Write)` | Plan/research doc writes — enriches with parsed file metadata |

**Team skill frontmatter (`skills/team/SKILL.md`):**

| Hook Event | What It Catches |
|---|---|
| `TaskCompleted` | Task-level events: agent_type inferred from teammate name |

`TaskCompleted` is a skill-scoped event, not available at plugin level. This is the only split in registration.

### Internal Branching

```
# Ensure table exists (hook may fire before MCP server starts)
CREATE TABLE IF NOT EXISTS outcome_events (...)

# Set WAL mode (idempotent, matches MCP server) + busy timeout
PRAGMA journal_mode=WAL
PRAGMA busy_timeout=3000

if tool == "ralph_hero__save_issue":
    Read command, workflowState, issue_number from tool params
    Map (command, workflowState) → event_type:
      (ralph_research, __LOCK__)      → research_started
      (ralph_research, __COMPLETE__)  → research_completed
      (ralph_plan, __LOCK__)          → plan_started
      (ralph_plan, __COMPLETE__)      → plan_completed
      (ralph_review, *)               → review_completed (verdict from params)
      (ralph_impl, __LOCK__)          → phase_started
      (ralph_impl, __COMPLETE__)      → phase_completed
      (ralph_val, *)                  → validation_completed (verdict from params)
      (ralph_pr, __COMPLETE__)        → pr_completed
      (ralph_merge, __COMPLETE__)     → merge_completed
    Extract available promoted columns from tool params
    INSERT into outcome_events

elif tool == "Write" && path matches thoughts/shared/(plans|research)/*:
    Extract issue_number from filename GH-NNNN pattern (e.g., "2026-03-21-GH-0617-foo.md" → 617)
    If no GH-NNNN in filename → skip (no event emitted)
    Determine subtype from path segment:
      /plans/    → grep for "## Phase" headings (count), "files:" entries (list)
      /research/ → grep for "### Will Modify" and "### Will Read" sections (file lists)
    Find most recent *_completed event for this issue_number:
      SELECT id FROM outcome_events
        WHERE issue_number = $N AND event_type LIKE '%_completed'
        ORDER BY timestamp DESC LIMIT 1
    If found → UPDATE payload (json_patch merge) with extracted metadata
    If not found → skip (enrichment is best-effort, not standalone events)

elif event == "TaskCompleted":
    Infer agent_type from teammate_name
    INSERT task_completed event with task_subject in payload
```

### Concurrent Access

The hook sets `PRAGMA busy_timeout=3000` before every INSERT. This handles the dual-writer pattern (hook via `sqlite3` CLI + MCP server via `better-sqlite3`) under WAL mode. In team mode with multiple workers completing phases simultaneously, the 3-second timeout provides sufficient retry window. If the timeout is exceeded, the hook logs a warning and exits 0 — the event is dropped silently.

### Failure Handling

If `sqlite3` fails (DB locked beyond timeout, missing binary, etc.), the hook logs a warning to stderr and exits 0. Outcome collection never blocks the pipeline.

### Data Availability

The hook has access to:
- Tool call parameters (JSON on stdin or env vars, per Claude Code hook protocol)
- Tool call result (for PostToolUse hooks)
- Environment variables (`RALPH_KNOWLEDGE_DB`, `RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_SESSION_ID`)
- The filesystem (can read files just written by `Write` tool)
- `sqlite3` CLI

It does NOT have access to:
- Other MCP servers (no MCP calls from hooks)
- Conversation context or agent memory
- Token usage (not exposed to hooks — captured in payload only when skills pass it via task metadata)

## Read Path: MCP Tools

### `knowledge_record_outcome`

Manual write tool for cases where the hook can't capture data (e.g., ad-hoc experiments, manual annotations, backfill).

```typescript
server.tool("knowledge_record_outcome", "Record a pipeline outcome event", {
  event_type: z.string().describe("Event type (e.g., 'phase_completed')"),
  issue_number: z.number().describe("GitHub issue number"),
  session_id: z.string().optional(),
  duration_ms: z.number().optional(),
  verdict: z.string().optional(),
  component_area: z.string().optional(),
  estimate: z.string().optional(),
  drift_count: z.number().optional(),
  model: z.string().optional(),
  agent_type: z.string().optional(),
  iteration_count: z.number().optional(),
  payload: z.record(z.unknown()).optional().describe("Arbitrary JSON payload"),
});
// Returns: { id, event_type, issue_number, timestamp }
```

Generates `id` (UUID v4) and `timestamp` (ISO 8601 now) server-side. Single INSERT.

### `knowledge_query_outcomes`

Read tool for research/planning agents.

```typescript
server.tool("knowledge_query_outcomes", "Query outcome events with optional aggregation", {
  issue_number: z.number().optional().describe("Filter to specific issue"),
  event_type: z.string().optional().describe("Filter by event type"),
  component_area: z.string().optional().describe("Filter by component (prefix match)"),
  estimate: z.string().optional().describe("Filter by estimate size"),
  verdict: z.string().optional().describe("Filter by verdict"),
  session_id: z.string().optional().describe("Filter by session"),
  since: z.string().optional().describe("ISO date — only events after this"),
  limit: z.number().optional().describe("Max results, default 50"),
  aggregate: z.boolean().optional().describe("Return computed stats instead of raw rows"),
});
```

**When `aggregate=false` (default):** Returns raw event rows, most recent first, up to `limit`.

**When `aggregate=true`:** Returns computed statistics:
- `count` of matching events
- `avg_duration_ms`, `p50_duration_ms`, `p90_duration_ms`
- `verdict_distribution` (counts per verdict value)
- `avg_drift_count`
- `avg_iteration_count`
- `top_component_areas` (most frequent, with counts)
- `event_type_distribution` (counts per event type)

### Duration Computation

Duration is computed at query time by pairing `*_started` and `*_completed` events:

```sql
-- For unique event types (research, plan, pr): pair by issue_number
SELECT
  c.issue_number,
  c.event_type,
  CAST(
    (julianday(c.timestamp) - julianday(s.timestamp)) * 86400000
    AS INTEGER
  ) AS duration_ms
FROM outcome_events c
JOIN outcome_events s
  ON s.issue_number = c.issue_number
  AND s.event_type = REPLACE(c.event_type, '_completed', '_started')
WHERE c.event_type IN ('research_completed', 'plan_completed')

UNION ALL

-- For phase events: disambiguate by phase_number in payload
SELECT
  c.issue_number,
  c.event_type,
  CAST(
    (julianday(c.timestamp) - julianday(s.timestamp)) * 86400000
    AS INTEGER
  ) AS duration_ms
FROM outcome_events c
JOIN outcome_events s
  ON s.issue_number = c.issue_number
  AND s.event_type = 'phase_started'
  AND json_extract(s.payload, '$.phase_number') = json_extract(c.payload, '$.phase_number')
WHERE c.event_type = 'phase_completed'
```

Phase events carry `phase_number` in their payload to avoid cross-product joins when an issue has multiple phases. The hook extracts `phase_number` from the `save_issue` tool params when available.

The `duration_ms` promoted column on individual rows remains available for events recorded via `knowledge_record_outcome` where the caller knows the duration upfront.

### `knowledge_search` Enrichment

When `knowledge_search` returns a document with a `github_issue`, the response includes an `outcomes_summary` field:

```json
{
  "id": "2026-03-19-GH-0616-playwright-research",
  "title": "Research: ralph-playwright",
  "outcomes_summary": {
    "total_events": 12,
    "latest_verdict": "pass",
    "total_duration_ms": 1560000,
    "drift_count": 2,
    "blockers": 0,
    "events_by_type": {
      "research_completed": 1,
      "plan_completed": 4,
      "phase_completed": 4,
      "validation_completed": 4
    }
  }
}
```

Computed via a single subquery grouped by `event_type` for each result's `github_issue`. Adds negligible latency at current scale.

## Schema Changes in ralph-knowledge

### `db.ts`

- Add `outcome_events` table creation to `createSchema()`
- Add `insertOutcomeEvent()` method
- Add `queryOutcomeEvents()` method with filter parameters
- Add `aggregateOutcomeEvents()` method with statistical computations
- Add `getOutcomeSummary(issueNumber)` method for search enrichment

### `index.ts`

- Register `knowledge_record_outcome` tool
- Register `knowledge_query_outcomes` tool
- Modify `knowledge_search` handler to call `getOutcomeSummary()` and attach to results

### `reindex.ts`

- `outcome_events` table is NOT cleared during reindex — it is append-only and not derived from markdown files. The `clearAll()` method skips this table.

### `parser.ts`

- No changes.

## Hook Changes in ralph-hero

### New file: `hooks/scripts/outcome-collector.sh`

Single script, ~200-250 lines. Self-contained — includes its own `CREATE TABLE IF NOT EXISTS` so it works regardless of MCP server startup order.

### Hook settings registration

- **Plugin-level:** Add `PostToolUse(ralph_hero__save_issue)` and `PostToolUse(Write)` entries in `plugin/ralph-hero/hooks.json` pointing to `outcome-collector.sh`
- **Skill-level:** Add `TaskCompleted` entry in `skills/team/SKILL.md` frontmatter pointing to `outcome-collector.sh`

### Postmortem skill modification

The `ralph-postmortem` skill is the single exception to "zero skill changes." It adds `knowledge_record_outcome` calls for `blocker_recorded`, `impediment_recorded`, and `session_completed` events, since it already holds this data in structured form during report generation. This is ~5 lines of additions to the skill.

## Migration

Existing `knowledge.db` files are handled safely:
- `createSchema()` uses `CREATE TABLE IF NOT EXISTS` — the new table is added on next MCP server start or hook invocation without affecting existing tables.
- `clearAll()` is modified to skip `outcome_events` — reindexing documents does not delete outcome data.
- No data migration needed — the ledger starts empty and accumulates from first hook firing.

## Testing

### ralph-knowledge (`plugin/ralph-knowledge/src/__tests__/`)

- `db.test.ts` — `insertOutcomeEvent`, `queryOutcomeEvents`, `aggregateOutcomeEvents`, `getOutcomeSummary` (with and without linked events)
- `index.test.ts` — `knowledge_record_outcome` and `knowledge_query_outcomes` MCP tool registration and invocation; `knowledge_search` enrichment with `outcomes_summary`
- Duration computation test — verify `*_started`/`*_completed` pairing produces correct durations

### ralph-hero (`plugin/ralph-hero/hooks/scripts/__tests__/`)

- `outcome-collector.sh` — test each branch (save_issue, Write, TaskCompleted) with mock tool params, verify INSERT into a test SQLite DB
- Verify exit 0 on DB errors (missing sqlite3, locked DB)
- Verify `CREATE TABLE IF NOT EXISTS` idempotency

## What This Does NOT Do

- **No retroactive parsing** — Historical post-mortem reports are not backfilled. The ledger starts from when the hook is deployed.
- **No background processes** — No daemons, no scheduled jobs, no clocks.
- **Near-zero skill modifications** — Only `ralph-postmortem` is modified (~5 lines) to emit blocker/impediment/session events via `knowledge_record_outcome`. All other skills are untouched.
- **No materialized views** — Aggregation is computed at query time. At the expected event volume (hundreds to low thousands), this is instantaneous on SQLite.
- **No schema enforcement on payloads** — The JSON payload column accepts anything. New fields can be added by hooks without touching the DB schema.

## Success Criteria

1. Pipeline skills continue to work identically — no regressions, no new tool calls.
2. `outcome_events` table accumulates rows as pipeline phases complete.
3. `knowledge_query_outcomes` returns raw and aggregated results.
4. `knowledge_search` results include `outcomes_summary` for issues with recorded events.
5. A planning agent can answer: "What's the average drift rate for plans in this component area?" by calling `knowledge_query_outcomes({ component_area: "src/tools/", event_type: "phase_completed", aggregate: true })`.
