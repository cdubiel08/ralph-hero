---
date: 2026-02-27
status: draft
github_issues: [456]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/456
primary_issue: 456
---

# Update Skills, Agents, and Justfile — Atomic Implementation Plan

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-456 | Update skills, agents, and justfile to use consolidated tools | S |

## Current State Analysis

After Phases 1-4 (GH-452, GH-453, GH-454, GH-455), the MCP server has consolidated tools but all consumers (skills, agents, justfile) still reference the old tool names. The grep across all files finds 70+ stale references across 15 skill files, 1 shared conventions file, 2 agent files, and the justfile.

### Stale Reference Inventory

**By old tool name (reference count):**

| Old Tool | Count | Files affected |
|----------|-------|---------------|
| `update_workflow_state` | ~33 | 13 skills + 2 agents + justfile + shared/conventions.md |
| `update_issue` | ~10 | 4 skills + 2 agents + justfile |
| `update_estimate` | ~10 | 4 skills + 1 agent |
| `advance_children` | 5 | ralph-pr, ralph-merge + 1 agent |
| `advance_parent` | 3 | ralph-merge + 1 agent |
| `detect_pipeline_position` | 4 | ralph-hero, justfile |
| `list_dependencies` | 2 | 1 agent, justfile |
| `detect_work_streams` | 1 | ralph-hero |
| `archive_item` | 1 | ralph-hygiene |
| `update_priority` | 1 | 1 agent (tools list) |
| `detect_group` | 1 | 1 agent (tools list) |
| `update_field_options` | 1 | ralph-setup |
| `configure_routing` | 1 | ralph-setup |

**Files with NO stale references** (no changes needed):
- draft-idea, idea-hunt, ralph-report, ralph-status, ralph-team, ralph-val, record-demo, research-codebase

## Desired End State

- Zero references to any removed tool name in `plugin/ralph-hero/skills/`, `plugin/ralph-hero/agents/`, or `plugin/ralph-hero/justfile`
- All tool calls updated to use consolidated equivalents
- All `matcher:` frontmatter patterns updated
- All `tools:` frontmatter lists updated
- Justfile recipes functional with new tool names

### Verification
- [x] Grep for all 30+ old tool names returns empty across skills/agents/justfile
- [ ] `just info 1` works
- [ ] `just move 1 "Backlog"` works
- [ ] `just where 1` works

## What We're NOT Doing

- Updating CLAUDE.md documentation (Phase 6, GH-457)
- Any MCP server code changes (Phases 1-4 already done)
- Changing skill logic or behavior — only tool name references

## Implementation Approach

Systematic file-by-file updates in 3 groups: (A) shared conventions, (B) skill SKILL.md files, (C) agent definitions, (D) justfile. Each file gets the same mechanical replacements. Process alphabetically within each group.

---

## Phase 1: GH-456 — Update skills, agents, and justfile
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/456

### Replacement Patterns

These patterns apply universally across all files:

| Old Pattern | New Pattern |
|-------------|-------------|
| `ralph_hero__update_workflow_state(number=N, state="X", command="Y")` | `ralph_hero__save_issue(number=N, workflowState="X", command="Y")` |
| `ralph_hero__update_workflow_state(number, state="__LOCK__", command="Z")` | `ralph_hero__save_issue(number=N, workflowState="__LOCK__", command="Z")` |
| `ralph_hero__update_workflow_state(number, state="__COMPLETE__", command="Z")` | `ralph_hero__save_issue(number=N, workflowState="__COMPLETE__", command="Z")` |
| `ralph_hero__update_workflow_state(number, state="__ESCALATE__", command="Z")` | `ralph_hero__save_issue(number=N, workflowState="__ESCALATE__", command="Z")` |
| `ralph_hero__update_issue(number=N, body="X")` | `ralph_hero__save_issue(number=N, body="X")` |
| `ralph_hero__update_issue(number=N, title="X")` | `ralph_hero__save_issue(number=N, title="X")` |
| `ralph_hero__update_estimate(number=N, estimate="X")` | `ralph_hero__save_issue(number=N, estimate="X")` |
| `ralph_hero__update_priority(number=N, priority="X")` | `ralph_hero__save_issue(number=N, priority="X")` |
| `ralph_hero__advance_children(parentNumber=N, targetState="X")` | `ralph_hero__advance_issue(direction="children", number=N, targetState="X")` |
| `ralph_hero__advance_parent(childNumber=N)` | `ralph_hero__advance_issue(direction="parent", number=N)` |
| `ralph_hero__detect_pipeline_position(owner=X, repo=Y, number=N)` | `ralph_hero__get_issue(number=N, includePipeline=true)` |
| `ralph_hero__detect_work_streams(issues=[...])` | `ralph_hero__detect_stream_positions(issues=[...])` |
| `ralph_hero__archive_item(number=N)` | `ralph_hero__bulk_archive(number=N)` |
| `ralph_hero__list_dependencies(number=N)` | `ralph_hero__get_issue(number=N)` (use blocking/blockedBy from response) |
| References to `update_workflow_state` in prose | `save_issue` |
| References to `update_issue` in prose | `save_issue` |
| Error handling mentioning `update_workflow_state` | Update to mention `save_issue` |

