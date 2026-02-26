---
date: 2026-02-21
status: draft
type: spec
---

# Debug Mode & Self-Healing Observability — Draft Spec

## Problem

Ralph-hero has no observability into its own operation. Errors surface as MCP tool responses and disappear. There's no way to:
- Know what went wrong after a session ends
- Detect recurring failure patterns across sessions
- Automatically create issues for bugs ralph-hero encounters in itself
- Measure whether fixes actually reduce error rates

## Goal

When `RALPH_DEBUG=true`, ralph-hero captures structured telemetry to disk, and exposes a tool to collate captured data into canonical GitHub issues — making ralph-hero self-improving.

## Architecture

Three layers, built in order:

```
┌─────────────────────────────────────────────────┐
│  Layer 1: Capture (automatic, background)       │
│  Structured logs → ~/.ralph-hero/logs/           │
├─────────────────────────────────────────────────┤
│  Layer 2: Collation (on-demand tool)            │
│  Analyze logs → deduplicate → canonical issues   │
├─────────────────────────────────────────────────┤
│  Layer 3: Metrics (derived from issue history)  │
│  Error rate, tool success rate over time         │
└─────────────────────────────────────────────────┘
```

**Separation of concerns**: Capture and collation are independent. Capture runs automatically when debug is on. Collation is a deliberate act — an agent (or human) invokes a tool that reads the logs, groups errors by signature, and creates/updates issues with structured data.

---

## Layer 1: Capture

### Activation

Environment variable: `RALPH_DEBUG=true`

Set in `settings.local.json`:
```json
{
  "env": {
    "RALPH_DEBUG": "true"
  }
}
```

When unset or `false`, zero overhead — no log files created, no hooks fire.

### What gets captured

Four event categories, each with a structured schema:

#### 1a. MCP Tool Calls

Captured inside the MCP server. Every tool invocation logs:

```jsonl
{"ts":"...","cat":"tool","name":"ralph_hero__update_workflow_state","params":{"issueNumber":42,"state":"In Progress"},"durationMs":340,"ok":true,"resultSummary":"state updated"}
{"ts":"...","cat":"tool","name":"ralph_hero__create_issue","params":{"title":"..."},"durationMs":1200,"ok":false,"error":"GraphQL: Could not resolve to a Repository","errorType":"graphql"}
```

Fields: `ts`, `cat`, `name`, `params` (sanitized — no tokens), `durationMs`, `ok`, `resultSummary` | `error` + `errorType`.

Implementation: Wrap the MCP server's tool dispatch (the `server.tool(...)` handlers in `index.ts`) with a logging decorator that measures duration and captures outcomes.

#### 1b. GraphQL Requests

Captured in `github-client.ts`. Every GraphQL call logs:

```jsonl
{"ts":"...","cat":"graphql","operation":"getIssue","variables":{"owner":"cdubiel08","number":42},"durationMs":180,"status":200,"rateLimitRemaining":4800,"rateLimitCost":1}
{"ts":"...","cat":"graphql","operation":"createIssue","variables":{"title":"..."},"durationMs":0,"status":403,"error":"rate limited","retryAfter":30}
```

Fields: `ts`, `cat`, `operation`, `variables` (sanitized), `durationMs`, `status`, `rateLimitRemaining`, `rateLimitCost`, optionally `error`.

#### 1c. Hook Executions

Captured via **togglable counting hooks**. A new PostToolUse hook (or a wrapper around existing hooks) increments counters:

```jsonl
{"ts":"...","cat":"hook","hook":"pre-github-validator","tool":"ralph_hero__update_workflow_state","exitCode":0,"blocked":false}
{"ts":"...","cat":"hook","hook":"impl-state-gate","tool":"Skill","exitCode":2,"blocked":true,"message":"Issue not in Ready for Plan state"}
```

Implementation approach: A lightweight hook script (`debug-hook-counter.sh`) registered on `*` (all tools) that only fires when `RALPH_DEBUG=true`. It appends a single JSONL line per hook execution. Existing hooks remain unchanged — this is additive.

#### 1d. Agent-Level Events

