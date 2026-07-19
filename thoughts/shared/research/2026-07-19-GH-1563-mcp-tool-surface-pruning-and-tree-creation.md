---
date: 2026-07-19
researcher: Chad Dubiel
git_commit: f8d81d0972fef8e73ccde1762e3fb212f042e05e
branch: worktree-bridge-cse_01JtrZkEy4BAc5iqfpdtmzHB
repository: ralph-hero
github_issue: 1563
github_url: https://github.com/cdubiel08/ralph-hero/issues/1563
topic: "MCP tool-surface audit: issue-tree creation cost + zero-reference tool pruning"
tags: [research, mcp-tools, toolspace, consolidation, tree-creation, batch, pruning]
status: complete
type: research
---

# Research: MCP Tool-Surface Pruning and Batch Issue-Tree Creation

## Research Question

Creating a ralph-hero issue tree (epic → feature children with dependency edges)
burns ~23 tool calls in a live session (observed in the GH-1550 plan-of-plans
session: 4× `add_sub_issue`, 3× `add_dependency`, plus `create_issue`,
`save_issue`, `get_issue`, `list_sub_issues` round-trips). Is there an existing
issue or plan to fix this? And more broadly: compare the entire MCP server tool
surface against how the plugin actually uses it, to find pruning and
consolidation opportunities.

## Summary

**No existing issue or plan covers this.** Prior art is [GH-451] (53→26
toolspace consolidation, merged 2026-02-27) and GH-21/GH-113 (original batch
tools). The surface has since re-grown to **38 tools**, of which **7 have zero
references anywhere in the live plugin surface** (`ralph/`, `plugin/`) and one
more (`batch_update`) is capable but bypassed by the exact loops it was built
for. The three tree-building surfaces (plan `--mode epic`, form tree shape,
caretake `--mode split`) all drive the same raw ~3-calls-per-child sequence;
no tool can create a parent+children+edges subtree in one call, though
`decompose_feature` comes close (issues + dependency edges in one call, but no
sub-issue links, and locked to `.ralph-repos.yml` registry patterns).

