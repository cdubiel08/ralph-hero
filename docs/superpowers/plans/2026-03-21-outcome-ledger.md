# Outcome Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a structured outcome event store to ralph-knowledge that captures pipeline telemetry via hooks and surfaces it through MCP tools and search enrichment.

**Architecture:** New `outcome_events` table in the existing `knowledge.db` SQLite database. A stateless PostToolUse hook (`outcome-collector.sh`) observes existing tool calls and INSERTs events. Two new MCP tools (`knowledge_record_outcome`, `knowledge_query_outcomes`) provide write/read access. `knowledge_search` is enriched with outcome summaries.

**Tech Stack:** TypeScript (ralph-knowledge MCP server), Bash (hook script), SQLite (better-sqlite3 + sqlite3 CLI), vitest (tests)

**Spec:** `docs/superpowers/specs/2026-03-21-outcome-ledger-design.md`

---

### Task 1: Schema and DB methods

**Files:**
- Modify: `plugin/ralph-knowledge/src/db.ts`
- Test: `plugin/ralph-knowledge/src/__tests__/db.test.ts`

- [ ] **Step 1: Write failing tests for outcome event operations**

Add to `plugin/ralph-knowledge/src/__tests__/db.test.ts`:

```typescript
describe("Outcome Events", () => {
  it("inserts and retrieves an outcome event", () => {
    const event = db.insertOutcomeEvent({
      eventType: "research_completed",
      issueNumber: 100,
      sessionId: "team-2026-03-21",
      componentArea: "src/tools/",
      model: "sonnet",
      payload: { files_will_modify: ["src/tools/foo.ts"] },
    });
    expect(event.id).toBeTruthy();
    expect(event.timestamp).toBeTruthy();
    const rows = db.queryOutcomeEvents({ issueNumber: 100 });
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("research_completed");
    expect(rows[0].componentArea).toBe("src/tools/");
  });

  it("filters by event_type and component_area", () => {
    db.insertOutcomeEvent({ eventType: "phase_completed", issueNumber: 100, componentArea: "src/tools/" });
    db.insertOutcomeEvent({ eventType: "phase_completed", issueNumber: 101, componentArea: "src/lib/" });
    db.insertOutcomeEvent({ eventType: "research_completed", issueNumber: 100, componentArea: "src/tools/" });
    const rows = db.queryOutcomeEvents({ eventType: "phase_completed", componentArea: "src/tools/" });
    expect(rows).toHaveLength(1);
    expect(rows[0].issueNumber).toBe(100);
  });

  it("filters by since date", () => {
    db.insertOutcomeEvent({ eventType: "research_completed", issueNumber: 100 });
    const rows = db.queryOutcomeEvents({ since: "2099-01-01" });
    expect(rows).toHaveLength(0);
    const all = db.queryOutcomeEvents({ since: "2020-01-01" });
    expect(all).toHaveLength(1);
  });

  it("filters by verdict and estimate", () => {
    db.insertOutcomeEvent({ eventType: "validation_completed", issueNumber: 100, verdict: "pass", estimate: "S" });
    db.insertOutcomeEvent({ eventType: "validation_completed", issueNumber: 101, verdict: "fail", estimate: "M" });
    expect(db.queryOutcomeEvents({ verdict: "pass" })).toHaveLength(1);
    expect(db.queryOutcomeEvents({ estimate: "S" })).toHaveLength(1);
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      db.insertOutcomeEvent({ eventType: "task_completed", issueNumber: i });
    }
    expect(db.queryOutcomeEvents({ limit: 3 })).toHaveLength(3);
  });

  it("returns most recent first", () => {
    db.insertOutcomeEvent({ eventType: "phase_started", issueNumber: 1 });
    db.insertOutcomeEvent({ eventType: "phase_completed", issueNumber: 2 });
    const rows = db.queryOutcomeEvents({});
    expect(rows[0].issueNumber).toBe(2);
  });

  it("aggregates outcome events", () => {
    db.insertOutcomeEvent({ eventType: "phase_completed", issueNumber: 100, driftCount: 2, verdict: "pass", iterationCount: 1 });
    db.insertOutcomeEvent({ eventType: "phase_completed", issueNumber: 101, driftCount: 4, verdict: "pass", iterationCount: 3 });
    db.insertOutcomeEvent({ eventType: "phase_completed", issueNumber: 102, driftCount: 0, verdict: "fail", iterationCount: 1 });
    const agg = db.aggregateOutcomeEvents({ eventType: "phase_completed" });
    expect(agg.count).toBe(3);
    expect(agg.avgDriftCount).toBe(2);
    expect(agg.verdictDistribution).toEqual({ pass: 2, fail: 1 });
  });

  it("computes outcome summary for an issue", () => {
    db.insertOutcomeEvent({ eventType: "research_completed", issueNumber: 100, verdict: "pass" });
    db.insertOutcomeEvent({ eventType: "plan_completed", issueNumber: 100 });
    db.insertOutcomeEvent({ eventType: "phase_completed", issueNumber: 100, driftCount: 2 });
    const summary = db.getOutcomeSummary(100);
    expect(summary).toBeTruthy();
    expect(summary!.totalEvents).toBe(3);
    expect(summary!.eventsByType.research_completed).toBe(1);
    expect(summary!.driftCount).toBe(2);
    expect(summary!.latestVerdict).toBe("pass");
  });

  it("returns null summary for issue with no events", () => {
    expect(db.getOutcomeSummary(999)).toBeNull();
  });

  it("clearAll does not delete outcome events", () => {
    db.insertOutcomeEvent({ eventType: "research_completed", issueNumber: 100 });
    db.clearAll();
    expect(db.queryOutcomeEvents({})).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugin/ralph-knowledge && npx vitest run src/__tests__/db.test.ts`
