---
date: 2026-03-01
github_issue: 488
github_url: https://github.com/cdubiel08/ralph-hero/issues/488
status: complete
type: research
---

# Research: GH-488 — Spawn N Builders from Stream Detection with Stream-Scoped Task Assignment

## Problem Statement

`ralph-team` always spawns exactly one builder (line 48: "Spawn one worker per role needed"). Even when multiple independent work streams exist, a single builder processes them sequentially — eliminating the parallelism that stream detection was designed to enable.

This issue adds two coordinated behaviors to `ralph-team/SKILL.md`:
1. **Roster-based builder spawning**: when implementation tasks are ready, read `suggestedRoster.builder` from the stream detection result (added in GH-487) and spawn that many builders — each named `builder`, `builder-2`, `builder-3`
2. **Stream-scoped task assignment**: tag each implementation task with its stream ID and pre-assign it to the corresponding builder, preventing cross-stream task stealing

## Current State Analysis

### ralph-team Spawning (No Stream Awareness)

[`plugin/ralph-hero/skills/ralph-team/SKILL.md:46-50`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L46-L50):
```
Spawn one worker per role needed based on the suggested roster from pipeline detection.
```

The instruction is "one worker per role" — regardless of how many independent work streams exist. There is no concept of spawning multiple builders. After GH-487 fixes `suggestedRoster.builder` to return stream count (1–3), ralph-team still won't use it until this issue is implemented.

### Task Assignment (Role-Based, Not Stream-Scoped)

[`plugin/ralph-hero/skills/ralph-team/SKILL.md:52-56`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L52-L56):
```
Assign an owner to every task. Use task metadata to pass information between phases...
```

Task subjects today follow patterns like `"Implement #NNN: title"`. Workers self-assign by matching role keywords (`builder*` matches "Review or Implement" tasks). With multiple builders assigned to the same TaskList, they would compete to claim tasks — builder-2 could accidentally claim stream-1's task while builder is working on stream-2.

### `detect_stream_positions` Response (After GH-487)

After GH-487, the tool response will include a top-level `suggestedRoster`:
```json
{
  "streams": [...],
  "totalStreams": 2,
  "totalIssues": 4,
  "rationale": "...",
  "suggestedRoster": { "analyst": 0, "builder": 2, "integrator": 1 }
}
```

This is the single source of truth for how many builders to spawn at implementation time.

### Worker Stop Gate (Already Compatible)

