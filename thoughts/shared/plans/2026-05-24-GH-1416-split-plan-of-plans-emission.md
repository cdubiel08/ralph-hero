---
date: 2026-05-24
status: ready
type: plan
estimate: S
tags: [caretake-split, plan-of-plans, hooks, doc-structure-validator, autopilot]
github_issue: 1416
github_url: https://github.com/cdubiel08/ralph-hero/issues/1416
primary_issue: 1416
---

# Plan: split-on-epic emits a parent plan-of-plans (GH-1416)

## Prior Work

- builds_on:: [[2026-05-24-GH-1416-split-epic-autopilot-deadlock-handoff]] (research — primary; root cause + the two-part fix incl. the `doc-structure-validator.sh` gap)
- builds_on:: [[2026-05-23-GH-1370-ralph-plan-7-caretake]] (plan — caretake split design; split context is free of the plan research gate)
- builds_on:: [[2026-05-23-GH-1364-ralph-plan-4-plan]] (plan — parent-plan-reuse short-circuit + auto-mode escalation)

## Overview

`/ralph:caretake --mode split` decomposes an M/L/XL issue into XS/S children that land
in **Ready for Plan** with spec-complete bodies, but it leaves **no** plan artifact on
disk. The autonomous planner only consumes a per-ticket research doc *or* a parent
plan-of-plans, so freshly-split clusters deadlock and escalate to **Human Needed**.

This plan makes split write a **parent plan-of-plans** to `thoughts/shared/plans/` whose
sections map 1:1 to the created children (by number/title). The existing parent-plan-reuse
short-circuit (`ralph/skills/plan/intake-routing.md:42-63`) then fires for each child during
`--mode auto` — posts `## Plan Reference`, advances **Ready for Plan → In Progress**, with no
per-child research doc — making the cluster fully autonomous with no new gate logic.

It also closes a non-obvious hole: `doc-structure-validator.sh` (a plan-skill Stop hook)
selects its rules **by file path** and applies `## Phase N` requirements to *every*
`thoughts/shared/plans/` doc. A plan-of-plans has no `## Phase N`, so the validator would
**block** the next child `plan --mode auto` run that fires it. The validator must learn the
plan-of-plans shape.

## Current State Analysis

The split mode and the plan validators live in the slim `ralph` plugin under
`/Users/dubiel/projects/ralph-hero/ralph/` (the `plugin/ralph-hero/` tree is the old
parallel plugin and is out of scope).

### Key Discoveries

- `ralph/skills/caretake/modes/split.md` §Step 8 writes only a `## Issue Split` comment +
  dependency table; **no** `Write` to `thoughts/shared/plans/` anywhere in the mode body.
- Parent-plan reuse keys on glob `thoughts/shared/plans/*GH-NNNN-*.md` (parent number) and
  matches a section to a child "by number or title" (`ralph/skills/plan/intake-routing.md:42-63`).
- Plan-of-plans shape is defined in `ralph/skills/plan/decomposition.md:13-50` — frontmatter
  `type: plan-of-plans`; sections Strategic Context / Shared Constraints / Feature
  Decomposition (`### Feature` subsections) / Integration Strategy / Feature Sequencing /
  What We're NOT Doing.
- `ralph/hooks/scripts/doc-structure-validator.sh` `plan)` branch requires `^## Phase [0-9]`,
  `^#### (Automated|Manual) Verification`, and `^- \[ \]` — a plan-of-plans fails all three.
  It scans `plans/ reviews/ research/` for any `${today}-*.md` modified in the last 15 min,
  freshest wins, and discriminates by **path, not mode**.
- Caretake's Stop set (`ralph/skills/caretake/SKILL.md`) is `triage/unblock/split-postcondition`,
  `postmortem-completeness`, `lock-release-on-failure` — **not** `doc-structure-validator.sh`.
  So split writes freely; the validator only bites on the *next plan-skill Stop* within 15 min.
- `ralph/hooks/scripts/plan-tier-validator.sh` already self-discriminates plan vs plan-of-plans
  by shape (`## Feature Decomposition` vs `## Phase N`, fence-stripped). It is the precedent
  for the validator fix.
- `ralph/hooks/scripts/plan-research-required.sh` is registered only in the plan skill — not
  armed in caretake — which is why split can write the doc with no research doc present.

## Desired End State

