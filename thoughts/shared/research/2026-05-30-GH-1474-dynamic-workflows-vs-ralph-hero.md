---
date: 2026-05-30
researcher: Claude (Opus 4.8)
git_commit: ec9c8f2d2ea281aa659b975e862eed36738c2a9d
branch: main
repository: ralph-hero
topic: "Claude Code Dynamic Workflows vs. the ralph hero orchestrator — replace / augment / simplify"
tags: [research, workflows, hero, orchestration, harness-engineering, dispatch]
status: complete
last_updated: 2026-05-30
github_issue: 1474
github_url: https://github.com/cdubiel08/ralph-hero/issues/1474
---

# Dynamic Workflows vs. the ralph `hero` orchestrator

## Research Question

Claude Code shipped a new "Dynamic Workflows" feature — Claude authors and runs
multi-agent, multi-phase orchestration scripts that can handle "quarters of work in days." What
parts of ralph-hero could it *replace*? What does it *augment*? How does it *simplify*?

## Prior Work

This builds on the slim-plugin restructure (`2026-05-22-ralph-slim-plugin-restructure.md`, principle
P1 "Claude Code is the harness"), the dispatch-surfaces inventory
(`2026-05-17-claude-code-dispatch-surfaces.md`), the harness-engineering five-pillars distillation
(`2026-05-26-...`, rent-vs-own thesis), and the triage-autonomy-gaps research
(`2026-05-30-ralph-triage-autonomy-gaps.md`, which establishes that hero's open autonomy gaps are in
picker/state-sync, not the loop/dispatch mechanism). Full paths in [Files Affected](#files-affected).

## Summary

Dynamic Workflows is the within-run **muscle** for fan-out-heavy bursts;
the ralph `hero` remains the durable, stateful, human-gated **spine** over a GitHub board. They are
complementary, not competitive — Workflows is a new *additive* harness primitive ralph can rent, not
a replacement for the autopilot. The highest-value adoption is to let hero *dispatch a Workflow* for
fan-out phases instead of hand-managing parallel `Agent()` calls and a `TaskList` DAG.

---

## What Dynamic Workflows actually is

Launched **May 28, 2026** as a **research preview** (requires Claude Code ≥ v2.1.154), alongside
Claude Opus 4.8. Available on all paid plans (on by default for Max/Team; opt-in for Pro; admin-gated
for Enterprise) and via the Agent SDK (`"ultracode": true`).

### Marketing claims (verbatim, official)
- **"Work you'd normally plan in quarters now finishes in days."** — [claude.com/blog/introducing-dynamic-workflows-in-claude-code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)
- "Claude dynamically writes orchestration scripts that run tens to hundreds of parallel subagents in a single session, checking its work before anything reaches you."
- Flagship example: Jarred Sumner (Bun) ported Bun from Zig to Rust — **~750k LOC of Rust, 99.8% of the existing test suite passing, 11 days from first commit to merge.** Presented as a real outcome, not a benchmark.
- Explicit cost warning: "Dynamic workflows can consume substantially more tokens than a typical Claude Code session."

### Mechanics (from the `Workflow` tool schema + [code.claude.com/docs/en/workflows](https://code.claude.com/docs/en/workflows))
- **A JavaScript script that Claude authors**, executed by a separate runtime in the background while the interactive session stays responsive. The user does not write the script.
- **State lives in script variables, not Claude's context window.** This is the core isolation design — Claude's context holds only the final answer, not the turn-by-turn transcript.
- Primitives: `phase(title)`, `agent(prompt, {schema, model, isolation, agentType})`, `parallel(thunks)` (barrier — awaits all), `pipeline(items, ...stages)` (no barrier — items flow independently), `workflow(name, args)` (one-level nesting), `budget` (token target), `log(msg)`. `agent()` with a `schema` returns a validated structured object; without one, returns the agent's final text.
- **Concurrency cap: 16 simultaneous agents** (fewer on low-CPU machines). **Lifetime cap: 1000 agents per run** (runaway backstop).
- **Resumable only within a session** — paused/stopped runs return cached results for completed agents; everything after re-runs live. **Exit Claude Code entirely and the workflow restarts fresh** (no cross-session resume).
- **No mid-run human input.** Only agent permission prompts can pause a run. The docs are explicit: *"If you need sign-off between stages, run each stage as its own separate workflow."*
- **The script has no direct filesystem/shell access** — it coordinates agents; agents do the file reads/writes/commands.
- Invocation paths: the `workflow` keyword in a prompt, the bundled `/deep-research` command, saved `/name` commands (`.claude/workflows/` or `~/.claude/workflows/`), or `/effort ultracode` (auto-orchestrates every substantive task in the session).

### Relationship to existing primitives (from the docs' own table)

| | Subagents | Skills | Workflows |
|---|---|---|---|
| What it is | A worker Claude spawns | Instructions Claude follows | A script the runtime executes |
| Who decides what runs next | Claude, turn by turn | Claude, following the prompt | The script |
| Where intermediate results live | Claude's context | Claude's context | **Script variables** |
| Scale | A few per turn | A few per turn | **Dozens to hundreds per run** |
| Interruption | Restarts the turn | Restarts the turn | **Resumable in-session** |

Distinct from **Agent Teams** (multiple communicating Claude Code instances) and **Background
Agents** (monitored sessions) — Workflows is a third parallel-execution model.

---

## What the ralph `hero` actually is

A **durable, multi-day, human-gated queue-drainer over a GitHub Projects V2 board.** Sources:
`ralph/skills/hero/SKILL.md`, `ralph/skills/hero/task-graph.md`, `ralph/skills/hero/dispatch.md`,
`ralph/skills/hero/state-machine.md`, and the design rationale in
`thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md`.

Defining properties:
- **State lives in GitHub** (durable, cross-session, human-observable) plus a session `TaskList` DAG — *not* volatile script variables. The board IS the state; a hero run is resumable across context windows precisely because `get_issue(includePipeline=true)` reconstructs the phase from GitHub (`dispatch.md` § Resumability).
- **`--mode auto` is a never-terminating adaptive watcher** built on `/loop` (dynamic) + `ScheduleWakeup` — tight 60–270s cadence during bursts, 1h idle backoff, runs until the user cancels via `/tasks`. Opt-in via `RALPH_AUTOPILOT_ENABLE=true`, enforced by `autopilot-enable-gate.sh` / `autopilot-stop-gate.sh` / `autopilot-wakeup-clear.sh` (`SKILL.md:157-170`).
- **Human-in-the-loop gates are the heart of it.** The default plan-approval gate (`RALPH_REVIEW_PLAN`) and merge gate (`RALPH_REVIEW_MODE`) both pause for a human (`dispatch.md` § Plan review gate / Merge gate).
- **Hooks enforce invariants, not prose** — `branch-gate.sh`, `hero-state-gate.sh`, `lock-release-on-failure.sh`, `autopilot-*`. Design principle **P1: "Claude Code is the harness; don't reimplement what it gives you"** (slim-plugin-restructure doc).
- **Three-tier dispatch already exists:** hero → `--mode classify` (event classification on `trigger:*` / `blocked:*` labels + workflow_state) → team `Skill()` fan-out → per-phase `Agent()` execution (`dispatch.md`, `event-classes.md`).
- The **MCP server** (`ralph-hero-mcp-server`) owns artifact state; skills read/write via `mcp__plugin_ralph_ralph-github__*` tools.

The autonomy gaps that still surface "Human Needed" are in the **picker / state-sync logic** (blind to `blockedBy` edges, `save_issue` doesn't move closed issues to terminal columns), **not** in the loop/dispatch mechanism — see `thoughts/shared/research/2026-05-30-ralph-triage-autonomy-gaps.md`. This matters: Workflows would not fix those gaps because they are about durable board state, which Workflows does not touch.

---

## The mapping: replace / augment / simplify

### SIMPLIFY — the `TaskList` DAG ceremony

`task-graph.md` defines ~90 lines of prose for an upfront `TaskCreate` + `addBlockedBy` graph and an
execution loop that filters `pending && blockedBy=[]`, dispatches unblocked tasks (parallel `Agent()`
calls for independent impl phases), marks completed, repeats. This is **exactly what `pipeline()` and
`parallel()` express natively** — with concurrency caps and in-session resume for free:

```js
// task-graph.md execution loop ≈
const plans = await parallel(researchTasks.map(t => () => agent(researchPrompt(t), {schema: FINDINGS})))
const impl  = await pipeline(phases, p => agent(implPrompt(p), {schema: PHASE_RESULT}),
                                     r => agent(verifyPrompt(r), {schema: VERDICT}))
```

The plan's "read each phase's `depends_on` annotations and set `blockedBy` chains" logic (`task-graph.md`
§ Implementation task ordering) becomes ordinary JS over the dependency graph. The "dispatch multiple
unblocked impl tasks as parallel `Agent()` calls in a single message" instruction becomes one
`parallel()` call. The BLOCKED-escalation retry counter (`dispatch.md` § BLOCKED escalation) becomes a
small loop with `budget`-aware bounds.

### AUGMENT — within-verb fan-out and adversarial verification

Each verb has an internal fan-out that today is described in prose and dispatched ad hoc. These are
textbook Workflow patterns:

- **`research` Step 3** dispatches `codebase-locator` / `analyzer` / `pattern-finder` / `thoughts-locator` / `thoughts-analyzer` in parallel → `parallel()` of `agent()` calls with `agentType` set to the existing investigators.
- **`plan --mode epic`** (multi-angle decomposition) → the judge-panel pattern: N independent attempts, scored, synthesized.
- **`review --mode code` / `--mode val`** → the canonical `pipeline(dimensions, review, parallel(verify))` adversarial-refute pattern the docs tout as producing "more trustworthy results than a single pass." This is the single most natural fit in the whole plugin.
- **`caretake --mode triage`** drain → loop-until-dry over the backlog.

The bundled **`/deep-research`** workflow overlaps with `research --mode prove`'s multi-source
cross-checking and could back it directly.

Critically, `agent()` accepts `agentType` — so ralph's **16 existing agents** (8 per-phase + 8
investigators in `ralph/agents/`) are usable as workflow workers *unchanged*. Adoption does not mean
rewriting the workers; it means replacing the hand-rolled dispatch loop with workflow primitives.

