---
date: 2026-03-01
github_issue: 469
github_url: https://github.com/cdubiel08/ralph-hero/issues/469
status: complete
type: research
---

# Research: Ralph Protocol Specs Phase 2 — Lifecycle and Document Specs

## Problem Statement

Phase 2 requires creating two spec files: `specs/issue-lifecycle.md` (full state machine, transition rules, Status sync) and `specs/document-protocols.md` (requirements for research, plan, and review artifacts). Both must be designed from first principles using existing sources as factual ground truth, not migrated from conventions.md.

This research extracts the complete machine-readable state definitions, Status sync mappings, and document structure requirements from hook scripts and the MCP server.

---

## Current State Analysis

### 1. Issue Lifecycle (`specs/issue-lifecycle.md`)

#### Complete State Machine

From `plugin/ralph-hero/hooks/scripts/ralph-state-machine.json`:

**All workflow states** (11 total):

| State | Description | Lock State | Terminal | Requires Human |
|-------|-------------|------------|----------|----------------|
| Backlog | Ticket awaiting triage | — | — | — |
| Research Needed | Needs investigation before planning | — | — | — |
| Research in Progress | Research actively underway | yes | — | — |
| Ready for Plan | Research complete, ready for planning | — | — | — |
| Plan in Progress | Plan actively being created | yes | — | — |
| Plan in Review | Plan awaiting human approval | — | — | yes |
| In Progress | Implementation actively underway | yes (informal) | — | — |
| In Review | PR created, awaiting code review | — | — | yes |
| Human Needed | Escalated, requires human | — | — | yes |
| Done | Ticket completed | — | yes | — |
| Canceled | Ticket canceled/superseded | — | yes | — |

**Valid transitions** (from state machine `allowed_transitions`):

| From | To (allowed) |
|------|-------------|
| Backlog | Research Needed, Ready for Plan, Done, Canceled |
| Research Needed | Research in Progress, Ready for Plan, Human Needed |
| Research in Progress | Ready for Plan, Human Needed |
| Ready for Plan | Plan in Progress, Human Needed |
| Plan in Progress | Plan in Review, Human Needed |
| Plan in Review | In Progress, Ready for Plan, Human Needed |
| In Progress | In Review, Human Needed |
| In Review | Done, In Progress, Human Needed |
| Human Needed | Backlog, Research Needed, Ready for Plan, In Progress |
| Done | (none — terminal) |
| Canceled | (none — terminal) |

**State ordering** (canonical pipeline, from `workflow-states.ts:12-22`):
Backlog → Research Needed → Research in Progress → Ready for Plan → Plan in Progress → Plan in Review → In Progress → In Review → Done

**Parent gate states** (`workflow-states.ts:50-54`): Ready for Plan, In Review, Done — children reaching these states trigger parent advancement check.

#### State Ownership by Skill

Which skills produce which states (from state machine `produces_for_commands`):

| State Produced | Skill(s) Responsible |
|---------------|----------------------|
| Backlog | ralph_triage, ralph_split |
| Research Needed | ralph_triage |
| Research in Progress | ralph_research (lock acquire) |
| Ready for Plan | ralph_research |
| Plan in Progress | ralph_plan (lock acquire) |
| Plan in Review | ralph_plan, ralph_review (after rejection bounce) |
| In Progress | ralph_review (approval), ralph_impl |
| In Review | ralph_impl |
| Human Needed | any skill via __ESCALATE__ |
| Done | ralph_triage, ralph_impl, ralph_merge |
| Canceled | ralph_triage |

**Skill input state requirements** (from `required_by_commands`):
- ralph_research: requires Research Needed
- ralph_split: requires Research Needed or Backlog
- ralph_plan: requires Ready for Plan
- ralph_review: requires Plan in Review
- ralph_impl: requires Plan in Review or In Progress
- ralph_merge: requires In Review

#### Lock States and Acquisition

Lock states prevent concurrent claim by multiple agents. From `lock_transitions` in `ralph-command-contracts.json`:

| Lock State | Acquired From | By Command | Released To (success) | Released To (failure) | Released To (escalation) |
|------------|--------------|-----------|----------------------|----------------------|--------------------------|
| Research in Progress | Research Needed | ralph_research | Ready for Plan | Research Needed | Human Needed |
| Plan in Progress | Ready for Plan | ralph_plan | Plan in Review | Ready for Plan | Human Needed |
| In Progress | Plan in Review | ralph_impl | In Review | (stays In Progress) | Human Needed |

