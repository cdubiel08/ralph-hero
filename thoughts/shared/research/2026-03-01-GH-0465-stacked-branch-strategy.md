---
date: 2026-03-01
github_issue: 465
github_url: https://github.com/cdubiel08/ralph-hero/issues/465
status: complete
type: research
---

# Research: GH-465 — Stacked Branch Strategy for Parallel Implementations

## Problem Statement

When `ralph-team` implements multiple sub-issues in parallel, all branches are created from `origin/main`. If those issues touch overlapping files, merge conflicts are inevitable — the PRs that merge first change the baseline that later PRs were based on. The GH-451 session documented this exactly: phases 2–4 were branched from main and implemented in parallel; when #453 and #454 merged first, PR #461 (#455) had conflicts requiring a manual rebase in 5 files.

The proposal is to detect overlapping file sets from research documents and choose the branching strategy automatically:
- **Independent files** → parallel branches from main (current behavior, no change)
- **Overlapping files** → stacked branches, where each branch is based on the previous one in the dependency chain

## Current State Analysis

### How Branches Are Created Today

`scripts/create-worktree.sh` ([`scripts/create-worktree.sh:33-58`](https://github.com/cdubiel08/ralph-hero/blob/main/scripts/create-worktree.sh#L33-L58)) hardcodes `BASE_BRANCH="origin/main"` as the worktree base. There is no parameter to specify a different parent branch. Every worktree created by `ralph-impl` branches from main.

`ralph-impl` calls the script at Step 6.3 ([`skills/ralph-impl/SKILL.md:184`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-impl/SKILL.md#L184)):
```bash
"$GIT_ROOT/scripts/create-worktree.sh" "$WORKTREE_ID"
```
No base branch is passed.

### File Overlap Detection Already Exists

`plugin/ralph-hero/mcp-server/src/lib/work-stream-detection.ts` implements a Union-Find algorithm that clusters issues into "work streams" based on:
1. Shared "Will Modify" file paths from research documents
2. `blockedBy` dependency relationships

The `ralph_hero__detect_stream_positions` MCP tool (registered in `dashboard-tools.ts`) exposes this to skills. It accepts `issues[]` (each with `files[]` and `blockedBy[]`) and returns stream clusters with shared file lists.

**The `ralph-hero` orchestrator already uses this** at Step 2.5 of `ralph-hero/SKILL.md`: after all research completes for groups with 3+ issues, it calls `detect_stream_positions`, then restructures the task graph so issues within the same stream form sequential `blockedBy` chains while independent streams remain parallel.

**`ralph-team` does not use this at all.** The team coordinator assigns tasks by pipeline state without any awareness of file overlap between concurrently running builder workers.

### The GH-451 Incident

From the session post-mortem ([`thoughts/shared/reports/2026-02-27-ralph-team-GH-451.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/reports/2026-02-27-ralph-team-GH-451.md)):

- Issues #453, #454, #455 were implemented in parallel background agents, all branched from `main`
- #453 (Phase 2: remove 5 mutation tools) and #454 (Phase 3: collapse read tools) merged first
- PR #461 (#455, Phase 4: remove admin tools + merge advance_issue) conflicted in 5 files
- The parent consolidation plan ([`thoughts/shared/plans/2026-02-27-mcp-toolspace-consolidation.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-27-mcp-toolspace-consolidation.md)) noted: "all phases touch the same tool files"
- Resolution required the builder to rebase PR #461, manually resolve deletion conflicts, and verify 708 tests passed

The plan for #455 ([`thoughts/shared/plans/2026-02-27-GH-0455-remove-admin-tools-merge-advance.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-27-GH-0455-remove-admin-tools-merge-advance.md)) even noted the risk: "Order of removal matters for merge conflicts: Since Phases 1-4 may be implemented in parallel branches, each phase should only remove the tools assigned to it." The knowledge was there — the tooling to act on it wasn't.

### What `detect_stream_positions` Needs

The tool requires callers to supply file paths per issue. These come from the "Will Modify" section of research documents (the required `## Files Affected → ### Will Modify` section). The research postcondition hook validates this section exists on every research document. So the data is always available after the research phase completes.

The `ralph-team` lead can extract "Will Modify" paths from research documents (glob `thoughts/shared/research/*GH-NNN*`, parse backtick-wrapped paths under `### Will Modify`) before creating builder tasks.

### Stacked Branch Mechanics (External Best Practices)

From external research on ghstack, Graphite CLI, git-stack, and `git rebase --update-refs`:

**Stack structure:**
```
main
 └── feature/GH-455-A    (based on main)
      └── feature/GH-455-B   (based on A, stacked)
           └── feature/GH-455-C   (based on B, stacked)
```

Each PR targets the previous branch as its base. When A merges to main, B is rebased onto main before creating its PR.

**Key decision criterion:**
```
FILE_OVERLAP = git diff --name-only main...feature/A
               ∩
               predicted files for feature/B

If FILE_OVERLAP is non-empty → stack B on A
If FILE_OVERLAP is empty    → parallel branches from main
```

**Agent-compatible approach (no external tooling needed):**
- Record `parent_branch` per task in task metadata when creating builder tasks
- Pass `parent_branch` to `create-worktree.sh` as an optional 3rd argument
- Script creates the worktree from `parent_branch` instead of `origin/main`
- When the parent PR merges, rebase child branch onto main before creating its PR

**Tradeoff: parallelism preserved within review cycles**
The issue correctly notes: "the builder can still work on implementation while the previous branch is being reviewed/merged." This is the key insight — stacking doesn't block concurrent work, it just changes what each branch is based on:
- Builder implements A (base: main)
- Builder implements B (base: A's branch) — concurrently while A is in review
- When A merges, integrator rebases B onto main before creating B's PR
- B's implementation already has A's changes in context, so the rebase is clean

## Key Discoveries

### 1. The gap is entirely in `ralph-team`, not in infrastructure

The file overlap algorithm (`work-stream-detection.ts`) is already correct and tested. The MCP tool (`detect_stream_positions`) is already registered. The only gap is that `ralph-team` doesn't call it. Adding a pre-implementation stream detection step to `ralph-team/SKILL.md` provides the detection logic.

### 2. `create-worktree.sh` needs a base branch parameter

The script hardcodes `origin/main` as the base. Adding an optional `BASE_BRANCH_OVERRIDE` as a 3rd positional argument is the minimal change needed. `ralph-impl` would read `base_branch` from task metadata (set by the team lead) and pass it to the script.

### 3. File paths are always available after research

The `## Files Affected → ### Will Modify` section is validated by the research postcondition hook. Every research document has it. The team lead can reliably parse these paths using a simple regex on backtick-wrapped paths (`\`[^`]+\``).

### 4. The detection is pre-implementation, not runtime

Unlike runtime conflict guards (which would need to watch for concurrent writes), this strategy works at **task creation time**: before any builder starts, the team lead checks overlap and structures the blockedBy chain appropriately. This is strictly additive — no new hooks, no runtime monitoring, no filesystem watching.

### 5. Rebase-on-merge is the only new integrator step

When the integrator merges an upstream branch in a stack, it must rebase the next branch onto main before creating that PR. This is one extra `git rebase main` + `git push --force-with-lease` step. The integrator agent definitions already allow git operations.

### 6. Independent streams are unaffected

Issues with no file overlap continue to branch from main and implement in parallel. The change only affects overlapping issues.

## Potential Approaches

### Approach A: Team lead stream detection + stacked worktree creation (Recommended)

**Two-part change:**

**Part 1 — `ralph-team/SKILL.md` stream detection step** (before creating builder tasks):
1. After research phase tasks complete, read all research documents for the group
2. Extract "Will Modify" paths per issue (regex: `` `[^`]+` `` under `### Will Modify`)
3. Call `ralph_hero__detect_stream_positions` with file paths + blockedBy relationships
4. For issues in the same stream: create sequential `blockedBy` chain; add `base_branch: "feature/GH-NNN-predecessor"` to task metadata
5. For independent streams: no change — create parallel tasks from main

**Part 2 — `create-worktree.sh` base branch parameter**:
```bash
# New: optional 3rd argument BASE_BRANCH_OVERRIDE
BASE_BRANCH_OVERRIDE="${3:-}"
if [[ -n "$BASE_BRANCH_OVERRIDE" ]]; then
  BASE_BRANCH="$BASE_BRANCH_OVERRIDE"
fi
```

`ralph-impl` reads `base_branch` from task description/metadata and passes it: `create-worktree.sh "$WORKTREE_ID" "$BRANCH_NAME" "$BASE_BRANCH"`.

**Part 3 — Integrator rebase step**:
When merging a PR that has downstream stacked branches, the integrator runs:
```bash
git checkout feature/GH-NNN-child
git fetch origin main
git rebase origin/main
git push --force-with-lease
```
Then creates the child PR targeting main (not the now-merged parent branch).

**Pros**: Fully automated, no manual intervention, uses existing `detect_stream_positions` infrastructure, preserves parallelism for independent issues.
**Cons**: Adds complexity to `ralph-team` coordination; integrator must know about downstream stacks to trigger rebase.

### Approach B: Prompt-level only — sequential blockedBy within streams

**Description**: Skip the stacked branch mechanics entirely. Just use `detect_stream_positions` to create sequential `blockedBy` chains in `ralph-team` for overlapping issues. All branches still base from main, but they implement sequentially so only the first PR has a clean base.

**Simplified rebase step**: When implementing the second issue in a stream, run `git rebase origin/main` in the worktree before implementation to pick up the previously merged changes.

**Pros**: No changes to `create-worktree.sh` or `ralph-impl`. Only `ralph-team/SKILL.md` changes.
**Cons**: Sequential implementation with main-based branches still has a conflict window — if A merged while B's worktree was being set up, B needs to rebase anyway. The stacked approach avoids this by capturing A's changes at worktree creation time.

### Approach C: Pre-detect in team lead on session start, annotate task metadata

**Description**: Same as Approach A but the stream detection happens earlier — during the "assess" phase of `ralph-team` before tasks are created, using the existing research documents if available. The base branch for each stream member is computed once and stored in task metadata from the start, so builders always have the right base branch at implementation time without the team lead needing to re-detect mid-session.

**Pros**: Cleaner — base branch is known at task creation, no mid-session coordination.
**Cons**: Requires research to be complete before any builder tasks are created (adds latency for large groups).

## Risks and Considerations

1. **Force-push safety**: Stacked branches require `--force-with-lease` after rebase. The integrator must never use bare `--force`. The `impl-branch-gate.sh` hook may need to be updated to allow `--force-with-lease` on feature branches.

2. **PR base branch drift**: GitHub PRs targeting a feature branch (not main) will show inflated diffs. After rebasing and pushing the child branch, the integrator must update the PR base to `main` if GitHub doesn't auto-detect the rebase. The `gh pr edit --base main` command handles this.

3. **Cascade cost if parent changes**: If the parent PR receives review feedback and commits are added, the child branch must be rebased again. With 3+ stacked issues, this cascades. The integrator needs to track the full stack order.

4. **`detect_stream_positions` requires file paths**: The team lead must successfully parse "Will Modify" paths from research documents. If a research document is malformed or paths are unreadable, the detection degrades gracefully to treating all issues as independent (parallel from main).

5. **Integration with dynamic scaling (#464)**: If worker count is dynamically scaled, the stream detection results should be computed once and shared — not recomputed per worker spawn. This aligns with computing it once during "assess" phase (Approach C).

## Recommended Next Steps

1. **Implement Approach A + B hybrid**: Add sequential `blockedBy` chains to `ralph-team` via stream detection (Approach B core) AND add the optional base branch parameter to `create-worktree.sh` (Approach A part 2). The stacked worktree creation is optional — builders can create from main and rebase at the start of implementation, which avoids the integrator cascade complexity.

2. **Simplest working implementation**: The minimal change is adding stream detection to `ralph-team/SKILL.md` ("Build the Task List" section) so overlapping issues get sequential task assignments. Even without stacked branches, sequential implementation from main + `git rebase origin/main` before starting each issue eliminates the conflict class observed in GH-451.

3. **Defer full stacked PR mechanics**: The PR base branch update and cascade rebase logic is additional complexity. Start with sequential task ordering and evaluate whether stacked PR bases are needed after observing conflict frequency.

4. **Scope assessment**: The full Approach A (stream detection + stacked worktrees + integrator cascade) is an M estimate. The minimal Approach B (sequential task ordering via stream detection in ralph-team only) is an XS–S estimate. Consider splitting as: (a) stream detection in ralph-team [XS], (b) stacked worktree creation [S], (c) integrator cascade rebase [S].

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/ralph-team/SKILL.md` — Add stream detection step in "Build the Task List" phase; use file paths from research docs to call `detect_stream_positions`; assign sequential `blockedBy` within streams; store `base_branch` in task metadata for stacked issues
- `scripts/create-worktree.sh` — Add optional 3rd positional arg `BASE_BRANCH_OVERRIDE` to allow creating worktree from a feature branch instead of `origin/main`
- `plugin/ralph-hero/skills/ralph-impl/SKILL.md` — Read `base_branch` from task metadata at Step 6.3; pass to `create-worktree.sh`; add `git rebase origin/main` step when starting implementation of a stream-sequential issue
- `plugin/ralph-hero/agents/ralph-integrator.md` — Add guidance for cascade rebase when merging stacked branches (rebase child onto main, update PR base, push with `--force-with-lease`)

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/lib/work-stream-detection.ts` — Existing Union-Find algorithm (no changes needed)
- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` — `detect_stream_positions` tool registration (no changes needed)
- `plugin/ralph-hero/skills/ralph-hero/SKILL.md` — Reference implementation of stream detection (Step 2.5) to follow the same pattern in ralph-team
- `thoughts/shared/reports/2026-02-27-ralph-team-GH-451.md` — GH-451 post-mortem documenting the conflict pattern
- `thoughts/shared/plans/2026-02-27-mcp-toolspace-consolidation.md` — Parent plan that caused overlapping files across phases
