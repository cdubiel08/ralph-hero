---
date: 2026-05-12
status: complete
type: plan
github_issue: 1130
github_issues: [1130]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1130
primary_issue: 1130
tags: [mcp-server, zod, type-coercion, bug-fix]
---

# GH-1130: MCP Boolean Param Coercion - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-01-GH-0478-empty-params-fix]]
- builds_on:: [[2026-03-01-GH-0478-empty-params-optional-schema]]

GH-478 landed the existing `validateToolInput` patch in `src/index.ts` that normalizes `undefined → {}` for mcptools 0.7.1 compatibility. That work established the precedent for the harness-quirk patch site referenced in Approach below. GH-1130 is the same class of bug (harness wire-format quirk on tool input) but solved at the Zod schema layer rather than the `validateToolInput` layer — see "What We're NOT Doing" for the rationale.

## Overview

Single XS atomic fix for GH-1130:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1130 | MCP tool calls: boolean params rejected as strings before tool schema is loaded via ToolSearch | XS |

The triage comment on the issue confirms root cause and recommends Option 1 (Zod-level `z.coerce.boolean()`), consistent with the existing `z.coerce.number()` pattern used widely across all tool files. Implementation is a uniform mechanical change across 14 boolean param declarations plus a regression test.

## Shared Constraints

- **Language**: TypeScript strict mode (no linter; `tsc` is the quality gate per `CLAUDE.md`).
- **Pattern parity**: The fix mirrors the existing `z.coerce.number()` convention used for `projectNumber`, `number`, `depth`, `blockedNumber`, etc. (see `tools/project-management-tools.ts:49` and 60+ other occurrences). Boolean params have simply never received the same defensive treatment.
- **No runtime behavior change for well-typed callers**: `z.coerce.boolean()` accepts native `true`/`false` unchanged. It only adds tolerance for the string `"true"`/`"false"` shape the harness emits on first call before `ToolSearch` hydrates the schema.
- **Zod 3.25 `z.coerce.boolean()` semantics caveat**: `z.coerce.boolean()` uses JavaScript `Boolean()` semantics — `Boolean("false")` is `true` (any non-empty string is truthy). This is a known Zod quirk. The acceptable mitigation is a `z.preprocess` shim that maps `"true"`/`"false"` → boolean explicitly, since the harness only ever sends those two string values. The plan uses a small shared helper (`zBoolish`) to keep the call sites tidy and reliable.
- **Scope**: ralph-hero MCP server only. ralph-knowledge has a parallel `z.boolean()` set (8 occurrences in `plugin/ralph-knowledge/src/index.ts` + `graph-tools.ts`) but is out of scope for this issue — left as a follow-up.
- **CI/release impact**: Any merged change touching `mcp-server/` triggers `release.yml` auto-version bump + npm publish. The change is patch-level (no `#minor`/`#major` in commit).

## Current State Analysis

The MCP server registers tools via `server.tool(name, description, zodSchemaObject, handler)`. When a tool's schema has not been pre-loaded via `ToolSearch`, the harness invokes the tool with argument values still in their wire shape (strings). Zod's `z.boolean()` rejects string `"true"`/`"false"` with `"Expected boolean, received string"`, producing MCP error `-32602` and forcing the agent to round-trip through `ToolSearch` before retrying.

The existing precedent for input coercion lives in two places:

1. **`tools/*.ts`** — `z.coerce.number()` is already the universal pattern for numeric params (e.g., `projectNumber: z.coerce.number().optional()` at `tools/project-management-tools.ts:49`).
2. **`src/index.ts:472-474`** — a `validateToolInput` patch normalizes mcptools 0.7.1's `undefined` → `{}` quirk. This patch site is type-agnostic and would be the wrong place to add boolean-specific coercion (it would couple a generic patch to schema-specific concerns).

The 14 `z.boolean()` declarations across tool files:

| File | Line | Param |
|------|------|-------|
| `tools/issue-tools.ts` | 524 | `includeGroup` (in `get_issue`) |
| `tools/issue-tools.ts` | 531 | `includePipeline` (in `get_issue`) |
| `tools/issue-tools.ts` | 1215 | `force` (in `save_issue`) |
| `tools/activity-tools.ts` | 23 | `compact` (in `recent_activity`) |
| `tools/project-management-tools.ts` | 577 | `unarchive` (in `archive_items`) |
| `tools/project-management-tools.ts` | 591 | (inline `.boolean()` — second flag in same tool) |
| `tools/debug-tools.ts` | 267 | `dryRun` (debug tool) |
| `tools/decompose-tools.ts` | 197 | feature decomposition flag |
| `tools/relationship-tools.ts` | 175 | flag in `add_sub_issue` / sibling |
| `tools/relationship-tools.ts` | 1085 | flag in `advance_issue` / sibling |
| `tools/plan-graph-tools.ts` | 91 | `dryRun` (in `sync_plan_graph`) |
| `tools/batch-tools.ts` | 262 | flag in `batch_update` |
| `tools/dashboard-tools.ts` | 71 | flag in `pipeline_dashboard` |
| `tools/dashboard-tools.ts` | 101 | flag in `pipeline_dashboard` |
| `tools/project-tools.ts` | 186 | flag in `setup_project` |

