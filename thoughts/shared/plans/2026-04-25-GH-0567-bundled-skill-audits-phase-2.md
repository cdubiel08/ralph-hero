---
date: 2026-04-25
status: draft
type: plan
github_issue: 567
github_issues: [567, 568, 569, 570, 571, 572, 573, 574, 575]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/567
  - https://github.com/cdubiel08/ralph-hero/issues/568
  - https://github.com/cdubiel08/ralph-hero/issues/569
  - https://github.com/cdubiel08/ralph-hero/issues/570
  - https://github.com/cdubiel08/ralph-hero/issues/571
  - https://github.com/cdubiel08/ralph-hero/issues/572
  - https://github.com/cdubiel08/ralph-hero/issues/573
  - https://github.com/cdubiel08/ralph-hero/issues/574
  - https://github.com/cdubiel08/ralph-hero/issues/575
primary_issue: 567
parent_plan: null
tags: [skill-audit, phase-2, ralph-triage, ralph-split, ralph-review, ralph-val, ralph-pr, ralph-merge, status, report, ralph-hygiene, draft, form, iterate, setup, idea-hunt]
---

# Phase 2 Skill Audits — Bundled Implementation Plan

## Prior Work

- builds_on:: [[2026-04-25-GH-0567-ralph-triage-skill-audit]]
- builds_on:: [[2026-04-25-GH-0568-ralph-split-skill-audit]]
- builds_on:: [[2026-04-25-GH-0569-ralph-review-skill-audit]]
- builds_on:: [[2026-04-25-GH-0570-pipeline-tail-skills-audit]]
- builds_on:: [[2026-04-25-GH-0571-status-report-audit]]
- builds_on:: [[2026-04-25-GH-0572-ralph-hygiene-audit]]
- builds_on:: [[2026-04-25-GH-0573-draft-form-iterate-audit]]
- builds_on:: [[2026-04-25-GH-0574-setup-skills-audit]]
- builds_on:: [[2026-04-25-GH-0575-specialty-skills-audit]]
- tensions:: None identified.

## Overview

