---
date: 2026-07-26
type: plan-of-plans
github_issue: 1591
parent_epic: 1588
status: draft
tags: [surface-reduction, mcp-tools, 4cs, workflow-first]
---

# GH-1591 Plan of Plans — Tool surface reduction wave 2 (33 → ≤20, workflow-first)

## Strategic Context

Wave 1 (#1563/#1565/#1566, PR #1570, merged 2026-07-19) added the batch
`create_sub_issues` tool and pruned 7 zero-reference tools. The 2026-07-25
audit of the post-prune surface found the distribution still badly skewed:
6 tools carry ~60% of all references, 12 have exactly one consumer, and the
4 `sre__*` tools have zero consumers on the board surface.

The governing principle is *workflow-first*: keep composed tools that do a
whole job server-side (`create_sub_issues`, `advance_issue`,
`decompose_feature`) and push more logic down into them, because the MCP
server is the layer every harness shares — a skill-prose rule only binds
Claude Code, a server-side rule binds hero-fable and any future metaharness
too. That is the same argument feature 1 (#1589) made for the merge gate.

## Shared Constraints

- **Tool tables are CI-checked.** `scripts/check-doc-rosters.sh` validates
  the CLAUDE.md tool-module table against source; `tool-registration.test.ts`
  asserts the registered surface.
- **Downstream consumers exist.** ralph-demo and ralph-playwright call
  `get_issue` / `create_issue` / `create_comment` — those three are not
  candidates for removal or rename.
- **Two failure directions, not one.** Prose→roster (a tool named in prose
  with no `allowed-tools` grant, e.g. `sync_plan_graph`) and
  registration→consumer (a registered tool nobody calls, e.g.
  `detect_stream_positions`). The wave fixes instances of both and ends by
  making both impossible in CI.
- **Cross-feature coupling.** `collate_debug`'s fate is decided by #1603
  (caretake `--mode debug` deletion) in the sibling feature #1590; the
  dependency is wired on the board.
- **Merge path.** `main` is ruleset-protected — land via PR through
  `scripts/attest-pr.sh` + `scripts/merge-pr.sh` (GH-1589). Changes under
  `mcp-server/src/**` trigger the auto-release workflow on merge.

## Feature Decomposition

### Feature 1 — #1609: Cut zero/thin-consumer tools: `detect_stream_positions` and `create_status_update`

`detect_stream_positions` has zero call sites — its only reference is an
allowed-tools roster line in hero. `create_status_update` has a single thin
consumer. Removing them also means deleting whatever lib code becomes
unreachable, while keeping the shared phase-detection path in
`pipeline-detection.ts` that still backs `get_issue(includePipeline)`.

Acceptance: neither tool registered, no dead lib code, the former
`create_status_update` consumer has a documented replacement or an explicit
capability-drop note, tests and doc rosters green.

### Feature 2 — #1610: Merge read-surface tools: `pipeline_status_summary` → `pipeline_dashboard`, `get_project` → `health_check`

Two read pairs collapse into one tool each, with the narrower output
reachable via a parameter rather than a second registration. The GH-1552
`phase_completed` event on `pipeline_status_summary` is recent and must
survive the merge with its test coverage intact.

Acceptance: two tools where there were four, no lost output shape, every
call site and roster updated.

### Feature 3 — #1611: Merge write-path tools: `capture_snapshot` → `metrics_trends`, `archive_items` → `batch_update`

Snapshot capture folds into the trends read that always follows it;
`archive_items` folds into the other bulk mutation. The open-children
archive guard (GH-0870) must survive the fold with coverage, and a callable
capture path must remain for the scheduled snapshot that replaces
`caretake --mode trends` (deleted in #1603).

Acceptance: two tools where there were four, guard preserved, persistence
contract unchanged.

### Feature 4 — #1612: Resolve the fix-or-cut orphans: `sync_plan_graph` (uncallable) and `collate_debug` (unrostered)

`sync_plan_graph` is referenced in plan prose *and* warned about in
`plan-postcondition.sh`, yet is in no skill's roster — it cannot be called
at all today. `collate_debug` is unrostered and only registers under
`RALPH_DEBUG=true`, and its only consumer is deleted in #1603. Each gets a
decision, and prose + roster + hook are made to agree with it.

Acceptance: each orphan either callable-and-consistent or fully removed
including its prose and hook references; blocked on #1603.

### Feature 5 — #1613: Gate the four `sre__*` tools behind an env flag

`sre__scale`, `sre__rollout_restart`, `sre__delete_pod`, `sre__drain` serve
the Watcher surface, not the board surface. Gating mirrors the existing
`RALPH_DEBUG` pattern in `debug-tools.ts`. Because agent `tools:` lists are
hard runtime enforcement, `sre-fixit` fails loudly without the flag — that
is documented rather than papered over with a fallback.

Acceptance: default surface drops 4 tools, both flag states covered by
`tool-registration.test.ts`, new env var documented.

### Feature 6 — #1614: Add the prose-vs-roster CI cross-reference check and verify the ≤20 tool count

The closing child: a CI check covering both failure directions, the
asserted final tool count, updated tool tables, and release notes naming
every removed or renamed tool for downstream consumers.

Acceptance: CI fails on either direction (with tests proving it), tool
count ≤20 asserted in `tool-registration.test.ts`, full CI green.

## Integration Strategy

Every child touches `mcp-server/src/tools/**` plus the same doc rosters, so
they share one revert scope and ship as ONE PR (GH-1538 group planning);
the child estimates size phases of that plan. Because the diff lands under
`mcp-server/src/**`, the merge triggers `release.yml` — version bump, npm
publish with OIDC provenance, and the `ralph/.mcp.json` pin. That makes the
release-notes item in #1614 load-bearing rather than cosmetic.

Verification is uniform per phase: `npm test` in `mcp-server/`,
`scripts/check-doc-rosters.sh`, hook and script test suites, ShellCheck,
and a grep proving no prose reference to a removed tool name survives.

## Feature Sequencing

```
#1609 ──┬─> #1610 ──┬─> #1614
        ├─> #1611 ──┤
        └─> #1612 ──┤   (#1612 also blocked by #1603, sibling feature)
#1613 ──────────────┘
```

- #1609 first — the pure cuts shrink the surface the merges operate on.
- #1610, #1611, #1612 are parallel-safe after #1609 (disjoint tool modules).
- #1613 is independent of the cut/merge chain (separate module, separate
  registration path) but lands before the final count is asserted.
- #1614 last — it depends on every preceding child and asserts the count.

## What We're NOT Doing

- Extracting `sre__*` into a separate package. Gating is the reversible
  step; extraction is a later decision if the Watcher surface grows.
- Touching the three tools downstream repos depend on (`get_issue`,
  `create_issue`, `create_comment`).
- Removing composed workflow tools (`create_sub_issues`, `advance_issue`,
  `decompose_feature`) — the wave pushes logic *toward* them.
- Server-side state-machine enforcement — that is #1592, which builds on
  the surface this feature leaves behind.
