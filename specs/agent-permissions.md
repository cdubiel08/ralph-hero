# Agent Permissions

## Purpose

Defines per-agent tool whitelists, PreToolUse gates, and the permission layering model that governs how agents, skills, and hooks interact.

## Definitions

- **Agent**: A Claude Code agent definition (`.md` file in `agents/`) that orchestrates skill invocations as a team worker
- **PreToolUse gate**: A hook that runs before a tool call and can block it (exit 2 = block)
- **`require-skill-context.sh`**: The gate that blocks mutating tool calls when `RALPH_COMMAND` is not set (i.e., outside a skill invocation)
- **Stop gate**: A hook that runs when an agent tries to stop, enforcing that it checks for remaining work first
- **Permission layering**: Three layers of access control, each more restrictive than the last

## Requirements

### Permission Layering Principle

| Layer | Scope | Mechanism | Example |
|-------|-------|-----------|---------|
| 1. Agent definition | Maximum tool surface | `tools:` field in agent `.md` | Builder can use Read, Write, Edit, Bash, ... |
| 2. Skill `allowed-tools` | Subset for active skill | `allowed-tools:` in SKILL.md | ralph-review allows Read, Write, Glob, Grep, Bash, Task |
| 3. `require-skill-context.sh` | Mutating tools blocked outside skill | PreToolUse hook checks `RALPH_COMMAND` | Write/Edit blocked if no skill is active |

| Requirement | Enablement |
|-------------|------------|
| Agent tool lists MUST define the maximum tool surface for that agent role | [x] Claude Code runtime (built-in) |
| Skill `allowed-tools` MUST further restrict tools within a skill invocation | [x] Claude Code runtime (built-in) |
| `require-skill-context.sh` MUST block mutating tools when `RALPH_COMMAND` is not set | [x] `require-skill-context.sh` |
| All three layers MUST be enforced simultaneously — each is additive restriction | [x] Claude Code runtime + `require-skill-context.sh` |

### Agent: ralph-analyst

| Property | Value |
|----------|-------|
| **Model** | sonnet |
| **Color** | green |
| **Role** | Triage, split, research, plan |

**Tool Whitelist**:

| Tool | Access |
|------|--------|
| Read | allow |
| Write | allow |
| Glob | allow |
| Grep | allow |
| Skill | allow |
| Bash | allow |
| TaskList | allow |
| TaskGet | allow |
| TaskUpdate | allow |
| SendMessage | allow |
| `ralph_hero__get_issue` | allow |
| `ralph_hero__list_issues` | allow |
| `ralph_hero__save_issue` | allow (gated) |
| `ralph_hero__create_issue` | allow (gated) |
| `ralph_hero__create_comment` | allow (gated) |
| `ralph_hero__add_sub_issue` | allow (gated) |
| `ralph_hero__add_dependency` | allow (gated) |
| `ralph_hero__remove_dependency` | allow (gated) |
| `ralph_hero__list_sub_issues` | allow |

**PreToolUse Gate**:

| Tool Matcher | Gate | Behavior |
|-------------|------|----------|
| `ralph_hero__save_issue\|ralph_hero__create_issue\|ralph_hero__create_comment\|ralph_hero__add_sub_issue\|ralph_hero__add_dependency\|ralph_hero__remove_dependency` | `require-skill-context.sh` | Blocks if `RALPH_COMMAND` not set |

| Requirement | Enablement |
|-------------|------------|
| Analyst MUST have PreToolUse gate on all mutating MCP tools | [x] `require-skill-context.sh` registered in agent `.md` |
| Analyst MUST NOT call mutating MCP tools outside a skill context | [x] `require-skill-context.sh` |

### Agent: ralph-builder

| Property | Value |
|----------|-------|
| **Model** | sonnet |
| **Color** | cyan |
| **Role** | Review, implement |

**Tool Whitelist**:

| Tool | Access |
|------|--------|
| Read | allow |
| Write | allow (gated) |
| Edit | allow (gated) |
| Bash | allow |
| Glob | allow |
| Grep | allow |
| Skill | allow |
| TaskList | allow |
| TaskGet | allow |
| TaskUpdate | allow |
| SendMessage | allow |

**PreToolUse Gate**:

| Tool Matcher | Gate | Behavior |
|-------------|------|----------|
| `Write\|Edit` | `require-skill-context.sh` | Blocks if `RALPH_COMMAND` not set |

| Requirement | Enablement |
|-------------|------------|
| Builder MUST have PreToolUse gate on Write and Edit tools | [x] `require-skill-context.sh` registered in agent `.md` |
| Builder MUST NOT write or edit files outside a skill context | [x] `require-skill-context.sh` |

### Agent: ralph-integrator

| Property | Value |
|----------|-------|
| **Model** | haiku |
| **Color** | orange |
| **Role** | Validate, PR creation, merge |

**Tool Whitelist**:

| Tool | Access |
|------|--------|
| Read | allow |
| Glob | allow |
| Bash | allow |
| Skill | allow |
| TaskList | allow |
| TaskGet | allow |
| TaskUpdate | allow |
| SendMessage | allow |
| `ralph_hero__get_issue` | allow |
| `ralph_hero__list_issues` | allow |
| `ralph_hero__save_issue` | allow (gated) |
| `ralph_hero__create_comment` | allow (gated) |
| `ralph_hero__advance_issue` | allow (gated) |
| `ralph_hero__list_sub_issues` | allow |

**PreToolUse Gate**:

| Tool Matcher | Gate | Behavior |
|-------------|------|----------|
| `ralph_hero__save_issue\|ralph_hero__advance_issue\|ralph_hero__create_comment` | `require-skill-context.sh` | Blocks if `RALPH_COMMAND` not set |

| Requirement | Enablement |
|-------------|------------|
| Integrator MUST have PreToolUse gate on mutating MCP tools | [x] `require-skill-context.sh` registered in agent `.md` |
| Integrator MUST NOT call mutating MCP tools outside a skill context | [x] `require-skill-context.sh` |

### Stop Gate Keyword Mapping

The `worker-stop-gate.sh` matches the `$TEAMMATE` environment variable prefix against role patterns to determine which task subject keywords an agent should look for before stopping.

| Agent Name Pattern | Keywords | Purpose |
|-------------------|----------|---------|
| `analyst*` | Triage, Split, Research, Plan | Analyst checks for triage/split/research/plan tasks |
| `builder*` | Review, Implement | Builder checks for review/implementation tasks |
| `integrator*` | Validate, Create PR, Merge, Integrate | Integrator checks for validation/PR/merge tasks |

| Requirement | Enablement |
|-------------|------------|
| Workers MUST check TaskList for remaining work matching their keywords before stopping | `[ ]` `worker-stop-gate.sh` (script not yet on main branch) |
| `worker-stop-gate.sh` MUST match `$TEAMMATE` prefix to determine role keywords | `[ ]` `worker-stop-gate.sh` (script not yet on main branch) |
| Workers MUST be allowed one TaskList check before the stop gate enforces keyword matching | `[ ]` `worker-stop-gate.sh` (script not yet on main branch) |

## Cross-References

- [skill-permissions.md](skill-permissions.md) — skill-level tool access (layer 2 of permission model)
- [team-schema.md](team-schema.md) — worker spawn protocol and role contracts (Phase 3)
