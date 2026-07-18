---
date: 2026-07-17
status: draft
type: plan
tags: [gates, plan-review, merge, autopilot, human-attention]
github_issue: 1544
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1544
estimate: M
research_waived: human-approved — design synthesized live from the 2026-07-17 five-agent workflow investigation (sessions, ralph-hero + landcrawler-ai delivery history, thoughts corpus, pipeline gate map); findings are summarized in issue #1544 rather than a standalone research doc
---

# Decision-gated plan approval + autonomous merge default (gate flip)

## Prior Work

- builds_on:: [[2026-07-08-GH-1538-pr-per-issue-cost-and-feature-batching]] — established the feature/group as the pipeline unit and tier routing by unit size; this plan keeps that routing intact and changes only *who* approves what.
- builds_on:: [[2026-06-10-fable-native-ralph-artifact-contracts]] — the hero-fable boundary contract ("state the exact decision you need, what you recommend, and what you deferred") is the prose model for the `#### Decision:` block introduced here.
- tensions:: `thoughts/wiki/auto-mode-is-end-to-end.md` — "Partial autonomy is the failure mode… the user can't predict when the skill will pause." This plan resolves the tension by making the only human pause *predictable and content-driven* (open design decisions), never positional (end-of-pipeline).
- builds_on:: PR #1532 (session-scoped artifact tracking + JSON-driven state-gate consolidation) — the hook patterns (artifact-write-tracker discovery, fail-open-with-warning) are reused, not modified.

## Overview

The pipeline's two review dials are inverted relative to where human judgment adds value. `RALPH_REVIEW_PLAN` defaults to `auto` (plan approval — the cheapest place to catch a design error — is an agent verdict running ~92% APPROVED), while `RALPH_REVIEW_MODE` defaults to `interactive` (the pipeline's only mandatory human touchpoint is "PR created, STOP", a gate the delivery data shows is ceremonial: 14–16 min median open→merge, zero formal GitHub reviews across ~200 recent PRs in ralph-hero and landcrawler-ai).

This plan (1) introduces a **plan-decisions contract**: every plan carries a structured `## Design Decisions & Open Ambiguities` section authored at the moment of uncertainty; (2) makes the plan gate **decision-driven**: plans with open decisions hold for the human (with the questions already written), decision-free plans flow through on the agent critique at any size; and (3) flips the merge gate default to autonomous so hero completes val → code-review → merge → CI watch unattended, with `CHANGES_REQUESTED` preserved as the unconditional human veto.

A naive flip of `RALPH_REVIEW_PLAN` to `interactive` was rejected: inside a `--mode auto` tick, an `AskUserQuestion` blocks the autopilot loop forever. The conditional gate restores human design authority without reintroducing partial-autonomy stalls.

## Current State Analysis

The gate topology lives in prose defaults and a handful of hooks:

- `ralph/skills/hero/SKILL.md:102-103` — config echoes resolve `${RALPH_REVIEW_PLAN:-auto}` and `${RALPH_REVIEW_MODE:-interactive}`.
- `ralph/skills/hero/dispatch.md` § Plan review gate (line ~64) and § Merge gate (line ~85) — branch on those two vars; the merge gate's `interactive` default is "report PR URLs, STOP. Human must re-run".
- `ralph/skills/plan/plan-review.md` § Interactive vs auto — interactive presents a 4-option whole-plan verdict picker; auto dispatches `review-agent` (opus for XS/S singles, fable for groups/M/plan-of-plans) and never prompts.
- `ralph/hooks/scripts/review-plan-gate.sh` — PreToolUse:AskUserQuestion; when `RALPH_REVIEW_PLAN=auto`, blocks any picker whose header is "Plan Review" or whose labels contain both "Approve…" and "Request changes".
- `ralph/hooks/scripts/doc-structure-validator.sh` — Stop hook; plan branch requires `## Phase N`, verification subsections, and checkboxes; knows nothing about decisions.
- `ralph/skills/review/merge-gate.md` + `merge-review-decision-gate.sh` — pre-merge gates (APPROVED or the XS-no-comments / solo-repo carve-outs; `CHANGES_REQUESTED` always blocks).
- `ralph/skills/review/auto-vs-interactive.md` § RALPH_REVIEW_MODE switch — documents `interactive` as the default for the code-review-gate BLOCKED branch.

