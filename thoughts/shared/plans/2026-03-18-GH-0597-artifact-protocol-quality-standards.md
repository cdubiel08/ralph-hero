---
date: 2026-03-18
status: draft
type: plan
tags: [quality-standards, artifact-protocol, documentation]
github_issue: 597
github_issues: [597]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/597
primary_issue: 597
parent_plan: docs/superpowers/specs/2026-03-15-superpowers-ralph-hero-quality-integration-design.md
---

# Artifact Protocol & Quality Standards — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Dispatchability quality dimension, plan-of-plans quality dimensions, and document the new Artifact Comment Protocol headers for the tiered planning system.

**Architecture:** Pure documentation changes — `quality-standards.md` is the canonical quality rubric referenced by `ralph-plan` and `ralph-review`. The Artifact Comment Protocol is defined in skill prose (SKILL.md files), not in TypeScript code. This plan modifies one shared document and establishes the protocol reference for Plans 4–6 to implement.

**Tech Stack:** Markdown

**Spec:** `docs/superpowers/specs/2026-03-15-superpowers-ralph-hero-quality-integration-design.md` Sections 5 and 7

---

## Chunk 1: Quality Standards Update

### Task 1: Add Dispatchability dimension to plan quality

**Files:**
- Modify: `plugin/ralph-hero/skills/shared/quality-standards.md:9-12`

- [ ] **Step 1: Read the current file to verify structure**

Run: `cat -n plugin/ralph-hero/skills/shared/quality-standards.md`
Expected: 53 lines, four plan quality dimensions at lines 9–12

- [ ] **Step 2: Add Dispatchability as fifth plan quality dimension**

After line 12 (the Scope dimension), add:

```markdown
5. **Dispatchability** — Every task is self-contained enough to dispatch to a subagent with zero additional context. Task has files, TDD flag, acceptance criteria, and dependency info. No task requires reading the full plan to understand.
```

- [ ] **Step 3: Verify no other files reference quality dimensions by number**

Run: `cd plugin/ralph-hero && grep -rn "four dimensions\|4 dimensions\|dimension 1\|dimension 2\|dimension 3\|dimension 4" skills/ --include="*.md"`
Expected: Any matches need updating to "five dimensions"

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-hero/skills/shared/quality-standards.md
git commit -m "docs(quality): add Dispatchability as fifth plan quality dimension"
```

---

### Task 2: Add plan-of-plans quality dimensions

**Files:**
- Modify: `plugin/ralph-hero/skills/shared/quality-standards.md`

- [ ] **Step 1: Add plan-of-plans section after plan anti-patterns (after line ~28)**

Insert after the plan anti-patterns section:

```markdown

## Plan-of-Plans Quality Dimensions

Plan-of-plans documents (type: plan-of-plans) are evaluated on four dimensions:

1. **Decomposition** — Features are M-sized, independently plannable, with clear boundaries between them.
2. **Dependency clarity** — Wave sequencing is explicit; each feature's inputs and outputs are named with concrete types, files, and interfaces.
3. **Integration** — Strategy for how features compose is concrete with specific shared interfaces, not hand-wavy.
4. **Constraint completeness** — Shared constraints cover patterns, conventions, compatibility requirements, and apply to all child features.

### Plan-of-Plans Anti-Patterns

- Features too large (L/XL) or too small (XS/S) — M is the target
- Dependencies between features left implicit ("Feature B needs Feature A")
- Integration strategy is just "test everything at the end"
- Shared constraints missing — each feature reinvents conventions
- Wave sequencing that doesn't match actual dependency graph
```

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-hero/skills/shared/quality-standards.md
git commit -m "docs(quality): add plan-of-plans quality dimensions"
```

---

### Task 3: Add task metadata documentation to quality standards

**Files:**
- Modify: `plugin/ralph-hero/skills/shared/quality-standards.md`

- [ ] **Step 1: Add task metadata section after plan-of-plans section**

```markdown

## Task Metadata Requirements

Every task within an implementation plan must include these fields to be dispatchable:

| Field | Required | Values | Purpose |
|-------|----------|--------|---------|
| `files` | yes | paths with (create/modify/read) | Scope + parallelism detection + drift tracking |
| `tdd` | yes | `true` / `false` | Planner's decision — test-first or implement directly |
| `complexity` | yes | `low` / `medium` / `high` | Drives implementer model selection |
| `depends_on` | yes | `null` or `[task IDs]` | Enables parallel dispatch |
| `acceptance` | yes | checkbox list | Verifiable criteria checked by task reviewer |

### TDD Flag Guidelines

Set `tdd: true` when:
- Task creates or modifies functions/methods with testable behavior
- Task adds error handling paths
- Task implements business logic

Set `tdd: false` when:
- Pure wiring/configuration (imports, exports, config files)
- Type-only changes (interfaces without logic)
- Migration/scaffolding
- Build/CI configuration changes
```

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-hero/skills/shared/quality-standards.md
git commit -m "docs(quality): add task metadata requirements for dispatchability"
```

---

## Chunk 2: Artifact Comment Protocol Reference

### Task 4: Create artifact comment protocol reference document

**Files:**
- Create: `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md`

- [ ] **Step 1: Write the protocol reference document**

```markdown
# Artifact Comment Protocol

