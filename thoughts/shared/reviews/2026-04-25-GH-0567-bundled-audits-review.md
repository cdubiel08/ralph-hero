---
date: 2026-04-25
github_issue: 567
github_url: https://github.com/cdubiel08/ralph-hero/issues/567
plan_document: thoughts/shared/plans/2026-04-25-GH-0567-bundled-skill-audits-phase-2.md
status: approved
type: review
tags: [plan-review, skill-audit, phase-2, bundled-implementation]
---

# Plan Review: GH-567 Bundled Skill Audits Phase 2

## Verdict: APPROVED

## Mode: AUTO

## Rationale

The bundled implementation plan is dispatchable, scope-disciplined, and faithfully maps each phase's tasks to the research findings recorded for issues #567–#575. All nine phases declare complete task metadata (files, tdd, complexity, depends_on, acceptance), file ownership is disjoint across phases (each operates on a distinct skill directory; the two phases that edit hook scripts touch different files: triage-postcondition.sh vs merge-state-gate.sh), and the 17-file eval-scenarios.md scope matches the integration testing target. Out-of-scope work (fragment extraction → #840–843; MCP server source changes → separate issues) is explicitly fenced in both "What We're NOT Doing" and Cross-Phase Concerns. Spot checks against three research artifacts (GH-0567 ralph-triage, GH-0569 ralph-review, GH-0574 setup) confirmed each cited finding has a corresponding acceptance bullet with line-level traceability.

## Review Dimensions

### 1. Dispatchability — PASS

Every task includes:
- `files:` list (exact paths under plugin/ralph-hero/)
- `tdd:` flag (false across the board, appropriate for content edits)
- `complexity:` tag (low/medium/high)
- `depends_on: null` for all phases and tasks
- Concrete `acceptance:` checklists with grep/bash -n/test -f verification

An impl-agent can pick up any single phase and execute it without re-reading research docs.

### 2. Task Metadata — PASS

All 26 tasks across the 9 phases are fully annotated. Phase 1 Task 1.3 (RE-ESTIMATE hook) is the smallest example of correct metadata; Phase 4 Task 4.5 (3 eval files in one task) demonstrates correct multi-file ownership.

### 3. Scope Discipline — PASS

- "What we're NOT doing" enumerates: fragment extraction, MCP server source changes, new agent files, eval execution, skill renames.
- Cross-Phase Concern #6 explicitly confirms no edits to `plugin/ralph-hero/mcp-server/src/`.
- Each phase that has fragment-extraction candidates only adds inline notes pointing at #840-843, not new fragment files.

### 4. Findings Coverage — PASS (spot checks)

**Phase 1 (ralph-triage):**
- Research Issue 1 (RE-ESTIMATE hook gap, line 42) → Task 1.3 acceptance bullet 1
- Research Issue 2 (RALPH_TRIAGE_ACTION undocumented, line 62) → Task 1.1 acceptance bullet 2
- Research Issue 3 (agent tools gap, lines 64-77) → Task 1.2 acceptance bullets 1-3
- Research Issue 4 (Step 2 ordering, line 79) → Task 1.1 acceptance bullet 3
- Research Issue 6 (Step 7 time budget, line 85) → Task 1.1 acceptance bullet 4
- Research Issue 7 (error handling, line 88) → Task 1.1 acceptance bullet 6
- Description fix (line 30 / line 161) → Task 1.1 acceptance bullet 1
- Eval scenarios (lines 117-130) → Task 1.4

**Phase 3 (ralph-review):**
- Discovery 1 (Dispatchability missing, lines 49-71) → Task 3.1 acceptance bullet 1
- Discovery 3 (ESCALATE missing, lines 92-103) → Task 3.1 acceptance bullet 2
- Discovery 10 (commit syntax bug, lines 164-181) → Task 3.1 acceptance bullet 3
- Discovery 4 (no plan summary, lines 105-114) → Task 3.1 acceptance bullet 4
- Discovery 5 (binary feedback, lines 119-124) → Task 3.1 acceptance bullet 5
- Discovery 7 (Task tool, lines 142-146) → Task 3.1 acceptance bullet 6 + Task 3.2

**Phase 8 (setup/setup-repos):**
- Finding 1 (Canceled state missing, lines 60-69) → Task 8.1 acceptance bullet 1
- Finding 3 (dead [project-number] hint, lines 80-85) → Task 8.1 acceptance bullet 3
- Finding 4 (.gitignore missing, lines 87-91) → Task 8.1 acceptance bullet 4
- Finding 12 (setup-repos merge logic data loss, lines 150-156) → Task 8.2 acceptance bullet 1
- Finding 14 (interruption recovery) → Top-of-skill recovery headers in both 8.1 and 8.2

### 5. Independence Claim — PASS

File ownership matrix:
- Phase 1: ralph-triage SKILL.md + triage-agent.md + triage-postcondition.sh + ralph-triage/eval-scenarios.md
- Phase 2: ralph-split SKILL.md + split-agent.md + split-estimate-gate.sh + ralph-split/eval-scenarios.md
- Phase 3: ralph-review SKILL.md + review-agent.md + ralph-review/eval-scenarios.md
- Phase 4: ralph-val SKILL.md + ralph-pr SKILL.md + ralph-merge SKILL.md + merge-state-gate.sh + 3 eval files
- Phase 5: status SKILL.md + report SKILL.md + 2 eval files
- Phase 6: ralph-hygiene SKILL.md + 1 eval file
- Phase 7: draft SKILL.md + form SKILL.md + iterate SKILL.md + 3 eval files
- Phase 8: setup SKILL.md + setup-repos SKILL.md + 2 eval files
- Phase 9: idea-hunt SKILL.md + record-demo SKILL.md + design-system-audit SKILL.md + 3 eval files

No file overlap between phases. The two phases editing shell scripts (1 and 4) touch different scripts. Parallel dispatch is safe.

### 6. Eval Scenarios — PASS

Sum: 1 + 1 + 1 + 3 + 2 + 1 + 3 + 2 + 3 = **17** new eval-scenarios.md files. Matches the integration test target ("17 expected" — line 702).

Each eval task explicitly requires:
- Frontmatter (type/skill/date)
- 3 scenarios with Input / Expected Behavior / Assertions sections

## Minor Observations (Non-Blocking)

1. Integration test threshold says ">= 14" with parenthetical "17 expected" — the >=14 floor is satisfied by the 17 files, but tightening to ">= 17" would catch a phase that silently dropped an eval file. Optional improvement.
2. Frontmatter `tags` (line 19) does not list `status` or `report` even though Phase 5 covers those skills. Cosmetic only.
3. Phase 5's "Use When" subsection differentiation guidance (Task 5.1 acceptance bullet 4) is good but could be cross-linked from `hello`'s SKILL.md in a future pass — out of scope for this plan.

None of these warrant iteration; they are flagged for impl-agent awareness.

## Approval Conditions

None. Ready for orchestrator dispatch via `/ralph-impl 567` (or parallel dispatch of all 9 phases).
