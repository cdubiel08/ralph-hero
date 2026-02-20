---
date: 2026-02-19
github_issue: 137
github_url: https://github.com/cdubiel08/ralph-hero/issues/137
status: complete
type: research
---

# GH-137: Update ralph-team SKILL.md Section 9 to Remove Custom Agent Tool Restriction Docs

## Problem Statement

Section 9 ("Known Limitations") of `ralph-team/SKILL.md` contains a bullet point (line 258) that documents custom agent tool restrictions:

> **Teammate GitHub access**: All 4 workers have scoped `ralph_hero__*` MCP tool access in their frontmatter. `Skill()` runs inline and inherits the calling agent's tool restrictions, so these tools MUST remain in agent frontmatter even when accessed indirectly through skills. Analyst has the widest set (14 tools); validator has the narrowest (5 tools).

This documentation becomes obsolete once the team migrates from custom agent types (`ralph-analyst`, `ralph-builder`, `ralph-validator`, `ralph-integrator`) to `general-purpose` subagents (parent issue GH-133). General-purpose subagents have full tool access by definition -- there are no scoped tool restrictions to document.

## Current State Analysis

### Section 9 Content (Lines 252-265)

The full Section 9 has 12 bullet points. Only **one** bullet needs removal:

- **Line 258** ("Teammate GitHub access"): Documents the scoped MCP tool access model that is specific to custom agent types. This entire bullet becomes invalid when workers are `general-purpose`.

### What Does NOT Change

The remaining 11 bullet points in Section 9 are all agent-type-agnostic:

| Bullet | Topic | Agent-type dependent? |
|--------|-------|----------------------|
| Line 254 | Idle is NORMAL | No |
| Line 255 | Task status may lag | No |
| Line 256 | Task list scoping | No |
| Line 257 | State trusts GitHub | No |
| Line 259 | No external momentum | No |
| Line 260 | No session resumption | No |
| Line 261 | Pull-based claiming | No |
| Line 262 | Task description = results channel | No |
| Line 263 | Lead name hardcoded | No |
| Line 264 | Fire-and-forget messages | No |
| Line 265 | Peer handoff depends on workers existing | No |

### Line 265 Assessment

The triage comment flagged line 265 ("Peer handoff depends on workers existing") as potentially needing a minor clarification about peers being identified by `name` rather than `agentType`. However, this line already uses generic "worker" language and does not reference `agentType` at all:

> **Peer handoff depends on workers existing**: If a stage has no worker (never spawned or crashed), the handoff falls back to the lead. The lead must then spawn a replacement.

The `agentType`-based peer discovery is documented in `conventions.md` (GH-136's scope), not in Section 9. Line 265 is about the behavioral limitation (handoff fails if no peer exists), which applies regardless of agent type. **No change needed for line 265.**

## Key Discoveries

### 1. Single Bullet Removal

The change is a pure deletion of the "Teammate GitHub access" bullet (line 258). No replacement text is needed because:

- `general-purpose` subagents have full tool access -- there is nothing to document about restrictions
- The Bowser research (GH-132) confirmed that agent-level tool restrictions are an anti-pattern -- enforcement belongs at the skill layer via `allowed_tools` if needed
- The `Skill()` inheritance warning is moot because `general-purpose` agents inherit no restrictions

### 2. No Replacement Bullet Needed

One might consider adding a new limitation like "Teammates have full tool access" -- but this is not a limitation, it is the expected behavior. The Known Limitations section documents constraints and gotchas, not normal behavior.

### 3. File and Line Reference

- **File**: [`plugin/ralph-hero/skills/ralph-team/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md)
- **Section**: Section 9 - Known Limitations (line 252)
- **Target bullet**: Line 258 (the "Teammate GitHub access" bullet)

### 4. Scope Boundary

This issue (GH-137) ONLY touches Section 9. Other sections of SKILL.md are covered by sibling issues:
- GH-134: Section 6 spawn table (Agent type column)
- GH-135: Spawn templates (self-contained for general-purpose)
- GH-136: conventions.md handoff protocol (agentType references)

## Potential Approaches

### Approach A: Delete the Bullet (Recommended)

Simply remove the entire "Teammate GitHub access" bullet point (line 258). No replacement.

**Pros**:
- Clean, minimal change
- No new documentation to maintain
- Consistent with the fact that full tool access is not a "limitation"

**Cons**:
- None identified

### Approach B: Replace with General-Purpose Note

Replace the bullet with something like: "**Teammates have full tool access**: Workers are `general-purpose` subagents with unrestricted tool access. Tool restrictions, if needed, should be applied at the skill level via `allowed_tools` frontmatter."

**Pros**:
- Documents the architectural decision for future maintainers

**Cons**:
- This is not a "limitation" -- it does not belong in the Known Limitations section
- Adds maintenance burden for a non-constraint
- The architectural rationale is already documented in the GH-132 research document

## Risks

- **Low risk**: This is a single-line documentation deletion in a markdown file. No code changes, no behavioral impact.
- **Ordering dependency**: GH-134 changes the spawn table first, making the custom agent types obsolete. GH-137 should be implemented after or alongside GH-134 to avoid documenting restrictions for agent types that still appear in the spawn table.

## Recommended Next Steps

1. **Implementation**: Delete line 258 (the "Teammate GitHub access" bullet) from Section 9
2. **Verify**: Confirm no other references to "scoped tool access" or "tool restrictions" exist in SKILL.md Section 9
3. **Coordinate**: Ensure GH-134 (spawn table update) is complete or in-flight before merging, so the documentation matches the spawn table
