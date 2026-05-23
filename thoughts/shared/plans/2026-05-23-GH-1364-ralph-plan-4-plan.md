---
date: 2026-05-23
status: draft
type: plan
tags: [ralph, plugin-restructure, plan, iterate, review, epic, split, migration, plan-of-plans]
github_issue: 1364
github_issues: [1364]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1364
primary_issue: 1364
---

# Plan 4: `/ralph:plan` — Plan Verb Implementation Plan

## Prior Work

- builds_on:: [[2026-05-22-ralph-slim-plugin-restructure]]
- builds_on:: [[2026-05-23-GH-1357-ralph-plan-1-catch-up]] — scaffold + flat-sibling pattern
- builds_on:: [[2026-05-23-GH-1359-ralph-plan-2-form]] — multi-surface fold heuristics (4 references comfortable, 5 if a sub-mode is structurally distinct)
- builds_on:: [[2026-05-23-GH-1362-ralph-plan-3-research]] — SKILL.md frontmatter `hooks:` pattern + slim-plugin scope fixes for ported hooks
- builds_on:: PR #1363 (Plan 3 in review)

## Overview

Largest fold in the migration: six `ralph-hero` skills (`plan`, `ralph-plan`, `ralph-plan-epic`, `iterate`, `ralph-review`, and the epic-decomposition side of `ralph-split`) collapse into one `/ralph:plan` verb with five modes:

| Mode | Source | Role |
|---|---|---|
| (default) | `plan` | Interactive collaborative planning |
| `--mode auto [#NNN]` | `ralph-plan` | Autonomous XS/S, lock → write → advance, hooks-gated |
| `--mode epic [#NNN]` | `ralph-plan-epic` + epic-side of `ralph-split` | Multi-tier strategic decomposition + child creation |
| `--mode iterate [#NNN \| path]` | `iterate` | Surgical refinement of an existing plan |
| `--mode review [#NNN]` | `ralph-review` | APPROVED / NEEDS_ITERATION verdict, gate before impl |