1. Running `/ralph:caretake --mode split` on an epic-shaped issue writes a plan-of-plans to
   `thoughts/shared/plans/YYYY-MM-DD-GH-<parent>-plan-of-plans.md` with one section per child
   carrying the child's real GH number + title, and a `## Feature Sequencing` graph identical
   to the `## Issue Split` comment's dependency chain.
2. `doc-structure-validator.sh` validates that plan-of-plans doc against plan-of-plans section
   rules (not `## Phase N` rules) and returns exit 0; it still enforces `## Phase N` for regular
   plan docs.
3. `/ralph:plan --mode auto #<child>` on a freshly-split child triggers parent-plan reuse,
   advances the child to In Progress, writes no child plan doc, and its Stop hook does not block.

### Verification

- `bash ralph/hooks/scripts/doc-structure-validator.sh` against a fixture plan-of-plans returns
  exit 0; against a fixture regular plan missing `## Phase N` returns exit 2.
- `grep` shows the new write step in `split.md` and its documentation in `split-decomposition.md`.
- Manual: re-run split on a test M/L/XL issue and confirm the plan-of-plans file is created and
  consistent with the `## Issue Split` comment.

## What We're NOT Doing

- Not changing `plan-research-required.sh` or the auto-mode research requirement for non-split
  issues (issue out-of-scope).
- Not making the epic-mode research carve-out hook-aware (separate follow-up).
- Not auto-backfilling the existing #1417 / #1404–#1410 cluster as code — that is a one-time
  re-run/hand-write covered under manual verification, not a code deliverable here.
- Not modifying the old `plugin/ralph-hero/` plugin tree.

## Implementation Approach

Two phases over disjoint files. Phase 1 teaches the validator the plan-of-plans shape first, so
that when Phase 2 makes split emit such a doc, it already passes validation end-to-end. Phase 2
adds the writer step to the split mode body and documents the contract.

## Phase 1: Teach `doc-structure-validator.sh` the plan-of-plans shape
depends_on: null

### Overview
Add a plan-of-plans detection arm to the validator's `plan` branch so a `type: plan-of-plans`
doc is validated against plan-of-plans sections instead of `## Phase N` rules — mirroring the
self-discrimination already in `plan-tier-validator.sh`.

### Changes Required
#### 1. Validator branch
**File**: `ralph/hooks/scripts/doc-structure-validator.sh`
**Changes**: In the `plan)` case, before applying the `## Phase N` checks, detect a
plan-of-plans doc — true when the doc's frontmatter contains `type: plan-of-plans` OR the body
has a line-start `## Feature Decomposition` heading. **Strip fenced code blocks before that
heading grep** (mirror the `awk` fence-toggle in `plan-tier-validator.sh`) so a doc that
documents the sibling shape in a fenced example does not false-positive. When detected, require
the plan-of-plans sections (`^## Feature Decomposition`, `^## Feature Sequencing`) and skip the
`## Phase N` / Verification / checkbox requirements. Otherwise keep the existing regular-plan
checks byte-for-byte unchanged.

### Success Criteria
#### Automated Verification
- [ ] `bash -n ralph/hooks/scripts/doc-structure-validator.sh` (syntax OK); `shellcheck` if available reports no new errors
- [ ] **plan-of-plans passes** — using an isolated project root so freshest-wins/path selection is unambiguous:
  ```
  tmp=$(mktemp -d); mkdir -p "$tmp/thoughts/shared/plans"
  printf '%s\n' '---' 'type: plan-of-plans' '---' '## Feature Decomposition' '### Feature A' '## Feature Sequencing' 'A -> B' \
    > "$tmp/thoughts/shared/plans/$(date +%F)-GH-9999-plan-of-plans.md"
  CLAUDE_PROJECT_DIR="$tmp" bash ralph/hooks/scripts/doc-structure-validator.sh <<< '{}'   # expect exit 0
  ```
- [ ] **regular plan still gated** — same isolated-dir recipe, fixture missing `## Phase N`:
  ```
  tmp=$(mktemp -d); mkdir -p "$tmp/thoughts/shared/plans"
  printf '%s\n' '---' 'type: plan' '---' '## Overview' 'x' > "$tmp/thoughts/shared/plans/$(date +%F)-GH-9998-regular.md"
  CLAUDE_PROJECT_DIR="$tmp" bash ralph/hooks/scripts/doc-structure-validator.sh <<< '{}'   # expect exit 2
  ```
- [ ] `npm test` in `plugin/ralph-hero/mcp-server/` still passes (no unintended breakage; hooks are out-of-tree but confirm the suite is green)

