---
date: 2026-05-08
status: draft
type: plan
github_issue: 1141
github_issues: [1141]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1141
primary_issue: 1141
parent_plan: thoughts/shared/plans/2026-05-07-GH-1136-autopilot-skill.md
tags: [skill, autopilot, docs, evals, readme, claude-md]
---

# GH-1141 — Autopilot Phase 5: Docs + Eval Scenarios

## Prior Work

- builds_on:: [[2026-05-07-GH-1136-autopilot-skill]]
- builds_on:: [[2026-05-08-GH-1136-critique-r2]]

## Overview

Final phase of the autopilot skill (parent plan-of-plans GH-1136). Three documentation artifacts:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1141 | Autopilot: docs (README, CLAUDE.md) + 13 eval scenarios | XS |

All prose is **pre-drafted in the parent plan** (Phase 5 §1, §2, §3). Implementer pastes verbatim — no inventing required. The eval-scenarios document is the only authored artifact, and the structure mirrors the existing `plugin/ralph-hero/skills/ralph-merge/eval-scenarios.md`.

## Shared Constraints

Inherited from the parent plan-of-plans (`2026-05-07-GH-1136-autopilot-skill.md`):

- **Pure markdown, no MCP/TypeScript changes** — `npm test` and `npm run build` must remain green without modification (zero source files touched in this phase).
- **No new dependencies** — `package.json` files unchanged.
- **Discovery is file-based** — plugin manifest (`plugin/ralph-hero/.claude-plugin/plugin.json`) does NOT need editing; the autopilot skill is registered by `skills/autopilot/SKILL.md` existing on disk (created in Phases 1-4).
- **Pre-drafted prose is canonical** — copy README and CLAUDE.md drafts from the parent plan §Phase 5 verbatim. Do not paraphrase, expand, or rewrite. The parent plan went through three review rounds; the prose has already been adjudicated.
- **Eval scenarios 12 and 13 are R3-critical** — these regression-test the In-Review filter (Step 2.5 from parent plan Phase 1). Without them passing, autopilot would falsely escalate healthy in-review PRs after 3 ticks. Manual verification of scenarios 12 and 13 against a real test board is a hard gate before this child can be marked Done.
- **Reference format**: `plugin/ralph-hero/skills/ralph-merge/eval-scenarios.md` is the formatting reference for the eval-scenarios document — match its heading style, scenario numbering, and "Setup / Steps / Expected" sub-sections.

## Current State Analysis

Phases 1-4 of the parent plan create:

- `plugin/ralph-hero/skills/autopilot/SKILL.md` — the skill body with the full tick state machine (Steps 0-10), including the Step 2.5 In-Review filter that scenarios 12 and 13 regression-test.
- `plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh` — the PreToolUse gate validating `ScheduleWakeup` calls.
- The skill writes audit lines to `~/.ralph-hero/autopilot.jsonl`.

Phase 5 (this plan) layers documentation over that working skill. Nothing in this phase touches the skill body, hook script, audit log shape, or any TypeScript code — it is pure markdown authoring + verbatim copy-paste of pre-drafted prose.

The autopilot skill directory does not exist on disk at planning time (Phases 1-4 are still in progress). This plan is dependency-blocked on Phase 4 (GH-1140) being merged before implementation begins, since the eval-scenarios document references the SKILL.md tick state machine and the hook gate behavior.