Nine related skill audit issues from the Phase 2 audit epic (#566), bundled into a single PR for atomic implementation. Each phase covers one audit ticket and applies the recommended content/structure improvements identified during research.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-567 | Audit ralph-triage skill | S |
| 2 | GH-568 | Audit ralph-split skill | S |
| 3 | GH-569 | Audit ralph-review skill | S |
| 4 | GH-570 | Audit ralph-val/ralph-pr/ralph-merge skills | S |
| 5 | GH-571 | Audit status & report skills | S |
| 6 | GH-572 | Audit ralph-hygiene skill | XS |
| 7 | GH-573 | Audit draft/form/iterate skills | S |
| 8 | GH-574 | Audit setup/setup-repos skills | XS |
| 9 | GH-575 | Audit idea-hunt/record-demo/design-system-audit skills | S |

**Why grouped**: All nine issues are children of the Phase 2 skill audit epic (#566) and were researched in parallel. Each operates on a distinct set of `SKILL.md` files (and a small number of agent/hook files), so phases are largely independent and can be executed in any order. Grouping enables a single review/merge cycle and consistent application of audit recommendations.

## Shared Constraints

These constraints apply to **all** phases.

### Skill audit principles

1. **Phase 1 systemic fixes are already shipped** (PR #565) — Task→Agent rename, missing MCP tools in `allowed-tools`, and interactive/autonomous description confusion. Do NOT repeat those fixes; this plan layers content-quality improvements on top.
2. **No fragment extraction in this plan** — that work belongs to #840-843. If a phase's research notes a duplication candidate (e.g., Link Formatting, branch verify, team reporting), record it as a follow-up comment on the relevant fragment-extraction issue but do NOT extract here. Each phase keeps its skill self-contained.
3. **Frontmatter conventions** — for `user-invocable: false` skills, descriptions should not use "Use when you want to..." phrasing (that is user-facing). For user-invocable skills, the description's trigger phrases drive natural-language matching.
4. **Allowed-tools hygiene** — remove dead tool entries (tools listed but never referenced in the skill body). The agent definition's `tools:` field is the runtime allowlist; the skill's `allowed-tools` should mirror what the body actually uses.
5. **No MCP server changes in this plan** — research findings that require GraphQL query changes, schema extensions, or new MCP tools are out of scope. They become follow-up issues. This plan is content-only edits to `.md` files plus narrowly scoped hook script edits.

### File ownership

Each phase exclusively writes its listed files. Phases that touch shared files (`escalation-steps.md` is `!cat`-included by all skills but never edited here) declare their dependencies. The vast majority of phases have **no cross-phase file overlap** because each audits a distinct skill directory.

### Verification expectations

- Every phase verifies edits with `grep` on the modified files to confirm the changes landed.
- For phases that edit hook shell scripts, run `bash -n <script>` to syntax-check.
- No automated test suite covers SKILL.md content. The MCP server's `npm test` is unaffected by these edits.

### Eval scenarios

Each research doc identified the need for 2-3 eval scenarios per skill. Per the audit process in #566, **creating eval scenario documents is in scope** for each phase but **executing them is out of scope** (manual runs are tracked separately). Eval files land at `plugin/ralph-hero/skills/<skill-name>/eval-scenarios.md`.

## Current State Analysis

The Phase 2 audit research surfaced several common themes across all nine skills:

1. **Description phrasing drift**: Many `user-invocable: false` skills still use "Use when you want to..." phrasing copied from user-invocable patterns.
2. **Stale references**: Multiple skills reference closed/delivered GH issues (GH-139, GH-158) as if they were unresolved.
3. **Stale tool references**: `advance_issue`, `advance_parent`, and `Task` (as deprecated alias for `Agent`) appear in allowed-tools and hook matchers despite no longer existing in the MCP server or being replaced.
4. **Postcondition hook ↔ skill body misalignment**: Skills set env vars (e.g., `RALPH_TRIAGE_ACTION`) that postcondition hooks check, but the SKILL.md body never instructs the agent to set them.
5. **Agent tool list narrower than skill allowlist**: Multiple agent files (`triage-agent.md`, `split-agent.md`) declare `tools:` lists that are missing capabilities the skill body requires.
6. **Cross-skill drift**: Patterns that should be uniform (Link Formatting, worktree resolution, code review feedback contract) appear inconsistently. Most are fragment-extraction targets (deferred to #840-843); a few warrant in-place fixes here.
7. **No eval scenarios exist**: Every skill audited has zero eval files. Each phase creates one.

## Desired End State

After all 9 phases ship:

- Every audited skill has accurate `description` phrasing matching its `user-invocable` flag.
- Every audited skill has its `allowed-tools` list trimmed of dead/unused entries and aligned with its agent definition.
- Stale GH references and tool references are removed.
- Postcondition hooks and skill bodies agree on env var contracts (`RALPH_TRIAGE_ACTION`, etc.).
- Each audited skill has an `eval-scenarios.md` document defining 2-3 scenarios for future manual or automated grading.
- Each skill body documents known constraints and follow-up work as inline notes pointing at the appropriate fragment-extraction issue.

### Verification

- [ ] All edited SKILL.md files render cleanly when read by `Read` tool (no YAML frontmatter parse errors).
- [ ] All edited shell scripts pass `bash -n` syntax check.
- [ ] Every audited skill has an `eval-scenarios.md` companion file.
- [ ] No skill description references closed GH issues by number.
- [ ] No skill `allowed-tools` lists reference `advance_issue` or `advance_parent`.

## What We're NOT Doing

- **No fragment extraction** — Link Formatting, branch verify step, team reporting step, worktree resolution, CODE_REVIEW_FEEDBACK contract are all duplicated across skills, but extraction belongs to #840-843. Phases here may add an inline note ("see #841 for planned extraction") but do not extract.
- **No MCP server source changes** — `dashboard-tools.ts` GraphQL query gaps (missing `subIssues { totalCount }`, `blockedBy` always empty), `hygiene.ts` archive confidence improvements, etc. are tracked as separate issues. This plan does not touch `plugin/ralph-hero/mcp-server/src/`.
- **No new agent files** — research recommended creating `ralph-hero:review-critique-agent`. Defer; the AUTO mode prompt fix in Phase 3 is sufficient interim.
- **No eval execution** — `eval-scenarios.md` files are written but not run. Manual eval runs are tracked outside this plan.
- **No skill renames or directory moves** — purely content edits inside existing files.

## Implementation Approach

Phases 1-9 each produce a discrete unit of work covering one audit ticket. Most phases are file-disjoint and can run in parallel. The `depends_on` annotations below capture the (very few) ordering constraints.

**Phase dependency annotations**:
- All 9 phases declare `depends_on: null` because each operates on a distinct set of `SKILL.md` files. There is no shared file across phases. (Hooks scripts touched by Phase 1 and Phase 4 are different files: Phase 1 edits `triage-postcondition.sh`, Phase 4 edits `merge-state-gate.sh`.)
- Phases can be dispatched in parallel. The orchestrator may serialize for review-flow simplicity but no functional dependency exists.

---

## Phase 1: GH-567 — ralph-triage skill audit

- **depends_on**: null

### Overview

Apply content-quality improvements to the ralph-triage skill: align skill body with postcondition hook contract (RALPH_TRIAGE_ACTION), expand triage-agent's tool list to match SKILL.md allowed-tools, add RE-ESTIMATE to the postcondition hook, fix description phrasing for `user-invocable: false`, clarify Step 2 ordering, and create eval scenarios.

### Tasks

#### Task 1.1: Update ralph-triage SKILL.md content quality
- **files**: `plugin/ralph-hero/skills/ralph-triage/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Description rewritten to remove "Use when you want to..." phrasing per research finding line 30 — replace with autonomous-skill phrasing (e.g., "Autonomous backlog groomer — picks oldest untriaged Backlog issue, assesses validity, closes duplicates, splits large tickets, or routes to research. For orchestrator dispatch only.")
  - [ ] Step 5 (Take Action) gains an explicit instruction: "Before completing, set `RALPH_TRIAGE_ACTION=<RESEARCH|SPLIT|CLOSE|KEEP|HUMAN|CANCEL|RE-ESTIMATE>` via Bash to signal the postcondition hook." (addresses research finding line 62, Issue 2)
  - [ ] Step 2 issue selection query specifies `orderBy: "CREATED_AT"` ascending direction explicitly (addresses research finding line 79, Issue 4)
  - [ ] Step 7 (grouping) gains a "best-effort within time budget" note (addresses research finding line 85, Issue 6)
  - [ ] CLOSE action branch in Step 5 documents: Done for "already implemented/fixed", Canceled for "no longer relevant" (addresses research recommendation line 155)
  - [ ] RESEARCH and CLOSE action branches gain error-handling guidance matching the existing SPLIT pattern (research finding line 88, Issue 7)
  - [ ] Inline follow-up note added: "Branch verify, link formatting, team reporting are fragment-extraction candidates — see #840-843"

#### Task 1.2: Expand triage-agent tools list
- **files**: `plugin/ralph-hero/agents/triage-agent.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `tools:` field gains `Task`, `Agent`, `WebSearch`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_issue`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_sub_issue`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_dependency` (addresses research finding lines 64-77, Issue 3)
  - [ ] After edit, `grep "Agent" plugin/ralph-hero/agents/triage-agent.md` returns at least one match for the tools field
  - [ ] After edit, `grep "create_issue" plugin/ralph-hero/agents/triage-agent.md` returns a match

#### Task 1.3: Add RE-ESTIMATE to triage-postcondition hook
- **files**: `plugin/ralph-hero/hooks/scripts/triage-postcondition.sh` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] The accepted-actions regex/case matcher updated from `RESEARCH|SPLIT|CLOSE|KEEP|HUMAN|CANCEL` to `RESEARCH|SPLIT|CLOSE|KEEP|HUMAN|CANCEL|RE-ESTIMATE` (addresses research finding line 42, Issue 1)
  - [ ] `bash -n plugin/ralph-hero/hooks/scripts/triage-postcondition.sh` passes
  - [ ] `grep "RE-ESTIMATE" plugin/ralph-hero/hooks/scripts/triage-postcondition.sh` returns a match

#### Task 1.4: Create ralph-triage eval scenarios
- **files**: `plugin/ralph-hero/skills/ralph-triage/eval-scenarios.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File contains 3 scenarios per research lines 117-130: Scenario A (Duplicate detection / CLOSE), Scenario B (Valid new feature / RESEARCH), Scenario C (Large scope / SPLIT)
  - [ ] Each scenario has Input, Expected Behavior, Assertions sections
  - [ ] File begins with frontmatter (`type: eval-scenarios`, `skill: ralph-triage`, `date: 2026-04-25`)

### Phase Success Criteria

#### Automated Verification:
- [ ] `bash -n plugin/ralph-hero/hooks/scripts/triage-postcondition.sh` — exit 0
- [ ] `grep -c "RALPH_TRIAGE_ACTION" plugin/ralph-hero/skills/ralph-triage/SKILL.md` >= 1
- [ ] `test -f plugin/ralph-hero/skills/ralph-triage/eval-scenarios.md` — exit 0

#### Manual Verification:
- [ ] Description reads naturally for an orchestrator-dispatched skill
- [ ] Eval scenarios are concrete enough to be graded by a reviewer

**Creates for next phase**: nothing — phases are independent.

---

## Phase 2: GH-568 — ralph-split skill audit

- **depends_on**: null

### Overview

Fix tool discrepancy between split-agent and SKILL.md, extend the split strategy table to cover non-code patterns (skill audits, fragment extraction, doc updates), add a research-notes-to-child-body step, raise the time constraint, calibrate escalation threshold, and strengthen the estimate gate. Create eval scenarios.

### Tasks

#### Task 2.1: Update ralph-split SKILL.md content quality
- **files**: `plugin/ralph-hero/skills/ralph-split/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Step 5 split strategy table gains 3-4 rows for non-code patterns (skill-audit, fragment-extraction, doc-update, cross-cutting-refactor) per research recommendation lines 144-148
  - [ ] New step inserted between Step 8 and Step 9 titled "Research notes to affected children": instructs agent to embed any relevant research-phase notes into individual child bodies, not just parent comments (addresses research finding line 103 / Option B)
  - [ ] Time constraint raised from "10 minutes" to "20 minutes" with note that Step 4 codebase research is optional if issue body is explicit (research recommendation line 159)
  - [ ] Escalation threshold ">5 issues" replaced with "escalate if you cannot identify natural decomposition boundaries" (research finding line 124, Option E)
  - [ ] Step 1 ordering clarification: "oldest" specified as `orderBy: "CREATED_AT"` ascending (addresses research finding line 105)
  - [ ] Inline follow-up note for fragment-extraction candidates pointing at #840-843

#### Task 2.2: Sync split-agent tools with SKILL.md allowed-tools
- **files**: `plugin/ralph-hero/agents/split-agent.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `tools:` field gains `mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment` and `mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues` (addresses research finding line 74, Section "Agent Definition vs SKILL.md Discrepancy")
  - [ ] `grep "create_comment" plugin/ralph-hero/agents/split-agent.md` returns a match

#### Task 2.3: Strengthen split-estimate-gate hook
- **files**: `plugin/ralph-hero/hooks/scripts/split-estimate-gate.sh` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Hook is no longer a pure passthrough — it parses the get_issue response payload (or post-tool output) and blocks if the fetched issue's `estimate` is `XS` or `S` (matching `RALPH_MIN_ESTIMATE=M` semantic) (addresses research finding line 67 and recommendation line 182)
  - [ ] `bash -n plugin/ralph-hero/hooks/scripts/split-estimate-gate.sh` passes
  - [ ] Existing allow-with-context message preserved for valid M/L/XL issues

#### Task 2.4: Create ralph-split eval scenarios
- **files**: `plugin/ralph-hero/skills/ralph-split/eval-scenarios.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File contains 3 scenarios: (A) Code split (M API endpoint into 3 children), (B) Skill audit split (M-or-larger audit issue into per-skill children — pattern from #566), (C) Fragment extraction split (M doc-refactor into per-fragment children — pattern from #576)
  - [ ] Each scenario has Input, Expected Behavior, Assertions sections
  - [ ] Frontmatter present

### Phase Success Criteria

#### Automated Verification:
- [ ] `bash -n plugin/ralph-hero/hooks/scripts/split-estimate-gate.sh` — exit 0
- [ ] `grep -c "skill-audit\|fragment-extraction" plugin/ralph-hero/skills/ralph-split/SKILL.md` >= 1
- [ ] `test -f plugin/ralph-hero/skills/ralph-split/eval-scenarios.md` — exit 0

#### Manual Verification:
- [ ] New split-strategy table rows are concrete and actionable
- [ ] Estimate gate blocks XS/S issues correctly when tested manually

**Creates for next phase**: nothing.

---

## Phase 3: GH-569 — ralph-review skill audit

- **depends_on**: null

### Overview

Fix the ralph-review AUTO mode critique prompt to include the missing Dispatchability dimension and Task Metadata Requirements, fix the commit message syntax bug, add ESCALATE to the JSON outcome schema, add a plan summary display step to INTERACTIVE mode, and add free-text capture to rejection flow. Remove vestigial Task tool. Create eval scenarios.

### Tasks

#### Task 3.1: Update ralph-review SKILL.md content quality
- **files**: `plugin/ralph-hero/skills/ralph-review/SKILL.md` (modify)
- **tdd**: false
- **complexity**: high
- **depends_on**: null
- **acceptance**:
  - [ ] AUTO mode subagent prompt (around line 224-264) extended to include Dispatchability dimension and Task Metadata Requirements table sourced from `plugin/ralph-hero/skills/shared/quality-standards.md` (addresses research Discovery 1, lines 49-71)
  - [ ] AUTO mode JSON outcome schema gains `ESCALATE` verdict alongside `APPROVED` and `NEEDS_ITERATION` (addresses research Discovery 3, lines 92-103)
  - [ ] AUTO mode commit message bash block (around lines 251-254) fixed: closing single-quote added before `git push origin main` (addresses research Discovery 10, lines 164-181)
  - [ ] INTERACTIVE mode (Step 4A, around lines 144-162) gains a plan-summary display step before the verdict picker: shows plan title, phase count, top-level success criteria (addresses research Discovery 4, lines 105-114)
  - [ ] INTERACTIVE rejection/major-changes flow (around lines 182-217) gains a free-text feedback field after the multi-select category picker (addresses research Discovery 5, lines 119-124)
  - [ ] `Task` removed from `allowed-tools` frontmatter — `Agent` is the canonical sub-agent dispatcher (addresses research Discovery 7, lines 142-146)
  - [ ] Inline follow-up note: "Consider creating ralph-hero:review-critique-agent — see future ticket"

#### Task 3.2: Clean up review-agent tools list (optional)
- **files**: `plugin/ralph-hero/agents/review-agent.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] No change required if `Task` is already absent — verify with `grep "Task" plugin/ralph-hero/agents/review-agent.md` returns nothing in the tools field
  - [ ] If `Task` is present in tools, remove it (research line 256)

#### Task 3.3: Create ralph-review eval scenarios
- **files**: `plugin/ralph-hero/skills/ralph-review/eval-scenarios.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File contains 3 scenarios: (A) AUTO mode approves a well-formed plan, (B) AUTO mode flags an undispatchable plan (missing files/tdd/complexity), (C) INTERACTIVE mode captures rich rejection feedback with free-text
  - [ ] Each scenario has Input, Expected Behavior, Assertions sections
  - [ ] Frontmatter present

### Phase Success Criteria

#### Automated Verification:
- [ ] `grep -c "Dispatchability" plugin/ralph-hero/skills/ralph-review/SKILL.md` >= 1
- [ ] `grep -c "ESCALATE" plugin/ralph-hero/skills/ralph-review/SKILL.md` >= 1
- [ ] `grep -c "git commit -m 'docs(review)" plugin/ralph-hero/skills/ralph-review/SKILL.md` — verify the closing quote is present in same line context
- [ ] `test -f plugin/ralph-hero/skills/ralph-review/eval-scenarios.md` — exit 0

#### Manual Verification:
- [ ] AUTO mode prompt is self-contained (no missing context that would force the subagent to re-derive criteria)
- [ ] INTERACTIVE plan summary helps a reviewer who has not opened the plan file

**Creates for next phase**: nothing.

---

## Phase 4: GH-570 — ralph-val / ralph-pr / ralph-merge skill audits

- **depends_on**: null

### Overview

Pipeline tail trio cleanup: remove stale `advance_issue` and `advance_parent` references, remove vestigial `Task` from ralph-val, fix ralph-merge description, enrich ralph-pr PR body template, document the CODE_REVIEW_FEEDBACK contract in ralph-merge, and add a worktree freshness check to ralph-val. Create eval scenarios for all three.

### Tasks

#### Task 4.1: Update ralph-val SKILL.md
- **files**: `plugin/ralph-hero/skills/ralph-val/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `Task` removed from `allowed-tools` (vestigial — research Finding 4, lines 209-213)
  - [ ] Step 4 (Find Worktree, around lines 74-84) gains a `git fetch origin main && git pull --ff-only` instruction before validation runs (research Finding 6, lines 220-223)
  - [ ] Step 5 gains an explicit handler for the case "Phase has no `Automated Verification` section" — agent must record this as PASS-with-warning, not silently skip (research line 38)

#### Task 4.2: Update ralph-pr SKILL.md
- **files**: `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Stale `mcp__plugin_ralph-hero_ralph-github__ralph_hero__advance_issue` removed from `allowed-tools` (research line 70 / Finding 1)
  - [ ] PreToolUse hook matcher in frontmatter updated to drop `ralph_hero__advance_issue` from the matcher pattern (research line 70)
  - [ ] PR body template (Step 5) enriched to include: `## Summary`, `## Plan` (link to plan doc), `## Test plan` checklist, phase count for group issues, and `Closes #NNN` lines (research lines 73-83 / "PR body template")
  - [ ] Inline follow-up note pointing at #840 for Link Formatting fragment extraction (research lines 215-218 / Finding 5)
  - [ ] Step 6 (advance children) clarified with a step distinguishing standalone vs group issues using `list_sub_issues`

#### Task 4.3: Update ralph-merge SKILL.md
- **files**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Stale `mcp__plugin_ralph-hero_ralph-github__ralph_hero__advance_issue` removed from `allowed-tools` (research line 110 / Finding 1)
  - [ ] PreToolUse hook matcher updated to drop `advance_issue` (research lines 16-17 mentioned in Finding 1)
  - [ ] Description (line 3) rewritten from "Merge an approved pull request" to "Merge a pull request after code review — handles review gate, merges, cleans up worktree, moves issues to Done." (research Finding 7, lines 225-228)
  - [ ] CODE_REVIEW_FEEDBACK contract (currently in Step 4 body) extracted into a header block at top of Step 4 with explicit caller-facing semantics: "When auto mode + code review requests changes, this skill outputs `CODE_REVIEW_FEEDBACK` instead of `MERGE BLOCKED` to signal the orchestrator should attempt a fix cycle." (research Finding 3, lines 204-208)
  - [ ] Step 9b (rejection detection) consolidated with Step 5 readiness check to avoid duplicate `gh pr view` calls (research line 136)

#### Task 4.4: Remove dead carve-out from merge-state-gate hook
- **files**: `plugin/ralph-hero/hooks/scripts/merge-state-gate.sh` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `advance_parent` carve-out (around lines 10-12) removed (research Finding 2, lines 200-203)
  - [ ] `bash -n plugin/ralph-hero/hooks/scripts/merge-state-gate.sh` passes
  - [ ] `grep -c "advance_parent" plugin/ralph-hero/hooks/scripts/merge-state-gate.sh` returns 0

#### Task 4.5: Create eval scenarios for ralph-val, ralph-pr, ralph-merge
- **files**: `plugin/ralph-hero/skills/ralph-val/eval-scenarios.md` (create), `plugin/ralph-hero/skills/ralph-pr/eval-scenarios.md` (create), `plugin/ralph-hero/skills/ralph-merge/eval-scenarios.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] ralph-val scenarios: (A) PASS with all checks satisfied, (B) FIX with auto-fix command output, (C) FAIL with substantive criteria gap
  - [ ] ralph-pr scenarios: (A) Standalone PR creation, (B) Group PR with child closes lines, (C) Multi-repo PR set with cross-references
  - [ ] ralph-merge scenarios: (A) APPROVED → merge, (B) auto-mode CHANGES_REQUESTED → CODE_REVIEW_FEEDBACK output, (C) interactive prompt for unreviewed PR
  - [ ] Each file has frontmatter and 3 scenarios with Input/Expected/Assertions

### Phase Success Criteria

#### Automated Verification:
- [x] `bash -n plugin/ralph-hero/hooks/scripts/merge-state-gate.sh` — exit 0
- [x] `grep -c "advance_issue" plugin/ralph-hero/skills/ralph-pr/SKILL.md plugin/ralph-hero/skills/ralph-merge/SKILL.md` returns 0
- [x] `grep -c "advance_parent" plugin/ralph-hero/hooks/scripts/merge-state-gate.sh` returns 0
- [x] `grep -c "CODE_REVIEW_FEEDBACK" plugin/ralph-hero/skills/ralph-merge/SKILL.md` >= 2 (header block + body reference)
- [x] All three eval-scenarios.md files exist

#### Manual Verification:
- [ ] PR body template produces a useful description for both human reviewers and code-review skills
- [ ] Worktree freshness check does not break existing single-agent flows

**Creates for next phase**: nothing.

---

## Phase 5: GH-571 — status & report skills audit

- **depends_on**: null

### Overview

Skill-only fixes to the two read-only ops skills: remove dead allowed-tools entries (Bash, Read), add `Use When` differentiation to status, add `issuesPerPhase` cap, add `user-invocable: true` to status for consistency, and remove the stale GH-139 reference from report's fallback condition. Create eval scenarios.

### Tasks

#### Task 5.1: Update status SKILL.md
- **files**: `plugin/ralph-hero/skills/status/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `Bash` and `Read` removed from `allowed-tools` (research finding "Dead allowed-tools" lines 153-155)
  - [ ] `user-invocable: true` added to frontmatter for consistency (research finding line 162)
  - [ ] Step 2 `pipeline_dashboard` invocation gains `issuesPerPhase: 5` parameter (research finding line 122 — "status has no such guard")
  - [ ] New "## Use When" subsection or inline note added differentiating from `hello`: "Use this skill when the user asks for the raw pipeline view, dashboard snapshot, or board status. For conversational orientation or 'what should I work on next', `hello` is the better fit." (research finding line 78 / Discovery 1)

#### Task 5.2: Update report SKILL.md
- **files**: `plugin/ralph-hero/skills/report/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `Bash` and `Read` removed from `allowed-tools` (research finding lines 153-155)
  - [ ] Step 3 fallback condition rewritten: replace "the metrics library from GH-139 is not yet deployed" with "If the response does not contain a `metrics` field" (research finding lines 105-108 / Discovery 5 stale reference)
  - [ ] No GH-139 reference remains anywhere in the file

#### Task 5.3: Create status & report eval scenarios
- **files**: `plugin/ralph-hero/skills/status/eval-scenarios.md` (create), `plugin/ralph-hero/skills/report/eval-scenarios.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] status scenarios: (A) Markdown default render, (B) JSON format with --json arg, (C) Critical health warnings highlighted
  - [ ] report scenarios: (A) ON_TRACK auto-status, (B) OFF_TRACK auto-status with multiple critical warnings, (C) --status override + --dry-run
  - [ ] Each file has frontmatter and 3 scenarios

### Phase Success Criteria

#### Automated Verification:
- [ ] `grep -c "Bash\|Read" plugin/ralph-hero/skills/status/SKILL.md` for the allowed-tools block specifically — manual check needed
- [ ] `grep -c "GH-139" plugin/ralph-hero/skills/report/SKILL.md` returns 0
- [ ] `grep -c "user-invocable: true" plugin/ralph-hero/skills/status/SKILL.md` >= 1
- [ ] Both eval-scenarios.md files exist

#### Manual Verification:
- [ ] Differentiation guidance helps users choose between `status`, `hello`, and `report`
- [ ] `issuesPerPhase: 5` cap does not truncate small-board outputs unhelpfully

**Creates for next phase**: nothing.

---

## Phase 6: GH-572 — ralph-hygiene skill audit

- **depends_on**: null

### Overview

Remove the stale GH-158 fallback message, restructure workflow to lead with `project_hygiene` (not `pipeline_dashboard`), document WIP limits requirement, and align description phrasing with `user-invocable: false` convention. XS-scoped — content edits only. Create eval scenarios.

### Tasks

#### Task 6.1: Update ralph-hygiene SKILL.md
- **files**: `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Step 3 stale GH-158 fallback message removed (research Finding 1, lines 65-67 — "If the tool is NOT available (expected until #158 is implemented)..." entire conditional dropped)
  - [ ] Workflow reordered: Step 1 → `project_hygiene` (primary), Step 2 → report all hygiene sections, Step 3 → supplement with `pipeline_dashboard` for health warnings only (research Finding 2, lines 69-75 / Approach A item 2)
  - [ ] Configuration block gains note: "WIP violation detection requires `wipLimits` parameter — pass parsed JSON if `RALPH_HYGIENE_WIP_LIMITS` env var is set, otherwise the WIP category will be empty" (research Finding 3 / Approach A item 3)
  - [ ] Description "Use when" phrasing trimmed to match non-user-invocable convention (research Finding 6, lines 93-96)
  - [ ] Inline follow-up note: "Sub-issue guard for archive candidates is a follow-up — see future ticket"

#### Task 6.2: Create ralph-hygiene eval scenarios
- **files**: `plugin/ralph-hero/skills/ralph-hygiene/eval-scenarios.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File contains 3 scenarios: (A) Dry-run with archive candidates present, (B) Auto-archive when threshold exceeded, (C) Project hygiene tool returns full report (stale + orphaned + duplicates)
  - [ ] Each scenario has Input, Expected Behavior, Assertions sections
  - [ ] Frontmatter present

### Phase Success Criteria

#### Automated Verification:
- [ ] `grep -c "GH-158\|#158" plugin/ralph-hero/skills/ralph-hygiene/SKILL.md` returns 0
- [ ] `grep -c "project_hygiene" plugin/ralph-hero/skills/ralph-hygiene/SKILL.md` >= 1 (still referenced in primary step)
- [ ] `test -f plugin/ralph-hero/skills/ralph-hygiene/eval-scenarios.md` — exit 0

#### Manual Verification:
- [ ] Reordered workflow flows naturally
- [ ] WIP limits note is discoverable

**Creates for next phase**: nothing.

---

## Phase 7: GH-573 — draft / form / iterate skills audit

- **depends_on**: null

### Overview

Add explicit `allowed-tools` to draft, add `AskUserQuestion` to form for the Step 4 output-format choice, fix the iterate description ambiguity ("approved plan"), and clarify form's dual-input description. Create eval scenarios.

### Tasks

#### Task 7.1: Update draft SKILL.md
- **files**: `plugin/ralph-hero/skills/draft/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `allowed-tools` field added to frontmatter with `[Write, Agent]` (research Finding 1, lines 79-81 — minimum needed: Write for idea-file save, Agent for optional codebase-locator call)
  - [ ] No other body changes — draft's lightweight inline-question style is intentional per research Finding 9 lines 132-143 and Approach B note ("Recommendation: Skip — draft's markdown-based questions are intentional")

#### Task 7.2: Update form SKILL.md
- **files**: `plugin/ralph-hero/skills/form/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] `AskUserQuestion` added to `allowed-tools` (research Finding 2, lines 83-85 / Approach A item 2)
  - [ ] Step 4 (Choose Output Format) refactored to use `AskUserQuestion` with labeled options (1=GitHub issue, 2=Implementation plan, 3=Research topic, 4=Ticket tree, 5=Keep as refined idea) instead of inline numbered markdown
  - [ ] Description updated to make dual input explicit: "Crystallize draft ideas, research findings, OR inline descriptions into structured GitHub issues, implementation plans, or research topics. Reads idea files, research documents, or accepts inline text..." (research Approach A item 4)

#### Task 7.3: Update iterate SKILL.md
- **files**: `plugin/ralph-hero/skills/iterate/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Description updated: replace "approved plan" with "existing implementation plan in any state" (research Finding 6, lines 113-114 / Approach A item 3)

#### Task 7.4: Create eval scenarios for draft, form, iterate
- **files**: `plugin/ralph-hero/skills/draft/eval-scenarios.md` (create), `plugin/ralph-hero/skills/form/eval-scenarios.md` (create), `plugin/ralph-hero/skills/iterate/eval-scenarios.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] draft scenarios: (A) Inline argument capture, (B) Empty argument with clarifying questions, (C) Idea file with attached context
  - [ ] form scenarios: (A) Form from idea file, (B) Form from research doc, (C) Form from inline description with output choice
  - [ ] iterate scenarios: (A) Iterate via #NNN with comment-discovered plan, (B) Iterate via direct path arg, (C) Plan-not-found hard stop
  - [ ] Each file has frontmatter and 3 scenarios

