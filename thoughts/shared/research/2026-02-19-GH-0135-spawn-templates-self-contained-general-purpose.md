---
date: 2026-02-19
github_issue: 135
github_url: https://github.com/cdubiel08/ralph-hero/issues/135
status: complete
type: research
---

# GH-135: Update Spawn Templates to Be Self-Contained for General-Purpose Agents

## Problem Statement

All 7 spawn templates in `plugin/ralph-hero/templates/spawn/` reference "your agent definition" for result reporting and procedure instructions. When the ralph-team orchestrator switches from custom agent types (`ralph-analyst`, `ralph-builder`, `ralph-validator`, `ralph-integrator`) to `general-purpose` subagents (GH-134), these references will break because `general-purpose` agents have no custom agent definition file.

Six templates say "Report results per your agent definition" and one (integrator) says "Follow the corresponding procedure in your agent definition." These phrases become meaningless for a `general-purpose` agent.

## Current State Analysis

### Current Templates (7 files)

All templates live at [`plugin/ralph-hero/templates/spawn/`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/):

| Template | Lines | "Agent definition" reference | Post-completion instruction |
|----------|-------|-------|------|
| `triager.md` | 7 | "Report results per your agent definition." | "Then check TaskList for more triage tasks." |
| `splitter.md` | 7 | "Report results per your agent definition." | "Then check TaskList for more split tasks." |
| `researcher.md` | 6 | "Report results per your agent definition." | "Then check TaskList for more research tasks. If none, hand off per shared/conventions.md." |
| `planner.md` | 7 | "Report results per your agent definition." | "Then check TaskList for more plan tasks. If none, hand off per shared/conventions.md." |
| `reviewer.md` | 7 | "Report results per your agent definition." | "Then check TaskList for more review tasks. If none, hand off per shared/conventions.md." |
| `implementer.md` | 8 | "Report results per your agent definition." | "DO NOT push to remote." + "Then check TaskList for more implementation tasks. If none, notify team-lead." |
| `integrator.md` | 5 | "Follow the corresponding procedure in your agent definition." | "Then check TaskList for more integration tasks." |

### What "Agent Definition" Currently Provides

The custom agent definitions (`ralph-analyst.md`, `ralph-builder.md`, `ralph-validator.md`, `ralph-integrator.md`) contain two things the templates delegate to:

1. **Result format contracts** -- Structured `TaskUpdate(description=...)` formats (e.g., `"RESEARCH COMPLETE: #NNN - [Title]\nDocument: [path]\n..."`)
2. **Task loop behavior** -- How to claim tasks, dispatch by subject keyword, and handle idle/shutdown

When templates say "Report results per your agent definition," they mean: use the result format contract from the agent `.md` file for the `TaskUpdate` call.

### What Changes with General-Purpose Agents

With `general-purpose` subagents (GH-134), there is no agent definition file loaded into the agent's context. The agent receives ONLY:
- The spawn prompt (resolved template)
- The skill it invokes (which has its own complete workflow)

This means:
1. "Report results per your agent definition" has no referent -- the agent cannot look up a result format
2. "Follow the corresponding procedure in your agent definition" has no referent -- the integrator has no procedure to follow
3. The task loop (check TaskList, self-claim, dispatch) must either be inline or delegated to the skill

### The 15-Line Constraint

