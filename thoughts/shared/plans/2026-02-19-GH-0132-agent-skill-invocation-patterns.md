---
date: 2026-02-19
status: draft
github_issue: 132
github_url: https://github.com/cdubiel08/ralph-hero/issues/132
---

# Agent/Skill Invocation Patterns — Bowser Reference Validation & Hardening

## Overview

1 issue implementing documentation-based hardening of agent/skill invocation patterns, informed by Bowser reference architecture analysis. The research confirmed our patterns are structurally sound and match industry best practices. This plan codifies the remaining gap: adding `allowed_tools` frontmatter to skill definitions for defense-in-depth, and strengthening result format contracts per worker role.

## Current State Analysis

The [research document](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0132-agent-skill-patterns-bowser-reference.md) confirms:

1. **Architecture is correct**: Ralph-hero's 4-layer architecture (scripts -> skills -> agents -> MCP tools) matches Bowser's proven pattern. No structural redesign needed.
2. **Template integrity is the right approach**: Both Bowser and ralph-hero use documentation-based enforcement because that's the only mechanism available in Claude Code's plugin system. PR #89 correctly established this.
3. **MCP tool removal was wrong**: PR #57's approach of stripping tools from agents was incorrect — Bowser confirms agents need tools. The constraint belongs at the skill layer (`allowed_tools`), not the agent layer.
4. **Two remaining gaps**:
   - Skills lack `allowed_tools` frontmatter (Bowser uses this for defense-in-depth)
   - Result format contracts are not formally specified per worker role

The [prior research on GH-53](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0053-teammate-inline-work-vs-skill-invocation.md) provides additional context: the root cause of skill bypass is orchestrator template inflation, not agent architecture. Template integrity rules (conventions.md, SKILL.md Section 6) address this directly.

**What already exists**:
- Template integrity rules in [`shared/conventions.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md) (lines 238-248)
- Template integrity anti-patterns in [`ralph-team/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md) Section 6 (lines 200-214)
- `context: fork` on 6 worker skills for process isolation
- Line-count guardrail (10-line max for spawn prompts)
- Structured result formats in agent definitions (analyst, builder, validator, integrator)

**What's missing**:
- `allowed_tools` frontmatter in skill SKILL.md files
- Formal result format contract documentation in `shared/conventions.md`
- Architecture validation documentation (confirming "this is correct, no redesign needed")

## Desired End State

### Verification
- [ ] All 8 workflow skills (triage, split, research, plan, review, impl, hero, team) have `allowed_tools` in their frontmatter
- [ ] `shared/conventions.md` has a "Result Format Contracts" section specifying per-role output formats
- [ ] `shared/conventions.md` has an "Architecture Decision: Agent/Skill Separation" section documenting the validated 4-layer pattern
- [ ] No skill has `Edit` or `Write` in `allowed_tools` unless it genuinely needs file creation (plan, research, review, impl)
- [ ] GH-132 issue comment links to the architecture decision section

## What We're NOT Doing

- **No structural redesign** — the research explicitly says our patterns are correct
- **No MCP tool removal from agents** — PR #57 proved this approach is wrong
- **No hook-based skill invocation verification** — research confirms this is infeasible (hooks cannot inspect conversation history)
- **No Justfile implementation** — that's GH-67/GH-68, a separate concern
- **No changes to spawn templates** — they're already correct (5-8 lines, minimal)
- **No changes to agent definitions** — they already have correct task loop patterns
- **No changes to ralph-team SKILL.md Section 6** — template integrity rules already exist there

## Implementation Approach

Two phases building on each other:

1. **Phase 1**: Add `allowed_tools` frontmatter to all 8 skill SKILL.md files. This is the primary Bowser pattern we're adopting — restricting tool surface per skill for defense-in-depth.

2. **Phase 2**: Add formal documentation to `shared/conventions.md` — result format contracts per worker role and architecture decision record. This codifies what the research validated and ensures future contributors understand the design.

---

## Phase 1: Add `allowed_tools` to Skill Frontmatter

### Overview

Bowser declares `allowed_tools: [Bash]` in skill frontmatter to restrict what Claude can do during skill execution. We adopt this pattern across all 8 workflow skills. Each skill gets a curated tool list matching its actual needs — no more, no less.

### Changes Required

#### 1. Add `allowed_tools` to `ralph-triage/SKILL.md`
**File**: [`plugin/ralph-hero/skills/ralph-triage/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-triage/SKILL.md)
**Location**: Frontmatter block (after `env:` section)

Add to the YAML frontmatter:
```yaml
allowed_tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Task
  - WebSearch
```

**Rationale**: Triage reads issues (MCP tools inherited via hooks), searches codebase for duplicates, and spawns sub-tasks for analysis. No file creation needed.

#### 2. Add `allowed_tools` to `ralph-split/SKILL.md`
**File**: [`plugin/ralph-hero/skills/ralph-split/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-split/SKILL.md)
**Location**: Frontmatter block (after `env:` section)

