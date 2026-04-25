---
date: 2026-04-25
github_issue: 567
github_url: https://github.com/cdubiel08/ralph-hero/issues/567
status: complete
type: research
tags: [skill-audit, ralph-triage, eval, content-quality, skill-description]
---

# Ralph-Triage Skill Audit — Content Quality and Structure

## Prior Work

- builds_on:: None identified.
- tensions:: None identified.

## Problem Statement

Phase 2 of the skill audit (#566) requires a deep content quality review of each skill — running eval scenarios, reviewing the decision tree, testing confidence level guidance, and verifying escalation triggers. Phase 1 (PR #565) already fixed systemic bugs (Task→Agent, missing MCP tools, description confusion). This audit focuses on whether the ralph-triage skill's content is high-quality, unambiguous, and correctly structured for reliable autonomous operation.

## Current State Analysis

### Invocation Context

The ralph-triage skill is invoked in two ways:

1. **Direct user invocation**: A user types `/ralph-triage [optional-issue-number]`. The skill runs in fork context with its own hooks enforcing branch gates, state validity, and postconditions.
2. **Orchestrator dispatch**: The `triage-agent` (`plugin/ralph-hero/agents/triage-agent.md`) preloads the skill. The hero orchestrator dispatches it via `Agent(subagent_type="ralph-hero:triage-agent", ...)`.

The skill is classified `user-invocable: false` in its frontmatter, which correctly signals it is for autonomous use by orchestrators, not direct user invocation. However, the description reads: "Triage GitHub issues from backlog - assess validity, close duplicates, split large tickets, route to research. Use when you want to triage issues, groom the backlog, assess tickets, or clean up issues." The "Use when you want to..." phrasing is user-facing language that conflicts with `user-invocable: false`. This is a mild description quality issue.

### Expected Output

The skill's output is a GitHub issue with one of these state transitions:
- Backlog → Research Needed (RESEARCH action)
- Backlog → Done (CLOSE action)
- Backlog unchanged, sub-issues created (SPLIT action)
- Backlog unchanged, estimate updated (RE-ESTIMATE action)
- Backlog unchanged, comment added (KEEP action)
- Backlog → Human Needed (ESCALATE)

The `triage-postcondition.sh` hook validates that `RALPH_TRIAGE_ACTION` was set. Valid actions checked by the hook: `RESEARCH|SPLIT|CLOSE|KEEP|HUMAN|CANCEL`. Notably, `RE-ESTIMATE` is a valid skill action described in the workflow (Step 4, Step 5) but is NOT listed in the hook's accepted actions — the hook would block a skill run that only re-estimated. This is a content/hook alignment bug.

### Structural Analysis of SKILL.md

#### Strengths

- Step sequence is logical: branch check → issue selection → assess → recommend → act → label → link → report
- Decision tree (CLOSE/SPLIT/RE-ESTIMATE/RESEARCH/KEEP) has clear criteria for each branch
- Confidence levels section is well-written and helps the agent calibrate assertiveness
- Escalation table is comprehensive, covering 6 specific trigger cases
- SPLIT action has the most detailed guidance: existing children check, three-step creation pattern, do-not-close parent rule
- Step 7 (Find and Link Related Issues) provides thorough grouping guidance with dependency chain examples
- Filter profiles table is helpful for understanding query expansion

#### Structural Issues

**Issue 1: RE-ESTIMATE action not recognized by postcondition hook.**
The skill defines RE-ESTIMATE as a valid action in Steps 4 and 5. But `triage-postcondition.sh` only accepts `RESEARCH|SPLIT|CLOSE|KEEP|HUMAN|CANCEL`. If the skill only re-estimates (no state change, just estimate + comment), the hook will block with "no action taken." The skill should instruct the agent to set `RALPH_TRIAGE_ACTION=RE-ESTIMATE` (or alternatively include RE-ESTIMATE in the hook's accepted set).

**Issue 2: RALPH_TRIAGE_ACTION not mentioned in SKILL.md content.**
The postcondition hook checks `RALPH_TRIAGE_ACTION` env var to gate completion, but nowhere in the SKILL.md body does it tell the agent to set this variable. The skill instructs "Take Action" and "Report" without any mention of signaling the postcondition hook. This is a silent failure mode: a well-behaved agent that takes an action but doesn't set the env var will be blocked by the hook. The skill needs an explicit step or note: "Before completing, set RALPH_TRIAGE_ACTION to [action] via Bash."

**Issue 3: triage-agent tool list is narrower than skill's allowed-tools.**
The `triage-agent.md` declares tools:
```
Read, Glob, Grep, Bash, mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue,
mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues,
mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue,
mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
```
The SKILL.md `allowed-tools` additionally lists: `Task`, `Agent`, `WebSearch`, `create_issue`, `add_sub_issue`, `list_sub_issues`, `add_dependency`. The agent cannot spawn sub-agents (no `Task`/`Agent`), cannot create issues (no `create_issue`), and cannot do sub-issue linking (no `add_sub_issue`/`list_sub_issues`). This means:
- Step 3's "Spawn parallel sub-tasks" for codebase assessment is impossible via triage-agent
- Step 5's SPLIT action (create issues → link as sub-issues → set estimate) is impossible via triage-agent

When invoked through the orchestrator as a triage-agent, the skill cannot execute its full workflow. The agent tool list must be expanded to match the skill's functional requirements.

**Issue 4: Step 2 issue selection algorithm is verbose but correct.**
The two-query pattern (get triaged numbers, get all Backlog, find first not in triaged set) is sound. However the description says "oldest untriaged issue" but the query uses `orderBy: "createdAt"` without specifying direction. The `list_issues` tool may default to descending (newest first). The skill should specify `orderBy: "CREATED_AT"` ascending explicitly (or the step should note it picks the first returned). This is an ambiguity that could cause wrong-direction selection.

**Issue 5: No guidance on what constitutes "Backlog" vs already-triaged scope.**
The skip condition is based on the `ralph-triage` label. But issues can arrive in Backlog without the label (fresh from route-issues.yml), and issues can be relabeled. The two-query approach correctly uses label presence as the proxy for "already triaged," which is the right pattern. No structural issue here, but the rationale is not explained — a future agent reading the skill won't understand why label presence equals "triaged."

**Issue 6: Step 7 (Related Issues and Grouping) is well-structured but adds scope ambiguity.**
The grouping guidance in Step 7 is detailed and valuable, but it introduces significant additional work after the primary triage action. The step queries up to 100 additional issues (50 Backlog + 50 Research Needed) and sets dependency relationships. For a skill constrained to "10 minutes," this is an underspecified time risk. The step should note it is optional/best-effort when time budget is tight.

**Issue 7: Error handling guidance is present but inconsistently placed.**
The SPLIT section has explicit error handling ("If `save_issue` returns an error, read the error message..."). But RE-ESTIMATE, RESEARCH, and CLOSE actions lack equivalent guidance. The error recovery pattern should either appear once at the top of Step 5 or be duplicated for each action branch.

#### Content Quality Assessment

| Dimension | Grade | Notes |
|-----------|-------|-------|
| Decision tree clarity | A | CLOSE/SPLIT/RE-ESTIMATE/RESEARCH/KEEP are well-defined with clear criteria |
| Confidence level guidance | A | Three-tier approach (High/Medium/Low) is practical and unambiguous |
| Escalation triggers | A- | Six specific triggers; slight gap: no trigger for "issue is XS/S but estimate is missing" |
| SPLIT action guidance | A | Most complete branch; existing-children check is sophisticated |
| CLOSE action guidance | B+ | Criteria are clear; missing: should CLOSE move to Canceled for "no longer relevant" vs Done for "already done"? |
| RESEARCH action guidance | B | Minimal; just sets state and adds comment. No guidance on what comment content should be. |
| RE-ESTIMATE action guidance | B | Describes the action but missing: the postcondition hook won't accept it |
| Step 7 grouping | B | Valuable but scope/time risk underspecified |
| Postcondition hook alignment | C | RALPH_TRIAGE_ACTION is hidden infrastructure that skill body never mentions |

### Description Triggering Quality

The current description:
> "Triage GitHub issues from backlog - assess validity, close duplicates, split large tickets, route to research. Use when you want to triage issues, groom the backlog, assess tickets, or clean up issues."

Since `user-invocable: false`, this description is used by the orchestrator (hero skill) to select which agent to dispatch. The orchestrator matches the description against natural language task descriptions like "triage the backlog" or "pick up a Backlog issue and assess it." The description is serviceable for this purpose.

However, the "Use when you want to..." phrasing is misleading in the `false` context. A cleaner description would be: "Autonomous backlog groomer — picks oldest untriaged Backlog issue, assesses validity, closes duplicates, splits large tickets, or routes to research. For orchestrator dispatch only."

### Eval Scenarios (None Exist)

No eval scenarios currently exist for ralph-triage. The `plugin/ralph-hero/skills/ralph-triage/` directory contains only `SKILL.md`. The parent issue #566 specifies creating 2-3 eval scenarios as Phase 2 step 2. Three eval scenarios should be created:

**Scenario A: Duplicate detection (CLOSE)**
- Input: An issue describing a feature that clearly exists in the codebase
- Expected behavior: Agent spawns codebase-locator, finds the feature, closes the issue with explanation
- Assertions: workflowState becomes Done, comment explains closure, ralph-triage label applied

**Scenario B: Valid new feature (RESEARCH)**
- Input: An issue for a new feature with clear scope, no existing implementation
- Expected behavior: Agent confirms novelty, routes to Research Needed, adds routing comment
- Assertions: workflowState becomes Research Needed, comment present, ralph-triage label applied

**Scenario C: Large scope (SPLIT)**
- Input: An M-or-larger issue that covers multiple distinct concerns
- Expected behavior: Agent identifies split points, creates 2-3 sub-issues (XS/S), links them
- Assertions: Sub-issues exist, parent unchanged in Backlog, summary comment added

### Fragment Extraction Candidates (#576)

The following content in ralph-triage SKILL.md is duplicated across multiple skills and is a candidate for fragment extraction:

1. **Branch verification step** (Step 1) — identical pattern appears in ralph-research, ralph-split, ralph-plan, and all other autonomous skills. Could be `fragments/step-branch-verify.md`.
2. **Link formatting section** — the full Link Formatting table is repeated verbatim in every skill. Already a known fragment candidate. Could be `fragments/link-formatting.md`.
3. **Team Result Reporting step** (Step 8) — identical "mark your assigned task complete via TaskUpdate" guidance appears in every skill. Could be `fragments/step-team-reporting.md`.
4. **Escalation Protocol header** — already uses `!cat` fragment inclusion for `escalation-steps.md`. The triage-specific triggers table is skill-unique and should stay.
5. **Report template** (Step 9) — partially unique (triage-specific fields) but the Report step structure pattern is shared.

## Risks

1. **Agent tool list gap** is a functional regression risk. Any orchestrator dispatching `triage-agent` for a SPLIT action will silently fail to create sub-issues. This is the highest-priority fix.
2. **RALPH_TRIAGE_ACTION not documented** means agents may complete actions without signaling the postcondition hook, causing false-negative failures. Medium risk since the hook only blocks completion, not the action itself.
3. **RE-ESTIMATE hook gap** is low risk in practice (re-estimation is rare), but when it occurs the skill will be incorrectly blocked.
4. **Confidence level guidance** is good but doesn't address what happens when the agent finds partial evidence — Step 3 synthesis guidance could be clearer.

## Recommended Next Steps

1. **Immediate (plan phase):**
   - Add `Task`, `Agent`, `WebSearch`, `create_issue`, `add_sub_issue`, `list_sub_issues`, `add_dependency` to `triage-agent.md`'s `tools:` field
   - Add `RALPH_TRIAGE_ACTION` documentation to SKILL.md Step 5 (explain each action should set this env var)
   - Add RE-ESTIMATE to `triage-postcondition.sh` accepted actions list
   - Clarify CLOSE destination: Done for "already implemented/fixed", Canceled for "no longer relevant"

2. **Content quality (plan phase):**
   - Add note to Step 7 that it is best-effort within time budget
   - Add `orderBy: "CREATED_AT"` with ascending direction to Step 2 query
   - Add error handling pattern to RESEARCH and CLOSE action sections
   - Fix description to remove user-facing phrasing for `user-invocable: false` skill

3. **Eval scenarios (plan phase):**
   - Create `plugin/ralph-hero/skills/ralph-triage/eval-scenarios.md` with Scenarios A, B, C defined above

4. **Fragment extraction (defer to #576):**
   - Branch verification step, link formatting, team reporting step are candidates

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/ralph-triage/SKILL.md` - Description fix, RALPH_TRIAGE_ACTION documentation, action error handling, Step 2 ordering clarification, Step 7 time budget note
- `plugin/ralph-hero/agents/triage-agent.md` - Add missing tools to match skill's allowed-tools functional requirements
- `plugin/ralph-hero/hooks/scripts/triage-postcondition.sh` - Add RE-ESTIMATE to accepted action list
- `plugin/ralph-hero/skills/ralph-triage/eval-scenarios.md` - Create with 3 eval scenarios (new file)

### Will Read (Dependencies)
- `plugin/ralph-hero/agents/research-agent.md` - Pattern reference for agent tool list completeness
- `plugin/ralph-hero/skills/ralph-split/SKILL.md` - Comparison for SPLIT-related tool requirements
- `plugin/ralph-hero/hooks/scripts/triage-state-gate.sh` - Valid output states reference
- `plugin/ralph-hero/hooks/scripts/set-skill-env.sh` - Hook wiring pattern
- `plugin/ralph-hero/hooks/scripts/hook-utils.sh` - block/allow pattern reference
