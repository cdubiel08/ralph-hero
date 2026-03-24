# Plan-Time Dependency Graph for Parallelization

**Date**: 2026-03-24
**Status**: Draft
**Scope**: ralph-hero plugin — plan format, MCP server, orchestration skills, hooks

## Problem Statement

Ralph-hero is ineffective at understanding when it can parallelize implementation work. Today, parallelization decisions are made too late (runtime stream detection via Union-Find over file paths) and too crudely (binary: parallel streams or sequential). The planning step — where the fullest understanding of work structure exists — produces no explicit dependency information that the execution layer can consume.

Superpowers (obra/superpowers) was investigated as a reference. Key findings:
- Superpowers has **no structured dependency notation** in plans. Task ordering is purely positional.
- Superpowers **explicitly bans parallel implementation** ("Never dispatch multiple implementation subagents in parallel").
- Superpowers removed chunk/phase groupings after 10 days (v5.0.4), citing reviewer blindness to cross-chunk dependencies and writer overhead managing artificial boundaries.
- These decisions are appropriate for superpowers' single-agent, single-issue scope but don't apply to ralph-hero's multi-issue, multi-agent, worktree-isolated architecture.

Ralph-hero already has the infrastructure for safe parallelism (worktree isolation, stream scoping, multi-agent dispatch). What's missing is the planning layer telling the execution layer what's safe to parallelize.

## Design Principle

The plan document's dependency graph is the **recommended execution order**, not a hard gate. The executing agent reads it as guidance, defaults to respecting it, but can override when it has better information at runtime. No new hard-gate hooks are introduced for dependency enforcement — the graph informs dispatch, it doesn't block it.

The one hard gate: `plan-postcondition.sh` verifies that the dependency graph has been synced to GitHub before the planning skill can complete.

## Plan Document Format Extensions

### Phase-Level Dependencies

Today, phases have no `depends_on`. Phases are implicitly sequential (Phase 1 before Phase 2). The extension adds explicit dependency annotations at the phase level:

```markdown
## Phase 1: Core data model (GH-660)
- **depends_on**: null

## Phase 2: API integration (GH-661)
- **depends_on**: [phase-1]
- **parallel_with**: [phase-3]

## Phase 3: CLI commands (GH-662)
- **depends_on**: [phase-1]
- **parallel_with**: [phase-2]
```

- `depends_on` references other phases by number (`phase-N`) or by issue number (`GH-NNN`) for cross-plan references.
- `depends_on: null` is the explicit "no dependencies" marker — this phase can start immediately.
- `parallel_with` is optional and advisory — makes parallelism visible in the plan rather than just inferred from absence of deps. It is never authoritative; the absence of a `depends_on` edge is what enables parallelism.

### Cross-Phase Task Dependencies

Today, task-level `depends_on` is scoped within a phase (e.g., Task 1.2 depends on Task 1.1). The extension allows cross-phase references:

```markdown
#### Task 2.1: Add endpoint handler
- **files**: `src/api/handler.ts` (create)
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] Handler uses the model from Task 1.3
```

Task 2.1 in Phase 2 depends on Task 1.3 in Phase 1. This allows partial overlap between phases — Phase 2 can start tasks that don't depend on Phase 1 outputs while Phase 1 is still completing.

### Plan-of-Plans Feature Dependencies

Today, the `## Feature Sequencing` section uses prose waves with `blocked_by:` lists. The extension replaces prose waves with structured `depends_on`:

```markdown
## Feature Decomposition

### Feature A: Auth middleware (GH-44)
- **depends_on**: null
- **produces**: AuthMiddleware interface, session token format

### Feature B: Protected routes (GH-45)
- **depends_on**: [feature-a]
- **consumes**: AuthMiddleware interface
- **produces**: Route guard pattern

### Feature C: Audit logging (GH-46)
- **depends_on**: null
- **parallel_with**: [feature-a, feature-b]
```

- `produces`/`consumes` annotations describe interface contracts between features. These are informational — they help child plans inherit context from completed siblings.
- The `## Feature Sequencing` section is replaced by the dependency graph implicit in these annotations. No separate wave section needed.

