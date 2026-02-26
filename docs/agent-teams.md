# Agent Teams

Ralph Team uses Claude Code Agent Teams to process GitHub issues with parallel specialist workers.

## Architecture

One **team lead** coordinates three **worker** roles:

| Role | Agent | What they do |
|------|-------|-------------|
| Analyst | ralph-analyst | Triage, split, research, plan |
| Builder | ralph-builder | Review plans, implement code |
| Integrator | ralph-integrator | Validate, create PRs, merge |

The lead never does substantive work. It assesses the issue, creates the team, builds the task list, assigns work, and monitors progress.

## How the lead works

1. **Assess** — fetch the issue and detect its pipeline position. If no issue number is given, scan the project board for actionable work.
2. **Create team** — one team per session, named after the issue (e.g., `ralph-team-GH-42`).
3. **Spawn workers** — one per role needed. Spawn prompts include the issue number, title, current state, and what kinds of tasks the worker should look for.
4. **Build the task list** — create tasks for the current and upcoming pipeline phases. Enrich each task description with issue context (number, title, estimate, group membership, relevant artifact paths). Every task should have an owner assigned. Use task metadata to pass information between phases (e.g., research doc paths, plan doc paths, verdicts).
5. **Respond to events** — hooks fire on TaskCompleted and TeammateIdle. When a phase completes, create tasks for the next phase. When all work is done, shut down the team.

Tasks can be added to the shared task list at any time after team creation. The lead creates follow-up tasks as earlier phases complete, rather than predicting the entire pipeline upfront.

## How workers work

Workers are autonomous and follow a simple loop:

1. Check TaskList for unblocked tasks matching their role
2. Claim an unclaimed task (set yourself as owner, mark in-progress)
3. Invoke the appropriate skill once (e.g., ralph-research, ralph-impl)
4. Mark the task completed with results in the description and metadata
5. Check TaskList again for more work
6. If no work is available, wait briefly — upstream tasks may still be completing

Workers invoke skills directly. They do not nest skill calls inside Task() subagents.

A Stop hook on each worker forces one re-check of TaskList before allowing the worker to shut down, preventing premature exits when upstream work is about to unblock new tasks.

## Task list design

Tasks are the coordination mechanism. Assignment is communication — when the lead assigns a task to a worker, the worker discovers it via TaskList.

Each task includes:
- **Subject**: short action label (e.g., "Research GH-42")
- **Description**: enriched with issue URL, title, estimate, group context, artifact paths from prior phases
- **Owner**: which worker is responsible
- **Metadata**: structured data for inter-phase handoff (issue number, command name, artifact paths, verdicts)

Dependencies between tasks use `blockedBy` chains. Workers only see tasks whose dependencies are all resolved.

## Resumability

Resumability operates at the **workflow level**, not the session level. If a session crashes:

- GitHub Projects state is durable — issues retain their workflow state
- Skills are idempotent against GitHub state (researching an already-researched issue is a no-op)
- A new `/ralph-team` invocation detects pipeline position from GitHub and picks up where things left off
- Completed work (research docs, plans, commits) persists on disk and in GitHub

This sidesteps Claude Code's limitation that agent team sessions cannot be resumed. The state machine and GitHub are the source of truth, not the session.

## Hooks

| Hook | Where | Behavior |
|------|-------|----------|
| TaskCompleted | Lead | Guidance: log which task completed |
| TeammateIdle | Lead | Guidance: note that idle is normal |
| Stop (lead) | Lead | Blocks stop if processable GitHub issues exist |
| Stop (worker) | Workers | Blocks stop once, forcing a TaskList re-check |

All hooks use re-entry safety — if the hook already fired once and the agent still wants to stop, the second attempt is allowed through. This prevents infinite loops.

## Constraints

- One team per session. Clean up before starting another.
- Workers cannot spawn their own teams or teammates.
- Workers go idle between turns — this is normal, not an error.
- The lead should not implement, research, plan, or review anything itself.
- All tasks are created after TeamCreate.

## Relationship to ralph-hero

Ralph Hero is the **solo orchestrator** — it does the same pipeline work but as a single agent using subagents (Task tool) for parallelism. Ralph Team is the **multi-agent** version using Claude Code Agent Teams for richer coordination.

Both read from the same GitHub Projects state machine and invoke the same skills. The difference is execution model, not workflow.