`plugin/ralph-hero/README.md` has an `### Individual Skills` section at line 73 — the natural insertion point for the autopilot README subsection. The pre-drafted README block goes near the existing `hero` skill entry (per parent plan §Phase 5 #2: "insert near the `hero` skill entry").

`/Users/dubiel/projects/ralph-hero/CLAUDE.md` has skill-list documentation that already references several skills (`/trends`, `/ralph-split`, etc.). The CLAUDE.md edit appends the pre-drafted "Autopilot" section to that list.

## Desired End State

Three new/modified files, all containing prose copied verbatim from the parent plan (except the eval-scenarios document, which is authored fresh against the parent plan's scenario list):

1. `plugin/ralph-hero/skills/autopilot/eval-scenarios.md` (NEW) — 13 numbered eval scenarios, formatted to match `ralph-merge/eval-scenarios.md`.
2. `plugin/ralph-hero/README.md` (MODIFIED) — adds the pre-drafted autopilot subsection under `### Individual Skills`, near the `hero` skill entry.
3. `/Users/dubiel/projects/ralph-hero/CLAUDE.md` (MODIFIED) — appends the pre-drafted "Autopilot" subsection to the existing skill list documentation.

### Verification

- [ ] All three files updated as specified
- [ ] All 13 eval scenarios documented (mirror `ralph-merge/eval-scenarios.md` format)
- [ ] README and CLAUDE.md prose match the parent plan §Phase 5 verbatim (diff against parent plan strings)
- [ ] `npm test` in `plugin/ralph-hero/mcp-server/` passes (unchanged — no MCP code touched)
- [ ] `npm run build` in `plugin/ralph-hero/mcp-server/` passes (unchanged)
- [ ] Eval scenarios 1–5, 10, 12 manually walked through against a real test board

## What We're NOT Doing

- **NOT inventing docs prose** — copy from parent plan §Phase 5 verbatim. Per critique issue 8 (R2), implementers shouldn't have to invent docs prose; that's why it was pre-drafted.
- **NOT editing the plugin manifest** (`plugin/ralph-hero/.claude-plugin/plugin.json`) — discovery is file-based per parent plan §Phase 5 #4.
- **NOT modifying `SKILL.md`** — Phases 1-4 own it.
- **NOT modifying `autopilot-wakeup-gate.sh`** — Phase 4 owns it.
- **NOT writing executable test code** — eval scenarios are documented as manual walkthroughs against a real test board, matching the `ralph-merge/eval-scenarios.md` reference style.
- **NOT documenting the deferred follow-ups** (token-telemetry budget cap, `next_actions(includeInReview=false)`, worktree auto-cleanup, auto-merge In-Review handling) — these are tracked in the parent plan's "Follow-up Work" section and explicitly out of scope here.

## Implementation Approach

One phase, three tasks. Each task touches a single file and produces output verifiable by simple file-presence and grep checks. Implementation order does not matter (no inter-task dependencies), but the eval-scenarios document is the largest authoring task, so doing it first front-loads the work and lets the implementer use the parent plan as a single source while attention is fresh.

---

## Phase 1: Author docs + eval scenarios

- **depends_on**: null

### Overview

Three documentation artifacts. Two are verbatim paste-from-parent-plan; one is structured authoring against an explicit scenario list.

### Tasks

#### Task 1.1: Author eval-scenarios.md

- **files**: `plugin/ralph-hero/skills/autopilot/eval-scenarios.md` (create), `plugin/ralph-hero/skills/ralph-merge/eval-scenarios.md` (read), `thoughts/shared/plans/2026-05-07-GH-1136-autopilot-skill.md` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/skills/autopilot/eval-scenarios.md`
  - [ ] File parses as valid markdown (no malformed code fences or lists)
  - [ ] All 13 scenarios from parent plan §Phase 5 #1 are present, numbered 1–13, in order
  - [ ] Each scenario follows the `ralph-merge/eval-scenarios.md` structural pattern: a heading (`### Scenario N: <title>`), then `Setup`, `Steps`, and `Expected` sub-sections (or the equivalent sub-headings used by the reference file)
  - [ ] Scenarios 12 and 13 explicitly call out the In-Review filter (Step 2.5) under test and document the regression they prevent (false escalation of healthy in-review PRs after 3 60s ticks)
  - [ ] Scenario 6 documents `no_progress_streak == 3` escalation behavior
  - [ ] Scenario 10 documents the worktree-liveness gate (escalation when `worktrees/GH-N/` already exists for the picked issue)
  - [ ] Scenario 9 documents `--dry-run` semantics (no hero dispatch, no `ScheduleWakeup` call)
  - [ ] Scenario 11 documents cross-tick state survival (`iteration` grows monotonically in audit log)
  - [ ] No invented scenarios beyond the 13 listed in parent plan §Phase 5 #1

#### Task 1.2: Add autopilot subsection to README.md

- **files**: `plugin/ralph-hero/README.md` (modify), `thoughts/shared/plans/2026-05-07-GH-1136-autopilot-skill.md` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] README.md contains a heading `### \`/ralph-hero:autopilot\` — Backlog Clearer` under the existing `### Individual Skills` section (line ~73), positioned near the existing `hero` skill entry
  - [ ] The subsection body is the verbatim block from parent plan §Phase 5 #2 (the markdown block beginning `Single-command shorthand for "clear the backlog while I'm away."` and ending with the cancel-mid-loop `/tasks` instruction)
  - [ ] The block includes: the opt-in note (`RALPH_AUTOPILOT_ENABLE=true`), four invocation examples (default, `--max-iterations 5`, `--auto-merge`, `--dry-run`), the four termination conditions, the interactive-merge-mode explanation (covering the In-Review filter), the audit-log path (`~/.ralph-hero/autopilot.jsonl`), and the cancel instructions
  - [ ] No paraphrasing, no expansion, no rewording — diff against parent plan should match the pre-drafted block character-for-character (modulo whitespace normalization)
  - [ ] No other sections of README.md are modified

#### Task 1.3: Append Autopilot section to CLAUDE.md

- **files**: `/Users/dubiel/projects/ralph-hero/CLAUDE.md` (modify), `thoughts/shared/plans/2026-05-07-GH-1136-autopilot-skill.md` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] CLAUDE.md contains a new `### Autopilot` heading appended to the existing skill-list documentation
  - [ ] The body is the verbatim single-paragraph block from parent plan §Phase 5 #3 (beginning `\`/ralph-hero:autopilot\` is a self-paced backlog clearer...`)
  - [ ] The block mentions: `ScheduleWakeup`-based loop, opt-in via `RALPH_AUTOPILOT_ENABLE=true`, audit log at `~/.ralph-hero/autopilot.jsonl`, references to `skills/autopilot/SKILL.md` and `hooks/scripts/autopilot-wakeup-gate.sh`, and coexistence with `scripts/ralph-loop.sh`
  - [ ] No paraphrasing, no expansion — diff against parent plan should match the pre-drafted block
  - [ ] No other sections of CLAUDE.md are modified

