---
description: Create, iterate on, or review an implementation plan. Use whenever the
  user says "plan this", "write a plan for X", "draft a spec", "decompose this
  epic", "split this into features", "iterate on the plan", "refine the plan",
  "tweak the plan", "update the plan", "amend the plan", "add a phase", "fix
  phase N", "extend the plan", "the plan is missing X", "review the plan",
  "critique this plan", "score the plan", "is this plan good?", "verdict on the
  plan", "sign off on the plan", "approve/reject the plan", hands over a plan
  path, or hands over a research doc to crystallize. Default is interactive
  (collaborative phased plan creation with human review). --mode auto is the
  autonomous XS/S picker. --mode epic is multi-tier strategic decomposition that
  creates feature children. --mode iterate makes surgical updates to an existing
  plan. --mode review produces an APPROVED/NEEDS_ITERATION verdict.
argument-hint: "[--mode auto|epic|iterate|review] [<issue-number|plan-path|description>] [--playwright|--no-playwright]"
context: inline
model: opus
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=plan"
  PreToolUse:
    - matcher: "Write"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-research-required.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/review-no-dup.sh"
    - matcher: "mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-tier-validator.sh"
    - matcher: "AskUserQuestion"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/review-plan-gate.sh"
  PostToolUse:
    - matcher: "mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-state-gate.sh"
    - matcher: "Write"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/review-verify-doc.sh"
  # review-state-gate stays unregistered (state-gate union lives on
  # plan-state-gate; double-firing would block legitimate transitions).
  # review-postcondition IS registered (re-added in GH-1378 fix). It uses
  # PATH-based mode discrimination: no-ops unless a fresh critique doc
  # exists for the ticket in thoughts/shared/reviews/. plan-postcondition
  # mirrors the pattern in reverse — it no-ops when a fresh critique
  # exists (review-mode) and validates the plan doc otherwise. Together
  # they form a mutex that does NOT rely on env-var propagation, which
  # Bash exports across the per-call subshell do not reliably provide.
  # The other path-discrimination guards still hold:
  #   - doc-structure-validator auto-picks branch from which artifact dir
  #     has the most recent today-prefixed doc,
  #   - review-verify-doc + review-no-dup self-no-op on file_path,
  #   - plan-state-gate accepts the union of valid transitions across modes.
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-postcondition.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/doc-structure-validator.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lock-release-on-failure.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/review-postcondition.sh"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
  - AskUserQuestion
  - WebSearch
  - WebFetch
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_sub_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_dependency
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__remove_dependency
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_dependencies
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__decompose_feature
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_recall
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
---

# /ralph:plan — Plan

The unified planning verb. Default is interactive collaborative plan creation.
`--mode auto` is the autonomous XS/S picker. `--mode epic` is strategic
decomposition. `--mode iterate` is surgical refinement. `--mode review` is
critique-with-verdict.

## Mode dispatch

| Mode | Behavior | Equivalent to |
|---|---|---|
| (default) | Interactive: intake → research → structure development → user review → write doc → post artifact | `/ralph-hero:plan` |
| `--mode auto [#NNN]` | Autonomous: pick XS/S Ready-for-Plan issue → lock → write doc → advance to Plan in Review | `/ralph-hero:ralph-plan` |
| `--mode epic [#NNN]` | Strategic: lock epic → write plan-of-plans → create feature children + dependency edges | `/ralph-hero:ralph-plan-epic` + epic-side of `/ralph-hero:ralph-split` |
| `--mode iterate [#NNN \| <path>] [feedback]` | Surgical: read existing plan → confirm approach → apply targeted edits | `/ralph-hero:iterate` |
| `--mode review [#NNN]` | Critique: read plan → execute rubric → write critique doc → APPROVED / NEEDS_ITERATION | `/ralph-hero:ralph-review` |
| `--help` / `-h` | Print this table and exit | — |

## Step 0: Parse args

Set `MODE` ∈ `{default, auto, epic, iterate, review}` from `--mode` flag (default if absent). Capture `ARG` (remaining positional). Capture `--playwright` / `--no-playwright`. Bail with the mode table on `--help`.

No env-flip is needed between modes: the hooks discriminate by the file path being written (review-no-dup / review-verify-doc no-op outside `thoughts/shared/reviews/`; doc-structure-validator picks its branch by which artifact dir has the most recent today-prefixed doc; plan-state-gate accepts the union of legitimate transitions across all modes).

## Default flow

