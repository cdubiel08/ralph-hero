---
date: 2026-03-20
type: research
github_issue: 646
tags: [hero, skills, agent-dispatch, orchestration]
---

# Skill Dispatch Inventory — Ralph Hero Skills

## Prior Work

- builds_on:: [[2026-03-19-GH-0637-hero-dispatch-model]]

## Purpose

Canonical reference classifying all 29 ralph-hero skills by dispatch mode. Used by:

- **GH-647**: Convention fragment (`skill-vs-agent-dispatch.md`) — references this inventory for the full mapping table
- **GH-645**: hello skill fix — confirms which routes must switch from `Skill()` to `Agent()`
- Future skill authors — determining appropriate dispatch when writing new orchestrators

Parent context: GH-630 (skill dispatch correctness epic).

---

## Summary Table

Quick-reference classification for all 29 skills. See per-skill detail below for rationale and edge cases.

| Skill | context | user-invocable | AskUserQuestion | Classification | Recommended Dispatch |
|-------|---------|----------------|-----------------|----------------|----------------------|
| `bridge-artifact` | fork | true | No | Lightweight/read-only | Either (prefer Agent) |
| `design-system-audit` | not set | not set | No | Interactive | Skill() or inline |
| `draft` | not set | not set | No | Interactive | Skill() or inline |
| `form` | not set | not set | No | Interactive | Skill() or inline |
| `hello` | inline | not set | Yes | Interactive | Skill() or inline |
| `hero` | inline | not set | Yes | Interactive | Skill() or inline |
| `idea-hunt` | not set | false | No | Autonomous | Agent() |
| `impl` | not set | not set | No | Interactive | Skill() or inline |
| `iterate` | not set | not set | No | Interactive | Skill() or inline |
| `plan` | not set | not set | No | Interactive | Skill() or inline |
| `ralph-hygiene` | fork | false | No | Autonomous | Agent() |
| `ralph-impl` | fork | false | No | Autonomous | Agent() |
| `ralph-merge` | fork | false | No | Autonomous | Agent() |
| `ralph-plan` | fork | false | No | Autonomous | Agent() |
| `ralph-plan-epic` | fork | false | No | Autonomous | Agent() |
| `ralph-pr` | fork | false | No | Autonomous | Agent() |
| `ralph-research` | fork | false | No | Autonomous | Agent() |
| `ralph-review` | fork | false | Conditional | **Autonomous in AUTO mode; Interactive in INTERACTIVE mode** | Agent() (AUTO) / Skill() (INTERACTIVE) |
| `ralph-split` | fork | false | No | Autonomous | Agent() |
| `ralph-triage` | fork | false | No | Autonomous | Agent() |
| `ralph-val` | fork | false | No | Autonomous | Agent() |
| `record-demo` | inline | false | Yes | Interactive | Skill() or inline |
| `report` | fork | not set | No | Lightweight/read-only | Either (prefer Agent) |
| `research` | not set | not set | No | Interactive | Skill() or inline |
| `setup` | fork | not set | Yes (extensive) | Interactive | Skill() or inline |
| `setup-cli` | fork | not set | No | Lightweight/read-only | Either |
| `setup-repos` | fork | not set | Yes | Interactive | Skill() or inline |
| `status` | fork | not set | No | Lightweight/read-only | Either |
| `team` | not set | not set | No | Interactive (orchestrator) | Skill() or inline |

**Classification key:**
- **Autonomous**: `context: fork` + `user-invocable: false` — designed for isolated, unattended execution
- **Interactive**: Requires human collaboration, uses `AskUserQuestion`, or is designed as a human-facing session companion
- **Lightweight/read-only**: Typically `context: fork` but does quick reads or one-shot tasks; safe either way

---

## Per-Skill Detail

### Autonomous Skills

These skills declare `context: fork` and `user-invocable: false`. They are designed to run in isolation from the calling context and never ask the human for input during normal operation. They **must** be dispatched via `Agent()` when called from an orchestrator (hero, hello, team) to preserve context isolation and enable parallelism.

---

#### `ralph-hygiene`

- **context**: fork
- **user-invocable**: false
- **AskUserQuestion**: No
- **Classification**: Autonomous
- **Recommended dispatch**: `Agent(subagent_type="ralph-hero:ralph-analyst", ...)`
- **Rationale**: Runs board hygiene check autonomously. No human interaction. Invoked by hero/hello when board needs cleaning.

---

#### `ralph-impl`

- **context**: fork
- **user-invocable**: false
- **AskUserQuestion**: No
- **Classification**: Autonomous
- **Recommended dispatch**: `Agent(subagent_type="ralph-hero:ralph-builder", ...)`
- **Rationale**: Executes one implementation phase per invocation in an isolated worktree. Strict hooks enforce plan compliance. Designed for unattended operation. Called by hero/team orchestrators.