**For `ralph-setup` skill only:**
| Old Pattern | New Pattern |
|-------------|-------------|
| `ralph_hero__update_field_options(...)` | `gh api graphql` mutation call (see details below) |
| `ralph_hero__configure_routing(...)` | Direct file editing of `.ralph-routing.yml` |

### Changes Required

#### 1. Update shared conventions
**File**: `plugin/ralph-hero/skills/shared/conventions.md`
**Changes** (2 references):
- Line 71: `ralph_hero__update_workflow_state(number, state="__ESCALATE__", command="[current-command]")` → `ralph_hero__save_issue(number=N, workflowState="__ESCALATE__", command="[current-command]")`
- Line 92: Update error handling prose from `update_workflow_state` to `save_issue`

#### 2. Update ralph-triage skill
**File**: `plugin/ralph-hero/skills/ralph-triage/SKILL.md`
**Changes** (6 references):
- Line 17: `matcher:` pattern — `ralph_hero__update_workflow_state` → `ralph_hero__save_issue`
- Line 162: `ralph_hero__update_workflow_state` → `ralph_hero__save_issue(workflowState=..., command=...)`
- Line 171: Error handling prose update
- Line 208, 221: `ralph_hero__update_estimate` → `ralph_hero__save_issue(estimate=...)`
- Line 231: `ralph_hero__update_workflow_state` → `ralph_hero__save_issue(workflowState=...)`
- Line 249: `ralph_hero__update_issue` → `ralph_hero__save_issue`

#### 3. Update ralph-split skill
**File**: `plugin/ralph-hero/skills/ralph-split/SKILL.md`
**Changes** (6 references):
- Line 182: `ralph_hero__update_issue` → `ralph_hero__save_issue`
- Line 190, 222: `ralph_hero__update_estimate` → `ralph_hero__save_issue(estimate=...)`
- Line 231: `ralph_hero__update_workflow_state` → `ralph_hero__save_issue(workflowState=..., command=...)`
- Line 239: Error handling prose update
- Line 313: `ralph_hero__update_issue` → `ralph_hero__save_issue`
- Line 331: `ralph_hero__update_workflow_state` → `ralph_hero__save_issue(workflowState=...)`

#### 4. Update ralph-research skill
**File**: `plugin/ralph-hero/skills/ralph-research/SKILL.md`
**Changes** (3 references):
- Line 71: `ralph_hero__update_workflow_state` → `ralph_hero__save_issue(workflowState=..., command=...)`
- Line 79: Error handling prose update
- Line 173: `ralph_hero__update_workflow_state` → `ralph_hero__save_issue(workflowState=..., command=...)`

