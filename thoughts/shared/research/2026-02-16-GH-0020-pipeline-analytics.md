---
date: 2026-02-16
github_issue: 20
github_url: https://github.com/cdubiel08/ralph-hero/issues/20
status: complete
type: research
---

# Research: GH-20 - Pipeline Analytics and Metrics Tracking

## Problem Statement

The ralph-hero workflow pipeline has no visibility into efficiency. There is no way to know how long issues spend in each phase, where bottlenecks occur, or what the team's throughput looks like. The issue proposes cycle time tracking, throughput metrics, bottleneck detection, and 3 new MCP tools (`pipeline_metrics`, `cycle_time_report`, `bottleneck_check`).

## Current State Analysis

### What Data Exists Today

**Issue timestamps** ([types.ts:209-211](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L209-L211)):
- `createdAt`, `updatedAt`, `closedAt` — available on every issue
- `updatedAt` changes on any modification (comments, labels, state changes) — not specific to workflow transitions

**Comment timestamps** ([types.ts:223-231](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L223-L231)):
- Each `IssueComment` has `createdAt`, `body`, `author.login`
- Skills leave structured comments during state transitions (research findings, plan summaries, review verdicts)
- Last 10 comments fetched by `get_issue` ([issue-tools.ts:695](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L695))

**Pipeline detection** ([pipeline-detection.ts:15-48](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L15-L48)):
- `PipelinePhase` enum: SPLIT, TRIAGE, RESEARCH, PLAN, REVIEW, IMPLEMENT, COMPLETE, HUMAN_GATE, TERMINAL
- `PipelinePosition` provides current phase, remaining phases, convergence status
- Purely state-based — **no temporal data** (no durations, no entry/exit timestamps)

