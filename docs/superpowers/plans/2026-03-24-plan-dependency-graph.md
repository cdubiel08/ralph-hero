# Plan-Time Dependency Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable plan documents to express explicit dependency graphs that the execution layer consumes for parallelization decisions.

**Architecture:** New `plan-graph-tools.ts` module with a pure plan parser (`parsePlanGraph`) and a `sync_plan_graph` MCP tool that syncs the parsed graph to GitHub `blockedBy` edges. Skill updates teach planners to emit `depends_on` annotations and orchestrators to read them.

**Tech Stack:** TypeScript (MCP server), vitest (tests), markdown parsing (regex-based, following existing patterns in `ralph-impl`), GitHub GraphQL API (existing `addBlockedBy`/`removeBlockedBy` mutations via `GitHubClient`)

---

### Task 1: Plan graph parser — pure function

**Files:**
- Create: `plugin/ralph-hero/mcp-server/src/lib/plan-graph.ts`

- [ ] **Step 1: Create the `PlanDependencyGraph` type and `parsePlanGraph` function**

```typescript
// plugin/ralph-hero/mcp-server/src/lib/plan-graph.ts

export interface DependencyEdge {
  /** The issue that is blocked (must wait) */
  blocked: number;
  /** The issue that is blocking (must complete first) */
  blocking: number;
  /** Where this edge was declared in the plan */
  source: "phase-level" | "feature-level";
}

export interface PlanDependencyGraph {
  /** Plan type from frontmatter */
  type: "plan" | "plan-of-plans";
  /** All issue numbers from frontmatter github_issues */
  issues: number[];
  /** Primary issue from frontmatter */
  primaryIssue: number;
  /** Map of phase number → issue number (for type: plan) */
  phaseToIssue: Map<number, number>;
  /** Resolved dependency edges (issue-level only, no task-level) */
  edges: DependencyEdge[];
}

/**
 * Parse a plan document and extract its dependency graph.
 * Pure function — no I/O, no GitHub calls.
 */
export function parsePlanGraph(content: string): PlanDependencyGraph { ... }
```

The parser should:
1. Extract frontmatter `type`, `github_issues`, `primary_issue` using the same YAML-in-markdown pattern used elsewhere in the codebase (regex for `---` fenced block)
2. For `type: plan`: scan for `## Phase N:` headings matching the pattern `## Phase (\d+):.*\(GH-(\d+)\)` to build `phaseToIssue` map. Then scan lines after each heading for `- **depends_on**: [phase-N, ...]` or `- **depends_on**: [GH-NNN, ...]`. Resolve `phase-N` refs via `phaseToIssue`.
3. For `type: plan-of-plans`: scan for `### Feature` headings matching `### Feature \w+:.*\(GH-(\d+)\)`. Then scan lines after each heading for `- **depends_on**: [GH-NNN, ...]`.
4. `depends_on: null` and absent `depends_on` produce no edges for that phase/feature.
5. Return the resolved `DependencyEdge[]` with issue numbers (not phase identifiers).

- [ ] **Step 2: Run TypeScript build to verify compilation**

Run: `cd plugin/ralph-hero/mcp-server && npm run build`
Expected: Clean compilation

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/lib/plan-graph.ts
git commit -m "feat: plan dependency graph parser (pure function)"
```

---

### Task 2: Tests for plan graph parser

**Files:**
- Create: `plugin/ralph-hero/mcp-server/src/__tests__/plan-graph.test.ts`

- [ ] **Step 1: Write tests for `parsePlanGraph`**

```typescript
import { describe, it, expect } from "vitest";
import { parsePlanGraph } from "../lib/plan-graph.js";

const PLAN_WITH_DEPS = `---
type: plan
github_issues: [660, 661, 662]
primary_issue: 659
---
# Test Plan

## Phase 1: Core data model (GH-660)
- **depends_on**: null

## Phase 2: API integration (GH-661)
- **depends_on**: [phase-1]

## Phase 3: CLI commands (GH-662)
- **depends_on**: [phase-1]
`;

const PLAN_NO_DEPS = `---
type: plan
github_issues: [100]
primary_issue: 100
---
# Simple Plan

## Phase 1: Everything (GH-100)
`;

const PLAN_OF_PLANS = `---
type: plan-of-plans
github_issues: [44, 45, 46]
primary_issue: 43
---
# Epic Plan

## Feature Decomposition

### Feature A: Auth middleware (GH-44)
- **depends_on**: null

### Feature B: Protected routes (GH-45)
- **depends_on**: [GH-44]

### Feature C: Audit logging (GH-46)
- **depends_on**: null
`;

