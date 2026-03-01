---
date: 2026-03-01
github_issue: 471
github_url: https://github.com/cdubiel08/ralph-hero/issues/471
status: complete
type: research
---

# Research: Ralph Protocol Specs Phase 4 — Shared Fragments and Skill Prompt Refactor

## Problem Statement

Phase 4 requires designing a shared fragment library, refactoring all skill prompts to use `!cat` injection instead of `See conventions.md` references, and deleting conventions.md after all references are eliminated. It also requires auditing enablement checkboxes across all specs to produce a maturity baseline.

The core problem: `conventions.md` is a reference document that LLMs must "go read" at runtime — but the three-layer architecture (established in Phase 1 specs/README.md) says LLMs should receive guidance via `!cat` injection, not file references. Skills currently say things like "See shared/conventions.md for escalation protocol" or "per Artifact Comment Protocol in shared/conventions.md" — the LLM sees the reference but never has the prose inlined. This creates runtime risk: if the `!cat` injection mechanism isn't used, the LLM may miss protocol details.

---

## Current State Analysis

### 1. What conventions.md Contains

`plugin/ralph-hero/skills/shared/conventions.md` (293 lines) has 11 major sections:

| Section | Lines | Referenced By |
|---------|-------|---------------|
| Identifier Disambiguation (T- vs GH-) | ~15 | — (background knowledge) |
| TaskUpdate Protocol | ~25 | 6 skills |
| Communication Discipline | ~20 | — (team lead guidance) |
| Escalation Protocol | ~30 | 11 skills |
| Link Formatting | ~10 | 7 skills |
| Error Handling | ~10 | 8 skills |
| Pipeline Handoff Protocol | ~15 | — (background) |
| Skill Invocation Convention | ~20 | — (background) |
| Sub-Agent Team Isolation | ~20 | 5 skills |
| Architecture Decision ADR-001 | ~20 | — (reference) |
| Artifact Comment Protocol | ~60 | 5 skills |
| Artifact Passthrough Protocol | ~65 | 5 skills |

### 2. How Skills Currently Reference conventions.md

Three patterns exist across the 15 ralph-* SKILL.md files:

**Pattern A: Full reference only (no inline prose)**
Most escalation, link formatting, and error handling references simply say "See shared/conventions.md for X":
```
## Escalation Protocol
See shared/conventions.md for full escalation protocol. Use `command="ralph_plan"` in state transitions.

## Link Formatting
See shared/conventions.md for GitHub link formatting patterns.
```
Affected skills: ralph-plan, ralph-impl, ralph-review, ralph-split, ralph-triage, ralph-hero (for link formatting/escalation)

**Pattern B: Brief inline callout + reference**
The Sub-Agent Team Isolation warning is always inlined as a one-line callout:
```
> **Team Isolation**: Do NOT pass `team_name` to these sub-agent `Task()` calls.
> Sub-agents must run outside any team context. See [shared/conventions.md](../shared/conventions.md#sub-agent-team-isolation).
```
Affected skills: ralph-research, ralph-plan, ralph-split (×2), ralph-triage, ralph-review

**Pattern C: Inline + comment comment (per Artifact Comment Protocol in shared/conventions.md)**
Skills that post artifact comments inline the specific comment body but reference conventions.md for protocol:
```
1. **Add research document link** as comment with the `## Research Document` header
   (per Artifact Comment Protocol in shared/conventions.md):
