# Phase execution

How `--mode auto` runs one phase of a plan. Default mode invokes a leaner form (no sub-agent dispatch) — most of this reference is auto-mode specific.

A phase is the atomic unit of implementation. It executes on one of two first-class paths, selected by whether the phase carries a `### Tasks` section:

- **Direct** (no `### Tasks` — the common case): implement the phase inline. See §Direct execution.
- **Task-graph** (`### Tasks` present): the plan opted this phase into parallel sub-agent dispatch. See §Task graph.

Check for the section, pick the path, and execute. Do not narrate the choice or characterize the plan's format — the absence of `### Tasks` is a normal plan shape, not a defect.

## §Direct execution

1. Read the phase's "Changes Required" section and implement the changes inline (no sub-agent dispatch).
2. Run the phase's automated verification.
3. Stage + commit + push per [plan-compliance.md §Staging Algorithm](plan-compliance.md).
4. Skip §Controller pattern and §Phase quality review — there's no task graph to review against.

## §Task graph

The phase's `### Tasks` section contains one or more `#### Task N.M:` blocks. Each task has:

- `files: <space-separated paths>` — exact ownership for the task.
- `tdd: true | false` — whether the implementer must write tests first.
- `complexity: low | medium | high` — selects the sub-agent model (haiku / sonnet / opus).
- `depends_on: null | [N.M, N.M, ...]` — within-phase ordering.
- `acceptance: <verification command>` — how to confirm the task is done.

Parse the section, build the dependency graph, identify **parallel groups**: tasks whose `depends_on` is null/empty AND whose `files` lists don't overlap with any other unfinished task. Dispatch parallel groups in a single turn with multiple `Agent()` calls.

Cross-phase task dependencies are informational here — the orchestrator (hero) handles cross-phase ordering by only dispatching `/ralph:impl --mode auto` once blocking phases are complete.

Set `RALPH_TASK_FILES` to the space-separated union of all task `files` for the current phase. `drift-tracker.sh` reads this to decide whether a Write/Edit is in-ownership or drift.

## §Controller pattern

For each task group:

1. **Build context packet** from `implementer-prompt.md` (sibling file in this skill bundle). Substitute `{{TASK_DEFINITION}}`, `{{SHARED_CONSTRAINTS}}`, `{{DRIFT_LOG}}`, `{{IF_TDD_TRUE/FALSE}}`.
2. **Dispatch implementer sub-agent**: `Agent(subagent_type="general-purpose", model=<from complexity>, prompt=rendered, description="Implement task N.M")`. Parallel tasks: one `Agent()` per parallel slot in a single turn.
3. **Handle status**:
   - `DONE` → proceed to reviewer (Step 4).
   - `DONE_WITH_CONCERNS` → evaluate concerns, then reviewer.
   - `NEEDS_CONTEXT` → provide context, re-dispatch (within retry budget).
   - `BLOCKED` → assess drift category (minor adapt+log; major pause+escalate; weak-model tier-escalate per §IMPL BLOCKED).
4. **Dispatch reviewer sub-agent** using the sibling `task-reviewer-prompt.md`. Substitute `{{TASK_DEFINITION}}`, `{{IMPLEMENTER_REPORT}}`, `{{SHARED_CONSTRAINTS}}`, `{{IF_TDD_TRUE/FALSE}}` before dispatch: `Agent(subagent_type="general-purpose", model="haiku", prompt=<task-reviewer-prompt.md rendered>, description="Review task N.M")`.
   - `COMPLIANT` → mark task complete, advance.
   - `ISSUES` → implementer fixes, re-review (max 3 loops).

Per-task retry budget: **3 attempts**. After three, escalate to Human Needed (`__ESCALATE__`).

## §IMPL BLOCKED escalation

Tier-escalation path (model-driven BLOCKED). When the implementer's internal retry budget is exhausted at the highest tier WITHIN this invocation AND the current dispatching model is NOT opus, emit a structured terminal line BEFORE stopping:

```
IMPL BLOCKED model=<current> needs=opus reason=<short-reason>
```

Do NOT call `save_issue(workflowState="__ESCALATE__")` in this path — leave the issue in "In Progress" so hero can re-dispatch with `model="opus"` once. The `impl-postcondition.sh` Stop hook greps the transcript for the unanchored `IMPL BLOCKED ` token (the marker is embedded inside a JSON `"text":"..."` field in the JSONL transcript and never appears at column 0) and accepts it as a non-error terminal state.

If the current dispatching model IS already opus, fall through to the existing escalate-to-Human-Needed path (`save_issue(workflowState="__ESCALATE__")`). A double-BLOCKED at opus is a real escalation, not a tier issue.

## §Phase quality review

After all tasks pass the reviewer step:

1. `git diff [phase-start]..HEAD` — capture the phase's net change.
2. Dispatch reviewer at opus, loading the prompt from the sibling `phase-reviewer-prompt.md`. Substitute `{{PHASE_DIFF}}`, `{{PHASE_DEFINITION}}`, `{{SHARED_CONSTRAINTS}}` before dispatch: `Agent(subagent_type="general-purpose", model="opus", prompt=<phase-reviewer-prompt.md rendered>, description="Review phase N quality")`.
3. `APPROVED` → proceed to Step 4. `NEEDS_FIXES` → dispatch fixer; Critical issues block, Important issues get fixed inline, Minor issues are logged.
4. Post `## Phase N Review` comment on the issue with reviewer verdict + diff summary.
5. If drift accumulated, post `## Drift Log — Phase N` comment summarizing off-ownership writes (read from `${TMPDIR}/ralph-drift-${RALPH_TICKET_ID}.log`).
6. Run the phase's automated verification via a **haiku test-runner fork**: `Agent(subagent_type="general-purpose", model="haiku", prompt="Run each of these Automated Verification commands from <worktree-path>: <commands>. For EACH command report PASS or FAIL with the actual parsed result (test counts, exit status) — never infer PASS from exit 0 or tail output alone; quote the failing output verbatim on FAIL.")`. This keeps raw test output out of the controller's context and puts a results-parsing discipline between "command exited" and "check passed". On any FAIL: attempt one fix in the controller, re-run via the same fork; if still failing, commit what works and STOP for human intervention.

## §Resumption

`/ralph:impl --mode auto` is **resumable across context windows**. State is tracked entirely on disk:

- Plan checkboxes (`- [x]`) mark completed automated verification.
- Worktree persists at the path recorded when it was created (see [worktree-setup.md](worktree-setup.md) — `EnterWorktree({name})` reports it; do not assume a literal `worktrees/GH-NNN`).
- Each phase's commits are pushed before the invocation stops.

To resume, re-invoke `/ralph:impl --mode auto NNN`. The skill re-reads the plan, finds the first unblocked unchecked phase, and continues. No in-memory state to recover.

## §Sub-agent isolation

Sub-agents spawned via `Agent()` from this skill must NOT receive `team_name` in their dispatch parameters. Team isolation is a separate concern (handled by the team orchestrator); within-impl sub-agents are stateless workers that report back via their final message.