Detection: check if ticket is in a lock state before claiming — skip if locked (`conflict_rules.same_ticket_different_commands`).

#### Semantic Intents

From state machine `semantic_states`:

| Intent | ralph_research | ralph_plan | ralph_impl | ralph_review | ralph_split | ralph_merge | all commands |
|--------|---------------|------------|------------|--------------|-------------|-------------|-------------|
| __LOCK__ | Research in Progress | Plan in Progress | In Progress | — | — | — | — |
| __COMPLETE__ | Ready for Plan | Plan in Review | In Review | In Progress | Backlog | Done | — |
| __ESCALATE__ | — | — | — | — | — | — | Human Needed |
| __CLOSE__ | — | — | — | — | — | — | Done |
| __CANCEL__ | — | — | — | — | — | — | Canceled |

Triage-specific actions: RESEARCH → Research Needed, PLAN → Ready for Plan, CLOSE → Done.

#### Status Sync (Workflow State → GitHub Status Field)

From `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts` (`WORKFLOW_STATE_TO_STATUS`):

| Workflow State | GitHub Status Field |
|---------------|---------------------|
| Backlog | Todo |
| Research Needed | Todo |
| Ready for Plan | Todo |
| Plan in Review | Todo |
| Research in Progress | In Progress |
| Plan in Progress | In Progress |
| In Progress | In Progress |
| In Review | In Progress |
| Done | Done |
| Canceled | Done |
| Human Needed | Done |

Sync is **one-way** and **best-effort**: `save_issue` syncs Status when setting `workflowState`. If the Status field is missing or has custom options, sync silently skips. `batch_update` and `advance_issue` also sync Status.

Enablement: `[x]` implemented in `issue-tools.ts` via `WORKFLOW_STATE_TO_STATUS` mapping applied in `save_issue` mutation.

#### Issue Creation Requirements

From command contracts (`ralph_triage`, `ralph_split`):

Required fields at creation: title. Fields set after creation via project: estimate, priority, workflowState.

**State gate enforcement** (current hooks):
- `research-state-gate.sh`: PostToolUse on `ralph_hero__get_issue`, validates output states for ralph_research
- `plan-state-gate.sh`: PostToolUse on `ralph_hero__save_issue`, validates output states for ralph_plan
- `review-state-gate.sh`: PreToolUse on `ralph_hero__save_issue` in ralph_review
- `triage-state-gate.sh`: PostToolUse on `ralph_hero__save_issue` in ralph_triage
- `impl-state-gate.sh`, `merge-state-gate.sh`, `pr-state-gate.sh`: similar per-command enforcement

Close/reopen semantics: Done and Canceled are terminal — no allowed_transitions. Human Needed can return to Backlog, Research Needed, Ready for Plan, or In Progress.

---

### 2. Document Protocols (`specs/document-protocols.md`)

#### Research Documents

**Required sections** (from research skill SKILL.md and postcondition enforcement):
- Frontmatter block (YAML)
- Problem statement
- Current state analysis
- Key discoveries with file:line references
- Potential approaches (pros/cons)
- Risks
- Recommended next steps
- `## Files Affected` section with `### Will Modify` and `### Will Read (Dependencies)` subsections

**Frontmatter schema** (from `ralph-command-contracts.json` artifact_types.research.validates):

```yaml
date: YYYY-MM-DD           # required
github_issue: NNN          # required (validates: frontmatter.github_issue)
github_url: https://...    # required (full issue URL)
status: complete           # required (validates: frontmatter.status)
type: research             # required
```

**Quality criteria** (from `quality-standards.md`):
1. Depth — problem understood from user perspective, root cause analysis
2. Feasibility — existing codebase patterns identified
3. Risk — edge cases and failure modes identified
4. Actionability — recommendations with file:line references

**Commit/push requirements**: MUST be committed and pushed to main before linking. `research-postcondition.sh` checks file exists (created within last 30 min) and contains `## Files Affected`.

**Artifact comment**: MUST post `## Research Document` header comment with GitHub blob URL.

Enablement:
- `[x]` `## Files Affected` section: `research-postcondition.sh`
- `[x]` Duplicate prevention: `pre-artifact-validator.sh`
- `[ ]` Frontmatter field validation: declared in `artifact_types.research.validates` but no hook enforces schema
- `[ ]` Required sections (problem statement, etc.): no hook validates section structure
- `[ ]` Artifact comment required: `artifact-discovery.sh` warns only, does not block

#### Plan Documents

