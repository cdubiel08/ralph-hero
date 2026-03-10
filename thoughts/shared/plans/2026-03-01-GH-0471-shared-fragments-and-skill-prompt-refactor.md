---
date: 2026-03-01
status: draft
type: plan
github_issues: [471]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/471
primary_issue: 471
---

# Shared Fragments and Skill Prompt Refactor — Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-471 | Ralph Protocol Specs Phase 4: Shared fragments and skill prompt refactor | S |

## Current State Analysis

Phase 1 (GH-468) created `specs/` with README.md and 4 core specs. Phase 2 (GH-469) added issue-lifecycle.md and document-protocols.md. Phase 3 (GH-470) added task-schema.md and team-schema.md. All Phase 1-3 specs use the enablement checkbox convention (`[x]` enforced / `[ ]` gap).

`plugin/ralph-hero/skills/shared/conventions.md` (293 lines) is the target for elimination. It's a reference document with 11 sections, and 7 skills reference it (28 occurrences total). 8 skills are already self-contained.

The three-layer architecture (specs/README.md) says LLMs receive guidance via `!cat` injection, not file references. Skills currently say "See shared/conventions.md for X" — the LLM sees the reference but the actual prose is NOT inlined at load time.

Research recommends Approach B: 4 essential fragments (artifact-discovery, escalation-steps, error-handling, team-reporting) + inline small items (link-formatting 3-row table, sub-agent isolation 1-line callout).

## Desired End State

### Verification
- [ ] `plugin/ralph-hero/skills/shared/fragments/` directory exists with 4 fragment files
- [ ] Each fragment is self-contained (no "See X" or cross-file references)
- [ ] Zero SKILL.md files contain "See shared/conventions.md" or "See conventions.md"
- [ ] All 7 affected skills use `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/X.md` injections
- [ ] Link formatting table inlined directly in each skill's Link Formatting section
- [ ] Sub-agent isolation callouts are self-contained (no conventions.md link)
- [ ] `plugin/ralph-hero/skills/shared/conventions.md` is deleted
- [ ] All specs have enablement checkboxes audited
- [ ] Maturity baseline documented (checked vs unchecked counts)

## What We're NOT Doing
- No new hook enforcement (just documenting gaps)
- No changes to hook scripts
- No changes to agent definitions
- No changes to MCP server code
- No JSON Schema validators
- No automated spec compliance testing
- No changes to skills that don't reference conventions.md (8 skills untouched)

## Implementation Approach

5 phases executed sequentially:
1. Create the 4 fragment files (foundation)
2. Refactor the 7 affected SKILL.md files (replace references with `!cat` injections)
3. Delete conventions.md (only after all references removed)
4. Audit enablement checkboxes across all specs
5. Document maturity baseline in specs/README.md

Each phase builds on the previous — fragments must exist before skills reference them, and all references must be removed before conventions.md deletion.

---

## Phase 1: Create Fragment Library
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/471 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0471-shared-fragments-and-skill-prompt-refactor.md

### Changes Required

#### 1. Create `plugin/ralph-hero/skills/shared/fragments/` directory

#### 2. Create `plugin/ralph-hero/skills/shared/fragments/artifact-discovery.md`
**File**: `plugin/ralph-hero/skills/shared/fragments/artifact-discovery.md` (new)
**Changes**: Self-contained prose for artifact discovery. Extract from conventions.md "Artifact Comment Protocol" + "Fallback Discovery" + "Self-Healing" sections. Include:
- Comment section headers table (Research -> `## Research Document`, Plan -> `## Implementation Plan`, Review -> `## Plan Review`, Impl -> `## Implementation Complete`)
- Discovery steps (1-6): fetch issue, search comments for header, extract URL, convert to local path, read file, glob fallback
- Fallback glob patterns (padded and unpadded)
- Self-healing rule (post missing comment when glob finds artifact)
- Known limitations (10-comment limit, group glob for non-primary issues)
- Deterministic file naming patterns table

Do NOT include: Artifact Passthrough Protocol (already inline in consuming skills), link formatting (separate fragment).

Approximately 40-50 lines.

