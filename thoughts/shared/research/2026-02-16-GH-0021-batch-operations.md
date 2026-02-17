---
date: 2026-02-16
github_issue: 21
github_url: https://github.com/cdubiel08/ralph-hero/issues/21
status: complete
type: research
---

# Research: GH-21 - Batch Operations for Bulk State Transitions, Estimation, and Labeling

## Problem Statement

All MCP server operations are single-issue. Processing backlogs (triage, sprint planning, cleanup, state cascading) requires N separate tool calls for N issues, burning tokens and API points. The issue proposes three tools: `batch_update`, `batch_triage`, and extending `advance_group`.

## Current State Analysis

### Existing Single-Issue Update Tools

The MCP server currently provides five single-issue mutation tools:

| Tool | File | Purpose |
|------|------|---------|
| `update_workflow_state` | [issue-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts) | Change workflow state with semantic intents |
| `update_estimate` | [issue-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts) | Set estimate (XS-XL) |
| `update_priority` | [issue-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts) | Set priority (P0-P3) |
| `update_issue` | [issue-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts) | Update title, body, labels, assignees |
| `create_comment` | [issue-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts) | Add comment to issue |

Each requires: resolve issue node ID (1 query) + resolve project item ID (1 query) + mutation (1 mutation) = **3 API calls per update minimum**.

### Existing Batch-Like Pattern: `advance_children`

[relationship-tools.ts:560-749](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L560-L749) already implements a batch pattern:

1. Fetches all sub-issues in one query (line 617-645)
2. Loops sequentially over children (line 675-737)
3. For each child: gets current state, checks if earlier, updates if needed
4. Tracks results in three arrays: `advanced[]`, `skipped[]`, `errors[]`
5. Per-item try/catch allows partial failure (line 729)

**Key insight**: This pattern works but is not optimized. Each child requires 2-3 API calls (resolve project item ID + get current field value + mutation). For 10 children, that's 20-30 API calls.

### Rate Limiting Infrastructure

[rate-limiter.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/rate-limiter.ts) tracks GitHub's point-based system:

- **Budget**: 5000 points/hour
- **Warning threshold**: 100 points remaining (line 26) - logs warning
- **Block threshold**: 50 points remaining (line 27) - waits up to 60s
- **Tracking**: Reactive only via `rateLimit` fragment in query responses (line 34-37)
- **No cost prediction**: Cannot estimate batch cost before executing

### Cache Architecture

[cache.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts) provides two tiers:

1. **SessionCache** (line 14-89): TTL-based (5min default) for query responses + stable node ID lookups
2. **FieldOptionCache** (line 100-189): Maps field/option names to IDs, populated once per session

