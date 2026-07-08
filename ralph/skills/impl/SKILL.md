---
description: Implement an approved plan, address PR review feedback, or create a pull
  request. Use whenever the user says "implement this", "code this up", "build
  the plan", "ship phase N", "run the plan", "execute the plan", "do the
  implementation", "auto-impl", "next phase", "resume the build", "address the
  review", "fix the PR feedback", "respond to comments", "create a PR", "open a
  pull request", "push the branch", "make the PR", hands over an issue number or
  plan path. Default is interactive (phase-by-phase with human verification).
  --mode auto runs ONE phase autonomously per invocation, hook-gated. --mode
  address handles PR review feedback. --mode pr creates a pull request for a
  completed implementation.
argument-hint: "[--mode auto|address|pr] [<issue-number|plan-path>] [--plan-doc <path>] [--loop [duration]] [--auto]"
context: inline
model: sonnet
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=impl"
  PreToolUse:
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-plan-required.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-worktree-gate.sh"
    - matcher: "mcp__plugin_ralph_ralph-github__ralph_hero__save_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/state-gate.sh impl impl pr"
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-staging-gate.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-branch-gate.sh"
  PostToolUse:
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/drift-tracker.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/artifact-write-tracker.sh"
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-verify-commit.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-postcondition.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lock-release-on-failure.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/doc-structure-validator.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/remember-turn.sh"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
  - Task
  - WebSearch
  - WebFetch
  - AskUserQuestion
  - mcp__plugin_ralph_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph_ralph-github__ralph_hero__list_sub_issues
  - mcp__plugin_ralph_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_recall
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
---

# /ralph:impl — Implement, address review, or ship PR

Reads an approved plan from `thoughts/shared/plans/`, executes phases, and ships a PR. Four modes share substrate (worktree isolation, plan compliance, staging gates) but route to distinct workflow bodies.

| Mode | Trigger | Role |
|---|---|---|
| **default** | `/ralph:impl #NNN` or `/ralph:impl <plan-path>` | Interactive phase-by-phase implementation, paused between phases for human verification |
| **auto** | `/ralph:impl --mode auto [#NNN] [--plan-doc <path>]` | Autonomous ONE phase per invocation, hook-gated, then STOP for resumability |
| **address** | `/ralph:impl --mode address [#NNN]` | PR review feedback handling (MUST_FIX / SHOULD_FIX / DISCUSS) |
| **pr** | `/ralph:impl --mode pr [#NNN]` | Push branch + create PR + scout-trigger heuristic |

References: [worktree-setup.md](worktree-setup.md) (worktree lifecycle, cross-repo), [plan-compliance.md](plan-compliance.md) (File Ownership, staging, drift), [phase-execution.md](phase-execution.md) (task graph, controller, IMPL BLOCKED), [address-mode.md](address-mode.md) (PR feedback classification), [pr-creation.md](pr-creation.md) (body template, scout trigger).

## Step 0: Parse arguments

**`--auto` alias** — resolve BEFORE `--loop` detection. See `ralph/skills/shared/auto-alias.md`:
- If `--auto` in `$ARGUMENTS` AND `--mode` also present → emit `--auto cannot be combined with explicit --mode; pick one.` and STOP.
- If `--auto` in `$ARGUMENTS` → strip `--auto` token, prepend `--mode auto` to `$ARGUMENTS` (verb=impl alias row). Continue to `--loop` detection with the rewritten args.

**`--loop` gate** — run the arg-parsing snippet from `ralph/skills/shared/loop-wrapper.md` § Arg-parsing snippet (sets `LOOP_RAW`, `LOOP_INTERVAL`, `STRIPPED_ARGS`). If `LOOP_RAW` is set:
- MODE `auto` → `Skill("loop", …)` using the `impl:auto` manifest row + continuation-prompt template from `loop-wrapper.md`, then STOP.
- MODE `pr` → `Skill("loop", …)` using the `impl:pr` row, then STOP.
- MODE `default` or `address` → emit the refusal from `loop-wrapper.md` § Refusal message, then STOP.

Resolve `MODE`, `TARGET`, optional flags from args:

