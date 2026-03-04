---
date: 2026-03-04
status: draft
github_issues: [514, 515]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/514
  - https://github.com/cdubiel08/ralph-hero/issues/515
primary_issue: 514
---

# Skill workflowState Enforcement — Atomic Implementation Plan

## Overview
2 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-514 | `form-idea` should set `workflowState: "Backlog"` on created issues | XS |
| 2 | GH-515 | `ralph-triage` split path should set `workflowState: "Backlog"` on child issues | XS |

**Why grouped**: Both fix the same enforcement gap — SKILL.md files that create issues without setting `workflowState`, leaving them invisible to the pipeline. Both are one-line additions to `save_issue` calls in skill markdown prompts.

## Current State Analysis

`form-idea` and `ralph-triage` (SPLIT path) both create issues using:
```
ralph_hero__create_issue(title=..., body=...)
ralph_hero__save_issue(number=..., estimate="XS")
```
Neither sets `workflowState`. Created issues land on the project board with no Workflow State, making them invisible to `ralph-triage`'s `analyst-triage` profile (which queries `workflowState: "Backlog"`).

In contrast, `ralph-split` (the dedicated split skill) correctly sets `workflowState: "Backlog"` on created sub-issues.

## Desired End State

### Verification
- [ ] Issues created by `form-idea` (single, parent, children) have `workflowState: "Backlog"` in the `save_issue` call
- [ ] Issues created by `ralph-triage` SPLIT path have `workflowState: "Backlog"` in the `save_issue` call
- [ ] Both skills match `ralph-split`'s pattern for setting workflowState on new issues

## What We're NOT Doing
- Not modifying `create_issue` MCP handler (that's GH-516, separate issue)
- Not adding hooks or validation — existing hooks already accept `"Backlog"` as a valid state
- Not changing any TypeScript code — these are pure SKILL.md prompt changes

## Implementation Approach
Both phases are independent one-line additions to SKILL.md files. Phase 1 has three insertion points (single issue, ticket tree parent, ticket tree children). Phase 2 has one insertion point. No code dependencies between phases.

---

## Phase 1: GH-514 — `form-idea` workflowState fix
> **Issue**: [GH-514](https://github.com/cdubiel08/ralph-hero/issues/514) | **Research**: [2026-03-04-GH-0514](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-04-GH-0514-form-idea-workflowstate-fix.md)

### Changes Required

#### 1. Single issue `save_issue` call
**File**: [`plugin/ralph-hero/skills/form-idea/SKILL.md:169-172`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/form-idea/SKILL.md#L169-L172)
**Change**: Add `- workflowState: "Backlog"` to the `save_issue` call

Before:
```markdown
   ralph_hero__save_issue
   - number: [created issue number]
   - estimate: "XS"  (or S/M/L/XL as appropriate)
```

After:
```markdown
   ralph_hero__save_issue
   - number: [created issue number]
   - estimate: "XS"  (or S/M/L/XL as appropriate)
   - workflowState: "Backlog"
```

#### 2. Ticket tree parent `save_issue` call
**File**: [`plugin/ralph-hero/skills/form-idea/SKILL.md:216-218`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/form-idea/SKILL.md#L216-L218)
**Change**: Add `workflowState: "Backlog"` parameter

Before:
```markdown
   ralph_hero__create_issue(title=..., body=...)
   ralph_hero__save_issue(number=..., estimate="L")
```

After:
```markdown
   ralph_hero__create_issue(title=..., body=...)
   ralph_hero__save_issue(number=..., estimate="L", workflowState="Backlog")
```

#### 3. Ticket tree children `save_issue` call
**File**: [`plugin/ralph-hero/skills/form-idea/SKILL.md:221-225`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/form-idea/SKILL.md#L221-L225)
**Change**: Add `workflowState: "Backlog"` parameter

Before:
```markdown
   ralph_hero__create_issue(title=..., body=...)
   ralph_hero__add_sub_issue(parentNumber=..., childNumber=...)
   ralph_hero__save_issue(number=..., estimate="XS")
```

After:
```markdown
   ralph_hero__create_issue(title=..., body=...)
   ralph_hero__add_sub_issue(parentNumber=..., childNumber=...)
   ralph_hero__save_issue(number=..., estimate="XS", workflowState="Backlog")
```

### Success Criteria
- [ ] Automated: `grep -c 'workflowState.*Backlog\|workflowState: "Backlog"' plugin/ralph-hero/skills/form-idea/SKILL.md` returns 3
- [ ] Manual: Read SKILL.md and verify all three `save_issue` calls include `workflowState: "Backlog"`

---

## Phase 2: GH-515 — `ralph-triage` split path workflowState fix
> **Issue**: [GH-515](https://github.com/cdubiel08/ralph-hero/issues/515) | **Research**: [2026-03-04-GH-0515](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-04-GH-0515-ralph-triage-split-workflowstate-fix.md)

### Changes Required

#### 1. SPLIT path `save_issue` call
**File**: [`plugin/ralph-hero/skills/ralph-triage/SKILL.md:205-209`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-triage/SKILL.md#L205-L209)
**Change**: Add `- workflowState: "Backlog"` to the `save_issue` call in Step 5 SPLIT, "If no children exist" branch

Before:
```markdown
3. Set estimate:
   ```
   ralph_hero__save_issue
   - number: [new-issue-number]
   - estimate: "XS"
   ```
```

After:
```markdown
3. Set estimate and workflow state:
   ```
   ralph_hero__save_issue
   - number: [new-issue-number]
   - estimate: "XS"
   - workflowState: "Backlog"
   ```
```

### Success Criteria
- [ ] Automated: `grep -c 'workflowState.*Backlog\|workflowState: "Backlog"' plugin/ralph-hero/skills/ralph-triage/SKILL.md` returns at least 1 (in the SPLIT path)
- [ ] Manual: Read the SPLIT path in SKILL.md and verify the `save_issue` call includes `workflowState: "Backlog"`

---

## Integration Testing
- [ ] Verify `form-idea` SKILL.md has `workflowState: "Backlog"` in all three issue creation paths
- [ ] Verify `ralph-triage` SKILL.md has `workflowState: "Backlog"` in the SPLIT path `save_issue` call
- [ ] Verify no other SKILL.md files were modified
- [ ] Verify changes match `ralph-split` SKILL.md's existing pattern

## References
- Research GH-514: [2026-03-04-GH-0514-form-idea-workflowstate-fix.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-04-GH-0514-form-idea-workflowstate-fix.md)
- Research GH-515: [2026-03-04-GH-0515-ralph-triage-split-workflowstate-fix.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-04-GH-0515-ralph-triage-split-workflowstate-fix.md)
- Audit: [2026-03-03-GH-0000-state-machine-transition-audit.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-03-GH-0000-state-machine-transition-audit.md)
- Related: [GH-516](https://github.com/cdubiel08/ralph-hero/issues/516) — `create_issue` Status sync fix (separate plan)