Expected: FAIL — `insertOutcomeEvent` is not a function

- [ ] **Step 3: Add OutcomeEvent interface and table creation to db.ts**

Add to `plugin/ralph-knowledge/src/db.ts`:

```typescript
export interface OutcomeEventInput {
  eventType: string;
  issueNumber: number;
  sessionId?: string;
  durationMs?: number;
  verdict?: string;
  componentArea?: string;
  estimate?: string;
  driftCount?: number;
  model?: string;
  agentType?: string;
  iterationCount?: number;
  payload?: Record<string, unknown>;
}

export interface OutcomeEventRow {
  id: string;
  eventType: string;
  issueNumber: number;
  sessionId: string | null;
  timestamp: string;
  durationMs: number | null;
  verdict: string | null;
  componentArea: string | null;
  estimate: string | null;
  driftCount: number | null;
  model: string | null;
  agentType: string | null;
  iterationCount: number | null;
  payload: string;
}

export interface OutcomeQueryParams {
  issueNumber?: number;
  eventType?: string;
  componentArea?: string;
  estimate?: string;
  verdict?: string;
  sessionId?: string;
  since?: string;
  limit?: number;
}

export interface OutcomeAggregate {
  count: number;
  avgDriftCount: number | null;
  avgIterationCount: number | null;
  verdictDistribution: Record<string, number>;
  eventTypeDistribution: Record<string, number>;
  topComponentAreas: Array<{ area: string; count: number }>;
}

export interface OutcomeSummary {
  totalEvents: number;
  latestVerdict: string | null;
  driftCount: number;
  blockers: number;
  eventsByType: Record<string, number>;
}
```

Add outcome_events table to `createSchema()`:

```typescript
CREATE TABLE IF NOT EXISTS outcome_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  session_id TEXT,
  timestamp TEXT NOT NULL,
  duration_ms INTEGER,
  verdict TEXT,
  component_area TEXT,
  estimate TEXT,
  drift_count INTEGER,
  model TEXT,
  agent_type TEXT,
  iteration_count INTEGER,
  payload TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_oe_type ON outcome_events(event_type);
CREATE INDEX IF NOT EXISTS idx_oe_issue ON outcome_events(issue_number);
CREATE INDEX IF NOT EXISTS idx_oe_component ON outcome_events(component_area);
CREATE INDEX IF NOT EXISTS idx_oe_timestamp ON outcome_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_oe_session ON outcome_events(session_id);
CREATE INDEX IF NOT EXISTS idx_oe_type_component ON outcome_events(event_type, component_area);
```

- [ ] **Step 4: Implement insertOutcomeEvent()**