```
Affected skills: ralph-research, ralph-plan, ralph-impl, ralph-review

### 3. Team Reporting — Repeated Inline Prose

The "Team Result Reporting" step appears in 6 skills with nearly identical prose that is fully inlined (not a reference):

All 6 variants follow this pattern:
> "When running as a team worker, mark your assigned task complete via TaskUpdate. Include key results in metadata ([skill-specific keys]) and a human-readable summary in the description. Then check TaskList for more work matching your role."

The skill-specific metadata keys differ (research: `artifact_path, workflow_state`; plan: `artifact_path, phase_count, workflow_state`; impl: `worktree, phase_completed`; etc.) but the framing sentence is identical across all 6 skills.

### 4. Escalation — Pattern across skills

Escalation sections follow a consistent structure:
1. "Follow [shared/conventions.md] escalation protocol with `command='ralph_X'`"
2. Skill-specific triggers table (unique per skill — cannot fragment)
3. Additional skill-specific steps (e.g., triage: add `ralph-triage` label)

The shared generic steps (move issue to Human Needed, post @mention comment, STOP) are in conventions.md but NOT inlined in skill prompts. Skills rely on the LLM reading conventions.md for the actual escalation steps.

### 5. Skills With Zero conventions.md References

8 skills have no conventions.md references:
- ralph-hygiene, ralph-merge, ralph-pr, ralph-report, ralph-setup, ralph-status, ralph-team, ralph-val

These skills are already self-contained and need no changes.

### 6. Skills Requiring Significant Refactor

7 skills reference conventions.md:
- ralph-hero (3 references), ralph-impl (5 references), ralph-plan (5 references)
- ralph-research (3 references), ralph-review (6 references)
- ralph-split (3 references), ralph-triage (3 references)

### 7. Fragment Candidates — What Prose Is Shared

Based on reference frequency and content analysis:

| Fragment | Skills Using | Content Type | Lines Est. |
|----------|-------------|--------------|------------|
| `artifact-discovery.md` | 5 (research, plan, impl, review + hero) | Steps 1-7 for finding linked artifacts via comments or glob fallback | ~25 |
| `error-handling.md` | 8 (all major pipeline skills) | 3-item list: tool failures, state gate blocks, postcondition failures | ~10 |
| `escalation-steps.md` | 11 (all pipeline skills) | Generic 3-step escalation: __ESCALATE__ state, @mention comment, STOP | ~15 |
| `team-reporting.md` | 6 (research, plan, impl, review, split, triage) | TaskUpdate pattern with metadata/description; check TaskList after | ~12 |
| `sub-agent-isolation.md` | 5 (research, plan, split, triage, review) | Rule + correct/incorrect code examples | ~15 |
| `link-formatting.md` | 7 (research, plan, impl, review, split, triage, hero) | Table of 3 link format patterns | ~8 |

**NOT fragment candidates** (skill-specific, cannot be shared):
- Skill-specific escalation trigger tables (unique per skill)
- Artifact passthrough flag parsing (fully inlined in ralph-plan/impl/review; complex enough to stay inline)
- Team reporting metadata keys (each skill has different keys)
- Skill-specific constraints sections

### 8. Artifact Passthrough — Already Inline

The Artifact Passthrough Protocol is already fully inlined in ralph-plan, ralph-impl, and ralph-review as a detailed step with specific flag parsing rules. ralph-hero references it. This content is too procedural to fragment meaningfully — the skills already handle it correctly. The reference in ralph-hero is appropriate since ralph-hero orchestrates rather than consuming artifacts directly.

### 9. Enablement Maturity Baseline (Phase 1 Specs Only)

Phase 1 specs produce this baseline (Phases 2-3 not yet implemented):

| Spec | Enforced (`[x]`) | Gap (`[ ]`) | % Enforced |
|------|-----------------|------------|-----------|
| artifact-metadata.md | 11 | 32 | 26% |
| skill-io-contracts.md | 31 | 5 | 86% |
| skill-permissions.md | 6 | 5 | 55% |
| agent-permissions.md | 13 | 0 | 100% |
| **Phase 1 Total** | **61** | **42** | **59%** |

Key gaps in artifact-metadata.md (32 unchecked): File naming conventions (6), all frontmatter fields for all artifact types (13+), artifact comment linking (5), artifact discovery sequence (2).

Key gaps in skill-io-contracts.md (5 unchecked): Stateless skills principle (3), team worker result reporting (2).

### 10. Deletion of conventions.md — Prerequisites

Before conventions.md can be deleted, ALL references must be eliminated. Current reference count:
- ralph-hero: 3 references
- ralph-impl: 5 references
- ralph-plan: 5 references
- ralph-research: 3 references
- ralph-review: 6 references (highest)
- ralph-split: 3 references
- ralph-triage: 3 references

Total: 28 reference occurrences across 7 files. All must be replaced with `!cat` injections or inlined prose before deletion.

---

## Key Discoveries

### Discovery 1: conventions.md Uses "See" Not "!cat" — That's the Core Problem

conventions.md was written as a **reference document** for humans who know to go read it. The intent of Phase 4 is to convert these to `!cat` injections so the LLM sees the prose inline. Currently, skills say things like "See shared/conventions.md for escalation protocol" — the LLM sees this text at runtime but never gets the actual escalation steps unless it goes to read the file (which it's not supposed to do via file-reading in production skills that `!cat` inject at load time).

### Discovery 2: Team Reporting Is the Easiest Fragment — Boilerplate Body, Variable Keys

The team reporting step is repeated identically in 6 skills with only the metadata key list varying. A `team-reporting.md` fragment can provide the boilerplate framing, and each skill inlines its own specific keys. This is the clearest fragment candidate.

### Discovery 3: Sub-Agent Isolation Is Already Partially Inline

Every skill that spawns sub-agents already inlines the one-line callout:
> `> **Team Isolation**: Do NOT pass team_name...`

The reference to conventions.md is a supplement, not the primary guidance. The fragment would make this self-contained without the external link.

### Discovery 4: Escalation Has Two Tiers — Generic Steps + Skill-Specific Triggers

The generic escalation steps (1. move to Human Needed, 2. @mention comment, 3. STOP) are in conventions.md but not inlined. Each skill has its own trigger table that is unique. A fragment for the generic steps + each skill inlines its own trigger table is the right approach. Skills currently rely on the LLM reading conventions.md for the steps they can't see.

### Discovery 5: 8 Skills Need No Changes

ralph-hygiene, ralph-merge, ralph-pr, ralph-report, ralph-setup, ralph-status, ralph-team, and ralph-val already have zero conventions.md references and are self-contained.

### Discovery 6: quality-standards.md Is Also a Reference File

`plugin/ralph-hero/skills/shared/quality-standards.md` (53 lines) is referenced by ralph-plan, ralph-review, and ralph-research SKILL.md files. It's a smaller version of the same problem — content that should be injected via `!cat` but is instead referenced. Phase 4 should also cover quality-standards.md in the `!cat` injection pass.

### Discovery 7: Artifact Passthrough Prose Is Large and Already Inline

The Artifact Passthrough Protocol section in conventions.md is 65 lines with complex parsing rules. It's already fully inlined in the 3 consuming skills (ralph-plan, ralph-impl, ralph-review) as a detailed step. The fragment would essentially duplicate what's already inline. Better to remove the conventions.md reference in ralph-hero (which just points to it, not using it) and trust the inline prose in each skill.

---

## Potential Approaches

### Approach A: Full Fragment Library (6 fragments)

Create all 6 fragment candidates, refactor all 7 skills, delete conventions.md.

**Pros**: Clean separation; each fragment is self-contained; conventions.md fully eliminated
**Cons**: Most work; some fragments (link-formatting.md, 8 lines) may be too small to justify a file; risk of over-engineering

### Approach B: Essential Fragments Only (4 fragments)

Create only the 4 highest-value fragments: `artifact-discovery.md`, `error-handling.md`, `escalation-steps.md`, `team-reporting.md`. Handle sub-agent isolation and link formatting by inlining directly in each skill (they're short enough).

**Pros**: Pragmatic; focuses effort on prose that the LLM most needs inline; avoids micro-fragments
**Cons**: Slightly less clean; 2 "fragments" are just inlined prose

### Approach C: Inline Everything, No Fragments

Remove conventions.md references by inlining all shared prose directly in each skill. No fragment library.

**Pros**: Simplest; no new file types; each skill is truly self-contained
**Cons**: Duplication; future updates require touching all 7 skills; defeats the maintainability purpose of fragments

**Recommendation: Approach B** — 4 essential fragments, inline the small items. This balances LLM runtime completeness against file proliferation. The 4 fragments cover the 5-11 skill references each (highest duplication ratio).

---

## Recommended Next Steps (for Planning)

### 4.1 Design Fragment Library

Create `plugin/ralph-hero/skills/shared/fragments/` with 4 fragments:

1. **`artifact-discovery.md`** — The 7-step artifact discovery sequence (search comments → extract URL → convert to local path → glob fallback → self-heal). Used by: ralph-plan, ralph-impl, ralph-review, ralph-research. Currently each skill inlines partial steps with `per Artifact Comment Protocol in shared/conventions.md` supplements.

2. **`escalation-steps.md`** — The 3 generic escalation steps (move to Human Needed via __ESCALATE__, post @mention comment, STOP). Skills inject this then add their own trigger table. Currently skills say "See conventions.md for full escalation protocol" — LLM never sees the actual steps.

3. **`error-handling.md`** — The 3-item error handling list (tool call failures → read error + retry; state gate blocks → check current state; postcondition failures → satisfy requirement). 8 skills reference this. Currently some inline it, most just reference it.

4. **`team-reporting.md`** — The team worker result reporting instruction: call TaskUpdate with metadata + description, then check TaskList for more work. 6 skills use this. Each skill inlines its own metadata key list alongside the injected fragment.

Small items to inline directly (no fragment file):
- Link formatting: 3-row table, inline directly in each skill's Escalation/Link Formatting section
- Sub-agent isolation: 1-line callout already inline, remove conventions.md link

### 4.2 Refactor SKILL.md Files

For each of the 7 affected skills:
- Replace `See shared/conventions.md#X` references with `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/X.md`
- Inline link formatting table directly
- Remove conventions.md links from sub-agent isolation callouts
- Remove conventions.md link from Artifact Passthrough references (prose already inline)
- Verify skill is self-contained after injection (no dangling references)

