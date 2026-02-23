---
date: 2026-02-21
status: draft
github_issues: [313, 314, 315, 316]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/312
  - https://github.com/cdubiel08/ralph-hero/issues/313
  - https://github.com/cdubiel08/ralph-hero/issues/314
  - https://github.com/cdubiel08/ralph-hero/issues/315
  - https://github.com/cdubiel08/ralph-hero/issues/316
primary_issue: 313
---

# Artifact Path Passthrough Between Workflow Phases - Atomic Implementation Plan

## Overview
4 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-313 | Define Artifact Passthrough Protocol in conventions.md | XS |
| 2 | GH-314 | Update ralph-team orchestrator for path extraction and injection | S |
| 3 | GH-315 | Update consumer skills to accept artifact path flags | S |
| 4 | GH-316 | Update ralph-hero solo orchestrator for artifact passthrough | XS |

**Why grouped**: All 4 issues implement a single feature — passing artifact file paths between workflow phases to eliminate wasteful token-consuming file discovery. The protocol definition (Phase 1) is consumed by all other phases. The orchestrator changes (Phases 2, 4) produce the flags that consumer skills (Phase 3) consume.

## Current State Analysis

Skills currently discover prior-phase artifacts through a multi-step protocol:
1. Fetch issue with comments via `get_issue` ([conventions.md:473](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md#L473))
2. Search comments for section headers (`## Research Document`, `## Implementation Plan`)
3. Extract URL, convert GitHub URL to local path
4. Fallback: glob search with padded/unpadded patterns ([conventions.md:501-508](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md#L501-L508))
5. Self-heal: post missing comment if found via fallback

This wastes tokens when the team lead already has artifact paths from completed task descriptions (Result Format Contracts at [conventions.md:321-412](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md#L321-L412)):
- `RESEARCH COMPLETE` includes `Document: [path]`
- `PLAN COMPLETE` includes `Plan: [path]`
- `VALIDATION VERDICT` includes `Plan: [path]`

## Desired End State

### Verification
- [ ] Skills accept `--research-doc` and `--plan-doc` flags in args, skipping discovery when valid path provided
- [ ] Direct user invocation without flags still works (backward compatible)
- [ ] Invalid/missing paths fall back to standard discovery
- [ ] ralph-team lead extracts paths from task results and injects into spawn args
- [ ] ralph-hero orchestrator passes paths between phases
- [ ] Resolved spawn prompts stay under 10 lines (template integrity preserved)

## What We're NOT Doing
- Changing `worker.md` template structure (path lives inside `{SKILL_INVOCATION}` args)
- Modifying hooks (`plan-research-required.sh`, `impl-plan-required.sh`) — they check filesystem, not args
- Changing Result Format Contracts — they already contain the paths we need
- Adding new environment variables or config

## Implementation Approach

Phase 1 defines the protocol. Phases 2-4 are producer/consumer pairs that reference the protocol. Phase 3 (consumer skills) can be implemented in parallel with Phase 2 (orchestrator producer) since the flag format is defined in Phase 1.

---

## Phase 1: GH-313 - Define Artifact Passthrough Protocol in conventions.md
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/313 | **Depends on**: none

### Changes Required

#### 1. Add Artifact Passthrough Protocol section
**File**: `plugin/ralph-hero/skills/shared/conventions.md`
**Changes**: Insert new section after "Artifact Comment Protocol" (after line 532). Define:
- `--research-doc` and `--plan-doc` flags
- Argument format: `{issue-number} --{flag} {local-path}`
- Parsing rules: first token = issue number, flags optional, validate file exists, fallback if missing
- Lead extraction rules: parse `Document:` / `Plan:` lines from completed task descriptions
- Example with and without flags

#### 2. Update Spawn Template Protocol
**File**: `plugin/ralph-hero/skills/shared/conventions.md`
**Changes**: In the Placeholder Substitution table (line 140), update `{SKILL_INVOCATION}` description to note that artifact flags may be appended to args when available. Add example in the Resolution Procedure showing args with artifact flag.

### Success Criteria
- [x] Automated: `grep -c "Artifact Passthrough Protocol" plugin/ralph-hero/skills/shared/conventions.md` returns 1
- [x] Automated: `grep -c "\-\-research-doc" plugin/ralph-hero/skills/shared/conventions.md` returns >= 1
- [x] Manual: Protocol section defines both flags, parsing rules, and lead extraction rules

**Creates for next phase**: Protocol definition that Phases 2-4 reference

---

## Phase 2: GH-314 - Update ralph-team orchestrator for path extraction and injection
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/314 | **Depends on**: Phase 1

### Changes Required

#### 1. Add path extraction to dispatch loop
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Changes**: In Section 4.4 (Dispatch Loop), after the bough advancement paragraph, add guidance for extracting artifact paths from completed task descriptions before creating next-bough tasks. Reference conventions.md Artifact Passthrough Protocol.

#### 2. Update spawn `{SKILL_INVOCATION}` construction
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Changes**: In Section 6, update the `{SKILL_INVOCATION}` placeholder description to show how artifact flags are appended:
- Plan: `args="{ISSUE_NUMBER} --research-doc {RESEARCH_PATH}"`
- Implement: `args="{ISSUE_NUMBER} --plan-doc {PLAN_PATH}"`
- Review: `args="{ISSUE_NUMBER} --plan-doc {PLAN_PATH}"`
- Omit flag if no path extracted (best-effort)

### Success Criteria
- [x] Automated: `grep -c "\-\-research-doc" plugin/ralph-hero/skills/ralph-team/SKILL.md` returns >= 1
- [x] Automated: `grep -c "\-\-plan-doc" plugin/ralph-hero/skills/ralph-team/SKILL.md` returns >= 1
- [x] Manual: Section 4.4 describes path extraction from task results
- [x] Manual: Section 6 shows artifact flag construction for all downstream roles

**Creates for next phase**: Orchestrator produces flags that consumer skills (Phase 3) accept

---

## Phase 3: GH-315 - Update consumer skills to accept artifact path flags
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/315 | **Depends on**: Phase 1

### Changes Required

#### 1. ralph-plan: Accept `--research-doc`
**File**: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`
**Changes**:
- Update `argument-hint` in frontmatter to `[optional-issue-number] [--research-doc path]`
- Add **Artifact shortcut** block at top of Step 2 (Gather Group Context): if flag provided and file exists, read directly and skip comment search, glob fallback, self-healing for that issue
- Note: for groups, flag covers primary issue only; other members use standard discovery

#### 2. ralph-impl: Accept `--plan-doc`
**File**: `plugin/ralph-hero/skills/ralph-impl/SKILL.md`
**Changes**:
- Update `argument-hint` in frontmatter to `[optional-issue-number] [--plan-doc path]`
- Add **Artifact shortcut** block at top of Step 2, sub-step 2 (Find linked plan document): if flag provided and file exists, use directly and skip discovery

#### 3. ralph-review: Accept `--plan-doc`
**File**: `plugin/ralph-hero/skills/ralph-review/SKILL.md`
**Changes**:
- Update `argument-hint` in frontmatter to `<issue-number> [--interactive] [--plan-doc path]`
- Add **Artifact shortcut** block before plan discovery: if flag provided and file exists, use directly and skip discovery

### Success Criteria
- [x] Automated: `grep -c "\-\-research-doc" plugin/ralph-hero/skills/ralph-plan/SKILL.md` returns >= 1
- [x] Automated: `grep -c "\-\-plan-doc" plugin/ralph-hero/skills/ralph-impl/SKILL.md` returns >= 1
- [x] Automated: `grep -c "\-\-plan-doc" plugin/ralph-hero/skills/ralph-review/SKILL.md` returns >= 1
- [x] Manual: Each skill's artifact shortcut validates file exists before using, falls back to discovery if not

**Creates for next phase**: Consumer skills ready to receive flags from orchestrators

---

## Phase 4: GH-316 - Update ralph-hero solo orchestrator for artifact passthrough
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/316 | **Depends on**: Phase 1, Phase 2 (pattern)

### Changes Required

#### 1. Add artifact passthrough to skill invocations
**File**: `plugin/ralph-hero/skills/ralph-hero/SKILL.md`
**Changes**: Where ralph-hero invokes skills via `Skill()` for PLAN, REVIEW, and IMPLEMENT phases, update to pass artifact paths from prior phase results through args. Follow same pattern as ralph-team (Phase 2). Reference conventions.md Artifact Passthrough Protocol.

### Success Criteria
- [x] Automated: `grep -c "\-\-research-doc\|--plan-doc" plugin/ralph-hero/skills/ralph-hero/SKILL.md` returns >= 1
- [x] Manual: PLAN phase passes `--research-doc`, IMPLEMENT/REVIEW phases pass `--plan-doc`

---

## File Ownership Summary

| File | Phase |
|------|-------|
| `plugin/ralph-hero/skills/shared/conventions.md` | 1 |
| `plugin/ralph-hero/skills/ralph-team/SKILL.md` | 2 |
| `plugin/ralph-hero/skills/ralph-plan/SKILL.md` | 3 |
| `plugin/ralph-hero/skills/ralph-impl/SKILL.md` | 3 |
| `plugin/ralph-hero/skills/ralph-review/SKILL.md` | 3 |
| `plugin/ralph-hero/skills/ralph-hero/SKILL.md` | 4 |

## Integration Testing
- [ ] Run `/ralph-plan 42 --research-doc thoughts/shared/research/some-existing-file.md` — should skip discovery and use provided file
- [ ] Run `/ralph-plan 42` — should use existing discovery protocol (backward compat)
- [ ] Run `/ralph-plan 42 --research-doc nonexistent.md` — should fall back to discovery
- [ ] Run a full `/ralph-team NNN` cycle and confirm workers receive artifact paths in spawn logs
- [ ] Verify resolved spawn prompts stay under 10 lines (template integrity)

## References
- Research: [Artifact Passthrough Plan](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-21-group-GH-0312-artifact-path-passthrough.md)
- Existing patterns: [Artifact Comment Protocol](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md#L414), [Result Format Contracts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md#L321), [Spawn Template Protocol](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md#L118)
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/312
