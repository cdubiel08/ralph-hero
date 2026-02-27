---
date: 2026-02-27
status: draft
github_issues: [365]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/365
primary_issue: 365
---

# Centralize Quality Standards - Implementation Plan

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-365 | Centralize project quality standards and embed them in plan phases | S |

## Current State Analysis

Quality standards are scattered across 3 skill files with overlapping but diverging criteria:

- `ralph-plan/SKILL.md:285-300` — 6 positive, 5 negative guidelines ("Good plans have / Avoid")
- `ralph-review/SKILL.md:397-409` — 4 focus areas, 4 anti-patterns ("Focus on / Avoid")
- `ralph-research/SKILL.md:222-226` — 2 inline sentences ("Focus on / Avoid")

The ralph-review AUTO mode critique prompt (`SKILL.md:196-200`) uses 4 named dimensions (Completeness, Feasibility, Clarity, Scope) that are already the de facto standard across 19 critique documents. These dimensions map cleanly to the scattered criteria and provide the best canonical foundation.

`shared/conventions.md` is currently the only file in `shared/` and has zero quality criteria.

## Desired End State

### Verification
- [x] `plugin/ralph-hero/skills/shared/quality-standards.md` exists with canonical quality dimensions
- [x] `ralph-plan/SKILL.md` Quality section references shared standard
- [x] `ralph-review/SKILL.md` Quality section references shared standard
- [x] `ralph-research/SKILL.md` Quality section references shared standard
- [x] All 4 files are syntactically valid markdown

## What We're NOT Doing

