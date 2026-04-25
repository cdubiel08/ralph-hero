---
date: 2026-04-25
status: draft
type: plan
github_issue: 850
github_issues: [850]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/850
primary_issue: 850
tags: [eval-scenarios, ralph-triage, skill-audit, phase-2]
---

# Run Eval Scenarios for ralph-triage and Grade Outputs - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-25-GH-0849-eval-runbook-and-report-skeleton]]
- builds_on:: [[2026-04-25-GH-0567-bundled-skill-audits-phase-2]]

## Overview

Single XS issue executing the canonical eval-runbook against the ralph-triage skill's three scenarios (A: CLOSE/duplicate, B: RESEARCH/valid feature, C: SPLIT/large scope), grading each, recording evidence in the shared phase-2 report, and filing FAIL bugs against parent skill issue #567.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-850 | Run eval scenarios for ralph-triage and grade outputs | XS |

**Why standalone**: Although #850 is part of a 19-issue group (#849-#867) under epic #848, only #850 is planned now. Each sibling execution issue (#851-#866) targets a different skill with a different `eval-scenarios.md` source file and different per-skill report section to fill — they share the runbook, but the actual execution work, evidence, and grading are skill-specific. Bundling them into one plan would (a) blow past XS scope, (b) couple unrelated PASS/FAIL outcomes into one PR, and (c) prevent parallel dispatch by sibling agents. The synthesis issue (#867) consumes the populated report only after all sibling executions complete; #850 produces only the ralph-triage section.

## Shared Constraints

The constraints below are the non-negotiable contract for any agent executing this plan. Most flow from the runbook at `thoughts/shared/runbooks/eval-scenario-execution.md`; deviating from them invalidates the audit.

1. **Read-only eval source**: Do NOT modify `plugin/ralph-hero/skills/ralph-triage/eval-scenarios.md`. The eval file is a fixed input. Eval-quality complaints (vague assertions, environmental coupling) go in the report's `## Eval-Scenario Quality Findings` section attributed to ralph-triage / Scenario X — never as edits to the source.
2. **Append-only report writes**: When updating `thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md`, edit ONLY the existing `## ralph-triage` per-skill stub (lines 244-262 in the skeleton) and the top-of-file `## Summary Table` row for ralph-triage (line 35). Do NOT create new top-level sections, do NOT restructure other skills' stubs, do NOT touch `## How to Append Findings` or `## References`. Eval-quality complaints append to the bottom `## Eval-Scenario Quality Findings` section as bullet items.
3. **Invocation pattern is Agent dispatch**: ralph-triage has a corresponding `triage-agent` in `plugin/ralph-hero/agents/triage-agent.md` (sonnet model, preloaded skill). Per runbook Section 2b, all three scenarios MUST be exercised via `Agent(subagent_type="ralph-hero:triage-agent", prompt="<scenario Input verbatim>")`. Do NOT bypass the agent contract by invoking the skill directly — the agent's tool allowlist and isolation are part of what is being graded.
4. **Test issues must not pollute the real backlog**: The scenarios' Inputs describe Backlog issues that don't exist in the live project. Each scenario requires an ephemeral test issue created in the project's `Backlog` workflow state, fed to the triage-agent, then archived/canceled afterward so it does not contaminate the backlog. Use clear test-issue titles prefixed with `[EVAL #850]` so they are trivially identifiable for cleanup.
5. **Evidence is non-optional**: Per runbook Section 3, every assertion must be backed by either an output snippet or a log line pasted in the per-skill report's `### Evidence` subsection, annotated with which assertion it addresses. A scenario with no evidence MUST be graded `blocked`, not guessed.
6. **FAIL bug destination is #567 (parent skill issue), NOT #850**: Per runbook Section 5, FAIL bugs are sub-issues of the **parent ralph-triage skill issue #567**. They are NOT sub-issues of this eval-execution issue (#850). Use the canonical body template from runbook Section 5; use title format `Eval FAIL: ralph-triage / Scenario <X> — <one-line summary>`.
7. **Status mapping is mechanical**: Per runbook Section 4: all-PASS → `passed`; any FAIL → `failed (N bugs filed)`; any blocked → `blocked`; PASS+partial only → `partial`. Apply this verbatim — do not editorialize.
8. **No source-skill modifications**: This plan does NOT modify `plugin/ralph-hero/skills/ralph-triage/SKILL.md` or `plugin/ralph-hero/agents/triage-agent.md` regardless of FAIL outcomes. Behavioral fixes to ralph-triage are follow-up work tracked as the FAIL-bug sub-issues of #567 (out of scope per the issue's `## Out of Scope`).

