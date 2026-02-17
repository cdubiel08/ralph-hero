---
date: 2026-02-16
github_issue: 25
github_url: https://github.com/cdubiel08/ralph-hero/issues/25
status: complete
type: research
---

# GH-25: Auto-estimation Engine for Heuristic Issue Sizing

## Problem Statement

Currently, issue estimation in the ralph-hero workflow is entirely manual. The triager agent makes subjective judgments about issue size (XS/S/M/L/XL) during triage, with no programmatic baseline. This leads to inconsistent estimates across sessions, wasted deliberation time, and no feedback loop to improve accuracy.

The goal is to build a heuristic-based `ralph_hero__suggest_estimate` MCP tool that analyzes issue content and produces a size suggestion with confidence scoring and signal transparency.

## Current State Analysis

### Estimation Infrastructure

The estimate system uses GitHub Projects V2 single-select fields with 5 options defined in [project-tools.ts:94-100](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L94-L100):

```typescript
const ESTIMATE_OPTIONS: FieldOption[] = [
  { name: "XS", color: "BLUE", description: "Extra Small (1)" },
  { name: "S", color: "GREEN", description: "Small (2)" },
  { name: "M", color: "YELLOW", description: "Medium (3)" },
  { name: "L", color: "ORANGE", description: "Large (4)" },
  { name: "XL", color: "RED", description: "Extra Large (5)" },
];
```

