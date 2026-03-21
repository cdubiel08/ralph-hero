# Skill Permissions

## Purpose

Defines the tool access matrix for every `ralph-*` skill and the plugin-level hook overlay that applies across all skills.

## Definitions

- **`allowed-tools`**: SKILL.md frontmatter field that whitelists tools a skill can use. Claude Code's skill runtime enforces this — tools not listed are blocked.
- **Plugin-level overlay**: PreToolUse and PostToolUse hooks registered in `hooks.json` that apply to ALL skills regardless of skill-level `allowed-tools`.
- **`Task` (shorthand)**: Refers to the aggregate of `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate` tools. When a skill lists `Task`, all four are allowed.

## Requirements

### Skill Permissions Matrix

Each cell: **allow** = tool is in `allowed-tools`, **—** = tool is not listed (blocked by runtime).

| Tool | triage | split | research | plan | impl | review | hero | team | merge | pr | val | status | report | hygiene | setup | hello |
|------|--------|-------|----------|------|------|--------|------|------|-------|----|----|--------|--------|---------|-------|-------|
| Read | allow | allow | allow | allow | allow | allow | allow | allow | allow | allow | allow | — | — | — | — | allow |
| Write | — | — | allow | allow | allow | allow | — | allow | — | — | — | — | — | — | — | — |
| Edit | — | — | — | — | allow | — | — | — | — | — | — | — | — | — | — | — |
| Glob | allow | allow | allow | allow | allow | allow | allow | — | allow | allow | allow | — | — | — | — | — |
| Grep | allow | allow | allow | allow | allow | allow | allow | — | — | — | allow | — | — | — | — | — |
| Bash | allow | allow | allow | allow | allow | allow | allow | allow | allow | allow | allow | — | — | — | — | allow |
| Task | allow | allow | allow | allow | allow | allow | allow | allow | — | — | allow | — | — | — | — | — |
| Agent | allow | allow | allow | allow | allow | allow | allow | — | — | — | — | — | — | — | — | — |
| Skill | — | — | — | — | — | — | allow | allow | allow | — | — | — | — | — | — | allow |
| WebSearch | allow | — | allow | — | — | — | — | — | — | — | — | — | — | — | — | — |
| WebFetch | — | — | allow | — | — | — | — | — | — | — | — | — | — | — | — | — |
| TaskCreate/List/Get/Update | — | — | — | — | — | — | — | allow | — | — | — | — | — | — | — | — |
| SendMessage | — | — | — | — | — | — | — | allow | — | — | — | — | — | — | — | — |
| TeamCreate/Delete | — | — | — | — | — | — | — | allow | — | — | — | — | — | — | — | — |
| AskUserQuestion | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | allow |
| MCP tools (ralph_hero__*) | indirect | indirect | indirect | indirect | indirect | indirect | indirect | indirect | direct | direct | — | — | — | — | — | direct |

**Note on MCP tools**: Most skills access `ralph_hero__*` tools indirectly through Bash/Task delegation. `ralph-merge` and `ralph-pr` have direct MCP tool access in their `allowed-tools`.

| Requirement | Enablement |
|-------------|------------|
| Every `ralph-*` skill MUST declare `allowed-tools` in its SKILL.md frontmatter | [x] all skills declare allowed-tools |
| `allowed-tools` MUST be enforced by Claude Code's skill runtime | [x] Claude Code runtime (built-in) |
| Skills MUST NOT access tools outside their `allowed-tools` whitelist | [x] Claude Code runtime (built-in) |

### Prescribed Permissions for Skills Missing `allowed-tools`

The following skills currently have no `allowed-tools` declaration. These permissions MUST be added:

| Skill | Prescribed `allowed-tools` | Rationale |
|-------|---------------------------|-----------|
| `status` | Read, Bash | Read-only dashboard queries via MCP tools |
| `report` | Read, Bash | Read-only queries, posts status update via MCP tools |
| `ralph-hygiene` | Read, Glob, Bash | Board queries, identifies archive candidates |
| `setup` | Bash | Creates project configuration via CLI |

| Requirement | Enablement |
|-------------|------------|
| `status` MUST have `allowed-tools: [Read, Bash]` | [x] SKILL.md frontmatter |
| `report` MUST have `allowed-tools: [Read, Bash]` | [x] SKILL.md frontmatter |
| `ralph-hygiene` MUST have `allowed-tools: [Read, Glob, Bash]` | [x] SKILL.md frontmatter |
| `setup` MUST have `allowed-tools: [Bash]` | [x] SKILL.md frontmatter |

### Plugin-Level Hook Overlay

These hooks are registered in `hooks.json` and apply across ALL skills, regardless of skill-level `allowed-tools`.

#### PreToolUse Hooks

| Tool Matcher | Hook Script | Purpose |
|-------------|-------------|---------|
| `ralph_hero__save_issue` | `pre-github-validator.sh` | Validates state transition is valid for current command |
| `ralph_hero__save_issue` | `artifact-discovery.sh` | Warns if expected artifact comment is missing |
| `ralph_hero__get_issue` | `pre-ticket-lock-validator.sh` | Validates ticket is not locked by another command |
| `ralph_hero__get_issue` | `skill-precondition.sh` | Validates skill preconditions (state, estimate, branch) |
| `ralph_hero__list_issues` | `skill-precondition.sh` | Validates skill preconditions |
| `Write` | `pre-artifact-validator.sh` | Blocks duplicate artifact creation |
| `Bash` | `pre-worktree-validator.sh` | Validates worktree operations |

#### PostToolUse Hooks

| Tool Matcher | Hook Script | Purpose |
|-------------|-------------|---------|
| `ralph_hero__save_issue` | `post-github-validator.sh` | Validates state transition completed correctly |
| `ralph_hero__get_issue` | `post-blocker-reminder.sh` | Reminds about blocked issues |
| `Bash` | `post-git-validator.sh` | Validates git operations (staging, commit messages) |

| Requirement | Enablement |
|-------------|------------|
| Plugin-level PreToolUse hooks MUST apply across all skills | [x] `hooks.json` loaded by Claude Code plugin runtime |
| Plugin-level PostToolUse hooks MUST apply across all skills | [x] `hooks.json` loaded by Claude Code plugin runtime |
| `pre-artifact-validator.sh` MUST block duplicate research/plan/review creation | [x] `pre-artifact-validator.sh` |
| `pre-github-validator.sh` MUST validate state transitions match command contracts | [x] `pre-github-validator.sh` |

## Cross-References

- [skill-io-contracts.md](skill-io-contracts.md) — what each skill does (inputs/outputs)
- [agent-permissions.md](agent-permissions.md) — agent-level permissions layered on top of skill permissions
