---
date: 2026-05-05
status: formed
type: spec
supersedes: thoughts/shared/plans/2026-02-21-debug-mode-observability-spec.md
related_issues: [537]
github_issue: 1096
github_url: https://github.com/cdubiel08/ralph-hero/issues/1096
sub_issues: [1097, 1098, 1099, 1100, 1101]
---

# Debug Mode & Self-Healing Observability — Spec v2 (OTel-native)

## Why this revision

The 2026-02-21 draft predates Claude Code's native OpenTelemetry support. That draft hand-rolled JSONL capture for tool calls, hook events, and session lifecycle — three of which Claude Code now emits as OTLP traces and metrics. It also reinvents query/aggregation that any OTel backend gives for free.

What's still load-bearing from v1: the **collation loop** that turns recurring errors into canonical, deduplicated GitHub issues with version stamps and occurrence histograms. That's the original idea worth preserving; everything underneath it changes.

## Goal (unchanged from v1)

When debug mode is on, ralph-hero captures structured telemetry and exposes a tool to collate it into canonical GitHub issues — making the loop self-improving. Closed feedback path: error → trace → grouped issue → fix → measurable error-rate drop.

## What changes vs. v1

| Layer | v1 approach | v2 approach |
|---|---|---|
| Tool-call capture | Decorator wraps `server.tool()` dispatch, writes JSONL | Already emitted by Claude Code OTel — no work |
| Hook capture | New `debug-hook-counter.sh` PostToolUse hook | Already emitted by Claude Code OTel — no work |
| Session/agent events | New `debug-agent-events.sh` hook | Already emitted by Claude Code OTel — no work |
| GraphQL capture | Hand-rolled JSONL log inside `github-client.ts` | OTel SDK in MCP server, emit child spans under inherited tool span |
| Storage | `~/.ralph-hero/logs/*.jsonl` | OTLP exporter → existing local Langfuse (`http://localhost:3100`) |
| `debug_stats` tool | Aggregates JSONL on demand | **Dropped** — backend UI / API gives this natively |
| `collate_debug` tool | Reads JSONL, signatures, files issues | Queries Langfuse API for error spans, signatures, files issues |
| Token scrubbing | Manual `params` filter | OTel `SpanProcessor` that scrubs attributes once, reused everywhere |

