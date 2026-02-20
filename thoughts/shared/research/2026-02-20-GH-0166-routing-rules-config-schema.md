---
date: 2026-02-20
github_issue: 166
github_url: https://github.com/cdubiel08/ralph-hero/issues/166
status: complete
type: research
---

# GH-166: Define Routing Rules Config Schema and TypeScript Types

## Problem Statement

The routing rules engine (#125) needs a config schema and TypeScript types to define match criteria (repo glob, label matching, issue type, negation) and actions (assign to project, set workflow state). No routing infrastructure exists in the MCP server — this is the foundation that all sibling issues (#167 matching engine, #168 config loader, #178 CRUD tool) depend on.

## Current State Analysis

### No Existing Routing Code

Zero routing-related files, types, or references exist in the MCP server source. No `routing-types.ts`, no `.ralph-routing.yml`, no YAML library in `package.json`. This is entirely greenfield.

### Type Organization Pattern

Types are organized in two ways:
- **Shared types** in [`types.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts) — GraphQL response types, entity interfaces, config types
- **Module-local types** — declared inline in tool files and lib files, not exported (e.g., `RawProjectItem` in `issue-tools.ts:1587` and `project-tools.ts:556`)

The issue specifies a dedicated `routing-types.ts` module — this follows the pattern of domain-specific lib modules like `lib/workflow-states.ts` and `lib/cache.ts`.

### Zod Schema Pattern

Zod is used exclusively as inline schema arguments to `server.tool()` calls. No Zod schemas are extracted into named constants or exported. Key patterns:

- `z.enum([...])` for closed value sets ([`issue-tools.ts:78-81`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L78))
- `z.array(z.object({...}))` for structured arrays ([`view-tools.ts:103-119`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/view-tools.ts#L103))
- `.optional()` with runtime resolution via `resolveConfig()` / `resolveFullConfig()`

GH-166 would be the first to export Zod schemas from a dedicated module — a new pattern for this codebase, but justified since the schema is consumed by multiple downstream tools (#168 config loader, #178 CRUD tool).

### Downstream Consumer Context

The GH-178 research doc already defined temporary inline types:
```typescript
interface RoutingRule {
  match: { labels?: string[]; repo?: string };
  action: { workflowState?: string; projectNumber?: number };
}
interface RoutingConfig { rules: RoutingRule[] }
```

These are explicitly marked as "temporary until #166" — GH-166's output replaces them. The CRUD tool schema in GH-178 also references match/action shapes that must align with GH-166's types.

### Related Research

- **GH-178 research** ([`2026-02-20-GH-0178-configure-routing-crud-tool.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0178-configure-routing-crud-tool.md)) — defines dependency chain: #166 → #167 → #168 → #178 → #179
- **No prior research** exists for #125, #126, #127, #128, or #129 — those parent/sibling issues were split but not researched

## Key Discoveries

### 1. Industry Patterns for Routing Config Schemas

Research across production GitHub routing tools reveals four dominant patterns:

| Pattern | Example | Best For |
|---------|---------|----------|
| Label-as-key flat map | `actions/labeler` | Simple label assignment from file/branch conditions |
| Label array with condition objects | `srvaroa/labeler` | Rich multi-condition labeling with AND/OR/negate |
| Nested routes tree | Prometheus alertmanager | Multi-level receiver fan-out with inheritance |
| Trigger/criteria/action triad | StackStorm rules | Event-driven rule with explicit separation |

For Ralph's use case (route issues to projects based on labels/repo/type), the **rule array with condition + action objects** pattern is most appropriate — it supports the required match criteria, is flat (no nesting needed), and maps cleanly to YAML.

### 2. Recommended Schema Design

Based on the issue's acceptance criteria and industry patterns:

```typescript
// lib/routing-types.ts

import { z } from "zod";

// === Match Criteria ===

export const MatchCriteriaSchema = z.object({
  repo: z.string().optional()
    .describe("Repository glob pattern (e.g., 'my-org/*', 'owner/repo')"),
  labels: z.object({
    any: z.array(z.string()).optional()
      .describe("Match if issue has ANY of these labels"),
    all: z.array(z.string()).optional()
      .describe("Match if issue has ALL of these labels"),
  }).optional()
    .describe("Label matching criteria"),
  issueType: z.enum(["issue", "pull_request", "draft_issue"]).optional()
    .describe("Match by issue type"),
  negate: z.boolean().optional().default(false)
    .describe("Invert match result — true means 'NOT matching'"),
}).refine(
  (d) => d.repo || d.labels || d.issueType,
  { message: "At least one match criterion must be specified" }
);

// === Actions ===

export const RoutingActionSchema = z.object({
  projectNumber: z.number().optional()
    .describe("Add issue to this project"),
  projectNumbers: z.array(z.number()).optional()
    .describe("Add issue to multiple projects"),
  workflowState: z.string().optional()
    .describe("Set workflow state after routing"),
  labels: z.array(z.string()).optional()
    .describe("Add these labels to the issue"),
}).refine(
  (d) => d.projectNumber || d.projectNumbers || d.workflowState || d.labels,
  { message: "At least one action must be specified" }
);

// === Rule ===

export const RoutingRuleSchema = z.object({
  name: z.string().optional()
    .describe("Human-readable rule name for debugging"),
  match: MatchCriteriaSchema,
  action: RoutingActionSchema,
  enabled: z.boolean().optional().default(true)
    .describe("Toggle rule on/off without removing it"),
});

// === Config ===

export const RoutingConfigSchema = z.object({
  version: z.literal(1)
    .describe("Schema version for forward compatibility"),
  stopOnFirstMatch: z.boolean().optional().default(true)
    .describe("Stop evaluating rules after first match (default: true)"),
  rules: z.array(RoutingRuleSchema)
    .describe("Ordered list of routing rules — evaluated top to bottom"),
});

// === Inferred TypeScript Types ===

export type MatchCriteria = z.infer<typeof MatchCriteriaSchema>;
export type RoutingAction = z.infer<typeof RoutingActionSchema>;
export type RoutingRule = z.infer<typeof RoutingRuleSchema>;
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;
```

### 3. Design Decisions

**Why `z.infer<>` instead of separate interfaces?**
Zod's `z.infer<>` derives TypeScript types directly from schemas, ensuring the runtime validation and compile-time types can never drift. This is a clean pattern that avoids maintaining two parallel definitions.

**Why `version: z.literal(1)`?**
Forward compatibility. If the schema changes in the future, the version number allows the config loader to handle migrations. `z.literal(1)` enforces exact match — loading a v2 config with a v1 loader fails fast.

**Why `stopOnFirstMatch: true` as default?**
Most routing use cases want deterministic, single-destination routing. Users who want fan-out (route to multiple projects) can set `stopOnFirstMatch: false`. This matches Prometheus alertmanager's `continue: false` default.

**Why `labels.any` / `labels.all` instead of just `labels[]`?**
The issue specifies "label matching (any/all)" as a requirement. A flat array is ambiguous — does `["bug", "critical"]` mean "has both" or "has either"? Explicit `any`/`all` eliminates ambiguity, following the `actions/labeler` pattern.

**Why `negate` on the match criteria, not per-field?**
Per-field negation (e.g., `labels.not`) is more granular but creates combinatorial complexity. A single `negate: true` on the match block inverts the entire match result — simpler and sufficient for the "exclude certain repos" or "exclude certain labels" use cases.

**Why `projectNumber` AND `projectNumbers`?**
Single project is the common case (deserves a simple field), but multi-project routing is a stated requirement. Having both avoids forcing users to wrap a single number in an array. The matching engine can normalize: `[action.projectNumber, ...(action.projectNumbers ?? [])]`.

### 4. Example YAML Config

```yaml
# .ralph-routing.yml
version: 1
stopOnFirstMatch: true

rules:
  - name: "Route MCP server issues"
    match:
      repo: "cdubiel08/ralph-hero"
      labels:
        any: ["enhancement", "bug"]
    action:
      projectNumber: 3
      workflowState: "Backlog"

  - name: "Route critical issues to multiple projects"
    match:
      labels:
        all: ["critical", "production"]
    action:
      projectNumbers: [3, 5]
      workflowState: "Backlog"
      labels: ["triaged"]

  - name: "Exclude docs-only issues"
    match:
      labels:
        any: ["documentation"]
      negate: true
    action:
      projectNumber: 3
```

