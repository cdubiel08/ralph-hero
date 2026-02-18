---
date: 2026-02-17
status: approved-with-warnings
type: critique
plan_document: thoughts/shared/plans/2026-02-17-plan-2-hop-architecture.md
---

# Plan 2 Review: HOP Architecture - Devil's Advocate Critique

## Verdict: APPROVED WITH WARNINGS

The core architecture (externalized spawn templates with placeholder substitution) is sound and addresses real problems (inline bloat, no composability, orchestrator coupling). However, there are 4 blocking-adjacent issues and 5 warnings that must be addressed during implementation. None require plan restructuring -- they're fixable within the existing phase structure.

---

## Blocking Issues

### B1: Result Templates Create Triple Source of Truth

**Severity**: High
**Phases affected**: 1, 5

Phase 1 spawn templates embed result formats inline (e.g., `TaskUpdate(taskId=..., description="RESEARCH COMPLETE: #{ISSUE_NUMBER}...")`). Phase 5 creates result template FILES in `templates/results/`. Agent `.md` files ALSO define their own TaskUpdate formats (e.g., `ralph-researcher.md:40-45`).

This creates THREE places defining the same format:
1. Spawn templates (Phase 1, inline)
2. Result template files (Phase 5)
3. Agent `.md` files (existing, unchanged by this plan)

**Evidence**:
- `plugin/ralph-hero/agents/ralph-researcher.md:40-45` defines researcher TaskUpdate format
- Plan Phase 1 researcher.md template (lines 107-108) defines a different-but-similar format
- Plan Phase 5 `research-complete.md` (lines 458-462) defines yet another format

**Fix**: Either (a) remove result formats from spawn templates and have agents reference `templates/results/*.md` files, or (b) drop Phase 5 entirely and let agent `.md` files remain the single source of truth for result format. Option (b) is simpler and recommended -- the agent `.md` files already do this well, and the spawn templates should just say "Report results per your agent definition."

### B2: Result Template Formats Don't Match Agent Definitions

**Severity**: High
**Phase affected**: 5

Several Phase 5 result templates diverge from the formats agents currently use:

**Planner**: Plan template has `Issues: {ISSUE_LIST}` + `Ticket moved to: Plan in Review`. Actual agent (`ralph-planner.md:39-45`) uses `File ownership groups:` with per-phase key files + `Ready for review.` The file ownership detail is **critical** for the lead to set up implementation tasks.

**Reviewer**: Plan template has 4 flat lines. Actual agent (`ralph-advocate.md:39-48`) uses `PLAN REVIEW VERDICT` header with structured sections: `## Blocking Issues`, `## Warnings`, `## What's Good`. The template would lose structured evidence for rejection reasons.

**Triager**: Plan template has 3 lines (Action + Reason). Actual agent (`ralph-triager.md:44-53`) includes SPLIT-specific details: sub-ticket IDs, dependency chain, estimates. The agent file says "**CRITICAL for SPLIT results**: Include ALL created sub-ticket IDs and their estimates."

**Fix**: If Phase 5 is kept (against B1 recommendation), templates must match existing agent formats exactly. If Phase 5 is dropped per B1, this issue resolves itself.

### B3: Hero Mode Template Incompatibility

**Severity**: Medium-High
**Phase affected**: 4

Phase 4 applies the same spawn templates to ralph-hero (sequential orchestrator). But templates are designed for team mode behavior:
- Templates say `"Then check TaskList for more research tasks. If none, hand off per shared/conventions.md."` -- ralph-hero has no team task list
- Templates say `"Then check TaskList for more implementation tasks. If none, notify team-lead."` -- ralph-hero has no team-lead
- Templates reference pull-based claiming behavior that doesn't exist in hero mode

Ralph-hero spawns agents with `subagent_type="general-purpose"` (not role-specific agents). These general-purpose agents don't have the team context to meaningfully interpret team-mode instructions.

**Evidence**: `ralph-hero/SKILL.md:94` spawns with `subagent_type="general-purpose"` and simple prompts like `"Use Skill(skill='ralph-hero:ralph-split', args='NNN') to split issue #NNN."` The templates add team-specific noise to hero mode.