Three of v1's five phases collapse to "set two env vars."

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Claude Code (CLAUDE_CODE_ENABLE_TELEMETRY=1)                 │
│   emits OTLP: tool calls, hooks, sessions, skills, costs     │
└──────────────────────────────────────────────────────────────┘
                            │
                            │ OTLP/HTTP
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ ralph-hero MCP server                                        │
│   OTel SDK enabled when RALPH_DEBUG=true                     │
│   Adds GraphQL child spans (the only missing surface)        │
│   SpanProcessor strips RALPH_HERO_GITHUB_TOKEN-shaped attrs  │
└──────────────────────────────────────────────────────────────┘
                            │
                            │ OTLP/HTTP → http://localhost:3100
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ Local Langfuse stack (~/projects/langfuse, already running)  │
│   Stores spans, exposes /api/public/traces                   │
│   UI for ad-hoc query + dashboards (replaces debug_stats)    │
└──────────────────────────────────────────────────────────────┘
                            │
                            │ on-demand
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ ralph_hero__collate_debug (new MCP tool)                     │
│   Queries Langfuse API for error spans in window             │
│   Groups by signature → dedupes vs `debug-auto` issues       │
│   Creates/comments canonical GitHub issues                   │
└──────────────────────────────────────────────────────────────┘
```

## Activation

```bash
# settings.local.json (or ~/.claude/settings.json for global)
{
  "env": {
    "RALPH_DEBUG": "true",
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:3100/api/public/otel",
    "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Basic <base64(pk-lf-local-dev:sk-lf-local-dev)>",
    "OTEL_SERVICE_NAME": "ralph-hero"
  }
}
```

When `RALPH_DEBUG` is unset, the MCP server skips OTel SDK init entirely — zero overhead, no exporter threads, no spans buffered.

## Spans the MCP server adds

The only surface Claude Code OTel doesn't cover is what happens *inside* a ralph-hero MCP tool. The SDK setup is ~20 lines. Each `server.tool(...)` handler runs inside the inbound span Claude Code emits; we add child spans for:

```
span: ralph_hero.mcp.tool                  (parent — emitted by Claude Code)
├── span: ralph_hero.graphql               attrs: operation, durationMs, status, rateLimitRemaining, rateLimitCost
│   └── event: error                       attrs: errorType, message
└── span: ralph_hero.cache                 attrs: cacheKey, hit
```

Standard OTel context propagation links these to the originating tool call automatically — solving v1's "hook event ↔ tool call ↔ GraphQL request can't be correlated" problem.

### Attributes (canonical names)

| Attribute | Type | Notes |
|---|---|---|
| `ralph_hero.tool` | string | MCP tool name |
| `ralph_hero.issue_number` | int | When the tool operates on an issue |
| `ralph_hero.operation` | string | GraphQL operation name |
| `ralph_hero.error_type` | string | `graphql` \| `validation` \| `rate_limit` \| `network` |
| `ralph_hero.rate_limit.remaining` | int | From GraphQL response |
| `ralph_hero.rate_limit.cost` | int | From GraphQL response |
| `ralph_hero.version` | string | `mcp-server` semver — set as resource attribute |
| `service.name` | string | `ralph-hero` |
| `service.version` | string | Same as `ralph_hero.version` — resource attribute |

### Token scrubbing

A single `SpanProcessor.onStart` walks attributes and redacts any value matching `^gh[ps]_` or attribute keys ending in `_TOKEN` / `authorization`. Replaces v1's manual filter scattered across loggers.

## Layer 2: Collation (the load-bearing piece, mostly preserved)

### `ralph_hero__collate_debug`

Only registered when `RALPH_DEBUG=true`.

| Param | Required | Type | Default | Description |
|---|---|---|---|---|
| `since` | No | ISO date | last 24h | Window start |
| `dryRun` | No | boolean | false | Return report without filing issues |
| `projectNumber` | No | number | configured | Target project for created issues |
| `backend` | No | string | `langfuse` | `langfuse` (local) or other OTLP-store with a query API |

### What it does

1. **Query** the OTel backend for spans in the window where `status = error` OR `ralph_hero.error_type` is set.
2. **Group** by signature: `{span.name}:{ralph_hero.error_type}:{normalized_message}`. Normalization strips issue numbers, timestamps, and variable IDs (same logic as v1).
3. **Dedupe** against open GitHub issues labeled `debug-auto` by matching the signature hash stored in the issue body.
4. **File or comment**:
   - No match → create issue with the v1 issue shape (signature, hash, first-seen version, reproduction, occurrences table).
   - Match → append a comment with new occurrence count and a Langfuse trace URL for the latest example so a human can drill in.
5. **Workflow state**: created issues land in **Backlog** with the `debug-auto` label so triage handles them like any other ticket.

### Why query the backend instead of files

- Trace context is already linked — a filed issue can include "5 of 8 occurrences happened during `ralph_hero__update_workflow_state` calls from `impl-agent` sessions" because the parent span is attached.
- Langfuse's own dedup/sampling is available if span volume gets unwieldy.
- Replaying a trace by ID for human inspection is one click in the UI; not possible from raw JSONL.
- `debug_stats` tool deleted — Langfuse dashboards do this and more.

## Phases

### Phase 1: Turn on Claude Code OTel — XS

- Document the four `OTEL_*` env vars in `CLAUDE.md` under "Environment Variables"
- Sanity-check spans flowing into Langfuse via existing `~/projects/langfuse` stack (run `./scripts/up.sh` if needed)
- Verify token scrubbing behavior (Claude Code already strips its own auth, but verify nothing leaks under `mcp.tool.params`)

### Phase 2: MCP-server OTel instrumentation — S

- Add `@opentelemetry/sdk-node` + OTLP HTTP exporter as deps
- `src/lib/telemetry.ts`: lazy init guarded by `RALPH_DEBUG` check, NodeSDK with auto-instrumentation off (we want explicit spans, not noise)
- Wrap `github-client.ts` `query`/`mutate`/`projectQuery`/`projectMutate` to emit `ralph_hero.graphql` spans with rate-limit attrs
- `SpanProcessor` for token scrubbing
- Verification: run an MCP tool call, confirm GraphQL child span appears under the Claude Code parent in Langfuse UI

### Phase 3: Collation tool — M

- `src/tools/debug-tools.ts` already exists for `RALPH_DEBUG`-gated tools; add `ralph_hero__collate_debug` there
- Langfuse API client (HTTP, basic auth from `LANGFUSE_*` env)
- Signature grouping + normalization (port from v1 if it exists, otherwise fresh)
- GitHub dedup query + issue create/comment via existing `GitHubClient`
- Tests using a recorded Langfuse trace fixture

### Phase 4: Optional `ralph-debug-collate` skill — XS

- Wraps the tool with a workflow: "run collation, summarize new issues filed, suggest triage priorities"
- Manually invoked or scheduled

**Total estimated effort: XS + S + M + XS — roughly half of v1.**

## Open questions

1. **Backend choice when not running locally.** Spec assumes Langfuse on `localhost:3100` because it's already provisioned. For users without that stack, an alternative path: ship a minimal sqlite-backed OTLP collector, or document Honeycomb/Tempo as supported. **Defer to v2.1** — keep local-Langfuse as the supported default for now.
2. **Sampling.** A noisy session could emit thousands of spans. Langfuse handles this fine, but the collator should reject signatures with fewer than N (~3?) occurrences in the window to avoid filing noise issues for transient errors. Make N a parameter with default 3.
3. **Cross-session dedup window.** v1 did per-session signatures. v2 should default to the last 7 days when checking for existing `debug-auto` issues to avoid re-filing slowly-recurring errors as new every week.
4. **Hook → MCP correlation.** Claude Code emits both as OTLP, but does the trace context propagate from a hook into an MCP tool call? **Verification step in Phase 1** — if not, hook spans will be siblings rather than children, which is acceptable but worth knowing.

## Success criteria

- [ ] With `RALPH_DEBUG=true` and Langfuse up, every MCP tool call appears as a span in Langfuse with GraphQL child spans visible
- [ ] With `RALPH_DEBUG` unset, MCP server emits zero OTel traffic (verify by inspecting outgoing connections)
- [ ] No token, auth header, or `RALPH_HERO_GITHUB_TOKEN` value appears in any captured span attribute
- [ ] `ralph_hero__collate_debug --dryRun` returns a grouped error report from real Langfuse data
- [ ] Running collation twice over the same window produces zero duplicate issues — second run only adds comments
- [ ] After fixing a collated issue, the same query window N days later shows that signature absent from the report
- [ ] `ralph_hero__debug_stats` is **not** registered (confirms we deleted dead surface area)

## Migration from v1

If anyone has implemented the v1 JSONL capture in a branch: keep the collation tool's signature-normalization logic, port it to consume OTLP query results, delete the file-based capture and `debug_stats`. The issue-shape format and dedup-by-signature-hash approach carry over unchanged.