#### Manual Verification
- [ ] Re-read the diff: the regular-plan path is byte-for-byte unchanged when no plan-of-plans signal is present

## Phase 2: Emit the plan-of-plans from split mode
depends_on: [phase-1]

### Overview
Add a step to the caretake split mode (after children exist) that writes the parent
plan-of-plans, and document the behavior + shape/naming contract in the decomposition reference.

### Changes Required
#### 1. Split mode body
**File**: `ralph/skills/caretake/modes/split.md`
**Changes**: Add a step after §Step 7 (dependencies set, child numbers known) and before/with
§Step 8 (the `## Issue Split` comment): write `thoughts/shared/plans/YYYY-MM-DD-GH-<parent>-plan-of-plans.md`
per `decomposition.md` § Plan-of-plans shape — frontmatter `type: plan-of-plans`; one
`### Feature` section per child embedding the child's real `#NNN` + title + scope; a
`## Feature Sequencing` graph identical to the `## Issue Split` dependency chain. Reference the
existing `--mode epic` Step 3 wording (`ralph/skills/plan/SKILL.md`) as the model. Note it only
applies to multi-child splits (the SPLIT-SKIPPED/re-estimate path writes nothing).

#### 2. Decomposition reference
**File**: `ralph/skills/caretake/split-decomposition.md`
**Changes**: Document the new plan-of-plans-emission behavior — when it fires, the filename
convention, the section-per-child format, the by-number/title match contract that parent-plan
reuse depends on, and the consistency requirement with the `## Issue Split` comment.

### Success Criteria
#### Automated Verification
- [ ] `grep -nE "plan-of-plans" ralph/skills/caretake/modes/split.md` shows the new write step
- [ ] `grep -nE "plan-of-plans" ralph/skills/caretake/split-decomposition.md` shows the documented contract
- [ ] `grep -n "thoughts/shared/plans" ralph/skills/caretake/modes/split.md` confirms the write target path is present
- [ ] No `^## Feature Decomposition` + `^## Phase` mixed-shape corruption introduced into any plan doc by the example text (review against `plan-tier-validator.sh`)

#### Manual Verification
- [ ] Run `/ralph:caretake --mode split` on a real M/L/XL test issue: a plan-of-plans file is created, sections map 1:1 to children by number/title, and `## Feature Sequencing` matches the `## Issue Split` comment
- [ ] On a freshly-split child, `/ralph:plan --mode auto #<child>` posts `## Plan Reference`, advances to In Progress, writes no child plan doc, and does not block at Stop
- [ ] End-to-end: re-run against the #1417 → #1404–#1410 cluster (or equivalent) drains Ready for Plan → In Progress without escalating to Human Needed

## Testing Strategy

### Unit / Hook Tests
The validator change is exercised by invoking `doc-structure-validator.sh` directly against
today-dated fixture docs (plan-of-plans pass, regular-plan-missing-Phase fail) — see Phase 1
automated verification. No new test file is strictly required; if a hook test harness exists,
add a case there.

### Integration Tests
Manual split → plan-auto child flow (Phase 2 manual verification) is the integration check; the
autonomous pipeline has no headless harness for skill-body changes.

### Manual Testing Steps
1. Pick/create a test M/L/XL issue with 2+ natural children.
2. `/ralph:caretake --mode split #<test>` → confirm children + plan-of-plans doc.
3. `/ralph:plan --mode auto #<child>` → confirm `## Plan Reference` + In Progress + no block.

## Performance Considerations

None — adds one file write per split invocation.

## Migration Notes

Already-split clusters (e.g. #1417 → #1404–#1410) predate the new path and have no
plan-of-plans on disk. To drain them, re-run the new split path against the parent or hand-write
the plan-of-plans once. No automated backfill ships with this change.

## References

- Research: `thoughts/shared/research/2026-05-24-GH-1416-split-epic-autopilot-deadlock-handoff.md` (`## Follow-up Research [2026-05-24]`)
- Reuse short-circuit: `ralph/skills/plan/intake-routing.md:42-63`
- Plan-of-plans shape: `ralph/skills/plan/decomposition.md:13-50`
- Validator: `ralph/hooks/scripts/doc-structure-validator.sh`; precedent `ralph/hooks/scripts/plan-tier-validator.sh`
- Split mode: `ralph/skills/caretake/modes/split.md`; `ralph/skills/caretake/split-decomposition.md`
