---
date: 2026-03-01
status: draft
github_issues: [469]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/469
primary_issue: 469
---

# Lifecycle and Document Specs — Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-469 | Ralph Protocol Specs Phase 2: Lifecycle and document specs | S |

## Current State Analysis

Phase 1 (GH-468) created the `specs/` directory with README.md (template, conventions, index), plus 4 core specs: artifact-metadata.md, skill-io-contracts.md, skill-permissions.md, agent-permissions.md. The README already has placeholder entries for Phase 2 specs (issue-lifecycle.md, document-protocols.md) in the Spec Index.

The research document (`thoughts/shared/research/2026-03-01-GH-0469-lifecycle-and-document-specs.md`) fully extracted:
- Complete 11-state machine from `ralph-state-machine.json`
- All valid transitions, lock acquisition/release tables
- Semantic intent resolution per command
- WORKFLOW_STATE_TO_STATUS mapping from `workflow-states.ts`
- State ownership by skill (which skills produce which states)
- Document protocol requirements for research, plan, and review artifacts
- Enablement status for all enforcement hooks (including orphaned scripts)

Existing Phase 1 specs already reference the Phase 2 specs in their Cross-References sections. `artifact-metadata.md` references `document-protocols.md` for "detailed content requirements per document type." `skill-io-contracts.md` references `issue-lifecycle.md` for "full state machine details."

## Desired End State

### Verification
- [ ] `specs/issue-lifecycle.md` exists and follows the spec template (Purpose, Definitions, Requirements with Enablement table)
- [ ] State machine contains all 11 workflow states with descriptions
- [ ] Every state has documented valid inbound and outbound transitions
- [ ] State ownership table maps each transition to the responsible skill
- [ ] Lock acquisition/release table documents all 3 lock states
- [ ] Semantic intent resolution table covers all 5 intents across all commands
- [ ] Status sync mapping table (workflow state -> GitHub Status field) is explicit
- [ ] Close/reopen semantics documented (Done/Canceled terminal, Human Needed escape)
- [ ] `specs/document-protocols.md` exists and follows the spec template
- [ ] Research document section covers required sections, frontmatter, quality criteria
- [ ] Plan document section covers required sections, frontmatter (single/group/stream), phase structure
- [ ] Review/critique document section covers required sections, verdict values, AUTO vs INTERACTIVE
- [ ] All enablement checkboxes accurately reflect current hook enforcement
- [ ] Cross-references link back to Phase 1 specs (artifact-metadata.md, skill-io-contracts.md)

## What We're NOT Doing
- No new hook enforcement (just documenting what exists)
- No modifications to existing specs from Phase 1
- No task-schema.md or team-schema.md (Phase 3, GH-470)
- No fragment library or skill prompt refactor (Phase 4, GH-471)
- No changes to the state machine itself (just specifying what IS)

## Implementation Approach

Two spec files created sequentially. `issue-lifecycle.md` first since `document-protocols.md` cross-references it. Both follow the exact template from `specs/README.md`: Purpose, Definitions, Requirements (with Enablement tables using `[x]`/`[ ]`).

---

## Phase 1: Create `specs/issue-lifecycle.md`
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/469 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0469-lifecycle-and-document-specs.md

### Changes Required

#### 1. Create `specs/issue-lifecycle.md`
**File**: `specs/issue-lifecycle.md` (new)
**Changes**: Full spec following the template:

**Purpose**: One sentence defining scope — governs the issue state machine, transitions, lock protocol, and Status sync.

**Definitions**: Key terms — workflow state, lock state, terminal state, semantic intent, Status sync, parent gate state.

**Requirements sections**:

1. **Workflow States** — Table of all 11 states with description, lock/terminal/human-required flags. Source: `ralph-state-machine.json`.

2. **Valid Transitions** — Full from/to table (inbound and outbound per state). Source: `allowed_transitions` in state machine JSON.

3. **State Ownership by Skill** — Which skills can produce which states via `produces_for_commands`. Which skills require which input states via `required_by_commands`.

4. **Lock State Protocol** — Table with 3 lock states (Research in Progress, Plan in Progress, In Progress), acquired-from, released-to on success/failure/escalation. Source: `lock_transitions` in command contracts.

5. **Semantic Intents** — Resolution table: intent x command matrix mapping to concrete states. Source: `semantic_states` in state machine JSON. Include the 5 intents: __LOCK__, __COMPLETE__, __ESCALATE__, __CLOSE__, __CANCEL__.

6. **Status Sync** — Mapping table (11 workflow states -> 3 Status field values). One-way, best-effort nature documented. Source: `WORKFLOW_STATE_TO_STATUS` in `workflow-states.ts`.

7. **Issue Creation** — Required fields, initial state assignment. Source: command contracts for triage/split.

8. **Close/Reopen Semantics** — Done and Canceled are terminal (no outbound transitions). Human Needed is NOT terminal — can return to Backlog, Research Needed, Ready for Plan, In Progress.

9. **Parent Gate States** — Ready for Plan, In Review, Done trigger parent advancement checks. Source: `PARENT_GATE_STATES` in `workflow-states.ts`.

10. **State Ordering** — Canonical pipeline order (left-to-right). Source: `STATE_ORDER` in `workflow-states.ts`.

