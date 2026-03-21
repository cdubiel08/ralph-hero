---
type: report
date: 2026-03-01
---

# Ralph Team Session Report: bugs-and-triage

**Date**: 2026-03-01

## Issues Processed

| Issue | Title | Estimate | Outcome | PR |
|-------|-------|----------|---------|-----|
| #479 | Bug: `doctor` health check doesn't increment error counter on API failure | XS | Done | #484 |
| #478 | Bug: Empty params `{}` via mcptools breaks tools with all-optional schemas | S | Done | #485 |
| #400 | GH-393 Phase 1: Create ralph-val skill | — | Closed as Done (already shipped in PR #426) | N/A |
| #397 | Add `ralph-draft` skill for rapid idea capture | S | Unlocked, reset to Research Needed | N/A |
| #362 | Detect plan drift and trigger automatic rebase | M | Deprioritized to Backlog (M/P3, no incidents) | N/A |
| #162 | Implement `copyProjectV2` mutation and template parameter | S | Fixed state: was Plan in Review but already closed — updated to Done | N/A |
| #163 | Add post-copy repository linking and tests | XS | Fixed state: was Plan in Review but already closed — updated to Done | N/A |

## New Issues Filed

| Issue | Title | Priority | Estimate |
|-------|-------|----------|----------|
| #483 | Bug: `save_issue` fails on terminal state transitions — `stateReason` not accepted | P1 | S |

## Worker Summary

| Worker | Tasks Completed |
|--------|----------------|
| analyst | Triaged 5 stale issues: closed #400, unlocked #397, deprioritized #362, fixed #162/#163 state. Discovered #483 bug. |
| builder | Implemented #479 (justfile JSON validation guard), #478 (McpServer arg normalization, 5 new tests) |
| integrator | Created PRs #484 and #485, merged both, cleaned up worktrees |

## Notes

- **New bug surfaced during triage**: `save_issue` fails when setting `workflowState="Done"` because `stateReason` is passed to `UpdateIssueInput` (wrong mutation). Filed as #483 (P1/S). Analyst used `gh` CLI and direct GraphQL as workarounds.
- **Board hygiene**: Issues #162/#163 were closed in GitHub but their project board workflow state was stuck at "Plan in Review". Direct GraphQL mutation was needed to fix the state — this is another symptom of the project field sync gap.
- **Builder confirmed** #483 is unrelated to #478/#479 — no shared root cause with the bugs fixed this session.
