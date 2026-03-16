---
date: 2026-02-28
status: draft
---

# Ralph Protocol Specification Plan

## Overview

Create a `specs/` directory at project root containing modular, authoritative specifications for the Ralph workflow. Each spec defines the contract — what MUST be true — independent of current enforcement level. Specs include enablement checklists to track which requirements are wired up via hooks.

Alongside specs, establish a shared fragment system using Claude Code's `!`backtick`` injection so that LLM-facing prose is maintained once and inlined into skill prompts at load time.

## Motivation

Ralph has no single source of truth for protocol requirements. Knowledge is scattered across hook scripts, SKILL.md bodies, and a legacy conventions.md file that skills reference at runtime — creating airgaps where the LLM may not read, misinterpret, or selectively apply protocol.

The result: token waste from repeated discovery, inconsistent enforcement, and no way to measure maturity.

### The Three-Layer Architecture

| Layer | Audience | Purpose | Mechanism |
|-------|----------|---------|-----------|
| `specs/` | Developers | Authoritative contract — defines what MUST be true | Human-readable specs with enablement checklists |
| `skills/shared/*.md` | LLMs (via injection) | Prose fragments maintained once, inlined at load time | `!`cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragment.md`` |
| Hook scripts | Machine | Enforces requirements at tool boundaries | Shell scripts, exit 2 = block |

**Key principle:** No skill prompt should ever say "go read this other file." If the LLM needs guidance, it's inlined via `!`backtick`` injection. If a requirement is machine-checkable, a hook enforces it. Specs guide the developers who write both.

## Principles

1. **Specs are definitive, not point-in-time.** A spec declares what's required. It doesn't soften language based on current state.
2. **Enablement checklists track enforcement.** Each requirement has a checkbox: checked = hook-enforced, unchecked = not yet enforced. The spec doesn't change when enforcement is added — the checkbox flips.
3. **Separation of concerns.** Each spec owns one topic. Cross-references use links, not duplication.
4. **Skills are stateless processes.** Every ralph-* skill has declared inputs, outputs, preconditions, and postconditions. The specs define these contracts.
5. **No runtime indirection.** No skill prompt references external files. Hooks enforce machine requirements. Shared fragments inject LLM guidance inline. Specs guide developers.
6. **Design from scratch.** Specs are designed from first principles, not migrated from conventions.md. conventions.md is legacy reference material only.

## Desired End State

```
specs/
├── README.md                    # Index, principles, how specs are structured
├── artifact-metadata.md         # File naming, frontmatter schemas, comment protocol
├── skill-io-contracts.md        # Per-skill input/output/precondition/postcondition
├── skill-permissions.md         # Tool permissions per ralph-* skill (allow/never)
├── agent-permissions.md         # Tool permissions per agent role, PreToolUse gates
├── issue-lifecycle.md           # Issue creation fields, state machine, transition rules
├── document-protocols.md        # Research + plan + review document requirements
├── task-schema.md               # TaskCreate/TaskUpdate fields, metadata keys, lifecycle
└── team-schema.md               # TeamCreate schema, roster sizing, spawn protocol, shutdown

plugin/ralph-hero/skills/shared/
├── fragments/                   # LLM-facing prose fragments (injected via !`cat`)
│   ├── artifact-discovery.md    # Steps for discovering linked artifacts
│   ├── error-handling.md        # Standard MCP error handling guidance
│   ├── team-reporting.md        # TaskUpdate result reporting steps
│   └── ...                      # Additional fragments as needed
└── quality-standards.md         # (existing, may be refactored into fragments)
```

Each spec file follows this template:

```markdown
# [Protocol Name]

## Purpose
One sentence: what this spec governs.

## Definitions
Key terms used in this spec.

## Requirements

### [Requirement Group]

| Requirement | Enablement |
|-------------|------------|
| Research docs MUST use frontmatter field `github_issue` | [x] `pre-artifact-validator.sh` |
| Plan docs MUST use frontmatter field `github_issues` (array) | [ ] not enforced |

## Cross-References
Links to related specs.
```

Skills inject shared fragments like:

```markdown
## Artifact Discovery

!`cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/artifact-discovery.md`

## Your Task
...
```

The LLM sees the expanded content inline. One file to maintain, N skills that include it.

## Phase 1: Scaffold and Core Specs

Design each spec from first principles. Use existing hook scripts and SKILL.md files as reference for what's currently enforced, but do not treat conventions.md as a template — design what SHOULD be true.

### 1.1 Create `specs/README.md`

Establish the directory. Document:
- Purpose: specs are the authoritative contract for Ralph protocol, for developers building skills and hooks
- Audience: developers, NOT LLMs at runtime
- The three-layer architecture (specs → shared fragments → hooks)
- Enablement checkbox convention
- Index linking to all specs
- How to use specs when developing a new skill or hook

### 1.2 Create `specs/artifact-metadata.md`

Requirements to define:
- File naming patterns per artifact type (research, plan, group plan, stream plan, review, report)
- Frontmatter field schemas per artifact type
- Artifact Comment Protocol — section headers, format, discovery sequence
- Passthrough protocol for artifact paths between skills
- Zero-padding convention

### 1.3 Create `specs/skill-io-contracts.md`

Requirements to define:
- Per-skill table: inputs (args, env vars, required artifacts), outputs (artifacts, state transitions, metadata keys)
- Preconditions (branch, state, required prior artifacts)
- Postconditions (what Stop hook validates)
- The principle: skills are stateless — all context comes from inputs, all results go to outputs
- Standard result reporting schema for team workers (TaskUpdate metadata + description)