The total is 15 occurrences (the triage comment said 5, but the actual count is 15 — the triage was illustrative, not exhaustive). All are tool input params (none are GraphQL response shape).

## Desired End State

A fresh agent session can invoke any ralph-hero MCP tool with boolean params on the **first call**, without a preceding `ToolSearch` schema-load round trip.

### Verification

- [ ] Calling any tool with `param: "true"` (string) succeeds and the handler receives `true` (boolean).
- [ ] Calling any tool with `param: "false"` (string) succeeds and the handler receives `false` (boolean).
- [ ] Calling any tool with `param: true` (native boolean) still succeeds unchanged.
- [ ] Calling any tool with `param: false` (native boolean) still succeeds unchanged.
- [ ] `npm run build` produces no TypeScript errors.
- [ ] `npm test` passes the full vitest suite including a new regression test for boolean coercion.

## What We're NOT Doing

- **Not** fixing ralph-knowledge's `z.boolean()` declarations (`plugin/ralph-knowledge/src/index.ts`, `graph-tools.ts`). Out of scope; track separately.
- **Not** patching `validateToolInput` in `src/index.ts`. Option 2 from the issue body is rejected: it would couple a type-agnostic patch site to schema-specific concerns, whereas Option 1 matches the existing `z.coerce.number()` convention.
- **Not** filing an upstream harness issue (Option 3). Defensive Zod coercion fully unblocks the user impact regardless of upstream behavior; upstream filing is a separate, lower-priority concern.
- **Not** introducing nullable/optional behavior changes — coercion only affects string → boolean parsing, never `undefined` handling.
- **Not** touching tests that already pass native-boolean values — those paths remain valid.

## Implementation Approach

Add a small shared helper (`zBoolish`) in a new `src/lib/zod-helpers.ts` that produces a Zod schema accepting `boolean | "true" | "false"` and coerces strings to booleans. Replace all 15 `z.boolean()` call sites with `zBoolish()`. Add a focused regression test that exercises the harness wire-shape (string `"true"`/`"false"`) against a representative subset of tools and confirms the handler receives proper booleans.

A `z.preprocess` shim is preferred over raw `z.coerce.boolean()` because the latter has the `Boolean("false") === true` JavaScript pitfall. Preprocessing keeps the semantics strict (`"true"` → true, `"false"` → false, native booleans pass through, anything else delegates to the inner `z.boolean()` which produces the same error message callers expect today).

**Phase dependency annotations** — Single phase, no internal dependencies.

---

## Phase 1: Add `zBoolish` helper and apply across all boolean tool params
- **depends_on**: null

### Overview

Introduce a shared Zod helper and migrate all 15 `z.boolean()` occurrences in `mcp-server/src/tools/*.ts` to use it. Add a regression test verifying the harness wire-shape (string booleans) round-trips correctly.

### Tasks

#### Task 1.1: Create `zBoolish` helper module
- **files**: `plugin/ralph-hero/mcp-server/src/lib/zod-helpers.ts` (create)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] Exports a `zBoolish()` function returning a Zod schema (`ZodEffects<ZodBoolean>` or compatible) that accepts `boolean | "true" | "false"`.
  - [x] `zBoolish().parse(true)` → `true`.
  - [x] `zBoolish().parse(false)` → `false`.
  - [x] `zBoolish().parse("true")` → `true`.
  - [x] `zBoolish().parse("false")` → `false`.
  - [x] `zBoolish().parse("yes")` throws (does NOT silently coerce — only the two literal harness shapes are accepted).
  - [x] `zBoolish().parse(1)` throws.
  - [x] The schema chains cleanly with `.optional()`, `.default(false)`, and `.describe(...)` (verified by TypeScript compilation).
  - [x] JSDoc comment explains the harness/ToolSearch interaction and references GH-1130.

