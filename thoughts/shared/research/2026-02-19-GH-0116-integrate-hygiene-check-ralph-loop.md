---
date: 2026-02-19
github_issue: 116
github_url: https://github.com/cdubiel08/ralph-hero/issues/116
status: complete
type: research
---

# GH-116: Integrate Hygiene Check into ralph-loop.sh Triage Phase

## Problem Statement

The `ralph-loop.sh` script runs the autonomous workflow loop (triage -> split -> research -> plan -> review -> implement) but has no hygiene step. Over time, project boards accumulate stale Done/Canceled items, missing-field items, and orphaned backlog entries. Issue #116 requests adding a hygiene check into the loop, ideally running after triage and before research, with configurable skip and standalone options.

## Current State Analysis

### ralph-loop.sh Structure (plugin/ralph-hero/scripts/ralph-loop.sh)

The loop script currently has this phase structure:

1. **Analyst Phase**: Triage -> Split (optional) -> Research
2. **Builder Phase**: Plan -> Review (optional) -> Implement
3. **Integrator Phase**: (placeholder, not yet implemented)

Each phase calls `run_claude()` which invokes `claude -p "/ralph-[skill]" --dangerously-skip-permissions` with a configurable timeout.

Key existing patterns:
- Mode flags: `--triage-only`, `--split-only`, `--research-only`, etc.
- Role aggregation flags: `--analyst-only`, `--builder-only`, `--validator-only`, `--integrator-only`
- Configurable behavior: `--split=auto|skip`, `--review=auto|skip|interactive`
- Environment variable defaults: `RALPH_SPLIT_MODE`, `RALPH_REVIEW_MODE`
- Iteration loop with `MAX_ITERATIONS` and `TIMEOUT` per task

### Existing MCP Tools

The following tools already exist or are planned:

| Tool | Status | File |
|------|--------|------|
| `ralph_hero__archive_item` | Implemented | `mcp-server/src/tools/project-management-tools.ts` |
| `ralph_hero__pipeline_dashboard` | Implemented | `mcp-server/src/tools/dashboard-tools.ts` |
| `ralph_hero__bulk_archive` | Planned (#153) | Not yet created |
| `ralph_hero__project_hygiene` | Planned (#158) | Not yet created |

The `archive_item` tool handles individual issue archiving. The `pipeline_dashboard` tool fetches all project items and generates health reports including stuck issues, WIP violations, and phase distribution.

### Sibling Issues in Epic #96

| Issue | Title | State | Dependency |
|-------|-------|-------|------------|
| #113 | Add `bulk_archive` MCP tool | Backlog (split) | Foundation - creates the batch archive capability |
| #114 | Add `project_hygiene` reporting tool | Backlog (split) | Foundation - creates the hygiene report |
| #115 | Add archive stats to `pipeline_dashboard` | Backlog | Depends on #113 for archive tracking |
| #116 | Integrate hygiene check into ralph-loop.sh | Backlog (this issue) | Depends on #153/#158 for MCP tools |
| #153 | Create core `bulk_archive` MCP tool | Open | Sub-issue of #113 |
| #158 | Create core `project_hygiene` reporting tool | Open | Sub-issue of #114 |

### Existing Skill Patterns

The triage skill (`skills/ralph-triage/SKILL.md`) provides a good template:
- Hooks-based validation (branch-gate, state-gate, postcondition)
- Environment variables (`RALPH_COMMAND`, `RALPH_REQUIRED_BRANCH`)
- Structured MCP tool invocation
- Clear step-by-step workflow

## Key Discoveries

### 1. Integration Point is Well-Defined

The natural insertion point in `ralph-loop.sh` is between triage and research (lines 92-106). The script already has a pattern for optional phases via mode flags (`--split=skip` pattern). A `--hygiene=auto|skip` flag fits naturally.

```
Triage -> [Hygiene] -> Split -> Research -> Plan -> Review -> Implement
```

Alternatively, hygiene could run *before* triage since it cleans up the board before the triage agent scans it. Running before triage reduces noise during triage scanning. The issue text says "After triage, before research" but "Before triage" is more logical since hygiene cleans up stale items that triage would otherwise need to skip.

### 2. Two Implementation Approaches

**Approach A: New Skill (`/ralph-hygiene`)**
- Create a dedicated skill file `skills/ralph-hygiene/SKILL.md`
- Skill calls `ralph_hero__project_hygiene` to generate report
- Skill calls `ralph_hero__bulk_archive` if threshold exceeded
- Skill logs report output
- Loop script calls `run_claude "/ralph-hygiene"` like other phases

Pros: Consistent with existing architecture, hooks support, full skill isolation.
Cons: Overhead of a full Claude session for what could be a simpler operation.

**Approach B: Direct Script Phase**
- Add a bash function `run_hygiene()` in `ralph-loop.sh`
- Calls MCP tools directly via `claude -p` with a minimal prompt
- Simpler, faster, lower token cost

Pros: Lighter weight, faster execution.
Cons: Breaks the pattern of skill-per-phase, harder to test, less flexible.

**Recommendation**: Approach A (new skill). The skill pattern is well-established, provides hook support for validation, and keeps the loop script clean. The MCP tool calls (`project_hygiene` + `bulk_archive`) are the heavy lifting; the skill just orchestrates them.

### 3. Dependencies Are Critical

This issue CANNOT be implemented until:
- **#153** (`bulk_archive` core MCP tool) is implemented - needed for auto-archive
- **#158** (`project_hygiene` core reporting tool) is implemented - needed for report generation

Without these MCP tools, the hygiene skill has nothing to call. The skill itself is a thin orchestration layer.

### 4. Configuration Design

Based on the existing patterns in `ralph-loop.sh`:

**New CLI flags:**
- `--hygiene=auto|skip` (default: `auto`)
- `--hygiene-only` (standalone mode)

**New environment variables:**
- `RALPH_HYGIENE_MODE` (default: `auto`)
- `RALPH_HYGIENE_THRESHOLD` (archive threshold, default: configurable in skill)
- `RALPH_HYGIENE_DRY_RUN` (report only, no archiving)

**Standalone invocation:**
```bash
./scripts/ralph-loop.sh --hygiene-only
```

### 5. Skill Workflow Design

The hygiene skill should:

1. Call `ralph_hero__project_hygiene` to generate the report
2. Log the report to stdout (always)
3. Check archive candidates count against threshold
4. If above threshold AND not dry-run: call `ralph_hero__bulk_archive`
5. Report summary: items archived, warnings, recommendations

### 6. Report Logging

The issue requests logging to stdout/file. The existing `run_claude()` function in `ralph-loop.sh` already captures all stdout. For file-based logging:
- Write hygiene report to `thoughts/shared/hygiene/YYYY-MM-DD-hygiene-report.md` (optional)
- Or simply rely on the terminal output captured by `run_claude()`

The simpler approach (stdout only) is recommended for v1. File logging can be added later.

## Potential Approaches

### Recommended: Skill-Based Integration

**Files to create/modify:**

1. **New file**: `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md`
   - Skill definition with hooks
   - Calls `project_hygiene` and optionally `bulk_archive`
   - Configurable thresholds via env vars

2. **Modified file**: `plugin/ralph-hero/scripts/ralph-loop.sh`
   - Add `--hygiene=auto|skip` flag parsing
   - Add `--hygiene-only` mode
   - Add hygiene phase between triage and split (or before triage)
   - Add `RALPH_HYGIENE_MODE` env var support

3. **New file**: `plugin/ralph-hero/hooks/scripts/hygiene-postcondition.sh` (optional)
   - Verify hygiene report was generated
   - Lightweight validation

### Insertion Position Options

| Position | Pros | Cons |
|----------|------|------|
| Before triage | Cleans board before scanning | May archive items triage would assess |
| After triage, before split | Issue's stated preference | Triage sees stale items first |
| After split, before research | Latest clean state | Further from triage |

**Recommendation**: Before triage. This cleans the board so triage operates on a focused set of items. Done/Canceled items older than the threshold are already resolved and should not distract the triage agent.

## Risks and Edge Cases

1. **Tool dependencies**: If #153 or #158 are not implemented, the skill will fail. The skill should gracefully handle missing tools with a "hygiene tools not available, skipping" message.

2. **Accidental archiving**: The `bulk_archive` tool should have a conservative default threshold. Items Done for less than 14 days should not be archived. The skill should support a dry-run mode.

3. **Rate limiting**: The `project_hygiene` tool fetches all project items. Combined with triage's own item fetching, this could hit API rate limits on large projects. The existing `RateLimiter` in the MCP server should handle this.

4. **Loop interaction**: If hygiene runs every iteration of the loop (up to `MAX_ITERATIONS`), it may repeatedly re-scan a clean board. Consider running hygiene only on iteration 1, or adding a "last run" check.

5. **Team loop compatibility**: The `ralph-team-loop.sh` does not use per-phase invocation; it delegates to the team orchestrator. Hygiene integration there would be different (team lead decides when to run hygiene).

## Recommended Next Steps

1. Implement #153 (`bulk_archive` core MCP tool) first
2. Implement #158 (`project_hygiene` core reporting tool) next
3. Then implement #116 (this issue) as the thin integration layer:
   - Create `skills/ralph-hygiene/SKILL.md`
   - Modify `scripts/ralph-loop.sh` to add the hygiene phase
   - Add `--hygiene=auto|skip` and `--hygiene-only` flags
4. Test: run `./scripts/ralph-loop.sh --hygiene-only` against a board with stale items
