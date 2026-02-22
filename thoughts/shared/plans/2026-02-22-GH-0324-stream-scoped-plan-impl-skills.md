---
date: 2026-02-22
status: draft
github_issues: [324]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/324
primary_issue: 324
---

# Stream-Scoped Plan & Impl Skills - Atomic Implementation Plan

## Overview
Single issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-324 | Adjust plan and impl skills for stream-scoped groups | S |

## Current State Analysis

Three markdown files need targeted edits to support stream-scoped groups:

1. **`shared/conventions.md`** has Group Context Resolution (`{GROUP_CONTEXT}`) but no stream equivalent. Standard input metadata lists `group_primary`, `group_members` but no stream fields. No "Work Streams" section exists.

2. **`ralph-plan/SKILL.md`** uses filename convention `YYYY-MM-DD-group-GH-NNN-description.md` for groups and `YYYY-MM-DD-GH-NNN-description.md` for singles. Frontmatter has `github_issues`, `primary_issue` but no stream metadata. The plan skill is already stream-compatible structurally -- it plans whatever issues it receives.

3. **`ralph-impl/SKILL.md`** has a worktree ID table (Step 5.2) with Epic member / Group plan / Single issue rows but no stream row. PR template (Step 9.3) has no stream context. Plan discovery glob fallback (Step 2) tries `*group*GH-{primary}*` but has no stream glob fallback.

## Desired End State
### Verification
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` succeeds (no TypeScript touched, build should pass)
- [ ] Plan skill filename convention includes stream variant: `YYYY-MM-DD-stream-GH-NNN-NNN-description.md`
- [ ] Plan skill frontmatter template includes conditional `stream_id`, `stream_issues`, `epic_issue` fields
- [ ] Impl skill worktree table includes stream row: `GH-[EPIC]-stream-[SORTED-ISSUES]`
- [ ] Impl skill PR template includes stream context in title and body
- [ ] Impl skill plan discovery includes stream glob fallback
- [ ] Conventions.md has "Work Streams" section with naming conventions
- [ ] Conventions.md has `{STREAM_CONTEXT}` in Group Context Resolution
- [ ] Conventions.md standard input metadata includes `stream_id`, `stream_primary`, `stream_members`, `epic_issue`
- [ ] Existing single-issue and group flows are unchanged (stream fields are additive/conditional)

## What We're NOT Doing
- No TypeScript changes (all changes are markdown documentation edits)
- Not modifying hooks or state gates
- Not changing how research works
- Not implementing the orchestrator stream model (that's GH-325/Phase 4)
- Not adding the `detect_work_streams` MCP tool (that's GH-323/Phase 2)

## Implementation Approach

Update conventions.md first (canonical source for cross-skill conventions), then reference from plan and impl SKILL.md files. This follows the existing pattern where conventions.md is the single source of truth for shared metadata, link formatting, and escalation protocols.

All changes are additive -- existing patterns for single issues and groups remain unchanged. Stream-specific content is conditional on stream context being present.

---

## Phase 1: GH-324 — Stream-Scoped Plan & Impl Skill Adjustments
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/324 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0324-stream-scoped-plan-impl-skills.md

### Changes Required

#### 1. Add "Work Streams" section to shared conventions
**File**: `plugin/ralph-hero/skills/shared/conventions.md`
**Changes**:

After the "Worktree Context Resolution" section (around line 131), add a new "## Work Streams" section:

```markdown
## Work Streams

Work streams partition a group of issues into independent subsets based on file overlap and `blockedBy` relationships. Each stream flows through plan -> implement -> PR independently.

### Stream ID Format
Deterministic, content-based: `stream-[sorted-issue-numbers]` (e.g., `stream-42-44`, `stream-43`).

### Naming Conventions

| Artifact | Single Issue | Group | Stream |
|----------|-------------|-------|--------|
| Plan filename | `YYYY-MM-DD-GH-NNNN-desc.md` | `YYYY-MM-DD-group-GH-NNNN-desc.md` | `YYYY-MM-DD-stream-GH-NNN-NNN-desc.md` |
| Worktree ID | `GH-[number]` | `GH-[primary]` | `GH-[EPIC]-stream-[SORTED-ISSUES]` |
| PR title | `[Title]` | `[Title]` | `[Title] [stream-X-Y of GH-EPIC]` |

### Stream Context Resolution

