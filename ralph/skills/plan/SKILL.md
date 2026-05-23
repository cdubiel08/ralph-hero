---
description: Create, iterate on, or review an implementation plan. Use whenever the
  user says "plan this", "write a plan for X", "draft a spec", "decompose this
  epic", "split this into features", "iterate on the plan", "refine the plan",
  "review the plan", "critique this plan", "approve/reject the plan", hands over
  a plan path, or hands over a research doc to crystallize. Default flow is
  interactive (collaborative phased plan creation with human review). --mode auto
  is the autonomous XS/S picker. --mode epic is multi-tier strategic decomposition
  that creates feature children. --mode iterate makes surgical updates to an
  existing plan. --mode review produces an APPROVED/NEEDS_ITERATION verdict.
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
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/review-state-gate.sh"
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
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-postcondition.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/review-postcondition.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/doc-structure-validator.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lock-release-on-failure.sh"
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

For `--mode review`, also export `RALPH_COMMAND=review` and `RALPH_ARTIFACT_DIR=thoughts/shared/reviews` via Bash before the first save_issue — this routes the gates (`review-state-gate.sh`, `review-postcondition.sh`, `review-verify-doc.sh`, `doc-structure-validator.sh` review branch) to the review-mode validation set.

## Default flow

### Step 1: Intake

Resolve `ARG` per `intake-routing.md`:

- `#NNN` / `NNN` / `GH-NNNN` → `get_issue(number)`. Set `LINKED_ISSUE`. Read issue comments for `## Research Document` artifact link; if present, read the linked research doc FULLY.
- Path to research doc (`thoughts/shared/research/*.md`) → read FULLY; extract `github_issue` from frontmatter; set `LINKED_ISSUE`.
- Path to existing plan (`thoughts/shared/plans/*.md`) → route to `--mode iterate` automatically (warn the user once).
- Free-form description → no linked issue; the user is planning ad-hoc.
- No `ARG` → prompt for issue / file / description.

Run the parent-plan reuse check per `intake-routing.md` § Parent-plan reuse. If the issue is a child of an epic whose plan-of-plans already covers this phase, post a `## Plan Reference` comment and advance the child to "In Progress" — STOP here.

### Step 2: Research & discovery

Knowledge-graph prior art (if available): `knowledge_recall(query="<topic>", role="planner", brief=true)` — planner tier policy `[reflection, wiki, doc]` surfaces synthesized + curated context.

Spawn parallel sub-agents (single message, multiple `Agent()` calls):

- `ralph-hero:codebase-locator` for WHERE files live.
- `ralph-hero:codebase-analyzer` for HOW components work.
- `ralph-hero:thoughts-locator` for prior research / plans / reviews.
- `ralph-hero:thoughts-analyzer` on the most relevant thoughts findings.

Wait for ALL. Read files identified by the locators FULLY (no offset/limit) into the main session.

### Step 3: Plan structure development

Propose phase shape based on research:

- How many phases? (1-2 for XS, 2-5 for S, 5-10 for M.)
- What does each phase own? (Tightly-scoped file sets; one concern per phase.)
- Where are the verification points? (Automated commands + manual user checks.)

Use `AskUserQuestion` to confirm structure with the user before drafting the full doc. Iterate on phase shape until the user approves. Consult `plan-shapes.md` § Phase-section anatomy for the shape each phase will take.

## --mode auto

_(Filled by Phase 4.)_

## --mode epic

_(Filled by Phase 5.)_

## --mode iterate

_(Filled by Phase 6.)_

## --mode review

_(Filled by Phase 6.)_

## References

- `intake-routing.md` — issue / file-path / description detection + parent-plan reuse
- `plan-shapes.md` — frontmatter, section order, Phase template, per-mode required-sections matrix
- `decomposition.md` — epic → feature children, dependency-edge rules
- `iteration.md` — surgical-update principles + state preservation
- `plan-review.md` — review rubric + verdict shape + critique-doc structure
- `ui-validation-phase.md` — conditional Playwright UI Validation phase