#### Task 1.2: Add regression test for `zBoolish` and harness wire-shape
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/boolean-coercion.test.ts` (create), `plugin/ralph-hero/mcp-server/src/lib/zod-helpers.ts` (read)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [x] Test file follows the pattern of `__tests__/empty-params.test.ts` (uses `createPatchedServer()`-equivalent helper to register a tool with `zBoolish()` params).
  - [x] At least one test registers a tool with `{ flag: zBoolish().optional().default(false) }` and asserts `parse({ flag: "true" })` resolves to `flag === true`.
  - [x] At least one test asserts `parse({ flag: "false" })` resolves to `flag === false`.
  - [x] At least one test asserts `parse({ flag: true })` still works unchanged.
  - [x] At least one test asserts `parse({ flag: "garbage" })` throws a Zod validation error.
  - [x] Tests pass with `npx vitest run src/__tests__/boolean-coercion.test.ts`.

#### Task 1.3: Migrate `tools/issue-tools.ts`
- **files**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [x] Import `zBoolish` from `../lib/zod-helpers.js` (note `.js` extension — ESM `NodeNext`).
  - [x] Line 524 `z.boolean()` for `includeGroup` → `zBoolish()`.
  - [x] Line 531 `z.boolean()` for `includePipeline` → `zBoolish()`.
  - [x] Line 1215 `z.boolean()` for `force` → `zBoolish()`.
  - [x] All chained methods (`.optional()`, `.default(...)`, `.describe(...)`) preserved verbatim.
  - [x] `grep -n "z\.boolean()" tools/issue-tools.ts` returns zero results.

#### Task 1.4: Migrate remaining tool files
- **files**: `plugin/ralph-hero/mcp-server/src/tools/activity-tools.ts` (modify), `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts` (modify), `plugin/ralph-hero/mcp-server/src/tools/debug-tools.ts` (modify), `plugin/ralph-hero/mcp-server/src/tools/decompose-tools.ts` (modify), `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts` (modify), `plugin/ralph-hero/mcp-server/src/tools/plan-graph-tools.ts` (modify), `plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts` (modify), `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` (modify), `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [x] Each file imports `zBoolish` from `../lib/zod-helpers.js`.
  - [x] Every occurrence of `z.boolean()` and `.boolean()` (as a Zod method) in tool input schemas is replaced with `zBoolish()`. The replacement preserves the surrounding chain (`.optional()`, `.default(...)`, `.describe(...)`) verbatim.
  - [x] After the migration, `grep -rn "\.boolean()" plugin/ralph-hero/mcp-server/src/tools/` returns zero results.
  - [x] `npm run build` from `plugin/ralph-hero/mcp-server/` succeeds with no TypeScript errors.

#### Task 1.5: Verify full test suite still passes
- **files**: (none — verification only)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2, 1.3, 1.4]
- **acceptance**:
  - [x] `npm test` from `plugin/ralph-hero/mcp-server/` passes all existing tests plus the new `boolean-coercion.test.ts`.
  - [x] No vitest snapshots updated (the change is type-coercion only; no test fixtures should drift).

### Phase Success Criteria

#### Automated Verification:
- [x] `cd plugin/ralph-hero/mcp-server && npm run build` — no TypeScript errors.
- [x] `cd plugin/ralph-hero/mcp-server && npm test` — full vitest suite passes including the new regression test (1293 tests pass).
- [x] `grep -rn "z\.boolean\|\.boolean()" plugin/ralph-hero/mcp-server/src/tools/` — zero results (full migration confirmed).
- [x] `grep -rn "zBoolish" plugin/ralph-hero/mcp-server/src/tools/` — 25 matches: 15 call-site replacements + 10 import-line occurrences.
- [x] `grep -rn "z\.coerce\.boolean" plugin/ralph-hero/mcp-server/src/` — zero functional matches (the sole textual match is the JSDoc comment in `lib/zod-helpers.ts` explaining why we deliberately did NOT use `z.coerce.boolean()`; it is not a call site).

#### Manual Verification:
- [ ] From a fresh agent session (one that has not run `ToolSearch` on any ralph-hero MCP tool), invoke `mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue({ number: 1, includePipeline: true })`. The call succeeds without an `Input validation error`.
- [ ] After the manual smoke test, re-run `mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue({ number: 1, includePipeline: true })` — still succeeds (no regression).

**Creates for next phase**: N/A (only phase).

---

## Integration Testing

- [ ] (manual) Trigger an autopilot session and confirm no `Input validation error` appears in the first invocation of any ralph-hero MCP tool with boolean params.
- [ ] (manual) Confirm `release.yml` publishes a new patch version on merge and `.mcp.json`-consuming projects pick it up via `npx ralph-hero-mcp-server`.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1130
- Triage comment with full root-cause analysis: https://github.com/cdubiel08/ralph-hero/issues/1130#issuecomment-* (referenced inline above)
- Existing pattern (numeric coercion): `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts:49` (`z.coerce.number()`)
- Existing precedent for harness-quirk patching: `plugin/ralph-hero/mcp-server/src/index.ts:472-474` (`validateToolInput` empty-params patch) and `__tests__/empty-params.test.ts`
- Zod `z.coerce.boolean()` JavaScript-semantics caveat: https://zod.dev/?id=coercion-for-primitives (documents `Boolean("false") === true`)
