---
date: 2026-02-16
status: draft
github_issue: 20
github_url: https://github.com/cdubiel08/ralph-hero/issues/20
revision: 2
revision_reason: "Reviewer rejection — Phase 1 targeted deleted tool (update_workflow_state → handoff_ticket per #19), Phase 2 redundant with #26 pipeline_dashboard. Rescoped to transition comment format spec + parser library only."
---

# Pipeline Analytics and Metrics Tracking (Revised)

## Revision History

**v2 (2026-02-16)**: Rescoped after reviewer rejection ([critique](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/reviews/2026-02-16-GH-0020-critique.md)). Two blocking issues addressed:
1. **Phase 1 dropped instrumentation**: `update_workflow_state` will be deleted by #19 and replaced with `handoff_ticket`, which already creates audit comments on every transition. No instrumentation target exists.
2. **Phase 2 dropped entirely**: `pipeline_metrics` is a strict subset of #26's approved `pipeline_dashboard`. Redundant.

**Rescoped deliverable**: `lib/transition-comments.ts` — transition comment format specification, builder, and parser. This module provides the data layer for future temporal analytics tools (`cycle_time_report`, `bottleneck_check`) to parse transition history from issue comments.

## Overview

Create `lib/transition-comments.ts` — a pure utility module that defines the canonical machine-parseable transition comment format (`<!-- ralph-transition: {...} -->`), provides builder and parser functions, and includes a fallback parser for #19's `handoff_ticket` markdown audit comments. This module has no API dependencies, does not instrument any tool, and is fully unit-testable. It establishes the data format contract that future analytics tools will consume.

## Current State Analysis

### #19 `handoff_ticket` Creates Audit Comments

Issue #19 (P1, In Progress) replaces `update_workflow_state` with `handoff_ticket`. The new tool posts a structured audit comment on every state transition ([#19 plan, Phase 2, Step 8](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-16-GH-0019-validated-handoff-ticket-tool.md)):

```markdown
**State transition**: {prev} → {new} (intent: {intent})
**Command**: ralph_{command}
**Reason**: {reason}
```

These comments have `createdAt` timestamps (from GitHub) and contain transition metadata, but the format is human-readable markdown — not optimized for machine parsing.

### #26 `pipeline_dashboard` Covers Snapshot Metrics

Issue #26 (approved) creates `ralph_hero__pipeline_dashboard` with WIP counts by state, per-issue listings, health indicators, and multiple output formats. This is a strict superset of the dropped `pipeline_metrics` tool.

### The Gap: No Machine-Parseable Transition Format

Neither #19's audit comments nor #26's dashboard provide a standardized, machine-parseable transition record format. Future tools like `cycle_time_report` need to:
1. Scan issue comments for transition records
2. Extract `from`, `to`, `command`, and timestamp
3. Compute phase durations (diff between consecutive transitions)

This requires a defined format and a reliable parser.

## Desired End State

1. `lib/transition-comments.ts` defines `TransitionRecord` type and the `<!-- ralph-transition: {...} -->` HTML comment format
2. `buildTransitionComment()` creates machine-parseable HTML comments
3. `parseTransitionComments()` extracts transition records from HTML comment format
4. `parseAuditComments()` extracts transition records from #19's markdown audit comment format (backward compatibility)
5. All functions are pure utilities with no API dependencies
6. Comprehensive tests cover builder, parser, round-trip, edge cases, and audit comment parsing

### Verification
- [ ] `npm run build` compiles with no type errors
- [ ] `npm test` passes with transition-comments tests
- [ ] `buildTransitionComment()` produces valid HTML comment with JSON payload
- [ ] `parseTransitionComments()` extracts records from HTML comments
- [ ] `parseAuditComments()` extracts records from #19-style markdown audit comments
- [ ] Round-trip: `build` → `parse` produces identical `TransitionRecord`
- [ ] HTML comments are invisible in rendered GitHub markdown

## What We're NOT Doing