1. **Intake** — resolve `ARG` per `intake-routing.md` (issue / research-doc / plan-path / free-form / no-arg). Read mentioned files FULLY before any sub-agent dispatch. Run parent-plan reuse check — if it short-circuits, post `## Plan Reference` and STOP.
2. **Research & discovery** — `knowledge_recall(role="planner", brief=true)` if available; dispatch codebase-locator / codebase-analyzer / thoughts-locator in parallel (one message, multiple `Agent()` calls). Wait for ALL, read identified files FULLY.
3. **Plan structure development** — propose phase count + ownership + verification points. `AskUserQuestion` to confirm. Loop until approved. Consult `plan-shapes.md` § Phase-section anatomy.
4. **Write the plan** — per `plan-shapes.md` (default-column required sections). Filename `thoughts/shared/plans/YYYY-MM-DD-[GH-NNNN-]description.md`.
4a. **UI Validation Phase (conditional)** — skip if `--no-playwright`. Else consult `ui-validation-phase.md`; append `## Phase N: UI Validation` if frontend-relevant + ralph-playwright installed.
5. **User review picker** — `AskUserQuestion` over *Approve* / *Approve with edits* / *Restart* / *Iterate*. `review-plan-gate.sh` hook enforces this picker runs before any state-advancing `save_issue`.
6. **GitHub integration** — if `LINKED_ISSUE`: post `## Implementation Plan` artifact comment with doc URL + 1-line summary; update issue body if scope clarified; `save_issue(workflowState: "Plan in Review", command: "plan")`. Human reviews the plan; a separate `--mode review` or manual approval advances to "In Progress".

## --mode auto

Autonomous XS/S plan picker. No questions; one issue, locked, planned, advanced. Frontmatter `hooks:` gate the flow (tier-validator, state-gate, postcondition, doc-validator, research-required, lock-release). XS/S only, 15-minute budget.

1. **Branch check** — `git branch --show-current` must be `main`.
2. **Select issue** — `ARG=#NNN` → `get_issue`; else `list_issues(profile: "analyst-plan", limit: 50)`, filter XS/S Ready-for-Plan + unblocked + has-linked-research, pick highest priority. None eligible → exit cleanly.
3. **Lock + research lookup** — `save_issue(workflowState: "__LOCK__", command: "plan")`. Find linked research per `intake-routing.md` § Linked-research check. If none → escalate to "Human Needed".
4. **Parent-plan reuse** — per `intake-routing.md` § Parent-plan reuse. If short-circuit: post `## Plan Reference`, advance child to "In Progress", report, STOP.
5. **Knowledge graph + sub-agent research** — same dispatch as default Steps 2-3, no AskUserQuestion. Wait for ALL, synthesize.
5a. **UI Validation Phase (conditional)** — per `ui-validation-phase.md`. No user prompt; heuristic-only.
6. **Write plan doc** — per `plan-shapes.md` (auto-column required sections, including Files Affected). The `plan-research-required.sh` hook blocks Write if no linked research; `doc-structure-validator.sh` blocks Stop if required sections missing.
7. **Commit + push** — `git add ... && git commit -m "docs(plan): GH-NNN implementation plan" && git push origin main`.
8. **Post artifact + advance + outcome** — `create_comment(## Implementation Plan ...)` → `save_issue(workflowState: "__COMPLETE__", command: "plan")` (advances to "Plan in Review") → `knowledge_record_outcome(event_type: "plan_completed", ...)` if available.
9. **Report** — single block: *Plan complete for #NNN: [Title] / Plan: [path] / Status: Plan in Review*.

**Escalation triggers (auto only):** advance to "Human Needed" when (a) no linked research exists, (b) issue is M/L/XL on research (suggest `--mode epic`), or (c) sub-agents surface conflicting implementations.

## --mode epic

Strategic multi-tier decomposition. Folds `ralph-plan-epic` + epic-decomposition side of `ralph-split`. Writes a plan-of-plans doc + creates feature children with dependency edges.

