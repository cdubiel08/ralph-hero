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
argument-hint: "[--mode auto|epic|iterate|review] [<issue-number|plan-path|description>] [--playwright|--no-playwright] [--loop [duration]] [--auto]"
context: inline
model: best
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
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-tier-validator.sh"
    - matcher: "Edit"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-tier-validator.sh"
    - matcher: "AskUserQuestion"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/review-plan-gate.sh"
    - matcher: "mcp__plugin_ralph_ralph-github__ralph_hero__save_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/state-gate.sh plan plan plan_epic review"
    - matcher: "mcp__plugin_ralph_ralph-github__ralph_hero__get_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/split-estimate-gate.sh"
    - matcher: "mcp__plugin_ralph_ralph-github__ralph_hero__create_issue|mcp__plugin_ralph_ralph-github__ralph_hero__create_sub_issues"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/split-size-gate.sh"
  PostToolUse:
    - matcher: "Write"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/review-verify-doc.sh"
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/artifact-write-tracker.sh"
    - matcher: "mcp__plugin_ralph_ralph-github__ralph_hero__get_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/split-estimate-gate.sh"
  # state-gate.sh carries the union of valid transitions across all five
  # plan modes via its command keys (plan + plan_epic + review), read from
  # ralph-state-machine.json.
  # split-* hooks (GH-1605) are the one exception to the file-path
  # discrimination note below — they fire on MCP tool payloads / Stop, which
  # carry no file_path, so they key on RALPH_SUBCOMMAND=epic-split (armed by
  # decomposition.md § Atomic split's re-export, on top of the Step 0 case
  # export above). The plan-of-plans path stays at RALPH_SUBCOMMAND=epic and
  # early-exits all three guards.
  # plan-postcondition owns BOTH plan-mode and review-mode Stop checks,
  # discriminating by which artifact path this session wrote (critique
  # under reviews/ → review mode; plan doc under plans/ → plan mode).
  # Artifact discovery is session-scoped via artifact-write-tracker.sh
  # (PostToolUse Write|Edit below), NOT env vars — Bash exports across the
  # per-call subshell do not reliably reach hook subprocesses — and NOT
  # directory mtime, which raced against concurrent sessions.
  # The other path-discrimination guards still hold:
  #   - doc-structure-validator picks its branch from each session-written
  #     doc's artifact dir,
  #   - review-verify-doc + review-no-dup self-no-op on file_path,
  #   - state-gate.sh accepts the union of valid transitions across modes.
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-postcondition.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/doc-structure-validator.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/split-postcondition.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lock-release-on-failure.sh"
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
  - AskUserQuestion
  - PushNotification
  - WebSearch
  - WebFetch
  - mcp__plugin_ralph_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__create_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph_ralph-github__ralph_hero__add_sub_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__create_sub_issues
  - mcp__plugin_ralph_ralph-github__ralph_hero__add_dependency
  - mcp__plugin_ralph_ralph-github__ralph_hero__remove_dependency
  - mcp__plugin_ralph_ralph-github__ralph_hero__list_dependencies
  - mcp__plugin_ralph_ralph-github__ralph_hero__list_sub_issues
  - mcp__plugin_ralph_ralph-github__ralph_hero__decompose_feature
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

| Mode | Behavior |
|---|---|
| (default) | Interactive: intake → research → structure development → user review → write doc → post artifact |
| `--mode auto [#NNN]` | Autonomous: pick XS/S Ready-for-Plan issue → lock → write doc → advance to Plan in Review |
| `--mode epic [#NNN]` | Strategic: lock epic → write plan-of-plans → create feature children + dependency edges |
| `--mode iterate [#NNN \| <path>] [feedback]` | Surgical: read existing plan → confirm approach → apply targeted edits |
| `--mode review [#NNN]` | Critique: read plan → execute rubric → write critique doc → APPROVED / NEEDS_ITERATION |
| `--help` / `-h` | Print this table and exit |