### Phase Success Criteria

#### Automated Verification:
- [ ] `test -f plugin/ralph-hero/skills/autopilot/eval-scenarios.md` — file exists
- [ ] `grep -c "^### Scenario " plugin/ralph-hero/skills/autopilot/eval-scenarios.md` returns `13` (or matches the heading style used in the reference file)
- [ ] `grep -q "ralph-hero:autopilot" plugin/ralph-hero/README.md` — README mentions the skill
- [ ] `grep -q "Autopilot" /Users/dubiel/projects/ralph-hero/CLAUDE.md` — CLAUDE.md mentions the skill
- [ ] `grep -q "RALPH_AUTOPILOT_ENABLE" plugin/ralph-hero/README.md` — README documents the opt-in
- [ ] `grep -q "autopilot.jsonl" plugin/ralph-hero/README.md` — README documents the audit log
- [ ] `grep -q "autopilot.jsonl" /Users/dubiel/projects/ralph-hero/CLAUDE.md` — CLAUDE.md documents the audit log
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` — all tests pass (unchanged)
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` — TypeScript compile succeeds (unchanged)

#### Manual Verification:
- [ ] Walk through eval scenarios 1, 2, 3, 4, 5 against a real test board and confirm autopilot behavior matches the documented Expected outcomes
- [ ] Walk through eval scenario 10 (pre-existing worktree at `worktrees/GH-N/` for the picked issue) and confirm autopilot escalates without dispatching
- [ ] Walk through eval scenario 12 (single XS, interactive default, In-Review filter regression) — tick 1 lands PR, tick 2 fires after 60s, Step 2.5 filters out the In-Review issue, autopilot exits `outcome=backlog_empty` without re-dispatching, no false escalation
- [ ] Cancel-mid-loop instructions in README work: invoke autopilot, verify `/tasks` lists the wakeup, deletion via cron tools cancels the next tick
- [ ] A teammate unfamiliar with the implementation can read the README + CLAUDE.md sections and successfully invoke autopilot end-to-end

**Creates for next phase**: nothing — this is the final phase of the parent plan.

---

## Integration Testing

Manual eval-scenario walkthrough against a test project board, per the eval-scenarios document. The skill is pure markdown — no automated integration tests beyond the existing `npm test` suite (which is unchanged because no MCP code is touched).

The R3-critical regression tests (scenarios 12 and 13) MUST be walked through manually before this issue is marked Done. Without them passing, the In-Review filter from parent plan Phase 1 Step 2.5 is unverified end-to-end, and the false-escalation regression that R3 introduced specifically to fix could re-emerge silently.

## References

- **Parent plan-of-plans**: [thoughts/shared/plans/2026-05-07-GH-1136-autopilot-skill.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-07-GH-1136-autopilot-skill.md) (revision 3, all prose pre-drafted in §Phase 5)
- **Parent issue**: https://github.com/cdubiel08/ralph-hero/issues/1136
- **This issue**: https://github.com/cdubiel08/ralph-hero/issues/1141
- **Sibling phase issues** (blockers — must be merged before this phase begins):
  - GH-1137 (Phase 1: scaffold + safety check + pick-next-actionable)
  - GH-1138 (Phase 2: tick body — worktree check + hero dispatch + pre/post diff)
  - GH-1139 (Phase 3: ScheduleWakeup loop + 4 termination conditions)
  - GH-1140 (Phase 4: audit log JSONL + ScheduleWakeup hook gate)
- **Reference eval-scenarios format**: `plugin/ralph-hero/skills/ralph-merge/eval-scenarios.md`
- **R2 critique** (informed R3 In-Review-filter design): `thoughts/shared/reviews/2026-05-08-GH-1136-critique-r2.md`
