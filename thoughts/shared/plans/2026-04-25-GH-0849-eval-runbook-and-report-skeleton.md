---
date: 2026-04-25
status: draft
type: plan
github_issue: 849
github_issues: [849]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/849
primary_issue: 849
parent_plan: thoughts/shared/plans/2026-04-25-GH-0567-bundled-skill-audits-phase-2.md
tags: [eval-scenarios, skill-audit, phase-2, runbook, report-skeleton]
---

# Build Eval Runbook Scaffold and Report Skeleton for Phase-2 Audits — Implementation Plan

## Prior Work

- builds_on:: [[2026-04-25-GH-0567-bundled-skill-audits-phase-2]]
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

Single-issue plan that produces the shared scaffolding all 17 per-skill eval-execution children (#850-#866) and the synthesis child (#867) require: a runbook describing the per-scenario execution pattern, and an empty report file with one section per skill ready for findings to be appended.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-849 | Build eval runbook scaffold and report skeleton for phase-2 audits | XS |

**Why standalone**: Although #849 is part of a larger sibling group (#849-#867 under parent epic #848), only #849 is being planned now because the other 18 issues are eval-execution work that **depends on** the artifacts #849 produces. Each child issue (#850-#866) is independently dispatchable once the runbook + report skeleton exist; planning all 19 as one atomic implementation would conflate scaffolding with execution and inflate scope far beyond XS. Each downstream issue will re-enter the planning queue after #849 lands.

## Shared Constraints

These constraints apply to this plan and propagate the relevant subset of the parent plan-of-plans constraints (`2026-04-25-GH-0567-bundled-skill-audits-phase-2.md`).

### Inherited from parent skill-audit plan

1. **Eval files already exist** — all 17 `plugin/ralph-hero/skills/<skill>/eval-scenarios.md` files were created by phases 1-9 of the parent plan and merged in PR #844. The runbook reads from those; it does not modify them.
2. **No skill content edits in this plan** — purely scaffolding-document creation. Skill audits are out of scope here.
3. **No MCP server changes** — pure markdown work.
4. **17 skills audited in phase 2** — ralph-triage, ralph-split, ralph-review, ralph-val, ralph-pr, ralph-merge, status, report, ralph-hygiene, draft, form, iterate, setup, setup-repos, idea-hunt, record-demo, design-system-audit. Both the runbook examples and the report skeleton must enumerate all 17.

### File ownership (this plan)

This plan exclusively writes:

- `thoughts/shared/runbooks/eval-scenario-execution.md` (new file; new directory)
- `thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md` (new file; existing directory)

No edits to existing files.

### Verification expectations

- Both new files must round-trip cleanly through the `Read` tool (valid YAML frontmatter + markdown).
- Report skeleton must contain exactly 17 H2 skill sections + 1 H2 quality-findings section + frontmatter + overview.
- Runbook must document: scenario file format, invocation construction (Skill vs Agent vs interactive simulation), evidence capture, PASS/FAIL/partial/blocked grading map, FAIL bug-filing template, and the JSON-vs-markdown format decision.

### Format consolidation decision

The runbook records a single decision on whether the JSON eval format at `plugin/ralph-hero/skills/design-system-audit/evals/evals.json` should be consolidated with the markdown `eval-scenarios.md` files. Per the parent plan's "purely additive" constraint and the fact that 16/17 skills already use the markdown format, the recommended decision is **keep both formats separate** for this audit cycle — the markdown format is the canonical input for #850-#866, and the JSON format remains a parallel design-system-audit-specific artifact whose consolidation can be re-evaluated after this audit completes. The runbook documents this rationale and instructs #866 (design-system-audit eval execution) to grade against the markdown file only, treating the JSON file as supplementary reference.

## Current State Analysis

**What exists:**

- 17 `eval-scenarios.md` files exist at `plugin/ralph-hero/skills/<skill>/eval-scenarios.md` (confirmed via `find`):
  ralph-triage, ralph-split, ralph-review, ralph-val, ralph-pr, ralph-merge, status, report, ralph-hygiene, draft, form, iterate, setup, setup-repos, idea-hunt, record-demo, design-system-audit.
- Each follows the structure: frontmatter (`type: eval-scenarios`, `skill`, `date`, `status`) → introduction → 3 scenarios per file (Scenario A/B/C, each with Input + Expected Behavior + Assertions sections) → grading rubric table.
- A separate JSON eval format exists at `plugin/ralph-hero/skills/design-system-audit/evals/evals.json` with 4 scenarios in `{prompt, expected_output, assertions: [{text, type}]}` shape (assertion types: `structural`, `scoring`, `content`).
- `thoughts/shared/reviews/` directory exists with 200+ critique documents but no phase-2 eval-results report yet.
- `thoughts/shared/runbooks/` directory does **not** exist — must be created.
- Sibling eval-execution issues #850-#866 are filed and reference both the parent runbook (#849) and their respective `eval-scenarios.md` source files.

**What's missing:**

- No shared runbook documents how to execute a scenario (read input, construct invocation, capture evidence, grade, file FAIL bug).
- No report file exists where findings can be appended.
- No recorded decision on the JSON-vs-markdown format question.

## Desired End State

After this phase ships:

- `thoughts/shared/runbooks/eval-scenario-execution.md` exists with all 6 documented sections (file format, invocation, evidence, grading map, FAIL bug template, format decision).
- `thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md` exists with frontmatter + overview + 17 stubbed skill sections (`Status: pending`, placeholder for grade summary, evidence, FAIL bugs) + one quality-findings section.
- The JSON-vs-markdown decision is recorded in the runbook with rationale.
- Sibling issues #850-#866 are immediately unblocked and can be planned and executed against the new scaffolding.

### Verification

- [ ] `test -f thoughts/shared/runbooks/eval-scenario-execution.md` exits 0
- [ ] `test -f thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md` exits 0
- [ ] `grep -c "^## " thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md` >= 18 (17 skills + quality-findings)
- [ ] All 17 skill names appear as exact H2 headings in the report file (one per skill listed in the parent plan)
- [ ] Both files contain valid YAML frontmatter (Read tool succeeds)
- [ ] Runbook contains explicit JSON-vs-markdown decision section

## What We're NOT Doing

- **Not running any eval scenarios** — execution is each per-skill child issue's job (#850-#866).
- **Not synthesizing findings** — synthesis lands in #867 after all execution children complete.
- **Not modifying any `eval-scenarios.md` source file** — they are read-only inputs.
- **Not consolidating JSON and markdown formats** — decision is recorded as "keep separate"; consolidation is a follow-up if needed.
- **Not creating per-skill bug issues** — those are filed by #850-#866 only when their scenarios FAIL.
- **Not editing the parent plan** (`2026-04-25-GH-0567-bundled-skill-audits-phase-2.md`) — it remains the historical record of the audit work.
- **No MCP server, hook, or skill-source changes**.

## Implementation Approach

A single phase produces both deliverables. Within the phase, the runbook is written first (Task 1.1) because it defines the execution contract; the report skeleton (Task 1.2) reflects that contract by stubbing the per-skill sections in the format the runbook specifies. The `tasks` are sequenced rather than parallel only to keep the document-format conventions consistent (a sub-agent writing the report should be able to mirror conventions established in the runbook).

**Phase dependency annotations** — Single phase, no `depends_on`.

---

## Phase 1: GH-849 — Build runbook + report skeleton

- **depends_on**: null

### Overview

Create the runbook (`thoughts/shared/runbooks/eval-scenario-execution.md`) describing the per-scenario execution pattern, then create the report skeleton (`thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md`) with one stubbed H2 section per audited skill plus a final quality-findings section.

### Tasks

#### Task 1.1: Create eval-scenario-execution runbook
- **files**: `thoughts/shared/runbooks/eval-scenario-execution.md` (create), `plugin/ralph-hero/skills/ralph-triage/eval-scenarios.md` (read), `plugin/ralph-hero/skills/design-system-audit/evals/evals.json` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] File begins with YAML frontmatter:
    ```yaml
    ---
    date: 2026-04-25
    status: active
    type: runbook
    audience: eval-execution-agents
    related_issues: [848, 849]
    related_plan: thoughts/shared/plans/2026-04-25-GH-0567-bundled-skill-audits-phase-2.md
    tags: [eval-scenarios, skill-audit, phase-2, runbook]
    ---
    ```
  - [ ] Document title `# Eval Scenario Execution Runbook` with a 2-3 sentence purpose statement immediately after.
  - [ ] Section `## 1. How to Read an eval-scenarios.md File` — documents the canonical structure: frontmatter (`type: eval-scenarios`, `skill`, `date`, `status`), introduction, scenarios labeled `## Scenario A/B/C: <name>`, each scenario containing `### Input`, `### Expected Behavior`, `### Assertions` (checklist), and a `## Grading Rubric` table at the bottom of the file. Cites `plugin/ralph-hero/skills/ralph-triage/eval-scenarios.md` as the canonical example (link to it).
  - [ ] Section `## 2. Constructing the Invocation` — three subsections:
    - `### 2a. Skill invocation` — when the eval input maps to a user-invocable slash command (e.g., `/ralph-hero:hello`), use `Skill(name=..., args=...)`.
    - `### 2b. Agent invocation` — when the eval input maps to an autonomous skill that runs via a per-phase agent (e.g., ralph-triage, ralph-impl), use `Agent(subagent_type="ralph-hero:<skill>-agent", prompt=...)`. Include the agent map from CLAUDE.md (research-agent, plan-agent, triage-agent, impl-agent, val-agent, pr-agent, merge-agent, plan-epic-agent, split-agent, review-agent).
    - `### 2c. Interactive simulation` — when the skill is interactive (e.g., draft, form, hello), simulate the inputs by reading the SKILL.md flow and recording the agent-side responses; mark these scenarios as `partial` if a real interactive run cannot be performed.
  - [ ] Section `## 3. Capturing Evidence` — documents the three evidence types: (a) **output snippet** — paste the agent's response or tool-call result inline, fenced; (b) **log line** — copy postcondition hook output, GH state-change log, or `bash` exit code; (c) **screenshot** — only when UI is involved (none for phase-2 skills, but documented for future use).
  - [ ] Section `## 4. Mapping Results to PASS / FAIL / partial / blocked`:
    - `PASS` — every assertion checkbox in the scenario can be checked from evidence.
    - `FAIL` — at least one assertion fails AND the agent ran to completion (i.e., a real failure, not an environment problem).
    - `partial` — the scenario produced meaningful output but one or more assertions cannot be evaluated from the evidence (e.g., interactive skill where simulation could not exercise a branch).
    - `blocked` — the scenario could not be run at all (missing dependency, broken dev env, prerequisite not satisfied). Include the blocker reason in evidence.
  - [ ] Section `## 5. Filing a FAIL Bug` — provides the canonical body template (markdown) for a bug filed against the parent skill issue (NOT the eval-scenarios.md file). Template:
    ```markdown
    ## Eval FAIL: <skill> / Scenario <X>

    **Source**: plugin/ralph-hero/skills/<skill>/eval-scenarios.md → Scenario <X>: <name>
    **Audit run**: GH-#NNN (the eval-execution issue, e.g., #850 for ralph-triage)
    **Date**: YYYY-MM-DD

    ### Failed Assertions
    - [ ] <assertion text from scenario>

    ### Evidence
    <output snippet / log line / screenshot>

    ### Suggested Fix Direction
    <1-2 sentence diagnosis>
    ```
    Bug is filed as a sub-issue of the parent skill issue (e.g., a ralph-triage bug becomes a sub-issue of #567). Do **not** modify the eval-scenarios.md source file from a FAIL — record eval-quality complaints separately for the synthesis issue (#867).
  - [ ] Section `## 6. JSON vs Markdown Eval Format Decision` — records the decision: "**Keep both formats separate for this audit cycle**." Lists rationale: (1) 16/17 skills already use markdown format and the parent audit plan locked that format choice when phases 1-9 of #567 created the files; (2) the JSON format at `plugin/ralph-hero/skills/design-system-audit/evals/evals.json` predates the markdown convention and has typed assertions (`structural`/`scoring`/`content`) that are useful for that skill but not currently consumed by any tooling; (3) consolidation would require either porting JSON to markdown (loss of typed assertions) or porting markdown to JSON (rewrite of 17 files for no immediate benefit); (4) for #866 (design-system-audit eval execution), the markdown file is the canonical source — the JSON file is supplementary reference only. A follow-up evaluation can re-open this decision after the audit completes.
  - [ ] Section `## 7. Per-Scenario Workflow Checklist` — a step-by-step checklist a per-skill execution agent follows for each scenario: (1) read `eval-scenarios.md` for the assigned skill, (2) for each scenario: read Input + Expected Behavior + Assertions, (3) construct invocation per Section 2, (4) execute, (5) capture evidence per Section 3, (6) grade per Section 4, (7) for FAILs: file bug per Section 5, (8) capture eval-quality complaints (vague assertions, environmental coupling) for the synthesis child (#867), (9) append findings to the per-skill section in the report file at `thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md`.

#### Task 1.2: Create phase-2 eval-results report skeleton
- **files**: `thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md` (create), `thoughts/shared/runbooks/eval-scenario-execution.md` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] File begins with YAML frontmatter:
    ```yaml
    ---
    date: 2026-04-25
    status: in_progress
    type: review
    review_type: eval-results
    audit_phase: 2
    related_issues: [848, 849, 850, 851, 852, 853, 854, 855, 856, 857, 858, 859, 860, 861, 862, 863, 864, 865, 866, 867]
    related_plan: thoughts/shared/plans/2026-04-25-GH-0567-bundled-skill-audits-phase-2.md
    runbook: thoughts/shared/runbooks/eval-scenario-execution.md
    tags: [eval-results, skill-audit, phase-2]
    ---
    ```
  - [ ] Document title `# Phase 2 Skill Audit — Eval Execution Results` with a 2-3 sentence overview describing what this file aggregates (per-skill eval grades from sibling issues #850-#866, plus quality-findings for the synthesis issue #867).
  - [ ] Section `## How to Append Findings` — short instruction (3-5 lines) pointing readers at the runbook (`thoughts/shared/runbooks/eval-scenario-execution.md`) for the canonical execution pattern; reminds appending agents to update the per-skill `Status:` line and add evidence under the existing stubs rather than creating new top-level sections.
  - [ ] Section `## Summary Table` — empty markdown table with columns: `Skill | Issue | Status | Scenarios | Pass | Fail | Partial | Blocked | FAIL bugs filed`. Header row + 17 placeholder data rows (one per skill, alphabetical), each row pre-populated with the skill name, the matching execution issue number from the group (see issue->skill mapping below), and the literal text `pending` in the Status column with `—` in the count columns.
  - [ ] **Issue → skill mapping** for the summary table and the H2 sections (taken from the parent epic #848's group members):
    | Order | Issue | Skill |
    |-------|-------|-------|
    | 2 | #850 | ralph-triage |
    | 3 | #851 | ralph-split |
    | 4 | #852 | ralph-review |
    | 5 | #853 | ralph-val |
    | 6 | #854 | ralph-pr |
    | 7 | #855 | ralph-merge |
    | 8 | #856 | status |
    | 9 | #857 | report |
    | 10 | #858 | ralph-hygiene |
    | 11 | #859 | draft |
    | 12 | #860 | form |
    | 13 | #861 | iterate |
    | 14 | #862 | setup |
    | 15 | #863 | setup-repos |
    | 16 | #864 | idea-hunt |
    | 17 | #865 | record-demo |
    | 18 | #866 | design-system-audit |
  - [ ] 17 H2 sections, one per skill, **alphabetized by skill name** (matches grading-by-eval-execution flow). For each skill, the H2 heading is exactly `## <skill-name>` (e.g., `## ralph-triage`, `## design-system-audit`). Each section MUST contain the following stubbed structure:
    ```markdown
    ## <skill-name>

    - **Status**: pending
    - **Execution issue**: #<NNN>
    - **Eval source**: `plugin/ralph-hero/skills/<skill-name>/eval-scenarios.md`
    - **Date executed**: —

    ### Grade Summary
    | Scenario | Result | Notes |
    |----------|--------|-------|
    | A | pending | — |
    | B | pending | — |
    | C | pending | — |

    ### Evidence
    _Pending execution. Append output snippets, log lines, or screenshots per `thoughts/shared/runbooks/eval-scenario-execution.md` Section 3._

    ### FAIL Bugs Filed
    _None yet. List sub-issues of the parent skill issue once filed per runbook Section 5._
    ```
    For `design-system-audit`, append an additional bullet to the metadata block: `- **Supplementary reference**: \`plugin/ralph-hero/skills/design-system-audit/evals/evals.json\` (JSON format, kept separate per runbook Section 6)`.
  - [ ] Final section `## Eval-Scenario Quality Findings` — purpose statement (1-2 sentences) explaining this section aggregates eval-quality complaints (vague assertions, environmental coupling, missing edge cases) across all 17 skills for the synthesis child (#867) to consume. Includes a stubbed bullet list with the literal text `_None yet. Per-skill execution agents append findings here as they encounter them, attributing each finding to its source skill and scenario._`.
  - [ ] Bottom-of-file references section listing: parent epic (#848), this scaffolding issue (#849), runbook path, parent audit plan path, and synthesis issue (#867).

### Phase Success Criteria

#### Automated Verification:
- [ ] `test -f thoughts/shared/runbooks/eval-scenario-execution.md` — exit 0
- [ ] `test -f thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md` — exit 0
- [ ] `grep -c "^## " thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md` returns at least 19 (How to Append Findings + Summary Table + 17 skill sections + Quality Findings)
- [ ] `grep -c "^## " thoughts/shared/runbooks/eval-scenario-execution.md` returns at least 7 (sections 1-7)
- [ ] All 17 skill names appear as exact H2 headings in the report: `for skill in ralph-triage ralph-split ralph-review ralph-val ralph-pr ralph-merge status report ralph-hygiene draft form iterate setup setup-repos idea-hunt record-demo design-system-audit; do grep -q "^## ${skill}$" thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md || echo "MISSING: ${skill}"; done` produces no output
- [ ] Both files round-trip through the `Read` tool with no YAML parse error (frontmatter valid)
- [ ] Runbook Section 6 (`## 6. JSON vs Markdown Eval Format Decision`) exists and contains the literal phrase "Keep both formats separate"

#### Manual Verification:
- [ ] A reviewer reading the runbook in isolation (no prior context) can execute one of the existing eval scenarios end-to-end without ambiguity.
- [ ] The report skeleton's per-skill sections are uniform — a per-skill execution agent can find their section and append without restructuring.
- [ ] The JSON-vs-markdown decision is defensible to someone seeing the design-system-audit JSON file for the first time.

**Creates for next phase**: nothing in this plan — but the deliverables unblock sibling issues #850-#866 (per-skill execution) which can subsequently be planned and dispatched, and #867 (synthesis) which will read the populated report once those complete.

---

## Integration Testing

- [ ] After this phase ships, all 17 sibling execution issues (#850-#866) can be moved through `/ralph-plan` → `/ralph-impl` without their plans flagging missing scaffolding.
- [ ] Spot-check one execution by reading the runbook + the report's `## ralph-triage` section + the source `plugin/ralph-hero/skills/ralph-triage/eval-scenarios.md` and confirming a hypothetical execution agent has all the inputs it needs.

## Cross-Phase Concerns

Single phase — no cross-phase concerns. The plan touches no shared files with any other in-flight plan and creates only two new files in distinct directories.

## References

### Source artifacts (read inputs)
- Parent audit plan: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-25-GH-0567-bundled-skill-audits-phase-2.md
- Canonical markdown eval example: https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-triage/eval-scenarios.md
- JSON eval format reference: https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/design-system-audit/evals/evals.json

### Related issues
- This issue: https://github.com/cdubiel08/ralph-hero/issues/849
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/848
- Sibling execution issues: #850-#866 (one per audited skill)
- Synthesis issue: https://github.com/cdubiel08/ralph-hero/issues/867
- Phase 2 audit epic (grandparent): https://github.com/cdubiel08/ralph-hero/issues/566