## Step 0: Parse args

Set `MODE` ∈ `{default, auto, epic, iterate, review}` from `--mode` flag (default if absent). Capture `ARG` (remaining positional). Capture `--playwright` / `--no-playwright`. Bail with the mode table on `--help`.

**`--auto` alias** — resolve BEFORE `--loop` detection. See `ralph/skills/shared/auto-alias.md`:
- Conflict check (`--auto` + an explicit `--mode`): apply `auto-alias.md` § Conflict detection — emit its refusal text verbatim, then STOP. Not restated here; that file is the only copy.
- If `--auto` in `$ARGUMENTS` → strip `--auto` token, prepend `--mode auto` to `$ARGUMENTS` (verb=plan alias row). Continue to `--loop` detection with the rewritten args.

```bash
case "$ARGUMENTS" in
  --mode\ auto*)    export RALPH_SUBCOMMAND=auto ;;
  --mode\ epic*)    export RALPH_SUBCOMMAND=epic ;;
  --mode\ iterate*) export RALPH_SUBCOMMAND=iterate ;;
  --mode\ review*)  export RALPH_SUBCOMMAND=review ;;
  *)                export RALPH_SUBCOMMAND=default ;;
esac
```

**`--loop` gate** — run the arg-parsing snippet from `ralph/skills/shared/loop-wrapper.md` § Arg-parsing snippet (sets `LOOP_RAW`, `LOOP_INTERVAL`, `STRIPPED_ARGS`). If `LOOP_RAW` is set:
- MODE `auto` → `Skill("loop", …)` using the `plan:auto` manifest row + continuation-prompt template from `loop-wrapper.md`, then STOP.
- MODE `review` → `Skill("loop", …)` using the `plan:review` row, then STOP.
- MODE `default`, `iterate`, or `epic` → emit the refusal from `loop-wrapper.md` § Refusal message, then STOP.

Most modes need no env-flip — hooks discriminate by the file path being written. The `split-*` gates are the exception (MCP payloads + Stop carry no `file_path`), so they key on `RALPH_SUBCOMMAND` instead — see `decomposition.md` § Hook contract for the full discrimination rationale and the `epic-split` re-export.

## Default flow

1. **Intake** — resolve `ARG` per `intake-routing.md` (issue / research-doc / plan-path / free-form / no-arg). Read mentioned files FULLY before any sub-agent dispatch. Run parent-plan reuse check — if it short-circuits, post `## Plan Reference` and STOP.
2. **Research & discovery** — `knowledge_recall(role="planner", brief=true)` if available; dispatch codebase-locator / codebase-analyzer / thoughts-locator in parallel (one message, multiple `Agent()` calls). Wait for ALL, read identified files FULLY.
3. **Plan structure development** — propose phase count + ownership + verification points. `AskUserQuestion` to confirm. Loop until approved. Consult `plan-shapes.md` § Phase-section anatomy.
4. **Write the plan** — per `plan-shapes.md` (default-column required sections). Filename `thoughts/shared/plans/YYYY-MM-DD-[GH-NNNN-]description.md`. Stamp `estimate:` into the frontmatter from the fetched issue. If the linked-research check (Step 1) ended in "plan anyway", also stamp `research_waived:`. Author the `## Design Decisions & Open Ambiguities` section per `plan-shapes.md` § Design decisions anatomy (resolved decisions journaled; open judgment calls as `#### Decision:` blocks; sentinel when none).
4a. **UI Validation Phase (conditional)** — skip if `--no-playwright`. Else consult `ui-validation-phase.md`; append `## Phase N: UI Validation` if frontend-relevant + ralph-playwright installed.
5. **User review picker** — `AskUserQuestion` over *Approve* / *Approve with edits* / *Restart* / *Iterate*. `review-plan-gate.sh` hook enforces this picker runs before any state-advancing `save_issue`.
6. **GitHub integration** — if `LINKED_ISSUE`: post `## Implementation Plan` artifact comment with doc URL + 1-line summary; update issue body if scope clarified; `save_issue(workflowState: "Plan in Review", command: "plan")`. Human reviews the plan; a separate `--mode review` or manual approval advances to "In Progress".

