# Hero State Machine

> Consulted by `/ralph:hero` default mode. The skill body says *what phase to execute next*; this reference says *what each phase does* and *how convergence is detected*.

## ASCII diagram

```
+-------------------------------------------------------------------+
|                     RALPH HERO STATE MACHINE                       |
+-------------------------------------------------------------------+
|  START                                                             |
|    |                                                               |
|    v                                                               |
|  ANALYZE ROOT                                                      |
|    |                                                               |
|    v                                                               |
|  ANALYST PHASE                                                     |
|    |- SPLIT (if M/L/XL) -- loop until all XS/S                    |
|    |- RESEARCH (parallel) -- all "Research Needed" leaves          |
|    | all "Ready for Plan"                                          |
|    v                                                               |
|  BUILDER PHASE                                                     |
|    |- PLAN (per group) -- create implementation plans              |
|    |- PLAN REVIEW GATE                                             |
|    |   | plan review is "auto":                                    |
|    |   |   /ralph:plan --mode review critiques plan                |
|    |   |   APPROVED -> report plan location, advance, continue     |
|    |   |   NEEDS_ITERATION -> return critique to /ralph:plan        |
|    |   |   ESCALATE -> move to Human Needed, STOP                  |
|    |   | plan review is "interactive":                              |
|    |   |   report plan location, ask human for approval            |
|    |   |   APPROVED -> advance, continue                           |
|    |   |   REJECTED -> STOP                                        |
|    |- IMPLEMENT (sequential) -- execute plan phases                |
|    |- PR (per feature plan; one PR closes all group members)       |
|    v                                                               |
|  MERGE GATE                                                        |
|    | merge review is "interactive" (default):                      |
|    |   report PR URLs, STOP -- human must request merge            |
|    | merge review is "auto":                                       |
|    |   proceed to /ralph:review (validate, merge, CI watch)        |
|    v                                                               |
|  INTEGRATOR PHASE                                                  |
|    |- /ralph:review GH-[PRIMARY] (validate, merge, CI watch)       |
|    v                                                               |
|  COMPLETE                                                          |
+-------------------------------------------------------------------+
```

## Phases

| Phase | MCP `phase` value | What it does |
|---|---|---|
| START | (none) | Entry point — call `get_issue(includePipeline=true)` and read `phase` |
| SPLIT | `SPLIT` | One or more M/L/XL issues need decomposition. Dispatch `/ralph:caretake --mode split #NNN` per issue. After all complete, re-detect. |
| RESEARCH | `RESEARCH` | All "Research Needed" leaves run in parallel via `/ralph:research --auto NNN` |
| PLAN | `PLAN` | After research converges, plan per primary issue via `/ralph:plan --auto NNN [--research-doc PATH]` |
| REVIEW | `REVIEW` | Plan-review gate. When `RALPH_REVIEW_PLAN=auto`, dispatch `/ralph:plan --mode review NNN`. When `interactive`, surface AskUserQuestion picker. |
| HUMAN_GATE | `HUMAN_GATE` | Issue is in Human Needed. STOP and report blocker. Do not auto-dispatch unblock — that's caretake's job. |
| IMPLEMENT | `IMPLEMENT` | Dispatch `/ralph:impl --auto NNN [--plan-doc PATH]` (one issue at a time, respecting `blockedBy` chains) |
| INTEGRATE | `INTEGRATE` | PR + merge. PR via `/ralph:impl --mode pr NNN`; merge gate via `/ralph:review NNN` (default mode = code-review + merge). |
| COMPLETE | `COMPLETE` | All issues in Done. Report final status. |
| TERMINAL | `TERMINAL` | Issue is Canceled or otherwise dead. Skip. |

## Convergence rules

- **SPLIT → RESEARCH**: All issues in the group have `estimate ∈ {XS, S}`.
- **RESEARCH → PLAN**: All issues have `workflowState == "Ready for Plan"`.
- **PLAN → REVIEW**: All issues have `workflowState == "Plan in Review"` AND have a plan doc linked.
- **REVIEW → IMPLEMENT**: All issues have `workflowState == "In Progress"` (review-agent approved).
- **IMPLEMENT → INTEGRATE**: All issues have `workflowState == "In Review"` (PR open).
- **INTEGRATE → COMPLETE**: All issues have `workflowState == "Done"` AND PRs merged AND CI green.

Hero does NOT recompute these — it trusts the `phase` field from `get_issue(includePipeline=true)`.

## Why this design

- **GitHub IS the tree.** Convergence is detected from project field state, not a sidecar data structure.
- **Single source of truth.** The MCP server owns the state machine; hero is a consumer.
- **Phase-driven dispatch.** Each phase has one verb to call. No conditional verb selection beyond the `phase` field.