### 4.3 Handle quality-standards.md

Replace `See shared/quality-standards.md` references in ralph-plan, ralph-review, and ralph-research with `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/quality-standards.md`. No need to fragment it — it's already one file.

### 4.4 Delete conventions.md

After verifying zero remaining references: `git rm plugin/ralph-hero/skills/shared/conventions.md`

### 4.5 Audit Enablement Checkboxes

Walk through all existing Phase 1 specs. Re-read each hook script, check if it enforces each requirement, flip `[ ]` to `[x]` if newly enforced. Phase 2-3 specs audit happens as part of their implementation.

---

## Risks

- **!cat injection syntax**: Claude Code plugin `!cat` injection happens at skill load time. The fragment files MUST exist before the skill is loaded. If fragments are added but referenced incorrectly (wrong path, wrong variable), the injection silently fails and the LLM sees a literal `!cat ...` string. Each fragment path must be tested.
- **Fragment self-containment**: Fragments must not reference other files. If a fragment says "see X" it defeats the purpose. Review each fragment for cross-file references.
- **Skill regression**: Replacing "See conventions.md" with `!cat` injections could change the prose the LLM sees at runtime (if conventions.md prose and the new fragment differ). Plan should include a prose accuracy check for each fragment.
- **quality-standards.md is referenced by non-skill files**: Confirm it's only referenced in SKILL.md files, not in hooks or agent definitions, before planning its `!cat` refactor.