- no args → `MODE=default`, prompt for TARGET
- `#NNN` / `NNN` / `<plan-path>` → `MODE=default`, TARGET resolved
- `--mode auto [#NNN]` → `MODE=auto`, TARGET=NNN or queue-pick
- `--mode address #NNN` → `MODE=address`, TARGET=NNN (must be In Review)
- `--mode pr [#NNN]` → `MODE=pr`, TARGET=NNN or queue-pick
- `--plan-doc <path>` → auto-mode shortcut, bypass plan discovery

Export `RALPH_TICKET_ID="GH-${TARGET}"` when TARGET is an issue number.

## Default mode — interactive phase-by-phase

### Step 1: Resolve plan + issue

For `#NNN`: fetch issue, scan comments for `## Implementation Plan` (most recent if multiple), extract path from URL. Fall back to glob `thoughts/shared/plans/*GH-${NNN}*` then `*group*GH-*` (scan frontmatter for issue number). If found via glob only, self-heal by posting the missing artifact comment. STOP with "No plan found for #NNN" if no match.

For `<plan-path>`: verify file exists, read frontmatter for `github_issue` / `github_issues`. Proceed without issue integration if no link.

### Step 2: Read plan fully

Read fully (no offset/limit). Detect resumption: scan for existing `- [x]` checkmarks; the first unchecked phase is the start point. Build context: which issue(s) does the plan cover (single `github_issue` or group `github_issues`).

### Step 3: Setup

Optional worktree suggestion per [worktree-setup.md §Suggestion](worktree-setup.md). If the user agrees, run `scripts/create-worktree.sh GH-NNN` and `cd worktrees/GH-NNN`. Otherwise implement in place.

Transition the linked issue to "In Progress" (skip if already). Post `## Implementation Started` comment.

### Step 4: Implement phase by phase

For each unchecked phase:

1. Read phase requirements + all referenced files (FULLY).
2. Implement changes per [plan-compliance.md §File Ownership](plan-compliance.md).
3. Run the phase's automated verification commands; fix until they pass.
4. Update `- [ ]` → `- [x]` for automated items that pass. Do NOT check manual items.
5. **Pause for human verification** via AskUserQuestion: list automated checks that passed + manual items the user must run. Wait for confirmation before proceeding to next phase.
6. If reality doesn't match the plan, STOP and surface the gap (Expected / Found / Why this matters / How should I proceed?).

If instructed to execute multiple phases consecutively, skip the pause until the final phase.

### Step 5: Complete

When all phases are verified:

1. **Stage + commit + push** the final phase per [plan-compliance.md §Staging Algorithm](plan-compliance.md). Multi-repo plans: commit and push in each worktree separately.
2. **Create PR** — either inline `gh pr create` (simple cases) or delegate to `--mode pr` for the full body composition + scout-trigger evaluation. Title `GH-NNN: <issue title>`. Body: `## Summary` + `## Plan` (link to plan doc) + `## Test plan` (from Success Criteria) + `Closes #NNN`. Capture the PR URL.
3. **Transition issue to "In Review"** via `save_issue`. For groups, advance every sub-issue.
4. **Post `## Implementation Complete` comment** on the issue with PR URL, branch, and "All phases implemented and verified."

### Step 6: Next-steps picker

Ask the user via AskUserQuestion what to do next:

- **Run review (close-out)** — `Skill("ralph:review", args="NNN")` — full val → code-review → merge → CI watch pipeline.
- **Create PR only** — already done in Step 5; re-confirm URL.
- **Iterate on plan** — `Skill("ralph:plan", args="--mode iterate #NNN")`.
- **Done for now** — report current state and STOP.

## `--mode auto` — autonomous one phase per invocation