### Phase Success Criteria

#### Automated Verification:
- [ ] `grep -c "allowed-tools" plugin/ralph-hero/skills/draft/SKILL.md` >= 1
- [ ] `grep -c "AskUserQuestion" plugin/ralph-hero/skills/form/SKILL.md` >= 1
- [ ] `grep -c "approved plan" plugin/ralph-hero/skills/iterate/SKILL.md` returns 0
- [ ] All three eval-scenarios.md files exist

#### Manual Verification:
- [ ] form's structured picker is clear and prevents wrong-option selection
- [ ] iterate description correctly conveys "any plan state" semantics

**Creates for next phase**: nothing.

---

## Phase 8: GH-574 — setup / setup-repos skills audit

- **depends_on**: null

### Overview

Onboarding skills cleanup: fix Canceled state row missing from setup's workflow states table, replace hardcoded `cdubiel08`/`3` defaults with template placeholders, implement the dead `[project-number]` argument-hint recovery path, add `.gitignore` automation, fix setup-repos merge logic data-loss risk, clarify the "verify with MCP tools" framing, add interruption recovery guidance to both. Create eval scenarios.

### Tasks

#### Task 8.1: Update setup SKILL.md
- **files**: `plugin/ralph-hero/skills/setup/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Step 5 Workflow States table (research lines 60-69, file lines 404-419) gains a `Canceled` row matching the 11-state reality
  - [ ] Step 6b-ii repository variables table (file lines 487-497) replaces `cdubiel08` with `[YOUR_PROJECT_OWNER]` and `3` with `[YOUR_PROJECT_NUMBER]` template placeholders (research recommendation 2, lines 184-186)
  - [ ] Step 3 implements the `[project-number]` argument-hint: if a number is provided as argument, skip project creation and verify the existing project (research Finding 3, lines 80-85 / recommendation 3)
  - [ ] Step 5 gains a `.gitignore` automation sub-step: after writing `.claude/ralph-hero.local.md`, check if `.gitignore` exists and append the path if not already present (research Finding 4, lines 87-91 / recommendation 4)
  - [ ] Top-of-skill recovery header added: "If setup was interrupted: run `/ralph-hero:setup [existing-project-number]` to resume from a known project number." (research Finding 14 / recommendation 6)

#### Task 8.2: Update setup-repos SKILL.md
- **files**: `plugin/ralph-hero/skills/setup-repos/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Step 1 "Merge new repos" option: implement actual merge logic in Step 7 — read existing `.ralph-repos.yml`, parse YAML, merge by repo key (new keys appended, existing keys preserved unless explicitly overridden by user input in current session) (research Finding 12, lines 150-156 / recommendation 5)
  - [ ] Step 8 renamed from "Verify with MCP Tools" to "Note on registry load" with explicit text: "Registry is loaded at MCP server startup. To activate the new file, restart Claude Code. The decompose_feature call below shows what the previous registry contained — this is informational only." (research Finding 10, lines 132-140 / recommendation 7)
  - [ ] Top-of-skill recovery header added: "If interrupted mid-session: re-running is safe — no side effects until Step 7 (file write)." (research Finding 14 / recommendation 6)