### PARTIALLY REPLACE — the default one-shot orchestrator

The default-mode pipeline (research → plan → review → impl → PR → merge for **one** issue) could be a
single Workflow script — **but only if the human plan-approval gate becomes a stage boundary.** The
docs' own guidance ("run each stage as its own separate workflow") maps cleanly onto ralph's existing
**checkpoint-at-surfaced-states** pattern (memory: `feedback_autopilot_checkpoint_at_surfaced_states`):
a "research+plan" workflow runs to the plan-review gate and stops; the human approves; an
"impl+PR+review" workflow runs the rest. Each is a bounded, resumable, fan-out-capable unit.

### DOES NOT REPLACE — the durable spine

Workflows cannot replace, and should not be expected to replace:

| ralph mechanism | Why Workflows can't replace it |
|---|---|
| `--mode auto` `/loop` never-terminating drain | Workflows are **session-scoped**, ≤1000 agents, then done. The autopilot runs for days/weeks across sessions. |
| GitHub board as durable state | Workflow state is **volatile script variables**, lost on session exit. The board is the cross-session source of truth and the human's window into progress. |
| Plan-approval + merge human gates | **No mid-run human input.** Gates must become workflow *boundaries*, not in-run pauses. |
| Hooks (branch-gate, state-gate, lock-release) | Enforcement is a harness concern; Workflows add no hook surface. |
| MCP server / artifact state | Orthogonal — agents inside a workflow still call the same MCP tools. |
| Event-driven classification (`trigger:*`/`blocked:*` labels, watcher heartbeats) | This is *triggering*, not orchestration. `/loop` + classify still owns it. |

