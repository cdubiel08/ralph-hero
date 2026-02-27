---
date: 2026-02-22
status: draft
type: architecture-spec
github_issues: [351]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/351
primary_issue: 351
---

# Ralph Workflow v4 — Architecture Specification

## Overview

This spec defines the foundational architecture for Ralph's autonomous workflow system. It starts from Claude Code's primitives, maps each primitive to its correct concern, identifies where the current system misuses them, and prescribes the corrected architecture for both single-agent (hero) and multi-agent (team) modes, plus interactive human-in-the-loop skills.

This is the authoritative reference. All skills, agents, hooks, and orchestrators derive their behavior from this spec.

## Table of Contents

1. [Claude Code Primitive Taxonomy](#1-claude-code-primitive-taxonomy)
2. [Concern Separation Model](#2-concern-separation-model)
3. [Diagnosed Failures](#3-diagnosed-failures)
4. [Single-Agent Mode (ralph-hero)](#4-single-agent-mode-ralph-hero)
5. [Multi-Agent Mode (ralph-team)](#5-multi-agent-mode-ralph-team)
6. [Interactive Mode (human-in-the-loop)](#6-interactive-mode-human-in-the-loop)
7. [Shared Infrastructure](#7-shared-infrastructure)
8. [Observability Layer](#8-observability-layer)
9. [Implementation Phases](#9-implementation-phases)

---

## 1. Claude Code Primitive Taxonomy

Every behavior in the Ralph system is composed from a small set of Claude Code primitives. This section documents what each primitive **is**, what it **can do**, what it **cannot do**, and its **observed failure modes**.

### 1.1 Task (subagent spawning)

**What it is**: Spawns an isolated subprocess (subagent) to perform work. The subagent gets its own context window and runs independently of the parent.

**Parameters that matter**:
| Parameter | Effect |
|-----------|--------|
| `subagent_type` | Determines agent definition loaded as system prompt. `"general-purpose"` loads nothing; typed agents (e.g., `"ralph-analyst"`) load `agents/ralph-analyst.md` as system prompt |
| `team_name` | Enrolls the subagent as a teammate. The subagent gains access to the team's task list at `~/.claude/tasks/{team-name}/` and can send/receive messages |
| `name` | Sets the teammate's display name (used for `SendMessage` recipient, task ownership) |
| `prompt` | The instruction given to the subagent. This is the **only** content the subagent sees at spawn (plus its agent definition if typed) |
| `run_in_background` | Runs the agent asynchronously. Parent doesn't block. Returns an `output_file` path to check later |
| `isolation: "worktree"` | Gives the subagent an isolated git worktree copy of the repo |

**Can do**:
- Run skills, read/write files, execute bash, call MCP tools (constrained by agent definition's `tools` list)
- Return a single result message to the parent when complete
- Access the team task list if `team_name` is provided

**Cannot do**:
- Stream intermediate results back to the parent (fire-and-forget until completion)
- Share memory or context with the parent (isolated context window)
- Survive session restart (subagents are ephemeral)
- Access a team task list without `team_name` parameter

**Observed failure modes**:
1. **Team context inheritance**: Even WITHOUT explicit `team_name`, sub-agents spawned by a teammate appear to inherit the parent's team context, enrolling as phantom teammates (GH-231). This floods the lead with unrecognizable idle notifications.
2. **`general-purpose` ignores agent definitions**: When `subagent_type="general-purpose"`, no agent `.md` file loads. Role knowledge (tools list, hooks, task loop) in agent definitions is dead code. The subagent operates with default Claude capabilities only.
3. **Prompt is the only instruction channel at spawn**: The subagent doesn't read task descriptions, metadata, or TaskList on its first turn. It only sees the `prompt` parameter. Any context not in the prompt must be discovered by the subagent itself (via TaskGet, Read, etc.).

### 1.2 TaskCreate / TaskList / TaskGet / TaskUpdate

**What they are**: A session-scoped task tracking system. Tasks have subjects, descriptions, metadata, status (pending/in_progress/completed), owners, and blocking relationships.

**Storage**: Tasks live at `~/.claude/tasks/{scope}/` where scope is either the session default or a team name.

**Task fields**:
| Field | Type | Purpose |
|-------|------|---------|
| `subject` | string | Short title. Workers match on keywords for self-claiming |
| `description` | string | Human-readable details. The lead reads this for quick orientation |
| `activeForm` | string | Present-continuous label shown in UI spinner during `in_progress` |
| `metadata` | object | Structured key-value pairs. Machine-readable. Merges on update |
| `status` | enum | `pending` -> `in_progress` -> `completed` (or `deleted`) |
| `owner` | string | Agent name who owns this task |
| `blockedBy` | string[] | Task IDs that must complete before this task can start |
| `blocks` | string[] | Task IDs that this task blocks |

**Can do**:
- Provide a shared work queue visible to all teammates in the same team
- Express sequential dependencies via `blockedBy` chains
- Carry structured results via `metadata` (artifact paths, verdicts, sub-ticket lists)
- Track progress (pending -> in_progress -> completed)

**Cannot do**:
- Push notifications to agents when tasks are created or assigned (there is no event system)
- Be visible across team boundaries (team-A's tasks are invisible to team-B agents)
- Trigger any action on status change (no webhooks or hooks on TaskUpdate itself)

**Atomicity note**: `TaskUpdate(owner=...)` sets the owner field on a single task. A task can only have one owner at a time — the last `TaskUpdate(owner)` call wins. This means self-claiming is safe at the task level: if two workers both call `TaskUpdate(taskId, owner="me")`, only one will be the actual owner. The "race" is that both may START working before checking who won, but the task system itself is consistent. Workers should check `TaskGet` after claiming to verify they are the actual owner before doing expensive work.

**Observed failure modes**:
1. **TaskList invisibility**: Workers spawned into a team cannot see tasks created by the lead. Root cause: team context (`team_name`) may not propagate correctly to the worker's TaskList calls, causing them to read from a different or empty task directory (GH-321, GH-322).
2. **Self-notification waste**: When a worker calls `TaskUpdate(status="completed")`, the SDK fires a notification to the task's `owner` — which is the worker itself. This creates a wasted turn where the worker processes a notification about its own completion (GH-52).
3. **Workers claim blocked tasks**: Creating all pipeline tasks upfront means workers can see future-phase tasks. The `blockedBy` field should prevent claiming, but workers may still read blocked task descriptions and attempt work. Workers must check `blockedBy` status before starting work on a claimed task.

### 1.3 SendMessage

**What it is**: Sends a text message from one teammate to another (or broadcasts to all).

**Types**:
| Type | Behavior |
|------|----------|
| `message` | DM to one specific teammate by name |
| `broadcast` | Same message to ALL teammates (expensive: N messages for N teammates) |
| `shutdown_request` | Ask a teammate to gracefully stop |
| `shutdown_response` | Accept or reject a shutdown request |

**Can do**:
- Wake an idle teammate (receiving a message triggers a new turn)
- Deliver unstructured context that doesn't fit in task metadata
- Request/respond to shutdown

**Cannot do**:
- Guarantee delivery order (messages queue if the recipient is mid-turn)
- Guarantee the recipient reads or acts on the message (the recipient's LLM decides what to do)
- Carry structured data reliably (the recipient must parse free text)
- Provide acknowledgment that the message was received

**Observed failure modes**:
1. **Redundant messaging after assignment**: Lead calls `SendMessage` immediately after `TaskUpdate(owner=...)`, consuming a worker turn for acknowledgment instead of task execution. This doubled the turn cost for every task assignment (GH-321: 30+ redundant messages in one session).
2. **Escalating nudge loops**: When a worker goes idle after receiving a message (normal behavior), the lead interprets the idle notification as "worker didn't get the message" and sends another nudge. This creates 3-4 messages per task before the worker starts working.
3. **Message-as-task-assignment**: Putting full task context in `SendMessage` content bypasses the task system entirely, creating two sources of truth that diverge.
4. **Broadcast spam**: Broadcasting is O(N) per teammate. In a 4-worker team, a broadcast sends 4 messages. Used carelessly, it creates noise proportional to team size.

### 1.4 TeamCreate / TeamDelete

**What they are**: Create and destroy a team scope. Creates directories at `~/.claude/teams/{name}/` and `~/.claude/tasks/{name}/`.

**Can do**:
- Establish a shared task namespace for all teammates
- Create a team config file that teammates can read to discover each other

**Cannot do**:
- Survive session restart (teams are ephemeral, though the directories persist on disk)
- Constrain which agents can join (any subagent spawned with `team_name` joins)
- Provide team-level events (no hook for "teammate joined" or "team created")

**Observed failure modes**:
1. **Tasks before TeamCreate**: Tasks created before `TeamCreate` go into the session default scope, not the team scope. Workers spawned with `team_name` can't see them (GH-322 root cause).
2. **Stale team directories**: If a session crashes, team/task directories persist on disk. A new session may find stale tasks from a previous session.

### 1.5 Hooks (Stop, TaskCompleted, TeammateIdle, PreToolUse, PostToolUse)

**What they are**: Shell scripts that execute in response to lifecycle events. They receive JSON input on stdin and communicate via exit codes and stderr.

**Exit codes**:
| Code | Meaning |
|------|---------|
| 0 | Allow the action to proceed |
| 2 | Block the action; stderr text is injected as guidance to the agent |

**Hook types relevant to team orchestration**:
| Hook | Fires when | Available to |
|------|-----------|--------------|
| `Stop` | An agent attempts to stop (end its turn or session) | Any agent (defined in agent frontmatter or skill frontmatter) |
| `TaskCompleted` | A teammate marks a task as completed | Team lead only (defined in skill frontmatter) |
| `TeammateIdle` | A teammate goes idle (end of their turn) | Team lead only (defined in skill frontmatter) |
| `PreToolUse` | Before any tool call | Any agent |
| `PostToolUse` | After any tool call | Any agent |
| `SessionStart` | When a session begins | Any agent |

**Can do**:
- Block an action (exit 2) with injected guidance
- Provide information to the agent via stderr (exit 0)
- Read the event context via stdin JSON (tool name, parameters, teammate name, etc.)
- Execute arbitrary shell commands (check git state, query APIs, read files)

**Cannot do**:
- Modify the agent's state or context directly (can only inject stderr guidance)
- Guarantee the agent follows the injected guidance (LLM-discretionary)
- Fire on task list changes (no hook for TaskCreate, TaskUpdate, or TaskList)
- Communicate with other agents (hooks are per-agent, no cross-agent signaling)

**Observed failure modes**:
1. **Guidance overload**: `team-task-completed.sh` injects multi-line guidance on every task completion ("Consider checking pipeline convergence via detect_pipeline_position. If the phase has converged..."). The lead treats each firing as an urgent action item, creating reactive checking loops.
2. **Idle notification misinterpretation**: `team-teammate-idle.sh` fires after every teammate turn (normal behavior). Prior versions included "Peers will wake this teammate" which created incorrect expectations. Current version is minimal but the lead still over-reacts to idle notifications.
3. **Re-entry loops**: Without the `stop_hook_active` safety pattern, a Stop hook that blocks (exit 2) can create an infinite loop: agent tries to stop -> hook blocks -> agent tries again -> hook blocks again. The re-entry safety (check a field, allow on second attempt) is critical.
4. **Hook guidance is advisory**: Even when a hook injects "check TaskList for more work", the agent may ignore it, misinterpret it, or do something entirely different. Hooks cannot force specific tool calls.

### 1.6 Skills (SKILL.md)

**What they are**: Markdown files that define a complete procedure for one workflow phase. When invoked via `Skill(skill="ralph-hero:ralph-research", args="42")`, the skill's content loads as instructions for the current agent.

**Frontmatter fields**:
| Field | Purpose |
|-------|---------|
| `description` | User-facing description (shown in `/` autocomplete) |
| `argument-hint` | Placeholder text for arguments |
| `model` | Which Claude model to use |
| `allowed_tools` | Tool whitelist (constrains what the skill can access) |
| `env` | Environment variables set when the skill runs |
| `hooks` | Lifecycle hooks specific to this skill |
| `context: fork` | Run in isolated subprocess (autonomous skills use this) |

**Can do**:
- Define a complete, self-contained procedure for one workflow phase
- Constrain available tools via `allowed_tools`
- Set environment variables that hooks can read
- Be invoked by users (`/ralph-hero:ralph-research 42`) or by agents (`Skill(...)`)
- Spawn sub-agents via `Task()` for parallel work

**Cannot do**:
- Return structured data to the caller (output is unstructured text)
- Communicate with other skills (each runs in isolation)
- Persist state across invocations (stateless by design)
- Force the agent to follow every instruction (LLM-discretionary)

**Observed failure modes**:
1. **Sub-agent team pollution**: Skills that spawn `Task()` sub-agents for research (codebase-locator, thoughts-locator, etc.) inadvertently pass team context, creating phantom teammates (GH-231, fixed but demonstrates the pattern).
2. **Context window saturation**: Skills loaded into a worker's context compete with the agent definition, spawn template, and task description for context space. Long skills (300+ lines) can crowd out working memory.
3. **`context: fork` vs inline**: Autonomous skills use `context: fork` for isolation. Interactive skills must NOT use this because they need to maintain conversation with the user. This is a fundamental split in skill design.

### 1.7 Agents (agent .md files)

**What they are**: Markdown files that define an agent's identity, available tools, model, and behavior. When a subagent is spawned with `subagent_type="ralph-analyst"`, the agent file loads as the system prompt.

**Frontmatter fields**:
| Field | Purpose |
|-------|---------|
| `name` | Agent identity |
| `description` | What this agent does |
| `tools` | Tool whitelist (what the agent CAN call) |
| `model` | Which Claude model |
| `color` | UI indicator |
| `hooks` | Lifecycle hooks (especially `Stop`) |

**Can do**:
- Define role-specific tool access (analyst gets MCP tools for issue management; builder gets Read/Write/Edit)
- Load Stop hooks that fire when the agent tries to end its turn
- Provide role knowledge as system prompt (skill dispatch, task loop, shutdown behavior)

**Cannot do**:
- Be loaded if `subagent_type="general-purpose"` (the agent definition is dead code in that case)
- Override the spawn `prompt` (agent definition is system prompt; spawn prompt is user message)
- Communicate its own existence to other agents (no "I am an analyst" broadcast)

**Key architectural constraint**: The `tools` list in agent frontmatter is the ENFORCED whitelist. If a tool isn't listed, the agent cannot call it. This means: agent definitions must list all MCP tools their skills need (ADR-001: "Do NOT remove MCP tools from agent definitions — PR #57 proved this breaks skill execution").

### 1.8 Primitive Composition Rules

Based on observed behavior and failure modes, these are the **correct** composition patterns:

| Pattern | Correct | Incorrect |
|---------|---------|-----------|
| Assign work to a worker | `TaskUpdate(owner=...)` | `SendMessage` with task details |
| Worker discovers work | `TaskList` -> `TaskGet` | Parsing `SendMessage` content |
| Worker reports results | `TaskUpdate(metadata={...})` | `SendMessage` with free text |
| Wake an idle worker | `SendMessage` (only if needed) | Re-spawning a new agent |
| Prevent premature stop | Stop hook (exit 2) | `SendMessage("don't stop")` |
| Isolate sub-agent from team | Omit `team_name` in `Task()` | No reliable alternative |
| Sequential execution | `blockedBy` relationships | Manual ordering in orchestrator |
| Parallel execution | Multiple `Task()` calls without `blockedBy` | `run_in_background=true` (less reliable) |
| Share context between phases | Task `metadata` + GitHub issue comments | `SendMessage` chains |
| Role-specific behavior | Typed `subagent_type` | Instructions in spawn `prompt` |

---

## 2. Concern Separation Model

The Ralph workflow has five distinct concerns. Each concern maps to specific primitives. When a primitive is used for the wrong concern, failures occur.

### 2.1 The Five Concerns

```
┌─────────────────────────────────────────────────────────────────┐
│                    CONCERN SEPARATION MODEL                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ORCHESTRATION         Who creates tasks, who routes work        │
│  Primitives: TaskCreate, TaskUpdate, TaskList, detect_*          │
│  Owner: Orchestrator skill (ralph-team, ralph-hero)              │
│                                                                  │
│  EXECUTION             Who does work, how skills are invoked     │
│  Primitives: Skill(), Task(subagent), Read/Write/Edit/Bash       │
│  Owner: Worker agents + Skills                                   │
│                                                                  │
│  COMMUNICATION         How agents exchange information           │
│  Primitives: TaskUpdate(metadata), SendMessage (exceptions)      │
│  Owner: Convention (shared/conventions.md)                        │
│                                                                  │
│  LIFECYCLE             Spawn, idle, wake, stop, shutdown          │
│  Primitives: Task(spawn), Stop hook, TeammateIdle, shutdown_*    │
│  Owner: Agent definitions (frontmatter) + Hooks                  │
│                                                                  │
│  MEMORY                Where state lives, how it's discovered    │
│  Primitives: GitHub Issues, thoughts/ files, Artifact Comments   │
│  Owner: MCP tools + Artifact Comment Protocol                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Concern Violations in Current System

| Violation | Concern Crossed | Current Behavior | Correct Behavior |
|-----------|----------------|------------------|------------------|
| Lead sends `SendMessage` after `TaskUpdate(owner=...)` | Orchestration -> Communication | Dual-channel assignment | `TaskUpdate(owner)` is the only assignment |
| Spawn templates include "check TaskList for more work" | Execution -> Orchestration | Workers self-orchestrate | Stop hook handles work discovery |
| Task descriptions carry research findings | Communication -> Memory | Context in ephemeral task | Context in GitHub comments + thoughts/ files |
| Workers claim tasks from wrong phase | Execution boundary | Workers start blocked tasks | Workers must verify `blockedBy` is empty before starting work |
| Hooks inject multi-line orchestration guidance | Lifecycle -> Orchestration | Hook tells lead what to do | Hook blocks/allows; lead decides |
| Workers spawned as `general-purpose` | Lifecycle: agent identity | Role knowledge is dead code | Typed agents load role knowledge |
| `SendMessage` carries task context | Communication -> Orchestration | Message-as-task-assignment | Task description + metadata |

### 2.3 Layer Architecture (from v3 epic, validated)

```
Layer 5: Entry Points      → CLI scripts, user slash commands
Layer 4: Orchestrators      → ralph-hero, ralph-team (route work, never implement)
Layer 3: Skills             → Self-contained, forked, self-validating execution units
Layer 2: Agents             → Thin wrappers: identity + tools + hooks + task loop
Layer 1: MCP Tools          → Raw GitHub API operations (no business logic)
```

**Downward delegation only**: Each layer delegates to the layer below. No layer skips levels. Orchestrators never call MCP tools for mutation (read-only queries for state detection are allowed). Skills never spawn other skills. Agents invoke exactly one skill per task.

---

## 3. Diagnosed Failures

Nine systemic failures have been documented across GH-52, GH-200, GH-218, GH-230, GH-231, GH-321, GH-322. Each failure maps to a specific concern violation from Section 2.2.

### 3.1 TaskList Invisibility (GH-321, GH-322) — CRITICAL

**Symptom**: Workers can't see tasks in TaskList. Lead assigns tasks, workers report empty TaskList.
**Root cause**: Team context may not propagate correctly to spawned agents' TaskList calls. Tasks created by the lead go to `~/.claude/tasks/{team-name}/` but workers may read from a different directory.
**Impact**: Complete pipeline stall. Workers fail to pick up any work without manual SendMessage nudges.
**Fix**: Verify team_name flows through Task() -> agent -> TaskList. Add defensive TaskList check in spawn template as first action. Include team_name in task metadata for debugging. If TaskList is empty on first check, retry once after a brief pause.

### 3.2 Redundant Messaging (GH-321, GH-322) — HIGH

**Symptom**: Lead sends 30+ messages per session. Every task assignment followed by a SendMessage.
**Root cause**: SKILL.md doesn't enforce "assignment is the only communication." Section 5 says "don't nudge" but Section 6 dispatch loop doesn't prevent it.
**Impact**: 2x turn cost per task. Workers process acknowledgment instead of doing work.
**Fix**: Hard rule in SKILL.md: "After TaskUpdate(owner=...), STOP. Do not call SendMessage. The task assignment is complete." Remove all SendMessage calls from the dispatch loop except for: direct responses to worker questions, escalation notifications, shutdown requests.

### 3.3 Self-Notification Waste (GH-52) — MEDIUM

**Symptom**: Workers receive a notification about their own task completion.
**Root cause**: SDK fires TaskCompleted event to the task's `owner`. Worker is its own owner.
**Impact**: ~1 wasted turn per task completion (5+ per pipeline).
**Fix**: Cannot be fixed at the plugin level (SDK behavior). Mitigate by documenting in agent definitions: "Ignore notifications about tasks you just completed."

### 3.4 Sub-Agent Team Pollution (GH-231) — FIXED

**Symptom**: Internal sub-agents (codebase-locator, etc.) appear as phantom teammates.
**Root cause**: `Task()` calls within skills inherited parent's team context.
**Fix**: ADR-001 in conventions.md: "Never pass team_name to internal Task() calls." Applied across all skills. Verified closed.

### 3.5 Self-Claiming Reliability (GH-200) — MEDIUM

**Symptom**: Concern that multiple workers might claim the same task.
**Analysis**: `TaskUpdate(owner=...)` sets owner atomically per-task — a task can only have one owner. The "race" is that two workers may both START work before verifying ownership. With typical team sizes (1 worker per role), same-role races are uncommon. At 2-3 workers per role, the window exists but is manageable.
**Impact**: Low at typical team sizes. Potentially wasteful at 3+ same-role workers.
**Fix**: Self-claim is the PRIMARY model. Workers call `TaskUpdate(owner="me")` then `TaskGet` to verify they are the actual owner before doing expensive work (skill invocation). If another worker won the claim, the losing worker skips that task and looks for the next unclaimed one. Lead pre-assigns the FIRST task before spawn; subsequent tasks use self-claim via Stop hook.

### 3.6 Over-Eager Hook Guidance (GH-321) — MEDIUM

**Symptom**: Lead treats every hook firing as requiring immediate action.
**Root cause**: Hook stderr text uses directive language ("Consider checking...", "ACTION:"). Lead interprets guidance as commands.
**Impact**: Reactive checking loops. Lead calls detect_pipeline_position after every single task completion, even when convergence is obviously not met.
**Fix**: Minimal hook guidance. Hooks should either block (exit 2) or pass (exit 0) with one-line factual context. No multi-step instructions. No "Consider doing X." The orchestrator skill (SKILL.md) owns the decision logic, not the hooks.

### 3.7 Conflicting Handoff Models (GH-218) — HIGH

**Symptom**: Three different instructions for what workers do after completing a task.
**Root cause**: Spawn templates say "check TaskList", conventions.md says "peer-to-peer handoff", idle hook says "peers will wake."
**Impact**: Inconsistent worker behavior. Some workers loop indefinitely, some stop immediately, some try to message peers.
**Fix**: One model: **upfront task list with self-claim**. All pipeline tasks are created at session start with `blockedBy` chains. Workers complete their task, mark it done, and the Stop hook checks TaskList for more unclaimed/unblocked tasks matching their role. If matching work exists, the worker self-claims and continues. If not, the worker goes idle. No peer-to-peer handoffs. No lead-driven bough advancement. The task list IS the work queue.

### 3.8 Diverged Orchestrator Modes — MEDIUM

**Symptom**: `ralph-hero` (solo, sequential with `run_in_background`) and `ralph-team` (multi-agent with teams) share no common architecture. Different task models, different agent spawning, different lifecycle management.
**Root cause**: Hero was designed for Linear integration in workspace commands; team was designed independently for GitHub in the plugin. They evolved separately.
**Impact**: Fixes in one mode don't transfer to the other. Behavioral knowledge is duplicated.
**Fix**: Shared foundation: both modes use the same skills, same conventions, same agent definitions, and the same upfront task list pattern. Hero mode = orchestrator without TeamCreate (uses Task() for parallel work, TaskList for tracking). Team mode = orchestrator with TeamCreate (uses typed agents, self-claim, upfront task list with blockedBy).

### 3.9 No Observability — LOW (but compounds other issues)

**Symptom**: Errors vanish after session ends. No way to detect recurring patterns.
**Root cause**: No structured telemetry capture.
**Impact**: Same failures repeat across sessions. Fixes are based on anecdotal observation, not data.
**Fix**: Debug mode spec (Layer 1: capture, Layer 2: collation, Layer 3: metrics). Already spec'd in `thoughts/shared/plans/2026-02-21-debug-mode-observability-spec.md`.

---

## 4. Single-Agent Mode (ralph-hero)

### 4.1 Design Principles

Hero mode is a **solo orchestrator** that processes an issue tree end-to-end. It delegates work to forked subagents (not teammates) and uses TaskList for progress tracking.

```
Hero Orchestrator (one agent)
  ├── Task(subagent) for split work
  ├── Task(subagent) for research work (parallel)
  ├── Task(subagent) for planning
  ├── Task(subagent) for implementation (sequential)
  └── Direct git/gh commands for PR creation
```

**Key differences from team mode**:
- No `TeamCreate` — no team task list, no teammate messaging
- Uses `run_in_background=true` for parallel work (research phase)
- Uses standard `Task()` with blocking for sequential work
- Orchestrator creates all tasks upfront with `blockedBy` chains (the original `ralph_hero.md` pattern)
- Resumable: re-invocation checks TaskList state and continues from where it left off

### 4.2 Task Model

Hero mode uses the **upfront task list** pattern from the workspace `ralph_hero.md` command:

1. Detect pipeline position via `detect_pipeline_position`
2. Create ALL tasks for the remaining pipeline with `blockedBy` dependencies
3. Execute unblocked tasks in a loop: find unblocked -> mark in_progress -> spawn subagent -> mark completed
4. Parallel execution: multiple unblocked tasks spawn concurrently
5. Sequential execution: `blockedBy` chains prevent out-of-order execution

This works for hero mode because:
- There's only one orchestrator reading the task list (no race conditions)
- Subagents are forked (not teammates), so they don't see the task list
- The orchestrator manages all task state transitions

### 4.3 Subagent Spawning

Hero mode spawns `general-purpose` subagents (not typed agents). This is intentional:
- Subagents don't need team task list access
- Subagents invoke skills directly via `Skill(skill="ralph-hero:ralph-research", args="42")`
- The skill provides all necessary context (agent definitions are unnecessary for forked work)
- No Stop hook needed (subagent does one task and returns)

### 4.4 State Machine

```
START
  │
  ▼
DETECT PIPELINE POSITION
  │
  ├── SPLIT (if M/L/XL exist)
  │   └── Parallel Task() subagents for each oversized issue
  │   └── Re-detect after all splits complete
  │
  ├── RESEARCH (if "Research Needed" leaves exist)
  │   └── Parallel Task() subagents (run_in_background=true)
  │   └── Wait for all to complete
  │
  ├── PLAN (if "Ready for Plan")
  │   └── Single Task() subagent per group
  │   └── Auto-review if RALPH_REVIEW_MODE=auto
  │
  ├── HUMAN GATE (if RALPH_AUTO_APPROVE=false)
  │   └── Report plan URLs, STOP
  │
  ├── IMPLEMENT (if "In Progress")
  │   └── Sequential Task() subagents (blockedBy chain)
  │   └── Each waits for prior to complete
  │
  └── COMPLETE (if all "In Review")
      └── Report PR URLs
```

### 4.5 What Changes from Current ralph-hero Skill

| Aspect | Current | v4 |
|--------|---------|------|
| Pipeline detection | `detect_pipeline_position` MCP tool | Same (works well) |
| Task creation | Per-phase, no upfront list | Upfront task list with blockedBy (from workspace command pattern) |
| Subagent type | `general-purpose` | Same (correct for hero mode) |
| Parallel research | `run_in_background=true` | Same |
| Sequential impl | Manual ordering in orchestrator | `blockedBy` chain in task list |
| Resumability | Re-detect pipeline position | Re-detect + check existing task list |
| Group handling | Per-group plans via `detect_group` | Same |
| Stream detection | Not in current hero | Add: stream detection post-research for groups >= 3 |

---

## 5. Multi-Agent Mode (ralph-team)

### 5.1 Design Principles

Team mode is a **lead-worker orchestrator** that spawns typed agent teammates to process issues in parallel. The lead creates the team, spawns the expected roster, builds an upfront task list with `blockedBy` chains, and then workers self-claim from the shared queue.

```
Team Lead (ralph-team skill)
  │
  ├── 1. TeamCreate (shared task namespace)
  │
  ├── 2. Spawn full roster (workers go idle immediately)
  │   ├── Task(subagent_type="ralph-analyst", team_name=..., name="analyst")
  │   ├── Task(subagent_type="ralph-builder", team_name=..., name="builder")
  │   ├── Task(subagent_type="ralph-validator", team_name=..., name="validator")
  │   └── Task(subagent_type="ralph-integrator", team_name=..., name="integrator")
  │
  ├── 3. Create upfront task list with blockedBy chains
  │   ├── "Research GH-42" (unblocked)
  │   ├── "Research GH-43" (unblocked)
  │   ├── "Plan group GH-42" (blockedBy: research tasks)
  │   ├── "Review plan for GH-42" (blockedBy: plan task)
  │   ├── "Implement GH-42" (blockedBy: review task)
  │   ├── "Create PR for GH-42" (blockedBy: implement task)
  │   └── "Merge PR for GH-42" (blockedBy: PR task)
  │
  └── 4. Pre-assign first unblocked tasks to spawned workers
      └── Workers self-claim subsequent tasks via Stop hook
```

### 5.2 Upfront Task List Model (replaces Bough Model)

**Core idea**: Create ALL pipeline tasks at session start with `blockedBy` dependency chains. Workers can see the full pipeline but can only work on unblocked tasks. This is the same pattern used by hero mode and the workspace `ralph_hero.md` command.

**Why this replaces the bough model**:
- **Simpler**: No convergence detection, no bough advancement logic, no lead-driven task creation mid-pipeline
- **More visible**: The full pipeline is visible from the start — progress tracking is natural
- **Self-service**: Workers self-claim unblocked tasks matching their role without needing the lead to create and assign work
- **Resumable**: On re-invocation, the task list state shows exactly where the pipeline is

**Example upfront task list** (group of 3 issues):
```
[T-1] ○ Research GH-42       (pending, unblocked)          → analyst
[T-2] ○ Research GH-43       (pending, unblocked)          → analyst
[T-3] ○ Research GH-44       (pending, unblocked)          → analyst
[T-4] ○ Plan group GH-42     (pending, blockedBy: T-1,T-2,T-3) → builder
[T-5] ○ Review plan GH-42    (pending, blockedBy: T-4)     → validator
[T-6] ○ Implement GH-42      (pending, blockedBy: T-5)     → builder
[T-7] ○ Create PR for GH-42  (pending, blockedBy: T-6)     → integrator
[T-8] ○ Merge PR for GH-42   (pending, blockedBy: T-7)     → integrator
```

The `→ role` annotations are NOT task owners — they indicate which role will claim the task. Tasks start unowned. The lead pre-assigns the first batch of unblocked tasks before spawning workers; subsequent tasks are self-claimed via the Stop hook.

### 5.3 Startup Sequence

The startup sequence is strictly ordered:

```
1. TeamCreate(team_name="ralph-team-GH-NNN")
   — Creates shared task namespace FIRST

2. detect_pipeline_position(number=NNN)
   — Determines current phase, group membership, issue states
   — Returns suggestedRoster for team sizing

3. Spawn full roster based on suggestedRoster
   — Each worker spawned with team_name, goes idle immediately
   — Workers have no task yet — they wait for the task list

4. Create ALL pipeline tasks with blockedBy chains
   — All tasks visible to all workers from this point

5. Pre-assign first unblocked tasks to matching workers
   — TaskUpdate(owner="analyst") for research tasks
   — Workers discover their assignment via TaskList (Stop hook wakes them)
```

**Why spawn before tasks**: Workers need to exist in the team before tasks are created so that:
- The Stop hook can check TaskList and find the tasks
- Workers' idle notification triggers the lead to check if tasks are ready
- No timing gap where tasks exist but no workers are available

### 5.4 Roster Sizing

The `detect_pipeline_position` tool returns a `suggestedRoster` field that recommends how many workers to spawn per role based on issue complexity:

```json
{
  "suggestedRoster": {
    "analyst": 1,      // 1 for single issue; 2 for groups of 3-5; 3 for 6+
    "builder": 1,      // 1 always; 2 only if streams > 1 with non-overlapping files
    "validator": 1,    // always 1 (automated review station)
    "integrator": 1    // always 1 (serialized on main branch)
  }
}
```

**Heuristic formula** (to be implemented in `pipeline-detection.ts`):

| Role | Base | Scale factor | Max |
|------|------|-------------|-----|
| `analyst` | 1 | +1 per 3 group members needing research | 3 |
| `builder` | 1 | +1 per independent work stream (from `detect_work_streams`) | 3 |
| `validator` | 1 | Fixed — automated review is serial | 1 |
| `integrator` | 1 | Fixed — git operations must serialize on main | 1 |

**Inputs to the heuristic** (all already available in `detect_pipeline_position` response):
- `issues[].estimate` — sizing signal per issue
- `issues.length` — total issues in group
- `isGroup` — single vs multi-issue
- `convergence.blocking.length` — how many issues are not yet ready
- `totalStreams` (from `detect_work_streams` if called) — independent parallel units

**When `RALPH_REVIEW_MODE=interactive`**: The validator station becomes human-in-the-loop instead of automated. The validator worker still spawns but reports and STOPS at the plan review gate, waiting for human approval.

### 5.5 Self-Claim Protocol

**Self-claim is the PRIMARY work discovery model.** Workers find their own work from the shared task list.

**First task**: Lead pre-assigns via `TaskUpdate(owner="analyst")` before spawning. Worker discovers it via TaskList on first turn.

**Subsequent tasks**: Worker's Stop hook fires after task completion. The hook checks TaskList for:
1. **Priority 1**: Unblocked tasks already owned by this worker (shouldn't happen normally, but catches edge cases)
2. **Priority 2**: Unblocked, unclaimed tasks matching this worker's role keywords

If a matching task is found, the hook blocks stop (exit 2) with guidance to claim and execute. The worker calls `TaskUpdate(owner="me")` to claim, then `TaskGet` to verify ownership, then executes.

**Claim verification**: After calling `TaskUpdate(owner="analyst")`, the worker calls `TaskGet` to confirm it is the actual owner. If another worker claimed it first, skip and look for the next unclaimed task. This handles the rare case of two same-role workers stopping simultaneously.

```
Worker completes task
  │
  ▼
TaskUpdate(status="completed", metadata={...})
  │
  ▼
Stop hook fires (worker-stop-gate.sh)
  │ Checks TaskList for unblocked, unclaimed tasks matching role
  ├── FOUND → exit 2: "Pending tasks exist for your role."
  │   │
  │   ▼
  │   Worker claims: TaskUpdate(owner="analyst")
  │   Worker verifies: TaskGet → check owner field
  │   Worker executes: Skill(...)
  │   Worker reports: TaskUpdate(status="completed")
  │   └── Stop hook fires again → cycle continues
  │
  └── NOT FOUND → exit 0 (allow stop)
      │
      ▼
    Worker goes IDLE
      │
      ├── Lead assigns new task + SendMessage wake → cycle resumes
      └── shutdown_request → SHUTDOWN
```

### 5.6 Communication Rules

**TaskUpdate is the primary channel. SendMessage is for exceptions.**

| Action | Primitive | Example |
|--------|-----------|---------|
| Pre-assign first task | `TaskUpdate(owner=...)` | `TaskUpdate(taskId=T-1, owner="analyst")` — before spawn |
| Self-claim subsequent task | `TaskUpdate(owner=...)` | Worker claims from TaskList via Stop hook |
| Report results | `TaskUpdate(metadata={...})` | `TaskUpdate(taskId=T-1, metadata={"artifact_path": "thoughts/..."})` |
| Worker progress | `TaskUpdate(description=...)` | Update description with progress notes |
| Wake idle worker for new work | `SendMessage` | ONLY after new tasks become available for an idle worker |
| Escalation | `SendMessage` | Blocking discovery, question not answerable from task description |
| Nudge | NEVER | If worker is idle with an assigned task, check TaskList visibility first |

**Anti-patterns to enforce**:
- `SendMessage` immediately after `TaskUpdate(owner=...)` → FORBIDDEN (task assignment is the communication)
- `SendMessage` with task details in content → FORBIDDEN (put context in TaskCreate description)
- `broadcast` for anything other than critical blocking issues → FORBIDDEN
- `SendMessage` to acknowledge receipt of a task → FORBIDDEN (just start working)
- Lead creating tasks mid-pipeline → FORBIDDEN (all tasks created upfront)

### 5.7 Worker Lifecycle

```
SPAWNED (roster member, no task yet)
  │
  ▼
STOP HOOK FIRES (immediately — worker has nothing to do)
  │ Checks TaskList for pre-assigned or unclaimed matching tasks
  ├── FOUND → Block stop, worker claims and executes
  └── NOT FOUND → Allow stop, worker goes idle (waiting for task list to be built)
        │
        ▼
      IDLE (normal — tasks may not be created yet)
        │
        ├── Lead finishes task list creation
        │   Lead pre-assigns first batch → SendMessage to wake idle workers
        │   Worker checks TaskList → finds owned task → executes
        │
        ├── Stop hook catches self-claimed work after task completion
        │   → Worker continues without going idle
        │
        └── shutdown_request → SHUTDOWN
```

### 5.8 Hook Behavior (Minimal, Factual)

**team-task-completed.sh** (exit 0, guidance only):
```
Task completed by {teammate}: "{subject}"
```
One line. No multi-step instructions. The orchestrator skill (SKILL.md) owns the decision logic.

**team-teammate-idle.sh** (exit 0, guidance only):
```
{teammate} is idle.
```
One line. No "consider" or "action" language.

**team-stop-gate.sh** (exit 0 or 2):
```
If GitHub has processable issues → exit 2: "GitHub has N processable issues."
Else → exit 0 (allow stop)
```
No step-by-step instructions. Just a fact and a block/allow.

**worker-stop-gate.sh** (exit 0 or 2):
```
If TaskList has owned or unclaimed unblocked tasks matching role → exit 2: "Pending tasks exist for your role."
Else → exit 0 (allow stop)
```
Same pattern: one fact, block or allow. The hook must check `blockedBy` status — only truly unblocked tasks count.

### 5.9 Typed Agent Definitions

Each worker is spawned as a typed agent. Agent definitions are minimal (20-35 lines):

```markdown
---
name: ralph-analyst
tools: [Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__*]
model: sonnet
hooks:
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/worker-stop-gate.sh"
---

You are an **ANALYST** in the Ralph Team.

## Task Loop

1. Check TaskList for tasks owned by you or unclaimed tasks matching your role (Research, Split, Triage)
2. Claim if unclaimed: TaskUpdate(owner="analyst"), then TaskGet to verify ownership
3. Read task description — it has GitHub URLs, artifact paths, group context
4. Invoke the matching skill (Triage → ralph-triage, Split → ralph-split, Research → ralph-research)
5. Report results via TaskUpdate with structured metadata
6. Stop hook checks for more work — cycle continues automatically

TaskUpdate is your primary channel. SendMessage is for escalations only.
```

### 5.10 Spawn Template

One template (`templates/spawn/worker.md`) for all roles. Investigation needed (Phase 0) to determine if the current minimal template is sufficient or needs enhancement. Current template:

```
{TASK_VERB} GH-{ISSUE_NUMBER}: {TITLE}.
{TASK_CONTEXT}

Invoke: {SKILL_INVOCATION}

Report via TaskUpdate: "{REPORT_FORMAT}"
```

6-8 lines after substitution. The agent definition (loaded as system prompt via typed `subagent_type`) provides the task loop, claiming behavior, and role constraints. The template provides the specific task directive.

**Open question for Phase 0**: When workers are spawned before tasks exist (roster-first model), the template's `{TASK_VERB}` and `{ISSUE_NUMBER}` may need to be generic ("Check TaskList for your first assignment") rather than task-specific. Alternatively, the lead can delay spawning until after the first batch of tasks is created and pre-assigned. Investigation needed.

### 5.11 What Changes from Current ralph-team Skill

| Aspect | Current (v3) | v4 |
|--------|-------------|------|
| Task creation | Bough model (current phase only) | **Upfront task list** with blockedBy chains (all phases at once) |
| Convergence detection | Lead checks `detect_pipeline_position` after each phase | Not needed — blockedBy chains handle ordering |
| Worker spawning | On-demand as tasks are created | **Full roster at session start** based on `suggestedRoster` |
| Roster sizing | Manual (lead decides how many) | **Heuristic formula** in `detect_pipeline_position` |
| First task assignment | Pre-assigned before spawn | Pre-assigned before spawn (same) |
| Subsequent task assignment | Lead assigns at bough advancement | **Workers self-claim** via Stop hook |
| SendMessage after assignment | Common (30+ per session) | Forbidden except for waking idle workers for genuinely new work |
| Hook guidance | Multi-line with "Consider..." | One-line factual statements |
| Lead's dispatch loop | Active: check convergence, create boughs, assign workers | **Passive**: monitor task completions, handle escalations, shutdown when done |
| Validator station | Only if `RALPH_REVIEW_MODE=interactive` | **Always spawned** (automated review by default, human gate if interactive) |
| Stream detection | Post-research for groups >= 3 | Same |

---

## 6. Interactive Mode (human-in-the-loop)

### 6.1 Design Principles

Interactive skills run **inline** in the user's session. They maintain a conversation, ask questions, and orchestrate work collaboratively. They are fundamentally different from autonomous skills.

```
User Session
  ├── /ralph-hero:create-plan #42
  │   └── Skill runs inline (no fork)
  │   └── Reads issue, researches codebase
  │   └── Asks user questions via AskUserQuestion
  │   └── Spawns sub-agents via Task() (no team_name)
  │   └── Writes plan document
  │   └── Links to GitHub issue
  │
  ├── /ralph-hero:implement-plan #42
  │   └── Finds plan via Artifact Comment Protocol
  │   └── Implements phase-by-phase with pauses
  │   └── Human verifies each phase before continuing
  │
  └── /ralph-hero:draft-idea
      └── Quick capture, 2-3 questions, saves to thoughts/ideas/
```

### 6.2 Interactive vs Autonomous Skills

| Aspect | Interactive | Autonomous |
|--------|-------------|------------|
| Context | `context: fork` ABSENT (inline) | `context: fork` (isolated) |
| Conversation | Maintains back-and-forth with user | No user interaction |
| Hooks | Minimal or none | PreToolUse/PostToolUse/Stop |
| `RALPH_COMMAND` env | Not set (bypasses state gates) | Set (activates hook validation) |
| `allowed_tools` | Broad (needs Read, Write, Edit, Bash, Task, WebSearch, etc.) | Constrained to phase needs |
| Sub-agent spawning | `Task()` without team_name | Same |
| State transitions | Offered to user, not automatic | Automatic via skills |
| Error handling | Ask user what to do | Escalate via GitHub comment |

### 6.3 The Six Interactive Skills

| Skill | Purpose | Key Behavior |
|-------|---------|-------------|
| `draft-idea` | Quick idea capture | 2-3 questions, saves to `thoughts/shared/ideas/`, suggests `/form-idea` next |
| `form-idea` | Crystallize idea into ticket | Reads idea file, researches duplicates, creates GitHub issue(s) |
| `research-codebase` | Deep codebase investigation | Spawns parallel sub-agents, synthesizes findings, saves research doc |
| `create-plan` | Interactive planning | Research → questions → structure → detailed plan → GitHub linking |
| `iterate-plan` | Modify existing plan | Finds plan via Artifact Comment Protocol, confirms approach, surgical updates |
| `implement-plan` | Phase-by-phase execution | Finds plan, sets up worktree, implements with manual verification pauses |

### 6.4 Common Frontmatter Pattern

```yaml
---
description: [user-facing description]
argument-hint: [optional args]
model: opus
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - WebSearch
  - WebFetch
env:
  RALPH_GH_OWNER: "${RALPH_GH_OWNER}"
  RALPH_GH_REPO: "${RALPH_GH_REPO}"
  RALPH_GH_PROJECT_NUMBER: "${RALPH_GH_PROJECT_NUMBER}"
---
```

No `context: fork`. No `RALPH_COMMAND`. No hooks (or minimal hooks). Full tool access.

### 6.5 GitHub Integration Adaptations

All interactive skills convert from the workspace Linear patterns to GitHub:
- `mcp__plugin_linear_linear__*` → `ralph_hero__*` tool calls
- `LAN-NNN` → `#NNN` issue references
- `GH-NNNN` file naming pattern (zero-padded)
- Artifact Comment Protocol for linking docs to issues
- State transitions offered to user (not automatic)

---

## 7. Shared Infrastructure

### 7.1 Conventions (shared/conventions.md)

Single source of truth for cross-cutting protocols. Changes needed:

| Section | Change |
|---------|--------|
| Identifier Disambiguation | Keep as-is |
| TaskUpdate Protocol | Strengthen: "SendMessage ONLY for waking idle workers and escalations" |
| Escalation Protocol | Keep as-is |
| Link Formatting | Keep as-is |
| Error Handling | Keep as-is |
| Pipeline Handoff Protocol | **Rewrite**: Upfront task list with self-claim. Remove peer-to-peer. Remove "Do NOT assign tasks mid-pipeline". Remove bough advancement. Workers self-claim from shared queue via Stop hook |
| Spawn Template Protocol | **Simplify**: Reference single worker.md, document placeholder substitution |
| Work Streams | Keep as-is |
| Skill Invocation Convention | Keep as-is |
| Sub-Agent Team Isolation | Keep as-is |
| ADR-001 Architecture | Keep as-is |
| Artifact Comment Protocol | Keep as-is |

**New section**: "Communication Discipline"
```
## Communication Discipline

### The Assignment Rule
After TaskUpdate(owner=...) for a worker's FIRST task (before spawn), do NOT SendMessage.
After TaskUpdate(owner=...) for a NEWLY ASSIGNED task to an IDLE worker, SendMessage to wake them.
After TaskUpdate(owner=...) in any other case, do NOT SendMessage.

### The Reporting Rule
Workers report via TaskUpdate(metadata={...}). SendMessage is for:
- Escalations (blocking discoveries, unanswerable questions)
- Responses to direct questions from teammates
Never for: acknowledgments, progress updates, task confirmations.

### The Nudge Rule
If a worker is idle with an assigned task, the problem is TaskList visibility, not communication.
Check the task exists in the team scope. Do NOT send a nudge message.
If the task is correctly scoped and the worker is still idle after 2 minutes, send ONE wake message.
```

### 7.2 Spawn Template (templates/spawn/worker.md)

Single template, already exists, correct design:
```
{TASK_VERB} GH-{ISSUE_NUMBER}: {TITLE}.
{TASK_CONTEXT}

Invoke: {SKILL_INVOCATION}

Report via TaskUpdate: "{REPORT_FORMAT}"
```

No changes needed to the template itself. Changes needed in SKILL.md Section 6 to enforce correct placeholder substitution and one-time read-resolve-substitute pattern.

### 7.3 Agent Definitions

Four typed agent definitions, each ~20-35 lines:

| Agent | Tools | Skills | Notes |
|-------|-------|--------|-------|
| `ralph-analyst` | Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__* (issue management) | ralph-triage, ralph-split, ralph-research | Needs MCP tools for issue creation/update during split |
| `ralph-builder` | Read, Write, Edit, Bash, Glob, Grep, Skill, Task, TaskList, TaskGet, TaskUpdate, SendMessage | ralph-plan, ralph-impl | Needs file editing for implementation |
| `ralph-validator` | Read, Write, Glob, Grep, Skill, Task, TaskList, TaskGet, TaskUpdate, SendMessage | ralph-review | Read-heavy, writes review documents |
| `ralph-integrator` | Read, Glob, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__* | (direct git/gh) | Needs MCP tools for state advancement |

All have the same Stop hook: `worker-stop-gate.sh`.

All have the same task loop pattern in body:
1. TaskGet your assigned task
2. Invoke skill matching your task subject
3. Report results via TaskUpdate with structured metadata
4. Stop hook handles work discovery

---

## 8. Observability Layer

The debug mode spec is already detailed in `thoughts/shared/plans/2026-02-21-debug-mode-observability-spec.md`. Integration with v4 architecture:

### 8.1 Capture Points

| Layer | What's Captured | How |
|-------|----------------|-----|
| MCP Tools | Every tool call: name, params, duration, success/error | Logging decorator in tool dispatch |
| GraphQL | Every API call: operation, variables, rate limit | Logging in github-client.ts |
| Hooks | Every hook execution: name, exit code, blocked? | `debug-hook-counter.sh` wrapper |
| Agent Events | Skill invocations, agent spawns, task completions | Hook scripts on SessionStart/Stop |

### 8.2 Activation

`RALPH_DEBUG=true` in `settings.local.json`. Zero overhead when unset.

### 8.3 Collation

On-demand `ralph_hero__collate_debug` MCP tool. Reads JSONL logs, groups errors by signature, deduplicates against existing issues, creates/updates canonical GitHub issues with `debug-auto` label.

### 8.4 Metrics

On-demand `ralph_hero__debug_stats` MCP tool. Aggregates across session logs. Error rate, tool success rate, avg duration per tool.

---

## 9. Implementation Phases

### Phase 0: Investigation & Validation (S)

**Goal**: Validate assumptions about Claude Code primitive behavior before committing to architectural changes. This phase produces test results and documented findings, not code changes.

**Investigation areas**:

#### 0a. TaskList Visibility in Team Context
- Create a team with `TeamCreate`
- Spawn a typed agent as teammate
- Create a task via `TaskCreate`
- Verify the teammate can see the task via `TaskList`
- Verify `TaskGet` works for the teammate
- Test: does `TaskUpdate(owner="worker")` from the lead make the task visible to the worker?
- Test: does `blockedBy` prevent workers from claiming blocked tasks, or is it advisory?
- **Document**: exact behavior of TaskList scoping in team context

#### 0b. Self-Claim Atomicity
- Spawn 2 same-role workers (e.g., `analyst` and `analyst-2`)
- Create 1 unclaimed task matching their role
- Both workers attempt `TaskUpdate(owner="me")` simultaneously
- Verify: only one owner wins. Does the second get an error, or silently overwrite?
- Test the claim-then-verify pattern: `TaskUpdate(owner)` → `TaskGet` → check owner field
- **Document**: race window size and mitigation effectiveness

#### 0c. Spawn-Before-Tasks Viability
- `TeamCreate` → spawn 2 workers → workers go idle (no tasks yet)
- Lead creates tasks after workers are idle
- Verify: do idle workers' Stop hooks fire when new tasks appear?
- Or: does the lead need to `SendMessage` to wake idle workers after task creation?
- Test: what happens if lead pre-assigns a task to an idle worker — does the worker notice?
- **Document**: the correct startup sequence (spawn-first vs tasks-first vs interleaved)

#### 0d. Worker Template Effectiveness
- Spawn a typed worker (`ralph-builder`) with the current minimal template
- Verify: does the worker correctly compose agent definition + template + TaskGet?
- Verify: does the worker find its task via TaskList without being told the task ID?
- Test: what if the template has no `{ISSUE_NUMBER}` because the worker is roster-spawned before tasks exist?
- **Document**: whether the template needs enhancement for the roster-first model

#### 0e. suggestedRoster Heuristic Feasibility
- Review the `detect_pipeline_position` response fields
- Prototype the heuristic formula (Section 5.4) on real issue groups
- Verify the inputs are sufficient: `issues.length`, `isGroup`, estimates, `totalStreams`
- **Document**: proposed `suggestedRoster` response shape and edge cases

**Success criteria**:
- Each investigation area produces a documented finding (pass/fail/nuance)
- Findings are recorded in `thoughts/shared/research/2026-MM-DD-GH-NNNN-v4-primitive-investigation.md`
- Any spec assumptions that prove wrong are flagged for spec revision before proceeding

### Phase 1: Communication Discipline (XS)

**Goal**: Eliminate the #1 observed failure — redundant messaging.

**Changes**:
1. Update `skills/shared/conventions.md` — add Communication Discipline section (Section 7.1 above)
2. Update `skills/ralph-team/SKILL.md` Section 5 — hard rule: no SendMessage after TaskUpdate(owner) except for waking idle workers
3. Update `skills/ralph-team/SKILL.md` Section 4.4 — remove any SendMessage from the dispatch loop flow
4. Update `hooks/scripts/team-task-completed.sh` — one-line guidance, no multi-step instructions
5. Update `hooks/scripts/team-teammate-idle.sh` — one-line guidance (already minimal, verify)

**Success criteria**:
- SKILL.md contains explicit "FORBIDDEN" rules for SendMessage misuse
- Hook scripts produce at most one line of stderr guidance
- conventions.md "Communication Discipline" section exists

### Phase 2: Upfront Task List Model (S)

**Goal**: Replace bough model with upfront task list in ralph-team. Replace convergence-driven bough advancement with blockedBy chains.

**Changes**:
1. Rewrite `skills/ralph-team/SKILL.md` Section 4.2 — create ALL pipeline tasks upfront with blockedBy dependencies (not current-phase-only)
2. Rewrite `skills/ralph-team/SKILL.md` Section 4.4 — remove bough advancement logic; lead monitors task completions and handles escalations but does NOT create tasks mid-pipeline
3. Update `skills/shared/conventions.md` Pipeline Handoff Protocol — replace bough advancement with upfront task list + self-claim
4. Remove "Do NOT assign tasks mid-pipeline" contradiction
5. Update `hooks/scripts/team-task-completed.sh` — remove bough advancement guidance
6. Update `hooks/scripts/worker-stop-gate.sh` — ensure it checks `blockedBy` status (only unblocked tasks count)

**Success criteria**:
- SKILL.md Section 4.2 creates all pipeline tasks at session start
- blockedBy chains enforce phase ordering
- No "bough" references remain in SKILL.md or conventions.md
- worker-stop-gate.sh only reports unblocked tasks

### Phase 3: Roster-First Spawning (S)

**Goal**: Spawn full expected roster at session start. Workers go idle and self-claim from task list.

**Changes**:
1. Add `suggestedRoster` field to `detect_pipeline_position` response in `pipeline-detection.ts`
2. Implement heuristic formula (Section 5.4) based on group size, estimates, and stream count
3. Update `skills/ralph-team/SKILL.md` Section 4.3 — spawn full roster before creating tasks (or after first batch, based on Phase 0 findings)
4. Update `skills/ralph-team/SKILL.md` Section 6 — adjust spawn procedure for roster-first model (template may need generic first-turn handling)
5. Update agent definitions — ensure task loop handles "no task yet" state gracefully
6. Validator always spawned (min 1) — automated review by default

**Success criteria**:
- `detect_pipeline_position` returns `suggestedRoster` with per-role counts
- Lead spawns the recommended roster at session start
- Workers go idle and self-claim when tasks are created
- Validator is always present in the roster

### Phase 4: Agent Definition & Self-Claim Cleanup (S)

**Goal**: Ensure agent definitions support the self-claim model and are correct.

**Changes**:
1. Update `ralph-analyst.md` — task loop uses TaskList for self-claim, claim-then-verify pattern, Stop hook handles work discovery
2. Update `ralph-builder.md` — same pattern
3. Update `ralph-validator.md` — same pattern, automated review by default
4. Update `ralph-integrator.md` — same pattern, plus PR/Merge procedures preserved
5. Verify `subagent_type` in SKILL.md Section 6 uses typed agents (not general-purpose)
6. Verify all agent definitions list correct MCP tools per ADR-001

**Success criteria**:
- All 4 agent definitions use the same self-claim task loop pattern
- All 4 have Stop hook in frontmatter
- Claim-then-verify pattern documented in each agent definition
- SKILL.md Section 6 spawn table uses typed agent names

### Phase 5: Hero Mode Task List (S)

**Goal**: Port the upfront-task-list pattern from workspace `ralph_hero.md` to the plugin `ralph-hero` skill.

**Changes**:
1. Update `skills/ralph-hero/SKILL.md` to create task list with blockedBy after detecting pipeline position
2. Add stream detection post-research for groups >= 3 (mirror from ralph-team)
3. Use blockedBy chains for sequential implementation (instead of manual ordering)
4. Add resumability: check existing TaskList on re-invocation before creating new tasks

**Success criteria**:
- Hero mode creates an upfront task list with blockedBy dependencies
- TaskList shows clear progress tracking (pending/in_progress/completed)
- Re-invocation resumes from existing task state

### Phase 6: Interactive Skills Port (M)

**Goal**: Create 6 interactive skills in the ralph-hero plugin.

**Changes**:
1. Create `skills/draft-idea/SKILL.md` — adapted from workspace draft_idea.md
2. Create `skills/form-idea/SKILL.md` — adapted from workspace form_idea.md
3. Create `skills/research-codebase/SKILL.md` — adapted from workspace research_codebase.md
4. Create `skills/create-plan/SKILL.md` — adapted from workspace create_plan.md (already exists, verify)
5. Create `skills/iterate-plan/SKILL.md` — adapted from workspace iterate_plan.md
6. Create `skills/implement-plan/SKILL.md` — adapted from workspace implement_plan.md

**Adaptation pattern for all**:
- Linear tools → GitHub tools (`ralph_hero__*`)
- `LAN-NNN` → `#NNN` / `GH-NNNN`
- No `context: fork` (inline conversation)
- No `RALPH_COMMAND` (bypasses state gates)
- Full tool access in `allowed_tools`
- Artifact Comment Protocol for linking docs to issues

**Success criteria**:
- All 6 skills appear in `/` autocomplete as `/ralph-hero:<name>`
- Each runs inline and maintains interactive conversation
- GitHub integration works (create issue, link artifacts, transition states)
- Sub-agents spawned without team_name

### Phase 7: Observability (M)

**Goal**: Implement the debug mode spec.

**Sub-phases** (from debug spec):
1. Logging infrastructure — `DebugLogger` class, JSONL capture
2. Hook-based capture — `debug-hook-counter.sh`, agent event hooks
3. Collation tool — `ralph_hero__collate_debug` MCP tool
4. Stats tool — `ralph_hero__debug_stats` MCP tool

**Success criteria**:
- `RALPH_DEBUG=true` produces JSONL logs with all 4 event categories
- `RALPH_DEBUG` unset produces zero overhead
- Collation creates well-formed issues with `debug-auto` label
- Stats show error rate and tool success rate

### Phase Dependency Graph

```
Phase 0 (Investigation & Validation)
  │
  ▼
Phase 1 (Communication Discipline)
  │
  ▼
Phase 2 (Upfront Task List Model)
  │
  ├── Phase 3 (Roster-First Spawning) ─── depends on Phase 0 findings
  │     │
  │     ▼
  │   Phase 4 (Agent Definition & Self-Claim Cleanup)
  │
  ├── Phase 5 (Hero Mode Task List) ─── independent of Phases 3-4
  │
  └── Phase 6 (Interactive Skills) ─── independent of Phases 3-5
      │
      ▼
Phase 7 (Observability) ─── can start after Phase 2, best after all

Sequential: Phase 0 → 1 → 2 are strictly ordered.
Parallelizable: Phases 3→4, 5, 6 can proceed concurrently after Phase 2.
Phase 3 depends on Phase 0 findings (spawn ordering, template changes).
```

---

## References

### Documents Synthesized
- `thoughts/shared/plans/2026-02-20-ralph-team-worker-redesign.md` — Worker architecture redesign
- `thoughts/shared/research/2026-02-21-GH-0230-ralph-team-worker-redesign.md` — Research findings
- `thoughts/ideas/2026-02-22-orchestrator-no-message-on-task-assign.md` — TaskList visibility + messaging
- `thoughts/shared/plans/2026-02-21-debug-mode-observability-spec.md` — Debug mode spec
- `thoughts/shared/plans/2026-02-21-interactive-skills-port.md` — Interactive skills port
- `thoughts/shared/plans/2026-02-17-ralph-hero-v3-architecture-epic.md` — V3 architecture epic
- `thoughts/shared/research/2026-02-20-GH-0200-task-self-assignment-race-condition.md` — Race conditions
- `thoughts/shared/research/2026-02-20-GH-0231-skill-subagent-team-context-pollution.md` — Team pollution
- `thoughts/shared/research/2026-02-17-GH-0052-taskupdate-self-notification.md` — Self-notification
- `~/projects/.claude/commands/ralph_hero.md` — Workspace hero command (inspiration for task list pattern)

### Current Files
- `plugin/ralph-hero/skills/ralph-team/SKILL.md` — Team orchestrator (467 lines)
- `plugin/ralph-hero/skills/ralph-hero/SKILL.md` — Hero orchestrator (252 lines)
- `plugin/ralph-hero/skills/shared/conventions.md` — Shared conventions (294 lines)
- `plugin/ralph-hero/agents/ralph-{analyst,builder,validator,integrator}.md` — Agent definitions
- `plugin/ralph-hero/templates/spawn/worker.md` — Spawn template (6 lines)
- `plugin/ralph-hero/hooks/scripts/team-{stop-gate,task-completed,teammate-idle}.sh` — Team hooks
- `plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh` — Worker Stop hook
