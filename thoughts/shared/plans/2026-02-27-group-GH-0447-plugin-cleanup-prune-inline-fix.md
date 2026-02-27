---
date: 2026-02-27
status: draft
github_issues: [447, 448, 449]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/447
  - https://github.com/cdubiel08/ralph-hero/issues/448
  - https://github.com/cdubiel08/ralph-hero/issues/449
primary_issue: 447
---

# Plugin Cleanup: Prune Hooks, Inline Conventions, Fix Stale References - Atomic Implementation Plan

## Overview
3 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-447 | Plugin cleanup Phase 1: delete orphaned and info-only hook scripts | XS |
| 2 | GH-448 | Plugin cleanup Phase 2: inline conventions.md content into each skill | S |
| 3 | GH-449 | Plugin cleanup Phase 3: fix stale validator references and align agent descriptions | XS |

**Why grouped**: All three issues share parent GH-407 and represent sequential cleanup phases that must land together. Phase 1 removes dead hooks, Phase 2 makes skills self-contained (referencing hook entries cleaned in Phase 1), and Phase 3 fixes stale naming left over from the validator-to-integrator refactor. A single PR keeps the cleanup atomic and avoids intermediate broken states where SKILL.md files reference deleted scripts.

## Current State Analysis

- **58 hook scripts** in `plugin/ralph-hero/hooks/scripts/`, of which 16 are orphaned or info-only
- **34 references** to `shared/conventions.md` across 9 skill files, requiring the model to resolve external file references at runtime
- **4 source files** contain stale `validator-review` / `VALIDATOR PHASE` references from the old validator station that was folded into the integrator
- `hooks.json` registers 9 plugin-level hooks (all blocking, all kept)
- `shared/conventions.md` is 293 lines with 12 named sections

## Desired End State
### Verification
- [ ] Hook script count drops from 58 to 42 (16 deleted)
- [ ] No script in `hooks/scripts/` is unreferenced by hooks.json or SKILL.md frontmatter or agent definitions
- [ ] No entry in SKILL.md frontmatter references a non-existent script
- [ ] `grep -r "conventions.md" plugin/ralph-hero/skills/` returns 0 results
- [ ] `shared/conventions.md` still exists (archival, not deleted)
- [ ] Each modified SKILL.md contains relevant protocol text inline
- [ ] `grep -r "VALIDATOR PHASE\|ralph-validator\|validator-review" plugin/ralph-hero/` (excluding dist/) returns 0 results
- [ ] `npm test` passes
- [ ] `npm run build` passes

## What We're NOT Doing
- Deleting `shared/conventions.md` (retained as archival reference)
- Converting info-only hooks to blocking hooks (out of scope)
- Normalizing all agent descriptions to a rigid template (only fixing the one clear outlier: `record-demo`)
- Adding new hooks or hook functionality
- Changing any MCP server logic beyond the `validator-review` -> `review-queue` profile rename

## Implementation Approach

Phase 1 deletes 16 dead scripts and cleans their SKILL.md frontmatter references. Phase 2 then modifies those same SKILL.md files (now with clean hook sections) to inline conventions.md content, replacing all 34 external references. Phase 3 renames the stale `validator-review` profile and fixes the ASCII diagram in `ralph-hero/SKILL.md`. The phases build naturally: Phase 1 simplifies the hook sections that Phase 2 will edit, and Phase 2 inlines content into files that Phase 3 also touches (ralph-hero/SKILL.md, ralph-review/SKILL.md).

---

## Phase 1: GH-447 - Delete Orphaned and Info-Only Hook Scripts
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/447 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0447-plugin-cleanup-phase1-delete-orphaned-info-only-hooks.md | **Depends on**: none

### Changes Required

#### 1. Delete 8 orphaned scripts
**Directory**: `plugin/ralph-hero/hooks/scripts/`
**Action**: Delete these files (no references anywhere):
- `auto-state.sh` - functionality moved to MCP server
- `debug-hook-counter.sh` - debug-only, never registered
- `plan-no-dup.sh` - overlaps with `pre-artifact-validator.sh`
- `plan-verify-commit.sh` - never wired up
- `plan-verify-doc.sh` - never wired up
- `research-no-dup.sh` - overlaps with `pre-artifact-validator.sh`
- `research-verify-doc.sh` - never wired up
- `state-gate.sh` - superseded by per-skill state gates

