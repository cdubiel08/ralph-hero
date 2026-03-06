# Skill I/O Contracts

## Purpose

Defines the inputs, outputs, preconditions, and postconditions for every `ralph-*` skill. Skills are stateless processes — all context comes from inputs, all results go to outputs.

## Definitions

- **Skill**: A Claude Code skill definition (SKILL.md) that performs one unit of workflow work
- **Precondition**: A condition that MUST be true before the skill starts (validated by gate hooks)
- **Postcondition**: A condition that MUST be true when the skill completes (validated by Stop hooks)
- **Lock state**: A transient workflow state that a skill acquires at start and releases on completion or failure
- **Stateless**: Skills MUST read all context from inputs (env vars, issue number, artifact comments) and MUST NOT carry state between invocations

## Requirements

### Stateless Skills Principle

| Requirement | Enablement |
|-------------|------------|
| Skills MUST read all context from inputs (env vars, issue data, artifact comments) | [ ] not enforced |
| Skills MUST NOT carry state between invocations | [ ] not enforced |
| Skills MUST NOT assume prior invocations have run | [ ] not enforced |

### Primary Environment Variables

| Variable | Set By | Purpose |
|----------|--------|---------|
| `RALPH_COMMAND` | `set-skill-env.sh` (SessionStart) | Identifies the active skill (e.g., `triage`, `research`, `plan`) |
| `RALPH_TICKET_ID` | Skill prompt logic | Issue identifier in `GH-NNN` format |
| `RALPH_GH_OWNER` | `settings.local.json` | GitHub repository owner |
| `RALPH_GH_REPO` | `settings.local.json` | GitHub repository name |
| `RALPH_GH_PROJECT_NUMBER` | `settings.local.json` | GitHub Projects V2 number |
| `RALPH_REQUIRED_BRANCH` | `set-skill-env.sh` (SessionStart) | Required git branch (usually `main`) |

| Requirement | Enablement |
|-------------|------------|
| `RALPH_COMMAND` MUST be set by `set-skill-env.sh` at SessionStart for every skill | [x] `set-skill-env.sh` |
| `RALPH_REQUIRED_BRANCH` MUST be set for skills that require main branch | [x] `set-skill-env.sh` |

### Per-Skill Contract Table

| Skill | Input States | Output States | Lock State | Preconditions | Postconditions |
|-------|-------------|--------------|------------|---------------|----------------|
| `ralph-triage` | Backlog | Research Needed, Ready for Plan, Done, Canceled, Human Needed | — | main branch | State changed, comment added |
| `ralph-split` | Backlog, Research Needed | Done, Canceled (parent); Backlog (sub-issues) | — | main branch, M/L/XL estimate | Sub-issues created, comment added |
| `ralph-research` | Research Needed | Ready for Plan, Human Needed | Research in Progress | main branch, XS/S estimate, no existing research doc | Research doc committed, artifact comment posted |
| `ralph-plan` | Ready for Plan | Plan in Review, Human Needed | Plan in Progress | main branch, XS/S estimate, research doc attached, no existing plan doc | Plan doc committed, artifact comment posted |
| `ralph-review` | Plan in Review | In Progress, Ready for Plan, Human Needed | — | main branch, XS/S estimate, plan doc attached | State changed; critique doc committed (AUTO mode); `needs-iteration` label (if rejected) |
| `ralph-impl` | Plan in Review, In Progress | In Progress, In Review, Human Needed | — | plan doc attached, plan approved | Phase committed and pushed; PR created (final phase) |
| `ralph-val` | any (reads plan) | pass/fail verdict | — | plan doc exists | Validation report |
| `ralph-pr` | (impl complete) | In Review, Human Needed | — | completed impl, worktree | PR created, state changed to In Review |
| `ralph-merge` | In Review | Done, Human Needed | — | merged PR | State changed to Done, worktree cleanup |
| `hero` | Backlog through In Progress | In Review, Human Needed | — | main branch, issue number provided | Delegates to split/research/plan/review/impl |
| `team` | any | In Review, Human Needed | — | — | Spawns analyst/builder/integrator workers |
| `status` | read-only | (no state changes) | — | — | Dashboard output |
| `report` | read-only | (no state changes) | — | — | Status update posted |
| `ralph-hygiene` | read-only | (no state changes) | — | main branch | Archive candidates report |
| `setup` | — | — | — | — | GitHub Project V2 configuration |
| `hello` | read-only | (no state changes) | — | — | Briefing output, routes to skills |

