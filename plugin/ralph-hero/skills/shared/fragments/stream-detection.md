<!-- Used by: team/SKILL.md, hero/SKILL.md -->
<!-- Captures the SHARED procedural core of stream detection. Consumer skills retain their own framing/intro prose above the include. -->

When creating implementation tasks for a group with 2+ issues:

1. **Extract "Will Modify" file paths** from each issue's research document:
   - Glob: `thoughts/shared/research/*GH-NNN*` for each issue
   - Parse backtick-wrapped paths under `### Will Modify` heading (regex: `` `[^`]+` ``)

2. **Detect stream positions** with file paths and blockedBy relationships — pass issues array (each with number, files, blockedBy) and issueStates to the detect_stream_positions tool.

3. **Read `suggestedRoster.builder`** from the response (1–3, capped at stream count).

4. **Spawn additional builders** if needed:
   - If `suggestedRoster.builder` > 1 and only 1 builder exists: spawn `builder-2` (and `builder-3` if needed)
   - Each new builder's spawn prompt: `"You are builder-N on team {team-name}. Your stream covers issues #A, #B. Only claim tasks tagged [stream-N]. Check TaskList for unblocked implementation tasks matching your stream."`

5. **Create implementation tasks with stream tags**:
   - Task subject: `"Implement GH-NNN: title [stream-N]"`
   - Task owner: assigned to the builder for that stream (`builder` → stream-1, `builder-2` → stream-2, `builder-3` → stream-3)
   - Within a stream: sequential `blockedBy` chain (second task blocked by first)
   - Across streams: no `blockedBy` (parallel execution)
   - Task description must include `base_branch` if stacked branches apply: set `base_branch` to the predecessor's branch name (e.g., `feature/GH-42`). This tells the builder to create its worktree stacked on the predecessor branch instead of main. Issues in independent streams or standalone issues should not have `base_branch` set.

6. **Single-stream fallback**: If `totalStreams == 1` or only 1 issue, skip stream tagging. Create implementation tasks as today — the existing single builder handles them sequentially.

7. **Overflow assignment** (4+ streams with 3 builders): Assign stream-4 tasks to the least-loaded builder (fewest assigned tasks). Document the assignment in the task description.

### Stream Detection Timing

Stream detection requires research documents (for file paths). If issues haven't been researched yet (pre-research states), the implementation task subjects and stream tags cannot be determined at initial graph creation time.

**Strategy**: Create placeholder implementation tasks without stream tags. When the last research task for the group completes, the team lead calls `detect_stream_positions`, updates implementation task subjects with stream tags, spawns additional builders if needed, and reassigns owners. This is the ONE exception to "no team lead intervention between phases" — stream detection is a graph refinement step, not a new task creation step.

### Stream Detection Refinement

When research tasks complete for a group with 2+ issues, refine the task graph:

1. Call `detect_stream_positions` with file paths from research documents
2. Update implementation task subjects with `[stream-N]` tags
3. Spawn additional builders if `suggestedRoster.builder` > current builder count
4. Reassign implementation task owners to stream-specific builders