#### Task 8.3: Create setup & setup-repos eval scenarios
- **files**: `plugin/ralph-hero/skills/setup/eval-scenarios.md` (create), `plugin/ralph-hero/skills/setup-repos/eval-scenarios.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] setup scenarios: (A) Fresh first-time install, (B) Re-run with existing project number argument, (C) Project-scoped vs user-scoped install detection
  - [ ] setup-repos scenarios: (A) Fresh registry creation, (B) Merge into existing registry preserving custom entries, (C) Multi-org repo discovery with `user→organization` fallback
  - [ ] Each file has frontmatter and 3 scenarios

### Phase Success Criteria

#### Automated Verification:
- [x] `grep -c "Canceled" plugin/ralph-hero/skills/setup/SKILL.md` >= 1 (in workflow states table)
- [x] `grep -c "cdubiel08\|RALPH_PROJECT_NUMBER.*= 3" plugin/ralph-hero/skills/setup/SKILL.md` returns 0
- [x] `grep -c "YOUR_PROJECT_OWNER\|YOUR_PROJECT_NUMBER" plugin/ralph-hero/skills/setup/SKILL.md` >= 2
- [x] Both eval-scenarios.md files exist

#### Manual Verification:
- [ ] First-time user can follow setup without hitting hardcoded-default confusion
- [ ] Merge logic in setup-repos preserves existing entries when re-run

**Creates for next phase**: nothing.

---

## Phase 9: GH-575 — idea-hunt / record-demo / design-system-audit skills audit

- **depends_on**: null

### Overview

Specialty skills (Tier 3): add `description` fields to idea-hunt and record-demo (currently missing), reconcile `user-invocable` status with actual interactive behavior, add explicit `allowed-tools` to design-system-audit, add Glob error handling for design-system-audit reference files, document OBS prerequisite as explicit limitation in record-demo, add lister output quality criteria stub for idea-hunt. Create eval scenarios.

### Tasks

#### Task 9.1: Update idea-hunt SKILL.md
- **files**: `plugin/ralph-hero/skills/idea-hunt/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] `description` field added to frontmatter (research Finding 1 / Approach C): "Coordinate a multi-agent GitHub-wide trend hunt — break a topic into search angles, dispatch lister + analyzer worker agents, and synthesize a structured ideas report. For coordinator dispatch via TeamCreate."
  - [ ] `user-invocable` flag reconciled: change to `user-invocable: true` if interactive prompts in workflow are kept, OR remove the prompt and require `topic` argument if `user-invocable: false` is correct. **Decision per research Finding 2 / Approach C**: set `user-invocable: true` (matches the interactive "ask domain or theme" behavior in the body)
  - [ ] Inline note added: "Output quality criteria for github-lister are qualitative; see eval-scenarios.md for grading rubric"