**Enablement**: Each requirement row gets `[x] hook-name.sh` or `[ ] not enforced`. Key enforced items:
- `[x]` per-command state gates (triage-state-gate.sh, research-state-gate.sh, etc.)
- `[x]` lock acquisition/release (auto-state.sh)
- `[x]` Status sync (implemented in MCP server, not hook — note as `[x] workflow-states.ts`)
- `[ ]` issue creation field validation (not enforced by hooks)

**Cross-References**: Link to skill-io-contracts.md (per-skill preconditions), agent-permissions.md (which agents run which skills).

### Success Criteria
- [ ] Automated: `test -f specs/issue-lifecycle.md && grep -q "## Purpose" specs/issue-lifecycle.md && grep -q "## Requirements" specs/issue-lifecycle.md && grep -q "## Cross-References" specs/issue-lifecycle.md`
- [ ] Manual: All 11 workflow states present in state table
- [ ] Manual: Transition table has entries for all non-terminal states
- [ ] Manual: Enablement checkboxes match actual hook registration

**Creates for next phase**: Foundation for document-protocols.md cross-references.

---

## Phase 2: Create `specs/document-protocols.md`
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/469 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0469-lifecycle-and-document-specs.md

### Changes Required

#### 1. Create `specs/document-protocols.md`
**File**: `specs/document-protocols.md` (new)
**Changes**: Full spec following the template:

**Purpose**: Defines content structure, quality criteria, and enforcement status for documents produced by Ralph skills — research, plan, and review/critique.

**Definitions**: Key terms — research document, plan document, critique document, phase structure, convergence verification, artifact comment.

**Requirements sections**:

1. **Research Documents** — Required sections (problem statement, current state analysis, key discoveries with file:line refs, approaches, risks, recommended next steps, `## Files Affected` with Will Modify / Will Read subsections). Quality criteria from quality-standards.md (Depth, Feasibility, Risk, Actionability). Enablement: `[x] research-postcondition.sh` for `## Files Affected`, `[ ] not enforced` for other section structure.

2. **Plan Documents** — Required sections (overview with phase table, current state analysis, desired end state with verification, "What We're NOT Doing", per-phase sections with `## Phase N:` pattern, success criteria per phase in `- [ ] Automated:` / `- [ ] Manual:` format, integration testing, references). Three frontmatter variants (single, group, stream) — reference artifact-metadata.md for schemas, don't duplicate. Quality criteria from quality-standards.md (Completeness, Feasibility, Clarity, Scope). Enablement: `[x] plan-postcondition.sh` for committed, `[x] plan-research-required.sh` for research prerequisite, `[ ] not enforced` for phase structure (plan-verify-doc.sh ORPHANED), `[ ] not enforced` for success criteria format.

3. **Review/Critique Documents** — Required sections (verdict, critique/findings). Verdict values: APPROVED or NEEDS_ITERATION. AUTO vs INTERACTIVE distinction (AUTO requires committed critique doc, INTERACTIVE does not). Enablement: `[x] review-postcondition.sh` for AUTO mode enforcement, `[x] review-no-dup.sh` for duplicate prevention, `[x] review-verify-doc.sh` for frontmatter warnings. Note: `review-verify-doc.sh` warns but does not block — document as partial enforcement.

4. **Convergence Verification (Group Plans)** — `convergence-gate.sh` warns on `Plan in Progress` transition without `RALPH_CONVERGENCE_VERIFIED`. `ralph_hero__check_convergence` MCP tool performs full check. Document as `[ ] warns only` (not blocking enforcement).

5. **Document Quality Dimensions** — Reference quality-standards.md for canonical dimensions. Research: Depth, Feasibility, Risk, Actionability. Plans: Completeness, Feasibility, Clarity, Scope. Enablement: `[ ] not enforced` (quality is skill-prompt guidance only).

**Cross-References**: Link to artifact-metadata.md (file naming, frontmatter schemas, Artifact Comment Protocol), skill-io-contracts.md (which skills produce which documents), issue-lifecycle.md (state transitions that trigger document creation).

### Success Criteria
- [ ] Automated: `test -f specs/document-protocols.md && grep -q "## Purpose" specs/document-protocols.md && grep -q "## Requirements" specs/document-protocols.md && grep -q "## Cross-References" specs/document-protocols.md`
- [ ] Manual: Research, plan, and review sections all present
- [ ] Manual: Enablement checkboxes match actual hook enforcement (orphaned scripts not cited as enforcers)
- [ ] Manual: Cross-references to artifact-metadata.md and skill-io-contracts.md present

---

## Integration Testing
- [ ] All 7 specs in `specs/` directory: README.md + 4 Phase 1 + 2 Phase 2
- [ ] Phase 2 specs follow same template as Phase 1 specs (Purpose, Definitions, Requirements, Cross-References)
- [ ] Cross-references between Phase 1 and Phase 2 specs are bidirectional and consistent
- [ ] No duplicate content between artifact-metadata.md (frontmatter schemas) and document-protocols.md (content requirements)
- [ ] Enablement checkboxes: no orphaned scripts (plan-verify-doc.sh, plan-no-dup.sh) cited as `[x]`

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0469-lifecycle-and-document-specs.md
- Parent plan: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-28-ralph-protocol-specs.md
- Phase 1 plan: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-03-01-GH-0468-scaffold-and-core-specs.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/469
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/467
