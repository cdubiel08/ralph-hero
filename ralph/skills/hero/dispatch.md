# Hero Dispatch Contract

> Consulted by `/ralph:hero` default mode Step 3 (execution loop) and `--mode classify` (single dispatch). Maps each phase to the verb that runs it.

## Phase → verb mapping

| Phase | Verb | Args |
|---|---|---|
| SPLIT | `/ralph:caretake --mode split` | `#NNN` |
| RESEARCH | `/ralph:research --auto` | `NNN` (or `NNN --mode prove` for claim-checks) |
| PLAN (XS/S/M) | `/ralph:plan --auto` | `NNN [--research-doc PATH]` |
| PLAN (L/XL epic) | `/ralph:plan --auto --mode epic` | `NNN [--research-doc PATH]` |
| REVIEW (plan) | `/ralph:plan --mode review` | `NNN [--plan-doc PATH]` |
| IMPLEMENT | `/ralph:impl --auto` | `NNN [--plan-doc PATH]` |
| PR | `/ralph:impl --mode pr` | `NNN` |
| INTEGRATE | `/ralph:review` | `NNN` |

All targets are skills in the same `ralph` plugin → unqualified names work in `Skill()` calls.

**Group unit (GH-1538):** PLAN, IMPLEMENT, PR, and INTEGRATE operate on the *plan group*, not the individual leaf. Once a sibling group plan exists (frontmatter `github_issues`), hero treats all members as one pipeline unit: one plan task, one worktree/branch, one PR closing every member. On the classify/auto path, SKIP any issue whose group is already in flight — a sibling group plan covering it exists and its train (plan → phases → PR) is the vehicle; dispatching the member separately would fork a duplicate PR.

## Skill() vs Agent()

| Phase | Dispatch | Why |
|---|---|---|
| SPLIT, RESEARCH (XS/S single), PLAN, REVIEW (plan), INTEGRATE | `Skill("ralph:<verb>", args="NNN ...")` | Inline — these read/write durable state via MCP and need to share hero's context for resumability |
| RESEARCH (feature/epic unit: estimate M+ or `kind:epic`/`kind:feature`) | `Agent(subagent_type="ralph:research-agent", model="fable", prompt="Research GH-NNN ... follow ${CLAUDE_PLUGIN_ROOT}/skills/research/*.md refs; write findings doc; advance to Ready for Plan")` | Tier routing by unit size (GH-1538): feature/epic research is a fable bookend — the findings doc steers every downstream phase. XS/S singles keep the cheap inline sonnet path. `CLAUDE_CODE_SUBAGENT_MODEL=opus` is the non-Fable rescue (flattens all forks — documented in docs/model-tier-policy.md). |
| IMPLEMENT | `Skill("ralph:impl", args="NNN --auto --plan-doc PATH")` | The slim plugin uses `--auto` mode (one phase per invocation in an isolated worktree, enforced by `impl-worktree-gate.sh`). The runtime gates worktree isolation; hero does not need a separate Agent() session for this. |
| PR (within IMPLEMENT) | `Skill("ralph:impl", args="NNN --mode pr")` | PR creation is `/ralph:impl --mode pr` — preserves the loop-runner sentinel `Queue empty.` and the queue-pick semantics from the source `ralph-pr` skill. |

> Agent-based dispatch is available via the thin `subagent_type=ralph:impl-agent` shells now living in `ralph/agents/` (these preload no skill — the dispatcher passes the worker prose inline; see the `review` / `catch-up` dispatch sites). Hero itself prefers `Skill()` dispatch because it keeps the hero session in control of the resumability protocol.

## Model selection (IMPLEMENT phase)

Read `${RALPH_IMPL_MODEL:-sonnet}`. Default is sonnet; override via env or shell:

```bash
impl_model="${RALPH_IMPL_MODEL:-sonnet}"
```

Pass the resolved model explicitly to dispatched verbs that respect it. Default is `sonnet`; opus is used on BLOCKED-escalation (when impl returns `IMPL BLOCKED needs=opus`).

## BLOCKED escalation

After `/ralph:impl --auto` returns, inspect the terminal verdict. If it contains the prefix `IMPL BLOCKED ` (full format: `IMPL BLOCKED model=<x> needs=opus reason=<short>` — match on the prefix, not the full string, so detection cannot drift from the emitted format):

1. If this dispatch's model was NOT opus AND no prior opus retry has occurred for this issue:
   re-dispatch the same issue with `RALPH_IMPL_MODEL=opus`:
   ```
   Skill("ralph:impl", args="NNN --auto --plan-doc PATH (retry after BLOCKED)")
   ```
   Track a per-issue retry counter in TaskList metadata so a second BLOCKED at opus does not loop.