### Key Discoveries

- `ralph/skills/hero/SKILL.md:2` claims "a human plan-approval gate by default" while line 102 resolves that gate to `auto` — a live documented contradiction.
- `review-plan-gate.sh:40-44` detects the verdict picker by header string `"plan review"` or the Approve/Request-changes label pair — a decisions picker with a different header and per-option decision labels passes untouched, so the new picker needs no hook bypass, only a documented naming contract.
- `doc-structure-validator.sh:56` already strips fenced code blocks before shape discrimination — the same `awk` pattern can be reused so plans that *document* the decisions format in fenced examples don't false-positive.
- `ralph/skills/shared/loop-wrapper.md` manifest rows define terminal sentinels per mode; `plan:review` terminates on `Queue empty.` — a new non-terminal `PLAN AWAITING DECISION` result line must be registered as a progress (re-fire) signal, not a terminal, or the review drain will hang/misreport.
- Autopilot's classify tick re-dispatches `/ralph:plan --mode review` for every Plan in Review issue on every pass — the awaiting-decision path must be idempotent (no duplicate `## Decision Request` comments, no repeat notifications).
- Merge safety does not regress: `merge-review-decision-gate.sh` is a PreToolUse:Bash hook that runs regardless of `RALPH_REVIEW_MODE`, and `CHANGES_REQUESTED` has no carve-out.

## Design Decisions & Open Ambiguities

Resolved during planning (2026-07-17, interactive session):

- **Park location for plans awaiting a decision** — options: Plan in Review + structured comment; Human Needed escalation; agent-decides-and-journals (hero-fable style). **Decided: Plan in Review + `## Decision Request` comment + PushNotification.** Keeps the board truthful (the plan *is* in review — by a human), avoids conflating design decisions with failures, and reuses the existing answer surfaces.
- **Skip scope for decision-free plans** — options: XS/S only skip the human gate; all sizes skip. **Decided: all sizes skip.** Groups/M plans already receive a fable critique; the decisions section is the gate, not size.
- **`RALPH_REVIEW_PLAN` semantics** — options: flip default to `interactive`; keep `auto` default but make auto decision-driven. **Decided: keep `auto` as default with decision-driven semantics.** A blanket interactive default stalls autopilot; `interactive` remains available as an explicit whole-plan-picker override.

None — no open design decisions.

## Desired End State

1. Every new plan doc (standard, group, and plan-of-plans shapes) contains a `## Design Decisions & Open Ambiguities` section, hook-enforced, with either ≥1 structured `#### Decision:` block or the literal sentinel `None — no open design decisions.`
2. `/ralph:plan --mode review` under `RALPH_REVIEW_PLAN=auto`: agent critique runs as today; an APPROVED plan with open decisions stays in Plan in Review with exactly one `## Decision Request` comment and one push notification, emitting `PLAN AWAITING DECISION`; an APPROVED plan with the sentinel advances to In Progress with no human involvement, at any estimate.
3. The interactive plan-review picker presents the decisions (one picker per open decision, agent recommendation first) instead of a whole-plan verdict; answers are folded into the plan's resolved-decisions list before advancing.
4. `RALPH_REVIEW_MODE` defaults to `auto` everywhere it is documented or branched on; a default hero run completes research → plan → (decision gate if needed) → impl → PR → val → code-review → merge → CI watch without a mandatory human stop.
5. `CHANGES_REQUESTED` on a PR still unconditionally blocks merge; the solo-repo and XS-no-comments carve-outs are unchanged.
6. `hero/SKILL.md`'s description and its config defaults agree: "decision-gated human plan approval by default; autonomous merge."

### Verification

