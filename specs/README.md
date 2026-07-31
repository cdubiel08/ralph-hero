# Ralph Protocol Specifications

## Purpose

This directory contains the authoritative contracts for the Ralph workflow. Each spec defines what MUST be true — independent of current enforcement level. Specs guide developers who build skills, hooks, and agent definitions.

**Audience**: Developers, NOT LLMs at runtime. LLMs receive guidance through shared fragments injected into skill prompts via `!`cat`` at load time. Specs are the source of truth that developers use to write those fragments and the hooks that enforce them.

## Three-Layer Architecture

| Layer | Audience | Purpose | Mechanism |
|-------|----------|---------|-----------|
| `specs/` | Developers | Authoritative contract — defines what MUST be true | Human-readable specs with enablement checklists |
| `skills/shared/fragments/` | LLMs (via injection) | Prose maintained once, inlined at load time | `!`cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/X.md`` |
| Hook scripts | Machine | Enforces requirements at tool boundaries | Shell scripts, exit 2 = block |

**Key principle**: No skill prompt should ever say "go read this other file." If the LLM needs guidance, it is inlined via `!`cat`` injection. If a requirement is machine-checkable, a hook enforces it. Specs guide the developers who write both.

## Enablement Checkbox Convention

Every requirement in a spec has an **Enablement** column:

| Symbol | Meaning |
|--------|---------|
| `[x] hook-name.sh` | Requirement is enforced by the named hook script |
| `[ ] not enforced` | Requirement is defined but not yet machine-enforced |

Specs do NOT change when enforcement is added — the checkbox flips. Unchecked requirements form the backlog for future enforcement work.

## Spec Template

Every spec follows this structure:

```markdown
# [Spec Name]

## Purpose
One sentence: what this spec governs.

## Definitions
Key terms used in this spec.

## Requirements

### [Requirement Group]

| Requirement | Enablement |
|-------------|------------|
| [Requirement text using MUST/MUST NOT] | [x] `hook-name.sh` or [ ] not enforced |

## Cross-References
Links to related specs.
```

Requirements use RFC 2119 language: **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, **MAY**.

## Spec Index

### Core Specs (Phase 1)

| Spec | Governs |
|------|---------|
| [artifact-metadata.md](artifact-metadata.md) | File naming patterns, frontmatter schemas, Artifact Comment Protocol |
| [skill-permissions.md](skill-permissions.md) | Tool access matrix per skill, plugin-level hook overlay |
| [agent-permissions.md](agent-permissions.md) | Per-agent tool whitelists, PreToolUse gates, stop gates |

### Lifecycle Specs (Phase 2)

| Spec | Governs |
|------|---------|
| [issue-lifecycle.md](issue-lifecycle.md) | State machine, transitions, creation requirements, status sync |
| [document-protocols.md](document-protocols.md) | Research, plan, and review document requirements |

### Coordination Specs (Phase 3)

| Spec | Governs |
|------|---------|
| [task-schema.md](task-schema.md) | TaskCreate/TaskUpdate fields, metadata keys, lifecycle |
| [team-schema.md](team-schema.md) | TeamCreate schema, roster sizing, spawn protocol, shutdown |

### Removed specs

`skill-io-contracts.md` was deleted. Do not re-create it. It described the `ralph-*` skill generation that shipped from `plugin/ralph-hero/` (deleted in GH-1438) — 27 references to skills that no longer exist, zero mentions of the current 9 verbs, half its named gate hooks gone, and an env-var table that contradicted the tracked-`settings.json` scope-var requirement. It had no consumer outside this directory.

Its content now lives in enforced, machine-readable form:

| What the spec claimed to govern | Live source |
|---|---|
| Per-skill input/output states, lock states, preconditions, postconditions | [`../ralph/hooks/scripts/ralph-state-machine.json`](../ralph/hooks/scripts/ralph-state-machine.json), read by the generic `state-gate.sh` |
| Which precondition/postcondition hooks a skill runs | The `hooks:` block in each `ralph/skills/<verb>/SKILL.md` frontmatter |
| Command-level result reporting schema | [`../ralph/skills/caretake/outcome-tokens.md`](../ralph/skills/caretake/outcome-tokens.md) (terminal tokens) and [`../ralph/skills/shared/loop-wrapper.md`](../ralph/skills/shared/loop-wrapper.md) (continuation rules) |
| Environment variables | Root [`../CLAUDE.md`](../CLAUDE.md) § Environment Variables — scope vars go in the **tracked** `<project>/.claude/settings.json`, tokens and machine-local toggles in the gitignored `settings.local.json` (see [`../ralph/skills/setup/scope-detection.md`](../ralph/skills/setup/scope-detection.md)) |

`state-gate.sh`'s own header records why prose duplication was the wrong shape: it replaced a per-verb gate family that "duplicated the state machine's `valid_output_states` as ten drifting bash literals." A prose spec is the same duplication with no test behind it.

## How to Use Specs

### When developing a new skill

1. Read [`../ralph/CLAUDE.md`](../ralph/CLAUDE.md) § Adding a new verb, then add the verb's command entry to [`../ralph/hooks/scripts/ralph-state-machine.json`](../ralph/hooks/scripts/ralph-state-machine.json) for its input/output states, lock states, preconditions, and postconditions
2. Read [skill-permissions.md](skill-permissions.md) for the tool access whitelist
3. Read [artifact-metadata.md](artifact-metadata.md) for file naming and frontmatter requirements
4. Read [document-protocols.md](document-protocols.md) for document structure requirements (if the skill produces artifacts)

### When developing a new hook

1. Find the unchecked (`[ ]`) requirements in the relevant spec — these are enforcement gaps
2. Write a hook that validates the requirement
3. Register the hook in `hooks.json` (plugin-level) or SKILL.md frontmatter (skill-level)
4. Flip the checkbox to `[x]` with the hook filename

### When developing a new agent

1. Read [agent-permissions.md](agent-permissions.md) for the permission layering model
2. Define the agent's tool whitelist (maximum surface)
3. Add PreToolUse gates for mutating tools via `require-skill-context.sh`
4. Define stop gate keywords for the worker-stop-gate

## Maturity Baseline

Enforcement coverage as of 2026-03-01, less the `skill-io-contracts.md` row (31 `[x]` / 5 `[ ]`) dropped when that spec was deleted. Each `[x]` requirement is enforced by a hook; each `[ ]` is a gap forming the backlog for future enforcement work.

| Spec | Enforced (`[x]`) | Gap (`[ ]`) | % Enforced |
|------|-----------------|------------|------------|
| artifact-metadata.md | 11 | 32 | 26% |
| skill-permissions.md | 6 | 5 | 55% |
| agent-permissions.md | 13 | 0 | 100% |
| issue-lifecycle.md | 18 | 7 | 72% |
| document-protocols.md | 10 | 14 | 42% |
| task-schema.md | 3 | 12 | 20% |
| team-schema.md | 3 | 15 | 17% |
| **Total** | **64** | **85** | **43%** |

These counts have not been re-derived since 2026-03-01 and predate the 9-verb restructure; treat them as historical, not as a current audit.

Largest gap areas: artifact-metadata.md (file naming, frontmatter field validation, artifact comment linking), task-schema.md and team-schema.md (coordination protocol is convention-only). These gaps form the backlog for Phase 5+ enforcement issues.