## --mode auto

Autonomous XS/S plan picker. No questions; one issue, locked, planned, advanced. Frontmatter `hooks:` gate the flow (tier-validator, state-gate, postcondition, doc-validator, research-required, lock-release). XS/S only, 15-minute budget.

1. **Branch check** — `git branch --show-current` must be `main`.
2. **Select issue** — `ARG=#NNN` → `get_issue`; else `list_issues(profile: "analyst-plan", limit: 50)`, filter XS/S Ready-for-Plan + unblocked, pick highest priority. None eligible → exit cleanly. (XS/S no longer require linked research — the gate waives sub-threshold work.)
2a. **Sibling-group detection** — per `intake-routing.md` § Sibling-group planning. If the picked issue's parent has a plan-of-plans and ≥2 open unblocked Ready-for-Plan members exist (picked included), set `GROUP_MEMBERS` — the remaining steps then operate on EVERY member (lock all, ONE group plan doc, artifact comment + advance per member). Otherwise `GROUP_MEMBERS=[#NNN]` (single-issue flow, unchanged).
3. **Lock + research lookup** — `save_issue(workflowState: "__LOCK__", command: "plan")` for every member of `GROUP_MEMBERS`. Find linked research per `intake-routing.md` § Linked-research check (group: any member's research doc counts). If none AND the issue's estimate is ≥ `RALPH_RESEARCH_REQUIRED_MIN_ESTIMATE` (default `M`) → escalate to "Human Needed". Otherwise (sub-threshold XS/S) proceed; the `estimate:` stamp in Step 6 lets the gate waive research.
4. **Parent-plan reuse** — per `intake-routing.md` § Parent-plan reuse (matches parent plan-of-plans AND existing sibling group plans). **Skip this step when Step 2a set a multi-member `GROUP_MEMBERS`** — the group plan authored in Step 6 supersedes phase-matching, and a single-member short-circuit here would strand the other locked members. If short-circuit (single-issue flow only): post `## Plan Reference`, advance child to "In Progress", report, STOP.
5. **Knowledge graph + sub-agent research** — same dispatch as default Steps 2-3, no AskUserQuestion. Wait for ALL, synthesize.
5a. **UI Validation Phase (conditional)** — per `ui-validation-phase.md`. No user prompt; heuristic-only.
6. **Write plan doc** — per `plan-shapes.md` (auto-column required sections, including Files Affected; group: § Group plans — `github_issues:` frontmatter, one phase per member). **Tier routing (GH-1538):** for a single XS/S issue (no group), fork the authoring — `Agent(subagent_type="ralph:plan-agent", model="sonnet", prompt=<issue context + research synthesis + plan-shapes requirements>)` — and relay its plan doc; the session handles only intake/lock/state. For a GROUP or an M single, author inline (this session's `best` pin — fable where entitled — is the point: the feature plan is a judgment artifact). Stamp `estimate:` into the frontmatter from the fetched issue (group: the HIGHEST member estimate). The `plan-research-required.sh` hook blocks Write if no linked research AND the estimate is ≥ threshold (the `estimate:` stamp waives sub-threshold XS/S); `doc-structure-validator.sh` blocks Stop if required sections missing. Author the `## Design Decisions & Open Ambiguities` section per `plan-shapes.md` § Design decisions anatomy — unresolved judgment calls the planner cannot settle from research become `#### Decision:` blocks instead of silent assumptions or `__ESCALATE__` (escalation remains for the missing-research / conflicting-implementation triggers).
7. **Commit + push** — `git add ... && git commit -m "docs(plan): GH-NNN implementation plan" && git push origin main`.
8. **Post artifact + advance + outcome** — `create_comment(## Implementation Plan ...)` → `save_issue(workflowState: "__COMPLETE__", command: "plan")` (advances to "Plan in Review") → `knowledge_record_outcome(event_type: "plan_completed", ...)` if available. Group: comment + advance EVERY member.
9. **Report** — single block: *Plan complete for #NNN: [Title] / Plan: [path] / Status: Plan in Review*. Group: *Group plan complete for #A+#B+#C (parent #P): [Title] / Plan: [path] / Status: all members Plan in Review*.

**Escalation triggers (auto only):** advance to "Human Needed" when (a) no linked research exists AND the estimate is ≥ `RALPH_RESEARCH_REQUIRED_MIN_ESTIMATE` (default `M`; sub-threshold XS/S proceed without research), (b) issue is M/L/XL on research (suggest `--mode epic`), or (c) sub-agents surface conflicting implementations.

## --mode epic

The single decomposition surface (GH-1605): plan-of-plans (strategic, multi-feature) AND atomic split (one M/L/XL issue → XS/S siblings), discriminated by the epic's own shape rather than a separate flag. **`decomposition.md` is the contract** — path selection, doc shape, child payload, dependency wiring, and hook arming all live there; the sequence below is dispatch order only and deliberately restates none of it.

0. **Classify** — plan-of-plans vs atomic split, per `decomposition.md` § When epic-mode applies and § Atomic split § When to split (which carry the ambiguity tie-break).
1. **Lock epic** — `save_issue(workflowState: "__LOCK__", command: "plan")` on the epic.
2. **Context gathering** — epic body + comments + linked research; `codebase-locator` for affected areas, `thoughts-locator` for prior plans. Wait for ALL.

**Plan-of-plans path:**

3. **Write plan-of-plans** — per `decomposition.md` § Plan-of-plans shape (required sections listed there).
4. **Create feature children** — per `decomposition.md` § Child creation and § Dependency-edge rules.
5. **Update plan-of-plans** — annotate each `### Feature` with its assigned child number + URL.

**Atomic-split path** (re-export `RALPH_SUBCOMMAND=epic-split` per `decomposition.md` § Atomic split before Step 3'; rationale in § Hook contract):

3'. **Research scope + propose split** — per `decomposition.md` § Atomic split §§Step 1-5.
4'. **Create or update sub-issues** — per `decomposition.md` § Atomic split §Step 6.
5'. **Establish dependencies + write parent plan-of-plans** — per `decomposition.md` § Atomic split §§Step 7-7.5. That doc is a *different* artifact from Step 3's: it exists so the new children are autonomously plannable (GH-1416), not as a strategic decomposition of the parent.

6. **Commit + push** — `git add ... && git commit -m "docs(plan): GH-NNN plan-of-plans" && git push origin main`.
7. **Post artifact + advance** — plan-of-plans: `create_comment(## Plan of Plans ...)` on the epic, then `save_issue(workflowState: "Plan in Review", command: "plan")`. Atomic split: per `decomposition.md` § Atomic split §§Step 8-10 — parent stays in Backlog, child states via `batch_update`, and `RALPH_SPLIT_COUNT=<N>` is exported before Stop for `split-postcondition.sh`.
8. **Optional orchestration** (plan-of-plans only) — optionally dispatch `--mode auto` per child in dependency order. Not auto-cascading by default.
9. **Report** — plan-of-plans: *Plan-of-plans complete for #NNN: [Title] / Children: N created / Sequence: A → B → C*. Atomic split: terminal token per `decomposition.md` § Atomic split § Terminal tokens.

## --mode iterate

Surgical updates to an existing plan. No state transitions (the plan stays in whatever workflow state it was in). Consult `iteration.md`.

1. **Resolve plan** — `ARG=#NNN` → `get_issue` and follow the `## Implementation Plan` artifact comment. `ARG=<path>` → use directly. Read FULLY.
2. **Understand feedback** — `ARG` extra positional or prompt for it. Restate the change in one sentence.
3. **Confirm approach** — `AskUserQuestion`: *Apply as proposed* / *Adjust* / *Abort*. Loop on Adjust.
4. **Apply surgical edits** — prefer `Edit` over `Write` per `iteration.md` § Surgical-update principle. Preserve phase numbering; add follow-up sections rather than renumbering. Renumbering escape hatch: see `iteration.md` § Phase numbering preservation.
5. **Update issue** — post `## Plan Updated` comment summarizing what changed. Do NOT advance state. Do NOT call `save_issue` for workflow transitions in iterate mode (`state-gate.sh` validates transition legitimacy; iterate-mode workflow-body discipline keeps it out of the gate entirely).
6. **Report** — *Plan iterated for #NNN: [Title] / Plan: [path] / Changes: [1-line summary]*.

## --mode review

Critique an existing plan and emit APPROVED / NEEDS_ITERATION. Folds `ralph-review`. Consult `plan-review.md`.

Mode discrimination is path-based: the Stop chain's `plan-postcondition.sh` branches on which artifact this session wrote — a critique under `thoughts/shared/reviews/` selects the review-mode checks, a plan doc under `thoughts/shared/plans/` the plan-mode checks (session writes recorded by `artifact-write-tracker.sh`). No env-var propagation across Bash subshells required.

1. **Resolve plan + issue** — `ARG=#NNN` → `get_issue`; locate the `## Implementation Plan` artifact. `--plan-doc <path>` accepted as override.
2. **Validate plan exists** — if absent, escalate the issue to "Human Needed". STOP.
3. **Held-plan short-circuit (auto only)** — if `RALPH_REVIEW_PLAN=auto`, run the idempotency check BEFORE reading the plan or scoring anything (the auto tick re-fires review on every held plan every pass — this step keeps those ticks cheap): existing `## Decision Request` comment → emit `PLAN AWAITING DECISION` or fold a human reply, per `plan-review.md` § Interactive vs auto. Held with no answers → STOP here.
4. **Execute rubric + pick mode** — read plan FULLY, score against `plan-review.md` § Review rubric. Auto: dispatch a sub-agent for delegated critique. Else (interactive): decisions-first — one `AskUserQuestion` per open `#### Decision:` block (`Decision:`-prefixed headers, recommendation first), fold answers into the plan, then the confirm picker *Approve* / *Request changes* / *Open in editor* (see `plan-review.md` § Interactive vs auto).
5. **Write critique doc** — `thoughts/shared/reviews/YYYY-MM-DD-GH-NNNN-critique.md` per `plan-review.md` § Critique-doc structure (frontmatter includes `decisions_open: <n>`). `review-no-dup.sh` blocks if a critique already exists.
6. **Verdict + transition** — per `plan-review.md` § Transition rules: APPROVED decision-free → `save_issue(workflowState: "In Progress", command: "review")` (impl can pick it up). APPROVED with open decisions (auto) → NO transition; post one `## Decision Request` comment + best-effort `PushNotification`, stay in Plan in Review, emit `PLAN AWAITING DECISION`. NEEDS_ITERATION → `save_issue(workflowState: "Plan in Progress", command: "review")` + post critique as a comment on the issue with specific gap callouts. `state-gate.sh` is broad enough to accept these (its plan/plan_epic/review command keys union the valid sets from ralph-state-machine.json).
7. **Report** — *Plan reviewed for #NNN: [Title] / Verdict: APPROVED|NEEDS_ITERATION / Critique: [path]* — or the terminal line `PLAN AWAITING DECISION` for held plans.

## References

- `intake-routing.md` — issue / file-path / description detection + parent-plan reuse
- `plan-shapes.md` — frontmatter, section order, Phase template, per-mode required-sections matrix
- `decomposition.md` — epic → feature children, dependency-edge rules
- `iteration.md` — surgical-update principles + state preservation
- `plan-review.md` — review rubric + verdict shape + critique-doc structure
- `ui-validation-phase.md` — conditional Playwright UI Validation phase
