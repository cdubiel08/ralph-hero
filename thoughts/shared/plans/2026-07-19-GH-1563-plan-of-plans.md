---
date: 2026-07-19
type: plan-of-plans
github_issue: 1563
github_issues: [1563, 1565, 1566]
status: draft
tags: [mcp-tools, toolspace, consolidation, tree-creation, batch, pruning]
---

# MCP tool-surface optimization: batch issue-tree creation + prune zero-reference tools

## Strategic Context

Creating a ralph-hero issue tree today costs ~3N+M sequential MCP tool calls
(N× `create_issue`, N× `add_sub_issue`, M× `add_dependency`, plus verification
round-trips) — a live plan-of-plans session (GH-1550) burned 23 calls to
assemble a 4-child tree. Meanwhile the tool surface has re-grown to 38 tools
since the GH-451 consolidation (53→26), and 7 of them have zero live
references in `ralph/` or `plugin/`. Every registered tool's schema+description
loads into every session and every agent carrying ralph tools, so the dead
20% is a real, recurring token cost — not just clutter.

Success at the parent-issue level: a batch tree-creation tool exists and is
wired into all three call sites that build trees (epic decomposition, form,
split), and the zero-reference tool surface is gone, with `batch_update`'s
fate explicitly decided rather than left as unused-but-capable.

Full research: `thoughts/shared/research/2026-07-19-GH-1563-mcp-tool-surface-pruning-and-tree-creation.md`.

## Shared Constraints

- Both children touch `mcp-server/src/tools/` and the root `CLAUDE.md` tool
  roster tables — `scripts/check-doc-rosters.sh` (CI-checked) must pass after
  either child's doc edits, so roster changes land in the same PR as the code
  change that motivates them.
- Both children are MCP-server-internal changes with no user-facing schema
  break beyond the tool list itself — no data migration, no workflow-state
  changes.
- Existing aliased-GraphQL bulk pattern (`batch-tools.ts`, `decompose-tools.ts`)
  is the shared implementation precedent for #1565's new tool and for any
  `batch_update` rewire in #1566.

## Feature Decomposition

### Feature A: Add `create_sub_issues` MCP batch tool + rewire tree-creation call sites (GH-1565)
- **Estimate**: S
- **Owner files**: `mcp-server/src/tools/` (new tool module), `ralph/skills/plan/decomposition.md`, `ralph/skills/form/SKILL.md`, `ralph/skills/caretake/modes/split.md`, root `CLAUDE.md` tool roster
- **Scope**: New `create_sub_issues` batch tool (parent + child specs array, aliased GraphQL, cycle-validated `dependsOn`) that creates issues + sub-issue links + dependency edges in one call. Rewire all three tree-creation call sites to use it. Resolve the edge-wiring split-brain between manual `add_dependency` loops and `sync_plan_graph`.
- **Acceptance**: Tool creates a full child tree in one call; all three call sites rewired; edge-wiring ownership resolved and documented; unit tests cover cycle detection and partial failure; roster docs updated.

### Feature B: Prune 6 zero-reference MCP tools + resolve `batch_update` fate (GH-1566)
- **Estimate**: S
- **Owner files**: `mcp-server/src/tools/project-management-tools.ts`, `relationship-tools.ts`, `view-tools.ts`, `debug-tools.ts`, `ralph/skills/caretake/modes/split.md` (if `batch_update` is wired in), root `CLAUDE.md` tool roster
- **Scope**: Remove the draft-issue quartet, `list_groups`, `create_views`, `debug_stats` (zero live references). Decide `batch_update`'s fate — wire it into split §Step 10's state-uniformity loop, or delete it if Feature A's new tool subsumes its capability.
- **Acceptance**: 6 dead tools removed (registration + handlers + tests); `batch_update` decision executed; roster docs match the live tool set; `scripts/check-doc-rosters.sh` passes; zero grep hits for removed tool names under `ralph/`, `plugin/`.

## Integration Strategy

No runtime coupling between the two changes — one adds a tool, the other
removes tools, and they touch disjoint tool modules. The only shared surface
is the root `CLAUDE.md` roster table, which both features edit; since they
land as one group plan / one PR (GH-1538), the roster ends up in one
consistent state rather than needing a merge reconciliation. The one design
coupling is informational: Feature B's `batch_update` decision is easier to
make once Feature A's new tool's capabilities are concretely known (does it
subsume bulk field updates, or only tree creation?).

## Feature Sequencing

GH-1565 → GH-1566. Feature A ships first so Feature B's `batch_update`
wire-in-or-delete decision has a concrete answer to react to. Both land in
the same group plan / single PR per GH-1538 — this is phase ordering within
that PR, not a hard cross-PR gate.

## What We're NOT Doing

- Not touching the "overlap notes" from the research doc (`advance_issue` vs
  `save_issue` parent-gate duplication, `detect_stream_positions` vs
  `pipeline_dashboard`, the scan-family shared-fetch refactor) — those are
  internal-refactor opportunities, not surface changes, and are out of scope
  for this pass.
- Not coordinating with GH-1552's `pipeline_status_summary` proposal beyond
  the research doc's note to watch for surface re-growth — that issue is
  independent and untouched here.

## Design Decisions & Open Ambiguities

- Resolved: split into exactly 2 children along the "add a tool" vs "remove
  tools" boundary — each ships independently (separate PR/revert scope per
  GH-1538 §split criteria), rather than bundling into one issue.
- Resolved: `batch_update`'s fate is deferred to the plan phase of GH-1566,
  informed by GH-1565's design, rather than pre-decided here.

None — no other open design decisions.

## References

- Parent: #1563
- Children: #1565, #1566
- Research: `thoughts/shared/research/2026-07-19-GH-1563-mcp-tool-surface-pruning-and-tree-creation.md`
- Prior art: GH-451 (toolspace consolidation 53→26), GH-21, GH-113 (original batch operations)