Add to the YAML frontmatter:
```yaml
allowed_tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Task
```

**Rationale**: Split reads issues and creates sub-issues (via MCP tools inherited through hooks). No file creation, no web search needed.

#### 3. Add `allowed_tools` to `ralph-research/SKILL.md`
**File**: [`plugin/ralph-hero/skills/ralph-research/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-research/SKILL.md)
**Location**: Frontmatter block (after `env:` section)

Add to the YAML frontmatter:
```yaml
allowed_tools:
  - Read
  - Write
  - Glob
  - Grep
  - Bash
  - Task
  - WebSearch
  - WebFetch
```

**Rationale**: Research creates markdown documents (`Write`), searches codebase, fetches external documentation, and spawns analysis sub-tasks.

#### 4. Add `allowed_tools` to `ralph-plan/SKILL.md`
**File**: [`plugin/ralph-hero/skills/ralph-plan/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-plan/SKILL.md)
**Location**: Frontmatter block (after `env:` section)

Add to the YAML frontmatter:
```yaml
allowed_tools:
  - Read
  - Write
  - Glob
  - Grep
  - Bash
  - Task
```

**Rationale**: Plan creates markdown documents (`Write`), reads research findings, searches codebase for patterns, and spawns analysis sub-tasks. No web search needed (research phase already gathered external info).

#### 5. Add `allowed_tools` to `ralph-review/SKILL.md`
**File**: [`plugin/ralph-hero/skills/ralph-review/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-review/SKILL.md)
**Location**: Frontmatter block (after `env:` section)

Add to the YAML frontmatter:
```yaml
allowed_tools:
  - Read
  - Write
  - Glob
  - Grep
  - Bash
  - Task
```

**Rationale**: Review reads plan documents, creates critique documents (`Write`), searches codebase to verify plan accuracy, and spawns analysis sub-tasks.

#### 6. Add `allowed_tools` to `ralph-impl/SKILL.md`
**File**: [`plugin/ralph-hero/skills/ralph-impl/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-impl/SKILL.md)
**Location**: Frontmatter block (after `env:` section)

Add to the YAML frontmatter:
```yaml
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
```

**Rationale**: Implementation is the only skill that needs `Edit` (modifying existing files). Also creates new files (`Write`), reads plan/research, searches codebase, runs tests via `Bash`, and spawns analysis sub-tasks.

#### 7. Add `allowed_tools` to `ralph-hero/SKILL.md`
**File**: [`plugin/ralph-hero/skills/ralph-hero/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-hero/SKILL.md)
**Location**: Frontmatter block (after `env:` section)

Add to the YAML frontmatter:
```yaml
allowed_tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Skill
  - Task
```

**Rationale**: Hero is an orchestrator — it dispatches work to other skills via `Skill()` and `Task()`. It reads issues and spawns sub-tasks but does not create files or edit code directly.

#### 8. Add `allowed_tools` to `ralph-team/SKILL.md`
**File**: [`plugin/ralph-hero/skills/ralph-team/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md)
**Location**: Frontmatter block (after `env:` section)

Add to the YAML frontmatter:
```yaml
allowed_tools:
  - Read
  - Glob
  - Bash
  - Task
  - Skill
  - TeamCreate
  - TeamDelete
  - TaskCreate
  - TaskList
  - TaskGet
  - TaskUpdate
  - SendMessage
```

**Rationale**: Team is the multi-agent orchestrator — it creates/manages teams, creates/assigns tasks, sends messages to teammates, reads templates, and dispatches skills. It must not create files, edit code, or do substantive research/implementation work.

### Success Criteria

#### Automated Verification
- [ ] `grep -c 'allowed_tools' plugin/ralph-hero/skills/ralph-triage/SKILL.md` returns at least `1`
- [ ] `grep -c 'allowed_tools' plugin/ralph-hero/skills/ralph-split/SKILL.md` returns at least `1`
- [ ] `grep -c 'allowed_tools' plugin/ralph-hero/skills/ralph-research/SKILL.md` returns at least `1`
- [ ] `grep -c 'allowed_tools' plugin/ralph-hero/skills/ralph-plan/SKILL.md` returns at least `1`
- [ ] `grep -c 'allowed_tools' plugin/ralph-hero/skills/ralph-review/SKILL.md` returns at least `1`
- [ ] `grep -c 'allowed_tools' plugin/ralph-hero/skills/ralph-impl/SKILL.md` returns at least `1`
- [ ] `grep -c 'allowed_tools' plugin/ralph-hero/skills/ralph-hero/SKILL.md` returns at least `1`
- [ ] `grep -c 'allowed_tools' plugin/ralph-hero/skills/ralph-team/SKILL.md` returns at least `1`
- [ ] `ralph-impl/SKILL.md` is the ONLY skill with `Edit` in its `allowed_tools`