---

## Strategic framing: a new rental, not a new harness

The five-pillars distillation (`thoughts/shared/research/2026-05-26-harness-engineering-five-pillars-distillation.md`)
observes that ralph "rents" Claude Code as its harness rather than owning one. Dynamic Workflows is a
**new additive rental on that same harness** — it does not threaten the rent model, it enriches the
heavy-lift bursts. The clean target architecture:

```
hero (durable spine: /loop + ScheduleWakeup + GitHub state + hooks + human gates)
  └── dispatches a Workflow() for each fan-out-heavy phase
        ├── research:    parallel investigators → synthesis
        ├── plan/epic:   judge-panel of N angles → synthesis
        ├── impl:        pipeline over independent phases (worktree isolation)
        └── review:      dimensions → adversarial verify
```

This replaces the hand-managed `TaskList` DAG + parallel-`Agent()` prose with a single typed
`Workflow` dispatch per phase, while leaving the durable, observable, human-gated outer loop exactly
where it is.

---

## Caveats and risks

1. **Token cost.** Workflows "consume substantially more tokens." Per-issue autopilot drain running a
   workflow on every issue could be expensive at scale. Mitigation: gate workflow dispatch behind
   issue size (M/L/XL only), use the `budget` primitive, route cheap stages to smaller models via the
   `model` arg, keep XS/S issues on the current inline dispatch.