Time-based definitions from [ralph-split/SKILL.md:175-176](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-split/SKILL.md#L175-L176): XS < 2hr, S = 2-4hr. M/L/XL are not explicitly time-defined but trigger the SPLIT phase.

### Existing Estimation Touchpoints

1. **`ralph_hero__update_estimate`** ([issue-tools.ts:1298-1349](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1298-L1349)): Sets estimate on project item via `updateProjectItemField`. Uses `resolveProjectItemId` + `ensureFieldCache` + `updateProjectItemField` pattern.

2. **`ralph_hero__pick_actionable_issue`** ([issue-tools.ts:1677-1906](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1677-L1906)): Filters by `maxEstimate` using ordinal index comparison (`validEstimates.indexOf(est)` vs `validEstimates.indexOf(maxEstimate)`). This ordinal comparison pattern is reusable for the estimation engine.

3. **Pipeline detection** ([pipeline-detection.ts:70](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L70)): `OVERSIZED_ESTIMATES = new Set(["M", "L", "XL"])` triggers SPLIT phase. The estimation engine should be aware of this threshold.

4. **Triage skill** ([ralph-triage/SKILL.md:206-214](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-triage/SKILL.md#L206-L214)): Manual RE-ESTIMATE action calls `update_estimate`. The new tool would provide a suggestion before this step.

### Available Issue Data for Heuristics

The `get_issue` tool ([issue-tools.ts:585-879](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L585-L879)) returns rich data that can serve as heuristic signals:

| Signal Source | Available Fields | Heuristic Potential |
|---------------|-----------------|-------------------|
| Title | `title` (string) | Keyword extraction, word count |
| Body | `body` (string) | Length, checkbox count, code block count, file references |
| Labels | `labels.nodes[].name` | Category mapping (bug→S, enhancement→M) |
| Sub-issues | `subIssues.totalCount`, `subIssuesSummary` | More sub-issues → larger scope |
| Dependencies | `blocking.totalCount`, `blockedBy.totalCount` | High connectivity → higher complexity |
| Comments | `comments.nodes[]` | Discussion volume suggests ambiguity/complexity |
| Assignees | `assignees.nodes[]` | Multiple assignees → larger scope |

### Technology Constraints

The MCP server dependencies ([package.json](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/package.json)) are minimal:
- `@modelcontextprotocol/sdk`, `@octokit/graphql`, `zod`
- **No NLP/ML libraries** — the engine must use pure heuristic/keyword-based approaches
- Adding heavy NLP dependencies would be inappropriate for a lightweight MCP server

## Key Discoveries

### 1. GraphQL Data Already Available

The `get_issue` GraphQL query already fetches all data needed for heuristics. No new API calls are required — the suggest_estimate tool can reuse the same query pattern or accept pre-fetched issue data as input. The key optimization question is whether to:
- (a) Accept an issue number and fetch data internally (simpler API, extra API call)
- (b) Accept pre-fetched issue data (no extra API call, but more complex input schema)

Option (a) is more consistent with existing tool patterns where tools resolve their own data.

### 2. Keyword-Based Complexity Signals

Analysis of existing issues and common software patterns suggests these keyword categories:

**High complexity indicators** (push toward M+):
- "refactor", "migrate", "redesign", "architecture", "breaking change", "rewrite"
- "security", "authentication", "authorization", "encryption"
- "database", "schema", "migration"
- Multiple component references (e.g., "frontend AND backend")

**Low complexity indicators** (push toward XS/S):
- "typo", "fix text", "update copy", "rename", "documentation"
- "bump version", "update dependency", "lint", "format"
- Single-file references

### 3. Body Structure as Size Proxy

Issue body structure correlates with scope:
- **Checkbox count** (`- [ ]` patterns): Each acceptance criterion represents a unit of work. 1-2 → XS/S, 3-5 → S/M, 6+ → M+
- **Body length**: Short descriptions (< 200 chars) suggest simple tasks; long descriptions (> 1000 chars) suggest complex scope
- **Code block count**: Multiple code examples suggest multi-component changes
- **Section headers** (`##`): Multiple sections suggest multi-faceted work
- **File path references**: Count of distinct paths mentioned suggests blast radius

### 4. Label-to-Size Mapping

Labels provide categorical signals with baseline size expectations:

| Label | Baseline Size | Rationale |
|-------|--------------|-----------|
| `bug` | S | Most bugs are focused fixes |
| `enhancement` | M | New features typically involve more code |
| `documentation` | XS | Usually text-only changes |
| `breaking-change` | L | Requires migration paths, broad impact |
| `performance` | M | Often involves profiling + targeted changes |
| `security` | M | Requires careful implementation + review |

### 5. Historical Calibration Not Yet Feasible

The issue spec mentions historical calibration (comparing estimates vs actuals). This requires:
- Tracking actual implementation metrics (commit count, files changed, time to merge)
- A data store for historical estimates and outcomes
- Sufficient data volume for statistical significance

**This is a separate concern** that should be deferred. The initial engine should use static heuristics only. Historical calibration could be added later as a weight-adjustment layer.

### 6. Confidence Scoring Model

A simple additive confidence model works well for transparent heuristics:
- Start with base confidence (0.5 = "uncertain")
- Each signal either reinforces (increases confidence) or conflicts (decreases confidence)
- If most signals agree, confidence is high (0.7-0.9)
- If signals conflict, confidence is low (0.3-0.5)
- Return confidence alongside the suggestion so callers can decide whether to auto-apply or flag for human review

### 7. Tool Registration Location

Two viable options:
- **New file `estimation-tools.ts`**: Clean separation, follows the modular pattern. Would need registration in [index.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts) as a new phase.
- **Add to `issue-tools.ts`**: Keeps estimation near related tools (`update_estimate`, `pick_actionable_issue`). But issue-tools.ts is already ~1900 lines.

A new `estimation-tools.ts` is preferable to keep modules focused.

## Potential Approaches

### Approach A: Single Heuristic Tool with Static Rules

Build `ralph_hero__suggest_estimate` as a single tool with hardcoded keyword lists and scoring weights.

**Pros:**
- Simple implementation (~200-300 lines)
- No external dependencies
- Easy to understand and debug
- Transparent signal reporting

**Cons:**
- Rigid — changing rules requires code changes
- No learning/adaptation
- Keyword lists may not generalize well

### Approach B: Configurable Rules Engine

Build the tool with configurable rules stored as structured data (JSON config or project-level metadata).

**Pros:**
- Rules can be tuned without code changes
- Different projects could use different rules
- More flexible long-term

**Cons:**
- More complex implementation (~400-500 lines)
- Configuration management adds overhead
- Overkill for current single-project usage

### Approach C: Two-Phase Tool (Suggest + Calibrate) (Recommended)

Build `ralph_hero__suggest_estimate` with static heuristics now, and design the interface to support a future `ralph_hero__calibrate_estimates` tool for historical adjustment.

**Proposed tool:**

```typescript
ralph_hero__suggest_estimate
Input:
  owner?: string
  repo?: string
  number: number  // Issue number
Output:
  number: number
  suggestedEstimate: "XS" | "S" | "M" | "L" | "XL"
  confidence: number  // 0.0-1.0
  signals: Array<{
    factor: string       // e.g., "body_checkbox_count"
    value: string|number // e.g., 6
    impact: string       // e.g., "+1 size"
    weight: number       // contribution to final score
  }>
  currentEstimate?: string | null  // existing estimate if set
  oversized: boolean  // true if M/L/XL (would trigger SPLIT)
```

**Heuristic pipeline:**
1. Fetch issue data via existing GraphQL pattern
2. Extract signals (keywords, body metrics, labels, relationships)
3. Compute weighted score (sum of signal weights → maps to size)
4. Calculate confidence (signal agreement ratio)
5. Return structured result

**Pros:**
- Clean, extensible design
- Static heuristics are sufficient for MVP
- Interface supports future calibration without breaking changes
- Signal transparency satisfies acceptance criteria

**Cons:**
- Still uses hardcoded rules initially
- Calibration tool is deferred work

## Risks and Considerations

1. **Accuracy expectations**: Heuristic estimation will not be highly accurate, especially for domain-specific issues. The confidence score must honestly reflect uncertainty. Setting expectations that this is a "suggestion" not a "decision" is critical.

2. **Over-estimation bias**: Conservative heuristics (biasing toward larger estimates) are safer than under-estimation in a pipeline where M+ triggers SPLIT. An issue estimated M that should be S wastes time splitting; an issue estimated S that should be M may fail during implementation.

3. **Keyword list maintenance**: Hardcoded keyword lists will grow stale. Consider using the `enhance` keyword — issues about new features not yet in the codebase won't match file-reference heuristics.

4. **Integration with triage**: The tool should be advisory only. The triage skill should call `suggest_estimate`, show the result to the agent, and let the agent decide whether to accept, modify, or override. This avoids automating away human judgment for edge cases.

5. **Issue scope**: This is estimated M by the author. The core tool implementation is straightforward (~300 lines), but thorough signal extraction and weight tuning add scope. Consider splitting into:
   - XS: Core tool skeleton with body-length + checkbox heuristics
   - S: Keyword extraction + label mapping + relationship signals
   - XS: Triage skill integration + documentation

6. **Testing**: Heuristic logic should be unit-testable with mock issue data. The vitest test pattern in [__tests__/](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/) should be followed. Consider creating test fixtures from real issues with known-good estimates.

## Recommended Next Steps

1. **Follow Approach C** — single `suggest_estimate` tool with static heuristics and extensible interface

2. **Create `estimation-tools.ts`** as a new tool module registered in `index.ts`

3. **Implement signal extractors** in priority order:
   - Body metrics (length, checkboxes, code blocks, sections)
   - Keyword analysis (complexity indicators)
   - Label mapping
   - Relationship signals (sub-issues, dependencies)

4. **Add weighted scoring** with ordinal mapping: score ranges → estimate sizes

5. **Integrate with triage skill** — add a step before RE-ESTIMATE that calls `suggest_estimate` and presents the result

6. **Defer historical calibration** to a future issue — the current engine should work with static weights

7. **Consider splitting this M into 2-3 sub-issues** per the scope risk noted above