**Required sections** (from `plan-verify-doc.sh` — ORPHANED but shows intent, and plan SKILL.md template):
- Frontmatter block
- Overview / Phase table
- Current state analysis
- Desired end state with verification criteria
- "What We're NOT Doing" section
- Per-phase sections (`## Phase N: Title`)
- Success criteria per phase (`- [ ] Automated:` / `- [ ] Manual:` format)
- Integration testing section
- References

**Frontmatter schema** — three variants:

Single issue:
```yaml
date: YYYY-MM-DD
status: draft
github_issues: [NNN]       # array even for single issue
github_urls:
  - https://...
primary_issue: NNN
```

Group plan:
```yaml
date: YYYY-MM-DD
status: draft
github_issues: [NNN, MMM]
github_urls:
  - https://...
primary_issue: NNN
```

Stream plan:
```yaml
date: YYYY-MM-DD
status: draft
github_issues: [NNN, MMM]
github_urls:
  - https://...
primary_issue: NNN
stream_id: "stream-NNN-MMM"
stream_issues: [NNN, MMM]
epic_issue: PPP
```

**Phase structure requirements** (from `plan-verify-doc.sh` checks):
- `## Phase N:` header pattern
- Success Criteria section per phase
- Automated + manual success criteria format

**Research prerequisite**: `plan-research-required.sh` blocks Write to plans/ if no research doc exists for the ticket.

**Convergence verification for groups**: `convergence-gate.sh` warns on `Plan in Progress` transition if `RALPH_CONVERGENCE_VERIFIED` not set. Full check via `ralph_hero__check_convergence` MCP tool.

**Artifact comment**: MUST post `## Implementation Plan` header comment.

Enablement:
- `[x]` Research prerequisite: `plan-research-required.sh`
- `[x]` Duplicate prevention: `pre-artifact-validator.sh`
- `[x]` Plan committed: `plan-postcondition.sh` (checks file exists and is committed)
- `[ ]` Phase section structure: `plan-verify-doc.sh` is ORPHANED — not registered in any skill or hooks.json
- `[ ]` Success criteria format: no hook enforces
- `[ ]` Frontmatter field validation: no hook enforces schema
- `[ ]` Artifact comment required: `artifact-discovery.sh` warns only

#### Review/Critique Documents

**Required sections** (from `review-verify-doc.sh` and `review-postcondition.sh`):
- Frontmatter block
- Verdict section (APPROVED or NEEDS_ITERATION)
- Critique/findings

**Frontmatter schema** (from `artifact_types.critique.validates` and `review-verify-doc.sh`):

```yaml
date: YYYY-MM-DD           # required (validates: frontmatter.date)
github_issue: NNN          # required (validates: frontmatter.github_issue)
status: complete           # required (validates: frontmatter.status)
type: critique             # required
```

**Verdict values**: APPROVED (skill transitions to In Progress), NEEDS_ITERATION (skill transitions to Ready for Plan, adds `needs-iteration` label).

**Artifact comment format**: posted by skill after creating critique (pattern from conventions.md reference). Header: `## Plan Critique` per `artifact_types.critique.attachment_title_pattern`.

**AUTO vs INTERACTIVE modes**:
- AUTO: critique document MUST be created and committed (`review-postcondition.sh` blocks if missing)
- INTERACTIVE: no critique document required

Enablement:
- `[x]` Critique created (AUTO mode): `review-postcondition.sh` (blocks on missing)
- `[x]` Duplicate prevention: `review-no-dup.sh`
- `[x]` Frontmatter warnings: `review-verify-doc.sh` (warns on missing status, github_issue, type)
- `[ ]` Required sections (verdict, critique): no hook validates structure

---

## Key Discoveries

### Discovery 1: plan-verify-doc.sh Is Orphaned
`plan-verify-doc.sh` was created to validate plan phase structure and success criteria on Write, but is explicitly marked ORPHANED in its header — never registered in any SKILL.md or hooks.json. This means plan structure requirements are currently enforced only by convention. The spec should mark these requirements as unchecked.

### Discovery 2: plan-no-dup.sh Is Also Orphaned
`plan-no-dup.sh` is marked ORPHANED — superseded by `pre-artifact-validator.sh` which provides the same protection globally via hooks.json. Only `pre-artifact-validator.sh` should be cited as the enforcer.

### Discovery 3: Status Sync Is One-Way and Best-Effort
The WORKFLOW_STATE_TO_STATUS mapping is applied in MCP server mutations (save_issue, batch_update, advance_issue) but silently skips if the Status field is missing or has non-standard options. The spec must document this as best-effort, not guaranteed.