1. **Lock epic** — `save_issue(workflowState: "__LOCK__", command: "plan")` on the epic.
2. **Context gathering** — read epic body + comments + any linked research. Spawn `codebase-locator` for affected areas; spawn `thoughts-locator` for prior plans on the same epic. Wait for ALL.
3. **Write plan-of-plans** — per `decomposition.md` § Plan-of-plans shape. Required: Strategic Context, Shared Constraints, Feature Decomposition (3-7 features), Integration Strategy, Feature Sequencing, What We're NOT Doing.
4. **Create feature children** — per `decomposition.md` § Child creation. For each feature: `create_issue` (Backlog state, estimate from decomposition) → `add_sub_issue(parent: <epic>, child: <new>)`. Apply `add_dependency` edges per `decomposition.md` § Dependency-edge rules.
5. **Update plan-of-plans** — annotate each `### Feature` with the assigned child issue number + URL.
6. **Commit + push** — `git add ... && git commit -m "docs(plan): GH-NNN plan-of-plans" && git push origin main`.
7. **Post artifact + advance** — `create_comment(## Plan of Plans ...)` on the epic; `save_issue(workflowState: "Plan in Review", command: "plan")`.
8. **Optional orchestration** — for each child in dependency order, optionally dispatch `--mode auto` to plan that feature. The user/orchestrator picks whether to chain — this mode does not auto-cascade by default.
9. **Report** — *Plan-of-plans complete for #NNN: [Title] / Children: N created / Sequence: A → B → C*.

## --mode iterate

Surgical updates to an existing plan. No state transitions (the plan stays in whatever workflow state it was in). Consult `iteration.md`.

1. **Resolve plan** — `ARG=#NNN` → `get_issue` and follow the `## Implementation Plan` artifact comment. `ARG=<path>` → use directly. Read FULLY.
2. **Understand feedback** — `ARG` extra positional or prompt for it. Restate the change in one sentence.
3. **Confirm approach** — `AskUserQuestion`: *Apply as proposed* / *Adjust* / *Abort*. Loop on Adjust.
4. **Apply surgical edits** — prefer `Edit` over `Write` per `iteration.md` § Surgical-update principle. Preserve phase numbering; add follow-up sections rather than renumbering. Renumbering escape hatch: see `iteration.md` § Phase numbering preservation.
5. **Update issue** — post `## Plan Updated` comment summarizing what changed. Do NOT advance state. Do NOT call `save_issue` for workflow transitions in iterate mode (`plan-state-gate.sh` validates transition legitimacy; iterate-mode workflow-body discipline keeps it out of the gate entirely).
6. **Report** — *Plan iterated for #NNN: [Title] / Plan: [path] / Changes: [1-line summary]*.

## --mode review

Critique an existing plan and emit APPROVED / NEEDS_ITERATION. Folds `ralph-review`. Consult `plan-review.md`.

Mode discrimination is path-based: the Stop chain's `plan-postcondition.sh` no-ops when a fresh critique doc exists under `thoughts/shared/reviews/` for this ticket, and `review-postcondition.sh` activates only when one does. No env-var propagation across Bash subshells required.

1. **Resolve plan + issue** — `ARG=#NNN` → `get_issue`; locate the `## Implementation Plan` artifact. `--plan-doc <path>` accepted as override.
2. **Validate plan exists** — if absent, escalate the issue to "Human Needed". STOP.
3. **Execute rubric** — read plan FULLY. Score against `plan-review.md` § Review rubric.
4. **Pick mode (interactive vs auto)** — if `RALPH_REVIEW_PLAN=auto`, dispatch a sub-agent for delegated critique. Else `AskUserQuestion`: *Approve* / *Approve with edits* / *Reject* / *Need more info*.
5. **Write critique doc** — `thoughts/shared/reviews/YYYY-MM-DD-GH-NNNN-critique.md` per `plan-review.md` § Critique-doc structure. `review-no-dup.sh` blocks if a critique already exists.
6. **Verdict + transition** — APPROVED → `save_issue(workflowState: "In Progress", command: "review")` (impl can pick it up). NEEDS_ITERATION → `save_issue(workflowState: "Plan in Progress", command: "review")` + post critique as a comment on the issue with specific gap callouts. `plan-state-gate.sh` is broad enough to accept both (see hook script header for the union-of-modes valid set).
7. **Report** — *Plan reviewed for #NNN: [Title] / Verdict: APPROVED|NEEDS_ITERATION / Critique: [path]*.

## References

- `intake-routing.md` — issue / file-path / description detection + parent-plan reuse
- `plan-shapes.md` — frontmatter, section order, Phase template, per-mode required-sections matrix
- `decomposition.md` — epic → feature children, dependency-edge rules
- `iteration.md` — surgical-update principles + state preservation
- `plan-review.md` — review rubric + verdict shape + critique-doc structure
- `ui-validation-phase.md` — conditional Playwright UI Validation phase