```typescript
insertOutcomeEvent(input: OutcomeEventInput): { id: string; eventType: string; issueNumber: number; timestamp: string } {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  this.db.prepare(`
    INSERT INTO outcome_events (id, event_type, issue_number, session_id, timestamp,
      duration_ms, verdict, component_area, estimate, drift_count, model, agent_type,
      iteration_count, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.eventType, input.issueNumber, input.sessionId ?? null, timestamp,
    input.durationMs ?? null, input.verdict ?? null, input.componentArea ?? null,
    input.estimate ?? null, input.driftCount ?? null, input.model ?? null,
    input.agentType ?? null, input.iterationCount ?? null,
    JSON.stringify(input.payload ?? {}),
  );
  return { id, eventType: input.eventType, issueNumber: input.issueNumber, timestamp };
}
```

- [ ] **Step 5: Implement queryOutcomeEvents()**

```typescript
queryOutcomeEvents(params: OutcomeQueryParams): OutcomeEventRow[] {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (params.issueNumber != null) { conditions.push("issue_number = ?"); values.push(params.issueNumber); }
  if (params.eventType) { conditions.push("event_type = ?"); values.push(params.eventType); }
  if (params.componentArea) { conditions.push("component_area LIKE ?"); values.push(params.componentArea + "%"); }
  if (params.estimate) { conditions.push("estimate = ?"); values.push(params.estimate); }
  if (params.verdict) { conditions.push("verdict = ?"); values.push(params.verdict); }
  if (params.sessionId) { conditions.push("session_id = ?"); values.push(params.sessionId); }
  if (params.since) { conditions.push("timestamp > ?"); values.push(params.since); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit ?? 50;
  return this.db.prepare(`
    SELECT id, event_type AS eventType, issue_number AS issueNumber,
      session_id AS sessionId, timestamp, duration_ms AS durationMs,
      verdict, component_area AS componentArea, estimate,
      drift_count AS driftCount, model, agent_type AS agentType,
      iteration_count AS iterationCount, payload
    FROM outcome_events ${where}
    ORDER BY timestamp DESC LIMIT ?
  `).all(...values, limit) as OutcomeEventRow[];
}
```

- [ ] **Step 6: Implement aggregateOutcomeEvents()**

Note: Duration aggregation (pairing `*_started`/`*_completed` events) is deferred to a follow-up. The current implementation aggregates `driftCount`, `iterationCount`, and verdict/event type distributions. Duration pairing requires the query-time SQL JOIN described in the spec and will be added once baseline telemetry is flowing.

```typescript
aggregateOutcomeEvents(params: OutcomeQueryParams): OutcomeAggregate {
  const rows = this.queryOutcomeEvents({ ...params, limit: 10000 });
  const verdictDist: Record<string, number> = {};
  const eventTypeDist: Record<string, number> = {};
  const areaCounts: Record<string, number> = {};
  let driftSum = 0, driftN = 0, iterSum = 0, iterN = 0;
  for (const r of rows) {
    if (r.verdict) verdictDist[r.verdict] = (verdictDist[r.verdict] ?? 0) + 1;
    eventTypeDist[r.eventType] = (eventTypeDist[r.eventType] ?? 0) + 1;
    if (r.componentArea) areaCounts[r.componentArea] = (areaCounts[r.componentArea] ?? 0) + 1;
    if (r.driftCount != null) { driftSum += r.driftCount; driftN++; }
    if (r.iterationCount != null) { iterSum += r.iterationCount; iterN++; }
  }
  return {
    count: rows.length,
    avgDriftCount: driftN > 0 ? driftSum / driftN : null,
    avgIterationCount: iterN > 0 ? iterSum / iterN : null,
    verdictDistribution: verdictDist,
    eventTypeDistribution: eventTypeDist,
    topComponentAreas: Object.entries(areaCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([area, count]) => ({ area, count })),
  };
}
```

- [ ] **Step 7: Implement getOutcomeSummary()**

```typescript
getOutcomeSummary(issueNumber: number): OutcomeSummary | null {
  const rows = this.db.prepare(`
    SELECT event_type AS eventType, verdict, drift_count AS driftCount
    FROM outcome_events WHERE issue_number = ? ORDER BY timestamp DESC
  `).all(issueNumber) as Array<{ eventType: string; verdict: string | null; driftCount: number | null }>;
  if (rows.length === 0) return null;
  const eventsByType: Record<string, number> = {};
  let totalDrift = 0, blockers = 0, latestVerdict: string | null = null;
  for (const r of rows) {
    eventsByType[r.eventType] = (eventsByType[r.eventType] ?? 0) + 1;
    if (r.driftCount != null) totalDrift += r.driftCount;
    if (r.eventType === "blocker_recorded") blockers++;
    if (latestVerdict == null && r.verdict) latestVerdict = r.verdict;
  }
  return { totalEvents: rows.length, latestVerdict, driftCount: totalDrift, blockers, eventsByType };
}
```

- [ ] **Step 8: Update clearAll() to preserve outcome_events**

Change `clearAll()` in `db.ts` from:
```typescript
this.db.exec("DELETE FROM relationships; DELETE FROM tags; DELETE FROM documents;");
```
to:
```typescript
this.db.exec("DELETE FROM relationships; DELETE FROM tags; DELETE FROM documents;");
// outcome_events is intentionally NOT cleared — it is append-only telemetry
```

(No behavioral change needed — `clearAll()` already only deletes from the three document tables. The `outcome_events` table is not referenced. Add the comment for clarity.)

- [ ] **Step 9: Run tests to verify they pass**

Run: `cd plugin/ralph-knowledge && npx vitest run src/__tests__/db.test.ts`
Expected: ALL PASS

- [ ] **Step 10: Commit**

```bash
git add plugin/ralph-knowledge/src/db.ts plugin/ralph-knowledge/src/__tests__/db.test.ts
git commit -m "feat(knowledge): add outcome_events table and DB methods

Adds OutcomeEventInput/Row/Aggregate/Summary types,
insertOutcomeEvent, queryOutcomeEvents, aggregateOutcomeEvents,
getOutcomeSummary methods. clearAll() preserves outcome data."
```

---

### Task 2: MCP tools — record and query

**Files:**
- Modify: `plugin/ralph-knowledge/src/index.ts`
- Test: `plugin/ralph-knowledge/src/__tests__/index.test.ts`

- [ ] **Step 1: Write failing tests for MCP tools**

Add to `plugin/ralph-knowledge/src/__tests__/index.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

describe("knowledge-index server", () => {
  it("exports createServer function", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.createServer).toBe("function");
  });

  it("registers outcome tools", async () => {
    const mod = await import("../index.js");
    const { server } = mod.createServer(":memory:");
    // Server should have knowledge_record_outcome and knowledge_query_outcomes registered
    // We verify by checking the server's tool list
    expect(server).toBeTruthy();
  });
});
```

Note: The existing test file is minimal. The real verification is that `createServer` doesn't throw when the new tools reference `db` methods that now exist. Integration testing of tool invocation is best done via the MCP protocol, which is out of scope for unit tests. The DB methods are already thoroughly tested in Task 1.

- [ ] **Step 2: Run tests to verify baseline passes**

Run: `cd plugin/ralph-knowledge && npx vitest run src/__tests__/index.test.ts`
Expected: PASS (baseline)

- [ ] **Step 3: Register knowledge_record_outcome tool**

Add to `createServer()` in `plugin/ralph-knowledge/src/index.ts`, after the `knowledge_traverse` registration:

```typescript
server.tool(
  "knowledge_record_outcome",
  "Record a pipeline outcome event (research, plan, phase, validation, etc.)",
  {
    event_type: z.string().describe("Event type (e.g., 'phase_completed', 'research_started')"),
    issue_number: z.number().describe("GitHub issue number"),
    session_id: z.string().optional().describe("Team/hero session identifier"),
    duration_ms: z.number().optional().describe("Duration in milliseconds"),
    verdict: z.string().optional().describe("Outcome verdict (pass, fail, approved, needs_iteration)"),
    component_area: z.string().optional().describe("Component path prefix (e.g., 'src/tools/')"),
    estimate: z.string().optional().describe("Issue estimate (XS, S, M, L, XL)"),
    drift_count: z.number().optional().describe("Files modified outside plan scope"),
    model: z.string().optional().describe("LLM model used (opus, sonnet, haiku)"),
    agent_type: z.string().optional().describe("Agent type (analyst, builder, integrator)"),
    iteration_count: z.number().optional().describe("Number of retry/review cycles"),
    payload: z.record(z.unknown()).optional().describe("Arbitrary JSON payload"),
  },
  async (args) => {
    try {
      const result = db.insertOutcomeEvent({
        eventType: args.event_type,
        issueNumber: args.issue_number,
        sessionId: args.session_id,
        durationMs: args.duration_ms,
        verdict: args.verdict,
        componentArea: args.component_area,
        estimate: args.estimate,
        driftCount: args.drift_count,
        model: args.model,
        agentType: args.agent_type,
        iterationCount: args.iteration_count,
        payload: args.payload as Record<string, unknown>,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);
```

- [ ] **Step 4: Register knowledge_query_outcomes tool**

Add to `createServer()` in `plugin/ralph-knowledge/src/index.ts`:

```typescript
server.tool(
  "knowledge_query_outcomes",
  "Query outcome events with optional aggregation. Use to find patterns in pipeline history.",
  {
    issue_number: z.number().optional().describe("Filter to specific issue"),
    event_type: z.string().optional().describe("Filter by event type"),
    component_area: z.string().optional().describe("Filter by component (prefix match)"),
    estimate: z.string().optional().describe("Filter by estimate size"),
    verdict: z.string().optional().describe("Filter by verdict"),
    session_id: z.string().optional().describe("Filter by session"),
    since: z.string().optional().describe("ISO date — only events after this"),
    limit: z.number().optional().describe("Max results (default: 50)"),
    aggregate: z.boolean().optional().describe("Return computed stats instead of raw rows"),
  },
  async (args) => {
    try {
      const params = {
        issueNumber: args.issue_number,
        eventType: args.event_type,
        componentArea: args.component_area,
        estimate: args.estimate,
        verdict: args.verdict,
        sessionId: args.session_id,
        since: args.since,
        limit: args.limit,
      };
      if (args.aggregate) {
        const agg = db.aggregateOutcomeEvents(params);
        return { content: [{ type: "text" as const, text: JSON.stringify(agg, null, 2) }] };
      }
      const rows = db.queryOutcomeEvents(params);
      return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);
```

- [ ] **Step 5: Run tests to verify nothing broke**

Run: `cd plugin/ralph-knowledge && npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add plugin/ralph-knowledge/src/index.ts plugin/ralph-knowledge/src/__tests__/index.test.ts
git commit -m "feat(knowledge): register outcome MCP tools

Adds knowledge_record_outcome (write) and
knowledge_query_outcomes (read + aggregate) tools."
```

---

### Task 3: Search enrichment

**Files:**
- Modify: `plugin/ralph-knowledge/src/index.ts`

- [ ] **Step 1: Add outcomes_summary to knowledge_search handler**

In `plugin/ralph-knowledge/src/index.ts`, modify the `knowledge_search` handler. Change:

```typescript
const enriched = results.map(r => ({ ...r, tags: db.getTags(r.id) }));
```

to:

```typescript
const enriched = results.map(r => {
  const base = { ...r, tags: db.getTags(r.id) };
  // SearchResult does not carry githubIssue — fetch from documents table
  const doc = db.getDocument(r.id);
  if (doc?.githubIssue) {
    const outcomes = db.getOutcomeSummary(doc.githubIssue);
    if (outcomes) return { ...base, outcomes_summary: outcomes };
  }
  return base;
});
```

Note: `SearchResult` (from `search.ts`) does NOT include `githubIssue`. We fetch it via `db.getDocument(r.id)` which is a cheap primary key lookup.

- [ ] **Step 2: Run tests**

- [ ] **Step 3: Run tests**

Run: `cd plugin/ralph-knowledge && npx vitest run`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-knowledge/src/index.ts
git commit -m "feat(knowledge): enrich search results with outcome summaries

knowledge_search now includes outcomes_summary for documents
linked to GitHub issues that have recorded outcome events."
```

---

### Task 4: Hook script — outcome-collector.sh

**Files:**
- Create: `plugin/ralph-hero/hooks/scripts/outcome-collector.sh`

- [ ] **Step 1: Create the hook script**

Create `plugin/ralph-hero/hooks/scripts/outcome-collector.sh`:

```bash
#!/bin/bash
# ralph-hero/hooks/scripts/outcome-collector.sh
# PostToolUse + TaskCompleted: Capture pipeline outcome events into knowledge.db
#
# Registered on:
#   PostToolUse(ralph_hero__save_issue) — state transitions
#   PostToolUse(Write)                 — plan/research doc enrichment
#   TaskCompleted                      — task-level events (team skill only)
#
# Stateless: each invocation is a standalone INSERT. No state between firings.
# Best-effort: sqlite3 failures are logged and ignored (exit 0 always).
#
# Does NOT source hook-utils.sh — this is a PostToolUse/TaskCompleted observer
# that reads stdin directly, following the pattern of post-github-validator.sh.
#
# Exit codes:
#   0 - Always (never blocks pipeline)

set -euo pipefail

# Resolve DB path
DB_PATH="${RALPH_KNOWLEDGE_DB:-${HOME}/.ralph-hero/knowledge.db}"

# Read hook input
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')

# Ensure table and pragmas
ensure_table() {
  sqlite3 "$DB_PATH" <<'SQL' 2>/dev/null || true
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=3000;
CREATE TABLE IF NOT EXISTS outcome_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  session_id TEXT,
  timestamp TEXT NOT NULL,
  duration_ms INTEGER,
  verdict TEXT,
  component_area TEXT,
  estimate TEXT,
  drift_count INTEGER,
  model TEXT,
  agent_type TEXT,
  iteration_count INTEGER,
  payload TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_oe_type ON outcome_events(event_type);
CREATE INDEX IF NOT EXISTS idx_oe_issue ON outcome_events(issue_number);
CREATE INDEX IF NOT EXISTS idx_oe_component ON outcome_events(component_area);
CREATE INDEX IF NOT EXISTS idx_oe_timestamp ON outcome_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_oe_session ON outcome_events(session_id);
CREATE INDEX IF NOT EXISTS idx_oe_type_component ON outcome_events(event_type, component_area);
SQL
}

# SQL helpers — escape single quotes to prevent injection
sql_escape() { echo "${1//\'/\'\'}"; }
sql_str() { if [[ -n "$1" ]]; then echo "'$(sql_escape "$1")'"; else echo "NULL"; fi; }
sql_int() { if [[ -n "$1" && "$1" =~ ^[0-9]+$ ]]; then echo "$1"; else echo "NULL"; fi; }

# Insert an outcome event
insert_event() {
  local event_type="$1"
  local issue_number="$2"
  local session_id="${3:-}"
  local verdict="${4:-}"
  local component_area="${5:-}"
  local estimate="${6:-}"
  local drift_count="${7:-}"
  local model="${8:-}"
  local agent_type="${9:-}"
  local iteration_count="${10:-}"
  local payload="${11:-{}}"

  local id
  id=$(uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]' || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "oe-$(date +%s%N)")
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Escape all string values for SQL safety
  local e_event_type e_payload
  e_event_type=$(sql_escape "$event_type")
  e_payload=$(sql_escape "$payload")

  sqlite3 "$DB_PATH" <<SQL 2>/dev/null || { echo "WARNING: outcome-collector failed to write event" >&2; return 0; }
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=3000;
INSERT INTO outcome_events (id, event_type, issue_number, session_id, timestamp,
  verdict, component_area, estimate, drift_count, model, agent_type, iteration_count, payload)
VALUES (
  '${id}', '${e_event_type}', $(sql_int "$issue_number"), $(sql_str "$session_id"), '${ts}',
  $(sql_str "$verdict"), $(sql_str "$component_area"), $(sql_str "$estimate"),
  $(sql_int "$drift_count"), $(sql_str "$model"), $(sql_str "$agent_type"),
  $(sql_int "$iteration_count"), '${e_payload}'
);
SQL
}

# ─── Branch: PostToolUse(ralph_hero__save_issue) ───
handle_save_issue() {
  local tool_input tool_response command workflow_state issue_number
  tool_input=$(echo "$INPUT" | jq -r '.tool_input // {}')
  tool_response=$(echo "$INPUT" | jq -r '.tool_response // {}')

  command=$(echo "$tool_input" | jq -r '.command // empty')
  workflow_state=$(echo "$tool_input" | jq -r '.workflowState // empty')
  issue_number=$(echo "$tool_response" | jq -r '.number // empty')

  # Need command, state, and issue number
  if [[ -z "$command" || -z "$workflow_state" || -z "$issue_number" ]]; then
    exit 0
  fi

  local event_type=""
  case "${command}:${workflow_state}" in
    ralph_research:__LOCK__)     event_type="research_started" ;;
    ralph_research:__COMPLETE__) event_type="research_completed" ;;
    ralph_plan:__LOCK__)         event_type="plan_started" ;;
    ralph_plan:__COMPLETE__)     event_type="plan_completed" ;;
    ralph_review:*)              event_type="review_completed" ;;
    ralph_impl:__LOCK__)         event_type="phase_started" ;;
    ralph_impl:__COMPLETE__)     event_type="phase_completed" ;;
    ralph_val:*)                 event_type="validation_completed" ;;
    ralph_pr:__COMPLETE__)       event_type="pr_completed" ;;
    ralph_merge:__COMPLETE__)    event_type="merge_completed" ;;
    *)                           exit 0 ;;
  esac

  # Extract available promoted columns from tool input/response
  local verdict component_area estimate drift_count model agent_type iteration_count
  verdict=$(echo "$tool_input" | jq -r '.verdict // empty')
  component_area=$(echo "$tool_input" | jq -r '.componentArea // empty')
  estimate=$(echo "$tool_input" | jq -r '.estimate // empty')
  drift_count=$(echo "$tool_input" | jq -r '.driftCount // empty')
  model=$(echo "$tool_input" | jq -r '.model // empty')
  agent_type=$(echo "$tool_input" | jq -r '.agentType // empty')
  iteration_count=$(echo "$tool_input" | jq -r '.iterationCount // empty')
  local session_id="${RALPH_SESSION_ID:-}"

  # Build payload from tool_input extras
  local payload
  payload=$(echo "$tool_input" | jq -c '{} + (del(.command, .workflowState, .number, .verdict, .componentArea, .estimate, .driftCount, .model, .agentType, .iterationCount) | to_entries | map(select(.value != null and .value != "")) | from_entries)' 2>/dev/null || echo '{}')

  ensure_table
  insert_event "$event_type" "$issue_number" "$session_id" "$verdict" \
    "$component_area" "$estimate" "$drift_count" "$model" "$agent_type" \
    "$iteration_count" "$payload"
}

# ─── Branch: PostToolUse(Write) ───
handle_write() {
  local file_path
  file_path=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

  # Only process thoughts/shared/plans/* and thoughts/shared/research/*
  case "$file_path" in
    */thoughts/shared/plans/*|*/thoughts/shared/research/*) ;;
    *) exit 0 ;;
  esac

  # Extract issue number from GH-NNNN in filename
  local basename issue_number
  basename=$(basename "$file_path")
  issue_number=$(echo "$basename" | grep -oE 'GH-[0-9]+' | head -1 | sed 's/GH-0*//')
  if [[ -z "$issue_number" ]]; then
    exit 0
  fi

  # Extract metadata from file
  local payload='{}'
  if [[ -f "$file_path" ]]; then
    case "$file_path" in
      */plans/*)
        local phase_count file_count
        phase_count=$(grep -c '^## Phase ' "$file_path" 2>/dev/null || echo 0)
        file_count=$(grep -c '^\s*- ' "$file_path" 2>/dev/null || echo 0)
        payload=$(jq -nc --argjson pc "$phase_count" --argjson fc "$file_count" \
          '{phase_count: $pc, file_references: $fc}')
        ;;
      */research/*)
        local will_modify will_read
        will_modify=$(sed -n '/### Will Modify/,/###/{/###/!p}' "$file_path" 2>/dev/null | grep -c '`' || echo 0)
        will_read=$(sed -n '/### Will Read/,/###/{/###/!p}' "$file_path" 2>/dev/null | grep -c '`' || echo 0)
        payload=$(jq -nc --argjson wm "$will_modify" --argjson wr "$will_read" \
          '{files_will_modify_count: $wm, files_will_read_count: $wr}')
        ;;
    esac
  fi

  # UPDATE the most recent *_completed event for this issue, or skip
  ensure_table
  local existing_id
  existing_id=$(sqlite3 "$DB_PATH" "PRAGMA busy_timeout=3000; SELECT id FROM outcome_events WHERE issue_number = $issue_number AND event_type LIKE '%_completed' ORDER BY timestamp DESC LIMIT 1;" 2>/dev/null || echo "")

  if [[ -n "$existing_id" ]]; then
    local merged
    merged=$(sqlite3 "$DB_PATH" "PRAGMA busy_timeout=3000; SELECT payload FROM outcome_events WHERE id = '$existing_id';" 2>/dev/null || echo '{}')
    merged=$(echo "$merged" | jq -c ". + $payload" 2>/dev/null || echo "$payload")
    sqlite3 "$DB_PATH" "PRAGMA busy_timeout=3000; UPDATE outcome_events SET payload = '${merged}' WHERE id = '${existing_id}';" 2>/dev/null || true
  fi
  # If no existing event, skip — enrichment is best-effort
}

# ─── Branch: TaskCompleted ───
handle_task_completed() {
  local task_subject teammate_name agent_type
  task_subject=$(echo "$INPUT" | jq -r '.task_subject // "unknown"')
  teammate_name=$(echo "$INPUT" | jq -r '.teammate_name // "unknown"')

  # Infer agent_type from teammate name
  case "$teammate_name" in
    *analyst*) agent_type="analyst" ;;
    *builder*) agent_type="builder" ;;
    *integrator*) agent_type="integrator" ;;
    *) agent_type="$teammate_name" ;;
  esac

  # Extract issue number from task subject (e.g., "Implement GH-617")
  local issue_number
  issue_number=$(echo "$task_subject" | grep -oE 'GH-[0-9]+' | head -1 | sed 's/GH-0*//')
  if [[ -z "$issue_number" ]]; then
    # Fall back to any number in subject
    issue_number=$(echo "$task_subject" | grep -oE '[0-9]+' | head -1)
  fi
  if [[ -z "$issue_number" ]]; then
    exit 0
  fi

  local payload
  payload=$(jq -nc --arg ts "$task_subject" --arg tn "$teammate_name" \
    '{task_subject: $ts, teammate_name: $tn}')

  local session_id="${RALPH_SESSION_ID:-}"

  ensure_table
  insert_event "task_completed" "$issue_number" "$session_id" "" "" "" "" "" "$agent_type" "" "$payload"
}

# ─── Main dispatch ───
case "$TOOL_NAME" in
  ralph_hero__save_issue)
    handle_save_issue
    ;;
  Write)
    handle_write
    ;;
  *)
    # TaskCompleted or unknown — check hook_event
    if [[ "$HOOK_EVENT" == "TaskCompleted" ]] || echo "$INPUT" | jq -e '.task_subject' >/dev/null 2>&1; then
      handle_task_completed
    fi
    ;;