#### Task 9.2: Update record-demo SKILL.md
- **files**: `plugin/ralph-hero/skills/record-demo/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] `description` field added: "Capture an OBS-based screen demo for a GitHub issue — orchestrates obs-cli to record, optionally trim/thumbnail, then upload and post a `## Demo Recording` comment. Requires OBS Studio + obs-cli installed and OBS WebSocket server running."
  - [ ] `user-invocable: true` set (matches the AskUserQuestion-driven interactive flow in Steps 3-5; research Finding 2)
  - [ ] New "## Prerequisites" section near top documents required environment: OBS Studio, obs-cli, WebSocket server enabled, scene configured. Includes link to obs-cli install instructions. Notes: "If OBS is not available, this skill cannot proceed — no fallback capture path is implemented."

#### Task 9.3: Update design-system-audit SKILL.md
- **files**: `plugin/ralph-hero/skills/design-system-audit/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] `allowed-tools` field added to frontmatter: `[Read, Glob, Bash, AskUserQuestion, Write, Agent]` (research Finding 3, lines 167-170 / recommendation 3)
  - [ ] Error handling added: when reading reference files via Glob (`maturity-checklist.md`, `angular-playbook.md`, `figma-hygiene.md`), if Glob returns empty results, surface a clear error: "Design system audit reference files not found at plugin/ralph-hero/skills/design-system-audit/references/. The skill cannot score without the maturity checklist." (research Finding 3 / recommendation 3)
  - [ ] Description not trimmed in this phase (over-triggering risk acknowledged but trim is defer-able; research Finding 5 lists it as optional)

#### Task 9.4: Create eval scenarios for idea-hunt, record-demo, design-system-audit
- **files**: `plugin/ralph-hero/skills/idea-hunt/eval-scenarios.md` (create), `plugin/ralph-hero/skills/record-demo/eval-scenarios.md` (create), `plugin/ralph-hero/skills/design-system-audit/eval-scenarios.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] idea-hunt scenarios with explicit quality criteria per research recommendation 4 (lines 226-228): (A) "AI agents" topic — at least 5 projects discovered, at least 1 with >100 stars, at least 1 emerging (<6 months old), synthesis names >=2 cross-cutting patterns; (B) Niche topic with sparse results — graceful "low-yield" report; (C) Topic dedup — re-running same topic does not report identical repos already surfaced
  - [ ] record-demo scenarios: (A) Standard issue demo recording, (B) OBS not running — graceful failure with setup guidance, (C) Recording + thumbnail + upload via gh release
  - [ ] design-system-audit scenarios: (A) React shadcn project full scoring, (B) Angular project with playbook reference, (C) "No design system at all" fast-track flow
  - [ ] Each file has frontmatter and 3 scenarios