```
{STREAM_CONTEXT} = "Stream stream-42-44: GH-42, GH-44 (shared: src/auth/). Plan covers stream issues only. Epic: GH-40."
```

When `STREAM_CONTEXT` is non-empty, it replaces `GROUP_CONTEXT` (a stream IS a group subset).

### Lifecycle
- Streams are detected once (after all research completes) and are immutable for the session
- Research is per-issue (pre-stream); plans and PRs are per-stream
- Each stream tracks its own phase independently
- For epics with <=2 children, stream detection is skipped (single group, same as current behavior)
```

#### 2. Extend standard input metadata with stream fields
**File**: `plugin/ralph-hero/skills/shared/conventions.md`
**Changes**:

Update the "Standard input metadata" line (line 27) to append stream fields:

**Before** (line 27):
```
`issue_number`, `issue_url`, `command`, `phase`, `estimate`, `group_primary`, `group_members`, `artifact_path`, `worktree`
```

**After**:
```
`issue_number`, `issue_url`, `command`, `phase`, `estimate`, `group_primary`, `group_members`, `artifact_path`, `worktree`, `stream_id`, `stream_primary`, `stream_members`, `epic_issue`
```

#### 3. Add stream file naming to Deterministic File Naming table
**File**: `plugin/ralph-hero/skills/shared/conventions.md`
**Changes**:

In the "Deterministic File Naming" table (around line 240), add a new row after the "Group Plan" row:

```markdown
| Stream Plan | `thoughts/shared/plans/YYYY-MM-DD-stream-GH-NNN-NNN-description.md` | `2026-02-17-stream-GH-0042-0044-auth-refresh.md` |
```

#### 4. Add stream glob fallback to Fallback Discovery
**File**: `plugin/ralph-hero/skills/shared/conventions.md`
**Changes**:

In the "Fallback Discovery" section (around line 250), add a stream glob fallback after the group glob fallback:

**Before**:
```
1. **Glob fallback**: Search `thoughts/shared/{type}/*GH-{number}*`. Try both unpadded and zero-padded patterns.
2. **Group glob fallback**: Try `*group*GH-{primary}*` where `{primary}` is the primary issue number.
3. **If found, self-heal**: Post the missing comment to the issue using the correct section header.
4. **If not found**: Block and report the missing artifact.
```

**After**:
```
1. **Glob fallback**: Search `thoughts/shared/{type}/*GH-{number}*`. Try both unpadded and zero-padded patterns.
2. **Group glob fallback**: Try `*group*GH-{primary}*` where `{primary}` is the primary issue number.
3. **Stream glob fallback**: Try `*stream*GH-{number}*` to find stream plans containing this issue.
4. **If found, self-heal**: Post the missing comment to the issue using the correct section header.
5. **If not found**: Block and report the missing artifact.
```

#### 5. Plan skill — Add stream filename convention and frontmatter
**File**: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`
**Changes**:

**5a. Filename convention** (line 149):

**Before**:
```
**Filename**: `thoughts/shared/plans/YYYY-MM-DD-group-GH-NNN-description.md` (use primary issue number; for single issues: `YYYY-MM-DD-GH-NNN-description.md`)
```

**After**:
```
**Filename**: `thoughts/shared/plans/YYYY-MM-DD-group-GH-NNN-description.md` (use primary issue number; for single issues: `YYYY-MM-DD-GH-NNN-description.md`; for stream plans: `YYYY-MM-DD-stream-GH-NNN-NNN-description.md` using sorted issue numbers from the stream)
```

**5b. Frontmatter template** (lines 154-161): Add conditional stream fields after `primary_issue`:

**Before**:
```yaml
---
date: YYYY-MM-DD
status: draft
github_issues: [123, 124, 125]
github_urls:
  - https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/123
primary_issue: 123
---
```

**After**:
```yaml
---
date: YYYY-MM-DD
status: draft
github_issues: [123, 124, 125]
github_urls:
  - https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/123
primary_issue: 123
# Stream fields (include only when planning a work stream):
stream_id: "stream-123-125"
stream_issues: [123, 125]
epic_issue: 40
---
```

#### 6. Impl skill — Add stream worktree row
**File**: `plugin/ralph-hero/skills/ralph-impl/SKILL.md`
**Changes**:

**6a. Worktree ID table** (lines 162-167): Add stream row above epic member (more specific match first):