**Workflow state ordering** ([workflow-states.ts:12-22](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts#L12-L22)):
- 9-state canonical progression: Backlog → Research Needed → Research in Progress → Ready for Plan → Plan in Progress → Plan in Review → In Progress → In Review → Done
- Helper functions: `stateIndex()`, `compareStates()`, `isEarlierState()`

**State transitions** ([issue-tools.ts:1206-1295](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1206-L1295)):
- `update_workflow_state` records `previousState` and `newState` in its return value
- **Does NOT record a timestamp** of the transition
- **Does NOT create a comment** logging the transition
- **Does NOT persist transition history** anywhere

### What Data Is NOT Captured

| Data Point | Current Status | Impact |
|-----------|---------------|--------|
| State transition timestamps | Not recorded | Cannot compute cycle times |
| Phase duration | Not tracked | Cannot identify slow phases |
| Transition history per issue | Not persisted | Cannot reconstruct timeline |
| WIP counts over time | Not tracked | Cannot detect queue growth |
| Blocker duration | Not recorded | Cannot measure wait time |
| Estimate accuracy | Not compared | Cannot improve estimations |

### Existing Related Infrastructure

**Rate limiter** ([rate-limiter.ts:19-89](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/rate-limiter.ts#L19-L89)):
- Tracks API point budget (5000/hour) with warning/block thresholds
- Analytics tools would add API calls — need to be efficient

**Session cache** ([cache.ts:14-89](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts#L14-L89)):
- In-memory, session-scoped — not suitable for persistent metrics
- Useful for caching expensive analytics queries within a session

**Field option cache** ([cache.ts:100-189](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts#L100-L189)):
- Maps field/option names to IDs — reusable for analytics tools

## Key Discoveries

### 1. Skills Already Leave Parseable Comments

Ralph workflow skills leave structured comments during state transitions that serve as an informal audit trail:

| Skill | Comment Pattern | Identifiable? |
|-------|----------------|---------------|
| ralph-research | "## Research Complete" + findings | Yes — marks research done |
| ralph-plan | "## Plan Created (Phase N of M)" | Yes — marks plan done |
| ralph-review | "## Review: APPROVED" / "REJECTED" | Yes — marks review outcome |
| ralph-impl | Implementation completion report | Yes — marks implementation done |
| ralph-triage | Escalation comments, split notifications | Partially |

**Key insight**: Comment `createdAt` + body pattern matching can reconstruct an approximate state transition timeline. However, this is fragile — comment formats aren't standardized, and not all transitions leave comments.

### 2. `update_workflow_state` Is the Natural Instrumentation Point

Every state transition goes through `update_workflow_state` ([issue-tools.ts:1234-1295](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1234-L1295)). It already resolves `previousState` and `newState`. Adding a structured transition comment here would create a reliable audit trail:

```markdown
<!-- ralph-transition: {"from":"Research Needed","to":"Research in Progress","command":"ralph_research","at":"2026-02-16T14:30:00Z"} -->
```

Using an HTML comment makes it parseable by machines while invisible in rendered markdown.

### 3. GitHub Projects V2 Supports DATE Fields But Lacks History

[types.ts:93-97](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L93-L97) shows `ProjectV2ItemFieldDateValue` is a supported field type. Custom DATE fields like "Last Transition At" could store the most recent transition timestamp, but:
- Only stores the **current value** — no change history
- Would need to be set by `update_workflow_state` on every transition
- Only captures the latest transition, not a full timeline

### 4. GitHub GraphQL Timeline Items API Exists But Is Not Used

GitHub's GraphQL API exposes `issue.timelineItems()` which includes events like labeled, assigned, and commented events with timestamps. This is **not currently queried** by the MCP server. However, it does NOT include Projects V2 field changes (workflow state transitions are project field updates, not issue events).

### 5. No Persistent Storage Exists in the MCP Server

The MCP server is stateless between sessions (session-scoped cache only). Analytics data would need to be stored either:
- In GitHub itself (comments, custom fields)
- In a local file (JSON/SQLite)
- Computed on-demand from existing data

## Potential Approaches

### Approach A: Comment-Based Audit Trail (Recommended for MVP)

**Instrument `update_workflow_state`** to append a structured HTML comment on every transition:

```html
<!-- ralph-transition: {"from":"Research Needed","to":"Research in Progress","command":"ralph_research","at":"2026-02-16T14:30:00Z"} -->
```

**Analytics tools** query issue comments and parse transition markers to compute:
- Cycle time per phase (diff between consecutive transitions)
- Total issue cycle time (first transition → Done)
- Phase distribution (which phases take longest)

**Pros:**
- Data lives in GitHub — no external storage needed
- Backfill possible from existing skill comments (approximate)
- Every transition automatically recorded
- HTML comments are invisible when rendered
- Works with existing `create_comment` tool

**Cons:**
- 1 extra API call per state transition (create comment mutation)
- Comments are append-only — no efficient bulk query for analytics across many issues
- Need to paginate through all comments to get full history
- Comment parsing is string-based — fragile if format changes

### Approach B: Custom DATE Fields on Project

Add DATE fields to the project for each major phase:
- "Researched At", "Planned At", "Reviewed At", "Implemented At", "Done At"

Update the relevant field when entering each state.

**Pros:**
- Structured, typed data — no parsing needed
- Queryable via standard project field queries
- Visible in GitHub Projects board views

**Cons:**
- Only captures phase entry time, not duration
- Limited to ~5 custom fields (one per phase) — not a full timeline
- Requires `setup_project` changes to create fields
- Cannot capture multiple transitions through the same phase (rework loops)
- Each field update = 1 mutation (same cost as comment approach)

### Approach C: Local JSON/SQLite Metrics Store

Maintain a local file with transition records. `update_workflow_state` writes to the file on each transition.

**Pros:**
- Fast queries, no API calls for analytics
- Rich query capabilities (aggregation, time ranges, filters)
- Can store arbitrary metrics (not limited by GitHub fields)

**Cons:**
- Not portable — data lives on one machine
- Lost on MCP server restart (unless persisted to disk)
- Not visible in GitHub UI
- Requires file I/O in the MCP server (currently pure API)
- Divergence risk — local store can desync from GitHub state

### Approach D: Hybrid (Recommended for Full Feature)

Combine Approach A (comments for audit trail) with computed analytics:

1. **Instrument `update_workflow_state`** with transition comments (Approach A)
2. **Compute metrics on-demand** by querying comments across issues
3. **Cache computed metrics** in SessionCache for the current session
4. **No persistent local store** — derive everything from GitHub data

This aligns with the existing architecture (no external dependencies) while providing full analytics capability.

### Recommendation

**Phase 1 (MVP)**: Approach A — Add transition comments to `update_workflow_state`. Implement `pipeline_metrics` tool that computes WIP counts and basic throughput from current state data.

**Phase 2 (Full)**: Approach D — Add `cycle_time_report` and `bottleneck_check` tools that parse transition comments for temporal analysis.

## Proposed Tool Designs

### `ralph_hero__pipeline_metrics` (Phase 1 — No New Data Needed)

Returns current pipeline snapshot computed from existing data:

```typescript
Input: { owner?, repo? }
Output: {
  snapshot: {
    [workflowState: string]: {
      count: number;
      issues: Array<{ number: number; title: string; estimate: string; priority: string }>;
    }
  },
  totalOpen: number,
  totalDone: number,
  wipByPhase: Record<PipelinePhase, number>,
  suggestions: string[],  // e.g., "Plan in Review has 5 items — consider running ralph-review"
}
```

**Implementation**: Reuse `list_issues` / `list_project_items` query pattern, group by workflow state.

### `ralph_hero__cycle_time_report` (Phase 2 — Requires Transition Comments)

Historical cycle time analysis computed from transition comments:

```typescript
Input: {
  owner?, repo?,
  since?: string,           // ISO date, default 30 days
  groupBy?: "phase" | "estimate" | "priority",
}
Output: {
  averageCycleTime: { days: number; hours: number },
  phaseBreakdown: Array<{
    phase: string;
    avgDuration: { days: number; hours: number };
    minDuration: { hours: number };
    maxDuration: { hours: number };
    issueCount: number;
  }>,
  completedIssues: number,
  throughput: { perDay: number; perWeek: number },
}
```

**Implementation**: Query recent Done issues, paginate through comments, parse transition markers, compute durations.

### `ralph_hero__bottleneck_check` (Phase 2 — Combination)

Identifies current bottlenecks using both snapshot and temporal data:

```typescript
Input: { owner?, repo? }
Output: {
  bottlenecks: Array<{
    phase: string;
    severity: "low" | "medium" | "high";
    wipCount: number;
    avgWaitTime?: { hours: number };
    suggestion: string;
  }>,
  healthy: boolean,
  summary: string,
}
```

**Detection rules:**
- WIP > 3 in any phase = medium bottleneck
- WIP > 5 in any phase = high bottleneck
- Phase with longest average wait time = bottleneck
- "Human Needed" issues older than 24h = high bottleneck

## Implementation Considerations

### API Cost of Analytics

**`pipeline_metrics`** (snapshot only):
- 1 `list_project_items` paginated query (~2-3 API calls for <100 items)
- Group and aggregate in memory — cheap

**`cycle_time_report`** (comment-based):
- 1 `list_issues` query to find Done issues (~1-2 API calls)
- N `get_issue` queries to fetch comments per issue (~1 each)
- For 20 completed issues: ~22 API calls, ~44 points
- **Optimization**: Batch comment fetching via aliased GraphQL queries

**`bottleneck_check`** (combined):
- Reuses `pipeline_metrics` snapshot (cached)
- Optional: fetch temporal data from recent transitions (~5-10 API calls)

### Transition Comment Format

Standardized format for machine parsing:

```html
<!-- ralph-transition: {"from":"STATE","to":"STATE","command":"CMD","at":"ISO8601"} -->
```

Properties:
- `from`: Previous workflow state
- `to`: New workflow state
- `command`: Ralph command that triggered transition (e.g., `ralph_research`)
- `at`: ISO 8601 timestamp

Parsing regex: `<!-- ralph-transition: ({.*?}) -->`

### Backfill Strategy

For existing issues (before transition comments exist):
1. Parse skill comments for phase markers ("Research Complete", "Plan Created", etc.)
2. Use comment `createdAt` as approximate transition time
3. Flag backfilled data as approximate in reports
4. Gracefully handle issues with no transition data

### File Organization

New file: `plugin/ralph-hero/mcp-server/src/tools/analytics-tools.ts`

- Register via `registerAnalyticsTools()` in `index.ts`
- Reuse existing query patterns from `issue-tools.ts`
- New helper: `parseTransitionComments()` in `lib/analytics.ts`

### Integration with `update_workflow_state`

Modify [issue-tools.ts:1269-1276](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1269-L1276) to add transition comment after field update:

```typescript
// After updateProjectItemField (line 1276):
await client.mutate(
  createCommentMutation,
  { issueId, body: `<!-- ralph-transition: ${JSON.stringify({ from, to, command, at: new Date().toISOString() })} -->` }
);
```

**Trade-off**: 1 extra mutation per state transition. At ~2 points per mutation, this doubles the cost of `update_workflow_state` from ~6 points to ~8 points. Acceptable for the analytics value gained.

### Interaction with #19 (Handoff Ticket)

If #19 replaces `update_workflow_state` with a validated `handoff_ticket` tool, the transition comment instrumentation should be added to `handoff_ticket` instead. The analytics tools themselves are independent of how transitions are triggered.

### Interaction with #21 (Batch Operations)

Batch state transitions (#21) would need to also create transition comments per issue. If using aliased mutations, the transition comments could be batched in the same mutation block.

## Risks and Considerations

1. **Comment volume**: Each state transition adds a comment. An issue going through all 9 states generates 8-9 transition comments. Combined with existing skill comments, issues could accumulate 15-20 comments. This is within GitHub's handling capacity but could make issue threads noisy.

2. **HTML comment visibility**: While hidden in rendered markdown, HTML comments are visible in raw markdown and issue edit mode. Users browsing raw issue data will see them.

3. **Comment pagination**: `get_issue` currently fetches last 10 comments. For analytics, need to paginate through ALL comments. This requires new pagination logic or using the pagination helper.

4. **Stale data**: Metrics are computed on-demand from current GitHub data. If issues are modified outside ralph-hero (manual GitHub UI changes), transition comments won't exist for those changes.

5. **Clock accuracy**: Transition timestamps use the MCP server's local clock, not GitHub's server clock. Minor skew is possible but unlikely to matter for cycle time analysis (hours/days granularity).

6. **Large project scalability**: For projects with 100+ issues, computing cycle time across all issues would require many API calls. Caching and `since` date filtering are essential.

## Recommended Next Steps

1. **Add transition comments to `update_workflow_state`** — single code change, creates the data foundation
2. **Implement `pipeline_metrics` tool** — snapshot only, no new data needed, immediate value
3. **Implement `cycle_time_report` tool** — leverages transition comments, computes temporal metrics
4. **Implement `bottleneck_check` tool** — combines snapshot + temporal data for actionable suggestions
5. **Add transition comment parsing helper** — `lib/analytics.ts` with `parseTransitionComments()`
6. **Consider splitting this L-sized issue** — Phase 1 (snapshot metrics + instrumentation) vs Phase 2 (temporal analytics) could be separate XS/S issues