### 1.4 Create `specs/skill-permissions.md`

Requirements to define:
- Matrix: rows = ralph-* skills, columns = tool categories
- Per cell: allow / never (skills use `allowed-tools` whitelist)
- Plugin-level overlay from `hooks.json`

### 1.5 Create `specs/agent-permissions.md`

Requirements to define:
- Per-agent tool whitelist
- Per-agent PreToolUse gates (require-skill-context enforcement)
- Permission layering: agent restrictions apply ON TOP of skill permissions
- Stop gate keyword mapping per role

## Phase 2: Lifecycle and Document Specs

### 2.1 Create `specs/issue-lifecycle.md`

Requirements to define:
- Full state machine (all workflow states, valid transitions)
- Required fields at issue creation
- State ownership by skill (which skills can transition to which states)
- Status sync rules (workflow state → Status field mapping)
- Close/reopen semantics
- Semantic intents (__LOCK__, __COMPLETE__, etc.)

### 2.2 Create `specs/document-protocols.md`

Requirements to define:

**Research documents:**
- Required sections
- Frontmatter field requirements
- Quality criteria
- Commit/push requirements
- Artifact comment requirements
- Valid output states

**Plan documents:**
- Required sections (phases, success criteria, what we're NOT doing)
- Frontmatter field requirements (single vs group vs stream)
- Phase structure
- Success criteria format (automated vs manual)
- Research prerequisite
- Convergence verification for groups

**Review documents:**
- Required sections (verdict, critique)
- Verdict values
- Artifact comment format

## Phase 3: Coordination Specs

### 3.1 Create `specs/task-schema.md`

Requirements to define:
- TaskCreate required fields (subject, description, activeForm, metadata)
- Metadata schema: required keys per phase, optional keys
- TaskUpdate result schema: what workers MUST set on completion
- Blocking/dependency patterns
- Hook integration points (TaskCompleted, worker-stop-gate keyword matching)
- Subject naming convention for keyword matching

### 3.2 Create `specs/team-schema.md`

Requirements to define:
- TeamCreate MUST precede TaskCreate ordering
- Roster sizing rules
- Worker spawn protocol (subagent_type, team_name, name, prompt requirements)
- Worker role contracts
- Sub-agent team isolation (no team_name on internal Task calls)
- Shutdown protocol
- Post-mortem requirements

## Phase 4: Shared Fragments and Skill Prompt Refactor

### 4.1 Design shared fragment library

Based on specs, identify prose that multiple skills need. Create `skills/shared/fragments/` with one .md file per fragment. Each fragment is self-contained LLM guidance — no references to other files.

### 4.2 Refactor skill prompts

For each SKILL.md:
- Remove all references to conventions.md
- Replace duplicated protocol prose with `!`cat`` injections of shared fragments
- Ensure each skill prompt is self-contained after injection (LLM sees everything it needs)
- Keep skill-specific logic inline (not in fragments)

### 4.3 Delete conventions.md

All content has been either:
- Designed from scratch in specs (developer reference)
- Enforced by hooks (machine boundary)
- Written as shared fragments and injected into skill prompts (LLM guidance)

Delete `plugin/ralph-hero/skills/shared/conventions.md`.

### 4.4 Audit enablement checkboxes

Walk through every requirement in every spec. Check the box if a hook enforces it. Leave unchecked if not yet enforced. This produces the maturity baseline and becomes the backlog for future enforcement work.

## What We're NOT Doing

- **JSON Schema validators** — premature. Enablement checklists track gaps.
- **Automated spec compliance testing** — future work. Specs establish what to test.
- **New hooks** — this plan creates specs and fragments, not new enforcement. New hooks are separate issues driven by enablement gaps.
- **Migrating conventions.md** — we're designing from scratch, not porting legacy content.

## Success Criteria

### Automated Verification
- [ ] `specs/` directory exists with all 9 files (README + 8 specs)
- [ ] Every spec follows the template structure (Purpose, Definitions, Requirements with Enablement)
- [ ] `skills/shared/fragments/` directory exists with shared prose fragments
- [ ] `conventions.md` is deleted
- [ ] No SKILL.md contains "See shared/conventions.md" or "See conventions.md"
- [ ] All SKILL.md files that need shared prose use `!`cat`` injection pattern

### Manual Verification
- [ ] Each spec is self-contained and designed from first principles
- [ ] Enablement checkboxes accurately reflect current hook enforcement
- [ ] Skill prompts are self-contained after fragment injection — no runtime indirection
- [ ] A developer can read any spec and understand what hooks to write and what fragments to create

## References

- v4 architecture spec: `thoughts/shared/plans/2026-02-22-ralph-workflow-v4-architecture-spec.md`
- Artifact pipeline spec: `thoughts/shared/plans/2026-02-24-GH-0380-artifact-pipeline-specification.md`
- Worker scope boundaries: `thoughts/shared/research/2026-02-17-GH-0044-worker-scope-boundaries.md`
- Enforce skill context plan: `thoughts/shared/plans/2026-02-26-enforce-skill-context-for-workers.md`
- GH-451 team post-mortem: `thoughts/shared/reports/2026-02-27-ralph-team-GH-451.md`
- Legacy conventions (reference only): `plugin/ralph-hero/skills/shared/conventions.md`