#### 5. Update ralph-plan skill
**File**: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`
**Changes** (4 references):
- Line 16: `matcher:` pattern → `ralph_hero__save_issue`
- Line 25: `matcher:` pattern → `ralph_hero__save_issue`
- Line 145: `ralph_hero__update_workflow_state(number, state="__LOCK__", command="ralph_plan")` → `ralph_hero__save_issue(number=N, workflowState="__LOCK__", command="ralph_plan")`
- Line 249: `ralph_hero__update_workflow_state(number, state="__COMPLETE__", command="ralph_plan")` → `ralph_hero__save_issue(number=N, workflowState="__COMPLETE__", command="ralph_plan")`

#### 6. Update ralph-impl skill
**File**: `plugin/ralph-hero/skills/ralph-impl/SKILL.md`
**Changes** (3 references):
- Line 18: `matcher:` pattern → `ralph_hero__save_issue`
- Line 146: `ralph_hero__update_workflow_state` → `ralph_hero__save_issue(workflowState=..., command=...)`
- Line 323: `ralph_hero__update_workflow_state` → `ralph_hero__save_issue(workflowState=..., command=...)`

#### 7. Update ralph-review skill
**File**: `plugin/ralph-hero/skills/ralph-review/SKILL.md`
**Changes** (5 references):
- Line 20: `matcher:` pattern → `ralph_hero__save_issue`
- Line 248: `ralph_hero__update_workflow_state` → `ralph_hero__save_issue(workflowState=..., command=...)`
- Line 256: Error handling prose update
- Line 285: `ralph_hero__update_issue` → `ralph_hero__save_issue`
- Line 296: `ralph_hero__update_workflow_state` → `ralph_hero__save_issue(workflowState=..., command=...)`

#### 8. Update ralph-pr skill
**File**: `plugin/ralph-hero/skills/ralph-pr/SKILL.md`
**Changes** (5 references):
- Line 12: `matcher:` pattern — `ralph_hero__update_workflow_state|ralph_hero__advance_children` → `ralph_hero__save_issue|ralph_hero__advance_issue`
- Line 31: `ralph_hero__advance_children` → `ralph_hero__advance_issue`
- Line 32: `ralph_hero__update_workflow_state` → `ralph_hero__save_issue`
- Line 102: `ralph_hero__advance_children(parentNumber=NNN, targetState="In Review")` → `ralph_hero__advance_issue(direction="children", number=NNN, targetState="In Review")`
- Line 108: `ralph_hero__update_workflow_state(number=NNN, state="In Review")` → `ralph_hero__save_issue(number=NNN, workflowState="In Review", command="ralph_pr")`

#### 9. Update ralph-merge skill
**File**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md`
**Changes** (7 references):
- Line 12: `matcher:` pattern — update all 3 old tool names → `ralph_hero__save_issue|ralph_hero__advance_issue`
- Line 26-28: Tool list — `advance_children`, `advance_parent`, `update_workflow_state` → `advance_issue`, `save_issue`
- Line 119: `ralph_hero__advance_children(parentNumber=NNN, targetState="Done")` → `ralph_hero__advance_issue(direction="children", number=NNN, targetState="Done")`
- Line 125: `ralph_hero__update_workflow_state(number=NNN, state="Done")` → `ralph_hero__save_issue(number=NNN, workflowState="Done", command="ralph_merge")`
- Line 133: `ralph_hero__advance_parent(childNumber=NNN)` → `ralph_hero__advance_issue(direction="parent", number=NNN)`

#### 10. Update ralph-hero skill
**File**: `plugin/ralph-hero/skills/ralph-hero/SKILL.md`
**Changes** (5 references):
- Line 87: `ralph_hero__detect_pipeline_position(...)` → `ralph_hero__get_issue(number=N, includePipeline=true)`
- Line 107: Prose reference to `detect_pipeline_position` → `get_issue(includePipeline=true)`
- Line 161: `ralph_hero__detect_work_streams(issues=[...])` → `ralph_hero__detect_stream_positions(issues=[...])`
- Line 186: Prose reference to `detect_pipeline_position` → `get_issue(includePipeline=true)`
- Line 279: Prose reference to `detect_pipeline_position` → `get_issue(includePipeline=true)`

#### 11. Update ralph-hygiene skill
**File**: `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md`
**Changes** (1 reference):
- Line 87: `ralph_hero__archive_item` → `ralph_hero__bulk_archive(number=N)`

