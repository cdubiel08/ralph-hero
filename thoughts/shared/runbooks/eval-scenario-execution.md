---
date: 2026-04-25
status: active
type: runbook
audience: eval-execution-agents
related_issues: [848, 849]
related_plan: thoughts/shared/plans/2026-04-25-GH-0567-bundled-skill-audits-phase-2.md
tags: [eval-scenarios, skill-audit, phase-2, runbook]
---

# Eval Scenario Execution Runbook

This runbook is the canonical execution contract for the phase-2 skill-audit eval scenarios. Each per-skill execution issue (#850-#866) under parent #848 follows this runbook end-to-end: read the scenarios for one skill, construct an invocation, capture evidence, grade against the assertions, file FAIL bugs against the parent skill issue, and append findings to the shared report. Read this document in full before running any scenarios — it defines vocabulary (PASS / FAIL / partial / blocked), evidence conventions, and the format-decision boundary between markdown and JSON eval files.

## 1. How to Read an eval-scenarios.md File

Every audited skill in phase 2 has a markdown eval file at:

```
plugin/ralph-hero/skills/<skill>/eval-scenarios.md
```

The canonical example is [`plugin/ralph-hero/skills/ralph-triage/eval-scenarios.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-triage/eval-scenarios.md). Every file conforms to the following structure:

1. **YAML frontmatter** at the top of the file:
   ```yaml
   ---
   type: eval-scenarios
   skill: <skill-name>
   date: <YYYY-MM-DD>
   status: defined
   ---
   ```
   The `skill` field MUST match the skill directory name (`ralph-triage`, `design-system-audit`, etc.). The `status: defined` value indicates the scenarios are written but not yet executed; once executed, the per-skill section in the report file (not the eval file itself) records the run.

2. **Introduction paragraph** — 1-3 sentences naming the skill, the action branches under test, and any execution caveats (manual vs. automated, agent dispatch vs. direct invocation).

3. **Scenarios** — labeled `## Scenario A: <name>`, `## Scenario B: <name>`, `## Scenario C: <name>`. Most files have exactly three scenarios chosen to cover the primary action branches of the skill. Each scenario has three required subsections:
   - `### Input` — the context fed to the skill (issue shape, command args, repo state). Read this verbatim; do not paraphrase or substitute equivalent values.
   - `### Expected Behavior` — a numbered list describing what the skill should do. This is narrative/descriptive; the binding contract is the assertion list below.
   - `### Assertions` — a bulleted markdown checklist. **Each `- [ ]` item is a binary check.** A scenario PASSes only if all assertions can be checked from the captured evidence.

4. **Grading Rubric** — a final `## Grading Rubric` table with rows for grading dimensions (action correctness, reasoning quality, hook contract, side-effect hygiene, label discipline) and columns for each scenario. Use this rubric when writing partial-credit notes, not as a substitute for the assertion checklist.

If a scenario file deviates from this structure, record the deviation in the eval-quality findings section of the report (it is a finding for synthesis issue #867, not a runbook violation).

## 2. Constructing the Invocation

For each scenario, decide which of three invocation patterns matches the skill under test. The decision is driven by how a real user invokes the skill, not by the eval file's wording.

### 2a. Skill invocation

Use when the eval input maps to a user-invocable slash command (e.g., `/ralph-hero:hello`, `/ralph-hero:status`, `/ralph-hero:report`).

```
Skill(name="ralph-hero:<skill>", args="<input prompt or command args>")
```

The Input section of the scenario translates directly to the `args`. Use this pattern for non-autonomous skills that produce a single response without dispatching downstream agents — typical examples are `status`, `report`, `record-demo`, `idea-hunt`.

### 2b. Agent invocation

Use when the eval input maps to an autonomous skill that runs via a per-phase agent (skills that have a corresponding `<skill>-agent` definition in `plugin/ralph-hero/agents/`). The agent map (from CLAUDE.md):

| Agent | Preloaded Skill |
|-------|-----------------|
| `research-agent` | ralph-research |
| `plan-agent` | ralph-plan |
| `plan-epic-agent` | ralph-plan-epic |
| `split-agent` | ralph-split |
| `triage-agent` | ralph-triage |
| `review-agent` | ralph-review |
| `impl-agent` | ralph-impl |
| `pr-agent` | ralph-pr |
| `merge-agent` | ralph-merge |
| `val-agent` | ralph-val |

Dispatch pattern:

```
Agent(subagent_type="ralph-hero:<skill>-agent", prompt="<scenario Input section, verbatim>")
```

Use this pattern for the agent-backed skills above. The agent contract (tool allowlist, memory, isolation) is the production contract; do not bypass it by calling the skill directly.

### 2c. Interactive simulation

Use when the skill is interactive (e.g., `draft`, `form`, `hello`) — that is, when the production execution depends on multi-turn user input that cannot be captured in a single prompt.

Procedure:

1. Read the skill's `SKILL.md` (in `plugin/ralph-hero/skills/<skill>/SKILL.md`) and identify the conversational flow (questions asked, decision branches taken).
2. For each branch the eval scenario exercises, record the agent-side response that the skill would produce given the scripted user input from the scenario's Input section.
3. Mark such scenarios as `partial` (see Section 4) if a real interactive run cannot be performed in the audit environment — the assertions about user-driven branches cannot be fully exercised by simulation alone.

Always note in the report's evidence section that the result came from interactive simulation, including which branches were simulated vs. exercised.

## 3. Capturing Evidence

Every scenario result MUST be backed by at least one of the following evidence types. Paste evidence directly into the per-skill section of the report (`thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md`) under that skill's `### Evidence` subsection.

- **Output snippet** — paste the agent's response or the tool-call result inline, fenced in a triple-backtick block. Trim aggressively but preserve any text that maps to a specific assertion (e.g., the line that names a file path, the workflowState transition, the comment body). Annotate which assertion each excerpt addresses.

- **Log line** — copy the relevant postcondition hook output, GH state-change log entry, or `bash` exit code. Useful for verifying side effects that are not visible in the agent's prose response (e.g., `RALPH_TRIAGE_ACTION` accepted, `workflowState` mutation succeeded, sub-issues created).

- **Screenshot** — only when UI is involved. Phase-2 skills produce no UI, so this evidence type is documented for future eval cycles but is not expected to appear in this audit's report. If a future skill needs visual evidence, save the screenshot under `thoughts/shared/reviews/screenshots/<skill>-<scenario>.png` and reference it inline.

A scenario with no evidence is not gradable — mark it `blocked` rather than guessing the result.

## 4. Mapping Results to PASS / FAIL / partial / blocked

For each scenario, choose exactly one of the four grades below. Record the grade in the per-skill section's `### Grade Summary` table and propagate it into the top-of-file `## Summary Table`.

- **PASS** — every assertion checkbox in the scenario can be checked from the captured evidence. No assertion is ambiguous or contradicted.

- **FAIL** — at least one assertion fails AND the agent ran to completion (i.e., a real failure of the skill's behavior, not an environmental problem). FAIL triggers the bug-filing flow in Section 5.

- **partial** — the scenario produced meaningful output but one or more assertions cannot be evaluated from the evidence (e.g., interactive skill where simulation could not exercise a branch, or assertion is so vague that no observation could falsify it). Note in the per-skill report which assertions were unevaluable and why; capture vague-assertion findings for the synthesis issue (#867) per Section 7 step 8. Do NOT file a FAIL bug for partial — the issue is with the eval, not the skill.

- **blocked** — the scenario could not be run at all. Causes include: missing prerequisite (test issue not present, environment unset), broken dev environment, agent contract changed between scenario authorship and execution, MCP server unavailable, etc. Record the blocker reason verbatim in the evidence section; do NOT FAIL the skill for environmental problems. If the blocker is a real skill regression (e.g., the agent crashes), grade as FAIL not blocked.

A skill's overall status in the summary table is derived from the per-scenario grades:
- All three PASS → `passed`
- Any FAIL → `failed` (count the FAIL bugs filed)
- Any blocked → `blocked` (skill cannot be fully evaluated this cycle)
- Mix of PASS and partial only → `partial`

## 5. Filing a FAIL Bug

When a scenario grades FAIL, file a bug as a sub-issue of the **parent skill issue** (NOT of the eval-scenarios.md file, NOT of the eval-execution issue). For example, a ralph-triage Scenario A failure becomes a sub-issue of #567 (the ralph-triage parent skill issue), not of #850 (the ralph-triage eval-execution child).

Use this canonical body template:

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

Field guidance:

- **Title** — `Eval FAIL: <skill> / Scenario <X> — <one-line summary>` (e.g., `Eval FAIL: ralph-triage / Scenario A — RALPH_TRIAGE_ACTION not set on CLOSE branch`).
- **Failed Assertions** — copy the exact assertion text(s) verbatim from the scenario file. One bullet per failed assertion. Keep the unchecked `- [ ]` so the bug closer can mark them once the fix lands.
- **Evidence** — copy the same evidence shown in the per-skill report section. Do not abbreviate further here; the bug must stand on its own.
- **Suggested Fix Direction** — a brief diagnosis (one or two sentences). If you have no diagnosis, write `Diagnosis pending — observed failure with no obvious root cause; assigned for skill maintainer triage.`

After filing the bug, also link it from the per-skill section of the report under `### FAIL Bugs Filed` so the synthesis agent (#867) does not have to re-discover them.

**Important — what NOT to do:**

- Do NOT modify the source `eval-scenarios.md` file when grading a FAIL. The eval files are read-only inputs to this audit; eval-quality complaints (vague assertions, environmental coupling, missing edge cases) are recorded separately for #867 per Section 7 step 8. If the eval itself is the problem (not the skill), grade `partial` and log the complaint, do not FAIL.
- Do NOT close the parent skill issue when filing the bug. The bug is a sub-issue; closure is the skill maintainer's call after fix.
- Do NOT batch multiple unrelated assertion failures into one bug. One bug per scenario; if a scenario fails three different assertions, list all three under `### Failed Assertions` in a single bug — but do not combine assertions across scenarios.

## 6. JSON vs Markdown Eval Format Decision

**Decision**: Keep both formats separate for this audit cycle.

The phase-2 audit operates against the markdown `eval-scenarios.md` files in each skill directory. A separate JSON eval format exists at `plugin/ralph-hero/skills/design-system-audit/evals/evals.json` with typed assertions (`structural`, `scoring`, `content`). For this audit cycle, the markdown file is the canonical input for grading; the JSON file is supplementary reference only.

Rationale:

1. **Format already locked by parent plan**. The parent audit plan (`thoughts/shared/plans/2026-04-25-GH-0567-bundled-skill-audits-phase-2.md`) phases 1-9 created 17 markdown eval files (merged in PR #844). Sixteen of seventeen audited skills have only the markdown format. The audit was scoped against markdown.

2. **JSON format predates the markdown convention**. The `design-system-audit/evals/evals.json` file uses a `{prompt, expected_output, assertions: [{text, type}]}` shape with typed assertions that pre-date the phase-1 audit work. The format is not currently consumed by any tooling in the repo (no eval runner reads it programmatically yet).

3. **Consolidation has no immediate benefit**. Porting the JSON file's typed assertions into markdown would lose the `structural`/`scoring`/`content` typing (markdown checklists are untyped). Porting all 17 markdown files into JSON would mean rewriting them for no immediate consumer. Either direction is a net loss for this audit cycle.

4. **Per-skill consequence for #866**. The design-system-audit eval-execution issue (#866) grades against `plugin/ralph-hero/skills/design-system-audit/eval-scenarios.md` (the markdown file) using the assertion-checklist pattern documented in Sections 1-5 of this runbook. The JSON file is supplementary reference: if the markdown scenario maps cleanly onto a JSON entry (same prompt, same expected output category), the JSON's typed assertions can inform partial-credit notes, but they do not bind grading.

This decision is revisitable. After the audit completes (#867 synthesis lands), a follow-up issue can re-evaluate whether to consolidate formats — for example, by extending the markdown frontmatter to declare assertion types, or by writing a converter that emits both formats from a single source. Such consolidation work is out of scope for this audit cycle.

## 7. Per-Scenario Workflow Checklist

For each scenario in your assigned skill's `eval-scenarios.md`, follow this checklist in order:

1. **Read the scenario file** — open `plugin/ralph-hero/skills/<skill>/eval-scenarios.md` for the assigned skill and read it end-to-end before executing the first scenario.
2. **For each scenario**: read its `### Input`, `### Expected Behavior`, and `### Assertions` subsections in full.
3. **Construct the invocation** per Section 2 (Skill / Agent / interactive simulation). Pick exactly one pattern per scenario based on how the skill is normally invoked.
4. **Execute** the invocation in the audit environment. Capture the full agent response and any side-effect log lines as they occur — do not rely on memory.
5. **Capture evidence** per Section 3. At minimum, paste the agent's primary response inline; add log lines for any assertion that depends on a side effect not visible in the response.
6. **Grade** per Section 4. Pick exactly one of PASS / FAIL / partial / blocked. Record the grade in the per-skill `### Grade Summary` table and propagate to the top-of-file `## Summary Table`.
7. **For FAILs**: file a bug per Section 5. Link the bug under `### FAIL Bugs Filed` in the per-skill report section.
8. **Capture eval-quality complaints** for the synthesis child (#867). When you encounter vague assertions, environmental coupling, missing edge cases, or scenario-file structural deviations, append a bullet under the report's `## Eval-Scenario Quality Findings` section attributing the finding to the source skill and scenario. Do not modify the source `eval-scenarios.md` file.
9. **Append findings** to the per-skill section in the report file at `thoughts/shared/reviews/2026-04-25-skill-audit-phase-2-eval-results.md`. Update the metadata block (`Status:`, `Date executed:`), fill in the Grade Summary table, paste evidence, and list any FAIL bugs filed. Do not create new top-level sections — append within the existing per-skill stub.

When all three scenarios for the assigned skill are graded and the per-skill report section is filled, the eval-execution issue (e.g., #850 for ralph-triage) is complete and can be moved to Done. The synthesis issue (#867) consumes the populated report once all sibling execution issues finish.