Standard comment headers used to link documents to GitHub issues. All document-producing and document-consuming skills use these headers for discovery.

## Comment Headers

### Existing Headers

| Header | Posted on | Contains | Created by |
|--------|-----------|----------|------------|
| `## Research Document` | Issue | URL to research doc + key findings summary | `ralph-research` |
| `## Implementation Plan` | Issue | URL to plan doc + phase position summary | `ralph-plan` |
| `## Group Implementation Plan` | Group issues | URL to group plan doc | `ralph-plan` |
| `## Validation` | Issue | Validation results (PASS/FAIL per check) | `ralph-val` |
| `## Plan Review` | Issue | VERDICT: APPROVED/NEEDS_ITERATION + critique URL | `ralph-review` |
| `## Implementation Complete` | Issue | PR URL + implementation summary | `ralph-impl` |

### New Headers (Tiered Planning)

| Header | Posted on | Contains | Created by |
|--------|-----------|----------|------------|
| `## Plan of Plans` | Epic issue | URL to plan-of-plans doc, feature list with issue numbers | `ralph-plan-epic` |
| `## Plan Reference` | Atomic issue (parent-planned) | URL to parent plan + `#phase-N` anchor, inherited constraints summary | `ralph-split` (when splitting from a plan) |
| `## Phase N Review` | Issue | Phase code quality review result (APPROVED/NEEDS_FIXES) | `ralph-impl` |
| `## Drift Log — Phase N` | Issue (if drift occurred) | List of adaptations with minor/major severity | `ralph-impl` |
| `## Plan Revision Request` | Sibling or parent issue | What's needed, why current plan doesn't provide it | `ralph-impl` or `ralph-plan-feature` |

## Comment Format Examples

### `## Plan Reference` (posted on atomic children)

```
## Plan Reference

https://github.com/OWNER/REPO/blob/main/thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-feature.md#phase-1

Parent: #NNN (feature issue)
Phase: 1 of 3
Shared constraints inherited from parent plan.
```

### `## Plan of Plans` (posted on feature children)

```
## Plan of Plans

https://github.com/OWNER/REPO/blob/main/thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-epic.md

Parent: #NNN (epic issue)
Feature scope defined in parent plan-of-plans.
```

### `## Phase N Review` (posted after phase code quality review)

```
## Phase 2 Review

Assessment: APPROVED
Strengths: Clean file boundaries, consistent naming
Issues fixed: 1 Important (extracted shared constant)
Minor notes: Consider extracting parser helper in future phase
```

### `## Drift Log — Phase N` (posted if drift occurred during phase)

```
## Drift Log — Phase 1

- `src/types.ts`: Added `timeout` field not in original plan (minor — needed by parser)
- `src/config.ts`: Import path changed from `./util` to `./utils` (minor — file was renamed)

No major drift. All adaptations documented in commit messages with DRIFT: prefix.
```

## Plan Discovery Chain

Skills that consume plan documents use this fallback chain:

1. `knowledge_search(query="implementation plan GH-NNN", type="plan", limit=3)`
2. `--plan-doc` flag (if provided)
3. Artifact Comment Protocol — search issue comments for headers in order:
   a. `## Implementation Plan` (direct plan ownership)
   b. `## Plan Reference` (backreference → follow URL to parent plan, extract phase section + `## Shared Constraints`)
   c. `## Plan of Plans` (for feature-level context only)
4. Glob fallback: `thoughts/shared/plans/*GH-NNN*`
5. Group fallback: `thoughts/shared/plans/*group*GH-NNN*`
6. Stream fallback: `thoughts/shared/plans/*stream*GH-NNN*`
7. Self-heal: if glob found a file, post comment to link it
8. Hard stop: no plan found

When resolving via `## Plan Reference`:
- Extract the URL and phase anchor from the comment
- Read the parent plan document
- Extract the specific phase section matching the anchor
- Also extract `## Shared Constraints` from the plan header
- Optionally: extract `## Integration Strategy` from plan-of-plans if cross-feature work
```

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-hero/skills/shared/artifact-comment-protocol.md
git commit -m "docs(protocol): create artifact comment protocol reference"
```

---

## Final Verification

- [ ] **Verify quality-standards.md is well-formed**

Run: `head -80 plugin/ralph-hero/skills/shared/quality-standards.md`
Expected: All five plan dimensions visible, plan-of-plans dimensions visible, task metadata table visible

- [ ] **Verify artifact-comment-protocol.md exists**

Run: `test -f plugin/ralph-hero/skills/shared/artifact-comment-protocol.md && echo "OK"`
Expected: OK

- [ ] **Run MCP server tests to verify no regressions**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: ALL PASS (these are doc-only changes, no TS impact)

---

## Summary of Changes

| File | Type | What Changed |
|------|------|-------------|
| `skills/shared/quality-standards.md` | Modified | +Dispatchability dimension, +plan-of-plans dimensions, +task metadata requirements |
| `skills/shared/artifact-comment-protocol.md` | Created | Protocol reference for all comment headers + discovery chain documentation |
