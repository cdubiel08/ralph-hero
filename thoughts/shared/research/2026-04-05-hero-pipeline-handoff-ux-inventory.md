---
date: 2026-04-05
last_updated: 2026-04-05
last_updated_note: "Incorporated user feedback on all six findings — corrected allowed-tools semantics, deepened mode-specific analysis for every handoff"
github_issue: 745
github_url: https://github.com/cdubiel08/ralph-hero/issues/745
topic: "Hero pipeline handoff points and closing UX inventory"
tags: [hero, pipeline, handoffs, ux, ask-user-question, skills, agents]
status: complete
type: research
---

# Research: Hero Pipeline Handoff Points and Closing UX Inventory

## Prior Work

- builds_on:: [[2026-03-24-GH-0674-agent-per-phase-architecture]]

## Research Question

Inventory every handoff point between the ralph primitives in the ralph-hero:hero chain and examine the closing interactive user experience of each skill. Determine if room for improvement exists — especially around AskUserQuestion usage, option phrasing, and flow continuity between pipeline phases.

## Summary

The hero pipeline chains 8 skill primitives: **split → research → plan → review → impl → pr → finish (val + merge + CI)**. Each skill has both an **autonomous** variant (dispatched by hero via `Skill()`) and an **interactive** variant (invoked directly by users). The closing UX must behave differently depending on **who invoked the skill**:

| Invocation context | User present? | Closing UX should... |
|--------------------|:---:|---|
| User invokes interactive skill directly (`/plan`, `/research`, `/impl`) | Yes | Use AskUserQuestion pickers, offer next steps |
| Hero orchestrator dispatches autonomous skill (`Skill("ralph-plan", ...)`) | No | Return clean status + artifact paths, no prompts |
| Autonomous loop invokes skill (future: ralph-loop) | No | Return clean status, use "STOP: [reason]" for human-needed situations |

This document inventories every handoff and analyzes the closing experience through all three lenses.

## Correction: `allowed-tools` Semantics

`allowed-tools` in skill frontmatter is a **whitelist to skip permission prompts**, not a hard block on tool access. A tool not listed can still be used but will trigger a permission prompt to the user. This means:

- AskUserQuestion will still *work* in skills that don't list it — but the user gets an extra confirmation dialog, which is friction
- For interactive skills that should use AskUserQuestion, it should be in `allowed-tools` for a smooth experience
- For autonomous skills, it doesn't matter (no user to prompt)

The same applies to agent `tools:` frontmatter — it's a hard allowlist in agent context, not just a skip-prompt list. So agents without AskUserQuestion in `tools:` genuinely cannot use it.

## AskUserQuestion Availability Matrix

### Skills (`allowed-tools:` — skip-prompt whitelist)

| Skill | In allowed-tools | Should be? | Notes |
|-------|:---:|:---:|-------|
| hero | Yes | Yes | Orchestrator needs it for human gate |
| plan (interactive) | **No** | **Yes** | Closing UX uses numbered lists instead of picker |
| research (interactive) | **No** | **Yes** | Should offer structured choices at closing |
| impl (interactive) | **No** | **Yes** | Should offer structured next-step choices |
| iterate | **No** | Maybe | Simpler flow, may not need structured picker |
| ralph-plan (autonomous) | **No** | No | No user present |
| ralph-research (autonomous) | **No** | No | No user present |
| ralph-impl (autonomous) | **No** | No | No user present |
| ralph-review | **No** | **Yes** | INTERACTIVE mode prose calls AskUserQuestion — needs it for skip-prompt |
| ralph-split | **No** | No | Autonomous only |
| ralph-triage | **No** | No | Autonomous only |
| ralph-pr | **No** | No | Autonomous only |
| ralph-merge | Yes | Yes | Code review gate uses it correctly |
| ralph-val | **No** | No | Autonomous only, read-only |
| finish | Yes | Yes | Delegates to ralph-merge which needs it |

### Agents (`tools:` — hard allowlist)

| Agent | Has AskUserQuestion | Should have? | Notes |
|-------|:---:|:---:|-------|
| finish-agent | **Yes** | Yes | Only agent with it — correct |
| merge-agent | **No** | **Yes** | Skill prose uses it for code review gate; fails as agent |
| review-agent | **No** | Conditional | Only needed if INTERACTIVE mode is passed through to agent |
| All others | **No** | No | Autonomous agents, no user present |

## Detailed Handoff Inventory

Each handoff is analyzed across three invocation modes:
- **:hero** — hero orchestrator dispatching via `Skill()`
- **Interactive** — user invoking the interactive variant directly
- **Autonomous standalone** — skill invoked programmatically with no user