#### 2. Delete 8 info-only scripts and remove SKILL.md references
**Action**: Delete each script file AND remove its hook entry from the corresponding SKILL.md frontmatter:

| Script to delete | SKILL.md to update | Hook section |
|-----------------|-------------------|--------------|
| `hygiene-postcondition.sh` | `ralph-hygiene/SKILL.md` | Remove from Stop hooks |
| `report-postcondition.sh` | `ralph-report/SKILL.md` | Remove from Stop hooks |
| `setup-postcondition.sh` | `ralph-setup/SKILL.md` | Remove from Stop hooks |
| `status-postcondition.sh` | `ralph-status/SKILL.md` | Remove from Stop hooks |
| `merge-postcondition.sh` | `ralph-merge/SKILL.md` | Remove from Stop hooks |
| `pr-postcondition.sh` | `ralph-pr/SKILL.md` | Remove from Stop hooks |
| `convergence-gate.sh` | `ralph-plan/SKILL.md` | Remove from Start hooks |
| `impl-verify-pr.sh` | `ralph-impl/SKILL.md` AND `ralph-pr/SKILL.md` | Remove from Stop hooks |

**Important**: `hook-utils.sh` (shared library sourced by 49 scripts), `require-skill-context.sh`, and `worker-stop-gate.sh` must NOT be deleted.

#### 3. Verify hooks.json has no stale references
**File**: `plugin/ralph-hero/hooks/hooks.json`
**Action**: Read and confirm all 9 registered scripts still exist. No changes needed (confirmed by research).

### Success Criteria
- [ ] Automated: `ls plugin/ralph-hero/hooks/scripts/*.sh | wc -l` returns 42 (down from 58, minus 16 deleted)
- [ ] Automated: `grep -r "hygiene-postcondition\|report-postcondition\|setup-postcondition\|status-postcondition\|merge-postcondition\|pr-postcondition\|convergence-gate\|impl-verify-pr" plugin/ralph-hero/skills/` returns 0 results
- [ ] Manual: No orphaned script headers reference deleted files

**Creates for next phase**: Clean SKILL.md files with accurate hook sections, ready for conventions.md inlining.

---

## Phase 2: GH-448 - Inline conventions.md Content Into Each Skill
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/448 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0448-inline-conventions-into-skills.md | **Depends on**: Phase 1

### Changes Required

The 34 references fall into 5 edit patterns. Apply the appropriate pattern for each reference.

#### Pattern A: Section-footer references (12 occurrences)
Replace `See shared/conventions.md for [X].` with the actual section content.

**Escalation Protocol** (inline into 7 skills):
Replace the one-line footer in each skill's `## Escalation Protocol` section with the full escalation table and steps from `conventions.md` lines 57-80:

| Skill file | Approximate location |
|-----------|---------------------|
| `ralph-plan/SKILL.md` | Escalation Protocol section footer |
| `ralph-impl/SKILL.md` | Escalation Protocol section footer |
| `ralph-review/SKILL.md` | Escalation Protocol section footer |
| `ralph-split/SKILL.md` | Escalation Protocol section footer |
| `ralph-hero/SKILL.md` | Escalation Protocol section footer |
| `ralph-research/SKILL.md` | Escalation Protocol section footer |
| `ralph-triage/SKILL.md` | Escalation Protocol section footer |

The inline content for each is the full escalation table:
```markdown
When encountering complexity, uncertainty, or states that don't align with protocol, **escalate via GitHub issue comment** by @mentioning the appropriate person.

| Situation | Action |
|-----------|--------|
| Issue scope larger than estimated | @mention: "This is [M/L/XL] complexity. Needs re-estimation or splitting." |
| Missing context/requirements | @mention: "Cannot proceed. Need clarification on: [specific questions]." |
| Architectural decision needed | @mention: "Multiple valid approaches: [A vs B]. Need guidance." |
| Conflicting existing patterns | @mention: "Found conflicting patterns: [A] vs [B]. Which to follow?" |
| Security concern identified | @mention: "Potential security issue: [description]. Need review." |

**How to escalate:**

1. **Move issue to "Human Needed"**:
   ```
   ralph_hero__update_workflow_state(number, state="__ESCALATE__", command="[current-command]")
   ```
   For group plans, move ALL group issues to "Human Needed".

2. **Add comment with @mention**:
   ```
   ralph_hero__create_comment(number, body="@$RALPH_GH_OWNER Escalation: [issue description]")
   ```

3. **STOP and report**: Issue URL, status "Human Needed", brief reason.
```

