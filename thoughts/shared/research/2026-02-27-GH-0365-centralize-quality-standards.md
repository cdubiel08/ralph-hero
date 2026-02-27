---
date: 2026-02-27
github_issue: 365
github_url: https://github.com/cdubiel08/ralph-hero/issues/365
status: complete
type: research
---

# GH-365: Centralize Project Quality Standards

## Problem Statement

Quality standards are defined in isolation across multiple skill files, using slightly different language and structure. `ralph-plan` has 6 planning guidelines, `ralph-review` AUTO mode checks 4 dimensions — they overlap on 3 of 4 points but diverge on "existing patterns" and "phase dependencies." `shared/conventions.md` has zero quality criteria. There is no canonical reference a skill can point to.

This creates drift risk: when the plan defines quality one way and the review validates it another way, agents can produce plans that pass one check but fail the other. The fix is a shared canonical `quality-standards.md` that both skills reference.

## Current State Analysis

### Quality Content Inventory

#### `ralph-plan/SKILL.md:285-300` — Planning Quality Guidelines

Two-section "Good/Avoid" structure:

**Good plans have:**
1. Clear phases with specific file changes
2. Testable success criteria for each phase
3. Explicit scope boundaries (what we're NOT doing)
4. References to existing code patterns to follow
5. For groups: explicit dependencies between phases
6. For groups: integration testing section

**Avoid:**
- Vague descriptions like "update the code"
- Missing success criteria
- Unbounded scope
- Ignoring existing patterns in the codebase
- For groups: unclear phase ordering or dependencies

The plan template itself (lines 155-217) also structurally encodes quality: each phase requires `### Success Criteria` with `- [ ] Automated:` and `- [ ] Manual:` items, plus a top-level `## What We're NOT Doing` section.

#### `ralph-review/SKILL.md:196-200` — AUTO Mode Critique Dimensions

The AUTO mode critique prompt instructs the sub-agent to evaluate:
1. **Completeness**: Are all phases defined with clear changes?
2. **Feasibility**: Do referenced files exist? Are patterns valid?
3. **Clarity**: Are success criteria specific and testable?
4. **Scope**: Is 'What we're NOT doing' well-defined?

#### `ralph-review/SKILL.md:397-413` — Quality Guidelines Section

Separately (not in the AUTO prompt), the review skill's own Quality Guidelines section says:

**Focus on:**
- Plan completeness (all phases defined)
- Success criteria specificity (testable)
- Scope boundaries (what we're NOT doing)
- Technical feasibility (files exist, patterns valid)

**Avoid:**
- Rubber-stamping without analysis
- Over-critiquing minor style issues
- Blocking on subjective preferences
- Creating critique without actionable feedback

#### `ralph-research/SKILL.md:222-226` — Research Quality

Single paragraph: "Focus on: understanding the problem deeply, finding existing codebase patterns to leverage, identifying risks and edge cases, providing actionable recommendations. Avoid: premature solutioning, over-engineering suggestions, ignoring existing patterns, vague findings."

#### `shared/conventions.md` — No Quality Content

1,138-line file covering 10 protocols. Zero mentions of "quality." Protocols govern communication and artifact handling, not quality standards.

### Overlap Analysis

| Criterion | ralph-plan | ralph-review AUTO | ralph-review QG | ralph-research |
|-----------|-----------|-------------------|-----------------|----------------|
| Testable success criteria | ✓ (line 289) | ✓ Clarity | ✓ | — |
| Scope boundaries / NOT doing | ✓ (line 291) | ✓ Scope | ✓ | — |
| Existing codebase patterns | ✓ (line 292) | ✓ Feasibility (implicit) | ✓ Feasibility | ✓ |
| Clear phase changes | ✓ (line 288) | ✓ Completeness | ✓ | — |
| Group: phase dependencies | ✓ (line 293-294) | — | — | — |
| Group: integration testing | ✓ (line 295) | — | — | — |
| Risk / edge cases | — | — | — | ✓ |

### Key Divergence Points

1. **ralph-plan has "group-specific" criteria** (lines 293-295) that ralph-review does not validate. A group plan could be reviewed without checking phase dependency clarity.

2. **ralph-review has "Feasibility" as a dimension** (verifying referenced files exist via `codebase-analyzer`) that ralph-plan's guidelines don't mention. Plans can reference non-existent files and still pass planning quality checks.

3. **ralph-research's "risks and edge cases"** has no counterpart in plan or review quality criteria. A plan could lack risk analysis and still be approved.

4. **ralph-review Quality Guidelines and AUTO critique use different wording** for the same dimensions, even within the same skill file (lines 196-200 vs 397-413).

### How ralph-impl Consumes Quality Artifacts

`ralph-impl/SKILL.md:126-130` treats `- [ ] Automated:` checkboxes as a progress state machine. A phase is complete when ALL its automated verification items are `- [x]`. The impl skill does not interpret quality criteria — it mechanically executes verification commands extracted from the plan. Plan quality therefore flows upstream: bad criteria → bad automated checks → failed or bypassed verification.

### Prior Related Work

- `thoughts/shared/plans/2026-02-21-ralph-hero-guidance-improvements.md`: Identified guidance centralization as a priority. Noted "skills lack shared includes" and "thin agent definitions."
- `thoughts/shared/plans/2026-02-15-skill-prompt-refactoring.md`: Anti-pattern elimination research.
- `thoughts/shared/reviews/` (19 files): Existing critique format is consistent — Verdict → Completeness → Feasibility → Clarity → Scope → Risk Assessment. This is already the de facto standard.

## Key Discoveries

### `plugin/ralph-hero/skills/ralph-plan/SKILL.md:285-300`
Current quality section — 6 positive, 5 negative criteria. Group-specific criteria only here.

### `plugin/ralph-hero/skills/ralph-review/SKILL.md:196-200`
AUTO mode uses 4 named dimensions (Completeness, Feasibility, Clarity, Scope) — already the best canonical framing.

### `plugin/ralph-hero/skills/ralph-review/SKILL.md:397-413`
Review's own Quality Guidelines section duplicates the AUTO criteria in different wording.

### `plugin/ralph-hero/skills/ralph-research/SKILL.md:222-226`
Brief research quality paragraph — no structured criteria.

### `plugin/ralph-hero/skills/shared/conventions.md`
Protocol-only, no quality content. The natural home for a new `quality-standards.md` is alongside this file.

## Potential Approaches

### Option A: New `shared/quality-standards.md` + Update Per-Skill References (Recommended)

Create a single canonical file at `plugin/ralph-hero/skills/shared/quality-standards.md` that defines the unified standard. Update the 3 affected skill files to reference it.

**Unified standard structure** (synthesizing all 4 sources):

**Plan Quality Dimensions (from ralph-review AUTO — already validated in practice):**
1. **Completeness** — All phases defined with specific file changes
2. **Feasibility** — Referenced files exist; patterns are valid and followed
3. **Clarity** — Success criteria are specific and testable (Automated: / Manual: format)
4. **Scope** — "What we're NOT doing" section is explicit

**Plan-Specific Additions:**
5. **For groups** — Phase dependencies are explicit; integration testing section exists

**Research Quality Dimensions:**
6. **Depth** — Problem understood from user perspective with root cause analysis
7. **Risk** — Edge cases and failure modes identified
8. **Actionability** — Recommendations are concrete with file:line references

**Files to modify:**
- `plugin/ralph-hero/skills/shared/quality-standards.md` (CREATE ~50 lines)
- `plugin/ralph-hero/skills/ralph-plan/SKILL.md` — Replace lines 285-300 with reference to shared file
- `plugin/ralph-hero/skills/ralph-review/SKILL.md` — Replace lines 196-200 (AUTO prompt) with reference; replace lines 397-413 with reference
- `plugin/ralph-hero/skills/ralph-research/SKILL.md` — Replace lines 222-226 with reference

**Pros:**
- Single source of truth — drift impossible
- Improves plan/review alignment (adds Feasibility to plan, Risk to review)
- Consistent vocabulary across all skills
- Small change surface — only 4 files

**Cons:**
- Skills reference an external file that must be loaded to be useful (but agents already load `shared/conventions.md` the same way)

### Option B: Embed Shared Standard in `shared/conventions.md`

Add a `## Quality Standards` section to the existing conventions file rather than creating a new file.

**Pros:** One fewer file; conventions already loaded by all skills

**Cons:** Conventions is already 1,138 lines and protocol-focused. Adding quality criteria mixes concerns. A dedicated file is more discoverable.

### Option C: In-Place Harmonization (No Shared File)

Update each skill's quality section to use identical language without creating a shared file.

**Pros:** No new file needed; each skill is self-contained

**Cons:** Drift will recur as skills evolve independently. Doesn't solve the root problem.

## Recommendation

**Option A** — Create `shared/quality-standards.md` and update 3 skill files. The 4-dimension model from ralph-review AUTO mode (Completeness, Feasibility, Clarity, Scope) is already validated by practice (19 critique documents use it). Use it as the canonical plan quality standard, augmenting with group-specific criteria and research-specific dimensions.

The research quality paragraph in ralph-research is the lowest priority update since it's not mechanically consumed by other skills.

## Risks

- **Breaking AUTO mode critique prompt**: The AUTO prompt in ralph-review embeds the 4 criteria inline in a sub-agent prompt string. If we replace those lines with a reference, the sub-agent won't have the file in its context. **Mitigation**: Keep the criteria inline in the AUTO prompt but note they match `shared/quality-standards.md`. The Quality Guidelines section (lines 397-413) is the better target for a clean reference replacement.
- **Token cost**: Loading an additional shared file adds ~50-100 tokens per skill invocation. Negligible.

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/shared/quality-standards.md` - Create canonical quality standards document
- `plugin/ralph-hero/skills/ralph-plan/SKILL.md` - Update Planning Quality Guidelines section to reference shared standard and align with 4-dimension model
- `plugin/ralph-hero/skills/ralph-review/SKILL.md` - Update Quality Guidelines section (lines 397-413) to reference shared standard
- `plugin/ralph-hero/skills/ralph-research/SKILL.md` - Update Research Quality section to reference shared standard

### Will Read (Dependencies)
- `plugin/ralph-hero/skills/shared/conventions.md` - Existing conventions file (model for shared/ pattern)
- `plugin/ralph-hero/skills/ralph-impl/SKILL.md` - Verify Automated: checkbox format requirements (must stay compatible)
