---
date: 2026-02-16
status: draft
github_issue: 25
github_url: https://github.com/cdubiel08/ralph-hero/issues/25
---

# Auto-estimation Engine for Heuristic Issue Sizing

## Overview

Build a `ralph_hero__suggest_estimate` MCP tool that analyzes issue content (body metrics, keywords, labels, relationships) and produces an XS/S/M/L/XL size suggestion with confidence scoring and transparent signal breakdown. The tool is advisory only — triage agents decide whether to accept the suggestion. All heuristic logic lives in a pure, testable `lib/estimation-engine.ts` module; the tool handler in `tools/estimation-tools.ts` fetches issue data and delegates to the engine.

## Current State Analysis

### No Programmatic Estimation Exists

Issue estimation is entirely manual. The triager agent subjectively assigns XS-XL during triage via `ralph_hero__update_estimate` ([issue-tools.ts:1298-1349](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1298-L1349)). There are no heuristics, no suggestion mechanisms, and no feedback loops.

### Estimate Infrastructure

- **5 estimate options**: XS, S, M, L, XL defined in [project-tools.ts:94-100](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L94-L100)
- **Ordinal comparison**: `pick_actionable_issue` uses `validEstimates.indexOf()` for ordinal filtering ([issue-tools.ts:1714](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1714))
- **Oversized threshold**: `OVERSIZED_ESTIMATES = new Set(["M", "L", "XL"])` in [pipeline-detection.ts:70](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L70) triggers SPLIT phase
- **Time definitions**: XS < 2hr, S = 2-4hr per [ralph-split/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-split/SKILL.md)

### Available Issue Data

The `get_issue` GraphQL query ([issue-tools.ts:668-721](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L668-L721)) already fetches all data needed for heuristics:

| Signal Source | GraphQL Field | Heuristic Use |
|---------------|---------------|---------------|
| Body text | `body` | Length, checkbox count, code blocks, section headers, file paths |
| Title | `title` | Keyword extraction, word count |
| Labels | `labels.nodes[].name` | Category mapping (bug/enhancement/docs) |
| Sub-issues | `subIssues.nodes`, `subIssuesSummary.total` | More sub-issues = larger scope |
| Dependencies | `trackedInIssues`, `trackedIssues` | High connectivity = higher complexity |
| Comments | `comments.nodes` | Discussion volume suggests ambiguity |

### Technology Constraints

The MCP server has minimal dependencies (`@modelcontextprotocol/sdk`, `@octokit/graphql`, `zod`). No NLP/ML libraries — must use pure heuristic/keyword-based approach with static weights.

## Desired End State

1. `ralph_hero__suggest_estimate` tool accepts an issue number, returns suggested estimate with confidence and signal breakdown
2. Pure heuristic engine in `lib/estimation-engine.ts` is independently testable with no API dependencies
3. Signals are transparent — callers can see exactly why a size was suggested
4. Result includes `oversized: true` flag when M/L/XL to alert about SPLIT threshold

### Verification
- [ ] `npm run build` compiles with no type errors
- [ ] `npm test` passes with estimation engine and tool tests
- [ ] Calling `suggest_estimate` on a small issue (few checkboxes, short body) returns XS or S
- [ ] Calling `suggest_estimate` on a complex issue (many checkboxes, keywords like "refactor") returns M or larger
- [ ] Signal breakdown explains the reasoning transparently
- [ ] `oversized` flag is true when suggested estimate is M/L/XL

## What We're NOT Doing

- Not implementing historical calibration (requires data store + sufficient history — future issue)
- Not auto-applying estimates (advisory only — triage agent decides)
- Not modifying the triage skill to call this tool (integration is a follow-up, see Phase 2)
- Not adding NLP/ML dependencies
- Not implementing a configurable rules engine (static weights are sufficient for MVP)
- Not adding new project fields or custom metadata

## Implementation Approach

Separate concerns into two layers:
1. **`lib/estimation-engine.ts`** — Pure functions: signal extraction + weighted scoring + confidence calculation. Zero API dependencies, fully unit-testable with mock issue data.
2. **`tools/estimation-tools.ts`** — MCP tool handler: fetches issue via GraphQL, passes data to engine, returns structured result. Follows existing tool registration patterns.

