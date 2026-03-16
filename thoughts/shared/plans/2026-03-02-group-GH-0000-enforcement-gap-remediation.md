---
date: 2026-03-02
status: draft
github_issues: [495, 496, 497, 498, 499, 500, 501, 502, 503]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/495
  - https://github.com/cdubiel08/ralph-hero/issues/496
  - https://github.com/cdubiel08/ralph-hero/issues/497
  - https://github.com/cdubiel08/ralph-hero/issues/498
  - https://github.com/cdubiel08/ralph-hero/issues/499
  - https://github.com/cdubiel08/ralph-hero/issues/500
  - https://github.com/cdubiel08/ralph-hero/issues/501
  - https://github.com/cdubiel08/ralph-hero/issues/502
  - https://github.com/cdubiel08/ralph-hero/issues/503
primary_issue: 495
type: parent-plan
---

# Enforcement Gap Remediation — Parent Plan

## Overview

This is a **plan of plans** to remediate all 90 enforcement gaps across the 8 Ralph protocol specifications. The specs define a three-layer permission and prompt injection defense:

1. **Agent definitions** — maximum tool surface per role
2. **Skill `allowed-tools`** — per-skill restriction within agent surface
3. **`require-skill-context.sh`** — blocks mutating tools outside any skill context

Beyond the three layers, hooks enforce state machine transitions, artifact naming, document structure, and team coordination protocols. This parent plan organizes remediation into 8 child plans, prioritized by security impact, blast radius, and implementation complexity.

## Current State Analysis

### Spec Baseline (from `specs/README.md` as of 2026-03-01)

| Spec | Enforced | Gap | % Enforced |
|------|----------|-----|------------|
| artifact-metadata.md | 11 | 32 | 26% |
| skill-io-contracts.md | 31 | 5 | 86% |
| skill-permissions.md | 6 | 5 | 55% |
| agent-permissions.md | 13 | 0 | 100% |
| issue-lifecycle.md | 18 | 7 | 72% |
| document-protocols.md | 10 | 14 | 42% |
| task-schema.md | 3 | 12 | 20% |
| team-schema.md | 3 | 15 | 17% |
| **Total** | **95** | **90** | **51%** |

### Critical Findings From Research

Codebase analysis revealed issues more serious than simple missing hooks:

#### Spec Inaccuracies — `[x]` Claims With No Enforcement

| Spec | Claimed `[x]` | Reality |
|------|---------------|---------|
| `agent-permissions.md:160-162` | `worker-stop-gate.sh` enforces stop gate | **Script does not exist on main branch** — only in worktrees |
| `agent-permissions.md:160` | Agent `.md` files register Stop hooks | **No Stop hook registered** in any agent `.md` on main |
| `issue-lifecycle.md:61,100-104` | `auto-state.sh` enforces lock protocol | **Script does not exist** anywhere in the plugin |
| `skill-permissions.md:71` | `pre-github-validator.sh` matches `ralph_hero__update_workflow_state` | **No MCP tool by that name exists** — the tool is `save_issue` with `workflowState` param |

#### Silent Enforcement Failures

| Hook | Issue |
|------|-------|
| `pre-ticket-lock-validator.sh` | Always exits 0 — comment says "we can't block" |
| State-gate hooks (`impl-state-gate.sh`, `plan-state-gate.sh`, etc.) | Read `.tool_input.state` but `save_issue` uses `.tool_input.workflowState` — field mismatch means checks always fall through to `allow` |
| `artifact-discovery.sh` | Explicitly designed to warn only, never block |
| `review-verify-doc.sh` | All three frontmatter checks emit WARNING and exit 0 |
| `convergence-gate.sh` | Does not exist on active plugin (only in worktrees) |
| `plan-verify-doc.sh` | Does not exist on active plugin; self-labeled ORPHANED in worktree |

These findings mean the **actual enforcement rate is lower than 51%**. Several `[x]` entries in the specs are inaccurate.

## Desired End State

After all 8 child plans are implemented:

- **Every `[ ]` gap** in every spec has a corresponding enforcement mechanism (hook script) that blocks (exit 2) on violation, or the gap is explicitly reclassified as SHOULD (advisory) vs MUST (blocking)
- **Every `[x]` claim** in every spec is verified accurate against the main branch codebase
- **All spec inaccuracies** (false `[x]` claims, wrong tool names, missing scripts) are corrected
- **Enforcement coverage** reaches ≥90% for MUST requirements across all specs
- **The three-layer permission model** has zero bypass paths for mutating tools

## What We're NOT Doing

- **Changing the spec requirements themselves** — specs define the contract; we only add enforcement or fix inaccuracies
- **Leaving SHOULD/MAY requirements unenforced** — creative hook-based enforcement will be attempted for all requirements, including quality dimensions and conventions
- **Rewriting existing hooks that work correctly** — only fix broken hooks or add missing ones
- **Adding new workflow states or transitions** — the state machine stays as-is
- **Changing MCP server tool signatures** — hooks adapt to existing tool interfaces

## Child Plan Index

### Priority 1 — Security & Correctness (Must fix first)

These plans address bypass paths in the permission model and false enforcement claims.

#### Child Plan 1: Spec Accuracy Corrections & Silent Failure Fixes
**Scope**: Fix `[x]` claims that are wrong, repair hooks that silently fail, correct tool name mismatches
**Gap count**: ~8 false `[x]` entries + ~6 silent failures
**Complexity**: S-M (mostly editing existing files, some hook script fixes)
**Security impact**: HIGH — false enforcement claims mask real vulnerabilities