---

#### `ralph-merge`

- **context**: fork
- **user-invocable**: false
- **AskUserQuestion**: No
- **Classification**: Autonomous
- **Recommended dispatch**: `Agent(subagent_type="ralph-hero:ralph-builder", ...)`
- **Rationale**: Merges approved PRs, cleans up worktrees, moves issues to Done. Fully deterministic with no human interaction needed.

---

#### `ralph-plan`

- **context**: fork
- **user-invocable**: false
- **AskUserQuestion**: No
- **Classification**: Autonomous
- **Recommended dispatch**: `Agent(subagent_type="ralph-hero:ralph-analyst", ...)`
- **Rationale**: Autonomous implementation planning — reads research, writes phased plan, commits to main. No questions asked. Called by hero orchestrators after research phase completes.

---

#### `ralph-plan-epic`

- **context**: fork
- **user-invocable**: false
- **AskUserQuestion**: No
- **Classification**: Autonomous
- **Recommended dispatch**: `Agent(subagent_type="ralph-hero:ralph-analyst", ...)`
- **Rationale**: Strategic planning for multi-tier epics. Internally calls ralph-split and ralph-plan (those calls should also be `Agent()` per GH-637 finding 4). Fully autonomous.

---

#### `ralph-pr`

- **context**: fork
- **user-invocable**: false
- **AskUserQuestion**: No
- **Classification**: Autonomous
- **Recommended dispatch**: `Agent(subagent_type="ralph-hero:ralph-builder", ...)`
- **Rationale**: Creates pull requests for completed implementations. Deterministic, no user input required.

---

#### `ralph-research`

- **context**: fork
- **user-invocable**: false
- **AskUserQuestion**: No
- **Classification**: Autonomous
- **Recommended dispatch**: `Agent(subagent_type="ralph-hero:ralph-analyst", ...)`
- **Rationale**: Investigates codebase autonomously, writes research findings, advances workflow state. Multiple research tasks can run in parallel when dispatched via `Agent()`.

---

#### `ralph-review`

- **context**: fork
- **user-invocable**: false
- **AskUserQuestion**: Conditional — Yes in INTERACTIVE mode (Step 4A), No in AUTO mode
- **Classification**: **Autonomous in AUTO mode; Interactive in INTERACTIVE mode — hero and hello only invoke AUTO mode**
- **Recommended dispatch**: `Agent(subagent_type="ralph-hero:ralph-builder", ...)` for AUTO mode; `Skill()` if INTERACTIVE mode is explicitly needed
- **Rationale**: The only skill with a mode-dependent classification. AUTO mode (default when `RALPH_REVIEW_MODE == "auto"` or no `--interactive` flag) does not call `AskUserQuestion` and runs fully autonomously. INTERACTIVE mode (triggered by `--interactive` flag) presents an `AskUserQuestion` wizard with Approve/Reject/Minor Changes options. Hero and hello call review without `--interactive`, so `Agent()` dispatch is safe. If a future caller needs interactive review, use `Skill()` and ensure `AskUserQuestion` is in the caller's `allowed-tools`.

---

#### `ralph-split`

- **context**: fork
- **user-invocable**: false
- **AskUserQuestion**: No
- **Classification**: Autonomous
- **Recommended dispatch**: `Agent(subagent_type="ralph-hero:ralph-analyst", ...)`
- **Rationale**: Splits large issues (M/L/XL) into XS/S sub-issues. Fully deterministic. Called by hero orchestrators for decomposition phase.

---

#### `ralph-triage`

- **context**: fork
- **user-invocable**: false
- **AskUserQuestion**: No
- **Classification**: Autonomous
- **Recommended dispatch**: `Agent(subagent_type="ralph-hero:ralph-analyst", ...)`
- **Rationale**: Triages backlog issues, closes duplicates, routes to research. No human interaction. Called by hello's routing table when board needs attention or user wants to pick work.

---

#### `ralph-val`

- **context**: fork
- **user-invocable**: false
- **AskUserQuestion**: No
- **Classification**: Autonomous
- **Recommended dispatch**: `Agent(subagent_type="ralph-hero:ralph-integrator", ...)`
- **Rationale**: Validates implementations against plan requirements. Read-only validation skill, fully automated.

---

#### `idea-hunt`

- **context**: not set
- **user-invocable**: false
- **AskUserQuestion**: No
- **Classification**: Autonomous
- **Recommended dispatch**: `Agent()` (general-purpose or custom agent)
- **Rationale**: Spawns a team of GitHub listers/analyzers autonomously. `user-invocable: false` signals it is not a human-initiated skill. Uses `TeamCreate`/`TaskCreate` for its own orchestration. Does not ask for user input during execution; the topic is passed as an argument.

---

### Interactive Skills

