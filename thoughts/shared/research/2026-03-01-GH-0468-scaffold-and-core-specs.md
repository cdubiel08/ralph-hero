---
date: 2026-03-01
github_issue: 468
github_url: https://github.com/cdubiel08/ralph-hero/issues/468
status: complete
type: research
---

# Research: Ralph Protocol Specs Phase 1 — Scaffold and Core Specs

## Problem Statement

Ralph has no single source of truth for protocol requirements. The five core spec files to be created in Phase 1 — `specs/README.md`, `specs/artifact-metadata.md`, `specs/skill-io-contracts.md`, `specs/skill-permissions.md`, and `specs/agent-permissions.md` — must be designed from first principles based on what actually exists in hook scripts, skill frontmatter, and agent definitions today.

This research documents what currently exists so the spec author can design correct, enforceable requirements.

---

## Current State Analysis

### 1. Artifact Metadata (for `specs/artifact-metadata.md`)

#### File Naming Patterns

From `ralph-command-contracts.json` and actual filesystem examples:

| Artifact Type | Pattern | Example |
|--------------|---------|---------|
| Research doc | `thoughts/shared/research/YYYY-MM-DD-GH-{NNNN}-{slug}.md` | `2026-02-16-GH-0019-validated-handoff-ticket-tool.md` |
| Plan doc (single) | `thoughts/shared/plans/YYYY-MM-DD-GH-{NNNN}-{slug}.md` | `2026-02-16-GH-0019-validated-handoff-ticket-tool.md` |
| Plan doc (group) | `thoughts/shared/plans/YYYY-MM-DD-group-GH-{NNNN}-{slug}.md` | `2026-02-22-group-GH-0352-v4-architecture-specification.md` |
| Review/critique | `thoughts/shared/reviews/YYYY-MM-DD-GH-{NNNN}-critique.md` | (pattern only) |
| Report | `thoughts/shared/reports/YYYY-MM-DD-*.md` | (pattern only) |

**Zero-padding**: Issue numbers use 4-digit zero-padding in artifact filenames (`GH-0019`, not `GH-19`). This is enforced by `artifact-discovery.sh:54` which computes `padded=$(printf '%04d' "$number")`.

#### Frontmatter Schemas

Research documents MUST include `github_issue` and `status` fields (validated by `artifact_types.research.validates` in `ralph-command-contracts.json`). Plan documents MUST include `github_issue`, `status`, and phase definitions. Critique documents MUST include `date`, `github_issue`, and `status`.

Currently enforced: `pre-artifact-validator.sh` blocks duplicate artifact creation for research and plan docs. `research-postcondition.sh` requires `## Files Affected` section.

#### Artifact Comment Protocol

Skills post artifact links as GitHub comments with a specific header:
- Research: `## Research Document` header (checked by `artifact-discovery.sh:57`)
- Plan: `## Implementation Plan` header (checked by `artifact-discovery.sh:63`)

Discovery sequence: check issue comments for the header → extract URL → use as artifact path.

Passthrough: `RALPH_ARTIFACT_CACHE` env var caches validation results between hook calls to avoid redundant API calls.

### 2. Skill I/O Contracts (for `specs/skill-io-contracts.md`)

Full data extracted from SKILL.md frontmatter and `ralph-command-contracts.json`:

#### Per-Skill Contract Summary