#### 3. Create `plugin/ralph-hero/skills/shared/fragments/escalation-steps.md`
**File**: `plugin/ralph-hero/skills/shared/fragments/escalation-steps.md` (new)
**Changes**: Self-contained prose for the generic escalation steps. Extract from conventions.md "Escalation Protocol" section. Include:
- When to escalate: complexity, uncertainty, state misalignment
- Generic situation/action table (scope larger than estimated, missing context, architectural decision, conflicting patterns, security concern)
- The 3 escalation steps: (1) move issue to Human Needed via `__ESCALATE__`, (2) post @mention comment, (3) STOP and report
- Note: each skill adds its own trigger table after this fragment

Do NOT include: skill-specific trigger tables (those stay inline in each SKILL.md).

Approximately 20-25 lines.

#### 4. Create `plugin/ralph-hero/skills/shared/fragments/error-handling.md`
**File**: `plugin/ralph-hero/skills/shared/fragments/error-handling.md` (new)
**Changes**: Self-contained prose for standard error handling. Extract from conventions.md "Error Handling" section. Include:
- Tool call failures: read error message, retry with corrected parameters
- State gate blocks: check current workflow state, re-evaluate
- Postcondition failures: satisfy the requirement before retrying

Approximately 10-12 lines.

#### 5. Create `plugin/ralph-hero/skills/shared/fragments/team-reporting.md`
**File**: `plugin/ralph-hero/skills/shared/fragments/team-reporting.md` (new)
**Changes**: Self-contained prose for team worker result reporting. Extract from conventions.md "TaskUpdate Protocol" section + the boilerplate "Team Result Reporting" step pattern. Include:
- TaskUpdate is the primary channel (metadata for machines, description for humans)
- Standard pattern: `TaskUpdate(status="completed", metadata={...}, description="...")`
- Each skill provides its own metadata keys (note: consult the skill's per-phase requirements)
- After completion: check TaskList for more work matching your role
- When to avoid SendMessage: acknowledgments, progress updates, confirmations

Do NOT include: specific metadata keys per phase (those stay inline in each SKILL.md), Communication Discipline rules (team lead guidance, not worker guidance).

Approximately 15-18 lines.

### Success Criteria
- [ ] Automated: `test -d plugin/ralph-hero/skills/shared/fragments/ && ls plugin/ralph-hero/skills/shared/fragments/*.md | wc -l` returns 4
- [ ] Manual: Each fragment contains no "See" or cross-file references
- [ ] Manual: Each fragment is self-contained LLM guidance prose

**Creates for next phase**: Fragment files at known paths for `!cat` injection.

---

## Phase 2: Refactor Skill Prompts
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/471 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0471-shared-fragments-and-skill-prompt-refactor.md

### Changes Required

For each of the 7 affected skills, apply these transformations:

#### 1. ralph-research (3 references)
**File**: `plugin/ralph-hero/skills/ralph-research/SKILL.md`
**Changes**:
- Line ~90: Remove `See [shared/conventions.md](../shared/conventions.md#sub-agent-team-isolation)` link from team isolation callout. Keep the inline `> **Team Isolation**: Do NOT pass team_name...` callout as-is, just remove the trailing link.
- Line ~155: Replace "per Artifact Comment Protocol in shared/conventions.md" with nothing (the artifact comment posting steps are already inline in the skill). Remove the conventions.md reference text only.
- Line ~224: Replace `See [shared/conventions.md]...for escalation protocol and link formatting rules.` with two sections:
  - Add `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/escalation-steps.md` in the Escalation Protocol section
  - Inline the 3-row link formatting table directly

#### 2. ralph-plan (5 references)
**File**: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`
**Changes**:
- Line ~119: Remove `(see [Artifact Passthrough Protocol](../shared/conventions.md#artifact-passthrough-protocol))` — the passthrough steps are already inline.
- Line ~139: Remove conventions.md link from team isolation callout.
- Line ~147: Replace `See shared/conventions.md for error handling.` with `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/error-handling.md`
- Line ~231: Remove "per Artifact Comment Protocol in shared/conventions.md" text from the artifact comment step.
- Line ~267: Replace `See shared/conventions.md for full escalation protocol.` with `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/escalation-steps.md`
- Line ~291: Replace `See shared/conventions.md for GitHub link formatting patterns.` with inlined 3-row link formatting table.

#### 3. ralph-impl (5 references)
**File**: `plugin/ralph-hero/skills/ralph-impl/SKILL.md`
**Changes**:
- Line ~100: Remove `(see [Artifact Passthrough Protocol](../shared/conventions.md#artifact-passthrough-protocol))` from artifact shortcut description.
- Line ~102: Remove "Per Artifact Comment Protocol in shared/conventions.md:" text.
- Line ~193: Replace `escalate per shared/conventions.md` with inline escalation reference: use `__ESCALATE__` state, comment with conflicted files list, STOP.
- Line ~304: Remove "per Artifact Comment Protocol in shared/conventions.md" text.
- Line ~396: Replace `See shared/conventions.md for full escalation protocol.` with `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/escalation-steps.md`
- Line ~408: Replace `See shared/conventions.md for GitHub link format patterns.` with inlined 3-row link formatting table.

#### 4. ralph-review (6 references)
**File**: `plugin/ralph-hero/skills/ralph-review/SKILL.md`
**Changes**:
- Line ~95: Remove `(see [Artifact Passthrough Protocol](../shared/conventions.md#artifact-passthrough-protocol))` from artifact shortcut.
- Line ~97: Remove "Per Artifact Comment Protocol in shared/conventions.md:" text.
- Line ~231: Remove conventions.md link from team isolation callout.
- Line ~256: Remove "per Artifact Comment Protocol in shared/conventions.md" text.
- Line ~298: Remove "per Artifact Comment Protocol in shared/conventions.md" text.
- Line ~362: Replace `Follow [shared/conventions.md]...escalation-protocol` with `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/escalation-steps.md`
- Line ~397: Replace `See [shared/conventions.md]...for GitHub link formatting patterns.` with inlined 3-row link formatting table.

#### 5. ralph-split (3 references)
**File**: `plugin/ralph-hero/skills/ralph-split/SKILL.md`
**Changes**:
- Lines ~57, ~136: Remove conventions.md link from team isolation callouts (both occurrences).
- Line ~353: Replace `Follow [shared/conventions.md]...escalation-protocol` with `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/escalation-steps.md`
- Line ~389: Replace `See [shared/conventions.md]...for GitHub link formatting patterns.` with inlined 3-row link formatting table.

#### 6. ralph-triage (3 references)
**File**: `plugin/ralph-hero/skills/ralph-triage/SKILL.md`
**Changes**:
- Line ~114: Remove conventions.md link from team isolation callout.
- Line ~371: Replace `Follow the escalation procedure in [shared/conventions.md]...` with `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/escalation-steps.md`
- Line ~405: Replace `See [shared/conventions.md]...for GitHub link formatting patterns.` with inlined 3-row link formatting table.

#### 7. ralph-hero (3 references)
**File**: `plugin/ralph-hero/skills/ralph-hero/SKILL.md`
**Changes**:
- Line ~198: Remove `(see Artifact Passthrough Protocol in shared/conventions.md)` from the passthrough description. The passthrough steps are already inline.
- Line ~273: Replace `For escalation procedures...see [shared/conventions.md]...` with `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/escalation-steps.md`
- Line ~309: Replace `See [shared/conventions.md]...for GitHub link patterns.` with inlined 3-row link formatting table.

#### Link Formatting Table (inline in each skill)

The table to inline in all 7 skills' Link Formatting sections:

```markdown
| Reference type | Format |
|---------------|--------|
| File only | `[path/file.py](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py)` |
| With line | `[path/file.py:42](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42)` |
| Line range | `[path/file.py:42-50](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42-L50)` |
```

### Success Criteria
- [ ] Automated: `grep -r "conventions\.md" plugin/ralph-hero/skills/ralph-*/SKILL.md | wc -l` returns 0
- [ ] Automated: `grep -r "conventions\.md" plugin/ralph-hero/skills/ralph-hero/SKILL.md | wc -l` returns 0
- [ ] Automated: `grep -c '!cat.*fragments' plugin/ralph-hero/skills/ralph-*/SKILL.md plugin/ralph-hero/skills/ralph-hero/SKILL.md | grep -v ':0$' | wc -l` shows skills using fragments
- [ ] Manual: Each affected skill has no dangling "See" references to conventions.md
- [ ] Manual: Each skill's Escalation Protocol section has `!cat` injection + skill-specific triggers

**Creates for next phase**: Zero conventions.md references remaining.

---

## Phase 3: Delete conventions.md
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/471 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0471-shared-fragments-and-skill-prompt-refactor.md

### Changes Required

#### 1. Delete `plugin/ralph-hero/skills/shared/conventions.md`
**File**: `plugin/ralph-hero/skills/shared/conventions.md` (DELETE)
**Changes**: `git rm plugin/ralph-hero/skills/shared/conventions.md`

#### 2. Verify no other files reference it
**Verification**: Search entire repo for "conventions.md" — should return zero results in code files (specs/README.md may mention it historically but that's documentation).

### Success Criteria
- [ ] Automated: `test ! -f plugin/ralph-hero/skills/shared/conventions.md`
- [ ] Automated: `grep -r "conventions\.md" plugin/ralph-hero/skills/ | wc -l` returns 0

**Creates for next phase**: Clean state for enablement audit.

---

## Phase 4: Audit Enablement Checkboxes
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/471 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0471-shared-fragments-and-skill-prompt-refactor.md

### Changes Required

#### 1. Audit Phase 1 specs
**Files**: `specs/artifact-metadata.md`, `specs/skill-io-contracts.md`, `specs/skill-permissions.md`, `specs/agent-permissions.md`
**Changes**: For each `[ ]` requirement, check if a hook script now enforces it. If yes, flip to `[x] hook-name.sh`. If no, leave as `[ ] not enforced`. This is a re-verification pass — Phase 1 implementation should already be accurate, but confirm.

#### 2. Audit Phase 2 specs
**Files**: `specs/issue-lifecycle.md`, `specs/document-protocols.md`
**Changes**: Same audit — verify each enablement checkbox matches actual hook enforcement.

#### 3. Audit Phase 3 specs
**Files**: `specs/task-schema.md`, `specs/team-schema.md`
**Changes**: Same audit.

### Success Criteria
- [ ] Manual: Every `[x]` checkbox cites an actual hook script that exists in `hooks/scripts/` or `hooks/hooks.json` or is a built-in runtime enforcement
- [ ] Manual: No orphaned scripts (plan-verify-doc.sh, plan-no-dup.sh) cited as `[x]` enforcers
- [ ] Manual: Advisory hooks (team-task-completed.sh, convergence-gate.sh) accurately described

**Creates for next phase**: Accurate counts for maturity baseline.

---

## Phase 5: Document Maturity Baseline
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/471 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0471-shared-fragments-and-skill-prompt-refactor.md

### Changes Required

#### 1. Add maturity baseline to `specs/README.md`
**File**: `specs/README.md`
**Changes**: Add a new `## Maturity Baseline` section after the Spec Index. Include:
- Table: Spec name | Enforced (`[x]`) | Gap (`[ ]`) | % Enforced
- Row per spec (all 8 specs)
- Total row
- Date of last audit
- Brief note: gaps form the backlog for future enforcement issues

### Success Criteria
- [ ] Automated: `grep -q "## Maturity Baseline" specs/README.md`
- [ ] Manual: Counts match actual `[x]` and `[ ]` counts in each spec file
- [ ] Manual: Total row sums correctly

---

## Integration Testing
- [ ] All 4 fragments exist in `plugin/ralph-hero/skills/shared/fragments/`
- [ ] Zero "conventions.md" references remain in any SKILL.md
- [ ] `conventions.md` is deleted
- [ ] Each affected skill's `!cat` injection paths are correct (`${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/X.md`)
- [ ] Specs enablement checkboxes are consistent with actual hook enforcement
- [ ] Maturity baseline in specs/README.md has accurate counts

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0471-shared-fragments-and-skill-prompt-refactor.md
- Parent plan: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-28-ralph-protocol-specs.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/471
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/467
- conventions.md (to be deleted): `plugin/ralph-hero/skills/shared/conventions.md`