This separation allows thorough testing of heuristic logic without mocking GitHub API calls.

---

## Phase 1: Estimation Engine Core

### Overview

Create the pure heuristic engine with signal extractors, weighted scoring, and confidence calculation. This phase has no API dependencies — everything operates on plain data structures.

### Changes Required

#### 1. Create estimation engine module
**File**: `plugin/ralph-hero/mcp-server/src/lib/estimation-engine.ts` (new)

**Types**:

```typescript
/** Valid estimate sizes in ordinal order */
type EstimateSize = "XS" | "S" | "M" | "L" | "XL";

/** A single signal extracted from issue data */
interface EstimationSignal {
  factor: string;        // e.g., "body_checkbox_count"
  value: string | number; // e.g., 6
  impact: string;        // e.g., "+1 size"
  weight: number;        // numeric contribution to score (-2 to +2)
}

/** Input data for the estimation engine (matches get_issue output shape) */
interface IssueData {
  title: string;
  body: string;
  labels: string[];
  subIssueCount: number;
  dependencyCount: number; // blocking + blockedBy
  commentCount: number;
}

/** Output from the estimation engine */
interface EstimationResult {
  suggestedEstimate: EstimateSize;
  confidence: number;     // 0.0 - 1.0
  signals: EstimationSignal[];
  rawScore: number;       // internal score for debugging
  oversized: boolean;     // true if M/L/XL (triggers SPLIT)
}
```

**Signal extractor functions** (each returns an `EstimationSignal`):

1. **`extractBodyLength(body)`**:
   - < 200 chars → weight -1 ("Short description suggests simple task")
   - 200-500 chars → weight 0 (neutral)
   - 500-1000 chars → weight +0.5
   - > 1000 chars → weight +1 ("Long description suggests complex scope")

2. **`extractCheckboxCount(body)`**: Count `- [ ]` and `- [x]` patterns
   - 0-2 → weight 0 (neutral)
   - 3-5 → weight +0.5
   - 6-8 → weight +1
   - 9+ → weight +1.5

3. **`extractCodeBlockCount(body)`**: Count triple-backtick blocks
   - 0-1 → weight 0
   - 2-3 → weight +0.5
   - 4+ → weight +1

4. **`extractSectionCount(body)`**: Count `##` headers
   - 0-2 → weight 0
   - 3-4 → weight +0.5
   - 5+ → weight +1

5. **`extractFilePathCount(body)`**: Count file path patterns (e.g., `src/`, `.ts`, `.py`, `/path/to/`)
   - 0-1 → weight 0
   - 2-4 → weight +0.5
   - 5+ → weight +1

6. **`extractKeywords(title, body)`**: Scan for complexity indicator keywords
   - High complexity: "refactor", "migrate", "redesign", "architecture", "rewrite", "breaking", "security", "authentication", "database", "schema" → weight +1 each (capped at +2 total)
   - Low complexity: "typo", "fix text", "rename", "documentation", "bump version", "update dependency", "lint", "format" → weight -1 each (capped at -2 total)

7. **`extractLabelSignals(labels)`**: Map labels to size baselines
   - "bug" → weight -0.5 (bugs tend smaller)
   - "enhancement" → weight +0.5
   - "documentation" → weight -1
   - "breaking-change" → weight +1.5
   - "performance" → weight +0.5
   - "security" → weight +0.5

8. **`extractRelationshipSignals(subIssueCount, dependencyCount)`**:
   - Sub-issues > 0 → weight +1 ("Has child issues suggesting compound scope")
   - Dependencies > 2 → weight +0.5 ("High connectivity")

**Scoring function** `computeEstimate(signals: EstimationSignal[]): { estimate: EstimateSize; confidence: number; rawScore: number }`:

1. Sum all signal weights → `rawScore`
2. Map rawScore to estimate:
   - rawScore <= -1.0 → XS
   - rawScore -1.0 to 0.5 → S
   - rawScore 0.5 to 2.0 → M
   - rawScore 2.0 to 3.5 → L
   - rawScore > 3.5 → XL
3. Confidence = based on signal agreement:
   - All signals same direction → 0.8-0.9
   - Mixed signals → 0.4-0.6
   - Calculated as: `1.0 - (stddev of weights / max possible stddev)`, clamped to [0.3, 0.95]