Templates MUST stay under 15 lines per the Template Authoring Rules in [`shared/conventions.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md) (line 231). The resolved prompt should be 5-8 lines, with 10 lines as the guardrail. Full result format contracts (4-7 lines each) would push templates over this limit if embedded verbatim.

### How ralph-hero Already Handles This

The `ralph-hero` orchestrator (SKILL.md) already uses `general-purpose` subagents and does NOT reference agent definitions. Its spawn prompts are self-contained:

```
Task(subagent_type="general-purpose", run_in_background=true,
     prompt="Use Skill(skill='ralph-hero:ralph-research', args='NNN') to research issue GH-NNN: [title].",
     description="Research GH-NNN")
```

Key pattern: the skill invocation IS the complete instruction. The skill itself handles all workflow logic, result formatting, and state transitions. The spawn prompt does not need result format contracts because the skill produces all outputs.

## Key Discoveries

### 1. Skills Already Produce Complete Results

Each skill (ralph-research, ralph-plan, ralph-review, ralph-impl, etc.) already handles:
- Workflow state transitions (lock, complete, escalate)
- Artifact creation (research docs, plan docs, critique docs)
- GitHub comments (artifact links)
- Git operations (commit, push)

The "Report results per your agent definition" instruction is vestigial -- it comes from the era when agents ran task loops with multiple claims. In the new model, each spawned subagent runs ONE skill invocation and the skill handles everything.

### 2. The Task Loop Is the Key Remaining Gap

Currently, agent definitions provide the task loop: check TaskList, self-claim, dispatch. When templates say "Then check TaskList for more [role] tasks," they assume the agent knows how to claim and dispatch. With `general-purpose` agents, this behavior needs to be specified inline.

However, the task loop behavior is simple enough to express in 1-2 lines:
- "Check TaskList for pending [role] tasks. If found, claim and invoke the same skill. If none, hand off per shared/conventions.md."

### 3. Result Format Contracts Already Live in Agent Definitions AND conventions.md

The GH-132 plan (Phase 2) adds formal "Result Format Contracts" to `shared/conventions.md`. Once that exists, templates could reference conventions.md instead of agent definitions. However, this creates a cross-file dependency that may or may not exist at implementation time.

More importantly, for the `general-purpose` model, the skill itself should handle result reporting. The skill runs via `Skill()` which returns its output to the caller. The caller (the spawned subagent) then reports via `TaskUpdate`. The subagent needs to know the format.

### 4. The Integrator Template Is Structurally Different

The integrator template is unique -- it does NOT invoke a skill via `Skill()`. Instead, it says:
```
Check your task subject to determine the operation (Create PR or Merge PR).
Follow the corresponding procedure in your agent definition.
```

The integrator has NO corresponding skill. It follows procedures defined in the `ralph-integrator.md` agent definition (PR Creation Procedure and Merge Procedure). This is the hardest template to make self-contained because the procedure is 15+ lines in the agent definition.

**Options for integrator**:
- **Option A**: Create a `ralph-integrate` skill that the integrator template can invoke via `Skill()`. This would be consistent with all other templates but requires new skill creation (out of scope for this issue).
- **Option B**: Keep the integrator as a custom agent type exception. The template stays as-is since `ralph-integrator` agents still have their agent definition.
- **Option C**: Inline minimal PR creation/merge instructions in the template. Risky given the 15-line constraint.

**Recommendation**: Option B for now. The integrator is already the only template that doesn't invoke `Skill()`. Making it self-contained requires either a new skill or inlining substantial procedure. Both exceed the scope of this issue. The integrator can remain a `ralph-integrator` custom agent type until a `ralph-integrate` skill is created.

### 5. Inline Result Formats Must Be Compact

For the 6 non-integrator templates, the result format needs to be inline but compact. The GH-132 plan's Result Format Contracts show 4-7 lines per role. Embedding these verbatim would push templates from 6-8 lines to 10-15 lines, right at the constraint boundary.

A compact approach: one-line result format specification.

Example for researcher:
```
Report via TaskUpdate: "RESEARCH COMPLETE: #NNN - [Title]\nDocument: [path]\nKey findings: [summary]\nTicket moved to: Ready for Plan"
```

This is one line of template content that replaces "Report results per your agent definition."

## Potential Approaches

### Approach A: Inline Compact Result Formats (Recommended)

Replace "Report results per your agent definition" with a one-line result format specification per template. Replace "Then check TaskList..." with a standardized self-claim instruction.

**Example -- researcher.md (before)**:
```
Research GH-{ISSUE_NUMBER}: {TITLE}.

Invoke: Skill(skill="ralph-hero:ralph-research", args="{ISSUE_NUMBER}")

Report results per your agent definition.
Then check TaskList for more research tasks. If none, hand off per shared/conventions.md.
```

**Example -- researcher.md (after)**:
```
Research GH-{ISSUE_NUMBER}: {TITLE}.

Invoke: Skill(skill="ralph-hero:ralph-research", args="{ISSUE_NUMBER}")

Report via TaskUpdate: "RESEARCH COMPLETE: #{ISSUE_NUMBER} - {TITLE}\nDocument: [path]\nKey findings: [summary]\nTicket moved to: Ready for Plan"
Then check TaskList for pending Research tasks. If found, claim and repeat. If none, hand off per shared/conventions.md.
```

**Pros**: Self-contained, no external references, stays within 15-line limit (7 lines)
**Cons**: Result format is duplicated across template and conventions.md; changes require updating both

### Approach B: Reference conventions.md Instead of Agent Definition

Replace "per your agent definition" with "per shared/conventions.md Result Format Contracts."

**Pros**: Single source of truth, no duplication
**Cons**: Depends on GH-132 Phase 2 being implemented first (the section doesn't exist yet). Creates a cross-file dependency. The agent still needs to look up the format at runtime.

### Approach C: Let Skills Handle Result Reporting

Remove result reporting instructions entirely from templates. The skill's output becomes the result. The subagent simply passes the skill output through to `TaskUpdate`.

**Example -- researcher.md (after)**:
```
Research GH-{ISSUE_NUMBER}: {TITLE}.

Invoke: Skill(skill="ralph-hero:ralph-research", args="{ISSUE_NUMBER}")

After skill completes, report its output via TaskUpdate(status="completed").
Then check TaskList for pending Research tasks. If found, claim and repeat. If none, hand off per shared/conventions.md.
```

**Pros**: Simplest template, no format duplication, skill owns all workflow details
**Cons**: Skill output may be verbose/unstructured. The lead relies on specific format strings (e.g., "RESEARCH COMPLETE") to parse results. Skills currently produce final status messages but not in the exact TaskUpdate format.

### Approach D: Hybrid -- Inline Formats for Critical Fields, Skill Handles Rest

For analyst/builder roles where the lead needs to parse specific fields (sub-ticket IDs, verdict), inline the critical format. For other roles, let the skill handle it.

**Pros**: Targeted, minimal template growth
**Cons**: Inconsistent across templates

## Risks and Considerations

1. **15-line constraint is the hard boundary**. Any approach must keep templates under 15 lines after placeholder resolution. Approach A keeps templates at 7-8 lines. Approach B at 6-7 lines. Approach C at 6-7 lines.

2. **Integrator template is the exception**. It cannot be made self-contained without a new skill or procedure inlining. Recommend keeping it as a `ralph-integrator` custom agent type.

3. **GH-132 Phase 2 dependency**. If Approach B is chosen, the "Result Format Contracts" section must exist in conventions.md first. GH-132 is currently in "Plan in Review" state.

4. **Task loop simplification**. The current "Then check TaskList for more [role] tasks" instruction already works for `general-purpose` agents -- they have full tool access including `TaskList`, `TaskGet`, `TaskUpdate`. The instruction just needs to be slightly more explicit (include "claim" verb).

5. **Handoff protocol**. The conventions.md Pipeline Handoff Protocol references `agentType` for peer discovery (e.g., "find the member whose agentType matches..."). GH-136 addresses updating this for `general-purpose` agents. The template's "hand off per shared/conventions.md" reference will work once GH-136 is complete.

6. **Template authoring rules in conventions.md** (lines 229-234) say templates must not include "assignment instructions." The self-claim instruction ("check TaskList, claim and repeat") is task loop behavior, not assignment. This is consistent with the existing "Then check TaskList..." lines.

## Recommended Approach

**Approach A (Inline Compact Result Formats)** for the 6 skill-invoking templates, with the integrator template as a deferred exception.

Rationale:
- Self-contained: no external file references that may not exist
- Compact: stays within 15-line limit (7-8 lines per template)
- Consistent: all 6 templates follow the same pattern
- Parseable: the lead can still match on "RESEARCH COMPLETE", "PLAN COMPLETE", etc.
- Independent of GH-132 Phase 2 timeline

The integrator template should remain targeting `ralph-integrator` custom agent type until a `ralph-integrate` skill is created (separate issue).

## Files Affected

| File | Change |
|------|--------|
| `plugin/ralph-hero/templates/spawn/triager.md` | Replace "Report results per your agent definition" with inline result format |
| `plugin/ralph-hero/templates/spawn/splitter.md` | Replace "Report results per your agent definition" with inline result format |
| `plugin/ralph-hero/templates/spawn/researcher.md` | Replace "Report results per your agent definition" with inline result format |
| `plugin/ralph-hero/templates/spawn/planner.md` | Replace "Report results per your agent definition" with inline result format |
| `plugin/ralph-hero/templates/spawn/reviewer.md` | Replace "Report results per your agent definition" with inline result format |
| `plugin/ralph-hero/templates/spawn/implementer.md` | Replace "Report results per your agent definition" with inline result format |
| `plugin/ralph-hero/templates/spawn/integrator.md` | **Deferred** -- keep as `ralph-integrator` agent type for now |

## Inline Result Formats (per template)

### triager.md
```
Report via TaskUpdate: "TRIAGE COMPLETE: #{ISSUE_NUMBER}\nAction: [CLOSE/SPLIT/RESEARCH/KEEP]\n[If SPLIT]: Sub-tickets: #AAA, #BBB\nEstimates: #AAA (XS), #BBB (S)"
```

### splitter.md
```
Report via TaskUpdate: "SPLIT COMPLETE: #{ISSUE_NUMBER}\nSub-tickets: #AAA, #BBB, #CCC\nEstimates: #AAA (XS), #BBB (S), #CCC (XS)"
```

### researcher.md
```
Report via TaskUpdate: "RESEARCH COMPLETE: #{ISSUE_NUMBER} - {TITLE}\nDocument: [path]\nKey findings: [summary]\nTicket moved to: Ready for Plan"
```

### planner.md
```
Report via TaskUpdate: "PLAN COMPLETE: [ticket/group]\nPlan: [path]\nPhases: [N]\nFile ownership: [groups]\nReady for review."
```

### reviewer.md
```
Report via TaskUpdate: "VALIDATION VERDICT\nTicket: #{ISSUE_NUMBER}\nPlan: [path]\nVERDICT: [APPROVED/NEEDS_ITERATION]\n[findings]"
```

### implementer.md
```
Report via TaskUpdate: "IMPLEMENTATION COMPLETE\nTicket: #{ISSUE_NUMBER}\nFiles: [list]\nTests: [PASSING/FAILING]\nCommit: [hash]\nWorktree: [path]"
```

## References

- [Parent issue #133](https://github.com/cdubiel08/ralph-hero/issues/133) -- ralph-team should dispatch via general-purpose subagents
- [Sibling #134](https://github.com/cdubiel08/ralph-hero/issues/134) -- Update spawn table to use general-purpose (foundation, blocks this issue)
- [Sibling #136](https://github.com/cdubiel08/ralph-hero/issues/136) -- Update conventions.md handoff protocol
- [Sibling #137](https://github.com/cdubiel08/ralph-hero/issues/137) -- Remove custom agent tool restriction docs
- [GH-132 Research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0132-agent-skill-patterns-bowser-reference.md) -- Bowser reference architecture analysis
- [GH-132 Plan](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-19-GH-0132-agent-skill-invocation-patterns.md) -- allowed_tools + result format contracts plan
- [GH-53 Research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0053-teammate-inline-work-vs-skill-invocation.md) -- Template integrity root cause analysis
- [shared/conventions.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md) -- Spawn Template Protocol and Template Authoring Rules