## Current State Analysis

**Eval source** (`plugin/ralph-hero/skills/ralph-triage/eval-scenarios.md`):
- Three scenarios defined (A: CLOSE/duplicate, B: RESEARCH/valid new, C: SPLIT/large scope)
- Each scenario has Input + Expected Behavior + Assertions checklist
- Final `## Grading Rubric` table with 5 dimensions (action correctness, reasoning quality, hook contract, side-effect hygiene, label discipline)
- File frontmatter declares `status: defined` and includes execution caveat: scenarios are written but not yet executed; manual eval runs tracked outside the audit plan

**Runbook** (`thoughts/shared/runbooks/eval-scenario-execution.md`):
- Sections 1-7 cover the full execution contract: scenario file structure, three invocation patterns (Skill / Agent / interactive simulation), evidence capture, grade mapping (PASS/FAIL/partial/blocked), FAIL-bug filing, JSON-vs-markdown decision, per-scenario workflow checklist
- Section 6 locks the eval format decision: keep markdown and JSON separate for this audit cycle; markdown is canonical for grading
- Section 5 locks the FAIL-bug destination: parent skill issue (e.g., #567 for ralph-triage), NOT the eval-execution issue (#850)
- Section 7 step 8 locks the eval-quality complaint pattern: append to the report's bottom section, do not modify the source eval file

**Report skeleton** (`thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md`):
- 17 per-skill sections pre-stubbed with metadata block lines `- **Status**: pending` and `- **Date executed**: —` (note the leading dash + bold markup — this exact format must be preserved when updating values), three-row Grade Summary tables (A/B/C), and `### Evidence` + `### FAIL Bugs Filed` subsections
- Top-of-file `## Summary Table` lists all 17 skills with `pending` status
- ralph-triage section at lines 244-262 is the target stub for this issue's writes
- Bottom `## Eval-Scenario Quality Findings` section exists with placeholder bullet for eval-quality complaints

**Triage-agent** (`plugin/ralph-hero/agents/triage-agent.md`):
- Sonnet model, preloads `ralph-hero:ralph-triage` skill
- Tool allowlist: Read, Glob, Grep, Bash, Task, Agent, WebSearch + 8 ralph_hero MCP tools (get_issue, list_issues, save_issue, create_comment, create_issue, add_sub_issue, list_sub_issues, add_dependency)
- This is the production invocation contract: dispatch via `Agent(subagent_type="ralph-hero:triage-agent", prompt="...")`

**Parent skill issue #567** (referenced as FAIL-bug parent per runbook Section 5):
- Verified to exist (referenced throughout the parent audit plan and runbook); no fetch needed for this plan since FAIL bugs are conditional and only filed if at least one scenario fails

**What does NOT yet exist for this issue**:
- The three test Backlog issues that the scenarios will be run against
- The populated `## ralph-triage` section in the report
- Any FAIL bugs (only filed if needed)

## Desired End State

After this issue completes:

### Verification

- [ ] Three test Backlog issues created and labeled `[EVAL #850]` exist or were created and archived during the run; cleanup status documented in evidence
- [ ] Report file `thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md` has the `## ralph-triage` section's `Status:` updated from `pending` to `passed|failed|partial|blocked`, `Date executed:` set to `2026-04-25` (or actual run date), Grade Summary table filled with PASS/FAIL/partial/blocked per scenario + one-line notes, `### Evidence` subsection populated with output snippets/log lines annotated to specific assertions, and `### FAIL Bugs Filed` listing any sub-issues of #567 (or "None — all scenarios passed" if no failures)
- [ ] Top-of-file `## Summary Table` row for ralph-triage updated to match: status, scenarios count (3), pass/fail/partial/blocked counts, FAIL-bugs-filed count
- [ ] If any scenario graded FAIL: at least one bug exists as a sub-issue of #567 with title format `Eval FAIL: ralph-triage / Scenario <X> — <summary>` and body matching the runbook Section 5 template (Source / Audit run / Date / Failed Assertions / Evidence / Suggested Fix Direction)
- [ ] If any eval-quality complaint surfaced: appended as a bullet under the report's `## Eval-Scenario Quality Findings` section, attributed to `ralph-triage / Scenario <X>`
- [ ] Source `plugin/ralph-hero/skills/ralph-triage/eval-scenarios.md` is unmodified (verifiable via `git diff`)
- [ ] No other per-skill sections in the report were touched (verifiable via `git diff` showing only the ralph-triage section, summary-table row, and quality-findings bullets changed)

## What We're NOT Doing

- NOT modifying `plugin/ralph-hero/skills/ralph-triage/eval-scenarios.md` (source is read-only per Shared Constraint #1)
- NOT modifying `plugin/ralph-hero/skills/ralph-triage/SKILL.md` or any other skill content (out of scope per issue body)
- NOT modifying `plugin/ralph-hero/agents/triage-agent.md` (out of scope; agent contract is what's being graded)
- NOT running scenarios for any other skill (#851-#866 are separate issues, each with their own plan)
- NOT producing the cross-skill summary or follow-up plan (that is #867's synthesis work)
- NOT filing FAIL bugs against #850 — they belong on parent skill issue #567 per runbook Section 5
- NOT consolidating the JSON eval format into markdown (decision locked in runbook Section 6)
- NOT bypassing the triage-agent by invoking the ralph-triage skill directly (agent dispatch is the production contract per Shared Constraint #3)
- NOT leaving test issues in the live backlog (cleanup is part of acceptance per Shared Constraint #4)
- NOT generating UI Validation phase (no UI baseline; not requested via `--playwright`)

## Implementation Approach

Single phase, single agent (the implementing agent itself, dispatching the triage-agent as a sub-agent for each scenario). The work decomposes into five tasks: prepare test issues, run all three scenarios via `triage-agent`, capture and grade evidence, file any FAIL bugs against #567, and atomically update the shared report + clean up test issues.

The single phase exists because all five tasks share evidence — the agent response from each scenario run is both the basis for grading and the content pasted into the report. Splitting evidence capture from report writes would require re-fetching agent outputs (impossible — they are ephemeral) or staging them in a temporary file (unnecessary overhead for XS work).

---

## Phase 1: Execute ralph-triage eval scenarios and populate report

- **depends_on**: null

### Overview

Dispatch the `triage-agent` against three test Backlog issues (one per scenario), capture evidence from each run, grade against the assertion checklists, file FAIL bugs as sub-issues of #567 if any assertion fails, and update the shared phase-2 report's `## ralph-triage` section + summary-table row in a single atomic edit. Clean up the test issues at the end so they do not pollute the live backlog.

### Tasks

#### Task 1.1: Prepare three test Backlog issues for the scenarios

- **files**: `plugin/ralph-hero/skills/ralph-triage/eval-scenarios.md` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Three issues created in the live project, each in workflow state `Backlog`, with `[EVAL #850]` prefix in titles for trivial identifiability:
    - Test A: `[EVAL #850] Add markdown table support to project_hygiene tool output` (body matches Scenario A Input verbatim, no labels, no estimate)
    - Test B: `[EVAL #850] Add SQLite WAL-mode auto-checkpoint configuration to ralph-knowledge` (body matches Scenario B Input verbatim, no labels, no estimate)
    - Test C: `[EVAL #850] Refactor MCP server tool registration to support per-project tool filtering` (body matches Scenario C Input verbatim, no labels, estimate set to `M` per Scenario C Input)
  - [ ] Issue numbers recorded for use in Task 1.2 (note them in the report's `### Evidence` subsection as the first line: `Test issues: A=#NNN, B=#NNN, C=#NNN`)
  - [ ] No labels applied (Scenarios A/B explicitly require unlabeled inputs to verify the agent applies `ralph-triage`; Scenario C also requires unlabeled to verify label preservation = empty set + agent's own label)

#### Task 1.2: Dispatch triage-agent for all three scenarios and capture full evidence

- **files**: (no file writes; evidence captured in agent context for paste in Task 1.4)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Three sequential `Agent(subagent_type="ralph-hero:triage-agent", prompt="<scenario-prompt>")` calls dispatched, one per test issue. Prompt format for each: `Triage issue #<test-issue-number>` (the agent reads the issue body itself; do NOT paste the scenario Input into the prompt — the agent must work from the live issue, not from a transcribed brief, to match production conditions per Shared Constraint #3)
  - [ ] Full agent response captured for each scenario (response text, any tool-call traces visible in the response, any postcondition hook output)
  - [ ] Post-run state of each test issue verified via `mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue` (capture: workflowState, labels, comments added by triage-agent, any sub-issues created via list_sub_issues for Scenario C)
  - [ ] Side-effect log lines captured: postcondition hook output (looks for `RALPH_TRIAGE_ACTION=<CLOSE|RESEARCH|SPLIT>`), and for Scenario C only, the `list_sub_issues` response confirming children + their estimates and workflowStates
  - [ ] If any agent invocation crashes or times out: that scenario marked `blocked` with the failure reason captured verbatim in evidence (do NOT FAIL the skill for environmental problems per runbook Section 4)

#### Task 1.3: Grade each scenario against its assertion checklist

- **files**: `plugin/ralph-hero/skills/ralph-triage/eval-scenarios.md` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] For each of A/B/C: every `- [ ]` assertion in the scenario's Assertions checklist evaluated against captured evidence; result is exactly one of PASS, FAIL, partial, blocked per runbook Section 4
  - [ ] Scenario A assertions evaluated: workflowState=Done; comment cites file path or PR number; `ralph-triage` label present + existing labels preserved; no postcondition hook block; no sub-issues created; no estimate change
  - [ ] Scenario B assertions evaluated: workflowState=Research Needed; comment names specific investigation topic; `ralph-triage` label present + existing labels preserved; no postcondition hook block; issue stays open; no sub-issues created
  - [ ] Scenario C assertions evaluated: ≥2 sub-issues created and linked; each sub-issue estimate XS or S; each sub-issue workflowState=Backlog; parent workflowState remains Backlog; parent has summary comment listing children; `ralph-triage` label on parent; no postcondition hook block; error-recovery behavior if applicable
  - [ ] Per-scenario one-line note recorded for the Grade Summary table (e.g., for PASS: `All assertions met`; for FAIL: `Failed: <assertion text>`; for partial: `Unevaluable: <which assertion + why>`; for blocked: `Blocker: <reason>`)
  - [ ] Overall skill status derived per runbook Section 4 mapping: all PASS → `passed`; any FAIL → `failed (N bugs filed)`; any blocked → `blocked`; PASS+partial only → `partial`
  - [ ] Eval-quality complaints surfaced and noted for Task 1.5 (vague assertions, environmental coupling, missing edge cases, structural deviations from canonical scenario shape) — attributed to ralph-triage / Scenario X

#### Task 1.4: File FAIL bugs as sub-issues of parent skill issue #567 (conditional)

- **files**: `thoughts/shared/runbooks/eval-scenario-execution.md` (read for Section 5 template)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] For every scenario graded FAIL in Task 1.3 (zero or more), one bug filed as a sub-issue of #567 (parent ralph-triage skill issue) — NOT of #850. Use `mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_issue` then `mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_sub_issue` to link under #567
  - [ ] Each bug's title matches format `Eval FAIL: ralph-triage / Scenario <X> — <one-line summary>` (e.g., `Eval FAIL: ralph-triage / Scenario A — RALPH_TRIAGE_ACTION not set on CLOSE branch`)
  - [ ] Each bug's body matches the runbook Section 5 canonical template verbatim with these substitutions:
    - `Source`: `plugin/ralph-hero/skills/ralph-triage/eval-scenarios.md → Scenario <X>: <name>`
    - `Audit run`: `GH-#850`
    - `Date`: `2026-04-25` (or actual run date)
    - `Failed Assertions`: copy assertion text(s) verbatim from scenario file, one bullet per failed assertion, kept as `- [ ]` unchecked so the bug closer can mark them on fix
    - `Evidence`: same evidence as in the report's per-skill section (do not abbreviate further)
    - `Suggested Fix Direction`: 1-2 sentence diagnosis or `Diagnosis pending — observed failure with no obvious root cause; assigned for skill maintainer triage.`
  - [ ] Each filed bug's URL recorded for inclusion in Task 1.5's `### FAIL Bugs Filed` list
  - [ ] If zero scenarios FAILed: no bugs filed; Task 1.5's `### FAIL Bugs Filed` reads `_None — all scenarios passed_` or analogous wording matching skeleton style
  - [ ] No bugs filed against #850 (verifiable: #850 should have zero new sub-issues created during this run)

#### Task 1.5: Atomically update report and clean up test issues

- **files**: `thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.4]
- **acceptance**:
  - [ ] In the report file, the `## ralph-triage` section's metadata block updated, **preserving the leading `- ` dash and `**Bold**` markup of each line verbatim**:
    - `- **Status**: pending` → `- **Status**: <passed|failed (N bugs filed)|partial|blocked>` per Task 1.3 mapping
    - `- **Date executed**: —` → `- **Date executed**: 2026-04-25` (or actual run date)
    - The leading `- **` and trailing `**:` characters are part of the markdown formatting and MUST NOT be stripped — only the value after the `: ` changes
  - [ ] Grade Summary table populated with one row per scenario:
    - `| A | <PASS|FAIL|partial|blocked> | <one-line note from Task 1.3> |`
    - `| B | <PASS|FAIL|partial|blocked> | <one-line note from Task 1.3> |`
    - `| C | <PASS|FAIL|partial|blocked> | <one-line note from Task 1.3> |`
  - [ ] `### Evidence` subsection populated: first line records `Test issues: A=#NNN, B=#NNN, C=#NNN`; each scenario gets a labeled subsection (`#### Scenario A`, `#### Scenario B`, `#### Scenario C`) containing pasted output snippets and/or log lines, each annotated with which assertion it addresses (e.g., `> Verifies: workflowState becomes "Done"`); placeholder `_Pending execution. Append output snippets..._` removed
  - [ ] `### FAIL Bugs Filed` subsection populated with bullet list of bug URLs from Task 1.4, or `_None — all scenarios passed_` if zero failures; placeholder `_None yet. List sub-issues..._` removed
  - [ ] Top-of-file `## Summary Table` row for ralph-triage updated from `| ralph-triage | #850 | pending | — | — | — | — | — | — |` to `| ralph-triage | #850 | <status> | 3 | <pass-count> | <fail-count> | <partial-count> | <blocked-count> | <fail-bug-count> |`
  - [ ] For each eval-quality complaint surfaced in Task 1.3: a bullet appended under the report's `## Eval-Scenario Quality Findings` section in the format `- ralph-triage / Scenario <X>: <complaint>` — placeholder bullet `_None yet. Per-skill execution agents append findings here..._` only removed if at least one new bullet replaces it (otherwise leave the placeholder so subsequent skill executions see the same instruction)
  - [ ] No other per-skill section in the report touched (verifiable via `git diff thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md` showing changes only inside the ralph-triage summary-table row, the `## ralph-triage` per-skill section, and (optionally) appended bullets in the `## Eval-Scenario Quality Findings` section — refer by section name only, not line numbers, since sibling skill executions (#851-#866) may shift line offsets if they merge first)
  - [ ] Source `plugin/ralph-hero/skills/ralph-triage/eval-scenarios.md` unchanged (verifiable via `git diff` showing no changes to that file)
  - [ ] All three test issues from Task 1.1 closed/canceled with workflowState set to `Canceled` (and issueState set to `CLOSED_NOT_PLANNED`) so they are removed from the live Backlog; cleanup confirmed by checking each test issue's final state

### Phase Success Criteria

#### Automated Verification:

- [ ] `git diff plugin/ralph-hero/skills/ralph-triage/eval-scenarios.md` produces no output (source unmodified per Shared Constraint #1)
- [ ] `git diff thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md` shows changes only within the ralph-triage summary-table row, the `## ralph-triage` section, and (optionally) appended bullets in `## Eval-Scenario Quality Findings`
- [ ] `grep -c '^- \*\*Status\*\*: pending' thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md` returns 16 (one less than the original 17 — only ralph-triage transitioned out of pending). Note the literal asterisks in the pattern: the skeleton's actual line format is `- **Status**: pending` (leading dash + bold markup), NOT bare `Status: pending`.
- [ ] `sed -n '/^## ralph-triage$/,/^## /p' thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md | grep '^- \*\*Status\*\*:'` does NOT match `pending` — confirms the ralph-triage section's status line transitioned to one of `passed|failed|partial|blocked`. The `sed` range scopes the grep to just the ralph-triage section so adjacent skills' pending lines do not leak into the result.

#### Manual Verification:

- [ ] Each scenario's grade is justifiable from the pasted evidence — a reviewer can read the report's `### Evidence` subsection and independently verify each assertion's PASS/FAIL determination without needing to re-run the agent
- [ ] FAIL bugs (if any) read as standalone reproducers: a maintainer reading the bug body can understand the failure without opening the report or scenario file
- [ ] Test issues from Task 1.1 are no longer visible in the live Backlog view of the GitHub Project

**Creates for next phase**: N/A — single-phase plan. The next downstream consumer is the synthesis issue #867, which reads this populated `## ralph-triage` section once all sibling executions (#851-#866) also complete.

---

## Integration Testing

- [ ] Visit the report file's rendered view on GitHub (`https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md`) after merge and confirm the `## ralph-triage` section renders cleanly (no broken markdown, no malformed table, evidence blocks readable)
- [ ] If any FAIL bugs filed: visit each bug on GitHub and confirm it appears as a sub-issue of #567 (not of #850) and has the runbook-template body sections present

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/850
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/848
- Sibling scaffold (Done): https://github.com/cdubiel08/ralph-hero/issues/849
- Parent ralph-triage skill issue (FAIL-bug destination): https://github.com/cdubiel08/ralph-hero/issues/567
- Synthesis issue (downstream consumer): https://github.com/cdubiel08/ralph-hero/issues/867
- Eval source: [plugin/ralph-hero/skills/ralph-triage/eval-scenarios.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-triage/eval-scenarios.md)
- Runbook: [thoughts/shared/runbooks/eval-scenario-execution.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/runbooks/eval-scenario-execution.md)
- Report skeleton: [thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md)
- Triage-agent definition: [plugin/ralph-hero/agents/triage-agent.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/triage-agent.md)
- Parent audit plan: [thoughts/shared/plans/2026-04-25-GH-0567-bundled-skill-audits-phase-2.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-25-GH-0567-bundled-skill-audits-phase-2.md)