### Discovery 4: Human Needed Is Not Fully Terminal
Unlike Done/Canceled, Human Needed has outbound transitions (to Backlog, Research Needed, Ready for Plan, In Progress). The state machine also shows Human Needed can be produced by ANY command (`produces_for_commands: ["*"]`). The spec must model this as an "escape hatch" state, not a terminal.

### Discovery 5: Plan in Review Requires Human Action Before ralph_impl
`Plan in Review` has `requires_human_action: true` and `ralph_impl` preconditions include `plan_approved: true`. This means the state machine has a human gate between planning and implementation — the spec should make this explicit as a non-automated transition.

### Discovery 6: Convergence Verification Is Warning-Only for Groups
`convergence-gate.sh` warns but does NOT block the `Plan in Progress` lock transition. The requirement for convergence verification (`ralph_hero__check_convergence`) is currently a convention enforced by the skill's own workflow, not by a hard hook gate.

---

## Recommended Next Steps (for Planning)

1. **`specs/issue-lifecycle.md`**: Use `ralph-state-machine.json` as the authoritative source. Document the full transition table, lock acquisition/release, semantic intent mappings, Status sync table, and state ownership by skill. Note Human Needed as non-terminal escape hatch.

2. **`specs/document-protocols.md`**: Three sections (research, plan, review). Most enforcement gaps are in plan documents (orphaned plan-verify-doc.sh). Use enablement checkboxes to make gaps explicit. Critical note: plan-verify-doc.sh MUST NOT be cited as an enforcer — it is orphaned.

3. **Spec dependency**: `specs/issue-lifecycle.md` should cross-reference `specs/skill-io-contracts.md` (Phase 1) for the full precondition/postcondition contracts. Do not duplicate — just reference.

---

## Risks

- **Status sync edge cases**: If a GitHub Projects field is renamed or custom options are used, sync silently fails. Spec should document the best-effort nature clearly.
- **Orphaned scripts**: `plan-verify-doc.sh` and `plan-no-dup.sh` exist on disk but are not enforced. Future contributors may try to register them without understanding the overlap — spec should mention orphaned status.
- **Human gate ambiguity**: `Plan in Review → In Progress` is the only transition where a human must act before the pipeline can proceed. If this gate is not clearly documented, automated agents may incorrectly attempt to self-advance.

---

## Files Affected

### Will Modify
- `specs/issue-lifecycle.md` — new file to create
- `specs/document-protocols.md` — new file to create

### Will Read (Dependencies)
- `plugin/ralph-hero/hooks/scripts/ralph-state-machine.json` — full state machine definition
- `plugin/ralph-hero/hooks/scripts/ralph-command-contracts.json` — command preconditions/postconditions
- `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts` — WORKFLOW_STATE_TO_STATUS mapping, STATE_ORDER, lock/terminal/human states
- `plugin/ralph-hero/hooks/scripts/research-state-gate.sh` — research state enforcement
- `plugin/ralph-hero/hooks/scripts/plan-state-gate.sh` — plan state enforcement
- `plugin/ralph-hero/hooks/scripts/review-state-gate.sh` — review state enforcement
- `plugin/ralph-hero/hooks/scripts/triage-state-gate.sh` — triage state enforcement
- `plugin/ralph-hero/hooks/scripts/research-postcondition.sh` — research doc requirements (## Files Affected)
- `plugin/ralph-hero/hooks/scripts/plan-postcondition.sh` — plan doc committed requirement
- `plugin/ralph-hero/hooks/scripts/review-postcondition.sh` — critique doc requirement (AUTO mode)
- `plugin/ralph-hero/hooks/scripts/plan-research-required.sh` — research prerequisite for plans
- `plugin/ralph-hero/hooks/scripts/convergence-gate.sh` — group plan convergence warning
- `plugin/ralph-hero/hooks/scripts/review-verify-doc.sh` — critique frontmatter warnings
- `plugin/ralph-hero/hooks/scripts/review-no-dup.sh` — critique duplicate prevention
- `plugin/ralph-hero/hooks/scripts/plan-verify-doc.sh` — ORPHANED, documents intended enforcement
- `plugin/ralph-hero/hooks/scripts/plan-no-dup.sh` — ORPHANED, superseded by pre-artifact-validator.sh
- `plugin/ralph-hero/hooks/hooks.json` — plugin-level hook registration
- `plugin/ralph-hero/skills/shared/quality-standards.md` — plan and research quality dimensions
