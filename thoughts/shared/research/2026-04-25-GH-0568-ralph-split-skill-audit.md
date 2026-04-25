---
date: 2026-04-25
github_issue: 568
github_url: https://github.com/cdubiel08/ralph-hero/issues/568
status: complete
type: research
tags: [ralph-split, skill-audit, decomposition, sub-issues, workflow]
---

# Audit ralph-split skill — eval decomposition quality

## Prior Work

- builds_on:: None identified.
- tensions:: None identified.

## Problem Statement

ralph-split is the core decomposition skill for the Analyst tier — it takes M/L/XL issues and breaks them into XS/S atomic sub-issues. Phase 1 of the skill audit (PR #565) fixed systemic bugs: the `Task()` → `Agent()` tool name, missing MCP tools in `allowed-tools`, and interactive/autonomous description confusion. Phase 2 (#568, child of #566) focuses on content quality: does the SKILL.md clearly guide decomposition, what split strategies exist, and how good are the resulting children's titles/scope/dependencies in practice?

## Current State Analysis

### SKILL.md Structure

`plugin/ralph-hero/skills/ralph-split/SKILL.md` is 318 lines. The YAML frontmatter is correct: `user-invocable: false`, `context: fork`, `model: opus`. Allowed-tools list is comprehensive and includes `mcp__plugin_ralph-hero_ralph-github__ralph_hero__remove_dependency`, which is **not** present in `split-agent.md`'s tools field (discrepancy noted below).

The workflow runs 11 steps (Step 1 through Step 11):

| Step | Purpose |
|------|---------|
| 1 | Select issue (by number or oldest M+ in Backlog/Research Needed) |
| 2 | Fetch + verify it needs splitting (M/L/XL guard) |
| 3 | Discover existing children |
| 4 | Research scope via parallel sub-agents |
| 5 | Propose split with reuse/update/create plan |
| 6 | Create or update sub-issues |
| 7 | Establish blocking dependencies |
| 8 | Update original issue (body + comment) |
| 9 | Move sub-issues to appropriate state |
| 10 | Team result reporting |
| 11 | Report |

### Split Strategies Defined

The SKILL.md provides a five-row lookup table (Step 5):

| Original Type | Split Strategy |
|---------------|----------------|
| Database schema | One issue per table/view |
| ETL pipeline | Extract, Transform, Load as separate issues |
| API endpoint | Repository, Service, Router as separate issues |
| Multi-state feature | One issue per state |
| Frontend feature | Component, State, Integration as separate issues |

This table is **software-architecture-centric** and covers none of the skill-audit, refactoring, documentation, or meta-engineering work that makes up most of the actual ralph-hero backlog. For issue #576 ("Extract shared content to fragments"), the agent decomposed by _candidate fragment_ rather than any table entry — it reasoned from the issue body directly.

### Sub-Issue Description Template

The sub-issue body template (Step 6) includes: Summary, Scope, Acceptance Criteria, References (parent + related files), and Out of Scope. This template is well-structured and the #576 split produced children (#840-843) that followed it faithfully.

### Hook Enforcement

Four hooks govern the split skill:

- **SessionStart**: `set-skill-env.sh` sets `RALPH_MIN_ESTIMATE=M`, `RALPH_VALID_SUB_ESTIMATES='XS,S'`, `RALPH_REQUIRED_BRANCH=main`.
- **PreToolUse (Bash)**: `branch-gate.sh` — enforces main branch.
- **PreToolUse (ralph_hero__get_issue)**: `split-estimate-gate.sh` — currently a **no-op**: it only emits an allow-with-context message and never blocks. The gate delegates enforcement to the agent itself after fetching the issue, rather than checking the fetched estimate from the response. This means a mis-estimated XS/S issue could be fetched without mechanical prevention.
- **PreToolUse (ralph_hero__create_issue)**: `split-size-gate.sh` — validates that `estimate` on the create call is in `RALPH_VALID_SUB_ESTIMATES`. This is the real enforcement boundary.
- **PostToolUse (ralph_hero__add_sub_issue)**: `split-verify-sub-issue.sh` — confirms `parentNumber` and `childNumber` are present. Warns (does not block) if `parentNumber` is missing.
- **Stop**: `split-postcondition.sh` — blocks if `RALPH_SPLIT_COUNT=0`, confirming at least one sub-issue was created.

### Agent Definition vs SKILL.md Discrepancy

`plugin/ralph-hero/agents/split-agent.md` tools field includes `mcp__plugin_ralph-hero_ralph-github__ralph_hero__remove_dependency` but **does not include** `mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment` or `mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues`. The SKILL.md allowed-tools includes `create_comment` and `list_sub_issues` but does not list `remove_dependency`. This asymmetry means:

- When running as split-agent, the agent **cannot** post the split summary comment on the original issue (Step 8 requires `create_comment`) — unless the agent silently falls back or the hook enforcement allows the call.
- When running directly via `/ralph-split`, `remove_dependency` is not in `allowed-tools`, so cleanup of stale dependencies would fail.

## Key Discoveries

### 1. Split Strategy Table Covers Only Software Engineering Patterns

The five-entry table maps cleanly to database/ETL/API/multi-state/frontend work. None of the 10 sub-issues in the #566 audit group (or the #576 fragment extraction) match these categories. The agent decomposed #576 correctly by reading the issue body's explicit candidate list, but this was pure LLM reasoning with no pattern guidance in the skill.

**Impact**: For content-refactoring or meta-engineering issues (skill audits, fragment extractions, doc updates), the agent is flying blind on strategy. Quality depends entirely on the richness of the issue body.

### 2. #576 → #840-843 Split: Strong Concrete Result

The #576 split produced 4 sub-issues (3 XS + 1 S), all set to "Ready for Plan". Quality assessment:

**Titles**: Precise and action-oriented. "Extract Link Formatting fragment — replace duplicates in 10 skills" is specific about the artifact and the scope. All four follow the same naming pattern: `Extract [fragment name] fragment — [action phrase]`.

**Scope sections**: Each child lists exact files to create and update. #840's scope names all 10 consumer skills explicitly. #841's scope correctly flags ambiguity ("decide whether to extend existing... or create a unified...") rather than pre-deciding.

**Acceptance criteria**: Checkbox-formatted, specific, and includes a verification command (`grep -rn "Link Formatting" skills/`). This is better than average.

**References**: Parent link is present. File links are GitHub URLs resolving to correct paths.

**Out of Scope**: Each sibling issue is named, preventing scope bleed.

**Dependencies**: No blocking dependencies were set between #840-843. The split comment notes "all 4 are independent and can run in parallel" — this is correct for fragment extraction (each targets different files). The dependency section of the skill (Step 7) was correctly omitted because no sequential ordering was needed.

**Gap**: The split summary comment on #576 contains a research note ("Artifact Comment Protocol partially extracted already") that should have been captured inside #841's body, not just in the parent comment. An implementer reading only #841 would miss this context, requiring them to read the parent comment. The "Out of Scope" section of #841 mentions sibling issues but not the existing partial extraction to investigate — this is a context-loss anti-pattern named in the Quality Guidelines.

### 3. Scope Selection: Oldest-First Is Ambiguous

Step 1 says "find oldest M+ issue in Research Needed or Backlog" — but does not define "oldest" by `createdAt`, `updatedAt`, or some other ordering. The agent has to guess. A `createdAt` ordering is most common, but this could pick up stale deprioritized issues over recently-triaged ones.

### 4. Description Triggering

The skill description is: "Split large GitHub issues (M/L/XL) into smaller XS/S sub-issues for atomic implementation. Use when you want to split issues, break down tickets, decompose epics, or make large work items implementable."

`user-invocable: false` — this is correct; the skill is orchestrator-dispatched. The description is adequate for routing by the hero orchestrator.

### 5. No "Skill/Non-Code" Split Patterns

The split strategy table is incomplete for the ralph-hero workflow itself, which frequently needs to split:
- Multi-skill audit issues (one issue per skill)
- Cross-cutting refactoring (one issue per pattern type)
- Documentation/extraction work (one issue per document or fragment)

These patterns are not named, leaving the agent to discover them from context.

### 6. Escalation Threshold Is Ambiguous

The escalation trigger "Split would create too many issues (>5)" conflicts with the example of #566 spawning 10 children. For large audit or refactoring epics, >5 sub-issues is normal. The threshold needs to be calibrated by issue type, not a hard number.

### 7. Constraint "Complete within 10 minutes" Is Unrealistic for L/XL Issues

For large scope issues requiring sub-agent spawning (Step 4), 10 minutes is insufficient. Research codebase + analyze + propose split + create 4-6 sub-issues + set dependencies typically takes 15-20 minutes. A deadline violation may cause the agent to skip codebase research (Step 4) and decompose only from the issue title/body.

## 5-Step Audit Process Comparison (from #566)

| Audit Step | Status |
|------------|--------|
| 1. Read and analyze skill content for structural issues | Done above — split strategy table gap, agent/skill tool discrepancy, estimate-gate no-op, template quality |
| 2. Create 2-3 eval scenarios and run with/without skill | Not applicable for this research pass (requires runtime execution). Recommended for Plan phase. |
| 3. Grade outputs against assertions | Graded #576 → #840-843 split: strong titles/scope/AC; partial context-loss in #841 |
| 4. Apply content improvements based on findings | Plan phase work |
| 5. Optimize description for triggering accuracy | Description is adequate for orchestrator dispatch; user-invocable=false means triggering is not a concern |

## Potential Approaches

### Option A: Extend Split Strategy Table
Add rows for skill-audit, fragment-extraction, doc-update, and cross-cutting-refactor patterns. Pros: model has explicit guidance. Cons: table could become unwieldy; most patterns are better detected from issue body.

**Recommended**: Add 3-4 rows covering non-code patterns. Keep the table concise.

### Option B: Research Notes → Child Body Convention
Add an instruction in Step 8 to embed any research-phase notes (like the partial-extraction note in #576) into the relevant child's body rather than only in the parent comment. This closes the context-loss gap.

**Recommended**: Add a mandatory "Research notes → affected children" step between Step 8 and Step 9.

### Option C: Fix Agent/SKILL.md Tool Discrepancy
Align `split-agent.md` tools with SKILL.md allowed-tools: add `create_comment` and `list_sub_issues`; ensure `remove_dependency` is in both.

**Recommended**: Always fix — this is a correctness bug, not a quality preference.

### Option D: Replace 10-Minute Constraint with Effort-Scaled Constraint
Change from "complete within 10 minutes" to "complete within 15 minutes for M, 20 minutes for L/XL". Or remove the absolute limit and rely on `maxTurns` in the agent definition.

**Recommended**: Raise to 20 minutes; note that Step 4 codebase research is optional if issue body is explicit.

### Option E: Calibrate Escalation Threshold
Replace ">5 issues" with ">5 issues per decomposition level, not counting epics already structured as groups". Or remove the numeric limit and replace with "escalate if you cannot identify natural boundaries" only.

**Recommended**: Remove the numeric limit; keep the semantic trigger.

## Risks

- **Tool discrepancy (Option C) is a live bug**: if split-agent is dispatched and tries to post the split summary comment (Step 8), it will fail silently or error. The current #576 split comment exists, suggesting either the skill ran directly (not via split-agent) or the comment was created through another path.
- **Estimate-gate no-op**: without mechanical enforcement on `get_issue` response, the LLM can proceed on an XS/S issue even if the skill instructions say to stop. The `split-size-gate.sh` on `create_issue` is the true backstop, but only catches the sub-issue creation — not the upstream selection error.
- **10-minute time pressure** may cause hasty decomposition on complex issues, producing under-researched children that require re-research later.

## Recommended Next Steps

1. **Fix tool discrepancy** (Priority: P1) — Add `create_comment` and `list_sub_issues` to `split-agent.md` tools; add `remove_dependency` to SKILL.md allowed-tools or remove it from the agent if unused.
2. **Extend split strategy table** with non-code patterns (Priority: P2) — skill-audit, fragment-extraction, doc-update.
3. **Add "research notes → child body" step** (Priority: P2) — after Step 8, embed relevant research context into child bodies.
4. **Raise time constraint to 20 minutes** (Priority: P3) — reflect realistic L/XL workloads.
5. **Calibrate escalation threshold** (Priority: P3) — replace ">5 issues" with semantic guidance.
6. **Strengthen split-estimate-gate.sh** (Priority: P3) — make it actually check the fetched issue's estimate from the response, rather than being a passthrough.

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/ralph-split/SKILL.md` — extend split strategy table, add research-notes→child step, raise time constraint, calibrate escalation threshold
- `plugin/ralph-hero/agents/split-agent.md` — add `create_comment`, `list_sub_issues`; sync tools with SKILL.md allowed-tools
- `plugin/ralph-hero/hooks/scripts/split-estimate-gate.sh` — implement actual estimate check from get_issue response

### Will Read (Dependencies)
- `plugin/ralph-hero/hooks/scripts/split-size-gate.sh` — current enforcement boundary for sub-issue sizing
- `plugin/ralph-hero/hooks/scripts/split-postcondition.sh` — stop-hook verification logic
- `plugin/ralph-hero/hooks/scripts/split-verify-sub-issue.sh` — post-tool-use sub-issue link verification
- `plugin/ralph-hero/skills/shared/quality-standards.md` — canonical quality dimensions
- `plugin/ralph-hero/skills/shared/fragments/escalation-steps.md` — shared escalation guidance