| Skill | Input States | Output States | Lock State | Requires | Creates |
|-------|-------------|--------------|------------|---------|---------|
| `ralph-triage` | Backlog | Research Needed, Ready for Plan, Done, Canceled, Human Needed | none | main branch | comment |
| `ralph-split` | Backlog, Research Needed | Backlog (sub-issues) | none | main branch, M/L/XL estimate | sub-issues, blocking relationships |
| `ralph-research` | Research Needed | Ready for Plan, Human Needed | Research in Progress | main branch, XS/S estimate, no existing research | research doc committed, comment with doc URL |
| `ralph-plan` | Ready for Plan | Plan in Review, Human Needed | Plan in Progress | main branch, XS/S estimate, research doc attached, no existing plan | plan doc committed, comment with doc URL |
| `ralph-review` | Plan in Review | In Progress, Ready for Plan, Human Needed | none | main branch, XS/S estimate, plan doc | state change, critique doc if AUTO mode |
| `ralph-impl` | Plan in Review, In Progress | In Progress, In Review, Human Needed | none | plan doc attached, approved | commits, worktree, PR on final phase |
| `ralph-val` | any (reads plan) | pass/fail verdict | none | plan doc | pass/fail report |
| `ralph-pr` | (impl complete) | In Review, Human Needed | none | completed impl, worktree | PR, state change to In Review |
| `ralph-merge` | In Review | Done, Human Needed | none | merged PR | state change to Done, worktree cleanup |
| `ralph-status` | read-only | no state changes | none | none | dashboard output |
| `ralph-report` | read-only | no state changes | none | none | status update posted |
| `ralph-hygiene` | read-only | no state changes | none | main branch | archive candidates report |
| `ralph-hero` | Backlog through In Progress | In Review, Human Needed | none | main branch, issue number | delegates to split/research/plan/review/impl |
| `ralph-team` | any | In Review, Human Needed | none | none | spawns analyst/builder/integrator workers |
| `ralph-setup` | none | none | none | none | GitHub Project V2 config |

**Stateless skills principle**: Each skill reads all context from inputs (env vars, issue number, artifact comments). No skill carries state between invocations. `RALPH_COMMAND`, `RALPH_TICKET_ID`, `RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER` are the primary env inputs.

**Standard result reporting for team workers** (from `conventions.md`): Workers MUST call `TaskUpdate(metadata={...}, description="...")` on completion. `metadata` keys: `artifact_path`, `result`, `sub_tickets`, `worktree`, `pr_url`. `description` is the human-readable summary. `SendMessage` is reserved for escalations only.

### 3. Skill Permissions (for `specs/skill-permissions.md`)

Extracted from SKILL.md `allowed-tools` frontmatter:

| Tool | triage | split | research | plan | impl | review | hero | team | merge | pr | val | status | report | hygiene | setup |
|------|--------|-------|----------|------|------|--------|------|------|-------|----|----|--------|--------|---------|-------|
| Read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | — |
| Write | — | — | ✓ | ✓ | ✓ | ✓ | — | ✓ | — | — | — | — | — | — | — |
| Edit | — | — | — | — | ✓ | — | — | — | — | — | — | — | — | — | — |
| Glob | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | — | — | — | — |
| Grep | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | ✓ | — | — | — | — |
| Bash | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | — |
| Task | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | — | — | — | — |
| Skill | — | — | — | — | — | — | ✓ | ✓ | ✓ | — | — | — | — | — | — |
| WebSearch | ✓ | — | ✓ | — | — | — | — | — | — | — | — | — | — | — | — |
| WebFetch | — | — | ✓ | — | — | — | — | — | — | — | — | — | — | — | — |
| TaskCreate/List/Get/Update | — | — | — | — | — | — | — | ✓ | — | — | — | — | — | — | — |
| SendMessage | — | — | — | — | — | — | — | ✓ | — | — | — | — | — | — | — |
| TeamCreate/Delete | — | — | — | — | — | — | — | ✓ | — | — | — | — | — | — | — |
| MCP tools (ralph_hero__*) | indirect | indirect | indirect | indirect | indirect | indirect | indirect | indirect | direct | direct | — | — | — | — | — |

**Plugin-level overlay** (`hooks.json`): The plugin adds PreToolUse hooks on `ralph_hero__update_workflow_state` (pre-github-validator, artifact-discovery), `ralph_hero__get_issue` (pre-ticket-lock-validator, skill-precondition), `ralph_hero__list_issues` (skill-precondition), `Write` (pre-artifact-validator), and `Bash` (pre-worktree-validator). These apply across all skills regardless of skill-level `allowed-tools`.

### 4. Agent Permissions (for `specs/agent-permissions.md`)