Tracked as [GH-1563](https://github.com/cdubiel08/ralph-hero/issues/1563).

## Detailed Findings

### 1. Tree-creation cost today

Three live surfaces create issue trees. All three instruct the model to run the
same per-child sequence — none use a bulk tool:

| Surface | Instruction | Calls per tree (N children, M edges) |
|---|---|---|
| `ralph/skills/plan/decomposition.md:58-83` (epic mode) | "create_issue → add_sub_issue(parent, child)… After all children are created, wire dependencies via add_dependency" | N + N + M, plus re-verification via `list_sub_issues`/`list_dependencies` |
| `ralph/skills/form/SKILL.md:142-143` (tree shape) | "For each child, create_issue … followed by add_sub_issue … For sequential children, add add_dependency edges in submission order" | N + N + M |
| `ralph/skills/caretake/modes/split.md:99-127` | create_issue → add_sub_issue (verify, retry once) → per-pair add_dependency; per-child estimate via save_issue | ≥3N + M |

Observed cost: the GH-1550 plan-of-plans session used **23 tool calls** to
assemble a 4-child tree (screenshot evidence, 2026-07-19). Each call is a
round-trip with its own model turn — the token cost is dominated by the
repeated tool-result → next-call reasoning cycles, not the GraphQL itself.

### 2. Bulk-capable tools exist but are bypassed

- **`decompose_feature`** (`mcp-server/src/tools/decompose-tools.ts:178-497`) —
  with `dryRun=false`, creates every proposed issue, adds each to the project,
  AND wires `blockedBy` edges from the pattern's `dependency_chain` in one
  call. But: no `add_sub_issue` parent/child links (flat sibling set only), and
  decomposition comes from named `.ralph-repos.yml` registry patterns, not an
  inline spec. 8 live references (research/plan/setup/caretake/hero) — but
  always as an *option*, never in the epic child-creation loop.
- **`sync_plan_graph`** (`plan-graph-tools.ts:81`) — parses a plan doc's
  `depends_on:` annotations, diffs vs live `blockedBy`, adds/removes edges.
  Edges only — no issues, no sub-issue links. Semi-live: documented in
  `ralph/skills/plan/plan-shapes.md:150,161,207` and `plan-postcondition.sh`
  warns when a plan has `depends_on` but the graph wasn't synced — yet
  `decomposition.md` § Dependency-edge rules tells the model to wire edges
  manually with `add_dependency`.
- **`batch_update`** (`batch-tools.ts:224`) — bulk field updates across ≤50
  issues via aliased GraphQL (~2 API calls instead of 3N). **Zero live
  references.** `split.md` Step 10 ("set workflow state for EVERY child") is
  its exact use case and instead loops per-child `save_issue`.

### 3. Full tool inventory vs live usage

38 registered tools (36 always-on + 2 gated by `RALPH_DEBUG`). "Live refs" =
files under `ralph/` + `plugin/` that mention the tool (skill bodies, agent
`tools:` frontmatter, hooks); docs/thoughts references excluded.

**Hot core (8-21 live files each):** `save_issue` (21), `get_issue` (19),
`list_issues` (17), `create_comment` (17), `create_issue` (10),
`list_sub_issues` (9), `add_dependency` (8), `add_sub_issue` (7).

**Working periphery (1-6):** `pipeline_dashboard` (6), `recent_activity` (5),
`remove_dependency` (4), `advance_issue` (4), `next_actions` (3),
`metrics_trends` (3), `list_dependencies` (3), `project_hygiene` (2),
`archive_items` (2), `capture_snapshot` (2), `health_check`, `get_project`,
`setup_project`, `create_status_update`, `collate_debug`, 4× `sre__*` (1 each,
single-consumer by design), `detect_stream_positions` (1 — hero only),
`decompose_feature` (8 — always optional path), `sync_plan_graph` (1 —
plan-shapes prose + postcondition hook).

**Zero live references (prune candidates):**

| Tool | Module | Note |
|---|---|---|
| `create_draft_issue` | project-management-tools.ts:44 | Draft subsystem: live paths always use `create_issue` directly |
| `update_draft_issue` | project-management-tools.ts:145 | ” |
| `convert_draft_issue` | project-management-tools.ts:201 | Own description flags it broken with fine-grained PATs |
| `get_draft_issue` | project-management-tools.ts:267 | Zero references even in docs |
| `list_groups` | relationship-tools.ts:1062 | Superseded: `get_issue` returns group data by default (GH-451-era enrichment); `list_sub_issues` covers per-parent |
| `create_views` | view-tools.ts:39 | Doc-only references |
| `debug_stats` | debug-tools.ts:765 | RALPH_DEBUG-gated and unused |
| `batch_update` | batch-tools.ts:224 | Capable but bypassed — wire in or delete |

### 4. Overlap notes (not zero-ref, but consolidation-relevant)

- **`advance_issue` vs `save_issue`** — `save_issue` already auto-advances the
  parent at gate states; `advance_issue`'s unique value is relationship fan-out
  (advance all children). The parent-gate half is duplicated.
- **`detect_stream_positions` vs `pipeline_dashboard`** — different mechanics
  (pure compute over caller data vs full fetch), but single consumer (hero);
  candidate to inline rather than keep as a public tool.
- **Scan family** — `list_issues`, `pipeline_dashboard`, `next_actions`,
  `project_hygiene`, `health_check` each do a full project scan; shared fetch +
  thin presenters is an internal refactor opportunity (not a surface change).

### 5. Why pruning pays beyond hygiene

Every registered tool's JSONSchema + description string loads into the context
of **every session and every agent** whose allowlist includes ralph tools. The
`list_issues` description alone is ~350 words. ~20% of the surface is dead
weight paid on every dispatch — research-agent, impl-agent, merge-agent, etc.
all carry it via the MCP server connection even when frontmatter narrows what
they may *call*.

## Proposed Direction (for the plan phase)

1. **`create_sub_issues` batch tool** — input: parent issue number + array of
   child specs `{title, body, estimate, priority, workflowState, dependsOn:
   [sibling-index | GH-number]}`. One call: create N issues (aliased GraphQL,
   same pattern as `batch_update`), add to project with fields, link each via
   sub-issue mutation, wire dependency edges, return the created tree.
   Cycle-validate `dependsOn` before any mutation. Collapses ~3N+M calls → 1.
2. **Rewire the three skills** — `decomposition.md` § Child creation,
   `form/SKILL.md` tree shape, `split.md` — to call it; keep single-child
   `create_issue` + `add_sub_issue` for incremental additions.
3. **Prune the 7 zero-ref tools** (draft quartet, `list_groups`,
   `create_views`, `debug_stats`); decide `batch_update` (wire into split
   Step 10 or fold its aliased-update capability into the new batch tool).
4. **Resolve the edge-wiring split-brain**: either `create_sub_issues`
   subsumes `sync_plan_graph`'s role at creation time (sync remains for
   post-hoc reconciliation), or decomposition.md switches to sync_plan_graph —
   not both manual `add_dependency` loops *and* a warning hook for the tool
   nobody calls.
5. **Roster/doc pass** — CLAUDE.md tool tables are CI-checked
   (`scripts/check-doc-rosters.sh`); removals must land in the same PR.

## Prior Art

- [GH-451] MCP toolspace consolidation 53→26 —
  `thoughts/shared/research/2026-03-03-GH-0451-toolspace-consolidation-status-and-next-steps.md`
- Hero entry-point ↔ tool allowlist inventory —
  `thoughts/shared/research/2026-05-24-hero-entry-points-mcp-tool-inventory.md`
- GH-21 (batch operations), GH-113 (`bulk_archive`), GH-1153 (shorthand
  discovery tools elegance pass) — all closed
- GH-1552 (open): `pipeline_status_summary` tool — coordinate so the surface
  doesn't re-grow while this pass prunes it

[GH-451]: https://github.com/cdubiel08/ralph-hero/issues/451