---

### 1. Entry → Split (if M/L/XL)

**Trigger**: `get_issue(includePipeline=true)` returns `phase: SPLIT`

**:hero dispatch**: `Skill("ralph-hero:ralph-split", args="NNN")`

**Split closing UX** (ralph-split SKILL.md Step 11):
```
Split complete for #NNN: [Original Title]
...
Next: Run /ralph-research or /ralph-plan on sub-issues as appropriate.
```

**Handoff**: Hero re-detects pipeline position after split, rebuilds task list.

| Mode | Current behavior | Desired behavior |
|------|-----------------|------------------|
| :hero | "Next: Run /ralph-research..." printed | Clean status only — hero ignores the suggestion and re-detects. Remove "Next:" line. |
| Interactive | N/A (split is not user-invocable) | N/A |
| Autonomous | Same as hero | Clean status only |

---

### 2. Entry → Research (parallel)

**Trigger**: Issues in "Research Needed"

**:hero dispatch**: `Skill("ralph-hero:ralph-research", args="NNN")` — one per issue, parallel

**Research closing UX** (ralph-research SKILL.md Step 10):
```
Research complete for #NNN: [Title]
Findings: thoughts/shared/research/[filename].md
Status: Ready for Plan
[If all done]: Group ready for planning. Run /ralph-plan.
```

