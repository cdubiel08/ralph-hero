---
date: 2026-02-17
github_issue: 50
github_url: https://github.com/cdubiel08/ralph-hero/issues/50
status: complete
type: research
---

# Update ralph-hero Orchestrator and Scripts for Worker-Based Architecture - Research Findings

## Problem Statement

Issue #50 requires updating the ralph-hero solo orchestrator (`skills/ralph-hero/SKILL.md`) and shell scripts (`scripts/ralph-loop.sh`, `scripts/ralph-team-loop.sh`) to align with the 4-worker model (Analyst, Builder, Validator, Integrator) defined in the epic #40. Currently, ralph-hero dispatches to 5 individual skills (split, research, plan, review, impl). The update should group these dispatches by worker scope boundaries while preserving backward compatibility with existing skills.

## Scope Boundary: #50 vs #49

- **#49**: Updates `ralph-team` (multi-agent orchestrator) -- spawn templates, Section 4/6, conventions
- **#50**: Updates `ralph-hero` (solo orchestrator) -- phase dispatching, shell scripts

The two issues share the foundation research (#44) but are independent implementations. #50 does NOT modify agent definitions, spawn templates, or the conventions doc (those are #49's scope).

## Current State Analysis

### ralph-hero SKILL.md - Current Phase Structure

From `plugin/ralph-hero/skills/ralph-hero/SKILL.md`:

```
State Machine Phases:
  ANALYZE ROOT -> EXPANDING (split M/L/XL issues)
  RESEARCHING (parallel background Tasks)
  PLANNING
  REVIEWING (if RALPH_REVIEW_MODE != "skip")
  HUMAN GATE (if review skipped)
  IMPLEMENTING (sequential, respecting dependency order)
  COMPLETE
```

Current dispatch pattern per phase:

| Phase | Skill Invoked | Task() Pattern | Notes |
|-------|--------------|----------------|-------|
| EXPANDING | `ralph-split` | Background, parallel per M/L/XL issue | Loops until no M/L/XL remain |
| RESEARCHING | `ralph-research` | Background, parallel per issue | All research tasks spawned in single message |
| PLANNING | `ralph-plan` | Foreground, per group | Groups detected; single-issue or multi-issue |
| REVIEWING | `ralph-review` | Background, parallel per group | Optional (RALPH_REVIEW_MODE) |
| HUMAN GATE | (none) | (pauses) | Reports and STOPs |
| IMPLEMENTING | `ralph-impl` | Foreground, sequential per issue | Respects dependency order |

### detect_pipeline_position Tool

From `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts`, the tool returns these phases:

| Pipeline Phase | Current Mapping | Proposed Worker |
|---------------|----------------|-----------------|
| SPLIT | EXPANDING | Analyst |
| TRIAGE | EXPANDING (pre-split) | Analyst |
| RESEARCH | RESEARCHING | Analyst |
| PLAN | PLANNING | Builder |
| REVIEW | REVIEWING | Builder (self-review) or Validator (interactive) |
| IMPLEMENT | IMPLEMENTING | Builder |
| COMPLETE | PR creation | Integrator |
| HUMAN_GATE | Plan in Review pause | Pause (human) |
| TERMINAL | Done | (none) |

### ralph-loop.sh - Current Phase Loop

From `plugin/ralph-hero/scripts/ralph-loop.sh`:

```bash
# Sequential phase execution per iteration:
1. Triage phase:    /ralph-triage
2. Split phase:     /ralph-split (if SPLIT_MODE != "skip")
3. Research phase:  /ralph-research
4. Planning phase:  /ralph-plan
5. Review phase:    /ralph-review (if REVIEW_MODE != "skip")
6. Implementation:  /ralph-impl
```

Repeats up to MAX_ITERATIONS (default 10), TIMEOUT per task (default 15m).

### ralph-team-loop.sh - Simple Wrapper

From `plugin/ralph-hero/scripts/ralph-team-loop.sh`:

Just a `timeout ... claude -p "/ralph-team [ISSUE]" --dangerously-skip-permissions` wrapper. Minimal script -- only comments reference the 5-agent model.

## Proposed Changes

### 1. ralph-hero SKILL.md Phase Restructuring

The state machine diagram should be updated to use worker-scoped phases:

**Current:**
```
ANALYZE ROOT -> EXPANDING -> RESEARCHING -> PLANNING -> REVIEWING -> HUMAN GATE -> IMPLEMENTING -> COMPLETE
```

**Proposed:**
```
ANALYZE ROOT -> ANALYST PHASE -> BUILDER PHASE -> VALIDATOR PHASE (optional) -> INTEGRATOR PHASE -> COMPLETE
```

Where each worker phase maps to the `detect_pipeline_position` results:

| Worker Phase | Pipeline Phases Handled | Skills Invoked | Parallelism |
|-------------|------------------------|---------------|-------------|
| ANALYST | SPLIT, TRIAGE, RESEARCH | ralph-split, ralph-triage, ralph-research | Parallel per issue |
| BUILDER | PLAN, REVIEW (auto), IMPLEMENT | ralph-plan, ralph-review, ralph-impl | Plan: per group; Impl: sequential |
| VALIDATOR | REVIEW (interactive only) | ralph-review | Per group |
| INTEGRATOR | COMPLETE | (PR merge, git ops) | Sequential |

### Specific SKILL.md Changes

**Step 1 (Detect Pipeline Position)**: No change -- `detect_pipeline_position` already returns the correct phase. The mapping is just presentation.

**Phase sections to update**:

1. **Rename "EXPANDING" to "ANALYST: SPLIT"**
   - Same logic: spawn background `ralph-split` tasks for M/L/XL issues
   - Loop until no M/L/XL remain (same as today)
   - Re-call `detect_pipeline_position` after each round

2. **Rename "RESEARCHING" to "ANALYST: RESEARCH"**
   - Same logic: spawn all research tasks in parallel
   - Wait for completion, re-check pipeline position

3. **Rename "PLANNING" to "BUILDER: PLAN"**
   - Same logic: invoke `ralph-plan` per group
   - After planning, check `RALPH_REVIEW_MODE`

4. **Rename "REVIEWING" to "BUILDER: REVIEW" (when auto) or "VALIDATOR: REVIEW" (when interactive)**
   - Same logic: spawn review tasks per group
   - Route based on `RALPH_REVIEW_MODE`

5. **Rename "IMPLEMENTING" to "BUILDER: IMPLEMENT"**
   - Same logic: sequential implementation respecting dependency order
   - Each invocation does one phase

6. **Add new section "INTEGRATOR: MERGE" after IMPLEMENTING**
   - Currently, ralph-hero leaves issues at "In Review" (TERMINAL state)
   - New: optionally invoke merge logic if `RALPH_AUTO_MERGE=true`
   - Default: report and STOP (same as today's COMPLETE phase)

**State machine diagram update:**

```
+-------------------------------------------------------------------+
|                     RALPH HERO STATE MACHINE                       |
+-------------------------------------------------------------------+
|  START                                                             |
|    |                                                               |
|    v                                                               |
|  DETECT PIPELINE POSITION                                          |
|    |                                                               |
|    v                                                               |
|  ANALYST PHASE                                                     |
|    |- SPLIT (if M/L/XL) -- loop until all XS/S                    |
|    |- RESEARCH (parallel) -- all "Research Needed" leaves          |
|    | all "Ready for Plan"                                          |
|    v                                                               |
|  BUILDER PHASE                                                     |
|    |- PLAN (per group) -- create implementation plans              |
|    |- REVIEW (if RALPH_REVIEW_MODE == "auto")                      |
|    |   | APPROVED -> continue                                      |
|    |   | NEEDS_ITERATION -> re-plan (loop)                         |
|    |- IMPLEMENT (sequential) -- execute plan phases                |
|    | all "In Review"                                               |
|    v                                                               |
|  VALIDATOR PHASE (if RALPH_REVIEW_MODE == "interactive")           |
|    |- HUMAN GATE: report and STOP                                  |
|    | (human approves, re-run continues)                            |
|    v                                                               |
|  INTEGRATOR PHASE                                                  |
|    |- Report PR URLs and "In Review" status                        |
|    |- (future: auto-merge if RALPH_AUTO_MERGE=true)                |
|    v                                                               |
|  COMPLETE                                                          |
+-------------------------------------------------------------------+
```

### 2. ralph-loop.sh Phase Restructuring

**Current** (6 sequential phases per iteration):
```bash
triage -> split -> research -> plan -> review -> impl
```

**Proposed** (4 worker phases per iteration):
```bash
analyst -> builder -> validator -> integrator
```

Where each phase invokes the appropriate skills:

```bash
# Analyst phase (replaces triage + split + research)
if [ "$MODE" = "all" ] || [ "$MODE" = "--analyst-only" ]; then
    echo "--- Analyst Phase ---"
    run_claude "/ralph-triage" "triage"
    if [ "$SPLIT_MODE" != "skip" ]; then
        run_claude "/ralph-split" "split"
    fi
    run_claude "/ralph-research" "research"
fi

# Builder phase (replaces plan + review(auto) + impl)
if [ "$MODE" = "all" ] || [ "$MODE" = "--builder-only" ]; then
    echo "--- Builder Phase ---"
    run_claude "/ralph-plan" "plan"
    if [ "$REVIEW_MODE" = "auto" ]; then
        run_claude "/ralph-review" "review"
    fi
    run_claude "/ralph-impl" "implement"
fi

# Validator phase (interactive review only)
if [ "$MODE" = "all" ] || [ "$MODE" = "--validator-only" ]; then
    if [ "$REVIEW_MODE" = "interactive" ]; then
        echo "--- Validator Phase ---"
        run_claude "/ralph-review" "review"
    fi
fi

# Integrator phase (future: auto-merge)
if [ "$MODE" = "all" ] || [ "$MODE" = "--integrator-only" ]; then
    echo "--- Integrator Phase (report only) ---"
    # Future: run_claude "/ralph-integrate" "integrate"
fi
```

**Backward compatibility**: Keep existing `--triage-only`, `--research-only`, etc. flags working alongside new `--analyst-only`, `--builder-only` flags. Old flags become aliases.

**New CLI arguments:**
- `--analyst-only` (replaces `--triage-only` + `--split-only` + `--research-only`)
- `--builder-only` (replaces `--plan-only` + `--review-only` + `--impl-only`)
- `--validator-only` (new, only interactive review)
- `--integrator-only` (new, future merge)

### 3. ralph-team-loop.sh Updates

Minimal changes needed -- just update comments:

```bash
# BEFORE:
# Launches the team coordinator skill which spawns specialized agents
# for each pipeline phase (triage, research, plan, review, implement).

# AFTER:
# Launches the team coordinator skill which spawns specialized workers
# for each pipeline phase (analyst, builder, validator, integrator).
```

The script body stays the same (it just calls `/ralph-team`).

## Key Design Decisions

### 1. Skill Invocations Stay the Same

The ralph-hero orchestrator still invokes the same skills (`ralph-split`, `ralph-research`, `ralph-plan`, `ralph-review`, `ralph-impl`). The worker-based grouping is a conceptual/structural change, not a functional one. Skills are not modified.

### 2. Pipeline Detection Tool Alignment

`detect_pipeline_position` returns phases (SPLIT, TRIAGE, RESEARCH, PLAN, REVIEW, IMPLEMENT, COMPLETE, HUMAN_GATE, TERMINAL). The ralph-hero SKILL.md currently maps these 1:1. With the update:

| detect_pipeline_position | ralph-hero Worker Phase | Action |
|-------------------------|------------------------|--------|
| SPLIT | ANALYST | Invoke ralph-split |
| TRIAGE | ANALYST | Invoke ralph-triage |
| RESEARCH | ANALYST | Invoke ralph-research |
| PLAN | BUILDER | Invoke ralph-plan |
| REVIEW | BUILDER (auto) or VALIDATOR (interactive) | Invoke ralph-review |
| IMPLEMENT | BUILDER | Invoke ralph-impl |
| COMPLETE | INTEGRATOR | Report / future merge |
| HUMAN_GATE | (pause) | Report and STOP |
| TERMINAL | (done) | Report completion |

No changes to the MCP tool itself. The mapping is in the SKILL.md prose only.

### 3. No New Environment Variables

The existing `RALPH_REVIEW_MODE` and `RALPH_SPLIT_MODE` continue to work. No new env vars needed for #50 (a future `RALPH_AUTO_MERGE` for Integrator is out of scope).

### 4. Solo vs Team Consistency

After both #49 and #50 are implemented:
- `ralph-hero` (solo): Invokes skills directly via Task(), grouped by worker phase
- `ralph-team` (multi-agent): Spawns worker agents that invoke skills via Skill()

Both use the same 4-worker mental model, same skill set, same state machine.

## Impact Assessment

### Files Modified

| File | Change Type | Scope |
|------|------------|-------|
| `plugin/ralph-hero/skills/ralph-hero/SKILL.md` | Restructure | Phase sections renamed, state machine diagram updated, phase-to-worker mapping added |
| `plugin/ralph-hero/scripts/ralph-loop.sh` | Restructure | Phase grouping by worker, new CLI flags, backward compat aliases |
| `plugin/ralph-hero/scripts/ralph-team-loop.sh` | Cosmetic | Comment updates only |

### Files NOT Modified (explicit exclusions per issue scope)

- Agent definitions (agents/*.md) -- #45-#48
- Spawn templates (templates/spawn/*.md) -- #49
- Shared conventions (skills/shared/conventions.md) -- #49
- MCP server (mcp-server/src/) -- no changes needed
- State machine JSON (hooks/scripts/ralph-state-machine.json) -- no changes
- Hook scripts (hooks/scripts/*.sh) -- no changes

### Backward Compatibility

- Old CLI flags (`--triage-only`, `--plan-only`, etc.) continue to work
- Skill invocations unchanged
- `detect_pipeline_position` phases unchanged
- Environment variables unchanged
- Hook behavior unchanged

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Breaking ralph-loop.sh with restructure | Medium | Keep old flags as aliases; test both old and new patterns |
| Divergence between solo and team orchestrator terminology | Low | Both issues (#49, #50) reference same foundation (#44) |
| Confusion during transition (old docs reference 5 agents) | Low | README update can be part of cleanup issue #51 |
| ralph-hero SKILL.md becomes too long | Low | Worker grouping actually reduces repetition (shared patterns documented once) |

## Recommended Implementation Approach

1. **Update ralph-hero SKILL.md**:
   - Update state machine diagram to worker-based phases
   - Add worker phase mapping table after Step 1 (detect pipeline position)
   - Rename phase section headers (EXPANDING -> ANALYST: SPLIT, etc.)
   - Add INTEGRATOR section (report-only for now)
   - Preserve all existing logic within each phase

2. **Update ralph-loop.sh**:
   - Group existing phases under worker headings
   - Add new `--analyst-only`, `--builder-only`, `--validator-only`, `--integrator-only` flags
   - Keep old flags working as aliases
   - Update header/footer messaging

3. **Update ralph-team-loop.sh**:
   - Update comments only (5 lines max)

## References

- Foundation research: `thoughts/shared/research/2026-02-17-GH-0044-worker-scope-boundaries.md`
- Parent epic: #40
- Sibling issue: #49 (ralph-team orchestrator updates)
- Current ralph-hero: `plugin/ralph-hero/skills/ralph-hero/SKILL.md`
- Current scripts: `plugin/ralph-hero/scripts/ralph-loop.sh`, `ralph-team-loop.sh`
- Pipeline detection: `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts`
- detect_pipeline_position tool: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1472`
