---
date: 2026-04-05
status: draft
type: plan
github_issue: 746
github_issues: [746, 747, 748, 749, 750, 751, 752]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/746
  - https://github.com/cdubiel08/ralph-hero/issues/747
  - https://github.com/cdubiel08/ralph-hero/issues/748
  - https://github.com/cdubiel08/ralph-hero/issues/749
  - https://github.com/cdubiel08/ralph-hero/issues/750
  - https://github.com/cdubiel08/ralph-hero/issues/751
  - https://github.com/cdubiel08/ralph-hero/issues/752
primary_issue: 746
tags: [skills, agents, ask-user-question, handoffs, ux, pipeline, closing-ux]
---

# Mode-Aware Pipeline Handoff UX - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-05-hero-pipeline-handoff-ux-inventory]]
- builds_on:: [[2026-03-24-GH-0674-agent-per-phase-architecture]]

## Overview

7 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-746 | Add AskUserQuestion to interactive skill allowed-tools and agent tools | XS |
| 2 | GH-747 | Remove PR creation from ralph-impl | S |
| 3 | GH-748 | Mode-aware closing UX for autonomous skills | S |
| 4 | GH-749 | Interactive plan closing UX with AskUserQuestion | S |
| 5 | GH-750 | Hero human gate: inline approval and structured STOP | S |
| 6 | GH-751 | Interactive research: gather feedback before finalizing document | S |
| 7 | GH-752 | Interactive impl closing UX with AskUserQuestion | XS |

**Why grouped**: All 7 issues address a single cross-cutting concern — the closing UX of pipeline skills is context-unaware. Phase 1 enables the tool, Phases 2-3 clean up autonomous closing, and Phases 4-7 add structured interactive closing. They share the same files (skill SKILL.md, agent .md) and form a coherent atomic change.

## Shared Constraints

- All file paths are relative to `plugin/ralph-hero/` in the repo root
- `allowed-tools` in skill frontmatter is a skip-prompt whitelist (tools not listed still work but prompt)
- `tools:` in agent frontmatter is a hard allowlist (tools not listed are genuinely unavailable)
- AskUserQuestion convention: label = action verb + concrete target (max ~5 words), description = what happens when selected. Defined in `skills/shared/fragments/ask-user-question.md`
- No MCP server TypeScript changes required — all modifications are to skill/agent markdown files
- Verification: YAML frontmatter must remain valid; skill prose must reference correct tool names

## Current State Analysis

Every skill in the hero pipeline has a single closing template serving three invocation contexts (interactive user, hero orchestrator, autonomous loop) poorly:
- Interactive skills use numbered lists instead of AskUserQuestion pickers
- Autonomous skills emit "Next: Run /ralph-foo" suggestions that hero ignores
- Hero human gate uses procedural instructions instead of inline approval
- ralph-impl creates PRs on final phase, conflicting with parallel execution and hero's dedicated ralph-pr stage
- Interactive research finalizes documents before users can shape them
- AskUserQuestion is missing from 5 interactive skill `allowed-tools` and 2 agent `tools:` lists

## Desired End State

### Verification
- [ ] AskUserQuestion in `allowed-tools` for plan, research, impl, iterate, ralph-review skills
- [ ] AskUserQuestion in `tools:` for merge-agent and review-agent
- [ ] ralph-impl no longer creates PRs (Steps 10-12 removed)
- [ ] Autonomous skills (ralph-research, ralph-split, ralph-review, ralph-impl) emit clean status without "Next:" suggestions
- [ ] Interactive plan skill uses AskUserQuestion for GitHub linking and state advancement
- [ ] Hero human gate uses AskUserQuestion for inline approval in interactive mode
- [ ] Interactive research skill presents findings and gathers feedback before finalizing
- [ ] Interactive impl skill uses AskUserQuestion for next-step choices at completion

## What We're NOT Doing
- Adding mode detection via `RALPH_INTERACTIVE` env var (open question — deferred)
- Structured STOP message format (JSON/YAML) for machine parsing (deferred)
- Adding mode-aware closing to iterate skill (simple enough to keep as-is)
- Changing ralph-merge or finish closing UX (already correct per research)
- Changing ralph-plan closing UX (already clean for autonomous mode)

## Implementation Approach

Phase 1 enables the AskUserQuestion tool across all interactive skills and agents — this is the prerequisite for Phases 4, 6, and 7 which introduce AskUserQuestion usage in skill prose. Phase 2 removes PR creation from ralph-impl (independent). Phase 3 cleans up autonomous "Next:" suggestions (depends on Phase 2 since both touch ralph-impl). Phases 4-7 add structured AskUserQuestion closing UX to interactive skills and the hero human gate.