- Automated: hook test suite passes (`find ralph/hooks/scripts/__tests__ … | xargs -0 -n1 bash`), ShellCheck clean at severity=error, `scripts/check-doc-rosters.sh` passes, `npx vitest run src/__tests__/skill-frontmatter.test.ts` passes.
- Automated: fixture-driven validator tests prove a plan without the decisions section blocks Stop, and both the sentinel and a `#### Decision:` block pass.
- Manual: dry-run `/ralph:plan --mode auto` on a scratch issue produces a plan containing the section; `/ralph:plan --mode review` on a plan with an open decision posts the Decision Request and re-invocation does NOT duplicate it; a decision-free plan advances straight to In Progress; a default `/ralph:hero NNN` run reaches merge + CI watch with no AskUserQuestion after plan approval.

## What We're NOT Doing

- Not changing `RALPH_AUTO_MERGE` (the loop-runner CI-green gate) — it remains an independent dial; this plan flips `RALPH_REVIEW_MODE` only.
- Not touching the merge carve-outs, `merge-review-decision-gate.sh`, or branch protection assumptions.
- Not building a new board state or label for "awaiting decision" — Plan in Review + comment is the contract (revisit only if classify-tick noise proves material).
- Not wiring decision answers into `caretake --mode unblock` — the answer surfaces are the interactive review picker and a plain issue-comment reply; unblock stays scoped to Human Needed.
- Not retrofitting the decisions section into existing plan docs (validator only checks today-dated, session-written docs by design).
- Not changing model-tier routing (GH-1538 bookends stay exactly as shipped).
- Not implementing the broader investigation's other recommendations (learning loop, firebreak quota, CI-watch babysitting) — separate issues.

## Implementation Approach

Four sequential phases. Phase 1 establishes the contract surface (shapes + validator) so everything downstream can rely on it. Phase 2 rewires plan review to consume it. Phase 3 flips the merge default and reconciles hero's prose. Phase 4 locks it in with tests and doc-roster consistency. File ownership is disjoint per phase except `plan-review.md` (Phase 2 only) and `hero/SKILL.md` (Phase 3 only).

## Phase 1: Plan-decisions section contract

depends_on: null

### Overview

Define the `## Design Decisions & Open Ambiguities` section in the plan shapes and enforce its presence in the Stop-hook validator, for all three plan shapes.

### Changes Required

#### 1. Section spec + matrix

**File**: `ralph/skills/plan/plan-shapes.md`
**Changes**: Add the section to § Section order (between `## What We're NOT Doing` and `## Implementation Approach`). New § Design decisions anatomy: resolved decisions as bullets (`**<title>** — options considered; **Decided:** <choice> + rationale`); open items as `#### Decision: <title>` blocks with **Context**, **Options** (agent recommendation listed first and marked), **Recommendation**, **Blocked without it**; the literal sentinel line `None — no open design decisions.` REQUIRED when no open items (may follow resolved bullets). Add a required row to § Per-mode required-sections matrix (required in default, `--mode auto`, and `--mode epic`). For the plan-of-plans variant, list the section alongside Feature Decomposition in the epic shape notes (decision-dense by nature).

#### 2. Validator enforcement

**File**: `ralph/hooks/scripts/doc-structure-validator.sh`
**Changes**: In the plan branch (both regular and plan-of-plans arms), on the fence-stripped body: require `^## Design Decisions` header; require EITHER `^#### Decision:` OR the sentinel `None — no open design decisions.` inside the doc. Error strings name the missing piece and point at `plan-shapes.md § Design decisions anatomy`.

#### 3. Authoring steps

**File**: `ralph/skills/plan/SKILL.md`
**Changes**: One line each in default Step 4 and auto Step 6: author the decisions section per `plan-shapes.md § Design decisions anatomy`; in auto mode, unresolved judgment calls the planner cannot settle from research become `#### Decision:` blocks instead of silent assumptions or `__ESCALATE__` (escalation remains for missing-research / conflicting-implementation triggers).

### Success Criteria