2. **Research preview.** Not GA; API/primitives may shift. Adopt behind a feature flag (e.g.
   `RALPH_USE_WORKFLOWS=true`) rather than hard-wiring.
3. **Keyword collision.** The `workflow` trigger keyword fires on the literal word — ralph's docs and
   prompts say "workflow" constantly ("the hero workflow", "workflow_state", "GitHub Actions
   workflows"). Authoring saved `/name` workflows avoids the keyword path; document the collision.
4. **No cross-session resume.** A workflow that outlives a session restarts fresh — so the durable
   spine must stay in GitHub/`TaskList`, never in workflow variables. This reinforces the
   spine/muscle split rather than undermining it.
5. **The autonomy gaps are unaffected.** The picker/state-sync gaps in
   `2026-05-30-ralph-triage-autonomy-gaps.md` are orthogonal — Workflows neither help nor hurt them.

---

## Files Affected

> This is a research/strategy doc — no code is changed. "Files Affected" lists the source files and
> documents this analysis draws on (and the verbs a future adoption spike, GH-1474, would touch).

**ralph hero (code, this repo):**
- `ralph/skills/hero/SKILL.md` — 5 modes, autopilot loop contract, hooks
- `ralph/skills/hero/task-graph.md` — the DAG ceremony that `pipeline()`/`parallel()` would simplify
- `ralph/skills/hero/dispatch.md` — phase→verb map, `Skill()` vs `Agent()`, BLOCKED escalation, gates
- `ralph/skills/hero/state-machine.md`, `event-classes.md`, `watch-dispatch.md`, `pr-drain.md`
- `ralph/CLAUDE.md` — loop/`--auto` suitability matrix; P1 harness principle

**Prior art (thoughts):**
- `thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md` — P1 "Claude Code is the harness"; 9-verb design
- `thoughts/shared/research/2026-05-17-claude-code-dispatch-surfaces.md` — 11 dispatch surfaces inventory
- `thoughts/shared/research/2026-05-26-harness-engineering-five-pillars-distillation.md` — rent-vs-own harness thesis
- `thoughts/shared/research/2026-05-30-ralph-triage-autonomy-gaps.md` — picker/state-sync gaps (Workflows-orthogonal)
- `thoughts/shared/research/2026-05-21-autopilot-loop-handoff.md` — `/loop` + `ScheduleWakeup` mechanics

**Dynamic Workflows (external):**
- [Introducing dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code) — announcement, "quarters of work in days," Bun port
- [Orchestrate subagents at scale with dynamic workflows](https://code.claude.com/docs/en/workflows) — primitives, caps, resume, gate guidance
- [Introducing Claude Opus 4.8](https://www.anthropic.com/news/claude-opus-4-8) — codebase-scale migration claim
- [Create custom subagents](https://code.claude.com/docs/en/sub-agents), [Model config / ultracode](https://code.claude.com/docs/en/model-config)
- The `Workflow` tool JSON schema (this Claude Code session's system prompt) — authoritative primitive spec (`pipeline`, `parallel`, `agent` schema, `budget`, `workflow` nesting, `meta` block)
