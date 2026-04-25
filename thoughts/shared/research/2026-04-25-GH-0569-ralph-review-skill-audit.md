---
date: 2026-04-25
github_issue: 569
github_url: https://github.com/cdubiel08/ralph-hero/issues/569
status: complete
type: research
tags: [skill-audit, ralph-review, plan-review, auto-mode, interactive-mode, quality-gate]
---

# GH-569: Audit ralph-review skill — eval plan critique quality

## Prior Work

- builds_on:: None identified.
- tensions:: None identified.

## Problem Statement

Phase 2 of the skill audit series focuses on deep individual audits. ralph-review is the pipeline's quality gate between planning and implementation. Phase 1 (#565) fixed Task→Agent and allowed-tools systemic bugs. This audit evaluates whether ralph-review's AUTO mode produces useful critique, whether INTERACTIVE mode presents the plan clearly to humans, and whether the quality gate criteria in both modes are sufficient to catch bad plans before implementation begins.

## Current State Analysis

### Skill Structure (SKILL.md)

The ralph-review SKILL.md is 411 lines and covers:
- **Frontmatter** (lines 1-53): hooks, allowed-tools, description, mode config
- **Workflow** (Steps 1-7): mode detection, issue selection, plan discovery, mode-specific review, transition execution, team reporting, completion report
- **Escalation protocol** (injected via fragment)
- **Quality guidelines** (pointer to shared/quality-standards.md)

The skill correctly declares `user-invocable: false`, uses `context: fork`, and specifies `model: opus` — appropriate for a quality gate role.

### Agent Definition (review-agent.md)

File: `plugin/ralph-hero/agents/review-agent.md`

```
tools: Read, Write, Glob, Grep, Bash, Agent, AskUserQuestion,
       mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue,
       mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues,
       mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue,
       mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
```

The agent definition is minimal but correct. The `AskUserQuestion` tool is present — needed for INTERACTIVE mode. Both list_issues and get_issue are declared — needed for Step 2 and Step 3. No `Task` tool is listed even though the SKILL.md `allowed-tools` includes it. This is a discrepancy: the SKILL.md declares `Task` in `allowed-tools`, but the agent definition's `tools:` field does not include `Task`. Since the agent definition's `tools:` is the hard allowlist enforced at runtime, `Task` is effectively unavailable to review-agent even though the skill says it's allowed.

## Key Discoveries

### Discovery 1: AUTO Mode Critique Quality is Shallow (Critical Gap)

**Location**: `plugin/ralph-hero/skills/ralph-review/SKILL.md` lines 224-264

The AUTO mode spawns a `general-purpose` subagent with a prompt that defines four quality criteria:

1. Completeness: Are all phases defined with clear changes?
2. Feasibility: Do referenced files exist? Are patterns valid?
3. Clarity: Are success criteria specific and testable?
4. Scope: Is 'What we're NOT doing' well-defined?

However, the shared quality-standards.md (`plugin/ralph-hero/skills/shared/quality-standards.md`) defines **five** dimensions for plan review:

1. Completeness
2. Feasibility
3. Clarity
4. Scope
5. **Dispatchability** — Every task is self-contained enough to dispatch to a subagent with zero additional context. Task has files, TDD flag, acceptance criteria, and dependency info.

The AUTO mode prompt is **missing Dispatchability**, which is arguably the most operationally critical criterion — it directly determines whether ralph-impl can execute the plan without ambiguity. The quality-standards.md also defines the **Task Metadata Requirements** table (files, tdd, complexity, depends_on, acceptance), none of which are included in the AUTO critique prompt.

**Impact**: AUTO mode can approve plans that pass the four listed criteria but are undispatchable because tasks lack file lists, TDD flags, or dependency declarations. The impl agent will then need to infer these details, leading to drift, hallucination, or failed runs.

### Discovery 2: AUTO Mode Uses Wrong Subagent Type (Structural Gap)

**Location**: `plugin/ralph-hero/skills/ralph-review/SKILL.md` line 224

```
Agent(subagent_type="general-purpose", ...)
```

The critique is spawned as a `general-purpose` agent, not as a `ralph-hero:codebase-analyzer` or dedicated review subagent. A `general-purpose` agent:
- Has no preloaded skill context about ralph plans, quality-standards, or task metadata requirements
- Cannot access the `quality-standards.md` fragment unless the prompt explicitly copies its content
- Has no access to the MCP tools needed to fetch issue details (the prompt references "Read the plan document attached to issue #NNN" without providing the plan path or read capability)

The subagent prompt instructs the critique agent to itself spawn a `codebase-analyzer`:
```
Agent(subagent_type='ralph-hero:codebase-analyzer', prompt='Verify files mentioned in plan exist: [list files]')
```

But the outer `general-purpose` agent cannot call `Agent()` unless `Agent` is in its allowed tools — and `general-purpose` agents have no guaranteed toolset. This creates a nested-agent call that may fail silently.

### Discovery 3: AUTO Mode Missing ESCALATE Verdict

**Location**: `plugin/ralph-hero/skills/ralph-review/SKILL.md` lines 256-275