These skills are designed for human collaboration. They may use `AskUserQuestion` directly, rely on natural conversation flow, or serve as session companions. They should be invoked via `Skill()` so they share the caller's context and can present questions to the user.

---

#### `hello`

- **context**: inline
- **user-invocable**: not set (effectively true — it is the primary entry point)
- **AskUserQuestion**: Yes (Step 4: intent confirmation)
- **Classification**: Interactive
- **Recommended dispatch**: Skill() or direct invocation
- **Rationale**: Session companion. Explicitly inline context. Presents direction picker to user via `AskUserQuestion`. Cannot run autonomously — it IS the human-facing entry point. After GH-645, hello will dispatch downstream autonomous skills via `Agent()`.

---

#### `hero`

- **context**: inline
- **user-invocable**: not set (effectively true — primary orchestrator)
- **AskUserQuestion**: Yes (plan approval gate between research and implementation phases)
- **Classification**: Interactive
- **Recommended dispatch**: Skill() or direct invocation
- **Rationale**: Tree-expansion orchestrator with a deliberate human plan-approval gate. The `AskUserQuestion` at the plan approval step is a feature, not a limitation. Hero dispatches downstream autonomous skills via `Agent()` (after GH-637 fix).

---

#### `design-system-audit`

- **context**: not set
- **user-invocable**: not set
- **AskUserQuestion**: No
- **Classification**: Interactive (consulting engagement)
- **Recommended dispatch**: Skill() or inline
- **Rationale**: No `context` or `user-invocable` frontmatter set. Runs a multi-phase consulting engagement with codebase scanning followed by targeted questions. The description states "Scan first, ask second" — questions are part of the design. Appropriate as a direct user-facing skill.

---

#### `draft`

- **context**: not set
- **user-invocable**: not set
- **AskUserQuestion**: No (uses normal conversation flow)
- **Classification**: Interactive
- **Recommended dispatch**: Skill() or inline
- **Rationale**: Quick idea capture with 2-3 clarifying questions via conversation flow. No `AskUserQuestion` tool but inherently collaborative. Designed as a low-friction user-facing command.

---

#### `form`

- **context**: not set
- **user-invocable**: not set
- **AskUserQuestion**: No (uses normal conversation flow)
- **Classification**: Interactive
- **Recommended dispatch**: Skill() or inline
- **Rationale**: Crystallizes draft ideas into structured GitHub issues. Collaborative process of refining ideas with the user before creating issues. No explicit `AskUserQuestion` but interactive by design.

---

#### `impl`

- **context**: not set
- **user-invocable**: not set
- **AskUserQuestion**: No (pauses for human verification via normal flow)
- **Classification**: Interactive
- **Recommended dispatch**: Skill() or inline
- **Rationale**: Human-in-the-loop implementation. Pauses after each phase for manual testing and human approval. Designed as the interactive counterpart to `ralph-impl`. Not suitable for autonomous dispatch.

---

#### `iterate`

- **context**: not set
- **user-invocable**: not set
- **AskUserQuestion**: No (uses normal conversation flow)
- **Classification**: Interactive
- **Recommended dispatch**: Skill() or inline
- **Rationale**: Iterates on existing plans with user feedback. Designed for collaborative refinement. The user provides feedback and the skill confirms approach before making changes.

---

#### `plan`

- **context**: not set
- **user-invocable**: not set
- **AskUserQuestion**: No (uses normal conversation flow for buy-in at steps 3 and 5)
- **Classification**: Interactive
- **Recommended dispatch**: Skill() or inline
- **Rationale**: Human-in-the-loop planner. Works WITH the user through research, design options, and incremental approval. Interactive counterpart to `ralph-plan`. Not suitable for autonomous dispatch.

---

#### `record-demo`

- **context**: inline
- **user-invocable**: false
- **AskUserQuestion**: Yes
- **Classification**: Interactive
- **Recommended dispatch**: Skill() or inline
- **Rationale**: Despite `user-invocable: false`, this skill is explicitly interactive — it records screen with the user present, asking them to confirm readiness and narrate. `context: inline` and `AskUserQuestion` confirm it must share caller context. Not a pipeline skill.

---

#### `research`

- **context**: not set
- **user-invocable**: not set
- **AskUserQuestion**: No (uses normal conversation flow)
- **Classification**: Interactive
- **Recommended dispatch**: Skill() or inline
- **Rationale**: Interactive codebase research with human collaboration. Asks for a research question, refines with user, validates findings. Interactive counterpart to `ralph-research`. Per GH-637, "interactive counterparts don't use `AskUserQuestion` tool — they rely on natural conversation flow."

---

#### `setup`