**Main entry point** `suggestEstimate(data: IssueData): EstimationResult`:
1. Run all signal extractors
2. Filter out zero-weight signals (don't report neutral signals)
3. Call `computeEstimate(signals)`
4. Return `{ suggestedEstimate, confidence, signals, rawScore, oversized }`

#### 2. Create estimation engine tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/estimation-engine.test.ts` (new)

**Tests**:
- **Body metrics**:
  - Short body (< 200 chars) → signal weight negative
  - Long body (> 1000 chars) → signal weight positive
  - Body with 6 checkboxes → checkbox signal weight +1
  - Body with 0 checkboxes → no checkbox signal reported
- **Keywords**:
  - Title containing "refactor" → high complexity signal
  - Body containing "fix typo" → low complexity signal
  - Both high and low keywords → signals partially cancel
- **Labels**:
  - `["bug"]` → negative weight
  - `["enhancement", "breaking-change"]` → positive weight
  - `["documentation"]` → strong negative weight
- **Relationships**:
  - 3 sub-issues → positive weight
  - 0 sub-issues, 0 deps → no relationship signals
- **End-to-end scoring**:
  - Minimal issue (short body, no checkboxes, "documentation" label) → XS
  - Moderate issue (medium body, 4 checkboxes, "enhancement" label) → S or M
  - Complex issue (long body, 8 checkboxes, "refactor" keyword, "breaking-change" label) → L or XL
- **Confidence**:
  - All signals agree on direction → confidence > 0.7
  - Signals conflict → confidence < 0.6
- **Oversized flag**:
  - XS/S → `oversized: false`
  - M/L/XL → `oversized: true`
- **Edge cases**:
  - Empty body → returns XS with low confidence
  - No labels → no label signals reported

### Success Criteria

#### Automated Verification
- [ ] `npm run build` — no type errors
- [ ] `npx vitest run src/__tests__/estimation-engine.test.ts` — all tests pass

#### Manual Verification
- [ ] Review signal weights for reasonable calibration against known issues

**Dependencies created for next phase**: `lib/estimation-engine.ts` with `suggestEstimate()`, `IssueData`, and `EstimationResult` types.

---

## Phase 2: MCP Tool and Registration

### Overview

Create the `ralph_hero__suggest_estimate` MCP tool that fetches issue data via GraphQL, passes it to the estimation engine, and returns the structured result. Register in `index.ts`.

### Changes Required

#### 1. Create estimation tools module
**File**: `plugin/ralph-hero/mcp-server/src/tools/estimation-tools.ts` (new)

**Contents**:

`registerEstimationTools(server, client, fieldCache)` function following existing patterns.

**`ralph_hero__suggest_estimate` tool**:

Input schema:
```typescript
{
  owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
  repo: z.string().optional().describe("Repository name. Defaults to env var"),
  number: z.number().describe("Issue number to estimate"),
}
```

Implementation:
1. Resolve config via `resolveConfig(client, args)` pattern (repo-level only, no project required)
2. Fetch issue data via GraphQL — reuse the same query pattern as `get_issue` but only fetch the fields needed for estimation:
   ```graphql
   query($owner: String!, $repo: String!, $number: Int!) {
     repository(owner: $owner, name: $repo) {
       issue(number: $number) {
         title
         body
         labels(first: 20) { nodes { name } }
         subIssuesSummary { total }
         trackedInIssues(first: 1) { totalCount }
         trackedIssues(first: 1) { totalCount }
         comments(last: 1) { totalCount }
         projectItems(first: 10) {
           nodes {
             project { number }
             fieldValues(first: 20) {
               nodes {
                 ... on ProjectV2ItemFieldSingleSelectValue {
                   __typename name
                   field { ... on ProjectV2FieldCommon { name } }
                 }
               }
             }
           }
         }
       }
     }
   }
   ```
3. Extract `IssueData` from GraphQL response:
   - `title` from response
   - `body` from response
   - `labels` from `labels.nodes[].name`
   - `subIssueCount` from `subIssuesSummary.total` (default 0)
   - `dependencyCount` from `trackedInIssues.totalCount + trackedIssues.totalCount`
   - `commentCount` from `comments.totalCount`
4. Call `suggestEstimate(issueData)` from `lib/estimation-engine.ts`
5. Extract current estimate from project field values (if set)
6. Return structured result:
   ```typescript
   {
     number: args.number,
     suggestedEstimate: result.suggestedEstimate,
     confidence: result.confidence,
     signals: result.signals,
     currentEstimate: existingEstimate || null,
     oversized: result.oversized,
   }
   ```

**Note**: The `resolveConfig` helper from `issue-tools.ts` is not exported. The estimation tool should inline a minimal version (same 5-line pattern) or the helper can be extracted to a shared location. Prefer inlining to avoid modifying `issue-tools.ts` for this issue.

#### 2. Register estimation tools in index.ts
**File**: `plugin/ralph-hero/mcp-server/src/index.ts`

**Changes**:
- Add import: `import { registerEstimationTools } from "./tools/estimation-tools.js";`
- Add registration after relationship tools (~line 294):
  ```typescript
  // Phase 5: Estimation tools
  registerEstimationTools(server, client, fieldCache);
  ```

#### 3. Add integration test
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/estimation-tools.test.ts` (new)

**Tests** (test the data transformation layer, not API calls):
- `extractIssueData` correctly maps GraphQL response to `IssueData` shape
- Tool returns error for non-existent issue number
- Current estimate is included in output when set
- Current estimate is null when not set
- `oversized` flag correctly reflects M/L/XL threshold

### Success Criteria

#### Automated Verification
- [ ] `npm run build` — no type errors
- [ ] `npm test` — all tests pass (existing + new)
- [ ] `npx vitest run src/__tests__/estimation-tools.test.ts` — focused test pass

#### Manual Verification
- [ ] Call `suggest_estimate` on issue #25 — verify it returns a reasonable estimate with signals
- [ ] Call `suggest_estimate` on a simple issue — verify XS/S suggestion
- [ ] Verify signal breakdown is human-readable and explains the reasoning

**Depends on**: Phase 1 (`lib/estimation-engine.ts` module).

---

## Testing Strategy

### Unit Tests (Phase 1)
Pure function testing of the estimation engine with mock `IssueData` objects. No API mocking needed. Test signal extractors individually and end-to-end scoring with representative issue profiles.

### Integration Tests (Phase 2)
Test the data transformation from GraphQL response to `IssueData`. Mock the GraphQL response shape, not the API call itself.

### Manual Validation
After implementation, run `suggest_estimate` on 5-10 real issues with known estimates to validate calibration:
- Compare suggested vs actual estimates
- Verify signal explanations make sense
- Check confidence levels are reasonable

---

## Integration Testing

After all phases complete:
- [ ] `npm run build` — clean compile, no type errors
- [ ] `npm test` — all tests pass (existing + new)
- [ ] Run `suggest_estimate` on issue #25 — verify structured output with signals
- [ ] Run `suggest_estimate` on a known-XS issue — verify XS/S suggestion
- [ ] Run `suggest_estimate` on a known-L issue — verify L/XL suggestion with `oversized: true`
- [ ] Verify the tool appears in MCP tool listing

## Future Considerations (Out of Scope)

- **Triage skill integration**: Add `suggest_estimate` call before RE-ESTIMATE action in [ralph-triage/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-triage/SKILL.md)
- **Historical calibration**: `ralph_hero__calibrate_estimates` tool comparing past suggestions vs actual outcomes
- **Weight tuning**: Per-project weight configuration via project metadata or config file
- **Estimate accuracy tracking**: Compare suggested estimates vs final estimates after triage

## References

- [Issue #25](https://github.com/cdubiel08/ralph-hero/issues/25)
- [Research: GH-25](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-16-GH-0025-auto-estimation-engine.md)
- [issue-tools.ts — update_estimate](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1298-L1349)
- [issue-tools.ts — get_issue](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L585-L879)
- [issue-tools.ts — pick_actionable_issue](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1677-L1906)
- [lib/pipeline-detection.ts — OVERSIZED_ESTIMATES](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L70)
- [project-tools.ts — ESTIMATE_OPTIONS](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L94-L100)
