---
date: 2026-02-23
github_issue: 361
github_url: https://github.com/cdubiel08/ralph-hero/issues/361
status: complete
type: research
---

# V4 Phase 7b: Observability Layer — Collation & Stats MCP Tools

## Problem Statement

Phase 7b adds two on-demand MCP tools (`ralph_hero__collate_debug` and `ralph_hero__debug_stats`) that read the JSONL session logs written by Phase 7a's `DebugLogger`. These tools surface recurring errors as GitHub issues and provide aggregated performance metrics. Both tools are conditionally registered only when `RALPH_DEBUG=true`.

**Hard dependency**: Phase 7a (#360) must ship first — it provides the JSONL log files that these tools consume. Neither tool can function without Phase 7a's logging infrastructure.

## Current State

- `plugin/ralph-hero/mcp-server/src/tools/debug-tools.ts` — **does not exist**
- `ralph_hero__collate_debug` / `ralph_hero__debug_stats` — **not registered** anywhere in `index.ts`
- JSONL logging infrastructure (`DebugLogger`, `RALPH_DEBUG`, session files) — **does not exist** (Phase 7a scope)
- Spec document — **exists** at `thoughts/shared/plans/2026-02-21-debug-mode-observability-spec.md` (authoritative reference, 362 lines)

## Key Discoveries

### 1. JSONL Log Format (written by Phase 7a)

Session files land at `~/.ralph-hero/logs/session-{YYYY-MM-DD}-{HH-MM-SS}-{random4}.jsonl`.

Four event categories (all relevant to Phase 7b's readers):

**Tool calls** (`cat: "tool"`):
```jsonl
{"ts":"...","cat":"tool","name":"ralph_hero__update_workflow_state","params":{...},"durationMs":340,"ok":true,"resultSummary":"state updated"}
{"ts":"...","cat":"tool","name":"ralph_hero__create_issue","params":{...},"durationMs":1200,"ok":false,"error":"GraphQL: Could not resolve to a Repository","errorType":"graphql"}
```

**GraphQL requests** (`cat: "graphql"`):
```jsonl
{"ts":"...","cat":"graphql","operation":"getIssue","variables":{...},"durationMs":180,"status":200,"rateLimitRemaining":4800,"rateLimitCost":1}
{"ts":"...","cat":"graphql","operation":"createIssue","variables":{...},"durationMs":0,"status":403,"error":"rate limited","retryAfter":30}
```

**Hook executions** (`cat: "hook"`):
```jsonl
{"ts":"...","cat":"hook","hook":"impl-state-gate","tool":"Skill","exitCode":2,"blocked":true,"message":"Issue not in Ready for Plan state"}
```

**Agent events** (`cat: "agent"`):
```jsonl
{"ts":"...","cat":"agent","event":"skill_invoked","skill":"ralph-impl","issueNumber":42}
{"ts":"...","cat":"agent","event":"session_end","toolCalls":47,"errors":2,"durationMs":180000}
```

**Session header** (first line of each file):
```jsonl
{"ts":"...","cat":"session","event":"start","version":"2.4.47","node":"22.0.0","os":"linux","env":{...}}
```

### 2. `ralph_hero__collate_debug` — Full Spec

**Source**: `thoughts/shared/plans/2026-02-21-debug-mode-observability-spec.md` lines 137–241

**Parameters**:
```typescript
{
  since?: string,        // ISO date, default: last 24h
  dryRun?: boolean,      // default: false (skip GitHub writes when true)
  projectNumber?: number // default: configured project
}
```

**Algorithm** (5 steps):
1. Read all `~/.ralph-hero/logs/*.jsonl` files within the `since` window
2. Filter to error events: `ok: false` OR `blocked: true` OR `exitCode !== 0`
3. Group by signature: `{cat}:{name|operation|hook}:{errorType|exitCode}:{normalized_error_message}` — normalization strips issue numbers, timestamps, variable data (produces stable string for repeated occurrences)
4. Hash each signature to 8 chars for deduplication key
5. For each signature group:
   - Search GitHub for open issues with label `debug-auto` matching the hash
   - **Match found**: add occurrence comment (new count, latest session context, tool call sequence leading to error)
   - **No match**: create new issue

**Issue creation**:
- Labels: `["debug-auto", "ralph-self-report"]`
- Title: `[Debug] {category}: {normalized_error_summary}`
- Body sections: `## Error Signature` (raw + 8-char hash), `## First Seen`, `## Error Details`, `## Reproduction` (JSON params), `## Occurrences` (table), `## Stats`
- Workflow state: `Backlog` (enters normal triage pipeline)

**Return**: summary of issues created, issues updated, occurrences recorded, `dryRun` flag

### 3. `ralph_hero__debug_stats` — Full Spec

**Source**: `thoughts/shared/plans/2026-02-21-debug-mode-observability-spec.md` lines 246–291

**Parameters**:
```typescript
{
  since?: string,          // ISO date, default: last 7 days
  groupBy?: "tool" | "category" | "day"  // default: "tool"
}
```

**Return shape**:
```typescript
{
  period: { from: string, to: string },
  summary: {
    totalToolCalls: number,
    totalErrors: number,
    errorRate: number,       // totalErrors / totalToolCalls
    sessionsAnalyzed: number
  },
  byTool: Array<{            // or byCategory or byDay depending on groupBy
    tool: string,
    calls: number,
    errors: number,
    errorRate: number,
    avgDurationMs: number
  }>
}
```

**Algorithm**: read all JSONL files in period → filter to `cat: "tool"` events → aggregate per `groupBy` dimension → compute rates and averages

### 4. MCP Tool Registration Pattern

**Source**: `plugin/ralph-hero/mcp-server/src/index.ts` lines 316–344

The universal pattern for all 51 existing tools:
```typescript
// In a registerXxxTools(server, client, fieldCache) function:
server.tool(
  "ralph_hero__tool_name",
  "Description for the LLM",
  { param: z.string().optional().describe("...") },  // Zod schema
  async (args) => {
    // implementation
    return toolSuccess(result);  // or toolError(message)
  }
)
```

Registration is called from `main()` in `index.ts`. For Phase 7b, registration must be **conditional**:
```typescript
// In index.ts main():
if (process.env.RALPH_DEBUG === 'true') {
  registerDebugTools(server, client);  // no fieldCache needed — uses fs, not GitHub project fields
}
```

**Note**: `registerDebugTools` likely doesn't need `fieldCache` — collation creates GitHub issues (repo API) but doesn't need project field option lookups. It does need `client` for GraphQL mutations (issue creation, comment creation).

### 5. GitHub Issue Creation Pattern for Collation

`hygiene-tools.ts` is read-only (no mutations). For issue creation, the reference is `issue-tools.ts` which already implements `ralph_hero__create_issue` and `ralph_hero__create_comment`. The collation tool should use the same `client` GraphQL mutation helpers:

```typescript
// Issue creation (from issue-tools.ts pattern):
await client.mutate(CREATE_ISSUE_MUTATION, { repositoryId, title, body, labelIds })

// Comment creation (from issue-tools.ts pattern):
await client.mutate(CREATE_ISSUE_COMMENT_MUTATION, { subjectId, body })

// Issue search (from issue-tools.ts pattern):
await client.query(SEARCH_ISSUES_QUERY, { query: `label:debug-auto is:open repo:${owner}/${repo}` })
```

The collation tool also needs to set workflow state (`Backlog`) after issue creation — use the same `ralph_hero__update_workflow_state` internal helper already used by `issue-tools.ts`.

### 6. Log File Coordination (hooks + MCP server)

Both Phase 7a hooks (shell scripts) and the MCP server (TypeScript) write JSONL independently. The spec resolves this with option (a): hooks write to `~/.ralph-hero/logs/hooks-{session}.jsonl` files; collation reads all `~/.ralph-hero/logs/*.jsonl` glob. Phase 7b's JSONL reader just needs to handle the union of both file patterns.

## Implementation Approach

### New file: `plugin/ralph-hero/mcp-server/src/tools/debug-tools.ts`

```typescript
export function registerDebugTools(server: McpServer, client: GitHubClient): void {
  server.tool("ralph_hero__collate_debug", "...", collateSchema, collateHandler);
  server.tool("ralph_hero__debug_stats", "...", statsSchema, statsHandler);
}
```

**Internal modules needed** (can be in the same file for S-sized implementation):
- `readLogFiles(since: Date): LogEvent[]` — glob `~/.ralph-hero/logs/*.jsonl`, parse lines, filter by `ts >= since`
- `groupBySignature(events: LogEvent[]): Map<string, LogEvent[]>` — normalize and hash error events
- `deduplicateAgainstGitHub(client, signatures)` — search for `debug-auto` issues per signature hash
- `createOrUpdateIssue(client, group, existing?)` — create issue or add occurrence comment
- `aggregateStats(events: LogEvent[], groupBy)` — compute metrics for `debug_stats`

### Conditional registration in `index.ts`

```typescript
// After existing registerXxxTools calls (around line 341):
if (process.env.RALPH_DEBUG === 'true') {
  registerDebugTools(server, client);
}
```

## Risks

1. **Phase 7a dependency is hard** — if #360 ships with a different log format, Phase 7b must adapt. Research should read Phase 7a's plan before implementing the log parser.
2. **`~/.ralph-hero/logs/` path** — spec uses `~` (home directory). Node.js requires `os.homedir()` to resolve this; cannot use `~` directly in `fs` calls.
3. **`dryRun` mode critical for testing** — collation creates real GitHub issues. `dryRun=true` must be well-tested before running in production sessions. The plan document should require `dryRun` testing as an acceptance criterion.
4. **Label creation** — `debug-auto` and `ralph-self-report` labels must exist in the repo for issue creation to succeed. Phase 7b plan should include a setup step to create these labels if missing.
5. **Error signature normalization** — over-normalization loses useful signal; under-normalization fragments the same error into many issues. The normalization regex (strip issue numbers, timestamps, UUIDs) needs careful testing against real error strings.
6. **S estimate is tight** — collation has meaningful complexity (JSONL parser, signature grouper, GitHub dedup, issue creation with structured body). Stats is simpler. Combined: S is correct but implementation should be done in one focused session.

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/tools/debug-tools.ts` — create new file with `registerDebugTools()`, `ralph_hero__collate_debug` and `ralph_hero__debug_stats` implementations
- `plugin/ralph-hero/mcp-server/src/index.ts` — add conditional `registerDebugTools(server, client)` call when `RALPH_DEBUG=true`

### Will Read (Dependencies)
- `thoughts/shared/plans/2026-02-21-debug-mode-observability-spec.md` — authoritative API spec for both tools (lines 137–291)
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` — GitHub issue creation and comment mutation patterns
- `plugin/ralph-hero/mcp-server/src/github-client.ts` — `client.mutate()`, `client.query()` call signatures
- `plugin/ralph-hero/mcp-server/src/types.ts` — `toolSuccess()`, `toolError()` helpers
- `plugin/ralph-hero/mcp-server/src/index.ts` — registration insertion point
- Phase 7a (#360) plan/research — JSONL log format confirmation (ensure alignment before implementing parser)