### Phase Success Criteria

#### Automated Verification:
- [ ] `grep -c "^description:" plugin/ralph-hero/skills/idea-hunt/SKILL.md` >= 1
- [ ] `grep -c "^description:" plugin/ralph-hero/skills/record-demo/SKILL.md` >= 1
- [ ] `grep -c "^allowed-tools:" plugin/ralph-hero/skills/design-system-audit/SKILL.md` >= 1
- [ ] All three eval-scenarios.md files exist

#### Manual Verification:
- [ ] idea-hunt and record-demo are now natural-language triggerable
- [ ] design-system-audit fails gracefully when reference files are missing

**Creates for next phase**: nothing.

---

## Integration Testing

- [ ] After all 9 phases land, run `find plugin/ralph-hero/skills -name "eval-scenarios.md" | wc -l` and confirm >= 14 new files (one per audited skill: ralph-triage, ralph-split, ralph-review, ralph-val, ralph-pr, ralph-merge, status, report, ralph-hygiene, draft, form, iterate, setup, setup-repos, idea-hunt, record-demo, design-system-audit = 17 expected)
- [ ] Run `grep -rn "advance_issue\|advance_parent\|GH-139\|GH-158" plugin/ralph-hero/skills/ plugin/ralph-hero/hooks/scripts/` and confirm no false-positive hits remain in the edited files
- [ ] Spot-check that no fragment-extraction work landed inadvertently (no new files in `plugin/ralph-hero/skills/shared/fragments/`)