#### Manual Verification
- [ ] Each skill's tool list matches its actual operational needs
- [ ] No skill has tools it doesn't use
- [ ] Orchestrator skills (hero, team) do NOT have Write/Edit

**Creates for Phase 2**: Tool surface documentation establishes the baseline that result format contracts build upon.

---

## Phase 2: Document Architecture Decisions & Result Format Contracts

### Overview

Add two new sections to `shared/conventions.md`: an Architecture Decision Record validating the 4-layer agent/skill separation, and formal Result Format Contracts per worker role. This codifies what the Bowser research validated and what agent definitions partially specify.

### Changes Required

#### 1. Add "Architecture Decision: Agent/Skill Separation" section
**File**: [`plugin/ralph-hero/skills/shared/conventions.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md)
**Location**: After the "Skill Invocation Convention" section (after line 276)

Add a new section:
```markdown
## Architecture Decision: Agent/Skill Separation (ADR-001)

**Status**: Validated (2026-02-19, GH-132)
**Reference**: Bowser framework (github.com/disler/bowser/)

### Decision

Ralph-hero uses a 4-layer architecture matching Bowser's proven pattern:

| Layer | Name | Role | Location |
|-------|------|------|----------|
| 4 | Scripts | Terminal invocation | `scripts/ralph-loop.sh`, `scripts/ralph-team-loop.sh` |
| 3 | Skills | Capability + workflow logic | `skills/*/SKILL.md` |
| 2 | Agents | Scale + isolation (team workers) | `agents/*.md` |
| 1 | MCP Tools | Raw GitHub API operations | `mcp-server/src/tools/` |

### Key Principles

1. **Agents are thin wrappers**: Agent definitions are 20-35 lines. They define a task loop that dispatches to skills. Agents do NOT contain workflow logic.
2. **Skills own workflow logic**: Each skill defines the complete procedure for one workflow phase (research, plan, review, implement). Skills declare `allowed_tools` to restrict their tool surface.
3. **MCP tools are primitive operations**: Create issue, update state, add comment. No business logic.
4. **Orchestrators delegate, never implement**: `ralph-team` and `ralph-hero` skills spawn workers and manage tasks. They never research, plan, review, or implement directly.

### Enforcement Mechanisms

| Mechanism | Type | What it prevents |
|-----------|------|-----------------|
| `allowed_tools` in SKILL.md | Declarative constraint | Skills using tools outside their scope |
| Template integrity rules | Documentation-based | Orchestrator front-loading context into spawn prompts |
| Line-count guardrail (10-line max) | Behavioral check | Orchestrator adding prohibited context beyond placeholders |
| `context: fork` on worker skills | Process isolation | Context pollution between skill invocations |
| Hook-based state gates | Structural enforcement | Invalid workflow state transitions |

**No structural enforcement for skill invocation exists** in Claude Code's plugin system. Both Bowser and ralph-hero rely on LLM compliance with documented patterns. This is an accepted limitation.

### What NOT to Do

- **Do NOT remove MCP tools from agent definitions** (PR #57 proved this breaks skill execution since `Skill()` inherits agent tool restrictions)
- **Do NOT add workflow logic to agent definitions** (agents dispatch to skills; skills contain the logic)
- **Do NOT create hook-based skill invocation verification** (hooks cannot inspect conversation history)
```

#### 2. Add "Result Format Contracts" section
**File**: [`plugin/ralph-hero/skills/shared/conventions.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md)
**Location**: After the new ADR-001 section

Add a new section:
```markdown
## Result Format Contracts

When teammates complete tasks, they report results via `TaskUpdate(description=...)`. The lead and hooks parse these descriptions. Formats MUST follow these contracts exactly.

### Analyst Results

**Triage**:
```
TRIAGE COMPLETE: #NNN
Action: [CLOSE|SPLIT|RESEARCH|KEEP]
[If SPLIT]: Sub-tickets: #AAA, #BBB
Estimates: #AAA (XS), #BBB (S)
```

**Split**:
```
SPLIT COMPLETE: #NNN
Sub-tickets: #AAA, #BBB, #CCC
Estimates: #AAA (XS), #BBB (S), #CCC (XS)
```

**Research**:
```
RESEARCH COMPLETE: #NNN - [Title]
Document: [path]
Key findings: [summary]
Ticket moved to: Ready for Plan
```

### Builder Results

**Plan**:
```
PLAN COMPLETE: [ticket/group]
Plan: [path]
Phases: [N]
File ownership: [groups]
Ready for review.
```

**Implement**:
```
IMPLEMENTATION COMPLETE
Ticket: #NNN
Phases: [N] of [M]
Files: [list]
Tests: [PASSING|FAILING]
Commit: [hash]
Worktree: [path]
```

### Validator Results

**Review**:
```
VALIDATION VERDICT
Ticket: #NNN
Plan: [path]
VERDICT: [APPROVED|NEEDS_ITERATION]
[blocking issues with file:line evidence]
[warnings]
[what's good]
```

### Integrator Results

**PR Creation**:
```
PR CREATED
Ticket: #NNN
PR: [URL]
Branch: [branch]
State: In Review
```

**Merge**:
```
MERGE COMPLETE
Ticket: #NNN
PR: [URL] merged
Branch: deleted
Worktree: removed
State: Done
```

### Contract Rules

1. **First line is the key**: The first line (e.g., `TRIAGE COMPLETE: #NNN`) is the parseable identifier. Always include it.
2. **Colon-separated fields**: Use `Key: Value` format for structured data.
3. **Sub-ticket IDs are critical**: Analyst triage/split results MUST include all sub-ticket IDs — the lead creates follow-up tasks from them.
4. **VERDICT line is parseable**: Validator results MUST include `VERDICT: APPROVED` or `VERDICT: NEEDS_ITERATION` on its own line.
5. **File lists use short paths**: Relative to repo root, not absolute paths.
```

### Success Criteria

#### Automated Verification
- [ ] `grep -c 'ADR-001' plugin/ralph-hero/skills/shared/conventions.md` returns at least `1`
- [ ] `grep -c 'Result Format Contracts' plugin/ralph-hero/skills/shared/conventions.md` returns at least `1`
- [ ] `grep -c 'TRIAGE COMPLETE' plugin/ralph-hero/skills/shared/conventions.md` returns at least `1`
- [ ] `grep -c 'IMPLEMENTATION COMPLETE' plugin/ralph-hero/skills/shared/conventions.md` returns at least `1`
- [ ] `grep -c 'VALIDATION VERDICT' plugin/ralph-hero/skills/shared/conventions.md` returns at least `1`

#### Manual Verification
- [ ] ADR-001 accurately reflects the Bowser research findings from GH-132
- [ ] Result format contracts match what agent definitions already specify
- [ ] "What NOT to Do" section captures lessons from PR #57 and GH-53
- [ ] All 5 worker roles have documented result formats

---

## Integration Testing

- [ ] All 8 skill SKILL.md files pass `claude skill validate` (if available) or at minimum have valid YAML frontmatter
- [ ] `conventions.md` renders correctly as markdown (no broken formatting)
- [ ] Agent definitions' result formats are consistent with the new conventions.md contracts
- [ ] No existing tests break (`cd plugin/ralph-hero/mcp-server && npm test`)

## File Ownership Summary

| Phase | Key Files (NEW) | Key Files (MODIFIED) | Key Files (DELETED) |
|-------|-----------------|---------------------|---------------------|
| 1 | — | `plugin/ralph-hero/skills/ralph-triage/SKILL.md`, `plugin/ralph-hero/skills/ralph-split/SKILL.md`, `plugin/ralph-hero/skills/ralph-research/SKILL.md`, `plugin/ralph-hero/skills/ralph-plan/SKILL.md`, `plugin/ralph-hero/skills/ralph-review/SKILL.md`, `plugin/ralph-hero/skills/ralph-impl/SKILL.md`, `plugin/ralph-hero/skills/ralph-hero/SKILL.md`, `plugin/ralph-hero/skills/ralph-team/SKILL.md` | — |
| 2 | — | `plugin/ralph-hero/skills/shared/conventions.md` | — |

## References

- [Issue #132](https://github.com/cdubiel08/ralph-hero/issues/132) — Research correct agent/skill invocation patterns using Bowser as reference architecture
- [Research: GH-132](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0132-agent-skill-patterns-bowser-reference.md) — Bowser reference architecture analysis
- [Research: GH-53](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0053-teammate-inline-work-vs-skill-invocation.md) — Template integrity root cause analysis
- [PR #89](https://github.com/cdubiel08/ralph-hero/pull/89) — Template integrity rules (merged)
- [PR #57](https://github.com/cdubiel08/ralph-hero/pull/57) — MCP tool removal (wrong approach, reverted by #89)
- [Bowser](https://github.com/disler/bowser/) — Reference architecture
- [conventions.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md) — Shared conventions (target for Phase 2)