Plan 3 established SKILL.md frontmatter `hooks:` and 5 references. Plan 4 extends both: ~9 hooks to port (with mode-scoping fixes inherited from Plan 3's audit) and 6 references — one more than Plan 3, justified by `--mode epic` and `--mode review` each having their own structurally distinct opinion content.

## Current State Analysis

Six source skills total **2,777 lines** of SKILL.md prose:

| Source | Lines | Shape |
|---|---|---|
| `plugin/ralph-hero/skills/plan/SKILL.md` | 613 | Interactive: context-gathering → research-locator dispatch → Plan Structure Development → Step 5 user review picker → Step 6 GitHub integration |
| `plugin/ralph-hero/skills/ralph-plan/SKILL.md` | 672 | Autonomous: pick issue group → lock → research lookup → write phased plan → advance to "Plan in Review" |
| `plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md` | 351 | Strategic: lock epic → write plan-of-plans doc → create feature children via `add_sub_issue` → orchestrate feature planning in dependency waves |
| `plugin/ralph-hero/skills/iterate/SKILL.md` | 320 | Surgical: read existing plan → understand feedback → confirm approach → update plan in place |
| `plugin/ralph-hero/skills/ralph-review/SKILL.md` | 470 | Critique: read plan → execute review rubric → write review doc → APPROVED (advance to In Progress) / NEEDS_ITERATION (return to Plan in Progress) |
| `plugin/ralph-hero/skills/ralph-split/SKILL.md` (epic side only) | 351 | Decompose M/L/XL → XS children via `decompose_feature` + `add_sub_issue` + `add_dependency` |

`ralph-plan-epic` and `ralph-split`'s epic side overlap heavily — both create parent → children hierarchies with dependency edges. The fold collapses them into `--mode epic`. The atomic-splitting side of `ralph-split` (M/L/XL → S/XS) is a board-grooming activity and goes to Plan 7 (`/ralph:caretake`).

Hooks to consider porting (under `plugin/ralph-hero/hooks/scripts/`):

| Hook | Trigger | Job | Port |
|---|---|---|---|
| `plan-tier-validator.sh` | PreToolUse on `save_issue` | Reject plan creation for non-XS/S issues without `--mode epic` | yes (auto-mode) |
| `plan-state-gate.sh` | PostToolUse on `save_issue` | Validate Plan workflow state transitions | yes (auto-mode) |
| `plan-postcondition.sh` | Stop | Verify a plan doc was written | yes (auto-mode) |
| `plan-research-required.sh` | PreToolUse on Write | Block plan-doc writes when no linked research exists | yes (auto-mode; also enforces in interactive when env is set) |
| `review-state-gate.sh` | PreToolUse on `save_issue` | Validate review workflow state transitions | yes (review-mode) |
| `review-no-dup.sh` | PreToolUse on Write | Block writing a duplicate review doc | yes (review-mode) |
| `review-plan-gate.sh` | PreToolUse on `AskUserQuestion` | Gate the review picker in interactive review | yes (review-mode) |
| `review-postcondition.sh` | Stop | Verify review doc + verdict | yes (review-mode) |
| `review-verify-doc.sh` | PostToolUse on Write | Validate the review doc has required sections + verdict | yes (review-mode) |
| `doc-structure-validator.sh` | Stop | Validate doc sections per command type | already ported in Plan 3; this plan re-uses its `plan)` branch unchanged |
| `branch-gate.sh` | PreToolUse on Bash | Block off-main bash in auto / epic modes | already ported in Plan 3 (no-op when env unset) |
| `lock-release-on-failure.sh` | Stop | Release workflow lock on failure | already ported in Plan 3 |

Total of 7 new hook ports (plus 3 that Plan 3 already shipped). With Plan 3's scope-fix pattern carried forward, each new hook continues to gate on `RALPH_COMMAND` / `RALPH_TICKET_ID` env vars set by SessionStart.

### Key Discoveries

- **Five modes are structurally distinct.** Interactive plan creation, autonomous plan creation, epic decomposition, surgical iteration, and review-with-verdict each have non-overlapping core operations. Sharing the workflow body would be wasteful.
- **`ralph-plan` and `ralph-plan-epic` share the SessionStart env shape** (`RALPH_COMMAND=plan RALPH_REQUIRED_BRANCH=main`). The difference is downstream — epic-mode skips `plan-tier-validator.sh` (epics are L/XL by definition).
- **`ralph-review` has its own SessionStart env shape** (`RALPH_COMMAND=review RALPH_ARTIFACT_DIR=thoughts/shared/reviews`). The slim plugin handles per-mode env by having the workflow body export the var via Bash when entering the mode. Mirror Plan 3's pattern — `set-skill-env.sh` only sets `RALPH_COMMAND=plan` on SessionStart; mode-specific vars (`RALPH_ARTIFACT_DIR`, `RALPH_VALID_INPUT_STATES`, etc.) are set by the mode-specific workflow steps. The hooks gate on what they see.
- **`iterate` does NOT lock or advance state.** It reads an existing plan, updates it, and updates the linked issue's comment — no workflow transition. So iterate doesn't need the state-gate or postcondition hooks. It does still need `RALPH_COMMAND=plan` for `doc-structure-validator.sh` to know which artifact dir to check.
- **The interactive plan flow's Step 5 picker (Approve / Adjust / Restart) is load-bearing UX.** Survives verbatim into default-mode body. `review-plan-gate.sh` exists to enforce that this picker is shown before any save_issue advancing past "Plan in Progress" — confirming the human had a chance to review. The slim plugin keeps this gate.
- **`plan-research-required.sh` is the strictest gate.** It blocks any Write to `thoughts/shared/plans/` unless a corresponding research doc exists at `thoughts/shared/research/...`. Auto and default modes both honor it. Epic mode writes a plan-of-plans which may not have linked research per primary issue — needs a carve-out flag (`RALPH_REQUIRES_RESEARCH=false` for epic-mode invocations, or skip the hook when `RALPH_PLAN_TYPE=epic`).
- **`ralph-plan` Step 3.5 (Parent Plan Reuse Check)** handles the case where a child issue's planning maps to a phase in an existing parent plan — instead of writing a duplicate child plan, post a `## Plan Reference` comment and advance the child to "In Progress" directly. This is a meaningful behavior — preserve in `--mode auto`'s flow.
- **`ralph-plan` Step 6.5 (Split Integration for M issues)** is the only place where the autonomous flow re-routes to ralph-split. In the slim plugin, this becomes "if the issue tier is M after research, escalate to Human Needed" — the slim plugin doesn't call out to the caretake-mode split from inside `/ralph:plan`; that's an orchestrator concern (Plan 8).
- **`ralph-review` interactive mode uses an AskUserQuestion picker** with 4 options (Approve / Approve with edits / Reject / Need more info). Survives into `--mode review`'s body. Auto mode dispatches a sub-agent for delegated critique and produces the same verdict shape — picker is interactive-only.
- **The plan-doc template** (Prior Work / Overview / Current State Analysis / Desired End State / What We're NOT Doing / Implementation Approach / Phase N sections with Success Criteria split into Automated + Manual / Testing Strategy / Performance Considerations / Migration Notes / References) is consistent across the source skills. Move into `plan-shapes.md` reference.
- **The UI Validation Phase** (conditional, ralph-playwright integration) appears in both `plan` and `ralph-plan` but with slightly different shapes. Centralize into `ui-validation-phase.md` reference; both default and auto modes consult it.

## Desired End State

After Plan 4 merges:

1. `/ralph:plan` is discoverable. With no args → prompts for issue / file / description.
2. `/ralph:plan "<description>"` or `/ralph:plan #NNN` → default interactive flow.
3. `/ralph:plan --mode auto [#NNN]` → autonomous XS/S flow.
4. `/ralph:plan --mode epic [#NNN]` → strategic decomposition + child creation.
5. `/ralph:plan --mode iterate [#NNN | path] [feedback]` → surgical update of an existing plan.
6. `/ralph:plan --mode review [#NNN]` → APPROVED / NEEDS_ITERATION verdict on a plan.
7. Old `/ralph-hero:plan`, `/ralph-hero:ralph-plan`, `/ralph-hero:ralph-plan-epic`, `/ralph-hero:iterate`, `/ralph-hero:ralph-review`, `/ralph-hero:ralph-split` (epic side) remain functional. Sunset is Plan 10.
8. `ralph/skills/plan/SKILL.md` ≤ 200 lines (target ~190).
9. Six flat-sibling references: `intake-routing.md`, `plan-shapes.md`, `decomposition.md`, `iteration.md`, `plan-review.md`, `ui-validation-phase.md`.
10. SKILL.md frontmatter `hooks:` block declares 7 plan/review-specific hooks scoped to auto/epic/review modes.
11. `ralph/README.md` migration table → Plan 4 shipped.
12. Friction-log entry appended to spec.

### Verification

- `/plugin marketplace update ralph-hero && /reload-plugins` discovers `/ralph:plan`.
- Five real invocations: default interactive, `--mode auto`, `--mode epic`, `--mode iterate`, `--mode review`.
- `wc -l ralph/skills/plan/SKILL.md` ≤ 200.
- Six reference siblings present, each non-stub.
- Old `/ralph-hero:*` plan-family skills still work.

## What We're NOT Doing

- **Not** absorbing the atomic-splitting side of `ralph-split` (M/L/XL → S/XS). That's board grooming → Plan 7 (`/ralph:caretake --mode split`).
- **Not** porting `remember-turn.sh`. Memory-tier writer is substrate concern, not verb concern.
- **Not** introducing a `--mode interactive` flag. Default is interactive.
- **Not** changing the plan-doc filename convention (`thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-description.md`). Keeps Plan 10 sunset trivial.
- **Not** introducing a separate `--mode split` flag for the epic-decomposition operation. The user types `--mode epic`; the workflow body internally invokes the decomposition primitives that source `ralph-split` exposed. The verb's mode surface stays at 5.
- **Not** wiring `/ralph:plan` → `/ralph:impl` dispatch. That's an orchestrator concern (`/ralph:hero` in Plan 8).
- **Not** porting `finish-review-verdict.sh`. That's a `/ralph:review` concern (Plan 6), not `/ralph:plan --mode review`.
- **Not** sunsetting source skills.

## Implementation Approach

Seven XS-sized phases:

1. **Scaffold + hook ports** owns: `ralph/skills/plan/SKILL.md` stub (frontmatter + mode-dispatch table + Step 0 arg parse), six empty reference stubs, hook ports under `ralph/hooks/scripts/` for the seven new scripts.
2. **Default flow — research + structure** owns: SKILL.md default-mode Steps 1-3 (context-gathering + research + plan structure development), `intake-routing.md` (issue / file / description detection + parent-plan reuse), partial `plan-shapes.md`.
3. **Default flow — write + GitHub + handoff** owns: SKILL.md default-mode Steps 4-6 (detailed writing + Step 5 picker + Step 6 GitHub integration), finish `plan-shapes.md`, `ui-validation-phase.md`.
4. **`--mode auto`** owns: SKILL.md auto-mode body, SKILL.md frontmatter `hooks:` block.
5. **`--mode epic`** owns: SKILL.md epic-mode body, `decomposition.md`.
6. **`--mode iterate` + `--mode review`** owns: SKILL.md iterate-mode + review-mode bodies, `iteration.md`, `plan-review.md`.
7. **Parity validation + dogfooding** owns: `ralph/README.md`, spec friction-log entry.

Only `ralph/skills/plan/SKILL.md` is touched in multiple phases — each appends a section. The reference files are single-owner.

## Phase 1: Scaffold + hook ports

### Overview

Stand up directory + frontmatter + reference stubs + hook ports.

### Changes Required

#### 1. Skill scaffold

`ralph/skills/plan/SKILL.md`:

- Description (covers all 5 modes + natural-language trigger phrases — plan, draft a plan, write a spec, decompose, iterate on, refine, review, critique, approve, reject).
- `argument-hint: "[--mode auto|epic|iterate|review] [<issue-number|file-path|description>] [--playwright|--no-playwright]"`
- `context: inline`, `model: opus`
- `allowed-tools` union covering all five modes.
- `hooks:` block:
  - SessionStart → `set-skill-env.sh RALPH_COMMAND=plan` (slim-plugin no longer sets `RALPH_REQUIRED_BRANCH` at SessionStart; mode-specific workflow steps export it as needed).
  - PreToolUse on Write → `plan-research-required.sh`
  - PreToolUse on `save_issue` → `plan-tier-validator.sh`
  - PreToolUse on `AskUserQuestion` → `review-plan-gate.sh`
  - PostToolUse on `save_issue` → `plan-state-gate.sh`
  - Stop → `plan-postcondition.sh`, `doc-structure-validator.sh`, `lock-release-on-failure.sh`
  - review-mode hooks are wired via the same matchers — they self-gate on `RALPH_COMMAND=review` vs `plan` and on `RALPH_ARTIFACT_DIR`. Since SKILL.md sets `RALPH_COMMAND=plan` globally for this skill, the review-mode hooks need a workflow-body export of `RALPH_COMMAND=review` to activate. Alternatively: keep review-mode hooks separate by matching on the review-doc artifact dir. See Phase 6.
- Body: mode-dispatch table + Step 0 (arg parse).

#### 2. Reference stubs

- `intake-routing.md`, `plan-shapes.md`, `decomposition.md`, `iteration.md`, `plan-review.md`, `ui-validation-phase.md` — `_Filled by Phase N._`

#### 3. Hook ports

Copy from `plugin/ralph-hero/hooks/scripts/`:
- `plan-tier-validator.sh`, `plan-state-gate.sh`, `plan-postcondition.sh`, `plan-research-required.sh`
- `review-state-gate.sh`, `review-no-dup.sh`, `review-plan-gate.sh`, `review-postcondition.sh`, `review-verify-doc.sh`

Apply Plan 3's scope-fix pattern: each script gates on `RALPH_COMMAND` / `RALPH_TICKET_ID` env vars and no-ops when they're unset.

### Success Criteria

#### Automated Verification

- [ ] `test -f ralph/skills/plan/SKILL.md`
- [ ] `[ "$(wc -l < ralph/skills/plan/SKILL.md)" -le 200 ]`
- [ ] All six references present.
- [ ] All seven new hooks present + executable.

#### Manual Verification

- [ ] `/reload-plugins` discovers `/ralph:plan --help`.

---

## Phase 2: Default flow — research + structure

### Overview

Default-mode body Steps 1-3 + intake-routing.md + partial plan-shapes.md.

### Changes Required

#### 1. SKILL.md default-mode Steps 1-3

- **Step 1: Intake** — consult `intake-routing.md`. Detect `#NNN` issue / file path (idea, research doc, existing plan) / inline description. Read mentioned files FULLY.
- **Step 2: Research & discovery** — knowledge-graph prior-art via `knowledge_recall` (planner tier `[reflection, wiki, doc]`); spawn parallel sub-agents (codebase-locator + codebase-analyzer + thoughts-locator + thoughts-analyzer); wait for all.
- **Step 3: Plan structure development** — propose phase shape based on research. Use `AskUserQuestion` to confirm structure with the user before drafting.

#### 2. `intake-routing.md`

- Issue-number / file-path / description detection rules.
- Linked-research check (if planning an issue with no linked research, surface to user — Plan 4 doesn't auto-spawn research, but flags the gap).
- Parent-plan reuse check (Step 3.5 from source `ralph-plan`): if the issue maps to a phase in a parent plan, skip child-plan creation and post a `## Plan Reference` comment.
- Mode-prove-style carve-out: `--mode iterate` and `--mode review` accept either `#NNN` or a path to an existing plan doc.

#### 3. `plan-shapes.md` (partial)

- Plan-doc structure section: frontmatter + Prior Work + Overview + Current State Analysis + Key Discoveries + Desired End State + Verification + What We're NOT Doing + Implementation Approach + Phase N section template.
- Phase-section anatomy: Overview + Changes Required (with file paths) + Success Criteria (Automated + Manual).
- Estimate / complexity decision guide (XS / S — Plan 4 default; M+ goes to epic).

### Success Criteria

#### Automated Verification

- [ ] `[ "$(wc -l < ralph/skills/plan/SKILL.md)" -le 200 ]`
- [ ] `intake-routing.md` non-stub: `[ "$(wc -l < ralph/skills/plan/intake-routing.md)" -ge 40 ]`
- [ ] SKILL.md references both.

#### Manual Verification

- [ ] `/ralph:plan "<description>"` runs research, surfaces structure for review.
- [ ] `/ralph:plan #NNN` fetches the issue + linked research.

---

## Phase 3: Default flow — write + GitHub + handoff + UI validation

### Overview

Default-mode body Steps 4-6 + finish `plan-shapes.md` + `ui-validation-phase.md`.

### Changes Required

#### 1. SKILL.md default-mode Steps 4-6

- **Step 4: Write plan** — generate phased plan doc per `plan-shapes.md`. Filename `thoughts/shared/plans/YYYY-MM-DD-[GH-NNNN-]description.md`.
- **Step 5: User review picker** — `AskUserQuestion` with 4 options (Approve / Approve with edits / Restart / Iterate). Loop on adjust/restart.
- **Step 6: GitHub integration** — post `## Implementation Plan` artifact comment on the issue; update issue frontmatter; advance to "Plan in Review" (interactive flow does NOT auto-advance past this — human approval is the gate).

#### 2. Finish `plan-shapes.md`

- Testing Strategy section template.
- Performance Considerations section template.
- Migration Notes section template.
- References section template.
- Per-mode required-sections matrix (interactive optional, auto required, epic plan-of-plans only requires Strategic Context + Feature Decomposition + Sequencing).

#### 3. `ui-validation-phase.md`

Port the UI Validation Phase template (Task N.1 start dev server → N.2 a11y audit → N.3 e2e stories → N.4 component tests → N.5 visual regression → N.6 UX audit → N.last teardown). Used by default and auto modes.

### Success Criteria

#### Automated Verification

- [ ] `plan-shapes.md` ≥ 80 lines.
- [ ] `ui-validation-phase.md` ≥ 50 lines.

#### Manual Verification

- [ ] `/ralph:plan #NNN` produces a phased plan doc that matches `plan-shapes.md`.
- [ ] Step 5 picker shows; Iterate / Restart loop back.

---

## Phase 4: `--mode auto`

### Overview

Autonomous XS/S flow. Mirrors `/ralph-hero:ralph-plan`.

### Changes Required

#### 1. SKILL.md auto-mode body

Compact list — Plan 3-style:

1. Branch check (workflow body does the check; `branch-gate.sh` reinforces).
2. Select issue — `list_issues(profile: "analyst-plan")` → XS/S → unblocked → highest priority.
3. Lock + research lookup (require linked research; if none, escalate to Human Needed).
4. Parent-plan reuse check (per `intake-routing.md`) — if mapped, post `## Plan Reference` and skip to Step 8.
5. Write plan doc per `plan-shapes.md`. Required: frontmatter, Prior Work, Overview, Phase 1+, Success Criteria.
6. UI Validation Phase (conditional) per `ui-validation-phase.md`.
7. Commit + push.
8. Post `## Implementation Plan` artifact comment, advance to "Plan in Review".
9. Report.

#### 2. Frontmatter hooks already declared in Phase 1; this phase exercises them.

### Success Criteria

#### Automated Verification

- [ ] SKILL.md auto-mode body references `__LOCK__`, `__COMPLETE__`, `Plan in Review`.

#### Manual Verification

- [ ] `/ralph:plan --mode auto` against a real Ready-for-Plan XS issue: locks → writes plan → posts artifact → advances. Hooks fire correctly.

---

## Phase 5: `--mode epic`

### Overview

Strategic multi-tier decomposition. Folds `ralph-plan-epic` + epic-side of `ralph-split`.

### Changes Required

#### 1. SKILL.md epic-mode body

1. Lock epic.
2. Write plan-of-plans doc per `decomposition.md` § Plan-of-plans shape. Required sections: Strategic Context, Shared Constraints, Feature Decomposition, Integration Strategy, Feature Sequencing, What We're NOT Doing.
3. Create feature children via `create_issue` + `add_sub_issue`. Apply dependency edges via `add_dependency` based on the sequencing.
4. Update plan-of-plans with assigned child issue numbers.
5. Optionally orchestrate feature-level planning by dependency waves (delegate to `--mode auto` per child issue when the workflow demands).
6. Transition epic to "Plan in Review" (or "Plan Complete" if substrate has the state).

#### 2. `decomposition.md`

- Plan-of-plans shape (sections + frontmatter).
- Decomposition rules: how to chunk an epic into feature children (3-7 features typical; each XS/S/M depending on substrate).
- Dependency-edge rules: when to use `add_dependency` (sequential phases) vs not (independent features).
- Re-decompose triggers: when an epic was already split and needs re-splitting (existing children stay; new children added).
- M/L/XL → S/XS split rules (formerly `ralph-split`'s epic side): the slim-plugin version focuses on epic → feature, not feature → atomic; atomic splitting is Plan 7.

### Success Criteria

#### Automated Verification

- [ ] `decomposition.md` ≥ 60 lines, includes Plan-of-plans shape + dependency-edge rules.

#### Manual Verification

- [ ] `/ralph:plan --mode epic #NNN` for a real epic: writes plan-of-plans → creates ≥2 feature children with `add_sub_issue` linkage → dependency edges added.

---

## Phase 6: `--mode iterate` + `--mode review`

### Overview

The two short modes that operate on an existing plan doc.

### Changes Required

#### 1. SKILL.md iterate-mode body

1. Resolve plan — `#NNN` → fetch linked plan from issue comments; path → read directly.
2. Read existing plan FULLY (no offset/limit).
3. Understand feedback (from `ARG` or prompt user).
4. Confirm approach via `AskUserQuestion`.
5. Apply surgical updates via Edit / Write. Do NOT rewrite the doc wholesale.
6. Update issue comment with `## Plan Updated` artifact (linking the changed sections).

#### 2. SKILL.md review-mode body

1. Resolve plan + issue.
2. Validate plan exists. If not, escalate to "Human Needed".
3. **Interactive review**: AskUserQuestion picker over 4 options (Approve / Approve with edits / Reject / Need more info). Apply chosen action.
4. **Auto review**: dispatch a sub-agent for delegated critique; produce verdict.
5. Write review doc to `thoughts/shared/reviews/YYYY-MM-DD-GH-NNNN-critique.md` per `plan-review.md`.
6. Execute transition: APPROVED → advance issue to "In Progress"; NEEDS_ITERATION → return to "Plan in Progress" + post critique as comment.

#### 3. `iteration.md`

- Surgical-update principle: prefer Edit over Write; preserve phase numbering; add follow-up sections.
- State preservation: don't change `status:` frontmatter on iterate unless the plan was Draft → Ready.
- Feedback intake heuristics: scope clarification vs new requirement vs correction.

#### 4. `plan-review.md`

- Review rubric: Phase clarity, File ownership, Verification quality (Automated + Manual ratio), Risk coverage, Plan-of-plans alignment for child plans.
- Verdict shape: APPROVED / NEEDS_ITERATION with specific gap callouts.
- Critique-doc structure: Strengths, Gaps, Recommended changes, Verdict, Confidence.
- Interactive picker shape (4 options), auto sub-agent dispatch prompt.

### Success Criteria

#### Automated Verification

- [ ] `iteration.md` ≥ 40 lines.
- [ ] `plan-review.md` ≥ 70 lines; includes APPROVED / NEEDS_ITERATION + rubric.

#### Manual Verification

- [ ] `/ralph:plan --mode iterate <plan-path>` with feedback updates the plan in place.
- [ ] `/ralph:plan --mode review #NNN` produces a verdict doc; APPROVED advances the issue.

---

## Phase 7: Parity validation + dogfooding setup

### Overview

README + friction-log + 5-session parity validation.

### Changes Required

#### 1. README

- `| 4 | \`/ralph:plan\` | shipped |`
- `## Status` paragraph updated.

#### 2. Friction-log on the spec

Append `### Plan 4: /ralph:plan (shipped YYYY-MM-DD)` subsection. Capture: largest-fold-yet stats (6 sources, 5 modes, 6 references, 7+3 hooks); design calls; active-use checkboxes.

#### 3. Parity validation runs

1. `/ralph:plan "<description>"` → default interactive.
2. `/ralph:plan --mode auto` → autonomous.
3. `/ralph:plan --mode epic #NNN` → strategic decomposition.
4. `/ralph:plan --mode iterate <plan-path>` → surgical update.
5. `/ralph:plan --mode review #NNN` → verdict.

### Success Criteria

#### Automated Verification

- [ ] README shows Plan 4 shipped.
- [ ] Friction-log section exists.

#### Manual Verification

- [ ] Five sessions completed successfully.
- [ ] No regressions in any `ralph-hero:*` plan-family skill.

---

## Testing Strategy

### Unit Tests

None — markdown workflow. MCP tools covered by ralph-hero MCP server's existing tests.

### Integration Tests

The 5 parity sessions in Phase 7 are the integration test. Auto-mode session exercises all hooks end-to-end. Epic-mode session exercises `add_sub_issue` + `add_dependency` chains.

### Manual Testing Steps

Per Phase 7's list, plus:

1. Verify auto-mode lock-release path: simulate mid-flow failure; confirm issue returns to "Ready for Plan".
2. Verify epic-mode dependency-graph integrity: created children appear in the correct order via `list_dependencies`.
3. Verify iterate-mode does NOT advance state (preserves Plan in Progress / Plan in Review).
4. Verify review-mode AUTO writes the same critique-doc structure as INTERACTIVE.

## Performance Considerations

- Default flow: ~5 parallel sub-agent dispatches + 1-2 AskUserQuestion + 1 Write. Mirrors source `plan`.
- Auto flow: same dispatch + 2 `save_issue` + 1 `create_comment` + optional `knowledge_record_outcome`. 15-minute budget.
- Epic flow: 1 Write (plan-of-plans) + N `create_issue` + N `add_sub_issue` + N-1 `add_dependency`. Latency scales with N children (typically 3-7).
- Iterate flow: 1-2 Read + 1-3 Edit. Fastest path.
- Review flow: 1 Read (plan) + 1 Write (critique) + 1 picker + 1 `save_issue`. Auto sub-mode adds 1 Agent dispatch.

## Migration Notes

- Source skills remain functional alongside the new verb until Plan 10 batches sunsets after each new counterpart has handled the surfaces it replaces.
- `--mode review` in Plan 4 is distinct from Plan 6's `/ralph:review` verb — Plan 4's is plan-doc review; Plan 6's is code+merge review. The naming is shared but the contexts differ.
- Plan 5 (`/ralph:impl`) consumes plan docs produced here. Schema stability matters; this plan preserves the existing plan-doc shape verbatim.
- Plan 7 (`/ralph:caretake --mode split`) absorbs the atomic-splitting side of `ralph-split`. The epic-decomposition side stays in `/ralph:plan --mode epic`.

## References

- Spec: `thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md` (plan-of-plans row 4 at line 336).
- Plan 3: `thoughts/shared/plans/2026-05-23-GH-1362-ralph-plan-3-research.md` (SKILL.md `hooks:` pattern + slim-plugin hook scope fixes).
- Source skills:
  - `plugin/ralph-hero/skills/plan/SKILL.md` (613)
  - `plugin/ralph-hero/skills/ralph-plan/SKILL.md` (672)
  - `plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md` (351)
  - `plugin/ralph-hero/skills/iterate/SKILL.md` (320)
  - `plugin/ralph-hero/skills/ralph-review/SKILL.md` (470)
  - `plugin/ralph-hero/skills/ralph-split/SKILL.md` (351; epic side only)
- Source hook scripts under `plugin/ralph-hero/hooks/scripts/`: `plan-tier-validator.sh`, `plan-state-gate.sh`, `plan-postcondition.sh`, `plan-research-required.sh`, `review-state-gate.sh`, `review-no-dup.sh`, `review-plan-gate.sh`, `review-postcondition.sh`, `review-verify-doc.sh`.
- ralph plugin state at Plan 4 start: `ralph/skills/{catch-up,form,research}/` (Plan 3 hooks declared in SKILL.md frontmatter; same pattern reused here).