describe("parsePlanGraph", () => {
  it("parses phase-level depends_on from a plan", () => {
    const graph = parsePlanGraph(PLAN_WITH_DEPS);
    expect(graph.type).toBe("plan");
    expect(graph.issues).toEqual([660, 661, 662]);
    expect(graph.edges).toHaveLength(2);
    // Phase 2 (GH-661) blocked by Phase 1 (GH-660)
    expect(graph.edges).toContainEqual({
      blocked: 661, blocking: 660, source: "phase-level",
    });
    // Phase 3 (GH-662) blocked by Phase 1 (GH-660)
    expect(graph.edges).toContainEqual({
      blocked: 662, blocking: 660, source: "phase-level",
    });
  });

  it("returns empty edges for plan with no depends_on", () => {
    const graph = parsePlanGraph(PLAN_NO_DEPS);
    expect(graph.edges).toHaveLength(0);
    expect(graph.issues).toEqual([100]);
  });

  it("parses feature-level depends_on from plan-of-plans", () => {
    const graph = parsePlanGraph(PLAN_OF_PLANS);
    expect(graph.type).toBe("plan-of-plans");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toEqual({
      blocked: 45, blocking: 44, source: "feature-level",
    });
  });

  it("handles depends_on: null explicitly", () => {
    const graph = parsePlanGraph(PLAN_WITH_DEPS);
    // Phase 1 has depends_on: null — should produce no edges where 660 is blocked
    const edgesBlocking660 = graph.edges.filter(e => e.blocked === 660);
    expect(edgesBlocking660).toHaveLength(0);
  });

  it("handles multiple dependencies on one phase", () => {
    const content = `---
type: plan
github_issues: [10, 11, 12]
primary_issue: 10
---
## Phase 1: A (GH-10)
- **depends_on**: null

## Phase 2: B (GH-11)
- **depends_on**: null

## Phase 3: C (GH-12)
- **depends_on**: [phase-1, phase-2]
`;
    const graph = parsePlanGraph(content);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges).toContainEqual({ blocked: 12, blocking: 10, source: "phase-level" });
    expect(graph.edges).toContainEqual({ blocked: 12, blocking: 11, source: "phase-level" });
  });

  it("handles GH-NNN references in plan depends_on", () => {
    const content = `---
type: plan
github_issues: [20, 21]
primary_issue: 20
---
## Phase 1: A (GH-20)
- **depends_on**: null

## Phase 2: B (GH-21)
- **depends_on**: [GH-20]
`;
    const graph = parsePlanGraph(content);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toEqual({ blocked: 21, blocking: 20, source: "phase-level" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/plan-graph.test.ts`
Expected: FAIL (parser not yet implemented — only types exist)

- [ ] **Step 3: Implement `parsePlanGraph` to make all tests pass**

Implement the function body in `plan-graph.ts` following the regex patterns described in Task 1.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/plan-graph.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run full test suite for regressions**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/__tests__/plan-graph.test.ts plugin/ralph-hero/mcp-server/src/lib/plan-graph.ts
git commit -m "test: plan dependency graph parser with TDD"
```

---

### Task 3: `sync_plan_graph` MCP tool

**Files:**
- Create: `plugin/ralph-hero/mcp-server/src/tools/plan-graph-tools.ts`
- Modify: `plugin/ralph-hero/mcp-server/src/index.ts:18-27` (add import)
- Modify: `plugin/ralph-hero/mcp-server/src/index.ts:350-383` (add registration)

- [ ] **Step 1: Create `plan-graph-tools.ts` with `registerPlanGraphTools`**

Follow the pattern from `decompose-tools.ts` (lines 169-503). The tool:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "fs/promises";
import type { GitHubClient } from "../github-client.js";
import { parsePlanGraph } from "../lib/plan-graph.js";
import type { DependencyEdge } from "../lib/plan-graph.js";
import { toolSuccess, toolError } from "../types.js";
import { resolveIssueNodeId, resolveConfig } from "../lib/helpers.js";

export function registerPlanGraphTools(
  server: McpServer,
  client: GitHubClient,
): void {
  server.tool(
    "ralph_hero__sync_plan_graph",
    "Parse plan dependency graph and sync to GitHub blockedBy edges",
    {
      planPath: z.string().describe("Absolute path to the plan document"),
      dryRun: z.boolean().optional().default(false)
        .describe("If true, report what would change without modifying GitHub"),
    },
    async ({ planPath, dryRun }) => {
      // 1. Read and parse plan
      let content: string;
      try {
        content = await readFile(planPath, "utf-8");
      } catch (err) {
        return toolError(`Failed to read plan: ${planPath} — ${err}`);
      }

      const graph = parsePlanGraph(content);
      if (graph.issues.length === 0) {
        return toolError("Plan has no github_issues in frontmatter");
      }
      if (graph.edges.length === 0 && !dryRun) {
        return toolSuccess({
          message: "No dependency edges declared in plan",
          added: [], removed: [], unchanged: [],
        });
      }

      // 2. Query existing blockedBy edges for all plan issues
      // Use list_dependencies pattern from relationship-tools.ts:561-583
      const existingEdges: Array<{ blocked: number; blocking: number }> = [];
      for (const issueNum of graph.issues) {
        const query = `query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            issue(number: $number) {
              blockedBy(first: 50) {
                nodes { number }
              }
            }
          }
        }`;
        // ... query each issue, collect edges
      }

      // 3. Diff: declared vs existing (scoped to plan issues only)
      // 4. If dryRun, return diff without mutating
      // 5. If not dryRun, add missing edges, remove stale edges
      //    using addBlockedBy/removeBlockedBy mutations
      //    (same GraphQL as relationship-tools.ts:391-400 and 477-486)
      // 6. Return summary
    },
  );
}
```

Key implementation details:
- Use `resolveIssueNodeId` from `helpers.ts:191-219` to get node IDs for mutations
- Use the same `addBlockedBy`/`removeBlockedBy` mutations as `relationship-tools.ts`
- Filter existing edges to only those between plan issues (ignore external edges)
- Batch queries where possible (similar to `autoAdvanceParent` batch strategy)

- [ ] **Step 2: Register the tool in `index.ts`**

Add import at line 27 area:
```typescript
import { registerPlanGraphTools } from "./tools/plan-graph-tools.js";
```

Add registration call at line 378 area:
```typescript
registerPlanGraphTools(server, client);
```

- [ ] **Step 3: Run TypeScript build**

Run: `cd plugin/ralph-hero/mcp-server && npm run build`
Expected: Clean compilation

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/tools/plan-graph-tools.ts plugin/ralph-hero/mcp-server/src/index.ts
git commit -m "feat: sync_plan_graph MCP tool for dependency sync"
```

---

### Task 4: Tests for `sync_plan_graph` tool

**Files:**
- Create: `plugin/ralph-hero/mcp-server/src/__tests__/plan-graph-tools.test.ts`

- [ ] **Step 1: Write tests**

Follow the pattern from `decompose-tools.test.ts` — test the pure logic, mock the GitHub client. Key test cases:

1. **dryRun returns diff without mutating** — pass a plan with 2 edges, mock empty GitHub state, verify response has `added: [2 edges]` and no mutations called
2. **adds missing edges** — plan declares A→B, GitHub has none, verify `addBlockedBy` mutation called
3. **removes stale edges** — plan declares no deps, GitHub has A→B between plan issues, verify `removeBlockedBy` mutation called
4. **leaves external edges alone** — GitHub has A→C where C is not in plan issues, verify no removal
5. **idempotent** — plan declares A→B, GitHub has A→B, verify no mutations called, response has `unchanged: [1]`
6. **handles plan with no edges** — verify early return with empty arrays

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/plan-graph-tools.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the missing logic to make tests pass**

Fill in the query and mutation logic in the tool handler.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/plan-graph-tools.test.ts`
Expected: All PASS

- [ ] **Step 5: Run full test suite**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/__tests__/plan-graph-tools.test.ts plugin/ralph-hero/mcp-server/src/tools/plan-graph-tools.ts
git commit -m "test: sync_plan_graph tool with mocked GitHub client"
```

---

### Task 5: Update `ralph-plan` skill

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-plan/SKILL.md:38-50` (allowed-tools)
- Modify: `plugin/ralph-hero/skills/ralph-plan/SKILL.md:290` (phase template)
- Modify: `plugin/ralph-hero/skills/ralph-plan/SKILL.md:407-430` (postcondition steps)

- [ ] **Step 1: Add `ralph_hero__sync_plan_graph` to allowed-tools**

In the frontmatter `allowed-tools` list (lines 38-50), add:
```yaml
  - ralph_hero__sync_plan_graph
```

- [ ] **Step 2: Add `depends_on` to the phase template**

In the plan template section (around line 290), update the phase heading format to include `depends_on`:

The existing format:
```markdown
## Phase 1: [Atomic Issue GH-123 — title]
```

Add after each phase heading:
```markdown
## Phase N: [description (GH-NNN)]
- **depends_on**: null | [phase-N, GH-NNN, ...]
```

Add guidance text explaining:
- `depends_on: null` means no dependencies (can start immediately)
- `depends_on: [phase-1]` means blocked by Phase 1
- Multiple deps: `depends_on: [phase-1, phase-2]` means blocked by both
- `GH-NNN` format for cross-plan references
- If omitted, phases are treated as sequential (backward compat)

- [ ] **Step 3: Add `sync_plan_graph` call to the skill's checklist**

After the plan document is committed (around line 429, after "Move to Plan in Review"), add a new step.
**Note**: The existing Step 8 ("Team Result Reporting") and Step 9 ("Report Completion") must be renumbered to Steps 9 and 10 respectively.

```markdown
### Step 8: Sync Dependency Graph

Call `ralph_hero__sync_plan_graph` with the plan file path to sync all
`depends_on` edges to GitHub `blockedBy` relationships:

```
ralph_hero__sync_plan_graph({ planPath: "<absolute path to plan>" })
```

This is a **required step** — the postcondition hook will block if it detects
`depends_on` annotations that haven't been synced.
```

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-plan/SKILL.md
git commit -m "feat: update ralph-plan skill with depends_on template and sync_plan_graph"
```

---

### Task 6: Update `ralph-plan-epic` skill

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md:30-47` (allowed-tools)
- Modify: `plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md:152-184` (feature decomposition template)
- Modify: `plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md:169-183` (wave sequencing → dependency graph)

- [ ] **Step 1: Add `ralph_hero__sync_plan_graph` to allowed-tools**

In the frontmatter `allowed-tools` list (lines 30-47), add:
```yaml
  - ralph_hero__sync_plan_graph
```

- [ ] **Step 2: Replace prose `Dependencies` with structured `depends_on`**

In the Feature Decomposition template (lines 152-184), change the feature block format from:
```markdown
### Feature A: [name] (GH-NNN)
- **Scope**: ...
- **Produces**: ...
- **Dependencies**: Feature X (needs types from X)
```

To:
```markdown
### Feature A: [name] (GH-NNN)
- **depends_on**: null | [GH-NNN, ...]
- **produces**: ...
- **consumes**: ...  (if applicable)
```

- [ ] **Step 3: Replace `## Feature Sequencing` waves with guidance**

Replace the wave template (lines 169-183) with guidance that the dependency graph expressed in `depends_on` annotations IS the sequencing. Remove `Wave N` headings and `blocked_by:` syntax. Add:

```markdown
## Feature Sequencing

Feature execution order is derived from the `depends_on` graph above.
Features with `depends_on: null` can be planned in parallel.
Features with `depends_on: [GH-NNN]` wait until the referenced feature's
plan is complete before planning begins.

No separate wave section is needed — the graph is the sequencing.
```

- [ ] **Step 4: Add `sync_plan_graph` call after plan-of-plans commit**

Add a step similar to ralph-plan's Step 8 — call `sync_plan_graph` after committing the plan-of-plans document.

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md
git commit -m "feat: update ralph-plan-epic with depends_on and sync_plan_graph"
```

---

### Task 7: Update `ralph-impl` phase selection

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-impl/SKILL.md:147-151` (phase selection logic)
- Modify: `plugin/ralph-hero/skills/ralph-impl/SKILL.md:277-287` (Step 6.5 task extraction)

- [ ] **Step 1: Update phase selection logic**

At lines 147-151 (Step 3, detect current progress), change the "first unchecked phase" logic to:

```markdown
Scan for `## Phase N:` sections and check `#### Automated Verification:` checkboxes.
A phase is complete if ALL automated items are `- [x]`.

**Phase selection (dependency-aware)**:
1. Find all unchecked phases.
2. For each unchecked phase, check its `- **depends_on**:` annotation.
3. If `depends_on` is `null` or absent, the phase is **unblocked**.
4. If `depends_on` references other phases (e.g., `[phase-1]`), check whether
   those referenced phases are complete (all automated verification items checked).
5. Select the **first unblocked unchecked phase** (by phase number).
6. If NO unchecked phase is unblocked, STOP and report:
   "All remaining phases have unsatisfied dependencies. Blocked on: [list]."
   The orchestrator will resume after blocking phases complete.

**Backward compat**: Phases without `depends_on` annotations are treated as
sequential — Phase N depends on Phase N-1.
```

- [ ] **Step 2: Update Step 6.5 task extraction**

At lines 277-287, add a note that cross-phase task `depends_on` references (e.g., `depends_on: [1.3]` where `1.3` is in a different phase) are informational within `ralph-impl` — the orchestrator handles cross-phase ordering. `ralph-impl` only evaluates within-phase task dependencies as it does today.

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-impl/SKILL.md
git commit -m "feat: dependency-aware phase selection in ralph-impl"
```

---

### Task 8: Update `hero` skill task graph construction

**Files:**
- Modify: `plugin/ralph-hero/skills/hero/SKILL.md:152-188` (task graph construction)

- [ ] **Step 1: Update the task graph construction section**

At lines 152-188, where implementation tasks get `blockedBy` chains, add dependency-graph-aware logic:

```markdown
**Implementation task ordering (dependency-graph-aware)**:

After all plans are written, read each plan's `## Phase N:` headings and
their `- **depends_on**:` annotations.

1. For each phase in each plan, create an implementation task.
2. Set `blockedBy` chains from the plan's dependency graph:
   - If Phase 2 has `depends_on: [phase-1]`, the Phase 2 impl task
     is `blockedBy` the Phase 1 impl task.
   - If Phase 3 has `depends_on: null`, the Phase 3 impl task has
     no `blockedBy` — it can execute in parallel with Phase 1.
3. If a plan has NO `depends_on` annotations on any phase,
   fall back to sequential `blockedBy` chains (current behavior).

This replaces the default sequential ordering with a graph-driven
ordering that enables parallel dispatch of independent phases.
```

Also update the stream detection section (lines 207-215) to note that stream detection becomes a fallback — the plan dependency graph takes precedence when available.

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-hero/skills/hero/SKILL.md
git commit -m "feat: hero skill reads plan dependency graph for task ordering"
```

---

### Task 9: Update `team` skill task graph construction

**Files:**
- Modify: `plugin/ralph-hero/skills/team/SKILL.md:103-183` (task list construction)

- [ ] **Step 1: Update task list construction**

At lines 103-148 (task graph construction), add the same dependency-graph-aware logic as the hero skill. The team lead reads plan documents' `depends_on` annotations and constructs `blockedBy` chains accordingly.

Key difference from hero: the team skill already has stream-scoped builder isolation (lines 176-181). When the plan graph provides dependency information, stream detection for task ordering becomes a fallback. Stream detection for **roster sizing** (how many builders to spawn) remains unchanged.

Add guidance:
```markdown
**Priority for task ordering**:
1. Plan dependency graph (`depends_on` annotations) — if present
2. Stream detection (`detect_stream_positions`) — fallback when no annotations
3. Sequential by default — fallback when no stream data
```

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-hero/skills/team/SKILL.md
git commit -m "feat: team skill reads plan dependency graph for task ordering"
```

---

### Task 10: Update `plan-postcondition.sh`

**Files:**
- Modify: `plugin/ralph-hero/hooks/scripts/plan-postcondition.sh` (lines 37-44)

- [ ] **Step 1: Add dependency sync validation**

After the existing artifact comment check (lines 37-41), before the final pass message (lines 43-44), add:

```bash
# --- Dependency graph sync check ---
# If the plan has depends_on annotations, verify sync_plan_graph was called.
# We check the conversation log for the tool call rather than querying GitHub
# directly, since the hook runs in bash without MCP access.
if grep -q 'depends_on.*\[' "$doc" 2>/dev/null; then
  # Plan has dependency annotations — check if sync happened
  # Look for sync_plan_graph in the tool call history
  log_file="/tmp/ralph-plan-sync-${ticket_id}"
  if [ ! -f "$log_file" ]; then
    echo "⚠️  WARNING: Plan has depends_on annotations but sync_plan_graph may not have been called."
    echo "   Run: ralph_hero__sync_plan_graph({ planPath: \"$doc\" })"
    echo "   Then retry."
    # Non-blocking warning for now — upgrade to exit 2 once the tool is proven reliable
  fi
fi
```

Note: Start as a warning (non-blocking) rather than a hard gate. Once `sync_plan_graph` is proven reliable in practice, upgrade to `exit 2` (blocking).

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-hero/hooks/scripts/plan-postcondition.sh
git commit -m "feat: plan-postcondition warns on unsynced dependency graph"
```

---

### Task 11: Full integration test and build verification

**Files:**
- No new files

- [ ] **Step 1: Run full MCP server test suite**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: All tests PASS

- [ ] **Step 2: Run TypeScript build**

Run: `cd plugin/ralph-hero/mcp-server && npm run build`
Expected: Clean compilation

- [ ] **Step 3: Verify the tool registers correctly**

Run: `cd plugin/ralph-hero/mcp-server && node -e "import('./dist/index.js')" 2>&1 | head -5`
Expected: No import errors (the server will fail without env vars, but imports should resolve)

- [ ] **Step 4: Final commit if any loose changes**

```bash
git status
# If any uncommitted changes, commit them
```