| Mode | Current behavior | Desired behavior |
|------|-----------------|------------------|
| :hero | "Run /ralph-plan" suggestion printed | Clean status + artifact path only. Hero resolves next task via TaskList dependency chain. |
| Interactive (research skill) | Writes doc, then suggests `/ralph-hero:form` | Should ask user for feedback on findings BEFORE writing the doc, or write then ask "Does this look right?" and update. See [Research Skill UX Issue](#research-skill-meta-ux-issue). |
| Autonomous | "Run /ralph-plan" printed | Clean status only |

---

### 3. Research → Plan

**Trigger**: All research tasks complete, plan task unblocks

**:hero dispatch**: `Skill("ralph-hero:ralph-plan", args="NNN --research-doc ...")`

**Autonomous plan closing UX** (ralph-plan SKILL.md Step 10):
```
Plan complete for [N] issue(s):
Plan: thoughts/shared/plans/[filename].md
Phases: 1. #XX [Title] (XS), 2. #YY [Title] (S), ...
All issues: Plan in Review
Ready for human review.
```

| Mode | Current behavior | Desired behavior |
|------|-----------------|------------------|
| :hero | "Ready for human review" — clean | Clean. Hero reads plan task result and unblocks review/gate. Good as-is. |
| Autonomous | Same | Clean status + artifact path only |

**Interactive plan closing UX** (plan SKILL.md Step 6) — **deep analysis**:

The interactive plan skill's Step 6 has TWO decision points presented as numbered lists:

**Decision 1 — GitHub linking:**
```
Would you like to link this plan to a GitHub issue?
1. Link to existing issue (provide issue number like #123)
2. Create new issue from this plan
3. Skip GitHub integration
```

**Decision 2 — State advancement (after linking):**
```
Would you like to advance #NNN?
1. Move to "Plan in Review" (for later autonomous review via /ralph-review)
2. Move to "In Progress" (you've reviewed the plan interactively — ready for implementation)
3. Skip state transition
```

**Mode-specific analysis:**

| Condition | Current behavior | Desired behavior |
|-----------|-----------------|------------------|
| User ran `/plan` interactively, default mode | Two numbered-list prompts | Use AskUserQuestion picker. Rephrase options (see below). |
| User ran `/plan` interactively with `RALPH_REVIEW_MODE=auto` | Same two prompts | After linking, should NOT prompt for advancement — automatically move to "Plan in Review" so ralph-review picks it up. Say "Plan linked and moved to Plan in Review. Ralph will review it automatically." and offer: "Would you like Ralph to review now, or leave it for the next session?" |
| ralph-plan invoked by hero | N/A (hero uses ralph-plan, not plan) | N/A — there is no user |
| ralph-plan invoked autonomously | Prints "Ready for human review" | Clean status only — correct |

**Proposed AskUserQuestion for interactive plan closing:**

Decision 2 options should be rephrased to be user-facing, not system-internal:

| Current option | Problem | Proposed option |
|---------------|---------|-----------------|
| `1. Move to "Plan in Review" (for later autonomous review via /ralph-review)` | System jargon — user doesn't know what "Plan in Review" means or what ralph-review is | `{"label": "Queue for review", "description": "Ralph will review this plan in a later session before implementation begins"}` |
| `2. Move to "In Progress" (you've reviewed the plan interactively — ready for implementation)` | Reasonable but could be tighter | `{"label": "Start implementation", "description": "You've reviewed the plan — move straight to implementation with /impl"}` |
| `3. Skip state transition` | Vague, sounds indifferent | `{"label": "Leave as-is", "description": "Keep the plan in draft — decide later what to do with it"}` |

And when `RALPH_REVIEW_MODE=auto`, replace the whole Decision 2 with:

```
{"label": "Review now", "description": "Run Ralph's automated plan review immediately"}
{"label": "Queue for review", "description": "Ralph will pick this up for review in the next session"}
```

---

### 4. Plan → Review (conditional)

**Trigger**: Plan task complete in hero pipeline.

Three paths based on `RALPH_REVIEW_MODE`:

#### 4a. `RALPH_REVIEW_MODE=auto` — Autonomous review

**:hero dispatch**: `Skill("ralph-hero:ralph-review", args="NNN --plan-doc ...")`

**Review closing UX — APPROVED** (ralph-review SKILL.md Step 7):
```
Review complete for GH-NNN: [Title]
Mode: AUTO, Result: APPROVED
Status: In Progress
Ready for implementation. Run /ralph-impl NNN
```

**Review closing UX — NEEDS_ITERATION**:
```
Review complete for GH-NNN: [Title]
Mode: AUTO, Result: NEEDS ITERATION
Issues: [list]
Status: Ready for Plan
Run /ralph-plan NNN to address critique and update plan.
```

| Mode | Current behavior | Desired behavior |
|------|-----------------|------------------|
| :hero | "Run /ralph-impl" or "Run /ralph-plan" suggestions | Clean verdict + artifact path only. Hero resolves routing. |
| Autonomous | Same | Clean verdict only |

#### 4b. `RALPH_REVIEW_MODE=interactive` — Human reviews inline

**ralph-review INTERACTIVE mode** (Step 4A) uses `AskUserQuestion()` with a well-structured picker:

```
AskUserQuestion(questions=[{
  "question": "How does the implementation plan for #NNN look?",
  "options": [
    {"label": "Approve", "description": "Plan is complete and ready for implementation"},
    {"label": "Minor Changes", ...},
    {"label": "Major Changes", ...},
    {"label": "Reject", ...},
    {"label": "Open in editor", ...}
  ]
}])
```

| Issue | Detail |
|-------|--------|
| Prose trigger strength | The skill prose includes the full AskUserQuestion call with proper structure. The trigger is clear. |
| allowed-tools gap | AskUserQuestion is NOT in ralph-review's `allowed-tools` — will trigger a permission prompt, adding friction. Should be added. |
| review-agent tools gap | review-agent does NOT have AskUserQuestion in `tools:` — if spawned as an agent (team mode), the tool call will be denied entirely. Should be added if INTERACTIVE mode is expected to work through agents. |
| Quality of options | Good — "Approve", "Minor Changes", "Major Changes", "Reject", "Open in editor" are clear verb+target labels following the AskUserQuestion convention. |

#### 4c. `RALPH_REVIEW_MODE=skip` (default) — Human gate

**Hero's HUMAN GATE closing UX** (hero SKILL.md "HUMAN GATE tasks"):
```
Report planned groups with plan URLs. All issues are in "Plan in Review".
Instruct user to: (1) Review plans in GitHub, (2) Move to "In Progress", (3) Re-run /ralph-hero [ROOT-NUMBER].
Then STOP.
```

| Mode | Current behavior | Desired behavior |
|------|-----------------|------------------|
| :hero (interactive session) | Procedural instructions to go to GitHub + re-invoke | **Use AskUserQuestion** — hero HAS it in allowed-tools. Offer: `{"label": "Approve plan", "description": "Move to In Progress and begin implementation"}`, `{"label": "Open plan in editor", ...}`, `{"label": "Stop here", "description": "Review the plan in GitHub and re-run /hero later"}` |
| :hero (autonomous/loop context) | Same procedural instructions | Print a clear **STOP message** explaining WHY: `HUMAN GATE: Plan requires human approval before implementation. Plan URL: [url]. Issue: #NNN. Re-run /ralph-hero NNN after approving.` This gives the calling client a structured stop reason. |

---

### 5. Review → Implement (sequential)

**Trigger**: Review approved (or human gate cleared). Impl tasks unblock per dependency chain.

**:hero dispatch**: `Skill("ralph-hero:ralph-impl", args="NNN --plan-doc ...")`

**Impl closing UX — mid-phase** (ralph-impl SKILL.md Step 9):
```
Phase [N]/[M] complete. Next: Phase [N+1]. Run /ralph-impl NNN to continue.
```

**Impl closing UX — final phase** (ralph-impl SKILL.md Step 14):
```
Implementation complete.
PR: [GitHub PR URL]
[List all issues with titles and "In Review" status]
Worktree preserved at: $GIT_ROOT/worktrees/[WORKTREE_ID]
```

| Mode | Current behavior | Desired behavior |
|------|-----------------|------------------|
| :hero | Mid-phase: "Run /ralph-impl" suggestion. Final: PR URL + worktree path. | Mid-phase: clean phase status only. Final: clean status + worktree path. **Remove PR creation from ralph-impl** — see below. |
| Interactive (/impl) | Mid-phase: pause for manual verification (correct). Final: PR created + "iterate with /ralph-hero:iterate" suggestion. | Mid-phase: correct. Final: should use AskUserQuestion: `{"label": "Run finish", "description": "Validate, merge, and watch CI"}`, `{"label": "Create PR only", ...}`, `{"label": "Done for now", ...}` |
| Autonomous | Same as hero | Clean status only |

**Critical: Remove PR creation from ralph-impl.** ralph-impl's Step 10 creates a PR when all phases complete. This is problematic because:
- ralph-impl may be invoked in parallel (multiple issues in a group each executing their phases)
- Creating multiple PRs from parallel impl invocations is undesirable
- The orchestrator (hero) has better sightlines on when the full group is ready for a single PR
- Hero already has a dedicated ralph-pr stage for this purpose

**Resolution**: Remove Steps 10-12 (PR creation, PR gate, GitHub issue update) from ralph-impl. ralph-impl should STOP after committing the final phase and reporting status. PR creation is the caller's responsibility — hero dispatches ralph-pr, interactive /impl can offer it via AskUserQuestion.

---

### 6. Implement → PR

**Trigger**: Last impl task complete, PR task unblocks in hero pipeline.

**:hero dispatch**: `Skill("ralph-hero:ralph-pr", args="NNN")`

**PR closing UX** (ralph-pr SKILL.md Step 8):
```
PR CREATED
Issue: #NNN
PR: https://github.com/owner/repo/pull/NNN
State: In Review
```

| Mode | Current behavior | Desired behavior |
|------|-----------------|------------------|
| :hero | Clean terse output with PR URL | Good as-is — hero consumes the PR URL and passes it to finish. |
| Interactive | N/A (ralph-pr is not user-invocable) | N/A |
| Autonomous | Same | Good as-is |

With ralph-impl's PR creation removed, there is no longer an overlap. ralph-pr is the sole PR creator. Clean separation.

---

### 7. PR → Finish (validate → merge → CI watch)

**Trigger**: PR task complete, finish task unblocks.

**:hero dispatch**: `Skill("ralph-hero:finish", args="NNN")`

Finish chains internally: `ralph-val → ralph-merge → CI watch`

**Finish closing UX** (finish SKILL.md Step 6):
```
FINISHED
Issue: #NNN
PR: https://github.com/OWNER/REPO/pull/PR_NUMBER
Validation: PASS
Merge: Done
CI: [PASS / FAIL / PENDING (timeout) / SKIPPED (no runs)]
```

**ralph-merge code review gate** (ralph-merge SKILL.md Step 4):
Uses AskUserQuestion correctly to ask about code review before merge. Options:
- "Run code review" — invokes `/code-review:code-review`
- "Merge without review" — proceeds to merge

| Mode | Current behavior | Desired behavior |
|------|-----------------|------------------|
| :hero (interactive) | AskUserQuestion picker for code review gate — works correctly | Good as-is. Best interactive UX in the pipeline. |
| :hero (autonomous/loop) | Same AskUserQuestion | Should detect autonomous context and either auto-select based on env var (e.g., `RALPH_AUTO_MERGE=true`) or emit a STOP message: `HUMAN GATE: PR ready for merge but requires human decision on code review.` |
| Interactive (/finish) | Same | Good as-is |

**merge-agent gap**: merge-agent lacks AskUserQuestion in `tools:` — when ralph-merge is dispatched via agent (team mode), the code review gate prompt fails silently. Should be added.

---

## Research Skill Meta-UX Issue {#research-skill-meta-ux-issue}

The interactive `research` skill (SKILL.md) writes the research document first, then presents findings and asks if the user has follow-up questions. This ordering means the user's first feedback gets appended as "Follow-up Research" rather than incorporated into the primary document.

**Current flow**: Research → Write doc → Present findings → Ask for follow-ups → Append to doc

**Proposed flow (interactive only)**:
1. Research → Present findings summary
2. Ask: "Does this capture your question accurately? Any corrections or areas to go deeper?"
3. If user provides feedback: incorporate before writing, or update the written doc
4. Write/update the doc with corrections incorporated
5. Offer next steps (link to issue, create issue via `/form`)

The autonomous `ralph-research` correctly skips user feedback (no user present). This change only applies to the interactive `research` skill.

This is itself a handoff UX issue: the document is the artifact, and the user should have a chance to shape it before it's finalized.

---

## Cross-Cutting Themes

### 1. Mode-aware closing UX

Every skill that can be invoked in multiple contexts (hero, interactive, autonomous) needs mode-aware closing behavior. Currently, all skills have a single closing template that tries to serve all three contexts and serves none perfectly.

**Pattern to adopt**: Check whether a user is present (AskUserQuestion availability or an env var like `RALPH_INTERACTIVE=true`) and branch:
- User present → AskUserQuestion picker with clear next-step options
- No user, hero context → clean status + artifact path for hero to consume
- No user, autonomous stop → structured STOP message with reason

### 2. AskUserQuestion should be in all interactive skill `allowed-tools`

Interactive skills (plan, research, impl, iterate, ralph-review) should include AskUserQuestion in `allowed-tools` to skip the permission prompt. This is the minimum change to enable structured pickers everywhere.

### 3. "Next:" suggestions should be context-dependent

When hero invokes an autonomous skill, "Next: Run /ralph-foo" is noise — hero determines routing via its task dependency graph. These suggestions should only appear when a user invoked the skill directly and needs guidance on what to do next.

### 4. PR creation belongs to the caller, not ralph-impl

ralph-impl should be pure implementation: execute phases, commit, push. PR creation should be removed from ralph-impl because:
- impl may run in parallel across a group
- The orchestrator has better sightlines on when all impl work is done
- Hero already has a dedicated ralph-pr stage
- Interactive /impl can offer PR creation via AskUserQuestion at closing

### 5. Human gates should be structured, not procedural

When a pipeline hits a human-needed point:
- Interactive sessions: use AskUserQuestion inline
- Autonomous sessions: emit a machine-parseable STOP with reason and required action, not prose instructions

### 6. Research skill should gather feedback before finalizing

The interactive research skill should present findings and invite corrections before writing the final document. The autonomous ralph-research correctly skips this. This applies to the research skill's closing UX and also serves as a general pattern: interactive skills should checkpoint with the user before producing artifacts.

## Code References

All paths relative to `plugin/ralph-hero/` in the marketplace install at `~/.claude/plugins/marketplaces/ralph-hero/plugin/ralph-hero/`.

| Component | Path | Relevant section |
|-----------|------|-----------------|
| Hero orchestrator | `skills/hero/SKILL.md` | Full pipeline, HUMAN GATE at line ~355 |
| Plan (interactive) | `skills/plan/SKILL.md` | Step 6 closing UX at lines 394-453 |
| Plan (autonomous) | `skills/ralph-plan/SKILL.md` | Steps 7-10 closing at lines 490-567 |
| Research (interactive) | `skills/research/SKILL.md` | Steps 8-9 closing at lines 248-297 |
| Research (autonomous) | `skills/ralph-research/SKILL.md` | Steps 8-10 closing at lines 338-369 |
| Impl (interactive) | `skills/impl/SKILL.md` | Step 5 closing at lines 171-244 |
| Impl (autonomous) | `skills/ralph-impl/SKILL.md` | Steps 9-14 closing at lines 383-477 |
| Review | `skills/ralph-review/SKILL.md` | Step 4A INTERACTIVE at lines 130-203 |
| Merge | `skills/ralph-merge/SKILL.md` | Step 4 code review gate at lines 88-153 |
| Finish | `skills/finish/SKILL.md` | Steps 3-6 chain at lines 97-176 |
| Iterate | `skills/iterate/SKILL.md` | Step 6 closing at lines 229-257 |
| AskUserQuestion convention | `skills/shared/fragments/ask-user-question.md` | Label/description rules |
| finish-agent (has AskUserQuestion) | `agents/finish-agent.md` | tools line |
| merge-agent (missing AskUserQuestion) | `agents/merge-agent.md` | tools line |
| review-agent (missing AskUserQuestion) | `agents/review-agent.md` | tools line |

## Open Questions

1. Should `RALPH_INTERACTIVE` env var be formalized as the mode detection mechanism, or should skills detect mode by checking if AskUserQuestion is available?
2. For the HUMAN GATE in autonomous mode, should the STOP message follow a structured format (JSON, YAML) for machine parsing by future orchestrators like ralph-loop?
3. Should iterate also get mode-aware closing UX, or is it simple enough to keep as free-text?