## Cross-Phase Concerns

1. **No shared file overlap** — the skill audits are file-disjoint by design. Phase 1 (triage) and Phase 4 (val/pr/merge) both touch hook scripts, but distinct ones (`triage-postcondition.sh` vs `merge-state-gate.sh`).
2. **All phases independently dispatchable** — `depends_on: null` for every phase. The orchestrator can parallelize all 9.
3. **Fragment extraction notes** — multiple phases add inline follow-up notes pointing at #840-843 (Link Formatting, branch verify, team reporting, worktree resolution, CODE_REVIEW_FEEDBACK contract). These notes are markdown comments only; no file at `plugin/ralph-hero/skills/shared/fragments/` is created or edited here.
4. **Hook script syntax** — Phases 1, 2, and 4 edit shell scripts. Each phase verifies with `bash -n`. No phase introduces a Bash 4+ feature that would break older shells.
5. **Agent definition edits** — Phases 1 and 2 edit agent files (`triage-agent.md`, `split-agent.md`). These are YAML frontmatter + markdown; no syntax check beyond `Read` round-tripping.
6. **No MCP server changes** — confirmed: no edits to `plugin/ralph-hero/mcp-server/src/`. All findings that need MCP changes (DASHBOARD_ITEMS_QUERY gaps, hygiene archive sub-issue guard, etc.) become follow-up issues.

## References

### Research documents (one per phase)
- https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-25-GH-0567-ralph-triage-skill-audit.md
- https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-25-GH-0568-ralph-split-skill-audit.md
- https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-25-GH-0569-ralph-review-skill-audit.md
- https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-25-GH-0570-pipeline-tail-skills-audit.md
- https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-25-GH-0571-status-report-audit.md
- https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-25-GH-0572-ralph-hygiene-audit.md
- https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-25-GH-0573-draft-form-iterate-audit.md
- https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-25-GH-0574-setup-skills-audit.md
- https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-25-GH-0575-specialty-skills-audit.md

### Related issues
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/566 (Skill audit phase 2)
- Fragment extraction (sibling, deferred to separate work): https://github.com/cdubiel08/ralph-hero/issues/576, #840, #841, #842, #843
- Phase 1 systemic fixes (already merged): PR #565