The AUTO mode only supports two JSON outcomes: `APPROVED` or `NEEDS_ITERATION`. The issue title references three verdicts: `APPROVED / NEEDS_ITERATION / ESCALATE`. The ESCALATE path exists in the escalation protocol (uses `__ESCALATE__` intent), and `Human Needed` is listed as a valid output state in the `set-skill-env.sh` call:

```
RALPH_VALID_OUTPUT_STATES='In Progress,Ready for Plan,Human Needed'
```

But the AUTO mode subagent prompt has no mechanism to return `ESCALATE`. If the critique agent identifies a fundamental issue (conflicting requirements, ambiguous scope), it can only return `NEEDS_ITERATION` — it cannot trigger escalation. The escalation protocol is only documented under the **Escalation Protocol** section, which the `general-purpose` subagent does not inherit.

### Discovery 4: INTERACTIVE Mode Critique Gap — No Plan Summary

**Location**: `plugin/ralph-hero/skills/ralph-review/SKILL.md` lines 144-162 (Step 4A)

The INTERACTIVE mode reads the plan document and presents a picker, but there is no step that **summarizes the plan for the human reviewer** before asking for a verdict. The wizard jumps directly to the "Approve / Minor Changes / Major Changes / Reject" picker without:
- Showing the plan title and scope
- Listing the phases
- Surfacing the success criteria

A human reviewer must have separately opened the plan or have a mental model of it. The "Open in editor" option provides an escape hatch, but it requires the reviewer to read the entire plan and then return to the picker — no in-terminal summary is presented.

This is a usability gap: the wizard should display a plan summary (title, phase count, estimated complexity) before showing the verdict picker.

### Discovery 5: Review Decision Capture in INTERACTIVE Mode is Binary

**Location**: `plugin/ralph-hero/skills/ralph-review/SKILL.md` lines 182-217

When the human selects "Minor Changes", a follow-up multi-select picker captures the change categories (Clarify success criteria / Add missing details / Fix technical approach / Update scope boundaries). However, this selection **does not block progression** — the flow continues to the approval path. Minor changes are noted in a comment but no loop or re-review is required.

When "Major Changes" or "Reject" is selected, a similar multi-select captures issue categories but provides only four coarse options: Insufficient research / Wrong approach / Missing requirements / Scope issues. No free-text field exists for capturing specific, actionable feedback. The GitHub comment generated will contain only the selected category labels — not specifics — reducing the quality of feedback returned to the plan agent.

### Discovery 6: Postcondition Hook Does Not Validate Verdict Quality

**Location**: `plugin/ralph-hero/hooks/scripts/review-postcondition.sh`

The postcondition hook checks:
1. In AUTO mode: that a critique document exists for the ticket ID
2. That there are no uncommitted files in the artifact dir

It does **not** check:
- Whether the verdict in the critique document is justified (has issue list when NEEDS_ITERATION)
- Whether the critique document contains the required APPROVED/NEEDS_ITERATION text (the doc-structure-validator does check for this)
- Whether a GitHub comment was posted (no API call to verify)
- Whether the state transition actually succeeded

The `doc-structure-validator.sh` checks that the review doc contains `APPROVED|NEEDS_ITERATION` — this is good but minimal.

### Discovery 7: Task Tool Discrepancy (Agent vs Skill)

**Location**: `plugin/ralph-hero/agents/review-agent.md` line 5

The review-agent.md `tools:` field does not include `Task`, but SKILL.md `allowed-tools` includes it (line 47). At runtime, the agent's `tools:` field is the authoritative allowlist. `Task` is a deprecated predecessor to `Agent` in Claude's SDK — its presence in `allowed-tools` without inclusion in the agent's `tools:` creates confusion but no functional breakage (since `Agent` is available).

### Discovery 8: Description Triggering Analysis

**Location**: `plugin/ralph-hero/skills/ralph-review/SKILL.md` line 2

```
description: Review and critique implementation plans before coding begins. INTERACTIVE mode for human review, AUTO mode for automated critique. Use when you want to review a plan, approve or reject a spec, or run quality gates on plans.
```

Since `user-invocable: false`, this description is used for agent routing (the hero orchestrator deciding which agent to dispatch), not for human slash-command matching. The description correctly covers the primary use case and both modes. It is long but informative. No triggering issues identified — the skill is dispatched programmatically by the hero pipeline, not by description matching.

### Discovery 9: Plan Discovery Robustness is Good

**Location**: `plugin/ralph-hero/skills/ralph-review/SKILL.md` lines 108-137

The plan discovery sequence (Step 3) is thorough: knowledge graph shortcut → artifact flag shortcut → comment scan → glob fallback → group fallback → self-heal. This 8-step cascade with self-healing is a strong pattern. No gaps identified here.

### Discovery 10: Commit Message in AUTO Prompt has Syntax Bug

**Location**: `plugin/ralph-hero/skills/ralph-review/SKILL.md` lines 251-254

```
git commit -m 'docs(review): GH-NNN plan critique

git push origin main
```

The commit message string is missing its closing single-quote before `git push`. This would cause the shell to treat everything up to the next single-quote as the commit message, including the `git push` command. The correct form should be:

```
git commit -m 'docs(review): GH-NNN plan critique'

git push origin main
```

This is a syntax bug that would cause the commit to fail in AUTO mode if the subagent executes the literal bash command from the prompt.

## Quality Gate Criteria Analysis

### Criteria Coverage vs quality-standards.md

| Criterion | quality-standards.md | AUTO Mode Prompt | INTERACTIVE Wizard |
|-----------|---------------------|-----------------|-------------------|
| Completeness | Yes | Yes | Implicit (human judgment) |
| Feasibility | Yes | Yes | Implicit |
| Clarity | Yes | Yes | Implicit |
| Scope | Yes | Yes | Implicit |
| Dispatchability | Yes | **Missing** | **Missing** |
| Task metadata (files, tdd, complexity, depends_on, acceptance) | Yes (table) | **Missing** | **Missing** |
| Group-specific (phase dependencies, integration tests) | Yes | **Missing** | **Missing** |

The AUTO mode prompt covers 4 of 5 plan dimensions. Task metadata requirements and group-specific requirements are not evaluated in either mode.

### 5-Step Audit Process Comparison (from #566)

The parent issue defines the audit process as:
1. Read and analyze skill content for structural issues — done in this research
2. Create 2-3 eval scenarios and run with/without skill — deferred to plan phase
3. Grade outputs against assertions — deferred to plan phase
4. Apply content improvements based on findings — deferred to impl phase
5. Optimize description for triggering accuracy — description is `user-invocable: false`, no optimization needed

This research document addresses step 1 fully. Steps 2-4 require plan + impl work.

## Potential Approaches

### Option A: Inline Quality Criteria in AUTO Prompt

Embed the full quality-standards.md content (or a targeted subset) directly in the AUTO mode Agent() prompt. This is the simplest fix.

**Pros**: No new files; works immediately with no infrastructure changes.
**Cons**: Prompt bloat; quality-standards.md changes won't automatically propagate.

### Option B: Use a Dedicated `ralph-hero:review-critique-agent`

Create a new agent definition that preloads ralph-review and quality-standards, replacing `general-purpose` with a purpose-built critique agent.

**Pros**: Inherits full skill context; avoids prompt bloat; quality-standards.md changes propagate automatically.
**Cons**: Adds an agent file; increases system complexity.

### Option C: Fix AUTO Prompt + Add Plan Summary to INTERACTIVE

Targeted fixes: (1) extend the AUTO prompt to cover dispatchability and task metadata, (2) add a plan summary display step before the INTERACTIVE verdict picker.

**Pros**: Minimal change, addresses the highest-impact gaps.
**Cons**: Does not address the `general-purpose` subagent type risk.

**Recommended**: Option C is the minimum viable fix. Option B should follow as a follow-up.

## Risks

- **Plan over-approval**: The missing Dispatchability criterion means the current AUTO mode can approve plans that will fail during implementation, causing wasted impl cycles.
- **Silent critique failure**: The `general-purpose` subagent with nested `Agent()` calls may fail without surfacing an error to the reviewer, causing AUTO mode to appear to hang or return a malformed JSON result.
- **Human reviewer blind spots**: The INTERACTIVE mode presents a verdict picker without a plan summary; reviewers who have not read the plan will approve/reject based on insufficient context.
- **Commit syntax bug**: The unclosed commit message in the AUTO prompt will cause the git commit step to fail when run literally, leaving critique docs uncommitted.

## Recommended Next Steps

1. Extend AUTO mode critique prompt to include Dispatchability dimension and Task Metadata Requirements table from quality-standards.md.
2. Add a plan summary display step to INTERACTIVE mode before the verdict picker (title, phases, estimated complexity).
3. Fix the commit message syntax bug in the AUTO prompt (add closing quote).
4. Add an ESCALATE return path to the AUTO mode JSON schema and handle it in Step 4B's routing logic.
5. Remove `Task` from SKILL.md `allowed-tools` (deprecated, replaced by `Agent`; already absent from agent definition).
6. Add free-text capture to the INTERACTIVE rejection flow (currently limited to 4 coarse categories).
7. Consider creating a `ralph-hero:review-critique-agent` to replace `general-purpose` subagent in AUTO mode.

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/ralph-review/SKILL.md` - Fix AUTO prompt (dispatchability, commit syntax), add INTERACTIVE plan summary, fix ESCALATE routing, remove Task from allowed-tools
- `plugin/ralph-hero/agents/review-agent.md` - Remove Task from tools list if cleanup desired (no functional impact)

### Will Read (Dependencies)
- `plugin/ralph-hero/skills/shared/quality-standards.md` - Source of truth for plan quality criteria
- `plugin/ralph-hero/hooks/scripts/review-postcondition.sh` - Postcondition validation logic
- `plugin/ralph-hero/hooks/scripts/review-verify-doc.sh` - Document verification logic
- `plugin/ralph-hero/hooks/scripts/review-state-gate.sh` - State transition validation
- `plugin/ralph-hero/hooks/scripts/review-plan-gate.sh` - AskUserQuestion gate for AUTO mode
- `plugin/ralph-hero/hooks/scripts/doc-structure-validator.sh` - Document structure validation