[`plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh:27-29`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh#L27-L29):
```bash
case "$TEAMMATE" in
  analyst*)    KEYWORDS="Triage, Split, Research, or Plan" ;;
  builder*)    KEYWORDS="Review or Implement" ;;
  integrator*) KEYWORDS="Validate, Create PR, Merge, or Integrate" ;;
```

The `builder*` glob already matches `builder`, `builder-2`, `builder-3`. **No hook changes needed.**

### Agent Naming Convention

From [`thoughts/shared/plans/2026-02-24-ralph-team-3-station-simplification.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-24-ralph-team-3-station-simplification.md):
```
Max 2 per station (append -2 for the second). Example: analyst, analyst-2.
```

The issue extends this to 3 builders max: `builder`, `builder-2`, `builder-3`. The `-2`/`-3` numeric suffix is the established convention.

### Bootstrapping Problem: When to Spawn Extra Builders

Stream detection can only run after research completes (research documents contain the "Will Modify" file paths that drive overlap detection). This means stream count is not known at session start — it's only known when implementation tasks are being created.

Ralph-team already handles this via incremental task creation: "Add tasks incrementally as phases complete rather than predicting the entire pipeline upfront." The same lifecycle applies here:

1. Session start: initial roster from `detectPipelinePosition` → spawn 1 builder (initial heuristic)
2. Research phase completes: research docs available on disk
3. **Implementation phase transition**: call `detect_stream_positions` with "Will Modify" paths from research docs → get `suggestedRoster.builder` = N → spawn additional builders if N > 1
4. Create implementation tasks tagged with stream IDs, pre-assigned to specific builders

This is additive — no changes to session start behavior; the extra spawning happens during the research→implementation phase transition.

### Stream-Scoped Task Subject Pattern

For task ownership to work cleanly with multiple builders, task subjects need stream tags. The `thoughts/shared/plans/2026-02-22-GH-0328-stream-aware-dispatch-skill-md.md` plan documents a subject pattern:
```
"Plan stream-{stream_id} GH-{stream_primary}"
"Implement stream-{stream_id} GH-{issue_number}"
```

Applying this to implementation tasks:
- `"Implement GH-42 [stream-1]"` → owner: `builder`
- `"Implement GH-43 [stream-1]"` → owner: `builder` (blocked by GH-42 task)
- `"Implement GH-44 [stream-2]"` → owner: `builder-2`

The brackets make the stream tag visible in task subjects while keeping the worker-stop-gate keyword matching intact ("Implement" still triggers "Review or Implement" keywords).

### Stream Data Extraction from Research Documents

The "Will Modify" section is validated by the research postcondition hook and always present after research. The team lead can extract paths using a glob + regex pattern (already referenced in the GH-465 research):

```
For each research doc (glob thoughts/shared/research/*GH-NNN*):
  Extract backtick-wrapped paths under "### Will Modify"
  regex: `[^`]+`
```

Then pass to `ralph_hero__detect_stream_positions`:
```json
{
  "issues": [
    { "number": 42, "files": ["src/auth/middleware.ts"], "blockedBy": [] },
    { "number": 43, "files": ["src/auth/middleware.ts", "src/db/schema.ts"], "blockedBy": [42] }
  ],
  "issueStates": [...]
}
```

## Key Discoveries

### 1. Extra builders are spawned at implementation phase transition, not session start

Session-start roster is already correct (1 builder is appropriate before stream count is known). The team lead spawns additional builders when creating implementation tasks. This aligns with ralph-team's incremental model and avoids idle workers during research/planning phases.

### 2. Pre-assignment eliminates cross-stream task stealing

Stream-scoped task subjects (`[stream-N]` tag) + explicit `owner` assignment at creation time prevents the race condition. Workers still use self-claim mechanics for their own stream's tasks (sequential tasks within a stream should still be auto-discovered), but the initial assignment anchors each builder to its stream.

### 3. Spawn prompt must include assigned stream

Each builder's spawn prompt must specify its stream: `"Your stream covers issues #42, #43. Only claim tasks tagged [stream-1]."` This prevents a builder from accidentally claiming a task from a different stream if the task subject pattern changes.

### 4. Single-stream sessions are unchanged

When N=1 (one stream or all issues independent), `suggestedRoster.builder = 1`. No additional builders are spawned. Task subjects don't need stream tags (or can include `[stream-1]` for consistency). The existing `builder` worker handles all implementation.

### 5. GH-487 is a hard dependency

`ralph_hero__detect_stream_positions` must return `suggestedRoster` in its response for this issue to read it. GH-487 adds that field. Until GH-487 is implemented, `ralph-team` cannot read the builder count from the stream detection result — it would need to compute it inline. The implementation plan should list GH-487 as a `blockedBy` dependency.

### 6. No roster table exists in SKILL.md today

The issue requests adding an explicit roster table documenting naming convention and per-station caps. Currently the SKILL.md only says "Spawn one worker per role needed" with no table. A table at the "Create Team and Spawn Workers" section formalizes the `analyst`/`analyst-2`/`analyst-3`, `builder`/`builder-2`/`builder-3` naming.

## Potential Approaches

### Approach A: Incremental spawn at implementation phase transition (Recommended)

1. During research→implementation transition (when creating impl tasks): extract "Will Modify" paths from research docs, call `detect_stream_positions`, read `suggestedRoster.builder` = N
2. Spawn builders 2..N at that point (builder already exists from session start)
3. Create implementation tasks with `[stream-N]` subject tag and explicit owner assignment

**Pros**: No idle builders during research/plan phases; uses GH-487's top-level suggestedRoster directly; incremental spawning fits existing ralph-team model.
**Cons**: Team lead must track which builders exist vs. which need spawning; slightly more complex event handling.

### Approach B: Pre-spawn at session start using initial heuristic

Spawn max builders (up to 3) at session start based on issue count heuristic, keep idle until implementation tasks exist.

**Pros**: Simpler — spawning is co-located with other worker spawning.
**Cons**: Builders sit idle during research/plan phases; requires stream count estimate before research completes (inaccurate); wastes resources on sessions with only 1 stream.

**Verdict**: Approach A is correct. Matches the incremental model and avoids speculative spawning.

### Approach C: Stream detection at session start, deferred spawning via message

Call `detect_stream_positions` at session start (if research docs already exist), store stream count in team metadata, then spawn builders when implementation phase starts.

**Pros**: Stream count known early if previous research exists.
**Cons**: Research docs may not exist at session start; adds complexity for caching stream results.

## Risks and Considerations

1. **GH-487 dependency**: If GH-487 is not merged before #488 is implemented, the SKILL.md instructions must inline the builder count formula `Math.min(totalStreams, 3)` instead of reading `suggestedRoster.builder`. The plan should mark GH-487 as blockedBy.

2. **Task subject keyword compatibility**: Adding `[stream-1]` tag to task subjects must not break `worker-stop-gate.sh` matching. The gate checks for "Implement" keyword — the tag is appended after, so "Implement GH-42 [stream-1]" still matches. ✓

3. **3-builder cap**: The issue caps at 3 builders. If more than 3 independent streams exist, streams 4+ are assigned to the least-loaded builder. The SKILL.md should document this assignment logic.

4. **Sequential within-stream tasks**: Within a stream, implementation tasks are sequential (GH-465 stacked branch + blockedBy chain). Both tasks are assigned to the same builder, but builder-2 shouldn't skip ahead to claim the second task. Pre-assigning `owner` prevents this.

5. **Post-mortem worker table**: The report template in ralph-team SKILL.md (lines 94-97) shows a single `builder` row. With multiple builders, it should show `builder`, `builder-2`, etc. This is cosmetic but the template needs updating.

## Recommended Next Steps

1. **Mark GH-487 as blockedBy**: The implementation of #488 needs `suggestedRoster` in the `detect_stream_positions` response — ensure GH-487 is merged first or plan for inline formula fallback.

2. **Modify `ralph-team/SKILL.md` — "Create Team and Spawn Workers"**: Add roster table with station caps; document N-builder spawning pattern.

3. **Modify `ralph-team/SKILL.md` — "Build the Task List"**: Add stream detection step when creating implementation tasks; document `[stream-N]` task subject pattern and per-builder assignment.

4. **Modify `ralph-team/SKILL.md` — Post-mortem template**: Update worker summary table to handle multiple builders dynamically.

5. **Incremental spawn logic**: Document the research→implementation phase transition trigger for spawning additional builders.

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/ralph-team/SKILL.md` — Add roster table; N-builder spawning at implementation phase transition; stream detection step with research doc path extraction; `[stream-N]` task subject tagging; per-builder stream assignment; post-mortem template update for multiple builders

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts` — `SuggestedRoster` interface; `computeSuggestedRoster` builder count (GH-487 will change this)
- `plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh` — `builder*` glob compatibility verification (no changes needed)
- `plugin/ralph-hero/skills/ralph-hero/SKILL.md` — Reference implementation of stream detection Step 2.5
- `thoughts/shared/plans/2026-02-24-ralph-team-3-station-simplification.md` — Worker naming convention (`-2` suffix pattern)
- `thoughts/shared/research/2026-03-02-GH-0487-compute-suggested-roster-stream-scaling.md` — GH-487 dependency details