**Link Formatting** (inline into 8 skills):
Replace the one-line footer with the formatting table:

| Skill file | Approximate location |
|-----------|---------------------|
| `ralph-plan/SKILL.md` | Link Formatting section footer |
| `ralph-impl/SKILL.md` | Link Formatting section footer |
| `ralph-review/SKILL.md` | Link Formatting section footer |
| `ralph-split/SKILL.md` | Link Formatting section footer |
| `ralph-hero/SKILL.md` | Link Formatting section footer |
| `ralph-research/SKILL.md` | Link Formatting section footer |
| `ralph-triage/SKILL.md` | Link Formatting section footer |
| `implement-plan/SKILL.md` | Link Formatting section or prose note |

The inline content:
```markdown
| Reference type | Format |
|---------------|--------|
| File only | `[path/file.py](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py)` |
| With line | `[path/file.py:42](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42)` |
| Line range | `[path/file.py:42-50](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42-L50)` |
```

**Error Handling** (inline into 1 skill):

| Skill file | Approximate location |
|-----------|---------------------|
| `ralph-plan/SKILL.md` | Error handling footnote |

The inline content:
```markdown
- **Tool call failures**: If `update_workflow_state` returns an error, read the error message -- it contains valid states/intents and a Recovery action. Retry with corrected parameters.
- **State gate blocks**: Hooks enforce valid state transitions. Check the current workflow state and re-evaluate.
- **Postcondition failures**: Stop hooks verify expected outputs. Satisfy the requirement before retrying.
```

#### Pattern B: Parenthetical artifact protocol references (10 occurrences)
These are parenthetical attributions like `(per Artifact Comment Protocol in shared/conventions.md)` where the actual protocol content is already inlined in the skill. Drop the `in shared/conventions.md` suffix or replace with a self-reference like `(per the Artifact Comment Protocol above)`.

| Skill file | Count | Action |
|-----------|-------|--------|
| `ralph-plan/SKILL.md` | 2 | Drop conventions.md reference from Artifact Comment Protocol and Artifact Passthrough mentions |
| `ralph-impl/SKILL.md` | 3 | Drop conventions.md reference from Artifact Comment Protocol mentions and merge conflict escalation |
| `ralph-review/SKILL.md` | 3 | Drop conventions.md reference from Artifact Comment Protocol and Artifact Passthrough mentions |
| `ralph-hero/SKILL.md` | 1 | Replace `see Artifact Passthrough Protocol in shared/conventions.md` with inline explanation |

#### Pattern C: Blockquote Team Isolation trailing links (6 occurrences)
The rule text is already inline in the blockquote. Remove the trailing `See [shared/conventions.md](../shared/conventions.md#sub-agent-team-isolation).` link.

| Skill file | Count |
|-----------|-------|
| `ralph-plan/SKILL.md` | 1 |
| `ralph-review/SKILL.md` | 1 |
| `ralph-split/SKILL.md` | 2 |
| `ralph-research/SKILL.md` | 1 |
| `ralph-triage/SKILL.md` | 1 |

#### Pattern D: Inline passthrough shortcut references (3 occurrences)
The full Artifact Passthrough Protocol logic is already described inline. Drop the `(see [Artifact Passthrough Protocol](../shared/conventions.md#artifact-passthrough-protocol))` parenthetical.

| Skill file | Count |
|-----------|-------|
| `ralph-plan/SKILL.md` | 1 |
| `ralph-impl/SKILL.md` | 1 |
| `ralph-review/SKILL.md` | 1 |

#### Pattern E: Prose references to conventions.md sections by name (3 occurrences)
Replace with inline rule text or drop the reference where the context is already clear.

| Skill file | Reference | Action |
|-----------|-----------|--------|
| `ralph-plan/SKILL.md` | `shared/conventions.md for error handling` | Replace with inline error handling text (Pattern A above) |
| `ralph-impl/SKILL.md` | `per shared/conventions.md` (merge conflict) | Drop the reference; the escalation action is already described inline |
| `create-plan/SKILL.md` | `ADR-001 in shared/conventions.md` | Replace with inline Sub-Agent Team Isolation rule text |

#### 6. Retain conventions.md as archival
**File**: `plugin/ralph-hero/skills/shared/conventions.md`
**Action**: No changes. Keep the file for historical reference.

