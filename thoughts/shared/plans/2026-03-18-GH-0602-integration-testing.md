---
date: 2026-03-18
status: complete
type: plan
tags: [integration-testing, ralph-val, smoke-tests]
github_issue: 602
github_issues: [602, 596]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/602
primary_issue: 602
parent_plan: docs/superpowers/specs/2026-03-15-superpowers-ralph-hero-quality-integration-design.md
---

# Integration Testing & Validation — Implementation Plan (Iteration 2)

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the remaining gaps from the GH-594 epic: enhance `ralph-val` with drift log and cross-phase checks, and update `split-estimate-gate.sh` to document "Plan in Review" as a valid input state.

**Architecture:** Two files change: `ralph-val/SKILL.md` (add two new validation steps + update report format) and `split-estimate-gate.sh` (update context message). Pure markdown/bash changes — no TypeScript.

**Tech Stack:** Markdown (ralph-val), Bash (hook script)

**Spec:** `docs/superpowers/specs/2026-03-15-superpowers-ralph-hero-quality-integration-design.md` Section 9

**Prior iteration status:** Chunks 1 (MCP integration tests), 2 (hook integration tests), and 4 (smoke test scenarios) are complete. Only Chunk 3 (ralph-val enhancements) was skipped. This iteration also adds a fix from GH-596 (split-estimate-gate.sh).

---

## Phase 1: ralph-val Enhancements + split-estimate-gate Fix

### Tasks

#### Task 1.1: Add drift log verification to ralph-val

- **files**: `plugin/ralph-hero/skills/ralph-val/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] SKILL.md contains a `## Step 6.5: Drift Log Verification` section
  - [ ] Section instructs searching issue comments for `## Drift Log — Phase N` headers
  - [ ] Section instructs verifying `DRIFT:` commit messages exist for each drift entry
  - [ ] Section instructs flagging undocumented drift (changed files with no DRIFT: commit)
  - [ ] Section includes a `Drift Analysis` report format example

**Implementation details:**

Insert after the existing Step 6 (`## Step 6: Run Automated Checks`, ends at line 104 of `plugin/ralph-hero/skills/ralph-val/SKILL.md`) and before Step 7 (`## Step 7: Produce Verdict`, line 107):

```markdown
## Step 6.5: Drift Log Verification

Search issue comments (from `ralph_hero__get_issue` response) for `## Drift Log — Phase N` headers.

For each drift log found:
1. Parse drift entries (lines starting with `- DRIFT:` or containing `DRIFT:` prefix)
2. For each minor drift: verify the adaptation is consistent with plan intent
3. For each entry: verify a `DRIFT:` commit message exists in the worktree git log via `git log --oneline | grep "DRIFT:"`
4. Flag any undocumented drift — files in `git diff --name-only [base]..HEAD` that aren't in any task's declared file list AND have no `DRIFT:` commit

Report drift summary:
```
Drift Analysis:
- Phase 1: 2 minor drifts (documented)
- Phase 2: 0 drifts
- Undocumented changes: none
```

If no drift logs exist on the issue, report: `Drift Analysis: No drift logs found (clean implementation)`
```

---

#### Task 1.2: Add cross-phase integration check to ralph-val

- **files**: `plugin/ralph-hero/skills/ralph-val/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] SKILL.md contains a `## Step 6.6: Cross-Phase Integration Check` section
  - [ ] Section is conditional: only runs for multi-phase plans
  - [ ] Section instructs verifying "Creates for next phase" items exist
  - [ ] Section instructs checking imports between phase outputs
  - [ ] Section includes a `Cross-Phase Integration` report format example

**Implementation details:**

Insert immediately after the Step 6.5 added by Task 1.1, before Step 7:

```markdown
## Step 6.6: Cross-Phase Integration Check (multi-phase plans only)

If the plan has more than one `## Phase N:` section:

1. Verify each phase's "Creates for next phase" items actually exist in the worktree
2. Check imports between phase outputs — if Phase 1 exports types used by Phase 2, verify the import paths resolve
3. Run the plan's `## Integration Testing` section checks if that section exists

Report integration status:
```
Cross-Phase Integration:
- Phase 1 → Phase 2: types.ts exports used correctly ✓
- Phase 2 → Phase 3: parser.ts interface matches ✓
- Integration tests: 3/3 passing ✓
```

If the plan has only one phase, report: `Cross-Phase Integration: Single-phase plan — skipped`
```

---

#### Task 1.3: Update ralph-val report format

- **files**: `plugin/ralph-hero/skills/ralph-val/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [ ] Step 7 verdict output includes `### Drift Analysis:` section
  - [ ] Step 7 verdict output includes `### Cross-Phase Integration:` section
  - [ ] The `## Validation` comment posted in Step 8 includes both new sections

**Implementation details:**

Replace the existing Step 7 verdict output template (lines 113-127 of `plugin/ralph-hero/skills/ralph-val/SKILL.md`) with:

```markdown
```
VALIDATION [PASS/FAIL]
Issue: #NNN
Plan: [plan path]
Worktree: [worktree path]

### Automated Checks:
- [x] npm test — passed (exit 0)
- [x] npm run build — passed (exit 0)
- [x] test -f plugin/ralph-hero/skills/ralph-val/SKILL.md — exists
- [ ] grep "RALPH_COMMAND: \"val\"" ... — MISSING

### Drift Analysis:
- Phase 1: 1 minor drift (documented)
- Undocumented changes: none

### Cross-Phase Integration:
- All phase outputs verified ✓

Verdict: [PASS/FAIL]
[If FAIL: list each failing criterion with specific details]
```
```

---

#### Task 1.4: Update split-estimate-gate.sh context message

- **files**: `plugin/ralph-hero/hooks/scripts/split-estimate-gate.sh` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] The `allow_with_context` message on line 19 mentions "Plan in Review" as a valid input state
  - [ ] Script still sources `hook-utils.sh` and calls `allow_with_context`

**Implementation details:**

In `plugin/ralph-hero/hooks/scripts/split-estimate-gate.sh`, line 19, replace:
```
allow_with_context "Split command requires ticket estimate of M/L/XL. Verify after fetching ticket details."
```
with:
```
allow_with_context "Split command requires ticket estimate of M/L/XL. Valid input states: Backlog, Research Needed, Plan in Review. Verify after fetching ticket details."
```

---

### Phase Success Criteria

#### Automated Verification:
- [ ] `grep -c "Step 6.5" plugin/ralph-hero/skills/ralph-val/SKILL.md` returns 1
- [ ] `grep -c "Step 6.6" plugin/ralph-hero/skills/ralph-val/SKILL.md` returns 1
- [ ] `grep -c "Drift Analysis" plugin/ralph-hero/skills/ralph-val/SKILL.md` returns at least 2
- [ ] `grep -c "Cross-Phase Integration" plugin/ralph-hero/skills/ralph-val/SKILL.md` returns at least 2
- [ ] `grep "Plan in Review" plugin/ralph-hero/hooks/scripts/split-estimate-gate.sh` matches
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` — all passing (no regressions)

#### Manual Verification:
- [ ] ralph-val SKILL.md reads naturally as a coherent workflow (Steps 1-8 with 6.5/6.6 inserted)

---

## Summary of Changes

| File | Type | What Changed |
|------|------|-------------|
| `skills/ralph-val/SKILL.md` | Modified | Added Step 6.5 (drift log verification), Step 6.6 (cross-phase integration check), updated Step 7 verdict format |
| `hooks/scripts/split-estimate-gate.sh` | Modified | Updated context message to document "Plan in Review" as valid input state |