esac

exit 0
```

- [ ] **Step 2: Make the script executable**

Run: `chmod +x plugin/ralph-hero/hooks/scripts/outcome-collector.sh`

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/hooks/scripts/outcome-collector.sh
git commit -m "feat(hooks): add outcome-collector.sh

Stateless hook that captures pipeline events into knowledge.db.
Branches on save_issue (state transitions), Write (doc enrichment),
and TaskCompleted (task-level events)."
```

---

### Task 5: Hook registration

**Files:**
- Modify: `plugin/ralph-hero/hooks/hooks.json`
- Modify: `plugin/ralph-hero/skills/team/SKILL.md`

- [ ] **Step 1: Register PostToolUse hooks in hooks.json**

In `plugin/ralph-hero/hooks/hooks.json`, add `outcome-collector.sh` to the existing `PostToolUse` matchers.

For `ralph_hero__save_issue` matcher (line 95), add to the hooks array:
```json
{
  "type": "command",
  "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/outcome-collector.sh"
}
```

For the `Write` matcher (line 122), add to the hooks array:
```json
{
  "type": "command",
  "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/outcome-collector.sh"
}
```

- [ ] **Step 2: Register TaskCompleted hook in team skill frontmatter**

In `plugin/ralph-hero/skills/team/SKILL.md`, add `outcome-collector.sh` to the `TaskCompleted` hooks (line 44-47). Change:

```yaml
  TaskCompleted:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/team-task-completed.sh"
```

to:

```yaml
  TaskCompleted:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/team-task-completed.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/outcome-collector.sh"
```

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/hooks/hooks.json plugin/ralph-hero/skills/team/SKILL.md
git commit -m "feat(hooks): register outcome-collector on save_issue, Write, TaskCompleted

Plugin-level PostToolUse for save_issue and Write.
Skill-level TaskCompleted in team skill frontmatter."
```

---

### Task 6: Postmortem skill modification

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md`

This is the single exception to "near-zero skill changes." The postmortem skill already has structured blocker/impediment data in memory during report generation — it just needs to emit it.

- [ ] **Step 1: Add knowledge_record_outcome to allowed-tools**

In `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md` frontmatter, add to the `allowed-tools` list:

```yaml
  - knowledge_record_outcome
```

- [ ] **Step 2: Add outcome recording instructions to skill body**

After the blocker classification step in the skill body, add instructions to call `knowledge_record_outcome` for each classified event:

```markdown
**After classifying blockers and impediments, record each to the outcome ledger:**

For each **blocker**: call `knowledge_record_outcome` with:
- `event_type`: `"blocker_recorded"`
- `issue_number`: the primary issue number
- `agent_type`: the worker that encountered the blocker
- `session_id`: the team session identifier
- `payload`: `{ blocker_type, description, created_issue_number }`

For each **impediment**: call `knowledge_record_outcome` with:
- `event_type`: `"impediment_recorded"`
- `issue_number`: the primary issue number
- `agent_type`: the worker that encountered the impediment
- `payload`: `{ impediment_type, description, self_resolved, workaround }`

After writing the report, record session completion:
- `event_type`: `"session_completed"`
- `issue_number`: the primary issue number
- `session_id`: the team session identifier
- `payload`: `{ issues_processed, issues_completed, workers, total_tokens }`
```

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-postmortem/SKILL.md
git commit -m "feat(postmortem): emit outcome events for blockers, impediments, sessions

Adds knowledge_record_outcome calls for blocker_recorded,
impediment_recorded, and session_completed events."
```

---

### Task 7: Build and verify

**Files:** None (verification only)

**Depends on:** Tasks 1-6

- [ ] **Step 1: Build ralph-knowledge**

Run: `cd plugin/ralph-knowledge && npm run build`
Expected: No TypeScript errors

- [ ] **Step 2: Run full test suite**

Run: `cd plugin/ralph-knowledge && npm test`
Expected: ALL PASS

- [ ] **Step 3: Verify hook script syntax**

Run: `bash -n plugin/ralph-hero/hooks/scripts/outcome-collector.sh`
Expected: No syntax errors

- [ ] **Step 4: Verify hooks.json is valid JSON**

Run: `jq . plugin/ralph-hero/hooks/hooks.json > /dev/null`
Expected: Exit 0

- [ ] **Step 5: Final commit with all passing**

```bash
git add -A
git commit -m "chore: verify outcome ledger build and tests pass"
```