#### 12. Update form-idea skill
**File**: `plugin/ralph-hero/skills/form-idea/SKILL.md`
**Changes** (3 references):
- Line 169: `ralph_hero__update_estimate` → `ralph_hero__save_issue(estimate=...)`
- Line 219: `ralph_hero__update_estimate(number=..., estimate="L")` → `ralph_hero__save_issue(number=..., estimate="L")`
- Line 226: `ralph_hero__update_estimate(number=..., estimate="XS")` → `ralph_hero__save_issue(number=..., estimate="XS")`

#### 13. Update iterate-plan skill
**File**: `plugin/ralph-hero/skills/iterate-plan/SKILL.md`
**Changes** (2 references):
- Line 63: `ralph_hero__update_workflow_state` → `ralph_hero__save_issue(workflowState=..., command=...)`
- Line 247: `ralph_hero__update_workflow_state` → `ralph_hero__save_issue(workflowState=..., command=...)`

#### 14. Update implement-plan skill
**File**: `plugin/ralph-hero/skills/implement-plan/SKILL.md`
**Changes** (2 references):
- Line 95: `ralph_hero__update_workflow_state(number=NNN, state="In Progress", command="implement_plan")` → `ralph_hero__save_issue(number=NNN, workflowState="In Progress", command="implement_plan")`
- Line 191: `ralph_hero__update_workflow_state(number=NNN, state="In Review", command="implement_plan")` → `ralph_hero__save_issue(number=NNN, workflowState="In Review", command="implement_plan")`

#### 15. Update create-plan skill
**File**: `plugin/ralph-hero/skills/create-plan/SKILL.md`
**Changes** (2 references):
- Line 347: `ralph_hero__update_workflow_state(number=NNN, state="Plan in Review", command="create_plan")` → `ralph_hero__save_issue(number=NNN, workflowState="Plan in Review", command="create_plan")`
- Line 351: `ralph_hero__update_estimate(number=..., estimate="XS|S|M|L|XL")` → `ralph_hero__save_issue(number=..., estimate="XS|S|M|L|XL")`

#### 16. Update ralph-setup skill (special handling)
**File**: `plugin/ralph-hero/skills/ralph-setup/SKILL.md`
**Changes** (2 references requiring `gh` CLI replacements):

a. **`update_field_options`** (line ~197):
Replace:
```
Use `ralph_hero__update_field_options` to apply color coding...
```
With:
```
Use `gh api graphql` to update field option colors and descriptions. Example:
gh api graphql -f query='mutation { updateProjectV2FieldOptionValue(input: { projectId: "PVT_xxx", fieldId: "PVTSSF_xxx", optionId: "xxx", color: "GREEN", description: "..." }) { projectV2FieldOption { id name } } }'
Or use the GitHub Projects UI to adjust field option colors after creation.
```

b. **`configure_routing`** (line ~436):
Replace:
```
Call `ralph_hero__configure_routing(operation: "add_rule", ...)`
```
With:
```
Create or edit `.ralph-routing.yml` directly. Example minimal stub:
```yaml
rules:
  - match:
      labels: ["enhancement"]
    action:
      workflowState: "Backlog"
      projectNumber: [project-number]
```
Use a text editor or Write tool to create this file.
```

#### 17. Update ralph-analyst agent
**File**: `plugin/ralph-hero/agents/ralph-analyst.md`
**Changes** (2 lines):
- Line 4 `tools:` list — Remove: `ralph_hero__update_issue`, `ralph_hero__update_workflow_state`, `ralph_hero__update_estimate`, `ralph_hero__update_priority`, `ralph_hero__list_dependencies`, `ralph_hero__detect_group`. Add: `ralph_hero__save_issue`
- Line 9 `matcher:` — Remove old tool names, add `ralph_hero__save_issue`

#### 18. Update ralph-integrator agent
**File**: `plugin/ralph-hero/agents/ralph-integrator.md`
**Changes** (2 lines):
- Line 4 `tools:` list — Remove: `ralph_hero__update_issue`, `ralph_hero__update_workflow_state`, `ralph_hero__advance_children`, `ralph_hero__advance_parent`. Add: `ralph_hero__save_issue`, `ralph_hero__advance_issue`
- Line 9 `matcher:` — Remove old tool names, add `ralph_hero__save_issue|ralph_hero__advance_issue`

#### 19. Update justfile
**File**: `plugin/ralph-hero/justfile`
**Changes** (7 references):