**Gaps addressed**:
- [ ] Fix `agent-permissions.md` to mark `worker-stop-gate.sh` as `[ ]` (script absent from main)
- [ ] Fix `issue-lifecycle.md` to mark `auto-state.sh` references as `[ ]` (script doesn't exist)
- [ ] Fix `skill-permissions.md` tool matcher from `ralph_hero__update_workflow_state` to match actual MCP tool names
- [ ] Fix state-gate hooks to read `.tool_input.workflowState` instead of `.tool_input.state`
- [ ] Fix `pre-ticket-lock-validator.sh` to actually check lock state (currently always exits 0)
- [ ] Fix `hooks.json` tool matchers referencing non-existent `ralph_hero__update_workflow_state`
- [ ] Decide: should `artifact-discovery.sh` be upgraded from warn to block?
- [ ] Decide: should `review-verify-doc.sh` warnings become blocks?

---

#### Child Plan 2: Skill Permission Lockdown
**Scope**: Add `allowed-tools` to the 4 skills missing it; verify all other skills match the spec matrix
**Gap count**: 5 (4 skills + 1 meta requirement)
**Complexity**: XS (trivial frontmatter additions)
**Security impact**: HIGH — without `allowed-tools`, these skills run with unrestricted tool access

**Gaps addressed**:
- [ ] Add `allowed-tools: [Read, Bash]` to `ralph-status/SKILL.md`
- [ ] Add `allowed-tools: [Read, Bash]` to `ralph-report/SKILL.md`
- [ ] Add `allowed-tools: [Read, Glob, Bash]` to `ralph-hygiene/SKILL.md`
- [ ] Add `allowed-tools: [Bash]` to `ralph-setup/SKILL.md`
- [ ] Audit remaining skills against `skill-permissions.md` matrix for any other mismatches

---

#### Child Plan 3: State Machine Enforcement Hardening
**Scope**: Implement missing state machine enforcement: lock claim prevention, lock release on failure, semantic intent validation, Human Needed outbound block
**Gap count**: 7 (from issue-lifecycle.md)
**Complexity**: M-L (requires new hooks + MCP server awareness of current state)
**Security impact**: HIGH — without lock enforcement, concurrent agents can corrupt issue state

**Gaps addressed**:
- [ ] Enforce that agents cannot claim issues already in lock states (Research in Progress, Plan in Progress, In Progress)
- [ ] Implement lock release on failure (rollback to pre-lock state when skill fails)
- [ ] Enforce semantic intent usage when `command` parameter is available
- [ ] Block automated transitions out of Human Needed state
- [ ] Validate issues are in exactly one workflow state (prevent double-state)
- [ ] Enforce estimate/priority/workflowState after issue creation
- [ ] Enforce that issues have required title at creation

---

### Priority 2 — Workflow Integrity (Prevents data corruption)

These plans ensure artifacts and documents meet their contracts.

#### Child Plan 4: Artifact Metadata Validation
**Scope**: File naming pattern enforcement + frontmatter schema validation for all artifact types
**Gap count**: 23 (5 naming + 18 frontmatter from artifact-metadata.md)
**Complexity**: M (new PostToolUse hook on Write that validates filename regex + YAML frontmatter)
**Integrity impact**: MEDIUM — malformed artifacts break discovery, but don't corrupt state

**Gaps addressed**:

*File naming (5)*:
- [ ] Research filenames MUST match `YYYY-MM-DD-GH-{NNNN}-{slug}.md`
- [ ] Plan (single) filenames MUST match `YYYY-MM-DD-GH-{NNNN}-{slug}.md`
- [ ] Plan (group) filenames MUST match `YYYY-MM-DD-group-GH-{NNNN}-{slug}.md`
- [ ] Critique filenames MUST match `YYYY-MM-DD-GH-{NNNN}-critique.md`
- [ ] Issue numbers MUST use 4-digit zero-padding (`GH-0019`)

*Research frontmatter (5)*:
- [ ] `date` (YYYY-MM-DD)
- [ ] `github_issue` (integer)
- [ ] `github_url` (full URL)
- [ ] `status` (draft or complete)
- [ ] `type: research`

*Plan frontmatter — single (5)*:
- [ ] `date`, `status`, `github_issues` (array), `github_urls` (array), `primary_issue`

*Plan frontmatter — group (4)*:
- [ ] All single-plan fields + group-specific optional fields

*Critique frontmatter (4)*:
- [ ] `date`, `github_issue`, `status`, `type: critique`

*Report naming (1)*:
- [ ] Report filenames MUST match `YYYY-MM-DD-{slug}.md`

**Implementation approach**: Single `artifact-metadata-validator.sh` PostToolUse hook on `Write`, activated for files under `thoughts/shared/{research,plans,reviews,reports}/`. Parses YAML frontmatter with `awk`/`grep`, validates filename regex, blocks (exit 2) on violation.

---

#### Child Plan 5: Artifact Comment Protocol Enforcement
**Scope**: Upgrade `artifact-discovery.sh` from warn-only to blocking; enforce comment posting; enforce discovery sequence
**Gap count**: 7 (5 from artifact-metadata.md + 2 from artifact discovery sequence)
**Complexity**: M (modify existing hook + add postcondition checks)
**Integrity impact**: MEDIUM — missing comments break cross-skill artifact discovery

**Gaps addressed**:
- [ ] `## Research Document` comment MUST be posted after research creation (upgrade warn → block)
- [ ] `## Implementation Plan` comment MUST be posted after plan creation (upgrade warn → block)
- [ ] Artifact URL MUST appear on line immediately after header
- [ ] When multiple comments match, most recent MUST be used
- [ ] Skills MUST follow the discovery sequence (comment → glob fallback → self-heal)
- [ ] Skills MUST self-heal missing artifact comments when fallback glob succeeds
- [ ] `artifact-discovery.sh` passthrough cache (`RALPH_ARTIFACT_CACHE`) is never populated — fix or remove

---

#### Child Plan 6: Document Structure Validation
**Scope**: Enforce required sections in research docs, plan phase structure, success criteria format, critique verdict
**Gap count**: 14 (from document-protocols.md)
**Complexity**: M (new/updated Stop hooks that grep for required sections)
**Integrity impact**: MEDIUM — malformed docs cause downstream skill failures

**Gaps addressed**:

*Research docs (3)*:
- [ ] Frontmatter with `github_issue` and `status` fields (declared in contracts JSON but no hook validates)
- [ ] All required sections: problem statement, analysis, discoveries, approaches, risks, next steps
- [ ] Artifact Comment with `## Research Document` header posted after creation

*Plan docs (4)*:
- [ ] `## Phase N:` header pattern for each phase (register and fix `plan-verify-doc.sh`)
- [ ] Success criteria in `- [ ] Automated:` / `- [ ] Manual:` format per phase
- [ ] Frontmatter with required fields
- [ ] Artifact Comment with `## Implementation Plan` header posted after creation

*Critique docs (2)*:
- [ ] Verdict section containing APPROVED or NEEDS_ITERATION
- [ ] Artifact Comment with `## Plan Critique` header posted after creation

*Convergence (1)*:
- [ ] Register and activate `convergence-gate.sh` (currently only in worktrees)

*Quality (4 — creative enforcement)*:
- [ ] Research quality dimensions (Depth, Feasibility, Risk, Actionability) — enforce via section header grep
- [ ] Plan quality dimensions (Completeness, Feasibility, Clarity, Scope) — enforce via section header grep
- [ ] Skills SHOULD evaluate documents against quality dimensions — enforce via postcondition section checks
- [ ] Note: Enforcement is proxy-based (section presence, not subjective quality). False negatives possible but catches the most common failure: missing entire sections.

---

### Priority 3 — Coordination Protocol (Prevents team dysfunction)

These plans enforce the multi-agent coordination protocol.

#### Child Plan 7: Task Schema Validation
**Scope**: Enforce TaskCreate required fields, metadata schemas, TaskUpdate result schemas, blocking dependencies, subject naming
**Gap count**: 12 (from task-schema.md)
**Complexity**: M (new PreToolUse hooks on TaskCreate/TaskUpdate)
**Coordination impact**: MEDIUM — missing metadata causes silent failures in task handoffs

**Gaps addressed**:
- [ ] TaskCreate MUST include subject, description, activeForm, metadata
- [ ] Subject MUST be in imperative form
- [ ] Input metadata MUST include issue_number, issue_url, command, phase, estimate
- [ ] Group-specific metadata keys when processing grouped issues
- [ ] Workers MUST set phase-appropriate metadata keys on completion
- [ ] Workers MUST include meaningful description on completion
- [ ] TaskUpdate is primary reporting channel (not SendMessage)
- [ ] Workers MUST NOT claim tasks with open blockedBy dependencies
- [ ] Team lead SHOULD use addBlockedBy for phase ordering
- [ ] Task subjects MUST include role-specific keyword
- [ ] Task subjects MUST include issue number (GH-NNN or #NNN)
- [ ] Worker names MUST use role prefixes for stop gate matching

---

#### Child Plan 8: Team Protocol Enforcement
**Scope**: Enforce TeamCreate ordering, spawn protocol, worker contracts, sub-agent isolation, shutdown sequence, post-mortem creation
**Gap count**: 15 (from team-schema.md)
**Complexity**: M-L (new hooks on TeamCreate/TeamDelete/Task spawn + Stop hook updates)
**Coordination impact**: MEDIUM — protocol violations cause team state corruption

**Gaps addressed**:

*TeamCreate ordering (2)*:
- [ ] TeamCreate MUST be called before TaskCreate
- [ ] Workers spawned before tasks assigned

*Roster sizing (2)*:
- [ ] Integrator limited to 1 per team (SHOULD — advisory)
- [ ] Roster size matches pipeline position (SHOULD — advisory)

*Spawn protocol (3)*:
- [ ] Worker name MUST use role prefix (analyst*, builder*, integrator*)
- [ ] Spawn prompts MUST include all 6 required fields
- [ ] team_name MUST be set for team binding

*Worker contracts (2)*:
- [ ] Workers MUST NOT use SendMessage for routine reporting
- [ ] Workers MUST report via TaskUpdate metadata and description

*Sub-agent isolation (1)*:
- [ ] Internal sub-tasks MUST NOT pass team_name

*Shutdown (2)*:
- [ ] Post-mortem MUST be written before TeamDelete
- [ ] Shutdown requests MUST be sent to all teammates before TeamDelete

*Post-mortem (3)*:
- [ ] MUST include Issues Processed and Worker Summary tables
- [ ] MUST use standard commit message pattern
- [ ] MUST capture all session results before TeamDelete

*Stateless principle (3 — from skill-io-contracts.md, creative enforcement)*:
- [ ] Skills read all context from inputs — SessionStart hook clears leftover env vars
- [ ] Skills don't carry state between invocations — SessionStart hook resets `RALPH_ARTIFACT_CACHE` and similar state files
- [ ] Skills don't assume prior invocations — postcondition hooks verify all required inputs were explicitly read

---

## Implementation Sequencing

```
Plan 1 (Spec Accuracy)  ──┐
                           ├──→ Plan 3 (State Machine) ──→ Plan 5 (Artifact Comments)
Plan 2 (Skill Perms)    ──┘
                                                           Plan 6 (Doc Structure)
                           Plan 4 (Artifact Metadata)  ──→ ↑

Plan 7 (Task Schema)    ──→ Plan 8 (Team Protocol)
```

**Rationale**:
- Plans 1 & 2 are prerequisites — fix false claims and close permission bypasses first
- Plan 3 depends on Plan 1 (state-gate hook fixes)
- Plan 4 is independent (new validation hook)
- Plans 5 & 6 share artifact awareness with Plans 3 & 4
- Plans 7 & 8 are coordination-layer and can proceed in parallel with Plans 3-6

## Estimated Effort

| Plan | Estimate | New Hooks | Modified Hooks | Spec Edits | Key Risk |
|------|----------|-----------|----------------|------------|----------|
| 1. Spec Accuracy | S | 0 | 3-4 | 3 | State-gate field name fix may break existing behavior |
| 2. Skill Perms | XS | 0 | 0 | 0 | May block tools currently used by skills |
| 3. State Machine | M | 2-3 | 1-2 | 1 | Lock enforcement may strand issues if agents crash |
| 4. Artifact Metadata | M | 1 | 0 | 0 | Regex too strict may block valid artifacts |
| 5. Artifact Comments | S | 0 | 1-2 | 0 | Upgrading warn→block may break existing workflows |
| 6. Doc Structure | M | 1-2 | 1 | 0 | Section detection heuristics may false-positive |
| 7. Task Schema | M | 1-2 | 0 | 0 | Hook on TaskCreate may slow team spawn |
| 8. Team Protocol | L | 2-3 | 0 | 0 | TeamDelete gate may prevent cleanup |

## Testing Strategy

Each child plan MUST include:
1. **Positive tests**: Hook allows valid input
2. **Negative tests**: Hook blocks invalid input (exit 2)
3. **Regression tests**: Existing workflows still pass end-to-end
4. **Spec update**: Flip `[ ]` to `[x]` with hook filename after verification

## Resolved Decisions

### Decision 1: Warn vs Block — UPGRADE TO BLOCKING
Existing warn-only hooks (`artifact-discovery.sh`, `review-verify-doc.sh`) will be upgraded to block (exit 2) on violation. No "strict mode" flag — enforcement is unconditional.

### Decision 2: SHOULD Reclassification — KEEP AS ENFORCEABLE, GET CREATIVE
All ~10 advisory requirements stay as enforceable gaps. Creative hook-based enforcement will be attempted:
- Quality dimensions → grep for required section headers as proxy
- Roster sizing → hook on Agent spawn to count team members by role prefix
- Stateless principle → SessionStart hook to clear leftover env vars

### Decision 3: Missing Scripts — INVESTIGATE BEFORE RECREATING
Each child plan must include a "why is this missing?" investigation step (git history, PR comments, post-mortems) before deciding implementation approach. Some scripts may have been deliberately removed. The enforcement goal remains, but the mechanism may differ from the original script.

### Decision 4: Scope — ALL 8 PLANS AS ISSUES NOW
All 8 child plans created as GitHub issues immediately. Implementation follows P1 → P2 → P3 sequencing. Full roadmap visibility from day one.

## References

- Specs: `specs/README.md` and all 8 spec files
- Hook scripts: `plugin/ralph-hero/hooks/scripts/`
- Hooks registry: `plugin/ralph-hero/hooks/hooks.json`
- Skill definitions: `plugin/ralph-hero/skills/*/SKILL.md`
- Agent definitions: `plugin/ralph-hero/agents/*.md`
- MCP server: `plugin/ralph-hero/mcp-server/src/`
- State machine: `plugin/ralph-hero/hooks/scripts/ralph-state-machine.json`
- Command contracts: `plugin/ralph-hero/hooks/scripts/ralph-command-contracts.json`
