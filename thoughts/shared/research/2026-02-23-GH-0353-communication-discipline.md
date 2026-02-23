---
date: 2026-02-23
github_issue: 353
github_url: https://github.com/cdubiel08/ralph-hero/issues/353
status: complete
type: research
---

# GH-353: V4 Phase 1 — Communication Discipline

## Problem Statement

The observed #1 failure mode in ralph-team sessions is **redundant messaging**: the lead sends `SendMessage` to workers after already assigning them via `TaskUpdate(owner=...)`, creating duplicate signals. Workers also occasionally send acknowledgment or progress messages instead of using `TaskUpdate`. This creates noise, burns context window, and causes race conditions where workers receive conflicting instructions.

Phase 1 addresses this by adding explicit FORBIDDEN rules, trimming verbose hook guidance, and formalizing the communication contract in `conventions.md`.

## Current State Analysis

### `skills/shared/conventions.md` (lines 18–35)

Has a `## TaskUpdate Protocol` section with basic guidance:
- Line 20: "TaskUpdate is the primary channel... SendMessage is for exceptions only"
- Lines 29–34: "When to avoid SendMessage" list (4 bullets)
- Line 35: "Lead communication: Prefer tasks over messages. Don't nudge after assigning..."

**Missing**: The formal "Communication Discipline" section with named rules (The Assignment Rule, The Reporting Rule, The Nudge Rule) specified in the v4 architecture spec Section 7.1. The current text is correct but lacks the precise, named, machine-scannable structure required.

### `skills/ralph-team/SKILL.md` — Section 5 (Behavioral Principles)

Lines 320–324 show a "Don't do this" bad example (Task then SendMessage nudge). Line 413 states: "Nudge idle workers via SendMessage only if idle >2 minutes with unclaimed tasks."

**Missing**: Explicit "FORBIDDEN" keyword rules. The spec calls for a hard rule in Section 5 banning `SendMessage` after `TaskUpdate(owner)` in all cases except waking idle workers. The current guidance is directional but not prohibitive.

### `skills/ralph-team/SKILL.md` — Section 4.4 (Dispatch Loop)

Lines 246–248 define the dispatch loop as hook-driven ("The lifecycle hooks fire at natural decision points and tell you what to check"). **No explicit `SendMessage` calls exist in the dispatch loop body** — the loop is already passive. However, the spec calls for this to be explicitly confirmed and documented as a design principle (passive monitoring, not active messaging).

### `hooks/scripts/team-task-completed.sh`

**Current state**: 8-line guidance block with conditional logic:
- Review tasks (lines 22–27): 4-line multi-step instructions (check verdict, check APPROVED vs NEEDS_ITERATION, create revision task)
- Other tasks (lines 29–34): 3-line instructions (check convergence, create next-bough tasks)

**Spec requirement**: "One-line guidance, no multi-step instructions." The current multi-step format turns a hook into a mini-spec, which competes with SKILL.md for authority and creates maintenance drift.

### `hooks/scripts/team-teammate-idle.sh`

**Current state**: Single line at line 21: `"$TEAMMATE is idle. This is normal -- upstream stages may still be in progress."`

**Already compliant** — no changes needed. The spec says "one-line guidance (already minimal, verify)" and it is.

## Key Discoveries

### Why the Hook Verbosity Is a Problem

The `team-task-completed.sh` hook currently gives the lead a 4-step decision tree (lines 22–27 for reviews). This means:
1. The hook is acting as a secondary spec, duplicating logic already in SKILL.md Sections 4.4/5
2. Any divergence between the hook and SKILL.md creates ambiguity about which is authoritative
3. Multi-step hooks encourage the lead to react to each task completion with a burst of tool calls rather than following the passive dispatch loop

### The Assignment Rule Gap

The current `conventions.md` guidance says "Don't nudge after assigning" (line 35) but doesn't codify the specific pattern that causes failures: the lead calls `TaskUpdate(owner=worker)` and then immediately `SendMessage(recipient=worker, ...)`. These two calls together create a double-signal — the worker is woken by the task claim AND receives a message. Under load, the lead sends the message before the worker has started, leading to out-of-order processing.

The new Assignment Rule precisely captures when NOT to message (after first assignment = no SendMessage) vs when to message (idle worker with unclaimed task = wake via SendMessage).

### Section 4.4 Dispatch Loop — Already Passive

The dispatch loop does not contain `SendMessage` calls today. The only `SendMessage` reference in SKILL.md outside the bad example is line 413 (the idle worker nudge guideline). The spec change for Section 4.4 is therefore a documentation clarification — making the passive-monitoring design intent explicit — rather than code removal.

## Potential Approaches

### Option A: Minimal targeted edits (recommended)

Make exactly the 5 changes specified in the Phase 1 spec:
1. Add "Communication Discipline" section to `conventions.md` with the three named rules verbatim from the spec
2. Add FORBIDDEN rule block to SKILL.md Section 5
3. Add "passive monitoring" explicit statement to SKILL.md Section 4.4
4. Trim `team-task-completed.sh` to one-line guidance per path
5. Verify `team-teammate-idle.sh` (no change needed)

**Pros**: Smallest diff, lowest risk, scoped exactly to the spec. Each change is independent — no ordering dependency within Phase 1.

**Cons**: None identified. The scope is precisely defined.

### Option B: Also add hook validation

Add a postcondition check in `team-task-completed.sh` that reads the completed task's metadata and warns if no structured `result` key was set.

**Pros**: Catches workers that produce plain text instead of `TaskUpdate`
**Cons**: Out of scope for Phase 1; adds hook complexity; Phase 0 investigation should validate whether this is needed first.

**Recommendation**: Option A. Phase 0 validates primitives; Phase 1 is prose/rules only.

## Risks

1. **Hook one-liner may lose review path distinction**: The current multi-step review guidance tells the lead specifically what to do for APPROVED vs NEEDS_ITERATION verdicts. Replacing with one line means the lead must know this from SKILL.md. Mitigation: ensure SKILL.md Section 4.4 and/or Section 5 references the review verdict handling before trimming the hook.

2. **conventions.md section placement**: Adding a new top-level section to conventions.md must not break existing cross-references (skills link to specific sections by name). Mitigation: add "Communication Discipline" as a new section after "TaskUpdate Protocol" — the existing section name is unchanged.

## Recommended Next Steps

1. **Verify SKILL.md review verdict handling** before trimming `team-task-completed.sh` — confirm that APPROVED/NEEDS_ITERATION handling is documented in SKILL.md (it is: Section 4.4 references verdict-based routing)
2. **Implement all 5 changes in one PR** — they are logically a single atomic unit and independently safe
3. No blockers — Phase 0 does not need to complete before Phase 1 prose/rule changes (Phase 0 validates runtime primitives, Phase 1 updates documentation)

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/shared/conventions.md` — Add "Communication Discipline" section with Assignment Rule, Reporting Rule, Nudge Rule
- `plugin/ralph-hero/skills/ralph-team/SKILL.md` — Section 5: add FORBIDDEN rule block; Section 4.4: add passive-monitoring design note
- `plugin/ralph-hero/hooks/scripts/team-task-completed.sh` — Trim multi-step guidance to single-line per path (review and non-review)

### Will Read (Dependencies)
- `plugin/ralph-hero/hooks/scripts/team-teammate-idle.sh` — Verify already compliant (no changes needed)
- `thoughts/shared/plans/2026-02-22-ralph-workflow-v4-architecture-spec.md` — Section 7.1 (verbatim text for new conventions.md section), Section 9 Phase 1 acceptance criteria