### Precondition Enforcement

| Requirement | Enablement |
|-------------|------------|
| `ralph-triage` MUST require `Backlog` state | [x] `triage-state-gate.sh` |
| `ralph-split` MUST require `Backlog` or `Research Needed` state | [x] `split-size-gate.sh` |
| `ralph-split` MUST require M/L/XL estimate | [x] `split-estimate-gate.sh` |
| `ralph-research` MUST require `Research Needed` state | [x] `research-state-gate.sh` |
| `ralph-research` MUST require no existing research doc for this issue | [x] `pre-artifact-validator.sh` |
| `ralph-plan` MUST require `Ready for Plan` state | [x] `plan-state-gate.sh` |
| `ralph-plan` MUST require research doc attached | [x] `plan-research-required.sh` |
| `ralph-plan` MUST require no existing plan doc for this issue | [x] `pre-artifact-validator.sh` |
| `ralph-review` MUST require `Plan in Review` state | [x] `review-state-gate.sh` |
| `ralph-impl` MUST require `Plan in Review` or `In Progress` state | [x] `impl-state-gate.sh` |
| `ralph-impl` MUST require plan doc attached | [x] `impl-plan-required.sh` |
| `ralph-merge` MUST require `In Review` state | [x] `merge-state-gate.sh` |
| `ralph-pr` MUST require appropriate state for PR creation | [x] `pr-state-gate.sh` |
| Skills requiring main branch MUST validate branch before execution | [x] `branch-gate.sh` |

### Postcondition Enforcement

| Requirement | Enablement |
|-------------|------------|
| `ralph-triage` MUST change workflow state and add a comment | [x] `triage-postcondition.sh` |
| `ralph-split` MUST create sub-issues and add a comment | [x] `split-postcondition.sh` |
| `ralph-research` MUST commit a research doc with `## Files Affected` section | [x] `research-postcondition.sh` |
| `ralph-plan` MUST commit a plan doc and post artifact comment | [x] `plan-postcondition.sh` |
| `ralph-review` MUST change state and post review comment | [x] `review-postcondition.sh` |
| `ralph-impl` MUST commit phase changes and push to remote | [x] `impl-postcondition.sh` |
| `ralph-impl` MUST verify committed changes match plan expectations | [x] `impl-verify-commit.sh` |
| `ralph-impl` MUST create PR on final phase | [x] `impl-verify-pr.sh` |
| `ralph-merge` MUST complete merge and cleanup | [x] `merge-postcondition.sh` |
| `ralph-pr` MUST create PR and transition state | [x] `pr-postcondition.sh` |

### Lock State Protocol

| Requirement | Enablement |
|-------------|------------|
| `ralph-research` MUST acquire `Research in Progress` lock at start | [x] `auto-state.sh` |
| `ralph-plan` MUST acquire `Plan in Progress` lock at start | [x] `auto-state.sh` |
| Lock MUST release to success state on successful completion | [x] `auto-state.sh` |
| Lock MUST release to failure state on error | [x] `auto-state.sh` |
| Lock MUST release to `Human Needed` on escalation | [x] `auto-state.sh` |

### Standard Result Reporting Schema (Team Workers)

When running as a team worker, skills MUST report results via `TaskUpdate`.

| Requirement | Enablement |
|-------------|------------|
| Workers MUST call `TaskUpdate` with `metadata` and `description` on completion | [ ] not enforced |
| Workers MUST use `SendMessage` only for escalations, not routine reporting | [ ] not enforced |

#### Required Metadata Keys Per Phase

| Phase | Required Keys | Optional Keys |
|-------|--------------|---------------|
| Research | `artifact_path`, `workflow_state` | — |
| Plan | `artifact_path`, `phase_count`, `workflow_state` | — |
| Review | `result` (`APPROVED` or `NEEDS_ITERATION`), `artifact_path` | — |
| Impl | `worktree`, `phase_completed` | `pr_url` (if final phase) |
| Split | `sub_tickets` (array of numbers), `estimates` | — |
| Triage | `action` (`RESEARCH`, `PLAN`, `CLOSE`, `SPLIT`), `workflow_state` | — |

## Cross-References

- [artifact-metadata.md](artifact-metadata.md) — file naming and frontmatter for artifacts
- [skill-permissions.md](skill-permissions.md) — tool access per skill
- [issue-lifecycle.md](issue-lifecycle.md) — full state machine details (Phase 2)