#### Automated Verification
- [x] `shellcheck -S error ralph/hooks/scripts/doc-structure-validator.sh` exits 0
- [x] New validator fixtures: plan missing the section → exit 2; plan with sentinel → exit 0; plan with one `#### Decision:` block and no sentinel → exit 0; section only inside a fenced example → exit 2 (fence-strip respected)
- [x] Existing hook tests still pass

#### Manual Verification
- [ ] This plan doc itself passes the updated validator (it models the contract)

## Phase 2: Plan review consumes decisions

depends_on: [phase-1]

### Overview

Make the decisions section the unit of human review: interactive mode presents decisions instead of a whole-plan verdict; auto mode holds open-decision plans with a self-authored Decision Request and auto-advances decision-free ones.

### Changes Required

#### 1. Rubric + verdict shape

**File**: `ralph/skills/plan/plan-review.md`
**Changes**: Add rubric dimension 8 **Decision honesty** — does the section exist with real content; are judgment calls visible in phases but absent from the section (buried decisions = GAP; contradiction between a resolved decision and the phases = FAIL)? Add the dimension to the verdict-shape score block.

#### 2. Interactive flow → decisions pickers

**File**: `ralph/skills/plan/plan-review.md` § Interactive vs auto
**Changes**: Replace the whole-plan 4-option picker as the primary surface: after rubric scoring, if open `#### Decision:` blocks exist, present one `AskUserQuestion` per decision (max 4 per call; header `Decision: <short title>`, options from the block's Options with the recommendation first; "Other" free-text is the escape hatch). Fold answers into the plan: move each answered block to the resolved list with the choice + "human-decided YYYY-MM-DD", restore the sentinel when none remain (surgical `Edit`, iterate-mode discipline). Then a single confirm picker (`header: "Plan Review"`, Approve / Request changes / Open in editor) replaces the old 4-option flow — kept for rubric-level rejections independent of decisions. Decision-free plans skip straight to the confirm picker. Document the naming contract: decision pickers MUST use `Decision:`-prefixed headers and MUST NOT pair "Approve"/"Request changes" labels, so `review-plan-gate.sh` (unchanged detection) never blocks them under auto.

#### 3. Auto flow → hold-or-advance

**File**: `ralph/skills/plan/plan-review.md` § Interactive vs auto (auto branch) + § Transition rules
**Changes**: After the review-agent verdict:
- NEEDS_ITERATION → unchanged (iterate loop, hero's 2-iteration cap).
- APPROVED + sentinel present + no `#### Decision:` blocks → unchanged APPROVED transition to In Progress (all sizes).
- APPROVED + ≥1 open `#### Decision:` block → **idempotency check first**: `gh` comment scan for an existing `## Decision Request`; if present with no later human comment → emit `PLAN AWAITING DECISION` and STOP (no re-post, no re-notify). If a later human comment exists → treat it as answers: fold into the plan (as in the interactive flow), then APPROVED transition. Otherwise post one `## Decision Request` comment — one `### <decision title>` per block with context/options/recommendation verbatim and the answer instructions ("reply here, or run `/ralph:plan --mode review NNN`") — fire `PushNotification(title="Decision needed #NNN", body="<n> design decision(s) — <issue-url>")`, leave state at Plan in Review, emit `PLAN AWAITING DECISION`.
- Critique-doc frontmatter gains `decisions_open: <n>`.

#### 4. Loop + dispatch plumbing

**File**: `ralph/skills/shared/loop-wrapper.md` (plan:review manifest row)
**Changes**: Register `PLAN AWAITING DECISION` as a progress (non-terminal) sentinel so a review drain continues past held plans; `Queue empty.` remains the only terminal.

**File**: `ralph/hooks/scripts/review-plan-gate.sh`
**Changes**: Comment-only update documenting the decisions-picker naming contract (detection logic itself unchanged); block-message text gains "decision pickers (`Decision:` headers) are allowed — see plan-review.md".

### Success Criteria

#### Automated Verification
- [ ] Hook test: review-plan-gate blocks a picker with header "Plan Review" under `RALPH_REVIEW_PLAN=auto` AND allows one with header "Decision: park location"
- [ ] `shellcheck -S error ralph/hooks/scripts/review-plan-gate.sh` exits 0
- [ ] `grep -q "PLAN AWAITING DECISION" ralph/skills/shared/loop-wrapper.md` (manifest row updated)

#### Manual Verification
- [ ] On a scratch issue: auto review of a plan with one open decision posts exactly one `## Decision Request` + one notification; immediate re-invocation emits `PLAN AWAITING DECISION` without duplicates
- [ ] Replying to the comment and re-running review folds the answer into the plan and advances to In Progress
- [ ] A decision-free plan auto-advances with no comment or notification

## Phase 3: Gate flip + hero reconciliation

depends_on: [phase-2]

### Overview

Flip the merge-review default to autonomous and reconcile every place the old defaults are echoed or branched on, including hero's contradictory description.

### Changes Required

#### 1. Hero defaults + description

**File**: `ralph/skills/hero/SKILL.md`
**Changes**: Line 103 `${RALPH_REVIEW_MODE:-interactive}` → `${RALPH_REVIEW_MODE:-auto}`. Line 2 description: "…with a human plan-approval gate by default" → "…with a decision-gated human plan approval (open design decisions route to the human; decision-free plans flow through) and autonomous merge by default". Line 102 stays `:-auto` (semantics now decision-driven).

#### 2. Dispatch contract

**File**: `ralph/skills/hero/dispatch.md`
**Changes**: § Plan review gate: default `auto` branch now routes on the three review outcomes (APPROVED-advanced / NEEDS_ITERATION / `PLAN AWAITING DECISION` → report the decision request URL and STOP that issue's pipeline — NOT an escalation; do not move to Human Needed). `interactive` branch: unchanged mechanics, note it now presents decisions-first pickers. § Merge gate: default annotation flips to `auto` ("dispatch `Skill("ralph:review", args="NNN")`…"); `interactive` documented as the opt-out ("report PR URLs, STOP").

#### 3. Review-side default echoes

**File**: `ralph/skills/review/auto-vs-interactive.md`
**Changes**: § RALPH_REVIEW_MODE switch table: `auto` row becomes "(default; unset or `auto`)", `interactive` row becomes explicit opt-in. The BLOCKED-branch behavior text updated accordingly.

**File**: `ralph/skills/review/SKILL.md`
**Changes**: Default-mode Step 3 BLOCKED branch: "`interactive` (default)" → "`interactive` (opt-in)"; `auto` marked default.

#### 4. Repo-wide default sweep

**Files**: `grep -rn "RALPH_REVIEW_MODE" --include="*.md"` across `ralph/`, `docs/`, root `CLAUDE.md`, `README.md`
**Changes**: Every prose statement of the default updated; add both vars to the root `CLAUDE.md` Environment Variables table (currently absent) with the new defaults and one-line semantics.

### Success Criteria

#### Automated Verification
- [ ] `grep -rn "RALPH_REVIEW_MODE:-interactive" ralph/ docs/ CLAUDE.md README.md` returns nothing
- [ ] `grep -c "human plan-approval gate by default" ralph/skills/hero/SKILL.md` returns 0 (old claim gone)
- [ ] `bash scripts/check-doc-rosters.sh` passes

#### Manual Verification
- [ ] `/ralph:hero <scratch-issue>` (default one-shot, decision-free plan) runs plan → impl → PR → val → code-review → merge → CI watch with no AskUserQuestion after planning and no "re-run /ralph:hero" stop
- [ ] With `RALPH_REVIEW_MODE=interactive` exported, the old PR-URLs-and-STOP behavior returns

## Phase 4: Tests + docs lock-in

depends_on: [phase-3]

### Overview

Deterministic coverage for the new gate behavior and documentation consistency, so the contract survives future skill edits.

### Changes Required

#### 1. Hook tests

**File**: `ralph/hooks/scripts/__tests__/doc-structure-validator-decisions.test.sh` (create)
**Changes**: Fixtures per Phase 1 criteria (missing section / sentinel / decision block / fenced-only), for both regular and plan-of-plans shapes.

**File**: `ralph/hooks/scripts/__tests__/review-plan-gate.test.sh` (modify or create alongside existing)
**Changes**: Cases per Phase 2 criteria (verdict picker blocked under auto; `Decision:` header allowed; unset var allows everything).

#### 2. Docs

**File**: `ralph/CLAUDE.md`
**Changes**: Loop-suitability matrix: `plan --mode review` row notes the `PLAN AWAITING DECISION` progress sentinel. Short § note under conventions: the decisions section is the plan's human-interface contract.

**File**: `docs/model-tier-policy.md`
**Changes**: One-paragraph note: tier routing unchanged; the human gate is now decision-conditional (cross-reference plan-shapes anatomy).

### Success Criteria

#### Automated Verification
- [ ] `find ralph/hooks/scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \) -print0 | xargs -0 -n1 bash` — all pass including the new files
- [ ] `shellcheck -S error ralph/hooks/scripts/*.sh` exits 0
- [ ] `cd mcp-server && npx vitest run src/__tests__/skill-frontmatter.test.ts` passes
- [ ] `bash scripts/check-doc-rosters.sh` passes

#### Manual Verification
- [ ] Fresh-eyes read of `plan-shapes.md § Design decisions anatomy` + `plan-review.md` — the contract is followable without this plan as context

## Testing Strategy

### Unit Tests
Hook-level bash tests are the unit layer (Phase 4): validator section enforcement across all fixture shapes; review-plan-gate picker discrimination. No mcp-server TypeScript changes are made, so the vitest suite is a regression check only.

### Integration Tests
Manual scratch-issue runs listed in Phases 2–3 (decision hold → answer → advance; decision-free flow-through; end-to-end hero merge). Run before merging this PR, from the worktree, against the live board with a throwaway issue.

### Manual Testing Steps
1. Create a scratch XS issue; `/ralph:plan --mode auto` it; confirm the section exists.
2. Hand-edit the plan to add one `#### Decision:` block; run `/ralph:plan --mode review` twice under `RALPH_REVIEW_PLAN=auto`; confirm single comment + notification + `PLAN AWAITING DECISION` twice.
3. Reply to the comment; re-run review; confirm fold-in + advance.
4. Full `/ralph:hero` one-shot on a second scratch issue; confirm unattended merge + CI watch.
5. Clean up scratch issues (Canceled) and revert scratch plans.

## Migration Notes

- Existing plan docs are untouched (validator scopes to today-dated, session-written docs). Plans currently sitting in Plan in Review under the old contract will be re-reviewed under the new flow on their next review dispatch; those lacking the decisions section were authored pre-contract and the review-agent should treat the missing section as a GAP (not FAIL) for a 2-week grace window — note this in the rubric dimension text.
- Anyone (CI, scripts, launchd runners) exporting `RALPH_REVIEW_MODE=interactive` explicitly keeps the old behavior — the flip changes only the unset default. `scripts/ralph-loop.sh --auto-merge` behavior is unchanged (`RALPH_AUTO_MERGE` untouched).
- Rollback: export `RALPH_REVIEW_MODE=interactive` (behavioral rollback, instant) or revert the PR (contract rollback); the two are independent.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1544 (evidence base summarized in body)
- `ralph/skills/hero/SKILL.md:102-103`, `ralph/skills/hero/dispatch.md` §§ Plan review gate / Merge gate
- `ralph/skills/plan/plan-review.md`, `ralph/skills/plan/plan-shapes.md`
- `ralph/hooks/scripts/review-plan-gate.sh`, `ralph/hooks/scripts/doc-structure-validator.sh`, `ralph/hooks/scripts/merge-review-decision-gate.sh`
- `ralph/skills/review/merge-gate.md` §§ Pre-merge gates / Carve-outs, `ralph/skills/review/auto-vs-interactive.md`
- `thoughts/shared/ideas/2026-06-10-fable-native-ralph-artifact-contracts.md` (decision-block prose model)
- `thoughts/wiki/auto-mode-is-end-to-end.md` (partial-autonomy axiom)