- Not instrumenting any tool (no modification to `handoff_ticket`, `update_workflow_state`, or any existing tool)
- Not implementing `pipeline_metrics` tool (redundant with #26's `pipeline_dashboard`)
- Not implementing `cycle_time_report` tool (future issue — will consume this module)
- Not implementing `bottleneck_check` tool (future issue)
- Not adding DATE custom fields to the project
- Not backfilling existing issues
- Not adding local/external storage
- Not modifying `index.ts` (no tool registration needed)

## Implementation Approach

Single phase — this is a pure library module with no API dependencies.

---

## Phase 1: Transition Comments Library (Only Phase)

### Overview

Create `lib/transition-comments.ts` with the canonical transition comment format, builder, two parsers (HTML comment + audit markdown), and comprehensive tests.

### Changes Required

#### 1. Create transition comments module
**File**: `plugin/ralph-hero/mcp-server/src/lib/transition-comments.ts` (new)

**Types**:

```typescript
/** A single state transition record extracted from an issue comment. */
export interface TransitionRecord {
  from: string;       // Previous workflow state
  to: string;         // New workflow state
  command: string;    // Ralph command that triggered transition (e.g., "ralph_research")
  at: string;         // ISO 8601 timestamp
}
```

**Constants**:

```typescript
/** Regex pattern for HTML transition comments: <!-- ralph-transition: {...} --> */
export const TRANSITION_COMMENT_PATTERN = /<!-- ralph-transition: ({.*?}) -->/g;

/** Regex pattern for #19 handoff_ticket audit comments */
export const AUDIT_COMMENT_PATTERN =
  /\*\*State transition\*\*: (.+?) → (.+?) \(intent: .+?\)\n\*\*Command\*\*: ralph_(\w+)/g;
```

**Functions**:

**`buildTransitionComment(record: TransitionRecord): string`**
- Returns: `<!-- ralph-transition: {"from":"...","to":"...","command":"...","at":"..."} -->`
- The HTML comment is invisible in rendered GitHub markdown
- JSON is compact (no pretty-printing) for single-line format
- Used by any tool that wants to record machine-parseable transition data

**`parseTransitionComments(text: string): TransitionRecord[]`**
- Scans text for all `<!-- ralph-transition: {...} -->` patterns
- Parses JSON payload from each match
- Returns array of `TransitionRecord` objects
- Gracefully handles malformed JSON (skips unparseable entries, does not throw)
- Returns empty array if no matches

**`parseAuditComments(text: string, commentCreatedAt: string): TransitionRecord[]`**
- Scans text for #19's markdown audit comment pattern: `**State transition**: X → Y (intent: Z)\n**Command**: ralph_cmd`
- Extracts `from` (X), `to` (Y), `command` (cmd)
- Uses `commentCreatedAt` parameter as the `at` timestamp (since audit comments don't embed their own timestamp — the comment's `createdAt` from GitHub serves as the transition time)
- Returns array of `TransitionRecord` objects
- Returns empty array if no matches

**`parseAllTransitions(commentBody: string, commentCreatedAt: string): TransitionRecord[]`**
- Convenience function that tries both parsers
- First tries `parseTransitionComments()` (preferred format)
- Falls back to `parseAuditComments()` if no HTML comments found
- Returns combined results (deduped by `from` + `to` + `command` if both formats present)
- This is the primary entry point for future analytics tools

#### 2. Add comprehensive tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/transition-comments.test.ts` (new)

**Tests**:

**Builder tests**:
- `buildTransitionComment` produces string starting with `<!--` and ending with `-->`
- Output contains valid JSON with all 4 fields (`from`, `to`, `command`, `at`)
- Output is a single line (no line breaks)
- Special characters in state names are JSON-escaped properly

**HTML comment parser tests**:
- Extracts single transition from comment body
- Extracts multiple transitions from multi-line body
- Returns empty array for comment with no transition markers
- Handles malformed JSON gracefully (returns empty, no throw)
- Handles partial match (opening `<!--` without closing `-->`) — no match
- Handles extra whitespace around JSON payload

**Audit comment parser tests**:
- Extracts transition from `**State transition**: X → Y (intent: Z)\n**Command**: ralph_cmd` format
- Uses provided `commentCreatedAt` as the `at` timestamp
- Returns empty array for non-audit comment text
- Handles multiple audit transitions in one comment (unlikely but defensive)

**Round-trip tests**:
- `build` → `parse` produces identical `TransitionRecord`
- Multiple `build` outputs concatenated → `parse` returns all records

**`parseAllTransitions` tests**:
- Prefers HTML comment format when both present
- Falls back to audit format when no HTML comments found
- Returns empty for comment with neither format
- Deduplicates if both formats describe the same transition

### Success Criteria

#### Automated Verification
- [x] `npm run build` — no type errors
- [x] `npm test` — all transition-comments tests pass
- [x] `npx vitest run src/__tests__/transition-comments.test.ts` — focused test pass

#### Manual Verification
- [ ] Paste a `buildTransitionComment()` output into a GitHub comment — verify it's invisible in rendered view
- [ ] Paste #19-style audit comment text into `parseAuditComments()` — verify extraction works

---

## Integration Testing

After phase complete:
- [ ] `npm run build` — clean compile, no type errors
- [ ] `npm test` — all tests pass (existing + new)
- [ ] Module exports are accessible: `TransitionRecord`, `buildTransitionComment`, `parseTransitionComments`, `parseAuditComments`, `parseAllTransitions`, `TRANSITION_COMMENT_PATTERN`

## Coordination with Other Issues

| Issue | Relationship | Action |
|-------|-------------|--------|
| **#19** (handoff_ticket) | #19's audit comments are parseable by `parseAuditComments()` | No changes to #19 needed. Future enhancement: #19 could optionally append `<!-- ralph-transition: {...} -->` alongside audit text for dual-format support. |
| **#26** (pipeline_dashboard) | #26 provides snapshot metrics, making `pipeline_metrics` redundant | Phase 2 dropped. No conflict. |
| **Future: cycle_time_report** | Will import `parseAllTransitions()` to compute phase durations from issue comment history | This module provides the data layer. |
| **Future: bottleneck_check** | Will combine #26 dashboard data with temporal data from this module | This module provides the parser. |

## References

- [Issue #20](https://github.com/cdubiel08/ralph-hero/issues/20)
- [Research: GH-20](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-16-GH-0020-pipeline-analytics.md)
- [Review Critique](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/reviews/2026-02-16-GH-0020-critique.md)
- [#19 Plan — handoff_ticket audit comments](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-16-GH-0019-validated-handoff-ticket-tool.md)
- [#26 Plan — pipeline_dashboard](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-16-GH-0026-workflow-visualization-pipeline-dashboard.md)