- **context**: fork
- **user-invocable**: not set
- **AskUserQuestion**: Yes (extensively — multiple configuration questions)
- **Classification**: Interactive
- **Recommended dispatch**: Skill() or inline
- **Rationale**: Despite `context: fork`, this skill uses `AskUserQuestion` extensively throughout its setup flow (token input, project number, config confirmation). The fork context means it runs in an isolated session but it is fundamentally interactive — it cannot complete without user responses.

---

#### `setup-repos`

- **context**: fork
- **user-invocable**: not set
- **AskUserQuestion**: Yes (domain/tech stack questions)
- **Classification**: Interactive
- **Recommended dispatch**: Skill() or inline
- **Rationale**: Bootstraps `.ralph-repos.yml` by asking domain and tech stack questions. `context: fork` but explicitly interactive with `AskUserQuestion` for repo configuration.

---

#### `team`

- **context**: not set
- **user-invocable**: not set
- **AskUserQuestion**: No
- **Classification**: Interactive (orchestrator — spawns persistent workers)
- **Recommended dispatch**: Skill() or direct invocation
- **Rationale**: Fully autonomous multi-agent orchestrator that spawns persistent specialist workers (analyst, builder, integrator) via `Agent()`/`TeamCreate()`. No human gates. However, it is the primary user-facing entry point for autonomous team operation — invoked directly by the user, not dispatched from another skill. Classified as "interactive" in the sense of being a top-level orchestrator rather than a pipeline sub-skill.

---

### Lightweight / Read-Only Skills

These skills are quick, read-only, or one-shot utilities. They may have `context: fork` but do not require isolation for correctness. Either `Skill()` or `Agent()` is acceptable; `Agent()` is preferred when the caller benefits from parallelism or context isolation.

---

#### `bridge-artifact`

- **context**: fork
- **user-invocable**: true
- **AskUserQuestion**: No
- **Classification**: Lightweight/read-only
- **Recommended dispatch**: Either (`Agent()` preferred for isolation)
- **Rationale**: Migrates superpowers artifacts to ralph-hero format. `user-invocable: true` means users invoke it directly. When called from an orchestrator, `Agent()` provides clean isolation. The task is bounded and deterministic.

---

#### `report`

- **context**: fork
- **user-invocable**: not set
- **AskUserQuestion**: No
- **Classification**: Lightweight/read-only
- **Recommended dispatch**: Either (`Agent()` preferred)
- **Rationale**: Generates project status reports and posts them as GitHub Projects V2 status updates. Fully deterministic. `context: fork` signals it was designed for isolated execution. No user interaction.

---

#### `setup-cli`

- **context**: fork
- **user-invocable**: not set
- **AskUserQuestion**: No
- **Classification**: Lightweight/read-only
- **Recommended dispatch**: Either
- **Rationale**: One-shot CLI install operation. `context: fork`, no user questions. Executes a Bash script and reports result. Bounded and deterministic.

---

#### `status`

- **context**: fork
- **user-invocable**: not set
- **AskUserQuestion**: No
- **Classification**: Lightweight/read-only
- **Recommended dispatch**: Either
- **Rationale**: Read-only pipeline dashboard display. Explicitly described as "First read-only skill - no state changes." Quick, bounded, and safe for inline invocation. `context: fork` but trivially lightweight.

---

## Subagent Type Mapping (for Agent() Dispatch)

When dispatching autonomous skills via `Agent()`, use these `subagent_type` values (from GH-637 research):

| Skill | subagent_type |
|-------|---------------|
| `ralph-triage` | `ralph-hero:ralph-analyst` |
| `ralph-research` | `ralph-hero:ralph-analyst` |
| `ralph-plan` | `ralph-hero:ralph-analyst` |
| `ralph-plan-epic` | `ralph-hero:ralph-analyst` |
| `ralph-split` | `ralph-hero:ralph-analyst` |
| `ralph-hygiene` | `ralph-hero:ralph-analyst` |
| `ralph-review` | `ralph-hero:ralph-builder` |
| `ralph-impl` | `ralph-hero:ralph-builder` |
| `ralph-merge` | `ralph-hero:ralph-builder` |
| `ralph-pr` | `ralph-hero:ralph-builder` |
| `ralph-val` | `ralph-hero:ralph-integrator` |

**Note**: There is no `ralph-hero:general-purpose` agent type. Use the role-based types above, or `"general-purpose"` (no plugin prefix) for generic subagents.

## Autonomous Classification Signal

The definitive signal for "autonomous" is the combination:
- `context: fork` — designed for isolated execution
- `user-invocable: false` — not meant for direct human invocation; called by orchestrators

Both conditions together confirm the skill was authored for unattended pipeline execution. A skill with only one signal may still be interactive (e.g., `setup` has `context: fork` but uses `AskUserQuestion` extensively).

The one exception is `ralph-review`, which meets both conditions but has a mode-dependent `AskUserQuestion` usage. This is the only skill requiring caller-side awareness of the mode flag.
