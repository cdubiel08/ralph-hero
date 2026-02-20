---
date: 2026-02-19
github_issue: 134
github_url: https://github.com/cdubiel08/ralph-hero/issues/134
status: complete
type: research
---

# GH-134: Update ralph-team SKILL.md Spawn Table to Use General-Purpose Subagent Type

## Problem Statement

The spawn table in `ralph-team/SKILL.md` Section 6 (lines 168-177) currently specifies custom agent types (`ralph-analyst`, `ralph-builder`, `ralph-validator`, `ralph-integrator`) in the "Agent type" column. These custom types are used in the `Task(subagent_type="[agent-type]", ...)` call on line 193. The ralph-hero SKILL.md already uses `general-purpose` for all spawns, matching the Bowser reference architecture and the original `~/projects/.claude/commands/ralph_hero.md` pattern. This issue aligns the ralph-team spawn table to the same pattern.

## Current State Analysis

### Spawn Table (Section 6, lines 168-177)

```markdown
| Task subject contains | Role | Template | Agent type |
|----------------------|------|----------|------------|
| "Triage" | analyst | `triager.md` | ralph-analyst |
| "Split" | analyst | `splitter.md` | ralph-analyst |
| "Research" | analyst | `researcher.md` | ralph-analyst |
| "Plan" (not "Review") | builder | `planner.md` | ralph-builder |
| "Review" | validator | `reviewer.md` | ralph-validator |
| "Implement" | builder | `implementer.md` | ralph-builder |
| "Create PR" | integrator | `integrator.md` | ralph-integrator |
| "Merge" or "Integrate" | integrator | `integrator.md` | ralph-integrator |
```

### Spawn Call (Section 6, line 191-196)

```markdown
4. **Spawn**:
   ```
   Task(subagent_type="[agent-type]", team_name=TEAM_NAME, name="[role]",
        prompt=[resolved template content],
        description="[Role] GH-NNN")
   ```
```

The `[agent-type]` placeholder on line 193 references the "Agent type" column from the spawn table.

### Reference Pattern (ralph-hero SKILL.md)

The ralph-hero orchestrator uses `general-purpose` for all 6 `Task()` calls:

```
Task(subagent_type="general-purpose", run_in_background=true,
     prompt="Use Skill(skill='ralph-hero:ralph-research', args='NNN') ...",
     description="Research GH-NNN")
```

This pattern is consistent across split, research, plan, review, and implement phases.

## Key Findings

### 1. Change is confined to Section 6 of ralph-team/SKILL.md

The custom agent type strings (`ralph-analyst`, `ralph-builder`, `ralph-validator`, `ralph-integrator`) appear ONLY in the spawn table rows (lines 170-177) within the entire `ralph-team/SKILL.md`. The spawn call on line 193 uses `[agent-type]` as a placeholder referencing the table, so updating the table values automatically updates the effective spawn call.

**Specific lines to change**:
- Line 170: `ralph-analyst` -> `general-purpose`
- Line 171: `ralph-analyst` -> `general-purpose`
- Line 172: `ralph-analyst` -> `general-purpose`
- Line 173: `ralph-builder` -> `general-purpose`
- Line 174: `ralph-validator` -> `general-purpose`
- Line 175: `ralph-builder` -> `general-purpose`
- Line 176: `ralph-integrator` -> `general-purpose`
- Line 177: `ralph-integrator` -> `general-purpose`

### 2. The spawn call example should also be updated

Line 193 shows `Task(subagent_type="[agent-type]", ...)`. Since all agent types are now `general-purpose`, the placeholder indirection is no longer needed. The spawn call example could be updated to use a literal `"general-purpose"` for clarity:

```
Task(subagent_type="general-purpose", team_name=TEAM_NAME, name="[role]",
     prompt=[resolved template content],
     description="[Role] GH-NNN")
```

### 3. The "Agent type" column header could be renamed or removed

Since all rows have the same value (`general-purpose`), the column provides no differentiation. Two options:

- **Option A**: Keep the column with all values set to `general-purpose` (preserves table structure, makes the pattern explicit)
- **Option B**: Remove the "Agent type" column entirely (reduces noise, acknowledges uniformity)

**Recommendation**: Option A. Keeping the column makes the subagent type visible at the point where spawning is documented. The column serves as documentation even when all values are identical -- it prevents future contributors from wondering "what subagent type should I use?"

### 4. Spawn templates reference "your agent definition" -- out of scope

All 7 spawn templates contain the phrase "per your agent definition" or "in your agent definition". When spawned as `general-purpose`, there is no custom agent definition file to reference. However, updating spawn templates is explicitly the scope of sibling issue #135 ("Update spawn templates to be self-contained for general-purpose agents"). Issue #134 should NOT modify templates.

### 5. conventions.md Pipeline Handoff table uses custom agent types -- out of scope