---

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/shared/fragments/artifact-discovery.md` — new fragment
- `plugin/ralph-hero/skills/shared/fragments/escalation-steps.md` — new fragment
- `plugin/ralph-hero/skills/shared/fragments/error-handling.md` — new fragment
- `plugin/ralph-hero/skills/shared/fragments/team-reporting.md` — new fragment
- `plugin/ralph-hero/skills/ralph-hero/SKILL.md` — remove 3 conventions.md references
- `plugin/ralph-hero/skills/ralph-impl/SKILL.md` — remove 5 conventions.md references
- `plugin/ralph-hero/skills/ralph-plan/SKILL.md` — remove 5 conventions.md references
- `plugin/ralph-hero/skills/ralph-research/SKILL.md` — remove 3 conventions.md references
- `plugin/ralph-hero/skills/ralph-review/SKILL.md` — remove 6 conventions.md references
- `plugin/ralph-hero/skills/ralph-split/SKILL.md` — remove 3 conventions.md references
- `plugin/ralph-hero/skills/ralph-triage/SKILL.md` — remove 3 conventions.md references
- `plugin/ralph-hero/skills/shared/conventions.md` — DELETE after all references removed

### Will Read (Dependencies)
- `plugin/ralph-hero/skills/shared/conventions.md` — source for all fragment content
- `plugin/ralph-hero/skills/shared/quality-standards.md` — also needs !cat refactor
- `plugin/ralph-hero/skills/ralph-research/SKILL.md` — 3 conventions.md references
- `plugin/ralph-hero/skills/ralph-plan/SKILL.md` — 5 conventions.md references
- `plugin/ralph-hero/skills/ralph-impl/SKILL.md` — 5 conventions.md references
- `plugin/ralph-hero/skills/ralph-review/SKILL.md` — 6 conventions.md references
- `plugin/ralph-hero/skills/ralph-split/SKILL.md` — 3 conventions.md references
- `plugin/ralph-hero/skills/ralph-triage/SKILL.md` — 3 conventions.md references
- `plugin/ralph-hero/skills/ralph-hero/SKILL.md` — 3 conventions.md references
- `specs/artifact-metadata.md` — Phase 1 spec for enablement audit
- `specs/skill-io-contracts.md` — Phase 1 spec for enablement audit
- `specs/skill-permissions.md` — Phase 1 spec for enablement audit
- `specs/agent-permissions.md` — Phase 1 spec for enablement audit