Phases 1, 2, and 5 can execute in parallel (no shared file dependencies). Phases 4, 6, 7 depend on Phase 1. Phase 3 depends on Phase 2.

---

## Phase 1: Add AskUserQuestion to allowed-tools and agent tools (GH-746)
- **depends_on**: null

### Overview
Add AskUserQuestion to the `allowed-tools:` frontmatter list in 5 interactive skills and the `tools:` list in 2 agents. Pure frontmatter changes, no prose modifications.

### Tasks

#### Task 1.1: Add AskUserQuestion to interactive skill allowed-tools
- **files**: [`skills/plan/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/plan/SKILL.md) (modify), [`skills/research/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/research/SKILL.md) (modify), [`skills/impl/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/impl/SKILL.md) (modify), [`skills/iterate/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/iterate/SKILL.md) (modify), [`skills/ralph-review/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-review/SKILL.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `AskUserQuestion` appears as a line item in the `allowed-tools:` YAML list in all 5 skill files
  - [ ] Each skill's YAML frontmatter parses without errors
  - [ ] Existing allowed-tools entries are unchanged

#### Task 1.2: Add AskUserQuestion to agent tools
- **files**: [`agents/merge-agent.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/merge-agent.md) (modify), [`agents/review-agent.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/review-agent.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `AskUserQuestion` appears in the comma-separated `tools:` line in merge-agent.md
  - [ ] `AskUserQuestion` appears in the comma-separated `tools:` line in review-agent.md
  - [ ] Each agent's YAML frontmatter parses without errors

### Phase Success Criteria

#### Automated Verification:
- [ ] `grep -c 'AskUserQuestion' plugin/ralph-hero/skills/plan/SKILL.md` returns at least 1
- [ ] `grep -c 'AskUserQuestion' plugin/ralph-hero/skills/research/SKILL.md` returns at least 1
- [ ] `grep -c 'AskUserQuestion' plugin/ralph-hero/skills/impl/SKILL.md` returns at least 1
- [ ] `grep -c 'AskUserQuestion' plugin/ralph-hero/skills/iterate/SKILL.md` returns at least 1
- [ ] `grep -c 'AskUserQuestion' plugin/ralph-hero/skills/ralph-review/SKILL.md` returns at least 1
- [ ] `grep -c 'AskUserQuestion' plugin/ralph-hero/agents/merge-agent.md` returns at least 1
- [ ] `grep -c 'AskUserQuestion' plugin/ralph-hero/agents/review-agent.md` returns at least 1

#### Manual Verification:
- [ ] YAML frontmatter in all 7 files parses correctly

**Creates for next phase**: AskUserQuestion is now available (skip-prompt) in all interactive skills and (hard-enabled) in merge-agent and review-agent. Phases 4, 6, and 7 can now reference AskUserQuestion in skill prose.

---

## Phase 2: Remove PR creation from ralph-impl (GH-747)
- **depends_on**: null

### Overview
Remove Steps 10-12 (PR creation, PR gate, GitHub issue update) from ralph-impl. After this change, ralph-impl stops after committing the final phase and reporting status. PR creation becomes the caller's responsibility (hero dispatches ralph-pr, interactive /impl offers it via AskUserQuestion in Phase 7).

### Tasks

#### Task 2.1: Remove Steps 10-12 from ralph-impl
- **files**: [`skills/ralph-impl/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-impl/SKILL.md) (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Steps 10 (Create PR), 11 (PR Gate), and 12 (Update GitHub Issues) are fully removed from the skill
  - [ ] Step 9 "Check if All Phases Complete" remains and serves as the final-phase exit point
  - [ ] Step 9's final-phase output is updated: instead of "continue to Step 10", it reports clean completion status with worktree path and artifact info
  - [ ] Step 13 (Team Result Reporting) is renumbered to Step 10
  - [ ] Step 14 (Final Report) is renumbered to Step 11 and updated to remove PR URL reference — reports: issues, worktree path, branch name, commit hash
  - [ ] Address Mode (PR Review Feedback) section is unchanged (it handles existing PRs, not creation)
  - [ ] Mid-phase STOP output (Step 9 non-final) is unchanged

**Step 9 final-phase replacement text**:
```
If ALL phases are complete:
```
Implementation complete for #NNN: [Title]

Issues: [list all issues with titles]
Branch: [branch-name]
Worktree: $GIT_ROOT/worktrees/[WORKTREE_ID]

All phases implemented and verified.
```
```

### Phase Success Criteria

#### Automated Verification:
- [ ] `grep -c 'Create PR' plugin/ralph-hero/skills/ralph-impl/SKILL.md` returns 0 (in step heading context)
- [ ] `grep -c 'gh pr create' plugin/ralph-hero/skills/ralph-impl/SKILL.md` returns 0
- [ ] `grep -c 'PR Gate' plugin/ralph-hero/skills/ralph-impl/SKILL.md` returns 0

#### Manual Verification:
- [ ] The skill reads coherently from Step 8 (commit) through new Step 11 (final report)
- [ ] Address Mode section is intact and unchanged

**Creates for next phase**: ralph-impl no longer creates PRs. Phase 3 can safely modify Step 9's mid-phase closing without conflicting with removed steps.

---

## Phase 3: Mode-aware closing UX for autonomous skills (GH-748)
- **depends_on**: [phase-2]

### Overview
Remove "Next: Run /ralph-foo" suggestions from autonomous skill closing templates. These suggestions are noise when hero is the caller (it determines routing via its task graph). Replace with clean status-only output.

### Tasks

#### Task 3.1: Clean ralph-research closing
- **files**: [`skills/ralph-research/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-research/SKILL.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Step 10 multi-issue closing no longer contains "Group ready for planning. Run /ralph-plan."
  - [ ] Step 10 multi-issue closing no longer contains "Run /ralph-research to continue group research."
  - [ ] Replaced with: "Group status: [M of N] issues researched." (no routing suggestion)
  - [ ] Single-issue closing keeps "Status: Ready for Plan" but removes any "Next:" line if present

#### Task 3.2: Clean ralph-split closing
- **files**: [`skills/ralph-split/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-split/SKILL.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Closing template no longer contains "Next: Run /ralph-research or /ralph-plan on sub-issues as appropriate."
  - [ ] Closing template retains the issue list and dependency chain info

#### Task 3.3: Clean ralph-review AUTO mode closing
- **files**: [`skills/ralph-review/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-review/SKILL.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] AUTO mode APPROVED closing no longer contains "Ready for implementation. Run /ralph-impl NNN"
  - [ ] AUTO mode NEEDS_ITERATION closing no longer contains "Run /ralph-plan NNN to address critique and update plan."
  - [ ] Both retain the mode, result, and status fields
  - [ ] INTERACTIVE mode (Step 4A) is unchanged

#### Task 3.4: Clean ralph-impl mid-phase closing
- **files**: [`skills/ralph-impl/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-impl/SKILL.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] Step 9 non-final STOP output changed from `Phase [N]/[M] complete. Next: Phase [N+1]. Run /ralph-impl NNN to continue.` to `Phase [N]/[M] complete.`
  - [ ] Retains phase number information

### Phase Success Criteria

#### Automated Verification:
- [ ] `grep -c 'Run /ralph-plan' plugin/ralph-hero/skills/ralph-research/SKILL.md` returns 0
- [ ] `grep -c 'Run /ralph-research' plugin/ralph-hero/skills/ralph-research/SKILL.md` returns 0 (in closing context)
- [ ] `grep -c 'Next: Run /ralph-research' plugin/ralph-hero/skills/ralph-split/SKILL.md` returns 0
- [ ] `grep -c 'Run /ralph-impl' plugin/ralph-hero/skills/ralph-review/SKILL.md` returns 0
- [ ] `grep -c 'Run /ralph-plan' plugin/ralph-hero/skills/ralph-review/SKILL.md` returns 0 (in closing context)
- [ ] `grep -c 'Run /ralph-impl NNN to continue' plugin/ralph-hero/skills/ralph-impl/SKILL.md` returns 0

#### Manual Verification:
- [ ] Each modified skill's closing template reads as clean status reporting (artifact path, workflow state, summary)

**Creates for next phase**: All autonomous skills now emit clean status output. No "Next:" noise for orchestrators to ignore.

---

## Phase 4: Interactive plan closing UX with AskUserQuestion (GH-749)
- **depends_on**: [phase-1]

### Overview
Replace the two numbered-list decision points in the interactive plan skill's Step 6 (GitHub Integration) with AskUserQuestion pickers using proper label/description convention.

### Tasks

#### Task 4.1: Replace GitHub linking prompt with AskUserQuestion
- **files**: [`skills/plan/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/plan/SKILL.md) (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Step 6 "Offer to link to a GitHub issue" uses AskUserQuestion instead of numbered list
  - [ ] Options: `{"label": "Link to existing issue", "description": "Provide an issue number to attach this plan to"}`, `{"label": "Create new issue", "description": "Create a GitHub issue from this plan and link it"}`, `{"label": "Skip GitHub linking", "description": "Keep the plan as a standalone document"}`
  - [ ] Routing logic after AskUserQuestion response matches current behavior per option

#### Task 4.2: Replace state advancement prompt with AskUserQuestion
- **files**: [`skills/plan/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/plan/SKILL.md) (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [4.1]
- **acceptance**:
  - [ ] State advancement prompt uses AskUserQuestion instead of numbered list
  - [ ] Options rephrased per research recommendations: `{"label": "Queue for review", "description": "Ralph will review this plan in a later session before implementation begins"}`, `{"label": "Start implementation", "description": "You've reviewed the plan — move straight to implementation with /impl"}`, `{"label": "Leave as-is", "description": "Keep the plan in draft — decide later what to do with it"}`
  - [ ] Routing logic matches: "Queue for review" -> Plan in Review, "Start implementation" -> In Progress, "Leave as-is" -> no state change

### Phase Success Criteria

#### Automated Verification:
- [ ] `grep -c 'AskUserQuestion' plugin/ralph-hero/skills/plan/SKILL.md` returns at least 2 (one per decision point, plus frontmatter)

#### Manual Verification:
- [ ] Step 6 reads naturally with AskUserQuestion calls replacing numbered lists
- [ ] Option labels follow AskUserQuestion convention (verb + target, max ~5 words)

**Creates for next phase**: Interactive plan skill now uses structured pickers. Users get clear, self-contained options.

---

## Phase 5: Hero human gate: inline approval and structured STOP (GH-750)
- **depends_on**: null

### Overview
Replace the hero orchestrator's procedural HUMAN GATE instructions with an AskUserQuestion picker for interactive sessions. Hero already has AskUserQuestion in its `allowed-tools`. The current prose tells users to go to GitHub and manually move issues — the new UX offers inline approval.

### Tasks

#### Task 5.1: Replace HUMAN GATE section with AskUserQuestion
- **files**: [`skills/hero/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/hero/SKILL.md) (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] The `#### HUMAN GATE tasks` section is replaced with an AskUserQuestion block
  - [ ] The section first lists all planned groups with plan URLs (existing behavior preserved)
  - [ ] AskUserQuestion options: `{"label": "Approve and implement", "description": "Move all issues to In Progress and begin implementation immediately"}`, `{"label": "Open plan in editor", "description": "Review the plan document in your default editor, then decide"}`, `{"label": "Stop here", "description": "Review plans in GitHub and re-run /hero later"}`
  - [ ] "Approve and implement" handler: batch updates all group issues to "In Progress" and continues the execution loop
  - [ ] "Open plan in editor" handler: opens the plan file with `open` (macOS) or `xdg-open` (Linux), then re-presents the picker
  - [ ] "Stop here" handler: marks the human gate task as completed and STOPs with a clear message including plan URL and re-run command

### Phase Success Criteria

#### Automated Verification:
- [ ] `grep -c 'AskUserQuestion' plugin/ralph-hero/skills/hero/SKILL.md` returns at least 2 (frontmatter + gate)

#### Manual Verification:
- [ ] HUMAN GATE section reads as a clear interactive approval flow
- [ ] The "Stop here" path still provides enough info for async review

**Creates for next phase**: Hero's human gate is now interactive. Users can approve plans inline without leaving the terminal.

---

## Phase 6: Interactive research: gather feedback before finalizing document (GH-751)
- **depends_on**: [phase-1]

### Overview
Restructure the interactive research skill's closing flow so findings are presented to the user BEFORE the document is finalized. Currently the skill writes the document first (Steps 7-8) and then presents findings (Step 9). The new flow presents a summary, asks for feedback via AskUserQuestion, incorporates it, then writes/updates the document.

### Tasks

#### Task 6.1: Restructure research closing flow
- **files**: [`skills/research/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/research/SKILL.md) (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] After sub-agent findings are synthesized (end of Step 6), the skill presents a findings summary to the user BEFORE writing the document
  - [ ] New Step 7 "Present Findings": display synthesized findings with key file references
  - [ ] New Step 7 includes AskUserQuestion: `{"label": "Looks good, write it", "description": "Finalize the research document as-is"}`, `{"label": "Go deeper on a topic", "description": "Investigate a specific area further before writing"}`, `{"label": "Correct something", "description": "Fix an inaccuracy or misunderstanding in the findings"}`
  - [ ] "Looks good" path: proceed to write the document (current Steps 7-8 become Steps 8-9)
  - [ ] "Go deeper" path: ask what topic, spawn targeted sub-agents, update findings, re-present
  - [ ] "Correct something" path: ask what's wrong, incorporate correction, re-present
  - [ ] Old Steps 7-10 are renumbered to Steps 8-11 (write doc, update GitHub, present findings becomes confirmation, handle follow-ups)
  - [ ] Step 9 (previously Step 9 "Present findings") is simplified since the user already saw findings — becomes a confirmation with offer to link and next steps
  - [ ] The `/ralph-hero:form` suggestion is moved into an AskUserQuestion option: `{"label": "Create issue from findings", "description": "Turn these findings into a GitHub issue via /form"}`

### Phase Success Criteria

#### Automated Verification:
- [ ] `grep -c 'AskUserQuestion' plugin/ralph-hero/skills/research/SKILL.md` returns at least 2 (frontmatter + findings step)

#### Manual Verification:
- [ ] Research skill flow reads naturally: research -> present findings -> user feedback -> write doc -> link/next steps
- [ ] The autonomous ralph-research skill is NOT modified (confirmed unchanged)

**Creates for next phase**: Interactive research now gathers user feedback before finalizing. Users shape the document before it's written.

---

## Phase 7: Interactive impl closing UX with AskUserQuestion (GH-752)
- **depends_on**: [phase-1]

### Overview
Replace the interactive impl skill's Step 5.4 report output with an AskUserQuestion picker offering structured next-step choices. Currently the skill prints a static "Next steps:" list. With ralph-impl's PR creation removed (Phase 2), the interactive impl skill needs to offer PR creation as a next step via AskUserQuestion.

### Tasks

#### Task 7.1: Replace impl completion report with AskUserQuestion
- **files**: [`skills/impl/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/impl/SKILL.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Step 5.4 "Report to User" replaced with AskUserQuestion block
  - [ ] First shows implementation summary (PR URL if already created in 5.1, issue URL, status)
  - [ ] AskUserQuestion options: `{"label": "Run finish", "description": "Validate implementation, merge PR, and watch CI"}`, `{"label": "Create PR only", "description": "Push branch and open a pull request without merging"}`, `{"label": "Iterate on plan", "description": "Refine the implementation plan before continuing"}`, `{"label": "Done for now", "description": "Stop here — continue later with /impl"}`
  - [ ] "Run finish" handler: invokes `Skill("ralph-hero:finish", args="NNN")`
  - [ ] "Create PR only" handler: runs `gh pr create` (existing Step 5.1 logic)
  - [ ] "Iterate on plan" handler: suggests `/ralph-hero:iterate #NNN`
  - [ ] "Done for now" handler: reports current state and stops

### Phase Success Criteria

#### Automated Verification:
- [ ] `grep -c 'AskUserQuestion' plugin/ralph-hero/skills/impl/SKILL.md` returns at least 2 (frontmatter + completion)

#### Manual Verification:
- [ ] Step 5 reads naturally from 5.1 (create PR) through 5.4 (next steps picker)
- [ ] Options cover the common next actions after interactive implementation

**Creates for next phase**: Interactive impl now uses structured pickers. Implementation complete.

---

## Integration Testing
- [ ] Load each modified skill via `/ralph-hero:plan`, `/ralph-hero:research`, `/ralph-hero:impl` and verify AskUserQuestion appears in `allowed-tools` (no permission prompt)
- [ ] Verify merge-agent and review-agent load with AskUserQuestion in tools (no errors in agent dispatch)
- [ ] Verify ralph-impl no longer references PR creation in autonomous invocation
- [ ] Verify no autonomous skill contains "Next: Run" or "Run /ralph-" suggestions in its closing template

## References
- Research: [thoughts/shared/research/2026-04-05-hero-pipeline-handoff-ux-inventory.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-05-hero-pipeline-handoff-ux-inventory.md)
- Parent issue: [#745](https://github.com/cdubiel08/ralph-hero/issues/745)
- AskUserQuestion convention: [skills/shared/fragments/ask-user-question.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/fragments/ask-user-question.md)
- Related: GH-0069 (unattended mode), GH-0418 (interactive/ralph parity), GH-0433 (auto-mode detection)