### Success Criteria
- [ ] Automated: `grep -r "conventions.md" plugin/ralph-hero/skills/` returns 0 results
- [ ] Manual: Each modified SKILL.md contains the relevant protocol text inline (Escalation Protocol, Link Formatting, Error Handling, Team Isolation, etc.)
- [ ] Manual: No SKILL.md lost any behavioral instructions (all convention content preserved inline)

**Creates for next phase**: Self-contained SKILL.md files with no external convention references, ready for final consistency fixes.

---

## Phase 3: GH-449 - Fix Stale Validator References and Align Agent Descriptions
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/449 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0449-fix-stale-validator-references.md | **Depends on**: Phase 1

### Changes Required

#### 1. Rename `validator-review` -> `review-queue` in filter profiles
**File**: `plugin/ralph-hero/mcp-server/src/lib/filter-profiles.ts`
**Line 43**: Change key from `"validator-review"` to `"review-queue"`
```typescript
// Before:
  "validator-review": {
    workflowState: "Plan in Review",
  },

// After:
  "review-queue": {
    workflowState: "Plan in Review",
  },
```

#### 2. Update filter profile tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/filter-profiles.test.ts`
**3 locations** to update:
- Line 38: test description `"validator-review filters to Plan in Review"` -> `"review-queue filters to Plan in Review"`
- Line 39: `FILTER_PROFILES["validator-review"]` -> `FILTER_PROFILES["review-queue"]`
- Line 70: `"validator-review"` in `VALID_PROFILE_NAMES` assertion -> `"review-queue"`

**Note**: The `toHaveLength(6)` count assertion stays unchanged (rename, not add/remove).

#### 3. Update ralph-review skill profile references
**File**: `plugin/ralph-hero/skills/ralph-review/SKILL.md`
**2 locations**:
- Line 71: `profile: "validator-review"` -> `profile: "review-queue"` in the `list_issues` call
- Line 384: table row `validator-review` -> `review-queue` in the Available Filter Profiles table

#### 4. Rename VALIDATOR PHASE in ASCII diagram
**File**: `plugin/ralph-hero/skills/ralph-hero/SKILL.md`
**Line 58**: `VALIDATOR PHASE (if RALPH_REVIEW_MODE == "interactive")` -> `REVIEW PHASE (if RALPH_REVIEW_MODE == "interactive")`

#### 5. Add "Use when" to record-demo description (optional alignment)
**File**: `plugin/ralph-hero/skills/record-demo/SKILL.md`
**Action**: Prepend "Use when" clause to the existing description. The current description is `"Record a product demo with narration and attach to a GitHub issue"`. Update to: `"Record a product demo with narration and attach to a GitHub issue. Use when you want to create an annotated showcase of a feature or workflow."` (or similar).

#### 6. Skip ralph-val/SKILL.md
**No changes needed**: `val-postcondition.sh` exists and is correctly wired via skill frontmatter. Research confirmed this is a live, functional hook.

### Success Criteria
- [ ] Automated: `grep -r "VALIDATOR PHASE\|ralph-validator\|validator-review" plugin/ralph-hero/` (excluding dist/) returns 0 results
- [ ] Automated: `npm test` passes (filter-profiles.test.ts)
- [ ] Automated: `npm run build` passes (dist/ regenerates cleanly)
- [ ] Manual: `record-demo/SKILL.md` description includes a "Use when" clause

**Creates for next phase**: N/A (final phase)

---

## Integration Testing
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` - all tests pass (filter profile rename)
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` - clean TypeScript compilation
- [ ] `ls plugin/ralph-hero/hooks/scripts/*.sh | wc -l` returns 42
- [ ] `grep -r "conventions.md" plugin/ralph-hero/skills/` returns 0 results
- [ ] `grep -r "VALIDATOR PHASE\|ralph-validator\|validator-review" plugin/ralph-hero/` (excluding dist/) returns 0 results
- [ ] No SKILL.md frontmatter references a non-existent script in `hooks/scripts/`
- [ ] All 9 scripts in `hooks.json` still exist on disk

## References
- Research (GH-447): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0447-plugin-cleanup-phase1-delete-orphaned-info-only-hooks.md
- Research (GH-448): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0448-inline-conventions-into-skills.md
- Research (GH-449): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0449-fix-stale-validator-references.md
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/407
