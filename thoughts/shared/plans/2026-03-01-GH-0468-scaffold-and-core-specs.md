---
date: 2026-03-01
status: draft
type: plan
github_issues: [468]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/468
primary_issue: 468
---

# Ralph Protocol Specs Phase 1: Scaffold and Core Specs — Implementation Plan

## Overview

Create `specs/` directory with 5 files: `README.md`, `artifact-metadata.md`, `skill-io-contracts.md`, `skill-permissions.md`, and `agent-permissions.md`. All specs are designed from first principles, using the research findings as the factual basis.

## Current State Analysis

No `specs/` directory exists. Protocol requirements are scattered across:
- `ralph-command-contracts.json` — machine-readable command contracts
- `ralph-state-machine.json` — state machine definitions
- SKILL.md frontmatter — per-skill allowed-tools and hooks
- Agent `.md` files — per-agent tool whitelists and PreToolUse gates
- Hook scripts — enforcement logic
- `conventions.md` — legacy prose (will be deleted in Phase 4)

The research document at `thoughts/shared/research/2026-03-01-GH-0468-scaffold-and-core-specs.md` contains the complete extracted data for all five specs.

## Desired End State

```
specs/
├── README.md                # Index, principles, template, three-layer architecture
├── artifact-metadata.md     # File naming, frontmatter, comment protocol
├── skill-io-contracts.md    # Per-skill I/O table, stateless principle
├── skill-permissions.md     # Skill × tool matrix, plugin overlay
└── agent-permissions.md     # Per-agent tools, PreToolUse gates, stop gates
```

### Verification
- [x] Automated: `ls specs/*.md | wc -l` returns 5
- [x] Automated: Every spec contains `## Purpose`, `## Requirements`, and `| Requirement | Enablement |` table
- [x] Automated: `grep -c 'MUST' specs/*.md` returns > 0 for each file (no "should" language)
- [x] Manual: Each spec is self-contained — a developer can understand what hooks to write from reading it alone
- [x] Manual: Enablement checkboxes match actual hook enforcement (cross-reference with hook scripts)

## What We're NOT Doing

- Not defining the issue lifecycle state machine (Phase 2: `issue-lifecycle.md`)
- Not defining document protocols for research/plan/review (Phase 2: `document-protocols.md`)
- Not defining task or team schemas (Phase 3)
- Not creating shared fragments or refactoring skills (Phase 4)
- Not writing new hooks — specs document what IS and what SHOULD BE, enablement checkboxes track the gap
- Not migrating conventions.md — designing from scratch

## Implementation Approach

Write specs in dependency order: README first (establishes template), then artifact-metadata (referenced by other specs), then the three contract specs (skill-io, skill-permissions, agent-permissions) which can use the template and reference artifact-metadata.

---

## Phase 1: Create `specs/README.md`

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/468 | **Research**: [research doc](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0468-scaffold-and-core-specs.md)

### Changes Required

#### 1. Create `specs/README.md`
**File**: `specs/README.md` (new)
**Changes**: Write the spec index document with:
- **Purpose section**: Specs are the authoritative contract for Ralph protocol, for developers building skills and hooks. NOT for LLMs at runtime.
- **Audience**: Developers who write skills, hooks, and agent definitions
- **Three-layer architecture table**: specs (developers) → shared fragments (LLMs via injection) → hooks (machine enforcement)
- **Enablement checkbox convention**: `[x]` = hook-enforced, `[ ]` = not yet enforced. Specs don't change when enforcement is added — the checkbox flips.
- **Spec template**: Purpose, Definitions, Requirements with Enablement table, Cross-References
- **Index**: Links to all 8 spec files (including Phase 2-3 specs as placeholders)
- **How to use specs**: When developing a new skill: read skill-io-contracts for I/O, skill-permissions for tool access, agent-permissions for agent gates. When developing a new hook: find the unchecked requirements in the relevant spec.

### Success Criteria
- [x] Automated: `test -f specs/README.md` passes
- [x] Automated: `grep -c '## Purpose' specs/README.md` returns >= 1
- [x] Manual: Three-layer architecture table present
- [x] Manual: Enablement checkbox convention clearly explained

---

## Phase 2: Create `specs/artifact-metadata.md`

### Changes Required

#### 1. Create `specs/artifact-metadata.md`
**File**: `specs/artifact-metadata.md` (new)
**Changes**: Define requirements for artifact file management:

**File Naming Requirements** — One row per artifact type:

| Artifact | Pattern | Directory |
|----------|---------|-----------|
| Research | `YYYY-MM-DD-GH-{NNNN}-{slug}.md` | `thoughts/shared/research/` |
| Plan (single) | `YYYY-MM-DD-GH-{NNNN}-{slug}.md` | `thoughts/shared/plans/` |
| Plan (group) | `YYYY-MM-DD-group-GH-{NNNN}-{slug}.md` | `thoughts/shared/plans/` |
| Plan (stream) | `YYYY-MM-DD-stream-GH-{NNN}-{NNN}-{slug}.md` | `thoughts/shared/plans/` |
| Critique | `YYYY-MM-DD-GH-{NNNN}-critique.md` | `thoughts/shared/reviews/` |
| Report | `YYYY-MM-DD-{slug}.md` | `thoughts/shared/reports/` |

Each requirement row includes Enablement status:
- Zero-padding (4-digit `NNNN`): `[ ]` not enforced (convention only, no hook validates format)
- No duplicate research docs per issue: `[x]` `pre-artifact-validator.sh`
- No duplicate plan docs per issue: `[x]` `pre-artifact-validator.sh`

**Frontmatter Schemas** — Per artifact type, list required fields:
- Research: `date`, `github_issue`, `github_url`, `status`, `type: research`
- Plan: `date`, `status`, `github_issues` (array), `github_urls`, `primary_issue`
- Group plan: adds `stream_id`, `stream_issues`, `epic_issue` (when applicable)
- Critique: `date`, `github_issue`, `status`

Enablement: `[ ]` frontmatter validation is declared in `ralph-command-contracts.json` but no hook enforces schema.

**Artifact Comment Protocol** — How skills link artifacts to issues:
- Research: `## Research Document` header + URL on next line
- Plan: `## Implementation Plan` header + URL on next line
- Discovery: search comments for header, extract URL, convert to local path
- Passthrough: `RALPH_ARTIFACT_CACHE` caches validation results

Enablement: `[ ]` `artifact-discovery.sh` warns but does not block on missing comments.

**Research document content requirements**:
- MUST include `## Files Affected` section with `### Will Modify` and `### Will Read (Dependencies)` subsections

Enablement: `[x]` `research-postcondition.sh` validates `## Files Affected` exists.

### Success Criteria
- [x] Automated: `grep -c 'MUST' specs/artifact-metadata.md` > 5 (result: 40)
- [x] Automated: All 6 artifact types documented
- [x] Manual: Enablement checkboxes match actual hook enforcement

---

## Phase 3: Create `specs/skill-io-contracts.md`

### Changes Required

#### 1. Create `specs/skill-io-contracts.md`
**File**: `specs/skill-io-contracts.md` (new)
**Changes**: Define per-skill contracts from the research data:

**Skill contract table** — All 15 skills with columns: Skill, Valid Input States, Valid Output States, Lock State, Preconditions, Postconditions, Artifacts Required, Artifacts Created.

Source data: `ralph-command-contracts.json` + SKILL.md frontmatter (fully extracted in research doc).

**Stateless skills principle**: Skills MUST read all context from inputs (env vars, issue number, artifact comments). Skills MUST NOT carry state between invocations. Define the primary env vars: `RALPH_COMMAND`, `RALPH_TICKET_ID`, `RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER`.

**Standard result reporting schema**: Workers MUST call `TaskUpdate(metadata={...}, description="...")`. Define required metadata keys per phase:
- Research: `artifact_path`, `workflow_state`
- Plan: `artifact_path`, `phase_count`, `workflow_state`
- Review: `result` (APPROVED/NEEDS_ITERATION), `artifact_path`
- Impl: `worktree`, `phase_completed`, `pr_url` (if final)
- Split: `sub_tickets` (array of numbers), `estimates`
- Triage: `action` (RESEARCH/PLAN/CLOSE/SPLIT), `workflow_state`

Enablement for each requirement row — cross-reference with:
- State gate hooks: `[x]` research-state-gate.sh, triage-state-gate.sh, plan-state-gate.sh, impl-state-gate.sh, review-state-gate.sh, merge-state-gate.sh, pr-state-gate.sh
- Postcondition hooks: `[x]` research-postcondition.sh, plan-postcondition.sh, etc.
- Branch gate: `[x]` branch-gate.sh
- Result reporting schema: `[ ]` no hook validates TaskUpdate metadata keys

### Success Criteria
- [x] Automated: All 15 skills have entries in the contract table
- [x] Automated: `grep -c 'Enablement' specs/skill-io-contracts.md` > 0 (result: 6)
- [x] Manual: Each skill's contract matches its SKILL.md frontmatter and command-contracts.json

---

## Phase 4: Create `specs/skill-permissions.md`

### Changes Required

#### 1. Create `specs/skill-permissions.md`
**File**: `specs/skill-permissions.md` (new)
**Changes**: Define tool access controls per skill:

**Permissions matrix** — Rows: 15 ralph-* skills. Columns: Read, Write, Edit, Glob, Grep, Bash, Task, Skill, WebSearch, WebFetch, TaskCreate/List/Get/Update, SendMessage, TeamCreate/Delete, MCP tools (ralph_hero__*). Cells: allow / never.

Data source: SKILL.md `allowed-tools` frontmatter (complete matrix in research doc).

**Gap to document**: `ralph-status`, `ralph-report`, `ralph-hygiene`, `ralph-setup` have no `allowed-tools` in their SKILL.md. The spec MUST prescribe explicit tool lists for these skills:
- `ralph-status`: Read, Bash (read-only, queries dashboard)
- `ralph-report`: Read, Bash (queries dashboard, posts status update)
- `ralph-hygiene`: Read, Glob, Bash (queries board, identifies candidates)
- `ralph-setup`: Bash (creates project config)

Enablement: `[x]` `allowed-tools` is enforced by Claude Code's skill runtime (built-in, not a custom hook).

**Plugin-level overlay** — Document the 5 PreToolUse hooks from `hooks.json`:
1. `ralph_hero__update_workflow_state` → `pre-github-validator.sh`, `artifact-discovery.sh`
2. `ralph_hero__get_issue` → `pre-ticket-lock-validator.sh`, `skill-precondition.sh`
3. `ralph_hero__list_issues` → `skill-precondition.sh`
4. `Write` → `pre-artifact-validator.sh`
5. `Bash` → `pre-worktree-validator.sh`

And the 3 PostToolUse hooks:
1. `ralph_hero__update_workflow_state` → `post-github-validator.sh`
2. `ralph_hero__get_issue` → `post-blocker-reminder.sh`
3. `Bash` → `post-git-validator.sh`

Enablement: `[x]` `hooks.json` is loaded by Claude Code plugin runtime.

### Success Criteria
- [x] Automated: Matrix covers all 15 skills
- [x] Automated: All 10 plugin-level hooks documented (7 PreToolUse + 3 PostToolUse)
- [x] Manual: Matrix matches SKILL.md frontmatter for each skill

---

## Phase 5: Create `specs/agent-permissions.md`

### Changes Required

#### 1. Create `specs/agent-permissions.md`
**File**: `specs/agent-permissions.md` (new)
**Changes**: Define per-agent access controls:

**Agent tool whitelist** — One section per agent (analyst, builder, integrator):
- Full tool list from agent `.md` definition
- Model assignment (sonnet/haiku)
- Color assignment (for UI identification)

**PreToolUse gates** — Per agent, which tools require skill context:
- Analyst: `ralph_hero__save_issue|create_issue|create_comment|add_sub_issue|add_dependency|remove_dependency` → `require-skill-context.sh`
- Builder: `Write|Edit` → `require-skill-context.sh`
- Integrator: `ralph_hero__save_issue|advance_issue|create_comment` → `require-skill-context.sh`

Enablement: `[x]` all three agents have PreToolUse hooks registered in their `.md` definitions.

**Permission layering principle**: Agent tool list = maximum surface. Skill `allowed-tools` further restricts within a skill. PreToolUse gates additionally require `RALPH_COMMAND` for mutating tools. Three layers, each more restrictive:
1. Agent definition → broad tool list
2. Skill `allowed-tools` → subset for this skill
3. `require-skill-context.sh` → mutating tools blocked outside skill

Enablement: `[x]` all three layers are enforced by Claude Code runtime + hook scripts.

**Stop gate keyword mapping** — Per agent role, the `worker-stop-gate.sh` keywords:
- `analyst*` → "Triage, Split, Research, or Plan"
- `builder*` → "Review or Implement"
- `integrator*` → "Validate, Create PR, Merge, or Integrate"

Enablement: `[x]` `worker-stop-gate.sh` enforces keyword matching.

### Success Criteria
- [x] Automated: All 3 agents documented with complete tool lists
- [x] Automated: PreToolUse gate matchers match agent `.md` definitions
- [x] Manual: Permission layering principle clearly explained with example

---

## Integration Testing

- [x] `ls specs/*.md | wc -l` returns 5
- [x] Every spec file has `## Purpose` and `## Requirements` sections
- [x] Every Enablement column entry is either `[x] hook-name.sh` or `[ ] not enforced`
- [x] No spec contains "should" or "can" where "MUST" or "MUST NOT" is appropriate
- [x] Cross-references between specs use relative links (`[artifact-metadata](artifact-metadata.md)`)

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0468-scaffold-and-core-specs.md
- Parent plan: `thoughts/shared/plans/2026-02-28-ralph-protocol-specs.md`
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/467