From agent `.md` files in `plugin/ralph-hero/agents/`:

#### ralph-analyst (green, sonnet)
- **Tools**: Read, Write, Glob, Grep, Skill, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__save_issue, ralph_hero__create_issue, ralph_hero__create_comment, ralph_hero__add_sub_issue, ralph_hero__add_dependency, ralph_hero__remove_dependency, ralph_hero__list_sub_issues
- **PreToolUse gate**: `require-skill-context.sh` on `ralph_hero__save_issue|ralph_hero__create_issue|ralph_hero__create_comment|ralph_hero__add_sub_issue|ralph_hero__add_dependency|ralph_hero__remove_dependency` — blocks if `RALPH_COMMAND` not set (i.e., outside skill context)
- **Stop gate**: `worker-stop-gate.sh` — keywords "Triage, Split, Research, or Plan"

#### ralph-builder (cyan, sonnet)
- **Tools**: Read, Write, Edit, Bash, Glob, Grep, Skill, TaskList, TaskGet, TaskUpdate, SendMessage
- **PreToolUse gate**: `require-skill-context.sh` on `Write|Edit` — blocks if `RALPH_COMMAND` not set
- **Stop gate**: `worker-stop-gate.sh` — keywords "Review or Implement"

#### ralph-integrator (orange, haiku)
- **Tools**: Read, Glob, Bash, Skill, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__save_issue, ralph_hero__create_comment, ralph_hero__advance_issue, ralph_hero__list_sub_issues
- **PreToolUse gate**: `require-skill-context.sh` on `ralph_hero__save_issue|ralph_hero__advance_issue|ralph_hero__create_comment`
- **Stop gate**: `worker-stop-gate.sh` — keywords "Validate, Create PR, Merge, or Integrate"

**Permission layering**: Agent tool lists are the maximum surface. Skill `allowed-tools` whitelists further restrict within a skill invocation. Agent PreToolUse gates (`require-skill-context.sh`) additionally require `RALPH_COMMAND` to be set (i.e., tool calls must happen inside a skill, not raw agent calls).

**Stop gate keyword matching** (`worker-stop-gate.sh`): Matches `$TEAMMATE` env var prefix (analyst*, builder*, integrator*) to role-specific task subject keywords. Forces one TaskList check before allowing idle.

---

## Key Discoveries

### Discovery 1: Two Levels of Permission Enforcement
There is a two-tier system: (1) `allowed-tools` in SKILL.md restricts what tools a skill can use, and (2) `require-skill-context.sh` in agent PreToolUse hooks restricts which tools require an active skill context. The second layer prevents agents from making mutating calls (write, state changes) outside of skill invocations.

### Discovery 2: The `hooks.json` Plugin Overlay Is Sparse
The plugin-level `hooks.json` only registers 5 hooks covering `update_workflow_state`, `get_issue`, `list_issues`, `Write`, and `Bash`. All skill-specific hooks are registered in SKILL.md frontmatter. The plugin overlay is for cross-cutting concerns (precondition validation, artifact duplication prevention).

### Discovery 3: Zero-Padding Is Only Partially Enforced
Zero-padding (`GH-0019`) is used in artifact filenames (evidenced by all existing research/plan docs) and the `artifact-discovery.sh` script generates the padded form for its reminder message. However, there is no PreToolUse hook that validates the padded format on Write calls — only `pre-artifact-validator.sh` which checks for duplicates.

### Discovery 4: Artifact Comment Protocol Is Convention, Not Hard Enforcement
The `artifact-discovery.sh` hook only warns (not blocks) when artifact comments are missing. The hard postcondition enforcement is in `research-postcondition.sh` (checks for `## Files Affected` section in the doc itself) and `plan-postcondition.sh` (checks file exists and is committed). The comment linking is validated by the skill's own workflow, not a hard gate.