Captured via togglable hooks on agent lifecycle events. These provide counts and timing, not full traces (Claude Code doesn't expose internal reasoning):

```jsonl
{"ts":"...","cat":"agent","event":"skill_invoked","skill":"ralph-impl","issueNumber":42}
{"ts":"...","cat":"agent","event":"agent_spawned","agentType":"ralph-builder","name":"builder-1"}
{"ts":"...","cat":"agent","event":"task_completed","taskId":"3","subject":"Implement phase 1"}
{"ts":"...","cat":"agent","event":"session_end","toolCalls":47,"errors":2,"durationMs":180000}
```

Implementation: Hook scripts on `SessionStart`, `Stop`/`SubagentStop`, and Skill invocations. These are toggleable — they check `RALPH_DEBUG` and no-op if unset.

### Storage

**Location**: `~/.ralph-hero/logs/`

**File naming**: `session-{YYYY-MM-DD}-{HH-MM-SS}-{random4}.jsonl`

One file per MCP server process lifetime. The MCP server creates the file on first write (lazy — no file created if nothing to log).

**Rotation**: Not in v1. Files accumulate. The collation tool can optionally archive/clean old logs.

**Format**: JSONL (one JSON object per line). Appendable, streamable, `grep`-friendly.

### Version Stamp

Every session log starts with a header line:

```jsonl
{"ts":"...","cat":"session","event":"start","version":"2.4.47","node":"22.0.0","os":"linux","env":{"owner":"cdubiel08","repo":"ralph-hero","project":3,"debugLevel":"true"}}
```

This provides the diagnostic context needed for issue creation.

---

## Layer 2: Collation

### New MCP Tool: `ralph_hero__collate_debug`

**Only registered when `RALPH_DEBUG=true`.** This is critical — when debug is off, this tool doesn't exist in the tool list, reducing decision entropy for the agent.

**Parameters**:
| Param | Required | Type | Description |
|-------|----------|------|-------------|
| `since` | No | string | ISO date. Only examine logs after this date. Default: last 24h. |
| `dryRun` | No | boolean | If true, return the report but don't create issues. Default: false. |
| `projectNumber` | No | number | Target project for created issues. Default: configured project. |

**What it does**:

1. **Read** all JSONL files in `~/.ralph-hero/logs/` matching the `since` window
2. **Filter** to error events (`ok: false`, `blocked: true`, `exitCode !== 0`)
3. **Group** errors by signature: `{cat}:{name|operation|hook}:{errorType|exitCode}:{error_message_normalized}`
   - Normalization: strip issue numbers, timestamps, variable data
4. **Deduplicate** against existing open issues:
   - Search GitHub issues with label `debug-auto` for matching signature hash
   - If match found: add a comment with new occurrence count + latest session context
   - If no match: create new issue
5. **Create/update** canonical issues

### Issue Shape

**Labels**: `debug-auto`, `ralph-self-report`

**Title**: `[Debug] {category}: {normalized_error_summary}`

Examples:
- `[Debug] graphql: rate limited on createIssue`
- `[Debug] tool: update_workflow_state fails with unknown state`
- `[Debug] hook: impl-state-gate blocks unexpectedly`

**Body** (on creation):

```markdown
## Error Signature

`tool:ralph_hero__update_workflow_state:graphql:Could not resolve`

**Hash**: `a1b2c3d4`

## First Seen

- **Date**: 2026-02-21T14:30:00Z
- **Version**: ralph-hero-mcp-server@2.4.47
- **Node**: 22.0.0
- **OS**: linux

## Error Details

- **Category**: tool
- **Tool/Operation**: `ralph_hero__update_workflow_state`
- **Error Type**: graphql
- **Message**: `Could not resolve to a Repository with the name 'cdubiel08/ralph-hero'`

## Reproduction

```json
{
  "tool": "ralph_hero__update_workflow_state",
  "params": { "issueNumber": 42, "state": "In Progress" }
}
```

## Occurrences

| Date | Version | Session | Count |
|------|---------|---------|-------|
| 2026-02-21 | 2.4.47 | session-2026-02-21-14-30-00-a1b2 | 3 |

## Stats

- **Total occurrences**: 3
- **Sessions affected**: 1
- **First seen**: 2026-02-21
- **Last seen**: 2026-02-21
```

**Comments** (on subsequent occurrences):

```markdown
## New occurrences (2026-02-22)

| Version | Session | Count |
|---------|---------|-------|
| 2.4.48 | session-2026-02-22-09-15-00-b3c4 | 5 |

**Running total**: 8 occurrences across 2 sessions

### Context (latest)

Tool call sequence leading to error:
1. `get_issue` (42) -> ok
2. `list_sub_issues` (42) -> ok
3. `update_workflow_state` (42, "In Progress") -> **error**
```

This structured comment format means stats accumulate on the issue over time — queryable, diffable.

### Workflow State

Created issues go into **Backlog** with `workflowState: "Backlog"`, so they enter the normal triage pipeline. The `debug-auto` label lets triage filter/prioritize them.

---

## Layer 3: Metrics

### Tool: `ralph_hero__debug_stats`

**Only registered when `RALPH_DEBUG=true`.**

**Parameters**:
| Param | Required | Type | Description |
|-------|----------|------|-------------|
| `since` | No | string | ISO date. Default: last 7 days. |
| `groupBy` | No | string | `tool` \| `category` \| `day`. Default: `tool`. |

**Returns** aggregated stats from log files:

```json
{
  "period": { "from": "2026-02-14", "to": "2026-02-21" },
  "summary": {
    "totalToolCalls": 1247,
    "totalErrors": 23,
    "errorRate": 0.018,
    "sessionsAnalyzed": 12
  },
  "byTool": [
    {
      "tool": "ralph_hero__update_workflow_state",
      "calls": 89,
      "errors": 5,
      "errorRate": 0.056,
      "avgDurationMs": 340
    },
    {
      "tool": "ralph_hero__create_issue",
      "calls": 34,
      "errors": 0,
      "errorRate": 0.0,
      "avgDurationMs": 1100
    }
  ]
}
```

This provides the **before/after** measurement:
1. Capture baseline error rate over N sessions
2. Fix issues surfaced by collation
3. Capture post-fix error rate
4. Compare: tool success rate should improve for fixed error categories

---

## Implementation Phases

### Phase 1: Logging Infrastructure (prerequisite for everything)

- Add `RALPH_DEBUG` env var check to MCP server startup
- Create `DebugLogger` class: lazy file creation, JSONL append, session header
- Instrument tool dispatch with logging decorator
- Instrument `github-client.ts` GraphQL calls
- Write session log to `~/.ralph-hero/logs/session-{ts}.jsonl`
- **Estimate**: M

### Phase 2: Hook-Based Capture

- Create `debug-hook-counter.sh` for hook execution logging
- Create `debug-agent-events.sh` for SessionStart/Stop/Skill events
- Register hooks conditionally (check `RALPH_DEBUG` at top, `exit 0` if unset)
- Both hooks append to the same session log file (need file path coordination via env var or convention)
- **Estimate**: S

### Phase 3: Collation Tool

- Implement `ralph_hero__collate_debug` MCP tool
- JSONL parser + error filter + signature grouping
- GitHub issue search for dedup (search by `debug-auto` label + signature hash in body)
- Issue creation with structured body
- Comment creation for subsequent occurrences
- Conditional tool registration (only when `RALPH_DEBUG=true`)
- **Estimate**: L

### Phase 4: Stats Tool

- Implement `ralph_hero__debug_stats` MCP tool
- JSONL aggregation across multiple session files
- Group-by support (tool, category, day)
- Conditional registration
- **Estimate**: S

### Phase 5: Collation Skill (optional)

- A skill (`ralph-debug-collate`) that wraps the collation tool with context: "run collation, review results, triage the created issues"
- Could be triggered manually (`/ralph_debug_collate`) or as a step in the ralph loop
- **Estimate**: XS

---

## Open Questions

1. **Hook → MCP log coordination**: Hooks run as shell scripts, the MCP server writes JSONL from TypeScript. Two options:
   - **(a)** Hooks write to their own file (`~/.ralph-hero/logs/hooks-{session}.jsonl`), collation reads both
   - **(b)** Hooks write to the same file (need `RALPH_DEBUG_SESSION_FILE` env var set by MCP server — but MCP server starts independently of hooks)
   - Leaning **(a)** for simplicity. Collation reads `~/.ralph-hero/logs/*.jsonl`.

2. **Log file size**: A busy session could produce thousands of lines. Should we cap file size or event count? Probably not in v1 — JSONL is compact and disk is cheap.

3. **Privacy/tokens**: The logger must never write tokens or auth headers. `params` should be shallow-copied with `RALPH_HERO_GITHUB_TOKEN` and similar keys stripped. GraphQL `variables` should strip any `Authorization` headers.

4. **Collation frequency**: Should collation run automatically at session end, or only on-demand? Starting with on-demand (the tool) seems safer — avoids creating noise issues from one-off transient errors.

---

## Success Criteria

- [ ] `RALPH_DEBUG=true` produces JSONL logs in `~/.ralph-hero/logs/` with all 4 event categories
- [ ] `RALPH_DEBUG` unset/false produces zero overhead (no files, no extra work)
- [ ] `ralph_hero__collate_debug` creates well-formed issues with `debug-auto` label
- [ ] Subsequent collation runs update existing issues via comments (no duplicates)
- [ ] `ralph_hero__debug_stats` shows error rate and tool success rate
- [ ] Both debug tools are invisible when `RALPH_DEBUG` is off
- [ ] After fixing a collated issue, subsequent stats show measurable error rate reduction for that tool
