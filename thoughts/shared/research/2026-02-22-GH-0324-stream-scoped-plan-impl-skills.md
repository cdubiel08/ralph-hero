---
date: 2026-02-22
github_issue: 324
github_url: https://github.com/cdubiel08/ralph-hero/issues/324
status: complete
type: research
---

# Stream-Scoped Plan & Impl Skills — Research Findings

## Problem Statement

Phase 3 of Epic #321 (Work Stream Parallelization). Plan and impl skills currently operate on the
"entire group" (all issues sharing a parent or blocking relationship). After Phase 2 introduces
`detect_work_streams`, the orchestrator will pass only a stream's subset of issues to these skills.
The skills must support stream-scoped planning/implementation while leaving single-issue and
small-group flows unchanged.

## Current State Analysis

### ralph-plan/SKILL.md

**Filename convention** (`plugin/ralph-hero/skills/ralph-plan/SKILL.md:149`):
```
thoughts/shared/plans/YYYY-MM-DD-group-GH-NNN-description.md
```
For single issues: `YYYY-MM-DD-GH-NNN-description.md`. No stream variant exists.

**Frontmatter** (`SKILL.md:154-163`):
```yaml
date: YYYY-MM-DD
status: draft
github_issues: [123, 124, 125]
github_urls:
  - https://github.com/...
primary_issue: 123
```
No `stream_id`, `stream_issues`, or `epic_issue` fields.

**Scope logic** (`SKILL.md:69-115`): The plan skill already accepts any set of issues (1a: explicit
number, 1b: auto-pick from "Ready for Plan"). When an orchestrator provides only stream-member issue
numbers, the skill already behaves correctly — it plans whatever it receives. **No structural
change needed**.

### ralph-impl/SKILL.md

**Worktree ID table** (`plugin/ralph-hero/skills/ralph-impl/SKILL.md:163-167`):
```
| Condition          | WORKTREE_ID                       |
|--------------------|-----------------------------------|
| Epic member        | GH-[EPIC_NUMBER] (e.g., "GH-42") |
| Group plan (not epic) | GH-[primary_issue]             |
| Single issue       | GH-[issue-number]                 |
```
No stream-scoped row. Currently all epic-member issues share one worktree (`GH-[EPIC]`), which
means different streams would conflict in the same worktree.

**PR template** (`SKILL.md:255-279`): PR title is `[Title]` only. No stream context. PR body has
an `## Epic` section (for epic members) but no mention of parallel streams.

### shared/conventions.md

**Standard input metadata** (`skills/shared/conventions.md:27`):
```
`issue_number`, `issue_url`, `command`, `phase`, `estimate`, `group_primary`, `group_members`, `artifact_path`, `worktree`
```
No stream fields.

**Group Context Resolution** (`conventions.md:125-126`):
```
If IS_GROUP=true: {GROUP_CONTEXT} = "Group: GH-{PRIMARY} (GH-{A}, GH-{B}, GH-{C}). Plan covers all group issues."
If IS_GROUP=false: {GROUP_CONTEXT} = ""
```
No `{STREAM_CONTEXT}` placeholder.

**No Work Streams section** exists in conventions.md.

## Key Discoveries

1. **Plan skill is already stream-compatible**. The skill plans whatever issues it receives. The
   orchestrator controls scope by only passing stream-member issues. Only the filename convention and
   frontmatter metadata need updating.

2. **Impl worktree naming is the critical gap**. Currently all epic members share `GH-[EPIC]`
   worktree. With streams, two parallel streams would write to the same worktree and conflict.
   Stream-scoped naming (`GH-[EPIC]-stream-[SORTED-ISSUES]`) is required for isolation.

3. **PR title and body need stream context** for reviewer orientation — they need to know this PR
   is one of N parallel streams from an epic, not the complete epic implementation.

4. **Stream metadata fields are additive**. They're only populated when the orchestrator is in
   stream mode. Single-issue and small-group flows remain unchanged (stream fields absent =
   existing behavior).

5. **Convention inheritance**: The "Work Streams" additions to `conventions.md` are the canonical
   reference for all three skills. Keeping definitions there (not duplicated in each SKILL.md)
   follows the existing conventions pattern.