### Discovery 5: `ralph-status`, `ralph-report`, `ralph-hygiene` Have No `allowed-tools`
These three skills have no `allowed-tools` declared in their SKILL.md frontmatter. This appears to be an omission — they are read-only skills but without explicit whitelisting, they may inherit broader defaults. The spec should define what they MUST NOT do (no state changes, no writes).

### Discovery 6: Worker Stop Gate Uses Name Prefix Pattern
The `worker-stop-gate.sh` script matches `$TEAMMATE` against `analyst*`, `builder*`, `integrator*` patterns — so team members named "analyst-1", "analyst-2" all get the analyst keyword set. This is the current keyword-based task matching mechanism.

---

## Recommended Next Steps (for Planning)

1. **Start with `specs/README.md`** — establishes the template all other specs follow. Must define: Purpose/Definitions/Requirements with Enablement table format, enablement checkbox convention, three-layer architecture, and audience boundary (developers not LLMs).

2. **`specs/artifact-metadata.md`** can be written in full from this research — all patterns are documented above. Design requirement: zero-padding MUST be enforced (currently only convention).

3. **`specs/skill-io-contracts.md`** is mostly derivable from `ralph-command-contracts.json` and skill frontmatter. The gap: no formal definition of the team worker result reporting schema. Spec should define required metadata keys per phase.

4. **`specs/skill-permissions.md`** matrix is complete from frontmatter extraction. Gap to note: `ralph-status`, `ralph-report`, `ralph-hygiene` lack explicit `allowed-tools` — spec should prescribe them.

5. **`specs/agent-permissions.md`** is well-documented from agent files. Key requirement to specify: the `require-skill-context.sh` gate applies to mutating tools — spec should enumerate which tools per agent require skill context vs which can be called directly.

---

## Risks

- **Scope creep into Phase 2-4**: The core specs reference lifecycle, documents, and team coordination. Define boundaries clearly — Phase 1 specs define what MUST be true, but leave lifecycle state machine details to Phase 2.
- **Spec staleness**: As skills evolve, specs must be updated. The enablement checkbox mechanism helps track divergence but relies on manual audit (Phase 4).
- **No automated spec validation**: There is currently no CI check that validates specs against actual hook scripts or skill frontmatter. Phase 4 audit will establish the baseline; automated checks are explicitly out of scope.

---

## Files Affected

### Will Modify
- `specs/README.md` — new file to create
- `specs/artifact-metadata.md` — new file to create
- `specs/skill-io-contracts.md` — new file to create
- `specs/skill-permissions.md` — new file to create
- `specs/agent-permissions.md` — new file to create

### Will Read (Dependencies)
- `plugin/ralph-hero/hooks/hooks.json` — plugin-level hook registration
- `plugin/ralph-hero/hooks/scripts/ralph-command-contracts.json` — command preconditions/postconditions
- `plugin/ralph-hero/hooks/scripts/ralph-state-machine.json` — state machine definitions
- `plugin/ralph-hero/hooks/scripts/require-skill-context.sh` — agent permission gate implementation
- `plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh` — worker stop gate with keyword matching
- `plugin/ralph-hero/hooks/scripts/set-skill-env.sh` — skill env initialization
- `plugin/ralph-hero/hooks/scripts/research-postcondition.sh` — research artifact requirements
- `plugin/ralph-hero/hooks/scripts/plan-postcondition.sh` — plan artifact requirements
- `plugin/ralph-hero/hooks/scripts/artifact-discovery.sh` — artifact comment protocol implementation
- `plugin/ralph-hero/hooks/scripts/pre-artifact-validator.sh` — duplicate artifact prevention
- `plugin/ralph-hero/skills/ralph-*/SKILL.md` — all skill frontmatter (allowed-tools, hooks)
- `plugin/ralph-hero/agents/ralph-analyst.md` — analyst agent tools and hooks
- `plugin/ralph-hero/agents/ralph-builder.md` — builder agent tools and hooks
- `plugin/ralph-hero/agents/ralph-integrator.md` — integrator agent tools and hooks
- `plugin/ralph-hero/skills/shared/conventions.md` — legacy reference only (do not migrate)
