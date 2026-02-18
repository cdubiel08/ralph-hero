---
date: 2026-02-17
github_issue: 51
github_url: https://github.com/cdubiel08/ralph-hero/issues/51
status: complete
type: research
---

# Clean Up Legacy Agent Definitions and Old Spawn Templates - Research Findings

## Problem Statement

Issue #51 requires removing the 5 old agent definition files and 6 old spawn template files that are superseded by the 4 new worker agents (Analyst, Builder, Validator, Integrator). All remaining references to the old agent names must also be updated.

## Files to Remove

### Old Agent Definitions (5 files)

| File | Replaced By | Status |
|------|------------|--------|
| `plugin/ralph-hero/agents/ralph-triager.md` | `ralph-analyst.md` (#45) | Remove |
| `plugin/ralph-hero/agents/ralph-researcher.md` | `ralph-analyst.md` (#45) | Remove |
| `plugin/ralph-hero/agents/ralph-planner.md` | `ralph-builder.md` (#46) | Remove |
| `plugin/ralph-hero/agents/ralph-advocate.md` | `ralph-validator.md` (#47) | Remove |
| `plugin/ralph-hero/agents/ralph-implementer.md` | `ralph-builder.md` (#46) | Remove |

### Old Spawn Templates (6 files)

| File | Replaced By | Status |
|------|------------|--------|
| `plugin/ralph-hero/templates/spawn/triager.md` | `analyst.md` (#49) | Remove |
| `plugin/ralph-hero/templates/spawn/splitter.md` | `analyst.md` (#49) | Remove |
| `plugin/ralph-hero/templates/spawn/researcher.md` | `analyst.md` (#49) | Remove |
| `plugin/ralph-hero/templates/spawn/planner.md` | `builder.md` (#49) | Remove |
| `plugin/ralph-hero/templates/spawn/reviewer.md` | `validator.md` (#49) | Remove |
| `plugin/ralph-hero/templates/spawn/implementer.md` | `builder.md` (#49) | Remove |

**Total**: 11 files to delete.

## References to Update

### Active Code Files (must update)

These files contain references to old agent names in functional code/docs that will be read by agents or users:

**1. `plugin/ralph-hero/skills/shared/conventions.md`** (3 reference areas)

Lines with old agent names in Pipeline Handoff Protocol:
```
| `ralph-researcher` | Planner | `ralph-planner` |
| `ralph-planner` | Reviewer | `ralph-advocate` |
| `ralph-advocate` | Implementer | `ralph-implementer` |
| `ralph-implementer` | Lead (PR creation) | `team-lead` |
```
AND in Spawn Template Protocol template naming table:
```
| `ralph-triager` agent (triage mode) | `triager.md` |
| `ralph-triager` agent (split mode) | `splitter.md` |
| `ralph-researcher` agent | `researcher.md` |
| `ralph-planner` agent | `planner.md` |
| `ralph-advocate` agent | `reviewer.md` |
| `ralph-implementer` agent | `implementer.md` |
```

**Update to**:
```
| `ralph-analyst` | Builder | `ralph-builder` |
| `ralph-builder` | Integrator | `ralph-integrator` |
| `ralph-validator` | Builder (rejection) | `ralph-builder` |
| `ralph-integrator` | (terminal) | `team-lead` |
```
AND:
```
| `ralph-analyst` agent | `analyst.md` |
| `ralph-builder` agent | `builder.md` |
| `ralph-validator` agent | `validator.md` |
| `ralph-integrator` agent | `integrator.md` |
```

**Note**: conventions.md is also in scope for #49. Coordinate: either #49 or #51 updates it, not both. Recommend #49 updates the Pipeline Handoff and Spawn Template tables, and #51 only handles any remaining stale references after #49 is done.

**2. `plugin/ralph-hero/skills/ralph-team/SKILL.md`** (multiple sections)

Section 6 spawn table references old agent types:
```
| "Triage" | triager | `triager.md` | ralph-triager |
| "Split" | splitter | `splitter.md` | ralph-triager |
| "Research" | researcher | `researcher.md` | ralph-researcher |
| "Plan" (not "Review") | planner | `planner.md` | ralph-planner |
| "Review" | reviewer | `reviewer.md` | ralph-advocate |
| "Implement" | implementer | `implementer.md` | ralph-implementer |
```

**Note**: ralph-team SKILL.md is in scope for #49. #51 should only clean up any stale references AFTER #49's updates.

**3. `plugin/ralph-hero/README.md`** (structure diagram)

Lines 191-195 list old agent files in the directory structure:
```
├── ralph-triager.md
├── ralph-researcher.md
├── ralph-planner.md
├── ralph-advocate.md
└── ralph-implementer.md
```

**Update to**:
```
├── ralph-analyst.md
├── ralph-builder.md
├── ralph-validator.md
└── ralph-integrator.md
```

**4. Workspace CLAUDE.md** (`/home/chad_a_dubiel/projects/CLAUDE.md`)

Line 36: `/ralph_team` description mentions "triager, researcher, planner, reviewer, implementer"
Lines 127-131: Supporting Agents table lists old agent names

**Update to**: New worker names (analyst, builder, validator, integrator)

### Historical/Reference Files (leave as-is)

These files contain old agent names in historical context (research docs, plan docs, critique docs). They should NOT be updated because:
- They document the state of the system at the time they were written
- They are reference material, not active code
- Changing them would falsify the historical record

| File | Type | Action |
|------|------|--------|
| `thoughts/shared/research/2026-02-17-GH-0044-worker-scope-boundaries.md` | Research | Leave (historical) |
| `thoughts/shared/research/2026-02-17-GH-0045-analyst-worker-agent.md` | Research | Leave (historical) |
| `thoughts/shared/research/2026-02-17-GH-0046-builder-worker-agent.md` | Research | Leave (historical) |
| `thoughts/shared/research/2026-02-17-GH-0047-validator-worker-agent.md` | Research | Leave (historical) |
| `thoughts/shared/plans/2026-02-17-plan-2-hop-architecture.md` | Plan | Leave (historical) |
| `thoughts/shared/plans/2026-02-17-plan-3-skill-autonomy-self-validation.md` | Plan | Leave (historical) |
| `thoughts/shared/plans/2026-02-14-ralph-team-throughput-optimization.md` | Plan | Leave (historical) |
| `thoughts/shared/plans/2026-02-16-peer-to-peer-pipeline-handoffs.md` | Plan | Leave (historical) |
| `thoughts/shared/plans/2026-02-13-skill-qualification-and-alignment.md` | Plan | Leave (historical) |
| Various critique/review docs | Review | Leave (historical) |

### Config/JSON Files (no references found)

- `.claude-plugin/plugin.json` -- no old agent names
- `.mcp.json` -- no old agent names
- `ralph-state-machine.json` -- references commands (`ralph_triage`, etc.), not agent types
- `ralph-command-contracts.json` -- references commands, not agents

### Hook Scripts (no changes needed)

Hook scripts reference `RALPH_COMMAND` values (`triage`, `research`, `plan`, `impl`, `review`), not agent type names. These command names stay the same (skills are not changing). No hook updates needed.

## Dependency Order

This cleanup issue (#51) MUST execute AFTER:
1. **#45-#48**: New worker agent definitions created (so replacements exist before deletion)
2. **#49**: ralph-team SKILL.md and conventions.md updated (so references are fixed before cleanup scans)
3. **#50**: ralph-hero SKILL.md updated (so orchestrator references are fixed)

Without this ordering, the cleanup would either:
- Delete agents before replacements exist (broken system)
- Find stale references that #49/#50 haven't updated yet (false positives)

## Verification Strategy

After cleanup, run this verification:

```bash
# Verify old agent files are gone
for f in ralph-triager ralph-researcher ralph-planner ralph-advocate ralph-implementer; do
  test ! -f "plugin/ralph-hero/agents/$f.md" || echo "FAIL: $f.md still exists"
done

# Verify old spawn templates are gone
for f in triager splitter researcher planner reviewer implementer; do
  test ! -f "plugin/ralph-hero/templates/spawn/$f.md" || echo "FAIL: $f.md still exists"
done

# Verify new worker files exist
for f in ralph-analyst ralph-builder ralph-validator ralph-integrator; do
  test -f "plugin/ralph-hero/agents/$f.md" || echo "FAIL: $f.md missing"
done

# Verify new spawn templates exist
for f in analyst builder validator integrator; do
  test -f "plugin/ralph-hero/templates/spawn/$f.md" || echo "FAIL: $f.md missing"
done

# Scan for remaining references in active files (excluding thoughts/)
grep -r "ralph-triager\|ralph-researcher\|ralph-planner\|ralph-advocate\|ralph-implementer" \
  plugin/ CLAUDE.md --include="*.md" --include="*.sh" --include="*.json" \
  | grep -v "thoughts/" || echo "PASS: No stale references"
```

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Deleting agents before replacements exist | High | Enforce dependency order: #45-#48 complete before #51 |
| Breaking plugin load | Low | Agent definitions are loaded by name; new names will be in place |
| Missing a reference | Low | Grep verification catches stragglers |
| Historical docs become confusing | Low | Leave historical docs untouched; they reference the system at time of writing |

## Recommended Implementation Approach

1. **Verify prerequisites**: Confirm new agent files (#45-#48) and updated orchestrators (#49-#50) exist
2. **Delete 5 old agent files**: `git rm plugin/ralph-hero/agents/ralph-{triager,researcher,planner,advocate,implementer}.md`
3. **Delete 6 old spawn templates**: `git rm plugin/ralph-hero/templates/spawn/{triager,splitter,researcher,planner,reviewer,implementer}.md`
4. **Update README.md**: Fix directory structure diagram
5. **Update workspace CLAUDE.md**: Fix agent table and ralph_team description
6. **Scan for stragglers**: Run verification grep, fix any remaining references in `plugin/` and root-level docs
7. **Run verification script**: Confirm all old files gone, new files present, no stale references
8. **Single commit**: `refactor: remove legacy agent definitions and spawn templates`

## Summary

This is a straightforward cleanup task: 11 file deletions + 4 file updates (README.md, conventions.md, ralph-team SKILL.md, workspace CLAUDE.md). The key constraint is dependency ordering -- #51 must execute last after all other epic #40 issues are complete.

## References

- Parent epic: #40
- Foundation research: `thoughts/shared/research/2026-02-17-GH-0044-worker-scope-boundaries.md`
- Old agents: `plugin/ralph-hero/agents/ralph-{triager,researcher,planner,advocate,implementer}.md`
- Old templates: `plugin/ralph-hero/templates/spawn/{triager,splitter,researcher,planner,reviewer,implementer}.md`
- README: `plugin/ralph-hero/README.md`
- Conventions: `plugin/ralph-hero/skills/shared/conventions.md`
- Workspace CLAUDE.md: `/home/chad_a_dubiel/projects/CLAUDE.md`
