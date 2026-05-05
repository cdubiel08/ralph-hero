---
date: 2026-05-04
status: draft
type: plan
github_issue: 576
github_issues: [576, 840, 841, 842, 843]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/576
  - https://github.com/cdubiel08/ralph-hero/issues/840
  - https://github.com/cdubiel08/ralph-hero/issues/841
  - https://github.com/cdubiel08/ralph-hero/issues/842
  - https://github.com/cdubiel08/ralph-hero/issues/843
primary_issue: 576
tags: [shared-fragments, skill-templates, dry, refactor, maintenance]
---

# Extract Shared Content to Fragments — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-01-GH-0471-shared-fragments-and-skill-prompt-refactor]]
- builds_on:: [[2026-03-09-GH-0550-knowledge-metadata-fragment]]

## Overview

5 issues for atomic implementation in a single PR (parent #576 + 4 atomic children):

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-840 | Extract Link Formatting fragment — replace duplicates in 9 skills | XS |
| 2 | GH-841 | Extract Artifact Comment Protocol discovery fragment — consolidate plan/impl/review | S |
| 3 | GH-842 | Extract Task Template Per Phase fragment — share team usage | XS |
| 4 | GH-843 | Extract Stream Detection fragment — share between hero and team | XS |
| 5 | GH-576 | Verify all 4 fragments, remove duplication, parent close | XS |

**Why grouped**: All 4 children operate on the same fragment infrastructure (`plugin/ralph-hero/skills/shared/fragments/`) and produce parallel mechanical refactors of skill SKILL.md files. The parent (#576) is the umbrella verification phase. Extracting them as one PR avoids partial merges where some skills reference fragments that don't yet exist alongside skills that still inline content. All 4 children are independent (different fragment files + non-overlapping consumer skill sections), so phase order is by complexity (XS → S → XS → XS) rather than data dependency. The final phase only verifies the result.

## Shared Constraints

These constraints apply to ALL phases and were established by the GH-471 fragment infrastructure work:

1. **Fragment include syntax**: Every consumer skill must reference the fragment via `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/<name>.md` (matches existing `escalation-steps.md`, `error-handling.md`, `knowledge-metadata.md` includes — see [skills/ralph-research/SKILL.md:66](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-research/SKILL.md#L66) for an existing example).
2. **Fragment self-containment**: Fragment files must NOT reference other files (no "see X.md") — they are inlined into the skill at load time, so cross-references defeat the purpose.
3. **!cat failure mode is silent**: If the path is wrong or the file is missing, the LLM sees a literal `!cat ...` string at runtime instead of inlined content. Each new include must be visually verified after change.
4. **Behavioral equivalence**: Fragment content must be byte-for-byte equivalent to the canonical inline block currently used. No prose changes during the extraction itself — those would be a separate refactor.
5. **No new tooling required**: The plugin has no separate "build" step for skill markdown files. The MCP server build (`npm run build` in `plugin/ralph-hero/mcp-server/`) is irrelevant to this work — fragment files are read at skill-load time by Claude Code itself.
6. **Heading parity**: When replacing an inline `## Link Formatting` block with a `!cat` include, keep the `## Link Formatting` heading in the SKILL.md and put only the body content (table + paragraphs) in the fragment file. Same pattern as `## Escalation Protocol` heading staying in skills with `!cat .../escalation-steps.md` underneath.
7. **Verification grep query**: `grep -rn "Single-repo (default)" plugin/ralph-hero/skills/ -l` must return exactly one match (the new fragment file) after Phase 1 completes. Equivalent grep checks apply to phases 2–4.

## Current State Analysis

### Where each duplicated block currently lives

**Link Formatting** (Phase 1 / GH-840) — identical block (table + cross-repo paragraph) appears at:
- [skills/finish/SKILL.md:176](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/finish/SKILL.md#L176)
- [skills/hero/SKILL.md:520](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/hero/SKILL.md#L520)
- [skills/ralph-impl/SKILL.md:479](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-impl/SKILL.md#L479)
- [skills/ralph-merge/SKILL.md:289](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-merge/SKILL.md#L289)
- [skills/ralph-plan/SKILL.md:616](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-plan/SKILL.md#L616)
- [skills/ralph-research/SKILL.md:468](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-research/SKILL.md#L468)
- [skills/ralph-review/SKILL.md:482](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-review/SKILL.md#L482)
- [skills/ralph-split/SKILL.md:332](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-split/SKILL.md#L332)
- [skills/ralph-triage/SKILL.md:324](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-triage/SKILL.md#L324)

GH-840's body lists 10 skills including ralph-pr. **Verification deviation** — ralph-pr has `### Link Formatting in PR Bodies` at [skills/ralph-pr/SKILL.md:104](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-pr/SKILL.md#L104) which is a PR-body-specific scope (different content), NOT the canonical `## Link Formatting` table. This must be EXCLUDED from Phase 1 and called out in the verification step.

**Artifact Comment Protocol discovery** (Phase 2 / GH-841) — present in plan/impl/review/val skills with subtle skill-specific differences. The current state already has two partially-extracted files:
- [skills/shared/artifact-comment-protocol.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/artifact-comment-protocol.md) — long-form reference doc (97 lines, headers + format examples + plan discovery chain)
- [skills/shared/fragments/artifact-discovery.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/fragments/artifact-discovery.md) — short fragment-style doc (47 lines, discovery steps + glob fallback + naming)

Neither file is currently `!cat`-included by any skill. They are reference docs only.

Inline discovery blocks live in:
- [skills/plan/SKILL.md:86, 385, 398, 465, 504](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/plan/SKILL.md) — interactive plan
- [skills/ralph-plan/SKILL.md:162-184](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-plan/SKILL.md#L162-L184) — autonomous plan (consumer side)
- [skills/ralph-plan-epic/SKILL.md:109-113](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md#L109-L113)
- [skills/impl/SKILL.md:39-55](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/impl/SKILL.md#L39-L55)
- [skills/ralph-impl/SKILL.md:106-133](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-impl/SKILL.md#L106-L133)
- [skills/ralph-review/SKILL.md:108-136](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-review/SKILL.md#L108-L136)
- [skills/ralph-val/SKILL.md:58-69](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-val/SKILL.md#L58-L69)
- [skills/bridge-artifact/SKILL.md:99](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/bridge-artifact/SKILL.md#L99) — producer-side reference only

**Task Template Per Phase** (Phase 3 / GH-842) — only exists in [skills/team/SKILL.md:111-126](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/team/SKILL.md#L111-L126). **Verification deviation** — GH-842's body says "share between hero and team" but hero/SKILL.md does NOT contain the `Phase | Subject Pattern | Owner | Command | activeForm` table. Hero only has phase-specific dispatch logic (no template table). Plan handles this by having Phase 3 only update team/SKILL.md and explicitly noting hero is out-of-scope.

**Stream Detection** (Phase 4 / GH-843) — appears in:
- [skills/team/SKILL.md:101-105, 166-197, 209-216](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/team/SKILL.md#L101-L216) — full procedural detail
- [skills/hero/SKILL.md:250-260](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/hero/SKILL.md#L250-L260) — Step 2.5 (shorter, hero-specific framing)

The hero version is NOT byte-identical to team's. Hero's Step 2.5 is an 11-line section ("Stream Detection (Groups >= 3) — Fallback") — different framing, different scope (group size threshold). Phase 4 plan handles this by extracting the **shared procedural core** to the fragment, keeping hero's framing inline above the include.

### Existing fragment infrastructure pattern

The skills/shared/fragments/ directory has 7 existing fragments. The integration pattern for NEW fragments:

```markdown
## <Section Name>

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/<name>.md
```

The skill keeps the `## Heading` for IDE/anchor navigation; the `!cat` line replaces the body. This matches existing usage at [skills/ralph-impl/SKILL.md:459](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-impl/SKILL.md#L459) (escalation-steps.md include).

Plugin path resolution: `${CLAUDE_PLUGIN_ROOT}` resolves to `plugin/ralph-hero/` at skill load time. Fragment paths are relative to that root.

## Desired End State

### Verification

- [ ] **GH-840**: `plugin/ralph-hero/skills/shared/fragments/link-formatting.md` exists with single-repo + cross-repo formats. Each of the 9 in-scope skills has `## Link Formatting` heading followed immediately by `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/link-formatting.md`. ralph-pr's `### Link Formatting in PR Bodies` is unchanged (out of scope, different content).
- [ ] **GH-841**: A consolidated artifact-comment-protocol fragment exists in `plugin/ralph-hero/skills/shared/fragments/`. ralph-plan, ralph-impl, ralph-review use the include for consumer-side discovery. ralph-val and bridge-artifact remain unchanged (different scope — val finds plans differently, bridge-artifact is producer-side). The duplication between existing `shared/artifact-comment-protocol.md` and `shared/fragments/artifact-discovery.md` is resolved by deletion of the duplicate or clear delineation.
- [ ] **GH-842**: `plugin/ralph-hero/skills/shared/fragments/task-template.md` exists with the per-phase table + required metadata footer. team/SKILL.md uses the include. hero is out of scope (no equivalent table to replace).
- [ ] **GH-843**: `plugin/ralph-hero/skills/shared/fragments/stream-detection.md` exists covering procedural shared core. team/SKILL.md and hero/SKILL.md both reference the fragment with their respective framing prose intact above each include.
- [ ] **Parent #576**: After all 4 children land, no skill SKILL.md contains the **inline** Link Formatting table OR the inline procedural artifact discovery steps OR the inline task template table OR the inline stream detection procedural body. Behavioral equivalence verified by manual diff inspection.

## What We're NOT Doing

- Not modifying `skills/ralph-pr/SKILL.md` "Link Formatting in PR Bodies" (different scope — PR-body-specific, not the canonical reference table).
- Not modifying `skills/hero/SKILL.md` task template (no equivalent table exists in hero).
- Not modifying `skills/ralph-val/SKILL.md` artifact discovery (val uses a different discovery shape: looks for plan paths in comments, not section headers — would require its own fragment or stay inline).
- Not modifying `skills/bridge-artifact/SKILL.md` artifact discovery (producer-side only — posts comments, doesn't read them).
- Not changing prose content of any block (this is a pure mechanical extraction).
- Not deleting `skills/shared/conventions.md` (already deleted per GH-471 — verified absent).
- Not running `npm run build` or similar — skill markdown is read at runtime by Claude Code, not compiled.
- Not authoring tests for fragment includes — verification is grep + manual diff (the existing skill test infrastructure under `hooks/scripts/__tests__/` validates hooks, not skill content).

## Implementation Approach

The 4 child issues operate on different fragment files and non-overlapping skill sections, so they could in principle be implemented in parallel. We sequence them as Phase 1 → 2 → 3 → 4 → 5 to allow each phase to be reviewed independently and to keep PR diffs reviewable. Each implementation phase is purely mechanical extraction with byte-equivalent content. The final phase (#576) is the verification rollup.

**Phase dependency annotations**: All 4 implementation phases (1–4) are independent (`depends_on: null`). Phase 5 (verification) depends on all four. The hero/team orchestrator may treat 1–4 as parallel-capable.

---

## Phase 1: Extract Link Formatting fragment (GH-840)

- **depends_on**: null

### Overview

Create `skills/shared/fragments/link-formatting.md` with the canonical Link Formatting block, then replace the inline table + cross-repo paragraph in 9 SKILL.md files with a `!cat` include. Keep the `## Link Formatting` heading in each skill.

### Tasks

#### Task 1.1: Create the link-formatting.md fragment file
- **files**: `plugin/ralph-hero/skills/shared/fragments/link-formatting.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at exact path `plugin/ralph-hero/skills/shared/fragments/link-formatting.md`
  - [ ] Content matches the canonical block from [skills/ralph-plan/SKILL.md:618-629](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-plan/SKILL.md#L618-L629) — does NOT include the `## Link Formatting` heading itself (heading stays in each skill)
  - [ ] Includes both the `**Single-repo (default):**` table (3 rows: File only, With line, Line range) and the `**Cross-repo:**` paragraph + cross-repo guidance sentence
  - [ ] Self-contained: no references to other files
  - [ ] No trailing whitespace; ends with single newline

#### Task 1.2: Replace inline blocks in 9 skills with `!cat` include
- **files**: `plugin/ralph-hero/skills/finish/SKILL.md` (modify), `plugin/ralph-hero/skills/hero/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-impl/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-merge/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-plan/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-research/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-review/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-split/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-triage/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Each of the 9 files has the `## Link Formatting` heading retained
  - [ ] Immediately under each heading, the body is exactly: `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/link-formatting.md`
  - [ ] The original inline body (table + cross-repo paragraph) is fully removed
  - [ ] `skills/ralph-pr/SKILL.md` is NOT modified — its `### Link Formatting in PR Bodies` is a different scope and stays inline
  - [ ] One blank line above and below the `!cat` line for readability

#### Task 1.3: Verify Phase 1 mechanical correctness
- **files**: (read-only verification — `plugin/ralph-hero/skills/`)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] `grep -rn "Single-repo (default)" plugin/ralph-hero/skills/` returns exactly 1 match (the new fragment file)
  - [ ] `grep -rln "## Link Formatting" plugin/ralph-hero/skills/` returns exactly 9 matches (the 9 modified skills)
  - [ ] `grep -rln "skills/shared/fragments/link-formatting.md" plugin/ralph-hero/skills/` returns 9 matches
  - [ ] `grep -rn "Link Formatting in PR Bodies" plugin/ralph-hero/skills/` still returns 1 match in ralph-pr (untouched)

### Phase Success Criteria

#### Automated Verification:
- [x] All grep checks in Task 1.3 pass with exact match counts
- [x] No syntax errors introduced (skill markdown has no compiler — relies on Claude Code's loader; visual inspection of one rendered skill is sufficient)

#### Manual Verification:
- [ ] Open one modified skill (e.g., ralph-plan) and confirm the `## Link Formatting` section reads cleanly as `## Link Formatting` followed by the `!cat` directive
- [ ] Diff one modified skill against pre-change content: only the body of the Link Formatting section should differ; everything else byte-equivalent

**Creates for next phase**: A working fragment-include reference pattern that Phases 2–4 will copy.

---

## Phase 2: Extract Artifact Comment Protocol discovery fragment (GH-841)

- **depends_on**: null

### Overview

Resolve duplication between existing `skills/shared/artifact-comment-protocol.md` and `skills/shared/fragments/artifact-discovery.md`, decide on a single canonical artifact-comment-protocol fragment, and have the 3 high-overlap consumer skills (ralph-plan, ralph-impl, ralph-review) `!cat`-include it. Skills with skill-specific discovery shapes (ralph-val, bridge-artifact, plan-epic) stay inline.

### Tasks

#### Task 2.1: Decide canonical fragment location and consolidate
- **files**: `plugin/ralph-hero/skills/shared/fragments/artifact-discovery.md` (modify or keep), `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md` (delete or keep, see decision below)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [x] Canonical fragment is `plugin/ralph-hero/skills/shared/fragments/artifact-discovery.md` (already exists; this is the one consumer skills will `!cat`)
  - [x] Decide: does the long-form `shared/artifact-comment-protocol.md` reference doc add value beyond the fragment? If yes, keep it but add a header note pointing readers to the fragment for the canonical discovery sequence. If no, delete it. Document the decision in the commit message
  - [x] Verify the existing `shared/fragments/artifact-discovery.md` content covers the discovery steps used by ralph-plan, ralph-impl, ralph-review. If gaps exist (e.g., `## Plan Reference` handling for parent-planned atomics — present in ralph-impl but not the fragment), extend the fragment to cover them generically
  - [x] Fragment must remain self-contained (no cross-file references)

#### Task 2.2: Replace ralph-plan inline discovery with fragment include
- **files**: `plugin/ralph-hero/skills/ralph-plan/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [2.1]
- **acceptance**:
  - [x] The discovery sequence inside Step 3 ("Gather Group Context", lines ~159-184) is replaced with `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/artifact-discovery.md`
  - [x] The skill-specific glue prose (knowledge graph shortcut, --research-doc flag handling, "If neither found: STOP with..." escalation) STAYS inline above/below the include — only the generic 7-step discovery is fragmented
  - [x] Specific research doc header `## Research Document` references stay in the inline glue (the fragment is generic; the consumer specifies which header to look for)

#### Task 2.3: Replace ralph-impl inline discovery with fragment include
- **files**: `plugin/ralph-hero/skills/ralph-impl/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [2.1]
- **acceptance**:
  - [x] The discovery sequence in Step 1 ("Find linked plan document", lines ~106-133) replaces the generic 7-step body with the `!cat` include
  - [x] The `## Plan Reference` parent-plan-handling step stays inline (it's skill-specific to atomic children with parent plans)
  - [x] Group/stream fallback paths stay inline if they are not in the fragment (verify in Task 2.1 whether to extend fragment or keep inline)

#### Task 2.4: Replace ralph-review inline discovery with fragment include
- **files**: `plugin/ralph-hero/skills/ralph-review/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [2.1]
- **acceptance**:
  - [x] The discovery sequence in Step 3 ("Validate Plan Exists", lines ~108-136) replaces the generic 7-step body with the `!cat` include
  - [x] The skill-specific intro ("Find the plan using the Artifact Comment Protocol:") stays inline — only the numbered procedural body becomes the fragment include

#### Task 2.5: Verify Phase 2 mechanical correctness
- **files**: (read-only verification)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.2, 2.3, 2.4]
- **acceptance**:
  - [x] `grep -rln "skills/shared/fragments/artifact-discovery.md" plugin/ralph-hero/skills/` returns 3 matches (ralph-plan, ralph-impl, ralph-review)
  - [x] `grep -rln "Convert GitHub URL to local path: strip" plugin/ralph-hero/skills/` returns 1 match (the fragment file) — confirms the inline procedural prose is gone from consumer skills
  - [x] ralph-val, bridge-artifact, plan-epic, plan, impl SKILL.md files are unchanged (they have skill-specific discovery shapes — their inline prose stays)

### Phase Success Criteria

#### Automated Verification:
- [x] Grep checks in Task 2.5 pass with exact counts
- [x] No occurrence of `## See artifact-comment-protocol.md` or similar dangling references remains

#### Manual Verification:
- [x] Read ralph-impl Step 1 end-to-end and confirm the discovery flow still makes sense: knowledge shortcut → --plan-doc shortcut → fragment-included generic discovery → Plan Reference handling → fallback chain → STOP
- [x] Diff one modified skill: only the generic discovery prose is removed; skill-specific glue intact

**Creates for next phase**: Confidence that fragments can include partial procedural sections surrounded by skill-specific prose without breaking the !cat injection.

---

## Phase 3: Extract Task Template Per Phase fragment (GH-842)

- **depends_on**: null

### Overview

Extract the 8-row task template table (Triage/Research/Plan/Review/Implement/Validate/Create PR/Merge) plus required metadata list from team/SKILL.md into a fragment. Hero/SKILL.md is out of scope — verified during research that it has no equivalent table.

### Tasks

#### Task 3.1: Create the task-template.md fragment file
- **files**: `plugin/ralph-hero/skills/shared/fragments/task-template.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] File exists at `plugin/ralph-hero/skills/shared/fragments/task-template.md`
  - [x] Content captures the table (8 rows: Triage, Research, Plan, Review, Implement, Validate, Create PR, Merge) with columns: Phase, Subject Pattern, Owner, Command, activeForm — matching [skills/team/SKILL.md:115-124](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/team/SKILL.md#L115-L124)
  - [x] Includes the `**Required metadata for every task**` footer line about `issue_number`, `issue_url`, `command`, `phase`, `estimate`, plus group fields
  - [x] Includes the intro sentence: "Each task must satisfy `task-schema-validator.sh`. Use these templates:"
  - [x] Does NOT include the `### Task Template Per Phase` heading (that stays in team SKILL.md)
  - [x] Self-contained

#### Task 3.2: Replace team/SKILL.md inline table with fragment include
- **files**: `plugin/ralph-hero/skills/team/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.1]
- **acceptance**:
  - [x] The `### Task Template Per Phase` heading (line ~111) is retained
  - [x] The body (intro sentence + table + required metadata line) is replaced with `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/task-template.md`
  - [x] Surrounding sections ("Build the Task List" before, "Full Graph Example" after) are unchanged

#### Task 3.3: Document hero scope deviation
- **files**: `plugin/ralph-hero/skills/shared/fragments/task-template.md` (modify if needed for clarity)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.2]
- **acceptance**:
  - [x] If a comment is needed inside the fragment to clarify it's currently used only by team skill (since hero has no equivalent table), include it as a markdown HTML comment `<!-- Used by: team/SKILL.md -->` at the top
  - [x] Otherwise, document the team-only scope in the commit message

#### Task 3.4: Verify Phase 3 mechanical correctness
- **files**: (read-only)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.2]
- **acceptance**:
  - [x] `grep -rln "skills/shared/fragments/task-template.md" plugin/ralph-hero/skills/` returns exactly 1 match (team/SKILL.md)
  - [x] `grep -rn "| Phase | Subject Pattern | Owner | Command | activeForm |" plugin/ralph-hero/skills/` returns exactly 1 match (the fragment file)
  - [x] hero/SKILL.md has no `Subject Pattern | Owner | Command | activeForm` table heading (confirms hero out-of-scope decision)

### Phase Success Criteria

#### Automated Verification:
- [x] Grep checks in Task 3.4 pass

#### Manual Verification:
- [x] Open team/SKILL.md, scroll to "Task Template Per Phase" section, confirm `!cat` directive replaces the inline table cleanly
- [x] Open the new fragment file, confirm it would render as a complete table when inlined

**Creates for next phase**: None (independent of Phase 4).

---

## Phase 4: Extract Stream Detection fragment (GH-843)

- **depends_on**: null

### Overview

The stream detection content in team/SKILL.md is fuller than hero's Step 2.5. Extract the **shared procedural core** (the 7-step "Stream Detection Before Implementation Tasks" block plus the timing/refinement guidance) to a fragment. Both team and hero `!cat`-include it; each skill's surrounding framing prose (different intros/scopes) stays inline.

### Tasks

#### Task 4.1: Identify the canonical shared core
- **files**: (read-only research) — `plugin/ralph-hero/skills/team/SKILL.md`, `plugin/ralph-hero/skills/hero/SKILL.md`
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Identify the byte-equivalent procedural shared content. The most likely candidate is team's "Stream Detection Before Implementation Tasks — Fallback" 7-step block ([team/SKILL.md:166-191](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/team/SKILL.md#L166-L191)) — it captures: extract file paths from research, call detect_stream_positions, read suggestedRoster.builder, spawn additional builders, create tasks with stream tags, single-stream fallback, overflow assignment
  - [ ] Hero's Step 2.5 ([hero/SKILL.md:250-260](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/hero/SKILL.md#L250-L260)) is shorter and has different framing ("Groups >= 3"). Confirm: the 3-step body of hero's Step 2.5 (detect → restructure → single-stream fallback) IS a strict subset of team's 7-step block. Therefore the fragment should contain the team-shaped 7-step procedure; hero will `!cat` it and the framing intro ("Step 2.5: Stream Detection (Groups >= 3) — Fallback" + the note about it being a fallback) stays inline above the include
  - [ ] Document the decision in a planning note inside the fragment (HTML comment) or in the commit message

#### Task 4.2: Create the stream-detection.md fragment file
- **files**: `plugin/ralph-hero/skills/shared/fragments/stream-detection.md` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [4.1]
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/skills/shared/fragments/stream-detection.md`
  - [ ] Content is the 7-step "Stream Detection Before Implementation Tasks" procedural body from team/SKILL.md, plus the "Stream Detection Timing" subsection ([team/SKILL.md:193-197](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/team/SKILL.md#L193-L197)) and "Stream Detection Refinement" subsection ([team/SKILL.md:209-216](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/team/SKILL.md#L209-L216))
  - [ ] Does NOT include the `### Stream Detection Before Implementation Tasks — Fallback` heading itself (that stays in each consumer skill)
  - [ ] Self-contained, no cross-file references

#### Task 4.3: Replace team/SKILL.md inline blocks with includes
- **files**: `plugin/ralph-hero/skills/team/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [4.2]
- **acceptance**:
  - [ ] The body of "Stream Detection Before Implementation Tasks — Fallback" is replaced with the `!cat` include
  - [ ] Subsections "Stream Detection Timing" and "Stream Detection Refinement" — keep their headings but replace bodies with the same `!cat` include (consolidated into one fragment) OR keep distinct subsections inline if the fragment is structured as a single block. Decide in Task 4.1 whether the fragment is one combined block or three subsections; ensure team/SKILL.md result reads coherently
  - [ ] Surrounding "Implementation Task Ordering (Dependency-Graph-Aware)" section is unchanged
  - [ ] Stream-related framing in the worker-roster section ([team/SKILL.md:101-105](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/team/SKILL.md#L101-L105) — "Builder scaling at implementation phase" + "Stream-scoped builder prompts") stays inline (it's framing, not procedural detection)

#### Task 4.4: Replace hero/SKILL.md Step 2.5 body with include
- **files**: `plugin/ralph-hero/skills/hero/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [4.2]
- **acceptance**:
  - [ ] Step 2.5 heading retained (`### Step 2.5: Stream Detection (Groups >= 3) — Fallback`)
  - [ ] Hero's framing note ("Stream detection is a fallback for plans without explicit `depends_on` annotations...") stays inline above the include
  - [ ] The 3-step body (detect → restructure → single-stream fallback) is replaced with `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/stream-detection.md`
  - [ ] Surrounding Step 3 (Execution Loop) is unchanged

#### Task 4.5: Verify Phase 4 mechanical correctness
- **files**: (read-only)
- **tdd**: false
- **complexity**: low
- **depends_on**: [4.3, 4.4]
- **acceptance**:
  - [ ] `grep -rln "skills/shared/fragments/stream-detection.md" plugin/ralph-hero/skills/` returns at least 2 matches (team, hero)
  - [ ] `grep -rn "Extract \"Will Modify\" file paths" plugin/ralph-hero/skills/` returns exactly 1 match (the fragment) — confirms the procedural body is no longer inline in team
  - [ ] Stream-tagging behavioral logic (the `[stream-N]` tag pattern, `detect_stream_positions` call site) is unchanged: `grep -rln "detect_stream_positions" plugin/ralph-hero/skills/` should still return both team and hero plus the fragment

### Phase Success Criteria

#### Automated Verification:
- [ ] Grep checks in Task 4.5 pass

#### Manual Verification:
- [ ] Open team/SKILL.md, read the "Build the Task List" → "Stream Detection ..." section end-to-end. Confirm that with the `!cat` substitutions visualized, the flow still makes sense (intro framing → procedural detail → timing → refinement)
- [ ] Open hero/SKILL.md, read Step 2.5 with the include visualized. Confirm hero's "Groups >= 3" framing reads coherently before the included procedural body

**Creates for next phase**: All 4 fragments are now in place; Phase 5 verifies the rollup.

---

## Phase 5: Verify and close parent (GH-576)

- **depends_on**: [phase-1, phase-2, phase-3, phase-4]

### Overview

Run the cumulative verification grep suite, manually inspect a sample skill from each consumer set to confirm `!cat` injection works, and ensure no inline duplication remains for the four extracted blocks. No code changes in this phase — this is a hygiene/rollup pass.

### Tasks

#### Task 5.1: Cumulative grep verification
- **files**: (read-only) — `plugin/ralph-hero/skills/`
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `grep -rn "Single-repo (default)" plugin/ralph-hero/skills/` → 1 match (link-formatting.md fragment)
  - [ ] `grep -rn "| Phase | Subject Pattern | Owner | Command | activeForm |" plugin/ralph-hero/skills/` → 1 match (task-template.md fragment)
  - [ ] `grep -rn "Extract \"Will Modify\" file paths" plugin/ralph-hero/skills/` → 1 match (stream-detection.md fragment)
  - [ ] `grep -rn "Convert GitHub URL to local path: strip" plugin/ralph-hero/skills/` → 1 match (artifact-discovery.md fragment)
  - [ ] `ls plugin/ralph-hero/skills/shared/fragments/` shows at least: artifact-discovery.md, ask-user-question.md, error-handling.md, escalation-steps.md, knowledge-metadata.md, link-formatting.md, skill-vs-agent-dispatch.md, stream-detection.md, task-template.md, team-reporting.md (10 files; 3 new from this group)

#### Task 5.2: Smoke test fragment !cat resolution
- **files**: (read-only verification of fragment content)
- **tdd**: false
- **complexity**: low
- **depends_on**: [5.1]
- **acceptance**:
  - [ ] Each new fragment file (link-formatting.md, task-template.md, stream-detection.md) is non-empty and parseable as standalone markdown
  - [ ] No fragment file references another file (no cross-file `see X.md`)
  - [ ] No fragment file starts with the `## Heading` of the section it's included under (heading stays in the consumer skill)

#### Task 5.3: Drift check against original content
- **files**: (read-only diff inspection)
- **tdd**: false
- **complexity**: low
- **depends_on**: [5.1]
- **acceptance**:
  - [ ] For one representative skill per phase (e.g., ralph-plan for Phase 1, ralph-impl for Phase 2, team for Phases 3+4), confirm via local diff (against the previous main commit) that ONLY the targeted blocks changed — no incidental edits elsewhere in the file
  - [ ] Confirm the change adds either a `!cat` line or fragment file content; nowhere does prose differ from the canonical pre-extraction text (byte equivalence rule from Shared Constraints #4)

### Phase Success Criteria

#### Automated Verification:
- [ ] All 4 grep checks in Task 5.1 return exactly 1 match each (the fragment file)
- [ ] `ls plugin/ralph-hero/skills/shared/fragments/` shows the 3 expected new files

#### Manual Verification:
- [ ] Visually inspect ralph-plan, ralph-impl, team SKILL.md sections that were modified — confirm clean `!cat` directives directly under retained `## ` headings, no orphaned text fragments

---

## Integration Testing

- [ ] Load one of the modified skills via Claude Code's skill loader (e.g., trigger `/ralph-hero:ralph-plan` in a test session) and confirm the inlined fragment content appears at runtime — i.e., the `!cat` directive resolved successfully and the LLM sees the prose, not the literal `!cat` line. (This is the only way to truly validate the load-time injection; deferred to actual usage during PR review.)
- [ ] Confirm no skill regression: running each modified skill (ralph-plan, ralph-impl, ralph-review, ralph-research, ralph-merge, ralph-split, ralph-triage, finish, hero, team) starts without error and the consumer can still execute its primary action.

## References

- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/576
- Atomic children: 840, 841, 842, 843
- Prior research: [thoughts/shared/research/2026-03-01-GH-0471-shared-fragments-and-skill-prompt-refactor.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0471-shared-fragments-and-skill-prompt-refactor.md)
- Existing fragments directory: [plugin/ralph-hero/skills/shared/fragments/](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/fragments/)
- Existing fragment include example: [skills/ralph-impl/SKILL.md:459](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-impl/SKILL.md#L459)