2. If this dispatch's model was opus, OR the retry counter is already 1:
   escalate via `save_issue(workflowState="__ESCALATE__", command="ralph_impl")` to Human Needed. Fire a best-effort push notification:
   ```
   PushNotification(title="Failed #NNN", body="<blocked-reason> — <issue-url>")
   ```
   STOP the hero loop and report the BLOCKED reason.

Contract: at most ONE re-dispatch at the higher tier. A double-BLOCKED is a real escalation, not a model-tier issue.

## Plan review gate

After all plans complete, read `$RALPH_REVIEW_PLAN` (default `auto`):

**`auto`:**

Dispatch `Skill("ralph:plan", args="NNN --mode review --plan-doc PATH")` for each plan. Route on the review outcome:

- **ALL APPROVED** (decision-free plans — the review advances them) → batch update all issues in the group to "In Progress", report plan locations, continue
- **NEEDS_ITERATION** → return critique to `/ralph:plan`, re-dispatch, re-review. Max 2 iterations before escalating
- **`PLAN AWAITING DECISION`** → the plan is APPROVED but holds in Plan in Review on open `#### Decision:` blocks. Report the `## Decision Request` comment URL and STOP this issue's pipeline. This is NOT an escalation — do NOT move to Human Needed; the human answers on the issue (or via `/ralph:plan --mode review NNN` interactively) and the next review dispatch advances it.
- **ESCALATE** → move issues to Human Needed, STOP with the critique

**`interactive`:**

Report planned groups with plan URLs and current state. All issues are in "Plan in Review".

Decisions-first (per `plan-review.md` § Interactive vs auto): present one `Decision:`-header `AskUserQuestion` per open `#### Decision:` block, folding answers into the plan. Then the confirm picker:
- "Approve and implement" → batch update to "In Progress", continue
- "Open plan in editor" → `open` / `xdg-open` the plan file, then re-present the picker
- "Stop here" → mark gate task completed and STOP with plan URL + resume command

## Merge gate

After all PRs created, read `$RALPH_REVIEW_MODE` (default `auto`):

**`auto`** (default; unset or `auto`): dispatch `Skill("ralph:review", args="NNN")` per primary issue. `/ralph:review` owns code-review + merge mechanics (it's Plan 6's verb) — including the epic close-out validation when the merge closes an epic's last child (fable val-agent, `ralph/skills/review/merge-gate.md` § Epic close-out validation). `CHANGES_REQUESTED` on the PR remains the unconditional human veto (`merge-review-decision-gate.sh` runs regardless of this dial).

**`interactive`** (opt-out): report PR URLs, STOP. Human must re-run `/ralph:hero NNN` or `/ralph:review NNN`.

## Error handling

| Error | Action |
|-------|--------|
| Split failure | Report which issue failed, preserve other results, STOP |
| Research failure | Report failure, other parallel research continues, STOP at convergence |
| Implementation failure | STOP immediately, preserve worktree, do NOT continue |
| Circular dependencies | Report the cycle, suggest manual cleanup, STOP |

## Resumability

Hero is resumable across context windows:

1. `get_issue(includePipeline=true)` determines the current phase from GitHub state
2. `TaskList()` restores progress from the session task list
3. If TaskList is empty (new session): rebuild upfront task list from the current phase
4. If TaskList has tasks: resume from the first pending unblocked task

Re-run with `/ralph:hero <ROOT-NUMBER>`.

## Cross-repo expansion

When the root issue spans repos (detected during research or from issue body):

1. **Check for matching pattern:** look up the issue's repos against `.ralph-repos.yml` patterns.
2. **Invoke `decompose_feature` directly** (hero has the MCP tool):
   ```
   ralph_hero__decompose_feature({
     title: <root issue title>,
     description: <root body + research summary>,
     pattern: <matched pattern name>,
     dryRun: true
   })
   ```
3. **Review proposal**, then re-call with `dryRun: false`. The tool wires sub-issues + dependencies on the project board.
4. **Update task list:** add created sub-issues as tasks with `blockedBy` chains matching the pattern's `dependency-flow`. Independent repos get no `blockedBy` — they run in parallel.

### Evidence-based dependency detection

During tree expansion, if research found imports between repos not declared in the registry (e.g., `import { X } from 'ralph-hero'` in landcrawler-ai):

- Treat repos as dependent (add `blockedBy` to the downstream sub-issue)
- Surface to the human: "I found imports from ralph-hero in landcrawler-ai. Your registry doesn't declare this dependency — want me to add it?"
- If human confirms, suggest adding a `dependency-flow` edge to the pattern

Default for unknown relationships: if no evidence of dependency is found and no `dependency-flow` edge exists, treat repos as independent and run in parallel.
