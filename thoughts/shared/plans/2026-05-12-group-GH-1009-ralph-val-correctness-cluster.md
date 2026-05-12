---
date: 2026-05-12
status: draft
type: plan
github_issue: 1009
github_issues: [1009, 1010, 1011, 1012]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1009
  - https://github.com/cdubiel08/ralph-hero/issues/1010
  - https://github.com/cdubiel08/ralph-hero/issues/1011
  - https://github.com/cdubiel08/ralph-hero/issues/1012
primary_issue: 1009
tags: [ralph-val, skill-correctness, hooks, validation, postcondition]
---

# ralph-val Correctness Cluster — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-25-GH-0570-pipeline-tail-skills-audit]]
- tensions:: None identified.

## Overview

4 related ralph-val correctness issues for atomic implementation in a single PR. All four address behavioral correctness gaps in the same skill pipeline (`ralph-val`) and touch overlapping files (`skills/ralph-val/SKILL.md`, `hooks/scripts/val-postcondition.sh`, `hooks/scripts/__tests__/val-postcondition.test.sh`).

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1011 | val-postcondition.sh reminder excludes VALIDATION FIX verdict | XS |
| 2 | GH-1012 | SKILL.md Step 4 `git pull --ff-only` doesn't compare against `origin/main` | XS |
| 3 | GH-1010 | Eval FAIL: Scenario A — silent main fallback when worktree missing | S |
| 4 | GH-1009 | Eval FAIL: Scenario C — verdict prefix not "VALIDATION FAIL" + content hallucination | (coordinator; sub-issues #1193/#1194) |

**Why grouped**: All four issues address behavioral correctness gaps in the same `ralph-val` skill pipeline. The fixes touch overlapping files (`skills/ralph-val/SKILL.md`, `hooks/scripts/val-postcondition.sh`, and its test file). Batching them into a single PR avoids three round-trips of plan/impl/review on the same surface and resolves the natural file-conflict graph: every issue mutates SKILL.md and at least one issue mutates `val-postcondition.sh`. The triage comments on #1009 and #1010 explicitly call out this cluster.

GH-1009's body is fully covered by its two atomic sub-issues #1193 (verdict format contract) and #1194 (citation gate). Those sub-issues live in Backlog and are *not* implemented in this plan — they remain on the path through normal triage/research/plan flow. This plan focuses on the three plannable atomic issues (#1011, #1012, #1010) plus the GH-1009 coordinator close-out, since the audit research (`thoughts/shared/research/2026-04-25-GH-0570-pipeline-tail-skills-audit.md`) covers all four. See "What We're NOT Doing" for the explicit boundary.

## Shared Constraints

- **Files in scope**: `plugin/ralph-hero/skills/ralph-val/SKILL.md`, `plugin/ralph-hero/hooks/scripts/val-postcondition.sh`, `plugin/ralph-hero/hooks/scripts/__tests__/val-postcondition.test.sh`. No MCP server (TypeScript) changes.
- **No new MCP tools, no new hooks**: Every change is text/bash. The hook framework is unchanged.
- **Preserve existing terminal verdicts**: `VALIDATION PASS`, `VALIDATION FAIL`, and `Queue empty` already exist in `val-postcondition.sh`. New work adds `VALIDATION FIX` to the accepted set without removing any existing accepted prefix.
- **SKILL.md Step numbering**: Keep the existing step numbers (1, 2, 3, 4, 5, 6, 6.5, 6.6, 7, 8). Insert sub-bullets or short paragraphs within existing steps rather than renumbering.
- **Test discipline**: Every change to `val-postcondition.sh` MUST be paired with a new case in `val-postcondition.test.sh`. Bash linting via `bash -n` is mandatory before commit.
- **Plugin scope**: Edits are confined to `plugin/ralph-hero/`. No changes to `plugin/ralph-knowledge/`, `plugin/ralph-playwright/`, or `plugin/ralph-demo/`.

## Current State Analysis

From the audit research (`thoughts/shared/research/2026-04-25-GH-0570-pipeline-tail-skills-audit.md`) and direct file reads:

**`plugin/ralph-hero/skills/ralph-val/SKILL.md`** (234 lines) already has partial implementations of the contracts referenced by these issues:
- Step 4 (lines 90-112) has a worktree-missing FAIL path AND a freshness check that runs `git fetch origin main && git pull --ff-only`. The freshness check is NEW since the issues were filed but the documented behavior is still ambiguous: `git pull --ff-only` without an explicit refspec pulls from the *tracked upstream*, not from `origin/main`. The intent (per #1012) is "is my feature branch up-to-date with main?" — the command doesn't deliver that.
- Step 7 (lines 184-221) prescribes verdicts of form `VALIDATION [PASS/FIX/FAIL]` with explicit per-check breakdown.
- Step 5 (lines 114-132) has a "Missing Automated Verification" handler that produces a PASS-with-warning.

**`plugin/ralph-hero/hooks/scripts/val-postcondition.sh`** (36 lines) currently:
- Reads the transcript file and greps for `VALIDATION PASS|VALIDATION FAIL|Queue empty`. Exits 0 if any marker found; exits 2 otherwise.
- Reminder string (line 34) lists `VALIDATION PASS, VALIDATION FAIL, or Queue empty` — does NOT mention `VALIDATION FIX`.
- The grep set does NOT include `VALIDATION FIX`, so a legitimate FIX verdict would be rejected by the postcondition hook.

**`plugin/ralph-hero/hooks/scripts/__tests__/val-postcondition.test.sh`** (106 lines) covers 8 cases: stop_hook_active short-circuit, PASS/FAIL/Queue empty acceptance, missing-verdict rejection, missing transcript-path, and nonexistent transcript file. No case for `VALIDATION FIX` accept.

**Scenario A failure (#1010)** — actual: agent emitted `VALIDATION PASS` with `Implementation: Merged to main` substitution. The SKILL.md Step 4 contract for "no worktree" is currently a soft prose instruction without negative-example or explicit "do NOT fall back to main" language. The val-postcondition.sh hook has no way to enforce the contract programmatically because by the time it sees the transcript, the fallback PASS verdict satisfies the grep.

**Scenario C failure (#1009)** — verdict format hallucination is being addressed via sub-issues #1193 + #1194 (separate work). The parent #1009 closes when both sub-issues close. This plan handles the coordinator close-out but does NOT modify SKILL.md Step 7 or add a citation gate (those are #1193 and #1194 scope).

## Desired End State

After this PR merges:

### Verification

- [ ] `val-postcondition.sh` accepts `VALIDATION FIX` as a terminal verdict alongside PASS/FAIL/Queue empty (#1011).
- [ ] The reminder string in `val-postcondition.sh` lists all four accepted verdicts (#1011).
- [ ] SKILL.md Step 4 freshness check explicitly compares the worktree branch against `origin/main` and emits a substantive failure note (or FAIL) when N commits behind (#1012).
- [ ] SKILL.md Step 4 "no worktree" path includes a negative example and the phrase "Do NOT fall back to validating against main" (#1010).
- [ ] `val-postcondition.sh` optionally detects the silent-fallback anti-pattern (PASS verdict + "Merged to main" + no `worktrees/GH-` path) and blocks stop with a contract-violation message (#1010 — additive hardening).
- [ ] All existing `val-postcondition.test.sh` cases still pass.
- [ ] At least one new test case covers `VALIDATION FIX` accept.
- [ ] At least one new test case covers the silent-fallback rejection (#1010 additive case).
- [ ] GH-1009 closes after #1193 and #1194 are themselves implemented (out-of-scope for this PR — close as parent of completed sub-issues OR document the deferral plainly in the close comment).

## What We're NOT Doing

- **Not implementing #1193 (verdict format contract tightening)** — separate ticket in Backlog; scoped to SKILL.md Step 7 negative-example.
- **Not implementing #1194 (citation gate for file-content claims)** — separate ticket in Backlog, blocked by #1193.
- **Not refactoring SKILL.md step structure** — Steps 6.5 / 6.6 remain decimal-numbered.
- **Not extracting fragments** (Link Formatting, worktree resolution, code-review feedback contract) — separate scope per the audit research Option B.
- **Not adding a new MCP tool** — all changes are skill/hook text.
- **Not changing the val-agent's model** (`model: haiku` in `agents/val-agent.md`) — model selection is out of scope for this correctness pass.
- **Not adding new `eval-scenarios.md` content** — the eval scenarios already document the expected behavior; only the implementation needs to catch up.

## Implementation Approach

Four phases ordered from least risk to most risk:

1. **Phase 1 (#1011)** is an XS pure-string edit + 1 test case + 1 grep extension. Smallest unit; lands first to establish the FIX verdict path is real.
2. **Phase 2 (#1012)** is an XS SKILL.md text-only change; replaces the ambiguous `git pull --ff-only` with explicit `rev-list HEAD..origin/main` comparison and documents the intent.
3. **Phase 3 (#1010)** is an S change combining stronger SKILL.md prose (negative example) with additive hook hardening (detect silent-fallback anti-pattern). Builds on Phase 1's hook contract.
4. **Phase 4 (#1009 coordinator close-out)** is a meta-phase: post a closure comment on #1009 explaining that the parent ticket's substantive work was split into #1193 + #1194 and remains tracked in Backlog. #1009 itself moves to Plan in Review with this plan as the artifact.

**Phase dependency annotations** — Phase 2 and Phase 3 both touch SKILL.md Step 4; Phase 3 depends on Phase 2 to avoid merge conflict. Phase 4 depends on Phases 1-3 being PR-ready, since the closure comment references their resolution.

---

## Phase 1: Allow VALIDATION FIX in val-postcondition.sh (GH-1011)
- **depends_on**: null

### Overview

Extend `val-postcondition.sh` to accept `VALIDATION FIX` as a terminal verdict and update the user-facing reminder string. Add a regression test.

### Tasks

#### Task 1.1: Extend grep to accept VALIDATION FIX
- **files**: `plugin/ralph-hero/hooks/scripts/val-postcondition.sh` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Line ~29 grep pattern is `VALIDATION PASS|VALIDATION FIX|VALIDATION FAIL|Queue empty`
  - [ ] Reminder string on line ~34 reads exactly: `Ensure you have produced a VALIDATION PASS, VALIDATION FIX, VALIDATION FAIL, or Queue empty verdict with specific check results before stopping.`
  - [ ] Header comment block (lines 5-9) lists all four accepted markers including FIX
  - [ ] `bash -n plugin/ralph-hero/hooks/scripts/val-postcondition.sh` exits 0

#### Task 1.2: Add VALIDATION FIX regression test
- **files**: `plugin/ralph-hero/hooks/scripts/__tests__/val-postcondition.test.sh` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] New test case (suggested name: "Test case 3b: VALIDATION FIX verdict in transcript -> exit 0") inserted between case 3 (FAIL) and case 4 (Queue empty)
  - [ ] Test asserts exit code 0 when transcript contains `VALIDATION FIX — only mechanical failures`
  - [ ] Final results line still passes (PASS count increments; FAIL stays 0)
  - [ ] `bash plugin/ralph-hero/hooks/scripts/__tests__/val-postcondition.test.sh` exits 0

### Phase Success Criteria

#### Automated Verification:
- [ ] `bash -n plugin/ralph-hero/hooks/scripts/val-postcondition.sh` — no syntax errors
- [ ] `bash plugin/ralph-hero/hooks/scripts/__tests__/val-postcondition.test.sh` — all 9 cases pass

#### Manual Verification:
- [ ] The reminder string echoed to stderr (when no verdict found) contains "VALIDATION FIX" — manual smoke via `echo '{"transcript_path":"/dev/null","stop_hook_active":false}' | bash val-postcondition.sh 2>&1 | grep FIX`

**Creates for next phase**: An updated `val-postcondition.sh` that the Phase 3 silent-fallback detection can extend without re-touching the verdict acceptance code path.

---

## Phase 2: Explicit origin/main comparison in worktree freshness check (GH-1012)
- **depends_on**: [phase-1]

### Overview

Replace the ambiguous `git pull --ff-only` in SKILL.md Step 4 with an explicit `origin/main` comparison and document the intent so future readers don't reintroduce the bug.

### Tasks

#### Task 2.1: Replace freshness-check command block in SKILL.md Step 4
- **files**: `plugin/ralph-hero/skills/ralph-val/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Lines 104-112 (the `**Worktree freshness check**:` paragraph and its bash block) are rewritten to use explicit `origin/main` comparison
  - [ ] The new bash block uses `git fetch origin main` followed by `behind=$(git rev-list --count HEAD..origin/main)` and emits a substantive-failure note when `behind > 0`
  - [ ] The replacement paragraph includes a one-sentence rationale: "We compare against `origin/main` explicitly because `git pull --ff-only` without a refspec pulls from the branch's tracked upstream, not from main."
  - [ ] The "Skip the pull if the worktree branch is detached or if there is no upstream tracking branch" sentence is preserved or adapted
  - [ ] No other steps are renumbered

#### Task 2.2: Verify SKILL.md frontmatter still parses
- **files**: `plugin/ralph-hero/skills/ralph-val/SKILL.md` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] `head -25 plugin/ralph-hero/skills/ralph-val/SKILL.md` shows valid YAML frontmatter (description, user-invocable, allowed-tools, etc. unchanged)
  - [ ] `awk '/^---$/{n++} n==2{exit} {print}' plugin/ralph-hero/skills/ralph-val/SKILL.md | tail -n +2 | head -n -1` returns the same key set as before the edit

### Phase Success Criteria

#### Automated Verification:
- [ ] `bash -n` — N/A (markdown-only change in this phase)
- [ ] `bash plugin/ralph-hero/hooks/scripts/__tests__/val-postcondition.test.sh` — still passes (no hook change in this phase, but regression-check the trio)

#### Manual Verification:
- [ ] In a stale worktree (`git rev-list --count HEAD..origin/main > 0`) the documented command emits the staleness note
- [ ] In a fresh worktree the command exits cleanly with the same flow as before

**Creates for next phase**: An updated SKILL.md Step 4 whose freshness check uses explicit `origin/main` semantics — Phase 3 can layer the "no worktree" negative-example onto this without re-litigating the freshness wording.

---

## Phase 3: Block silent main fallback when worktree missing (GH-1010)
- **depends_on**: [phase-2]

### Overview

Strengthen SKILL.md Step 4's "no worktree" path with a negative example and explicit prohibition of the silent-fallback. Add an additive content-check in `val-postcondition.sh` that blocks stop when the transcript shows PASS-with-Merged-to-main paired with no worktree path.

### Tasks

#### Task 3.1: Tighten SKILL.md Step 4 "no worktree" prose
- **files**: `plugin/ralph-hero/skills/ralph-val/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] The existing "If no worktree found, output: VALIDATION FAIL ..." block (lines 96-102) is preserved verbatim
  - [ ] A new paragraph is inserted immediately after that block (before the freshness check paragraph) reading: `**Do NOT fall back to validating against main.** Do NOT substitute any other path. The "no worktree" condition is a hard stop with VALIDATION FAIL. The following is a forbidden anti-pattern:` followed by a markdown code fence containing the negative example (`Implementation: Merged to main` shown as the kind of substitution that must NOT happen)
  - [ ] The negative example specifically calls out: "no `worktrees/GH-NNN` path printed" + "verdict is `VALIDATION PASS`" as the two signals of the anti-pattern
  - [ ] Step numbering is unchanged

#### Task 3.2: Add silent-fallback detection to val-postcondition.sh
- **files**: `plugin/ralph-hero/hooks/scripts/val-postcondition.sh` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] When the transcript contains `VALIDATION PASS` AND `Merged to main` AND does NOT contain a `worktrees/GH-` path token, the script exits 2 with a stderr message: `Detected silent main fallback: VALIDATION PASS emitted with "Merged to main" and no worktree path. This is a Step 4 contract violation. Emit VALIDATION FAIL with "No worktree found at worktrees/GH-NNN".`
  - [ ] When the transcript contains `VALIDATION PASS` AND `worktrees/GH-` (legitimate validation path), the script still exits 0
  - [ ] When the transcript contains `VALIDATION FAIL` AND `No worktree found` (correct Step 4 path), the script still exits 0
  - [ ] Implementation uses additional `grep -q` invocations layered AFTER the existing terminal-verdict accept and BEFORE the existing exit 0 — the detection is a *conditional rejection* of an otherwise-accepted PASS
  - [ ] `bash -n plugin/ralph-hero/hooks/scripts/val-postcondition.sh` exits 0

#### Task 3.3: Add silent-fallback regression test
- **files**: `plugin/ralph-hero/hooks/scripts/__tests__/val-postcondition.test.sh` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [3.2]
- **acceptance**:
  - [ ] New test case (suggested name: "Test case 9: silent main fallback (PASS + Merged to main + no worktree path) -> exit 2") added after current case 8
  - [ ] Test makes a transcript whose verdict text contains both `VALIDATION PASS` and `Implementation: Merged to main` with no `worktrees/GH-` token
  - [ ] Test asserts exit code 2
  - [ ] Second new test case (suggested name: "Test case 10: legitimate PASS with worktree path -> exit 0") with `VALIDATION PASS` and a `worktrees/GH-820` token; asserts exit 0
  - [ ] `bash plugin/ralph-hero/hooks/scripts/__tests__/val-postcondition.test.sh` exits 0 with PASS count >= 11

### Phase Success Criteria

#### Automated Verification:
- [ ] `bash -n plugin/ralph-hero/hooks/scripts/val-postcondition.sh` — no syntax errors
- [ ] `bash plugin/ralph-hero/hooks/scripts/__tests__/val-postcondition.test.sh` — all ≥11 cases pass

#### Manual Verification:
- [ ] Read SKILL.md Step 4 end-to-end and confirm the "no worktree" prose now reads as a hard contract with the negative example clearly marked as forbidden
- [ ] Simulate the Scenario A failure by piping a fake transcript with `VALIDATION PASS` + `Implementation: Merged to main` + no worktree path into the hook and confirm exit 2 + the contract-violation stderr message

**Creates for next phase**: The cluster's substantive code/text changes are complete. Phase 4 only handles GH-1009 close-out semantics.

---

## Phase 4: Close out GH-1009 coordinator (GH-1009)
- **depends_on**: [phase-3]

### Overview

GH-1009's substantive defects (verdict format hallucination + content hallucination) are tracked as sub-issues #1193 (verdict format) and #1194 (citation gate), both currently in Backlog. This phase posts a coordinator-close comment on #1009 documenting that the parent ticket's resolution path is via its sub-issues and that this PR addressed the adjacent cluster issues. #1009 itself moves to Plan in Review with this plan attached.

### Tasks

#### Task 4.1: Post coordinator-close comment on GH-1009
- **files**: (no files — GitHub API only)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] A `## Coordinator Note` comment is posted on #1009 (via `create_comment`) explaining:
    - This PR addresses the adjacent cluster issues (#1010, #1011, #1012) but does NOT fix the verdict-format / content-hallucination defects described in #1009's body.
    - Those defects are tracked atomically as #1193 (verdict format contract) and #1194 (citation gate), currently in Backlog.
    - GH-1009 will close when #1193 and #1194 both close.
  - [ ] The comment links to this plan path: `thoughts/shared/plans/2026-05-12-group-GH-1009-ralph-val-correctness-cluster.md`

### Phase Success Criteria

#### Automated Verification:
- [ ] Comment was posted (verified by the `create_comment` response containing a `commentId`)

#### Manual Verification:
- [ ] The coordinator comment renders cleanly on the issue and the cross-references to #1193 / #1194 / this plan are clickable

**Creates for next phase**: (final phase — no downstream consumers in this plan)

---

## Integration Testing

- [ ] After all four phases land in the same PR, run `bash plugin/ralph-hero/hooks/scripts/__tests__/val-postcondition.test.sh` from the worktree root — all original 8 cases plus the 3 new cases (VALIDATION FIX accept + 2 silent-fallback cases) pass.
- [ ] `bash -n plugin/ralph-hero/hooks/scripts/val-postcondition.sh` exits 0.
- [ ] Manual rendering: open `plugin/ralph-hero/skills/ralph-val/SKILL.md` in a markdown viewer and confirm Step 4 reads as a coherent step with: (a) worktree-found path, (b) no-worktree FAIL path, (c) negative-example anti-pattern callout, (d) freshness check using explicit `origin/main`.
- [ ] Build/lint: there is no top-level npm script that covers this plugin's bash scripts; the bash test file IS the lint+test for the hook. No TypeScript build is needed because no `.ts` files change.
- [ ] Manual eval rerun: dispatch the val-agent against an issue without a worktree (e.g., GH-820 after worktree was pruned) and confirm the agent now produces `VALIDATION FAIL` with `No worktree found` rather than silently substituting main.

## References

- Issues: https://github.com/cdubiel08/ralph-hero/issues/1009, https://github.com/cdubiel08/ralph-hero/issues/1010, https://github.com/cdubiel08/ralph-hero/issues/1011, https://github.com/cdubiel08/ralph-hero/issues/1012
- Sub-issues tracked separately: https://github.com/cdubiel08/ralph-hero/issues/1193, https://github.com/cdubiel08/ralph-hero/issues/1194
- Research: `thoughts/shared/research/2026-04-25-GH-0570-pipeline-tail-skills-audit.md`
- Eval scenarios: `plugin/ralph-hero/skills/ralph-val/eval-scenarios.md`
- Skill source: `plugin/ralph-hero/skills/ralph-val/SKILL.md`
- Hook source: `plugin/ralph-hero/hooks/scripts/val-postcondition.sh`
- Hook tests: `plugin/ralph-hero/hooks/scripts/__tests__/val-postcondition.test.sh`