1. **Select target** — `#NNN` provided OR `list_issues(profile: "builder-active", limit: 1)` highest-priority XS/S in "In Progress".
2. **Detect mode** — if issue is "In Review" with an open PR carrying review comments, delegate to [`--mode address`](#--mode-address--pr-review-feedback). Otherwise continue.
3. **Read plan** — Artifact Comment Protocol with knowledge_recall shortcut (search `type=plan, role=implementer`). STOP with `Issue #NNN has no implementation plan` if neither `## Implementation Plan` nor `## Plan Reference` is found.
4. **Build issues[] + detect phase** — frontmatter `github_issues` array (group) or single `github_issue`. Find the first **unblocked** unchecked phase per `depends_on` annotations; STOP if all remaining phases are blocked.
5. **Lock** — for every issue in `issues[]`, `save_issue(workflowState="__LOCK__", command="ralph_impl")`. STOP if any issue is not "In Progress".
6. **Worktree** — consult [worktree-setup.md §Auto-mode](worktree-setup.md) for epic detection, WORKTREE_ID selection (stream / epic / group / single), base-branch detection, create-or-reuse, rebase-onto-main if predecessor merged.
7. **Execute phase** — consult [phase-execution.md](phase-execution.md) for the task graph + controller pattern + IMPL BLOCKED escalation + phase quality review. If sub-agent budget exhausts at a non-opus tier, emit `IMPL BLOCKED model=<current> needs=opus reason=<short>` and STOP (do NOT escalate to Human Needed; hero re-dispatches at opus once).
8. **Stage + commit + push** — per [plan-compliance.md §Staging Algorithm](plan-compliance.md).
9. **Check completion** — re-read plan. If ALL automated checkboxes are checked, continue to Step 10; otherwise STOP with `Phase [N]/[M] complete.`.
10. **Final report** — `Implementation complete for #NNN: <Title>` + issues + branch + worktree.

## `--mode address` — PR review feedback

1. **Verify state** — issue must be "In Review" with an open PR. STOP otherwise.
2. **Gather feedback** — `gh pr view <NNN> --json reviews,comments` + `gh api repos/$RALPH_GH_OWNER/$RALPH_GH_REPO/pulls/<NNN>/comments`. Skip resolved/outdated.
3. **Classify** each comment as MUST_FIX / SHOULD_FIX / DISCUSS per [address-mode.md §Classification](address-mode.md).
4. **Reuse worktree** — `cd $GIT_ROOT/worktrees/GH-NNN && git pull origin <branch>`.
5. **Address** items grouped by file: read, fix, verify (lint/tests). DISCUSS items get reply-only.
6. **Stage** only modified files (PR's existing file list + reviewer-requested new files). Never `git add -A`/`.`/`--all`.
7. **Commit** with `fix: address PR review feedback` heading + change bullets. **Push.**
8. **Reply** to each PR comment: change + commit ref for fixed items, rationale for DISCUSS items. Post summary comment.
9. **Report** MUST_FIX/SHOULD_FIX/DISCUSS counts. Issue stays "In Review".

## `--mode pr` — push branch and create pull request

1. **Parse args** — `#NNN` provided OR queue-pick: `list_issues(workflowState: "In Progress", limit: 10)`; **resolve each candidate to its plan's WORKTREE_ID first** (locate the plan per the Artifact Comment Protocol; group plan → `GH-[primary_issue]`, single → `GH-NNN`), then check `worktrees/<WORKTREE_ID>` exists AND no open PR for `feature/<WORKTREE_ID>`. De-duplicate candidates sharing a plan — group members resolve to the SAME worktree ID; the first wins and the one PR closes every member (GH-1538). STOP with literal `Queue empty.` if none match. (This literal is the loop-runner sentinel.)
2. **Fetch issue + worktree** — `feature/<WORKTREE_ID>` branch. Detect cross-repo per [pr-creation.md §Cross-repo](pr-creation.md) if multiple worktrees exist.
3. **Push branch** — `git push -u origin feature/<WORKTREE_ID>` from the worktree.
4. **Compose PR body** — `## Summary` (optional delegation per [pr-creation.md §Delegated Summary](pr-creation.md)) + `## Plan` (link) + `## Test plan` (from Success Criteria) + `Closes #NNN` (one per sub-issue for groups).
5. **Create PR** — `gh pr create --title "GH-NNN: <title>" --body-file <body> --head feature/GH-NNN --base main`. Capture URL.
6. **Advance issues** to "In Review" via `save_issue` (standalone: own state; group: every child; never advance parent — server-side workflow handles that).
7. **Record outcome** — `knowledge_record_outcome(event_type="pr_created", issue_number=NNN, verdict="created", payload={pr_url, branch, repo})`.
8. **Evaluate UI heuristic** — per [pr-creation.md §Scout Trigger](pr-creation.md). Post `## Scout Trigger` advisory comment if any frontend glob matches.
9. **Artifact comment** — post `## Pull Request` on the issue with PR URL.
10. **Report** — `PR CREATED / Issue: #NNN / PR: <url> / State: In Review`.

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.