**Before**:
```
| Condition | WORKTREE_ID |
|-----------|-------------|
| Epic member | `GH-[EPIC_NUMBER]` (e.g., "GH-42") |
| Group plan (not epic) | `GH-[primary_issue]` from plan frontmatter |
| Single issue | `GH-[issue-number]` |
```

**After**:
```
| Condition | WORKTREE_ID |
|-----------|-------------|
| Stream member (epic) | `GH-[EPIC_NUMBER]-stream-[SORTED-ISSUES]` (e.g., "GH-40-stream-42-44") |
| Epic member | `GH-[EPIC_NUMBER]` (e.g., "GH-42") |
| Group plan (not epic) | `GH-[primary_issue]` from plan frontmatter |
| Single issue | `GH-[issue-number]` |
```

Stream detection: if plan frontmatter contains `stream_id`, use the stream worktree naming. This takes precedence over the generic epic member row.

**6b. Plan discovery fallback** (around lines 103-107): Add stream glob fallback after group fallback:

**Before**:
```
   6. **Group fallback**: If standard glob fails, try `thoughts/shared/plans/*group*GH-{primary}*` where `{primary}` is the primary issue number from the issue's group context.
```

**After**:
```
   6. **Group fallback**: If standard glob fails, try `thoughts/shared/plans/*group*GH-{primary}*` where `{primary}` is the primary issue number from the issue's group context.
   6b. **Stream fallback**: If group fallback also fails, try `thoughts/shared/plans/*stream*GH-{number}*` to find stream plans containing this issue.
```

**6c. PR template** (lines 257-279): Add stream context section:

**Before** (the PR create template):
```
[If epic, add:]
## Epic
- Parent: #[EPIC_NUMBER]
```

**After**:
```
[If stream, add:]
## Stream Context
- Epic: #[EPIC_NUMBER]
- Stream: [STREAM_ID] ([N] of [TOTAL_STREAMS] streams)
- Stream issues: [list of #NNN]

[If epic (non-stream), add:]
## Epic
- Parent: #[EPIC_NUMBER]
```

PR title for streams: append `[stream-X-Y of GH-EPIC]` (e.g., `feat(auth): Token refresh [stream-42-44 of GH-40]`)

### File Ownership Summary

| File | Change Type |
|------|------------|
| `plugin/ralph-hero/skills/shared/conventions.md` | Add Work Streams section, extend metadata, add stream file naming, add stream glob fallback |
| `plugin/ralph-hero/skills/ralph-plan/SKILL.md` | Add stream filename convention, add conditional stream frontmatter fields |
| `plugin/ralph-hero/skills/ralph-impl/SKILL.md` | Add stream worktree row, add stream glob fallback, add stream PR template |

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` succeeds (no TS changes, verifies nothing broken)
- [ ] Manual: conventions.md contains "Work Streams" section with stream ID format, naming conventions, context resolution, and lifecycle
- [ ] Manual: conventions.md standard input metadata includes `stream_id`, `stream_primary`, `stream_members`, `epic_issue`
- [ ] Manual: Plan skill SKILL.md filename convention includes stream variant
- [ ] Manual: Plan skill SKILL.md frontmatter template includes conditional stream fields
- [ ] Manual: Impl skill SKILL.md worktree table has stream row as first entry (most specific match)
- [ ] Manual: Impl skill SKILL.md has stream glob fallback for plan discovery
- [ ] Manual: Impl skill SKILL.md PR template includes stream context section
- [ ] Manual: Existing single-issue and group patterns remain unchanged in all three files

---

## Integration Testing
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` passes (no TypeScript touched)
- [ ] All three files parse correctly as valid markdown
- [ ] Stream naming conventions are consistent across all three files (conventions.md is canonical, others reference it)
- [ ] Backward compatibility: single-issue plan filename pattern unchanged, group plan filename pattern unchanged
- [ ] Stream fields in plan frontmatter are clearly marked as conditional (only when planning a work stream)

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0324-stream-scoped-plan-impl-skills.md
- Parent plan (Phase 3): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-21-work-stream-parallelization.md
- Related issues: https://github.com/cdubiel08/ralph-hero/issues/321 (epic), https://github.com/cdubiel08/ralph-hero/issues/322 (Phase 1), https://github.com/cdubiel08/ralph-hero/issues/323 (Phase 2), https://github.com/cdubiel08/ralph-hero/issues/325 (Phase 4)