### Backward Compatibility

- Plans without phase-level `depends_on` are treated as strictly sequential (current behavior).
- Plans with partial annotations (some phases have `depends_on`, others don't) treat un-annotated phases as sequential relative to the previous phase.
- Existing task-level `depends_on` within a phase continues to work unchanged.

## New MCP Tool: `sync_plan_graph`

### Purpose

A single tool call that parses a plan document's dependency annotations and atomically syncs them to GitHub issue `blockedBy` relationships. This replaces the need for the LLM to make N individual `add_dependency` calls.

### Interface

```typescript
server.tool("ralph_hero__sync_plan_graph", "Parse plan dependency graph and sync to GitHub blockedBy edges", {
  planPath: z.string().describe("Absolute path to the plan document"),
  dryRun: z.boolean().optional().describe("If true, report what would change without modifying GitHub"),
}, async (params) => { ... });
```

### Behavior

1. **Read the plan** — parse frontmatter for `github_issues`, `primary_issue`, `type`.
2. **Extract the dependency graph**:
   - For `type: plan`: scan `## Phase N: ... (GH-NNN)` headings and their `depends_on` annotations. Map phase numbers to issue numbers.
   - For `type: plan-of-plans`: scan `### Feature N: ... (GH-NNN)` headings and their `depends_on` annotations.
3. **Diff against GitHub** — query existing `blockedBy` edges for all issues in the plan via `subIssues` and dependency queries.
4. **Sync edges**:
   - Add missing `blockedBy` edges (plan declares dependency, GitHub doesn't have it).
   - Remove stale edges (GitHub has a `blockedBy` edge between plan issues that the plan no longer declares).
   - Leave edges involving issues outside the plan untouched.
5. **Return summary** — `{ added: [...], removed: [...], unchanged: [...], errors: [...] }`.

### Design Decisions

- **Idempotent**: safe to call multiple times. Subsequent calls with the same plan produce no changes.
- **Plan wins**: if a GitHub `blockedBy` edge between plan issues contradicts the plan, the plan takes precedence.
- **Scoped to plan issues**: edges involving issues not in the plan's `github_issues` array are never touched.
- **Within-phase task deps don't sync**: task-level `depends_on` is consumed directly by `ralph-impl` at execution time. GitHub `blockedBy` only operates at the issue level.

### Registration

New tool module `src/tools/plan-graph-tools.ts` following the existing `registerXyzTools()` pattern. The tool needs filesystem read access (to parse the plan) and GitHub API access (to query/mutate dependencies).

## Execution Layer Changes

### `ralph-impl` (autonomous single-issue implementation)

Today: processes phases sequentially. Phase 1 must complete before Phase 2 starts.

With dependency graph:
- Step 6.5 (task extraction) extends to parse phase-level `depends_on` and cross-phase task refs.
- Phase ordering becomes graph-driven: when a phase completes, the next phase(s) to execute are those whose `depends_on` are all satisfied, not just the numerically next phase.
- Multiple unblocked phases can execute concurrently via parallel subagent dispatch (extending the existing within-phase parallel task dispatch).
- If no explicit `depends_on` exists on phases, fall back to sequential ordering (backward compat).

### `hero` skill (single orchestrator, multi-issue)

Today: builds TaskList graph upfront. Research is parallel, implementation is sequential by default unless stream detection restructures it.

With dependency graph:
- After planning completes, hero reads each plan's phase-level `depends_on` to build the TaskList `blockedBy` chains.
- Phases with `depends_on: null` across independent issues become parallel tasks immediately.
- Stream detection becomes a fallback for plans without explicit dependency annotations.

### `team` skill (persistent multi-agent)

Today: team lead builds TaskList, builders are stream-scoped, claim unblocked tasks.

With dependency graph:
- Team lead reads all plan dependency graphs to construct TaskList with `blockedBy` edges matching declared dependencies.
- Builder scaling still uses stream detection for roster sizing (how many builders to spawn), but task ordering comes from the plan graph.
- When a builder finishes a phase, downstream phases that just became unblocked are made claimable.

### `ralph-plan-epic` (plan-of-plans orchestration)

Today: prose waves in `## Feature Sequencing`, sequential wave processing.

With dependency graph:
- Feature-level `depends_on` replaces prose waves. The dependency graph IS the sequencing.
- When dispatching `ralph-plan` for features, the epic planner dispatches all features whose `depends_on` are satisfied, in parallel.
- `produces`/`consumes` annotations on features are passed as sibling context to child plan invocations (extending the existing sibling context passing mechanism).

## GitHub `blockedBy` Sync

### Write Path (Plan → GitHub)

When `ralph-plan` or `ralph-plan-epic` commits a plan, it calls `sync_plan_graph` with the plan file path. The MCP tool handles all edge creation/removal.

### Read Path (GitHub → Orchestrator)

When an issue completes (reaches a gate state), `autoAdvanceParent` fires as today. The orchestrator (hero/team) re-reads the plan graph to determine what just became unblocked, rather than relying solely on GitHub `blockedBy` edges.

### Conflict Resolution

Plan wins for edges between plan issues. If someone manually adds/removes a `blockedBy` edge on GitHub that contradicts the plan, the orchestrator follows the plan. The agent can choose to override if it judges the situation warrants it.

## Hardening: Ensuring the Sync Happens

### Primary: Single Tool Call

`sync_plan_graph` is one call, not N. LLMs are much more reliable at remembering one tool call than N individual `add_dependency` calls. The plan skill checklist includes it as a required step.

### Safety Net: Postcondition Hook

`plan-postcondition.sh` is extended to:
1. Parse the plan document for `depends_on` annotations.
2. Query GitHub via `gh` CLI for actual `blockedBy` edges on the plan's issues.
3. Compare declared dependencies against actual edges.
4. **Block the plan skill from completing** if they don't match.

This is a hard gate — the planner cannot claim it's done without syncing. If the LLM forgot to call `sync_plan_graph`, the postcondition hook catches it and the LLM is forced to make the call.

## What Doesn't Change

- **State machine and workflow states** — untouched. Lock states, gate states, allowed transitions all stay the same.
- **Existing hook enforcement** — `impl-plan-required`, `lock-claim-validator`, worktree gates, branch gates all continue as-is.
- **Within-phase task `depends_on`** — same as today, extended to allow cross-phase refs.
- **Stream detection** — still available as fallback for plans without explicit dependency annotations and for builder roster sizing.
- **Caching, rate limiting, GitHub client** — no changes.
- **`autoAdvanceParent`** — continues to fire on gate state transitions. The dependency graph doesn't replace parent advancement; it governs sibling/peer ordering.

## Implementation Scope

| Component | Change | Type |
|-----------|--------|------|
| Plan document format | Phase-level `depends_on`, cross-phase task `depends_on`, feature-level `depends_on`/`produces`/`consumes` | Format extension |
| `src/tools/plan-graph-tools.ts` | New `sync_plan_graph` tool — plan parser + GitHub dependency sync | New tool module |
| `ralph-plan` skill | Add phase-level `depends_on` to template, add `sync_plan_graph` to checklist | Skill update |
| `ralph-plan-epic` skill | Replace prose waves with feature-level `depends_on`, add `sync_plan_graph` call | Skill update |
| `ralph-impl` skill | Extend Step 6.5 for phase-level deps, allow non-sequential phase execution | Skill update |
| `hero` skill | Build TaskList from plan dependency graph instead of defaulting to sequential | Skill update |
| `team` skill | Same as hero — TaskList edges from plan graph | Skill update |
| `plan-postcondition.sh` | Add dependency sync validation | Hook update |

## Open Questions

1. **Cross-plan dependencies**: Should `sync_plan_graph` handle dependencies between issues in different plan documents (e.g., GH-45 in plan B depends on GH-44 in plan A)? Or is that always managed at the epic level?
2. **Dependency removal**: When a plan is revised and a `depends_on` edge is removed, should `sync_plan_graph` also remove the corresponding GitHub `blockedBy` edge? (Current design says yes — plan wins.)
3. **Visualization**: Should the plan document include a rendered dependency graph (mermaid/dot) for human reviewability? This would be generated, not authored.