6. **Filename disambiguation**: The existing patterns are:
   - Single: `YYYY-MM-DD-GH-NNNN-description.md`
   - Group: `YYYY-MM-DD-group-GH-NNNN-description.md`
   - Stream (new): `YYYY-MM-DD-stream-GH-NNN-NNN-description.md` — uses sorted issue numbers (not
     zero-padded, multiple numbers) to distinguish from group plans.

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/ralph-plan/SKILL.md` - Filename convention + frontmatter fields
- `plugin/ralph-hero/skills/ralph-impl/SKILL.md` - Worktree naming table + PR template
- `plugin/ralph-hero/skills/shared/conventions.md` - Work Streams section, stream context resolution, stream metadata fields

### Will Read (Dependencies)
- `plugin/ralph-hero/skills/ralph-team/SKILL.md` - Orchestrator that produces stream metadata (context only)
- `thoughts/shared/plans/2026-02-21-work-stream-parallelization.md` - Parent plan (Phase 3 spec)

## Potential Approaches

### Option A: Inline stream metadata in each SKILL.md (not recommended)
Add stream field documentation inline in plan/impl SKILL.md files. Each skill documents its own
stream conventions.

**Pros**: Self-contained per skill.
**Cons**: Duplication across 3 files. Conventions.md is already the single source for
cross-skill metadata — violates existing pattern.

### Option B: Canonical definitions in conventions.md, referenced by skills (recommended)
Add "Work Streams" section to conventions.md as the single source of truth. Plan and impl SKILL.md
reference it (as they already reference conventions.md for escalation, link formatting, etc.).

**Pros**: Follows existing pattern. Easier to maintain. Orchestrator (ralph-team) can also
reference the same section.
**Cons**: Skills must instruct the reader to check conventions.md — minor friction.

## Recommended Implementation

**Phase 3 changes are documentation-only** (markdown edits to SKILL.md files and conventions.md).
No TypeScript changes. The plan and impl skills already handle multi-issue groups — stream support
is achieved by:

1. **`shared/conventions.md`**: Add "Work Streams" section defining:
   - Stream ID format: `stream-[sorted-issue-numbers]` (e.g., `stream-42-44`)
   - Stream plan filename: `YYYY-MM-DD-stream-GH-NNN-NNN-description.md`
   - Stream worktree naming: `GH-[EPIC]-stream-[SORTED-ISSUES]`
   - Stream PR title format
   - `{STREAM_CONTEXT}` placeholder for spawn templates
   - Extend "Standard input metadata" with: `stream_id`, `stream_primary`, `stream_members`, `epic_issue`

2. **`ralph-plan/SKILL.md`**: Two targeted edits:
   - Step 4 filename line: add stream variant alongside group/single
   - Frontmatter template: add `stream_id`, `stream_issues`, `epic_issue` (conditional on stream context)

3. **`ralph-impl/SKILL.md`**: Two targeted edits:
   - Step 5.2 table: add stream row above epic member row (more specific match first)
   - Step 9.3 PR template: add stream context to title and body

**Order**: Update conventions.md first (canonical source), then reference from SKILL.md files.

## Risks

- **Filename pattern collision**: `stream-GH-42-44` vs `group-GH-42` — no collision risk since they
  use different prefixes and the stream variant includes multiple numbers.
- **Glob fallback in impl**: Step 2.5 tries `*GH-${number}*`. Stream plans named
  `*stream-GH-42-44*` will match for issue 42 and 44, so discovery works correctly.
- **Group glob fallback** (`*group*GH-{primary}*`) won't match stream plans (uses `stream-` not
  `group-`). A new stream glob fallback is needed: `*stream*GH-{number}*`. Add this to impl Step 2
  fallback logic.
- **Backward compatibility**: Stream fields optional — no risk to existing flows.

## Recommended Next Steps

1. Edit `shared/conventions.md` — add Work Streams section, stream context resolution, stream
   metadata fields (5-10 min)
2. Edit `ralph-plan/SKILL.md` — filename convention + conditional frontmatter (2-3 min)
3. Edit `ralph-impl/SKILL.md` — worktree table + PR template + stream glob fallback (5 min)
4. No build step needed (markdown only)
5. Verify: `npm run build` still passes (no TypeScript touched)