The Pipeline Handoff Protocol in `shared/conventions.md` (lines 97-103) and the Template Naming Convention table (lines 221-227) reference custom agent types. This is the scope of sibling issue #136 ("Update conventions.md handoff protocol for general-purpose agent types"). Issue #134 should NOT modify conventions.md.

### 6. Section 9 Known Limitations references tool restrictions -- out of scope

Line 258 in Section 9 states: "Teammate GitHub access: All 4 workers have scoped `ralph_hero__*` MCP tool access in their frontmatter." This is the scope of sibling issue #137. Issue #134 should NOT modify Section 9.

## Risks and Edge Cases

### Risk: Behavioral regression from losing tool restrictions

Custom agent types had explicit `tools:` frontmatter restricting available tools. `general-purpose` agents have unrestricted tool access. This means workers could potentially use tools outside their intended scope.

**Mitigation**: The Bowser research (GH-132) explicitly validated that tool restrictions belong at the skill layer (`allowed_tools` in SKILL.md frontmatter), not at the agent layer. The parent issue's plan (GH-132) adds `allowed_tools` to all skill frontmatter as a separate concern. Additionally, the spawn templates + skill invocation pattern constrain behavior through documentation -- the same approach Bowser uses.

### Risk: Team config peer discovery still uses agentType

The Pipeline Handoff Protocol (conventions.md lines 110-120) instructs workers to read `~/.claude/teams/[TEAM_NAME]/config.json` and find peers by `agentType`. If all workers become `general-purpose`, this lookup breaks because all entries have the same `agentType`.

**Mitigation**: This is sibling issue #136's scope. The handoff protocol will switch from `agentType` to `name` for peer discovery. Issue #134 does not break the handoff protocol by itself -- the protocol currently works because the custom agent types match, and after #134 but before #136, it would still work because the team config file would reflect the new `general-purpose` type (all rows match, so the first match of the target type would still resolve correctly, though ambiguously). The real fix is in #136.

### Edge case: Per-role instance limits reference role names, not agent types

Section 6's "Per-Role Instance Limits" (lines 217-220) references roles (`Analyst`, `Builder`, `Validator`, `Integrator`), not agent types. These role names are used for the `name` parameter in `Task()`, not `subagent_type`. This section is unaffected by the change.

## Recommended Approach

**Minimal, focused change**: Update the 8 cells in the spawn table's "Agent type" column from custom types to `general-purpose`, and update the spawn call example to use a literal `"general-purpose"`. Keep the "Agent type" column for documentation clarity.

### Before

```markdown
| Task subject contains | Role | Template | Agent type |
|----------------------|------|----------|------------|
| "Triage" | analyst | `triager.md` | ralph-analyst |
| "Split" | analyst | `splitter.md` | ralph-analyst |
| "Research" | analyst | `researcher.md` | ralph-analyst |
| "Plan" (not "Review") | builder | `planner.md` | ralph-builder |
| "Review" | validator | `reviewer.md` | ralph-validator |
| "Implement" | builder | `implementer.md` | ralph-builder |
| "Create PR" | integrator | `integrator.md` | ralph-integrator |
| "Merge" or "Integrate" | integrator | `integrator.md` | ralph-integrator |
```

### After

```markdown
| Task subject contains | Role | Template | Agent type |
|----------------------|------|----------|------------|
| "Triage" | analyst | `triager.md` | general-purpose |
| "Split" | analyst | `splitter.md` | general-purpose |
| "Research" | analyst | `researcher.md` | general-purpose |
| "Plan" (not "Review") | builder | `planner.md` | general-purpose |
| "Review" | validator | `reviewer.md` | general-purpose |
| "Implement" | builder | `implementer.md` | general-purpose |
| "Create PR" | integrator | `integrator.md` | general-purpose |
| "Merge" or "Integrate" | integrator | `integrator.md` | general-purpose |
```

And update the spawn call example (line 193):

```markdown
Task(subagent_type="general-purpose", team_name=TEAM_NAME, name="[role]",
     prompt=[resolved template content],
     description="[Role] GH-NNN")
```

## Files Affected

| File | Change | Lines |
|------|--------|-------|
| [`plugin/ralph-hero/skills/ralph-team/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md) | Update spawn table Agent type column + spawn call example | 170-177, 193 |

## Sibling Issues (Out of Scope)

| Issue | Scope | Depends on #134? |
|-------|-------|-------------------|
| #135 | Update spawn templates to be self-contained (remove "agent definition" references) | Yes |
| #136 | Update conventions.md handoff protocol (agentType -> name for peer discovery) | Yes |
| #137 | Remove Section 9 custom agent tool restriction docs | Yes |

## References

- [Parent issue #133](https://github.com/cdubiel08/ralph-hero/issues/133) -- ralph-team should dispatch via general-purpose subagents
- [GH-132 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0132-agent-skill-patterns-bowser-reference.md) -- Bowser reference architecture validation
- [ralph-hero/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-hero/SKILL.md) -- Reference pattern (already uses general-purpose)
- [ralph-team/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md) -- Target file for this change