**Mutation cache invalidation** ([github-client.ts:221-223](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/github-client.ts#L221-L223)):
```typescript
cache.invalidatePrefix("query:");  // Invalidates ALL query cache entries
```

**Problem for batches**: Every mutation invalidates the entire query cache. A batch of 10 mutations causes 10 full cache invalidations, defeating the purpose of caching. Node ID lookups (`issue-node-id:*`, `project-item-id:*`) are preserved since they're stable.

### GraphQL Client Structure

[github-client.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/github-client.ts) exposes four methods:

| Method | Line | Token | Cache? | Invalidates? |
|--------|------|-------|--------|-------------|
| `query()` | 173 | Repo | Optional | No |
| `projectQuery()` | 193 | Project | Optional | No |
| `mutate()` | 217 | Repo | Never | Yes (query:*) |
| `projectMutate()` | 228 | Project | Never | Yes (query:*) |

**Rate limit injection** (line 109-124): Automatically adds `rateLimit` fragment to every non-mutation query for proactive tracking.

## Key Discoveries

### 1. GitHub GraphQL Supports Multi-Alias Mutations

GitHub's GraphQL API supports aliased mutations in a single request:
```graphql
mutation {
  a1: updateProjectV2ItemFieldValue(input: { projectId: "...", itemId: "item1", ... }) { projectV2Item { id } }
  a2: updateProjectV2ItemFieldValue(input: { projectId: "...", itemId: "item2", ... }) { projectV2Item { id } }
  a3: updateProjectV2ItemFieldValue(input: { projectId: "...", itemId: "item3", ... }) { projectV2Item { id } }
}
```

This can reduce N mutations to 1 API call. GitHub allows up to ~100 mutations per request, but point cost scales with node count. A batch of 10 field updates in one request costs roughly the same points as 10 separate requests but saves 9 round trips and 9 cache invalidations.

### 2. Node ID Pre-Resolution Can Be Batched

Currently, resolving issue node IDs and project item IDs requires one query per issue. These could be batched:

```graphql
query {
  i1: repository(owner: "x", name: "y") { issue(number: 1) { id projectItems(first: 1) { nodes { id } } } }
  i2: repository(owner: "x", name: "y") { issue(number: 2) { id projectItems(first: 1) { nodes { id } } } }
}
```

This resolves both issue node IDs and project item IDs in a single query, eliminating N+1 patterns.

### 3. Field Option IDs Are Already Cached

The `FieldOptionCache` (populated once via `ensureFieldCache()`) already resolves field/option names to IDs without API calls. Batch operations can reuse this directly - no per-item cache lookups needed for field metadata.

### 4. Existing Helper Functions Can Be Reused

Key helpers already exist and can serve batch tools:

| Helper | Location | Reuse |
|--------|----------|-------|
| `resolveConfig()` | [issue-tools.ts:329-344](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L329-L344) | Config resolution |
| `resolveFullConfig()` | [issue-tools.ts:346-364](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L346-L364) | Full config with project |
| `ensureFieldCache()` | [issue-tools.ts:31](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L31) | Field option cache |
| `updateProjectItemField()` | [issue-tools.ts:220-259](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L220-L259) | Single field update |
| `isValidState()` | [workflow-states.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts) | State validation |
| `isEarlierState()` | [workflow-states.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts) | State comparison |

However, `updateProjectItemField()` and `resolveProjectItemId()` are currently defined as private functions inside `issue-tools.ts`, not exported. They'd need to be either exported or duplicated for a new batch tools file.

### 5. State Resolution Adds Complexity for Batch

[state-resolution.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts) validates state transitions per-command. For batch operations, this raises a question: should batch state changes be validated per-item (slower, safer) or applied uniformly (faster, could violate state machine)?

The `advance_children` pattern skips `resolveState()` validation and uses `isEarlierState()` directly - this is likely the right pattern for batch operations too.

## Potential Approaches

### Approach A: Single `batch_update` Tool (Recommended)

One general-purpose batch tool that accepts an array of operations:

```typescript
{
  issues: [1, 2, 3, 4, 5],
  operations: [
    { field: "workflow_state", value: "Research Needed" },
    { field: "estimate", value: "XS" },
    { field: "priority", value: "P1" },
  ]
}
```

**Pros:**
- Single tool covers all batch update scenarios (state, estimate, priority)
- Composable - apply multiple field changes in one call
- Aligns with `updateProjectV2ItemFieldValue` GraphQL mutation (all three fields are project field updates)
- Simplest API surface

**Cons:**
- Doesn't cover label/assignee updates (those are issue mutations, not project mutations)
- No per-issue differentiation (all issues get same updates)

### Approach B: Separate `batch_update` + `batch_triage` Tools

Two tools with different scopes:

- `batch_update`: Uniform updates (same operation across all issues)
- `batch_triage`: Per-issue differentiated actions (different operation per issue)

**Pros:**
- `batch_triage` enables heterogeneous operations (close #1, estimate #2, move #3)
- Better matches actual triage workflow where each issue gets different treatment

**Cons:**
- Two tools to maintain, overlapping functionality
- `batch_triage` schema is complex (per-issue action maps)
- Agent already knows what to do per-issue; the bottleneck is API calls, not decision-making

### Approach C: Extend `advance_children` into `advance_group`

Extend the existing pattern to support arbitrary issue sets (not just parent/child):

```typescript
{
  issues: [1, 2, 3],  // or group detection via parent number
  targetState: "Research Needed",
  onlyIfEarlier: true,  // Skip if already at/past target
}
```

**Pros:**
- Natural extension of existing pattern
- `advance_children` already handles partial failures and skip logic
- Preserves workflow state ordering guarantees

**Cons:**
- Only handles state transitions, not estimate/priority/label updates
- Doesn't reduce API calls per-item (still sequential mutations)

### Recommendation

**Start with Approach A** (`batch_update`) with these optimizations:

1. **Batch node ID resolution**: Single aliased query to resolve all issue + project item IDs
2. **Batch mutation execution**: Single aliased mutation to update all fields across all issues
3. **Deferred cache invalidation**: Only invalidate query cache once after all mutations complete
4. **Rate limit pre-check**: Estimate total point cost before executing (roughly 2 points per mutation)

**Extend `advance_children`** to accept an optional `issues` array (making parent optional). This makes it `advance_group` without breaking backward compatibility.

**Defer `batch_triage`** - per-issue differentiated actions can be achieved with multiple `batch_update` calls grouped by operation. The token savings from reducing individual tool calls are minimal since the agent still needs to decide per-issue.

## Implementation Considerations

### API Point Budget

- Batch resolve N issue IDs + project item IDs: ~1-2 points (one aliased query)
- Batch update K fields across N issues: ~N*K points (aliased mutation)
- Example: Update state + estimate for 10 issues = ~22 points total
- Current: Same operation = ~60 points (3 queries + 2 mutations per issue)
- **Savings: ~63% fewer API points**

### Cache Invalidation Strategy

Current approach invalidates ALL query cache on every mutation. For batch operations:

1. **Suppress invalidation during batch** - call `executeGraphQL()` directly instead of `mutate()`/`projectMutate()`
2. **Single invalidation after batch** - call `cache.invalidatePrefix("query:")` once at the end
3. **Or use aliased mutation** - one mutation = one invalidation regardless of batch size

### Error Handling

Follow `advance_children` pattern (line 663-743):
- Three result arrays: `succeeded[]`, `skipped[]`, `errors[]`
- Per-item try/catch within the batch
- Continue processing remaining items on partial failure
- No rollback (partial results are fine for idempotent field updates)

### File Organization

New file: `plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts`

- Register via `registerBatchTools()` in `index.ts`
- Import shared helpers from `issue-tools.ts` (will need to export them)
- Follow existing patterns: Zod schemas, `toolSuccess`/`toolError`, try/catch

### Helper Extraction

Several helpers are currently private to `issue-tools.ts` but needed by batch tools:

| Helper | Current Location | Action |
|--------|-----------------|--------|
| `ensureFieldCache()` | issue-tools.ts:31-53 | Export or move to shared module |
| `resolveIssueNodeId()` | issue-tools.ts:117-145 | Export or move to shared module |
| `resolveProjectItemId()` | issue-tools.ts:151-214 | Export or move to shared module |
| `updateProjectItemField()` | issue-tools.ts:220-259 | Export or move to shared module |
| `resolveConfig()` | issue-tools.ts:329-344 | Export or move to shared module |
| `resolveFullConfig()` | issue-tools.ts:346-364 | Export or move to shared module |

Recommendation: Extract these to a new `lib/helpers.ts` to avoid circular dependencies.

### Type Extensions

New types needed in `types.ts`:

```typescript
interface BatchOperation {
  field: "workflow_state" | "estimate" | "priority";
  value: string;
}

interface BatchResult {
  succeeded: Array<{ number: number; updates: Record<string, string> }>;
  skipped: Array<{ number: number; reason: string }>;
  errors: Array<{ number: number; error: string }>;
  rateLimit: { remaining: number; cost: number };
}
```

### Testing Strategy

Follow existing test patterns in `__tests__/`:
- Unit tests for batch resolution logic (mock GraphQL client)
- Unit tests for aliased query/mutation generation
- Integration-style tests for error handling (partial failures)
- Rate limit behavior tests (warning/block thresholds with batch sizes)

## Risks and Considerations

1. **GraphQL complexity limits**: GitHub may reject very large aliased mutations. Safe batch size is likely 20-50 items. Need to chunk larger batches.

2. **Point cost uncertainty**: Aliased mutations may cost more points than expected. Need to monitor `rateLimit.cost` in responses and adjust batch sizes dynamically.

3. **Partial failure semantics**: If mutation 5 of 10 fails in an aliased batch, GitHub may roll back all 10 or apply only the first 4. Need to verify GitHub's behavior with aliased mutation failures.

4. **Label/assignee updates are different**: These use `updateIssue` (repo mutation), not `updateProjectV2ItemFieldValue` (project mutation). Batch label updates would need a separate aliased mutation pattern.

5. **Interaction with #19 (handoff_ticket)**: If #19 replaces `update_workflow_state` with a validated `handoff_ticket` tool, batch state transitions should also use that validation. Coordinate implementation order.

6. **Duplicate helper code**: The `advance_children` tool in `relationship-tools.ts` duplicates helpers from `issue-tools.ts` (field cache, project item resolution, field update). A batch tools module would be a third copy. Helper extraction is a prerequisite.

## Recommended Next Steps

1. **Extract shared helpers** from `issue-tools.ts` and `relationship-tools.ts` into `lib/helpers.ts`
2. **Implement `batch_update` tool** in new `tools/batch-tools.ts` with aliased mutations
3. **Extend `advance_children`** to accept optional `issues` array
4. **Add batch-aware cache invalidation** (suppress during batch, single invalidation after)
5. **Add unit tests** for batch resolution and error handling
6. **Monitor API point costs** after deployment and tune batch sizes