**Fix**: Either (a) create hero-specific templates (e.g., `templates/spawn/hero/researcher.md`) that strip team instructions, or (b) use a `{MODE_INSTRUCTIONS}` placeholder that resolves to team instructions in team mode and empty in hero mode, or (c) keep hero mode prompts inline (they're already 1-liners) and only apply templates to ralph-team. Option (c) is simplest and preserves hero mode's working simplicity.

### B4: Defensive Guardrails Lost

**Severity**: Medium
**Phase affected**: 3

Current Section 6 "Spawn Prompt Requirements" contains important negative constraints:

> **DO NOT include**: conversation history, document contents, code snippets, assignment instructions, SendMessage reporting instructions.

And:

> **Lead name**: Teammates needing to message lead MUST use `recipient="team-lead"` exactly. Other names are silently dropped.

Phase 3 removes these entirely, saying "now implicit in the templates themselves." But templates only define what IS included -- they don't warn against what SHOULDN'T be added. If someone creates a new template or modifies an existing one, there's no guardrail preventing over-inclusion.

**Fix**: Add a "Template Authoring Rules" subsection to the conventions.md Spawn Template Protocol section. Include the DO NOT rules and the team-lead naming constraint. Something like:

```
### Template Authoring Rules
- Templates MUST be under 15 lines
- DO NOT include: conversation history, document contents, code snippets, assignment instructions
- Teammates message lead using `recipient="team-lead"` exactly
```

---

## Warnings

### W1: `${CLAUDE_PLUGIN_ROOT}` Path Resolution Unverified

The refactored Section 6 (Phase 3, line 328) uses:
```
Read(file_path="${CLAUDE_PLUGIN_ROOT}/templates/spawn/{template}")
```

Claude Code's plugin infrastructure resolves `${CLAUDE_PLUGIN_ROOT}` in `.mcp.json`, hook commands, and skill frontmatter. It has NOT been verified that the `Read` tool's `file_path` parameter expands environment variables the same way. If not, the orchestrator would need to resolve the path via Bash (`echo $CLAUDE_PLUGIN_ROOT`) first.

**Recommendation**: Verify during implementation. If Read doesn't expand env vars, add a path resolution step.

### W2: Missing Idle Worker Nudge Guidance

Current Section 6 "Parallel Workers" says: "Idle workers auto-claim new tasks. Nudge via SendMessage only if idle >2 minutes with unclaimed tasks."

The refactored Section 6 (Phase 3) removes this. The "Per-Role Instance Limits" only covers how many to spawn, not what to do when workers are idle with unclaimed tasks.

**Recommendation**: Add the idle nudge guidance back to the refactored Section 6, either in Per-Role Instance Limits or as a separate "Worker Lifecycle" subsection.

### W3: Placeholder Substitution for Empty Optional Values

The conventions.md protocol (Phase 2, lines 253-254) says:
```
{GROUP_CONTEXT} = ""  (empty string, placeholder line removed)
```

And step 4 of the resolution procedure says: "Remove any lines that are empty after substitution (optional context lines)."

This is a text-based protocol for an LLM orchestrator, not a template engine. The instruction "remove empty lines" is ambiguous -- does it mean lines that are ENTIRELY empty after substitution, or lines that CONTAIN only whitespace? What about a line like `"Group: "` where the placeholder resolved to empty but the prefix remains?

**Recommendation**: Make the protocol more explicit: "If a placeholder resolves to an empty string, remove the ENTIRE LINE containing that placeholder." Add an example showing before/after.

### W4: Template Count Verification Discrepancy

Phase 1 success criteria says "All 6 template files exist in `plugin/ralph-hero/templates/spawn/`" but there are actually 6 templates listed (researcher, planner, reviewer, implementer, triager, splitter). Phase 5 also says "All 6 result templates." Count is correct.

However, the conventions.md template naming convention (Phase 2, lines 278-283) lists only 5 mappings (triager, researcher, planner, advocate->reviewer, implementer). The **splitter** mapping is missing from this table.

**Recommendation**: Add splitter mapping to the naming convention table: `ralph-triager agent (split mode) -> splitter.md template`

### W5: Task Subject Matching Fragility

The refactored Section 6 (Phase 3) maps task subjects to roles:

| Task subject contains | Role | Template |
|---|---|---|
| "Plan" (not "Review") | planner | planner.md |
| "Review" | reviewer | reviewer.md |

This relies on substring matching. What about task subjects like "Create PR for #NNN" (which the current system uses)? Or what about "Review plan for #NNN" which contains BOTH "Plan" and "Review"?

Current system already has this issue (agents match on subjects per their agent `.md` files). The plan doesn't make it worse, but it's worth noting for awareness.

**Recommendation**: No change needed for this plan, but consider explicit task-type metadata in a future iteration.

---

## What's Good

- **Core architecture is sound**: Externalizing spawn prompts to template files cleanly separates orchestrator logic from agent prompt content. This is a proven pattern (Bowser, shell templates) applied well.
- **Minimalism argument is validated**: Skills fetch their own context via `get_issue`. The current 8+ field spawn prompt duplicates what skills already retrieve. Templates correctly reduce to issue number + skill invocation.
- **Placeholder design is clean**: 5 placeholders (`ISSUE_NUMBER`, `TITLE`, `ESTIMATE`, `GROUP_CONTEXT`, `WORKTREE_CONTEXT`) cover all agent needs without over-engineering.
- **Phase ordering is correct**: Templates (Phase 1) before conventions (Phase 2) before orchestrator refactor (Phase 3/4) is the right dependency order.
- **Scope exclusions are well-defined**: "What We're NOT Doing" clearly separates this from Plans 3 and 4.
- **The "zero orchestrator changes for new agent" goal** is achievable with this design.

---

## Summary of Required Actions

| ID | Severity | Fix |
|----|----------|-----|
| B1 | High | Drop Phase 5 result templates; keep agent `.md` files as result format authority; remove inline result formats from spawn templates |
| B2 | High | Resolves automatically if B1 is accepted |
| B3 | Medium-High | Keep hero mode prompts inline (option c); limit template system to ralph-team only |
| B4 | Medium | Add "Template Authoring Rules" to conventions.md protocol section |
| W1 | Low | Verify `${CLAUDE_PLUGIN_ROOT}` expansion in Read tool during implementation |
| W2 | Low | Restore idle-nudge guidance in refactored Section 6 |
| W3 | Low | Clarify empty-line removal semantics with explicit examples |
| W4 | Low | Add splitter mapping to naming convention table |

If B1, B3, and B4 are addressed, the remaining issues are minor and can be fixed during implementation.
