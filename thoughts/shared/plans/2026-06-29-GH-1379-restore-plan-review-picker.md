---
date: 2026-06-29
status: draft
type: plan
tags: [ralph-plan, plan-review, askuserquestion, slim-plugin, regression]
github_issue: 1379
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1379
primary_issue: 1379
estimate: S
---

# Restore the richer `/ralph:plan --mode review` interactive picker (GH-1379)

## Prior Work

- builds_on:: [[issue-1379]] — the slim-plugin completeness-audit gap (2026-05-23) and the human restore decision (2026-06-27, in the issue's `## Unblock Resolution`).
- builds_on:: reference implementation `plugin/ralph-hero/skills/ralph-review/SKILL.md:158-245` — deleted from the working tree in GH-1438 (commit `ca6a54f0`), recoverable via `git show ca6a54f0~1:plugin/ralph-hero/skills/ralph-review/SKILL.md`.
- tensions:: `ralph/CLAUDE.md` "Substrate is the product" / SKILL.md ≤150-line convention — the restore must add capability without bloating the skill body; the richer flow lives in the `plan-review.md` sibling, not `SKILL.md`.

No linked research doc — S/sub-threshold work, research waived per the XS/S rule in `ralph/CLAUDE.md`.

## Overview

The slim-plugin restructure (Plan 4, `/ralph:plan` fold) collapsed the old 5-label
plan-review picker into the current 4-option prose picker in
`ralph/skills/plan/plan-review.md:89-112` (*Approve / Approve with edits / Reject /
Need more info*). Two capabilities were lost:

1. **The multi-select category sub-flow + free-text capture** — the old "Minor Changes"
   path opened an "Adjustments" multi-select, and the old "Major Changes" / "Reject"
   paths opened an "Issues" multi-select followed by a free-text prompt. The current
   picker has no structured-category or free-text capture at all; feedback shape is a
   bare verdict.
2. **"Open in editor"** — opened the plan file in the system editor and re-looped the
   picker, letting the reviewer read the full plan before deciding.

A human decided (2026-06-27) to **restore** the richer flow rather than accept the
simplification. This plan restores both capabilities by rewriting the
`## Interactive vs auto` section of `plan-review.md` and syncing the one-line picker
summary in `SKILL.md`. No hook or MCP-server changes are required — the underlying
verdict model (APPROVED / NEEDS_ITERATION) and its existing state transitions are
unchanged.

## Current State Analysis

The interactive plan-review picker lives entirely in skill prose; there is no code or
hook that hard-codes the option set, so this is a documentation-surface change.

### Key Discoveries

- **Target surface**: `ralph/skills/plan/plan-review.md:89-112` (`## Interactive vs
  auto`). The interactive branch is lines 91-101; the auto branch (sub-agent delegated
  critique) is lines 103-112 and must stay untouched.
- **One-line summary to sync**: `ralph/skills/plan/SKILL.md:195` restates the picker
  labels inline (*Approve / Approve with edits / Reject / Need more info*). It must match
  whatever labels the restored picker uses or the doc drifts.
- **Verdict → transition model is already broad enough.** `plan-state-gate.sh:48` accepts
  `Plan in Progress, Plan in Review, In Progress, Ready for Plan, Human Needed`, and
  `review-state-gate.sh:22` accepts `In Progress, Ready for Plan, Human Needed`. Both
  the APPROVED (`In Progress`) and NEEDS_ITERATION (`Plan in Progress`) targets are
  already valid — **no hook edits needed.**
- **The old skill already collapsed Major+Reject.** In the reference
  (`plugin/ralph-hero/skills/ralph-review/SKILL.md:200-245`), "Major Changes" and
  "Reject" routed to the *identical* "Issues" multi-select + free-text + rejection flow.
  The only behavioral distinction in the old 5-label picker was 4-way: Approve / Minor /
  (Major≡Reject) / Open-in-editor. This is what lets a faithful restore fit the current
  4-option `AskUserQuestion` cap (`minItems:2, maxItems:4`, plus an auto-provided
  "Other") without losing any behavior.
- **Slim-plugin picker convention is prose, not JSON.** Existing slim skills (e.g. the
  current `plan-review.md`, `review/auto-vs-interactive.md`) describe options in prose +
  routing rules rather than dumping full `AskUserQuestion` JSON. The restore follows that
  convention: describe the picker + sub-flows + routing, keep JSON examples minimal.
- **"Need more info" is dropped by the restore.** It was not in the old reference set;
  the human asked to restore the old set. The reviewer reaches the same outcome by
  opening the editor to read more, or via free-text on the reject path. Documented in
  Migration Notes.

## Desired End State

1. `plan-review.md` `## Interactive vs auto` documents a 4-option primary picker —
   **Approve / Approve with edits (Minor) / Request changes (Major or Reject) / Open in
   editor** — where the "Open in editor" branch opens the plan file and re-loops the
   picker.
2. The "Approve with edits" branch opens an **Adjustments** multi-select (category
   capture) and the "Request changes" branch opens an **Issues** multi-select followed
   by a free-text prompt; both feed structured feedback into the critique doc + GitHub
   comment.
3. Each picker outcome maps explicitly to the existing verdict + transition: Approve and
   Approve-with-edits → APPROVED → `In Progress` (Approve-with-edits also posts a
   `## Recommended Edits` comment); Request changes → NEEDS_ITERATION → `Plan in
   Progress` with categories + free-text in the critique.
4. `SKILL.md:195`'s inline picker-label summary matches the restored labels.
5. The auto branch (`RALPH_REVIEW_PLAN=auto` sub-agent delegation) is unchanged.
6. All CI gates that run on `ralph/` changes pass (hook tests, ShellCheck, doc-roster,
   skill-frontmatter contract).

### Verification

- `grep -n "Open in editor" ralph/skills/plan/plan-review.md` → ≥1 hit (capability
  restored).
- `grep -n "multiSelect" ralph/skills/plan/plan-review.md` → ≥2 hits (Adjustments +
  Issues sub-pickers restored).
- `grep -n "Need more info" ralph/skills/plan/plan-review.md ralph/skills/plan/SKILL.md`
  → 0 hits (old label fully replaced; no drift).
- The `SKILL.md:195` summary lists the same 4 labels as `plan-review.md`.
- Hook tests + ShellCheck + doc-roster + skill-frontmatter test all green.

## What We're NOT Doing

- **No hook changes.** The verdict→transition gates already accept both targets. We are
  not adding a new gate to validate the picker option set (the option set is skill prose;
  there is no machine contract to enforce).
- **No MCP-server / TypeScript changes.** This is a skill-doc-only restore.
- **Not preserving the literal 5 labels.** "Major Changes" and "Reject" are merged into
  one "Request changes" outcome because they were behaviorally identical in the old skill.
  (Migration Notes records the nested-picker fallback if the literal 5 labels are ever
  demanded.)
- **Not restoring "Need more info"** as a separate option — it was not in the restored
  reference set.
- **Not touching the auto / sub-agent delegated critique branch.**

## Implementation Approach

Two tightly-scoped phases. Phase 1 rewrites the `plan-review.md` interactive section to
restore both capabilities, mapping every outcome onto the unchanged verdict model. Phase
2 syncs the one-line `SKILL.md` summary and runs the full local CI-equivalent gate set.
File ownership is disjoint: Phase 1 owns `plan-review.md`, Phase 2 owns `SKILL.md` +
verification.

## Phase 1: Restore the richer interactive picker in `plan-review.md`

depends_on: null

### Overview

Replace the 4-option bare-verdict interactive picker (lines 91-101) with the restored
4-option picker that re-adds the Adjustments/Issues multi-select sub-flows, free-text
capture, and the Open-in-editor loop — each mapped to the existing APPROVED /
NEEDS_ITERATION transitions. Leave the auto branch (lines 103-112) untouched.

### Changes Required

#### 1. `## Interactive vs auto` — interactive branch

**File**: `ralph/skills/plan/plan-review.md`
**Changes**:
- Rewrite the interactive picker (currently lines 91-101) to a 4-option primary picker:
  - **Approve** → write APPROVED critique → `save_issue(workflowState: "In Progress",
    command: "review")`.
  - **Approve with edits** → open an **Adjustments** `multiSelect` sub-picker (categories
    from the reference: *Clarify success criteria / Add missing details / Fix technical
    approach / Update scope boundaries*) → write APPROVED critique, fold the selected
    categories into `## Recommended Changes`, post a `## Recommended Edits` comment →
    advance to `In Progress`.
  - **Request changes** → open an **Issues** `multiSelect` sub-picker (categories from the
    reference: *Insufficient research / Wrong approach / Missing requirements / Scope
    issues*) → then a free-text prompt ("provide specifics the planner must act on; skip
    to use categories only") → write NEEDS_ITERATION critique with free-text as the
    primary feedback and categories as secondary tags → `save_issue(workflowState: "Plan
    in Progress", command: "review")` + post critique as a comment with the gap callouts.
  - **Open in editor** → `open` (macOS) / `xdg-open` (else) the plan's local path, then
    re-present the same primary picker (loop until a verdict is chosen).
- Keep `AskUserQuestion` JSON minimal/prose per slim convention; reference the four
  category labels explicitly so the implementer of a review session has them verbatim.
- Add a short note that "Open in editor" loops and does not itself produce a verdict.
- Preserve the existing **Auto** subsection (sub-agent delegated critique) byte-for-byte.

### Success Criteria

#### Automated Verification
- [ ] `grep -c "multiSelect" ralph/skills/plan/plan-review.md` returns ≥ 2.
- [ ] `grep -c "Open in editor" ralph/skills/plan/plan-review.md` returns ≥ 1.
- [ ] `grep -c "xdg-open" ralph/skills/plan/plan-review.md` returns ≥ 1.
- [ ] `grep -c "Need more info" ralph/skills/plan/plan-review.md` returns 0.
- [ ] `cd mcp-server && npx vitest run src/__tests__/skill-frontmatter.test.ts` passes
      (skill frontmatter contract intact).

#### Manual Verification
- [ ] Each of the 4 outcomes maps to exactly one of the existing transitions (`In
      Progress` for both approve variants, `Plan in Progress` for Request changes); no
      transition references a state outside `plan-state-gate.sh`'s valid set.
- [ ] The Approve-with-edits and Request-changes paths both capture structured categories
      AND (for Request changes) free-text, matching the reference behavior.

## Phase 2: Sync `SKILL.md` summary + run the gate set

depends_on: [phase-1]

### Overview

Update the one-line picker-label summary in `SKILL.md:195` to match the restored labels,
then run the full local CI-equivalent gate set that runs on `ralph/` changes.

### Changes Required

#### 1. `--mode review` step 4 summary line

**File**: `ralph/skills/plan/SKILL.md`
**Changes**:
- Line 195: replace the inline label list *Approve / Approve with edits / Reject / Need
  more info* with the restored set *Approve / Approve with edits / Request changes / Open
  in editor*, keeping the `RALPH_REVIEW_PLAN=auto` clause intact.

### Success Criteria

#### Automated Verification
- [ ] `bash scripts/check-doc-rosters.sh` passes (no roster drift).
- [ ] `find ralph/hooks/scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \)
      -print0 | xargs -0 -n1 bash` all pass (hooks unaffected).
- [ ] `shellcheck -S error ralph/hooks/scripts/*.sh` clean.
- [ ] `cd mcp-server && npx vitest run src/__tests__/skill-frontmatter.test.ts` passes.
- [ ] `grep -n "Need more info" ralph/skills/plan/SKILL.md` returns 0 hits.

#### Manual Verification
- [ ] `SKILL.md:195` label list is identical to the primary-picker labels in
      `plan-review.md`.

## Testing Strategy

### Unit Tests
- No new unit tests — this is a skill-prose restore with no code path. The existing
  `skill-frontmatter.test.ts` guards the frontmatter contract.

### Integration Tests
- The hook test suite (`ralph/hooks/scripts/__tests__`) confirms the review/plan state
  gates still accept the unchanged transitions after the doc edit.

### Manual Testing Steps
1. Read the rewritten `## Interactive vs auto` section end-to-end; confirm every branch
   names a concrete transition and the Open-in-editor branch loops.
2. Cross-check the four Adjustments and four Issues category labels against the reference
   `git show ca6a54f0~1:plugin/ralph-hero/skills/ralph-review/SKILL.md` (lines 195-245).
3. Confirm `SKILL.md:195` and `plan-review.md` agree on the primary labels.

## Migration Notes

- **Behavior is additive for reviewers**; no existing automation depends on the dropped
  "Need more info" label. The auto / sub-agent critique branch is unchanged, so headless
  plan-review (the autopilot path) is unaffected.
- **If the literal 5 labels (Approve / Minor / Major / Reject / Open in editor) are ever
  required**: split the picker into two `AskUserQuestion` calls — a verdict-tier call
  (Approve / Needs changes / Reject / Open in editor) followed by a severity call (Minor /
  Major) — so each stays within the 4-option cap. Recorded here so the merge is reversible
  without re-deriving the constraint.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1379
- Reference implementation: `git show ca6a54f0~1:plugin/ralph-hero/skills/ralph-review/SKILL.md` (lines 158-245)
- Target: `ralph/skills/plan/plan-review.md` (`## Interactive vs auto`), `ralph/skills/plan/SKILL.md:195`
- Transition gates: `ralph/hooks/scripts/plan-state-gate.sh:48`, `ralph/hooks/scripts/review-state-gate.sh:22`