- Line 272: `ralph_hero__update_workflow_state` → `ralph_hero__save_issue` in the `approve` recipe prompt
- Line 276: `run_quick "ralph_hero__update_workflow_state"` → `run_quick "ralph_hero__save_issue"`
- Line 319: `run_quick "ralph_hero__update_workflow_state"` → `run_quick "ralph_hero__save_issue"` in `move` recipe
- Line 354: `run_quick "ralph_hero__list_dependencies"` → `run_quick "ralph_hero__get_issue"` in `deps` recipe
- Line 369: `run_quick "ralph_hero__detect_pipeline_position"` → `run_quick "ralph_hero__get_issue"` in `where` recipe (add `includePipeline: true` to the prompt/args)
- Line 388: `run_quick "ralph_hero__update_issue"` → `run_quick "ralph_hero__save_issue"` in `assign` recipe
- Line 625: `ralph_hero__update_workflow_state` → `ralph_hero__save_issue`
- Line 637: `ralph_hero__update_issue` → `ralph_hero__save_issue`

### Success Criteria

#### Automated Verification:
- [x] `grep -rE "update_workflow_state|update_issue|update_estimate|update_priority|clear_field|detect_group|check_convergence|detect_pipeline_position|list_project_items|detect_work_streams|archive_item|advance_children|advance_parent|list_dependencies|list_projects|copy_project|update_project|list_views|list_project_repos|remove_from_project|reorder_item|link_team|delete_field|update_collaborators|add_to_project|link_repository|update_status_update|delete_status_update|sync_across_projects|configure_routing|update_field_options" plugin/ralph-hero/skills/ plugin/ralph-hero/agents/ plugin/ralph-hero/justfile` returns empty
- [x] No broken YAML frontmatter in any SKILL.md (check `matcher:` and `tools:` fields parse correctly)

#### Manual Verification:
- [ ] `just info 1` works (get_issue — unchanged)
- [ ] `just move 1 "Backlog"` works (now uses save_issue)
- [ ] `just where 1` works (now uses get_issue with includePipeline)
- [ ] `just deps 1` works (now uses get_issue)

**Implementation Note**: After automated grep verification, run the 4 justfile recipes as a quick manual smoke test.

---

## Key Implementation Notes

1. **Mechanical but high volume**: 19 files to edit, ~70 individual replacements. Work systematically file-by-file to avoid missing references.

2. **`matcher:` frontmatter is critical**: Skills use `matcher:` patterns to auto-trigger on tool calls. If these aren't updated, skills won't fire when the new tools are called. Always update `matcher:` alongside the tool call references in the body.

3. **`tools:` frontmatter in agents**: The `tools:` line in agent definitions controls which MCP tools the agent can access. Removing old tool names without adding new ones would break the agent.

4. **Justfile uses `run_quick` helper**: The justfile recipes pass tool names to a `run_quick` shell function that constructs MCP tool calls. Only the tool name string needs changing — the recipe logic stays the same.

5. **`ralph-setup` is the only non-mechanical update**: It requires replacing MCP tool calls with `gh api graphql` mutations and direct file editing instructions. The other 18 files are pure find-and-replace.

6. **Verify grep is truly empty**: The acceptance criterion grep pattern covers ALL 30+ old tool names. A single missed reference means the grep will catch it. Run the grep as the final verification step.

7. **Parameter name changes**: `update_workflow_state` uses `state=` while `save_issue` uses `workflowState=`. `advance_children` uses `parentNumber=` while `advance_issue` uses `number=`. These are not just tool name renames — parameter names change too.

## References

- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/451
- Parent plan: `thoughts/shared/plans/2026-02-27-mcp-toolspace-consolidation.md` Phase 5
- Phase 1 plan (save_issue): `thoughts/shared/plans/2026-02-27-GH-0452-build-save-issue-tool.md`
- Phase 3 plan (read tools): `thoughts/shared/plans/2026-02-27-GH-0454-collapse-read-tools-merge-archive.md`
- Phase 4 plan (admin tools): `thoughts/shared/plans/2026-02-27-GH-0455-remove-admin-tools-merge-advance.md`