### 5. File Placement

**New file**: `plugin/ralph-hero/mcp-server/src/lib/routing-types.ts`

This follows the lib module pattern (`lib/workflow-states.ts`, `lib/cache.ts`). Export both Zod schemas and inferred types so downstream consumers can choose:
- **#167 matching engine**: imports `MatchCriteria`, `RoutingRule` types for the pure-function engine
- **#168 config loader**: imports `RoutingConfigSchema` for validation after YAML parse
- **#178 CRUD tool**: imports both schemas (for inline validation) and types (for handler logic)

### 6. No `z.discriminatedUnion` Needed

The web research suggested `z.discriminatedUnion("type", [...])` for condition types. This is overkill for GH-166's scope — the match criteria fields are all optional on a single object, not discriminated variants. The flat `z.object` with optional fields is simpler and matches the YAML config format naturally.

### 7. Dependency Chain Clarification

The GH-178 research established: #166 → #167 → #168 → #178 → #179. However, #167 (matching engine) doesn't actually depend on #166 — it can be implemented in parallel using the same types. The matching engine needs the `MatchCriteria` and `RoutingRule` types, which exist once #166 is done, but the matching logic can be designed and tested against inline types and swapped later.

**Recommended parallel tracks**:
- Track 1: #166 (types) → #168 (config loader)
- Track 2: #167 (matching engine) — parallel with #166, both produce types
- Merge: #178 (CRUD tool) — needs #166 + #168

## Potential Approaches

### Approach A: Zod Schemas with `z.infer<>` Types (Recommended)

Export Zod schemas as named constants and derive TypeScript types via `z.infer<>`. Single source of truth for both runtime validation and compile-time types.

**Pros:** No type drift, schemas reusable by config loader and CRUD tool, idiomatic Zod pattern.
**Cons:** New pattern in this codebase (first exported Zod schemas). Minor learning curve for maintainers.

### Approach B: Separate TypeScript Interfaces + Zod Schemas

Define TypeScript interfaces manually, then create matching Zod schemas separately.

**Pros:** Types are readable without understanding Zod.
**Cons:** Two definitions to maintain, drift risk, more code.

### Approach C: TypeScript Interfaces Only, No Zod

Define interfaces and use manual validation in the config loader.

**Pros:** Simpler, no new Zod patterns.
**Cons:** No runtime validation schema, manual validation is error-prone, CRUD tool (#178) needs validation anyway.

### Recommendation: Approach A

Zod is already a dependency. Exporting schemas is the natural evolution. The `z.infer<>` pattern eliminates duplication and ensures the YAML config is validated against the exact same schema used for type checking.

## Risks

1. **Schema evolution**: If the match criteria or actions change significantly, the `version: 1` guard ensures old configs fail fast. But schema migration logic doesn't exist yet — that's a future concern.
2. **Zod `.refine()` and YAML round-trip**: Zod refinements validate at parse time but don't affect serialization. The config loader must call `.parse()` after `yaml.parse()` to trigger refinements.
3. **`negate` semantics ambiguity**: Does `negate: true` with `labels.any: ["bug"]` mean "NOT any bug" (= no bug label) or "NOT (any bug)" (= same thing)? Semantics are clear when there's one condition, but with multiple conditions (repo + labels), `negate` inverts the combined result, not individual conditions. This should be documented.
4. **`projectNumber` vs `projectNumbers` redundancy**: Could confuse users. The matching engine should normalize both into a single array. Document that `projectNumber` is shorthand for `projectNumbers: [n]`.

## Recommended Next Steps

1. Create `lib/routing-types.ts` with 4 exported Zod schemas and 4 inferred types
2. Include 3+ YAML config examples as JSDoc comments
3. Export `RoutingConfigSchema.parse()` as a convenience `validateRoutingConfig()` function
4. Add unit tests: valid config parses, invalid configs rejected (missing match criteria, empty actions, wrong version)
5. Update dependency: #167 can proceed in parallel with #166, not blocked by it