- Not modifying the ralph-review AUTO mode inline prompt (lines 196-200) — the sub-agent needs criteria inline since it can't load external files
- Not modifying `ralph-impl/SKILL.md` — it mechanically consumes checkboxes, not quality policy
- Not modifying `ralph-triage/SKILL.md` — confidence levels are triage-specific, not plan/review quality
- Not modifying `shared/conventions.md` — keeping quality separate from protocol/process conventions
- Not changing the plan template structure (Success Criteria, What We're NOT Doing sections)

## Implementation Approach

Single phase with 4 file changes:
1. Create the shared canonical standard
2. Update 3 skill files to reference it, replacing inline duplicates

The ralph-review AUTO mode inline prompt (lines 196-200) stays unchanged — it's embedded in a sub-agent prompt string that can't reference external files. Its Quality Guidelines section (lines 397-409) is the correct replacement target.

---

## Phase 1: Create shared quality standards and update skill references
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/365 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0365-centralize-quality-standards.md

### Changes Required

#### 1. Create canonical quality standards document
**File**: `plugin/ralph-hero/skills/shared/quality-standards.md` (NEW)
**Changes**: Create file with the unified quality standard. Structure:

```markdown
# Quality Standards

Canonical quality criteria referenced by ralph-plan, ralph-review, and ralph-research.

## Plan Quality Dimensions

Plans are evaluated on four dimensions (matching ralph-review AUTO critique):

1. **Completeness** — All phases defined with specific file changes and clear descriptions
2. **Feasibility** — Referenced files exist; patterns are valid and follow existing codebase conventions
3. **Clarity** — Success criteria are specific and testable (`- [ ] Automated:` / `- [ ] Manual:` format)
4. **Scope** — "What we're NOT doing" section is explicit and well-bounded

### Group-Specific Requirements

For multi-issue group plans, also verify:
- Phase dependencies are explicit (each phase states what it creates for the next)
- Integration testing section covers cross-phase interactions

### Plan Anti-Patterns

Avoid:
- Vague descriptions like "update the code"
- Missing or untestable success criteria
- Unbounded scope without explicit exclusions
- Ignoring existing patterns in the codebase
- For groups: unclear phase ordering or missing dependencies

## Research Quality Dimensions

Research documents are evaluated on:

1. **Depth** — Problem understood from user perspective with root cause analysis
2. **Feasibility** — Existing codebase patterns identified to leverage
3. **Risk** — Edge cases and failure modes identified
4. **Actionability** — Recommendations are concrete with file:line references

### Research Anti-Patterns

Avoid:
- Premature solutioning before understanding the problem
- Over-engineering suggestions beyond issue scope
- Ignoring existing patterns in the codebase
- Vague findings without concrete file references

## Review Anti-Patterns

When reviewing plans or research, avoid:
- Rubber-stamping without analysis
- Over-critiquing minor style issues
- Blocking on subjective preferences
- Creating critique without actionable feedback
```

#### 2. Update ralph-plan Quality Guidelines section
**File**: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`
**Lines**: 285-300 (replace entire section content)
**Change**: Replace inline guidelines with reference to shared standard

Replace:
```markdown
## Planning Quality Guidelines

Good plans have:
- Clear phases with specific file changes
- Testable success criteria for each phase
- Explicit scope boundaries (what we're NOT doing)
- References to existing code patterns to follow
- For groups: explicit dependencies between phases
- For groups: integration testing section

Avoid:
- Vague descriptions like "update the code"
- Missing success criteria
- Unbounded scope
- Ignoring existing patterns in the codebase
- For groups: unclear phase ordering or dependencies
```

With:
```markdown
## Planning Quality Guidelines

See [shared/quality-standards.md](../shared/quality-standards.md) for canonical plan quality dimensions (Completeness, Feasibility, Clarity, Scope) and group-specific requirements.
```

#### 3. Update ralph-review Quality Guidelines section
**File**: `plugin/ralph-hero/skills/ralph-review/SKILL.md`
**Lines**: 397-409 (replace entire section content)
**Change**: Replace inline guidelines with reference to shared standard

Replace:
```markdown
## Quality Guidelines

**Focus on**:
- Plan completeness (all phases defined)
- Success criteria specificity (testable)
- Scope boundaries (what we're NOT doing)
- Technical feasibility (files exist, patterns valid)

**Avoid**:
- Rubber-stamping without analysis
- Over-critiquing minor style issues
- Blocking on subjective preferences
- Creating critique without actionable feedback
```

With:
```markdown
## Quality Guidelines

See [shared/quality-standards.md](../shared/quality-standards.md) for canonical plan quality dimensions and review anti-patterns.
```

#### 4. Update ralph-research Research Quality section
**File**: `plugin/ralph-hero/skills/ralph-research/SKILL.md`
**Lines**: 222-226 (replace entire section content)
**Change**: Replace inline quality text with reference to shared standard

Replace:
```markdown
## Research Quality

Focus on: understanding the problem deeply, finding existing codebase patterns to leverage, identifying risks and edge cases, providing actionable recommendations.

Avoid: premature solutioning, over-engineering suggestions, ignoring existing patterns, vague findings.
```

With:
```markdown
## Research Quality

See [shared/quality-standards.md](../shared/quality-standards.md) for canonical research quality dimensions (Depth, Feasibility, Risk, Actionability) and anti-patterns.
```

### File Ownership Summary

| File | Action |
|------|--------|
| `plugin/ralph-hero/skills/shared/quality-standards.md` | CREATE |
| `plugin/ralph-hero/skills/ralph-plan/SKILL.md` | MODIFY (lines 285-300) |
| `plugin/ralph-hero/skills/ralph-review/SKILL.md` | MODIFY (lines 397-409) |
| `plugin/ralph-hero/skills/ralph-research/SKILL.md` | MODIFY (lines 222-226) |

### Success Criteria

- [x] Automated: `test -f plugin/ralph-hero/skills/shared/quality-standards.md` exits 0
- [x] Automated: `grep -q "quality-standards.md" plugin/ralph-hero/skills/ralph-plan/SKILL.md` exits 0
- [x] Automated: `grep -q "quality-standards.md" plugin/ralph-hero/skills/ralph-review/SKILL.md` exits 0
- [x] Automated: `grep -q "quality-standards.md" plugin/ralph-hero/skills/ralph-research/SKILL.md` exits 0
- [x] Automated: `grep -c "Completeness" plugin/ralph-hero/skills/shared/quality-standards.md` returns at least 1
- [x] Automated: `grep -c "Feasibility" plugin/ralph-hero/skills/shared/quality-standards.md` returns at least 1
- [x] Manual: ralph-review AUTO mode inline prompt (lines 196-200) is unchanged
- [x] Manual: No other skill files are modified

## Integration Testing

- [x] Verify `quality-standards.md` relative links work from each skill file's location (`../shared/quality-standards.md`)
- [x] Verify the ralph-review AUTO critique prompt (lines 196-200) still contains the 4 inline dimensions
- [x] Verify `ralph-impl` checkpoint consumption is unaffected (no changes to that file)

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0365-centralize-quality-standards.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/365
- Prior art: `thoughts/shared/plans/2026-02-21-ralph-hero-guidance-improvements.md` (guidance centralization initiative)
