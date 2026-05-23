---
date: 2026-05-23
status: draft
type: plan
tags: [ralph, plugin-restructure, impl, pr, worktree, address-mode, migration, plan-of-plans]
github_issue: 1366
github_issues: [1366]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1366
primary_issue: 1366
---

# Plan 5: `/ralph:impl` — Impl Verb Implementation Plan

## Prior Work

- builds_on:: [[2026-05-22-ralph-slim-plugin-restructure]]
- builds_on:: [[2026-05-23-GH-1357-ralph-plan-1-catch-up]] — scaffold + flat-sibling pattern
- builds_on:: [[2026-05-23-GH-1359-ralph-plan-2-form]] — multi-surface fold heuristics
- builds_on:: [[2026-05-23-GH-1362-ralph-plan-3-research]] — SKILL.md frontmatter `hooks:` pattern + slim-plugin scope fixes
- builds_on:: [[2026-05-23-GH-1364-ralph-plan-4-plan]] — multi-mode fold (5 modes, 6 references) + path-discrimination hook pattern + multi-RALPH_COMMAND lesson

## Overview

The hot path. Three `ralph-hero` skills (`impl`, `ralph-impl`, `ralph-pr`) collapse into one `/ralph:impl` verb with four modes:

| Mode | Source | Role |
|---|---|---|
| (default) | `impl` | Interactive phase-by-phase implementation, paused between phases for human verification |
| `--mode auto [#NNN]` | `ralph-impl` | Autonomous ONE phase per invocation, hook-gated, then stops for resumability |
| `--mode address [#NNN]` | `ralph-impl` Address Mode | PR review feedback handling (MUST_FIX / SHOULD_FIX / DISCUSS) |
| `--mode pr [#NNN]` | `ralph-pr` | Push branch + create PR + scout-trigger heuristic + Drive push |

The four modes share substrate (worktree, plan-compliance, staging constraints) but have distinct workflow bodies. This plan honors Plan 4's friction note (cap references at ≤4-5 unless structurally distinct) by collapsing the four modes into **5 references** organized by axis-of-concern, not by mode.

Plan 4 established SKILL.md frontmatter `hooks:` and warned: *do NOT rely on env-var flipping across hook invocations*. Plan 5 inherits the constraint. The hook surface is the largest yet — nine new hook ports — but they all gate on `RALPH_COMMAND=impl` (or `RALPH_COMMAND=pr` for the pr-mode subset) set once at SessionStart, with per-mode behavior driven by tool-input shape (file paths, branch state) inside the hook scripts, not by mid-flow env mutation.

## Current State Analysis

Three source skills total **1,210 lines** of SKILL.md prose:

| Source | Lines | Shape |
|---|---|---|
| `plugin/ralph-hero/skills/impl/SKILL.md` | 264 | Interactive: parse arg → read plan → optional worktree suggestion → phase-by-phase with pauses → PR at end → AskUserQuestion next-step picker |
| `plugin/ralph-hero/skills/ralph-impl/SKILL.md` | 499 | Autonomous: pick issue → detect mode (normal vs Address) → fetch plan → build issue list → dependency-aware phase selection → worktree setup (single + cross-repo) → task graph + sub-agent controller loop → phase quality review → staged commit → push → STOP |
| `plugin/ralph-hero/skills/ralph-pr/SKILL.md` | 447 | PR creation: parse args → fetch issue → detect worktree → multi-repo detection → push branch → compose PR body (optional delegated summary) → create PR → advance to In Review → outcome event → Drive push → scout-trigger heuristic → post artifact comment |

Hooks to consider porting (under `plugin/ralph-hero/hooks/scripts/`):

| Hook | Trigger | Job | Port |
|---|---|---|---|
| `impl-plan-required.sh` | PreToolUse on Write/Edit | Block Write/Edit when no plan doc linked | yes |
| `impl-worktree-gate.sh` | PreToolUse on Write/Edit | Block writes outside the active worktree path | yes |
| `impl-state-gate.sh` | PreToolUse on `save_issue` | Validate impl workflow state transitions (In Progress / In Review / Human Needed) | yes |
| `impl-staging-gate.sh` | PreToolUse on Bash | Block `git add -A` / `git add .` / `git add --all` outside the phase ownership | yes |
| `impl-branch-gate.sh` | PreToolUse on Bash | Block destructive git ops on main; require feature/GH-NNN branch | yes |
| `drift-tracker.sh` | PostToolUse on Write/Edit | Log files written outside the plan's File Ownership table to `${TMPDIR}/ralph-drift-*.log` | yes |
| `impl-verify-commit.sh` | PostToolUse on Bash | Sanity-check `git commit` succeeded after Write/Edit batch | yes |
| `impl-postcondition.sh` | Stop | Verify either a phase advanced (checkbox added) OR `IMPL BLOCKED` verdict was emitted | yes |
| `pr-state-gate.sh` | PreToolUse on `save_issue` | Validate pr-mode transitions (only In Review / Human Needed allowed) | yes |
| `doc-structure-validator.sh` | Stop | Validate doc sections per command type | already ported in Plan 3; impl mode reuses with `RALPH_COMMAND=impl` no-op branch |
| `lock-release-on-failure.sh` | Stop | Release workflow lock on failure | already ported in Plan 3 |

Nine new hook ports + 2 reuses. With Plan 3's scope-fix pattern carried forward, each hook gates on `RALPH_COMMAND` / `RALPH_TICKET_ID` env vars and no-ops when they're unset.

### Key Discoveries

- **Four modes share two load-bearing concerns**: worktree isolation and plan compliance. Both are enforced by hooks (`impl-worktree-gate.sh`, `impl-plan-required.sh`, `impl-staging-gate.sh`), so the SKILL.md body can stay narrow — it describes the workflow, not the gate logic. Plan 4's friction note ("worktree + plan-compliance feel like the load-bearing references") is honored by promoting these to dedicated references.
- **The interactive default flow's Step 3.1 worktree suggestion is optional UX**, but auto-mode worktree setup is mandatory and richer (single + cross-repo + base-branch detection). Centralize into `worktree-setup.md` reference; default mode consults it for the suggestion, auto mode consults it for the full lifecycle.
- **`ralph-impl` Step 6.5–7.5 (task dependency graph + sub-agent controller + phase-quality review)** is the most procedurally distinct surface across source skills. It belongs in `phase-execution.md` so the SKILL.md body can stay at one numbered list per mode.
- **`ralph-impl` Step 6a (multi-repo worktree setup)** depends on `.ralph-repos.yml` registry shape. Preserve verbatim into `worktree-setup.md` — registry interface is stable per Plan 4's "schema stability" note.
- **`ralph-impl` Address Mode is structurally distinct from normal flow**: it inspects PR review comments instead of plan phases. Hooks differ too (no `impl-plan-required.sh` — address mode operates on an existing PR's diff). Promote to `--mode address` with its own reference, `address-mode.md`.
- **The IMPL BLOCKED tier-escalation token** (`IMPL BLOCKED model=<current> needs=opus reason=<short>`) is load-bearing — `impl-postcondition.sh` greps the transcript for it. Preserve the contract verbatim in `phase-execution.md` and the SKILL.md auto-mode body.
- **`ralph-pr` Step 5.0 (delegated PR summary)** is opt-in via `RALPH_DELEGATE_ENABLED`. Preserve as a section in `pr-creation.md`; the threshold gate (≥2 files OR ≥20 lines) and the shape-validation bash guards (byte length, first character) survive verbatim.
- **`ralph-pr` Step 6.8 (Scout Trigger heuristic)** is conservative-by-design — frontend globs only, advisory comment, never blocks PR creation. Move to `pr-creation.md` §Scout Trigger.
- **`ralph-pr` Step 6.7 (Drive push)** is opt-in via `--push-drive` / `RALPH_IOS_MODE`. Move to `pr-creation.md` §Drive push. Sub-skill responsibility lives in `scripts/lib/push-artifact.sh` — not duplicated here.
- **`ralph-impl` exposes a `--plan-doc` flag** as an artifact shortcut. Preserve in `--mode auto`'s arg parse so caller-driven plan-doc resolution (hero/team orchestrator) keeps working.
- **`ralph-impl` Step 7c BLOCKED escalation has a 3-retry budget per task** before escalating to Human Needed. Preserve in `phase-execution.md` Controller Pattern section.
- **`ralph-impl` Step 8 staging rule**: stage ONLY files listed in the plan's File Ownership Summary. `impl-staging-gate.sh` enforces by blocking `git add -A` / `git add .` / `git add --all` regex matches. The hook does NOT enforce the positive case (you still have to enumerate files); the skill body does that.
- **`ralph-impl` Step 9** stops after a single phase. The SKILL.md auto-mode body MUST end with an explicit STOP marker after the phase commit/push completes; calling `ralph-impl` again resumes from the next unchecked phase. Preserve verbatim.
- **Outcome recording (`knowledge_record_outcome`)** appears in `ralph-pr` Step 6.5. Preserve as a step in pr-mode body; the MCP call is already declared in `allowed-tools`.
- **The cross-repo PR creation path in `ralph-pr` Step 3a** creates one PR per repo and cross-references via PR body links. Preserve in `pr-creation.md` §Cross-repo.

## Desired End State

After Plan 5 merges:

1. `/ralph:impl` is discoverable. With no args → prompts for issue / file / plan-path.
2. `/ralph:impl #NNN` or `/ralph:impl <plan-path>` → default interactive flow with phase-by-phase pauses.
3. `/ralph:impl --mode auto [#NNN] [--plan-doc <path>]` → autonomous one-phase-per-invocation.
4. `/ralph:impl --mode address [#NNN]` → PR review feedback handling.
5. `/ralph:impl --mode pr [#NNN] [--push-drive | --no-push-drive]` → push branch + create PR.
6. Old `/ralph-hero:impl`, `/ralph-hero:ralph-impl`, `/ralph-hero:ralph-pr` remain functional. Sunset is Plan 10.
7. `ralph/skills/impl/SKILL.md` ≤ 200 lines (target ~190).
8. Five flat-sibling references: `worktree-setup.md`, `plan-compliance.md`, `phase-execution.md`, `address-mode.md`, `pr-creation.md`.
9. SKILL.md frontmatter `hooks:` block declares 9 impl/pr-specific hooks scoped via `RALPH_COMMAND`.
10. `ralph/README.md` migration table → Plan 5 shipped.
11. Friction-log entry appended to spec.

### Verification

- `/plugin marketplace update ralph-hero && /reload-plugins` discovers `/ralph:impl`.
- Four real invocations: default interactive, `--mode auto`, `--mode address`, `--mode pr`.
- `wc -l ralph/skills/impl/SKILL.md` ≤ 200.
- Five reference siblings present, each non-stub.
- Old `/ralph-hero:*` impl-family skills still work.

## What We're NOT Doing

- **Not** absorbing `ralph-merge` or `ralph-val`. Those are Plan 6 (`/ralph:review`).
- **Not** absorbing `ralph-code-review`. Also Plan 6.
- **Not** absorbing `finish`. Also Plan 6.
- **Not** changing the PR body template structure (`## Summary` / `## Plan` / `## Test plan` / `Closes #NNN`). Keeps Plan 10 sunset trivial.
- **Not** changing the worktree directory convention (`worktrees/GH-NNN`). Keeps `scripts/create-worktree.sh` reusable as-is.
- **Not** changing the IMPL BLOCKED tier-escalation token. Contract is hook-greppable.
- **Not** changing the cross-repo registry shape (`.ralph-repos.yml`).
- **Not** wiring `/ralph:impl` → `/ralph:review` dispatch. Orchestrator concern (`/ralph:hero` in Plan 8).
- **Not** sunsetting source skills.

## Implementation Approach

Seven XS-sized phases, mirroring Plan 4's phase shape:

1. **Scaffold + hook ports** owns: `ralph/skills/impl/SKILL.md` stub (frontmatter + mode-dispatch table + Step 0 arg parse), five empty reference stubs, hook ports under `ralph/hooks/scripts/` for the nine new scripts.
2. **Default flow — read + setup + phase loop** owns: SKILL.md default-mode body (Steps 1-4), `worktree-setup.md` (optional-suggestion section + reuse path), partial `plan-compliance.md`.
3. **Default flow — pause + PR offer + next-steps picker** owns: SKILL.md default-mode Steps 5-6, finish `plan-compliance.md`.
4. **`--mode auto` workflow body** owns: SKILL.md auto-mode body, `phase-execution.md` (task graph, controller pattern, phase-quality review, IMPL BLOCKED tier escalation).
5. **`--mode auto` worktree + multi-repo** owns: finish `worktree-setup.md` (single + cross-repo + base-branch detection + merge-conflict escalation).
6. **`--mode address` + `--mode pr`** owns: SKILL.md address-mode + pr-mode bodies, `address-mode.md`, `pr-creation.md`.
7. **Parity validation + dogfooding** owns: `ralph/README.md`, spec friction-log entry.

Only `ralph/skills/impl/SKILL.md` is touched in multiple phases — each appends a section. The reference files are single-owner except `worktree-setup.md` (Phase 2 starts, Phase 5 finishes) and `plan-compliance.md` (Phase 2 starts, Phase 3 finishes).

## Phase 1: Scaffold + hook ports

### Overview

Stand up directory + frontmatter + reference stubs + nine hook ports.

### Changes Required

#### 1. Skill scaffold

`ralph/skills/impl/SKILL.md`:

- Description (covers all 4 modes + natural-language trigger phrases — implement, code, build, ship, address feedback, create PR, push branch).
- `argument-hint: "[--mode auto|address|pr] [<issue-number|plan-path>] [--plan-doc <path>] [--push-drive|--no-push-drive]"`
- `context: inline`, `model: opus`
- `allowed-tools` union covering all four modes (Read, Write, Edit, Glob, Grep, Bash, Agent, Task, WebSearch, WebFetch, AskUserQuestion, plus the MCP tools used in any mode).
- `hooks:` block:
  - SessionStart → `set-skill-env.sh RALPH_COMMAND=impl` (no `RALPH_REQUIRED_BRANCH` at SessionStart; mode-specific workflow steps export it as needed).
  - PreToolUse on Write|Edit → `impl-plan-required.sh`, `impl-worktree-gate.sh`
  - PreToolUse on `save_issue` → `impl-state-gate.sh`, `pr-state-gate.sh` (pr-state-gate self-gates on tool-input target state — only fires when transitioning to In Review)
  - PreToolUse on Bash → `impl-staging-gate.sh`, `impl-branch-gate.sh`
  - PostToolUse on Write|Edit → `drift-tracker.sh`
  - PostToolUse on Bash → `impl-verify-commit.sh`
  - Stop → `impl-postcondition.sh`, `lock-release-on-failure.sh`, `doc-structure-validator.sh`
- Body: mode-dispatch table + Step 0 (arg parse).

#### 2. Reference stubs

- `worktree-setup.md`, `plan-compliance.md`, `phase-execution.md`, `address-mode.md`, `pr-creation.md` — `_Filled by Phase N._`

#### 3. Hook ports

Copy from `plugin/ralph-hero/hooks/scripts/`:
- `impl-plan-required.sh`, `impl-worktree-gate.sh`, `impl-state-gate.sh`, `impl-staging-gate.sh`, `impl-branch-gate.sh`
- `drift-tracker.sh`, `impl-verify-commit.sh`, `impl-postcondition.sh`
- `pr-state-gate.sh`

Apply Plan 3's scope-fix pattern: each script gates on `RALPH_COMMAND` / `RALPH_TICKET_ID` env vars and no-ops when they're unset. For `pr-state-gate.sh`, additionally gate on tool-input target state — only fire when the `save_issue` call sets `workflowState=In Review`.

### Success Criteria

#### Automated Verification

- [x] `test -f ralph/skills/impl/SKILL.md`
- [x] `[ "$(wc -l < ralph/skills/impl/SKILL.md)" -le 200 ]`
- [x] All five references present.
- [x] All nine new hooks present + executable.

#### Manual Verification

- [ ] `/reload-plugins` discovers `/ralph:impl --help`.

---

## Phase 2: Default flow — read + setup + phase loop

### Overview

Default-mode body Steps 1-4 + `worktree-setup.md` (suggestion section) + partial `plan-compliance.md`.

### Changes Required

#### 1. SKILL.md default-mode Steps 1-4

- **Step 1: Parse argument** — resolve `#NNN` / plan-path / no-arg. For `#NNN`, fetch issue, search comments for `## Implementation Plan`, fall back to glob. For plan-path, verify file exists + read frontmatter for linked issue.
- **Step 2: Read plan** — read fully (no offset/limit), detect resumption via existing checkmarks, identify first unchecked phase.
- **Step 3: Setup** — optional worktree suggestion per `worktree-setup.md` §Suggestion. Transition issue to "In Progress". Post `## Implementation Started` comment.
- **Step 4: Implement phase by phase** — per phase: read requirements, implement changes, run automated verification, update checkboxes for automated items only, pause for human verification (AskUserQuestion), handle mismatches via STOP-and-think pattern. Manual checkboxes confirmed only by user.

#### 2. `worktree-setup.md` (partial — suggestion + reuse)

- §Suggestion: optional UX for default mode. Bash snippet for `scripts/create-worktree.sh GH-NNN`.
- §Reuse path: detect existing worktree at `worktrees/GH-NNN`, `git pull origin <branch> --no-edit`. Escalation on merge conflict.

#### 3. `plan-compliance.md` (partial — file-ownership + drift)

- §File Ownership: the plan's File Ownership Summary table is the source of truth. Workflow body stages exactly those files; `impl-staging-gate.sh` enforces no `git add -A` / `git add .` / `git add --all`.
- §Drift Log: when an unexpected file appears (not in this phase's ownership), warn and skip — do not stage. `drift-tracker.sh` logs to `${TMPDIR}/ralph-drift-*.log`.

### Success Criteria

#### Automated Verification

- [x] `[ "$(wc -l < ralph/skills/impl/SKILL.md)" -le 200 ]`
- [x] `worktree-setup.md` non-stub: `[ "$(wc -l < ralph/skills/impl/worktree-setup.md)" -ge 40 ]`
- [x] `plan-compliance.md` non-stub: `[ "$(wc -l < ralph/skills/impl/plan-compliance.md)" -ge 40 ]`

#### Manual Verification

- [ ] `/ralph:impl #NNN` against a real Ready-for-Plan issue: reads plan, surfaces phase requirements, pauses after Phase 1's automated verification.

---

## Phase 3: Default flow — pause + PR offer + next-steps picker

### Overview

Default-mode body Steps 5-6 + finish `plan-compliance.md`.

### Changes Required

#### 1. SKILL.md default-mode Steps 5-6

- **Step 5: Complete** — when all phases verified: create PR (delegate to `--mode pr` internally via the pr-mode body section, or run `gh pr create` inline for simple cases), transition issue to "In Review", post `## Implementation Complete` comment.
- **Step 6: Next steps picker** — `AskUserQuestion` with 4 options (Run finish / Create PR only / Iterate on plan / Done for now). Dispatch accordingly. For "Run finish" → `Skill("ralph-hero:finish", args="NNN")` until Plan 6 ships `/ralph:review`; then update to `Skill("ralph:review", args="NNN")`.

#### 2. Finish `plan-compliance.md`

- §Staging Algorithm: `git status --porcelain` → diff against File Ownership table → `git add <file1> <file2>` (specific files only) → commit + push.
- §Multi-repo Commits: when changes span multiple repos, commit and push separately in each worktree; never `git add -A`/`.`/`--all`.
- §Mismatch Handling: STOP-and-think pattern when reality doesn't match plan. Surface the gap to the user with Expected/Found/Why-this-matters format.

### Success Criteria

#### Automated Verification

- [ ] `plan-compliance.md` ≥ 80 lines.

#### Manual Verification

- [ ] `/ralph:impl #NNN` ships a PR when all phases pass.
- [ ] Next-steps picker shows; each option dispatches correctly.

---

## Phase 4: `--mode auto` workflow body + phase-execution.md

### Overview

Autonomous one-phase-per-invocation flow. Folds `ralph-impl` Steps 1-11.

### Changes Required

#### 1. SKILL.md auto-mode body

Compact list — Plan 3-style:

1. **Select target** — issue number provided OR `list_issues(profile: "builder-active", limit: 1)` highest priority.
2. **Detect mode** — fetch issue; if `workflowState == "In Review"` AND open PR exists with review comments → delegate to `--mode address`.
3. **Read plan** — Artifact Comment Protocol with knowledge_recall shortcut. STOP with "Issue #NNN has no implementation plan" if neither `## Implementation Plan` nor `## Plan Reference` found.
4. **Build issues[] + detect phase** — frontmatter `github_issues` array or single `github_issue`. Find first unblocked unchecked phase (dependency-aware via `depends_on` annotations).
5. **Verify readiness + lock** — all issues in `issues[]` must be "In Progress" (lock via `workflowState="__LOCK__"`, command="ralph_impl"); STOP otherwise.
6. **Setup worktree** — consult `worktree-setup.md` §Auto-mode for single + cross-repo + base-branch detection + rebase-onto-main if predecessor merged.
7. **Execute phase** — consult `phase-execution.md` for task graph, controller pattern, IMPL BLOCKED escalation, phase quality review.
8. **Stage + commit + push** — consult `plan-compliance.md` §Staging Algorithm.
9. **Check completion** — re-read plan; if all phases checked → continue to Step 10, else STOP with `Phase [N]/[M] complete.`.
10. **Final report** — output issue list + branch + worktree.

#### 2. `phase-execution.md`

- §Task graph: parse phase's `### Tasks` section for `#### Task N.M:` blocks; extract files, tdd, complexity, depends_on, acceptance; build dependency graph; identify parallel groups.
- §Controller pattern: dispatch implementer sub-agent (model from complexity), handle status (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED), max 3 retries.
- §IMPL BLOCKED escalation: when sub-agent budget exhausted AND dispatching model is not opus, emit `IMPL BLOCKED model=<current> needs=opus reason=<short>` and STOP — do NOT escalate to Human Needed in this path. Hero re-dispatches once with `model="opus"`. If already opus, fall through to escalate.
- §Phase quality review: `git diff [phase-start]..HEAD` → dispatch reviewer sub-agent (opus) → APPROVED / NEEDS_FIXES; if NEEDS_FIXES, dispatch fixer; post `## Phase N Review` + `## Drift Log — Phase N` comments on issue.
- §Legacy plan fallback: if no `### Tasks` section, fall back to monolithic implementation (read phase requirements, implement directly without sub-agent dispatch).

#### 3. Frontmatter hooks already declared in Phase 1.

### Success Criteria

#### Automated Verification

- [ ] `phase-execution.md` ≥ 80 lines.
- [ ] SKILL.md auto-mode body references `__LOCK__`, `IMPL BLOCKED`, "In Progress", "Phase [N]/[M] complete".

#### Manual Verification

- [ ] `/ralph:impl --mode auto` against a real "In Progress" XS issue: locks → executes one phase → commits + pushes → STOPs with phase-N-of-M marker. Hooks fire correctly.

---

## Phase 5: `--mode auto` worktree + multi-repo

### Overview

Finish `worktree-setup.md` with the auto-mode lifecycle.

### Changes Required

#### 1. Finish `worktree-setup.md`

- §Auto-mode lifecycle: detect epic membership (parent estimate in M/L/XL) → choose WORKTREE_ID (stream / epic / group / single) → base-branch detection from plan frontmatter or task description → create-or-reuse → rebase-onto-main if predecessor merged.
- §Cross-repo (multi-worktree): read `.ralph-repos.yml`, create worktrees per repo, set `RALPH_WORKTREE_PATHS` env var (colon-separated absolute paths), pass mapping to builder sub-agents.
- §Tilde expansion: `localDir` values in the registry may use `~`; always expand to absolute paths before setting `RALPH_WORKTREE_PATHS` — the hook compares against `file_path` which is always absolute.
- §Escalation on merge conflict: when `git pull` fails, set `workflowState="__ESCALATE__"`, comment with conflicted files list, STOP.

#### 2. SKILL.md auto-mode body — no changes (Phase 4 stub references `worktree-setup.md §Auto-mode` already).

### Success Criteria

#### Automated Verification

- [ ] `worktree-setup.md` ≥ 100 lines (suggestion + reuse + auto-mode + cross-repo + tilde + escalation).
- [ ] SKILL.md references `worktree-setup.md` from default-mode (suggestion) and auto-mode (full lifecycle).

#### Manual Verification

- [ ] `/ralph:impl --mode auto` against a single-repo issue: creates worktree correctly, uses feature/GH-NNN branch.
- [ ] `/ralph:impl --mode auto` against a cross-repo issue: creates worktrees in each repo, exports `RALPH_WORKTREE_PATHS` correctly.

---

## Phase 6: `--mode address` + `--mode pr`

### Overview

The two short modes that don't follow the plan-phase lifecycle.

### Changes Required

#### 1. SKILL.md address-mode body

1. Detect: invoked directly OR auto-mode delegated. Issue must be "In Review" with an open PR.
2. Gather feedback: `gh pr view [number] --json reviews,comments` + `gh api repos/$RALPH_GH_OWNER/$RALPH_GH_REPO/pulls/[number]/comments`. Skip resolved/outdated.
3. Classify each comment: MUST_FIX / SHOULD_FIX / DISCUSS per `address-mode.md` §Classification.
4. Reuse worktree: `cd $GIT_ROOT/worktrees/GH-NNN && git pull origin <branch>`.
5. Address items grouped by file: read, fix, verify (lint/tests). DISCUSS items get reply-only.
6. Stage only modified files (PR's existing file list as constraint) + new files explicitly requested. NEVER `git add -A`/`.`/`--all`.
7. Commit + push.
8. Reply to PR comments: each addressed item with change + commit ref; DISCUSS items with rationale. Post summary comment.
9. Report MUST_FIX/SHOULD_FIX/DISCUSS counts. Issue stays "In Review".

#### 2. SKILL.md pr-mode body

1. **Parse args** — `#NNN` provided OR queue-pick. Queue-pick: `list_issues(workflowState: "In Progress", limit: 10)`; for each candidate, check `worktrees/GH-NNN` exists AND no open PR for the branch. STOP with literal `Queue empty.` if none match.
2. **Fetch issue + determine worktree + branch** — `feature/GH-NNN`.
3. **Multi-repo PR detection** — per `pr-creation.md` §Cross-repo if multiple worktrees exist for the issue.
4. **Push branch** — `git push -u origin feature/GH-NNN`.
5. **Compose PR body** — `## Summary` (optional delegation per `pr-creation.md` §Delegated Summary) + `## Plan` (link to plan doc) + `## Test plan` (from Success Criteria sections) + `Closes #NNN` (one per sub-issue for groups).
6. **Create PR** — `gh pr create --title "GH-NNN: <title>" --body-file <body> --head feature/GH-NNN --base main`. Capture URL.
7. **Move issues to In Review** — standalone: own state to "In Review"; group: every child via `save_issue`. Do NOT advance parent (server-side advance-parent workflow handles it).
8. **Record outcome event** — `knowledge_record_outcome(event_type="pr_created", issue_number=NNN, verdict="created", payload={pr_url, branch, repo})`.
9. **Drive push (optional)** — per `pr-creation.md` §Drive push when `--push-drive` or `RALPH_IOS_MODE`. Append `Drive: <URL>` line to artifact comment if non-empty.
10. **Evaluate UI-touching heuristic** — per `pr-creation.md` §Scout Trigger. Post `## Scout Trigger` comment with `/scout` body if any frontend glob matches.
11. **Post artifact comment** on issue: `## Pull Request` + PR URL + (optional) `Drive:` line.
12. **Report** — `PR CREATED / Issue: #NNN / PR: <url> / State: In Review`.

#### 3. `address-mode.md`

- §Classification: MUST_FIX (explicit change requests), SHOULD_FIX (quality improvements), DISCUSS (reply only).
- §Comment threading: GitHub thread anchors via `gh api ... /comments` for inline-comment context; thread anchor preserved in commit messages so reviewers can trace.
- §Address commit shape: `fix: address PR review feedback` heading + bullet list of changes.

#### 4. `pr-creation.md`

- §Delegated Summary: threshold gate (≥2 files OR ≥20 lines), wrapper invocation via `$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh`, shape-validation guards (byte length, first character), fallback to native one-liner.
- §Body template: `## Summary` + `## Plan` (link to plan doc) + `## Test plan` (from Success Criteria) + `Closes #NNN`.
- §Cross-repo: one PR per repo, cross-reference via PR body links per registry `dependency-flow`.
- §Drive push: `--push-drive` / `--no-push-drive` flag parsing, `$CLAUDE_PLUGIN_ROOT/scripts/lib/push-artifact.sh` invocation, `Drive: <URL>` line in artifact comment.
- §Scout Trigger: frontend globs (`**/*.tsx`, `**/*.svelte`, `**/*.vue`, `**/components/**`, `**/*.css`, `**/*.scss`, `**/storybook/**`), `## Scout Trigger` comment with `/scout` body, conservative-by-design (false-positive cost > false-negative cost).

### Success Criteria

#### Automated Verification

- [ ] `address-mode.md` ≥ 50 lines.
- [ ] `pr-creation.md` ≥ 100 lines.
- [ ] SKILL.md pr-mode body references `Queue empty.` literal.
- [ ] SKILL.md address-mode body references MUST_FIX / SHOULD_FIX / DISCUSS.

#### Manual Verification

- [ ] `/ralph:impl --mode address #NNN` on a real PR with review comments: classifies, fixes MUST_FIX items, replies to all.
- [ ] `/ralph:impl --mode pr #NNN` on a real "In Progress" issue with a worktree: pushes branch, creates PR, advances to "In Review", posts artifact comment.

---

## Phase 7: Parity validation + dogfooding setup

### Overview

README + friction-log + 4-session parity validation.

### Changes Required

#### 1. README

- `| 5 | \`/ralph:impl\` | shipped |`
- `## Status` paragraph updated.

#### 2. Friction-log on the spec

Append `### Plan 5: /ralph:impl (shipped YYYY-MM-DD)` subsection. Capture: hot-path stats (3 sources, 4 modes, 5 references, 9+2 hooks); design calls; active-use checkboxes.

#### 3. Parity validation runs

1. `/ralph:impl #NNN` → default interactive (against a real Ready-for-Plan or In Progress XS issue).
2. `/ralph:impl --mode auto` → autonomous one-phase-per-invocation.
3. `/ralph:impl --mode address #NNN` → PR review feedback.
4. `/ralph:impl --mode pr #NNN` → PR creation.

### Success Criteria

#### Automated Verification

- [ ] README shows Plan 5 shipped.
- [ ] Friction-log section exists.

#### Manual Verification

- [ ] Four sessions completed successfully.
- [ ] No regressions in any `ralph-hero:*` impl-family skill.

---

## Testing Strategy

### Unit Tests

None — markdown workflow. MCP tools covered by ralph-hero MCP server's existing tests. Hooks are bash scripts; coverage continues via the existing hook-gate snapshot tests (Plan 3 pattern).

### Integration Tests

The 4 parity sessions in Phase 7 are the integration test. Auto-mode session exercises all 9 hooks end-to-end. PR-mode session exercises the scout-trigger heuristic + outcome recording.

### Manual Testing Steps

Per Phase 7's list, plus:

1. Verify auto-mode lock-release path: simulate mid-phase failure (kill `git push`); confirm issue does NOT regress past "In Progress" (lock-release-on-failure.sh fires).
2. Verify worktree-gate hook: attempt Write to a path OUTSIDE the active worktree; confirm hook blocks with exit 2.
3. Verify staging-gate hook: attempt `git add -A` from within the workflow; confirm hook blocks.
4. Verify IMPL BLOCKED tier escalation: simulate sub-agent exhaustion at sonnet; confirm the JSONL transcript contains `IMPL BLOCKED model=sonnet needs=opus` and the issue stays "In Progress".
5. Verify pr-mode queue-pick: invoke `--mode pr` with no args when no eligible issue exists; confirm literal `Queue empty.` output.
6. Verify scout-trigger heuristic: PR with only backend files → no comment; PR with `.tsx` change → `## Scout Trigger` comment posted.

## Performance Considerations

- Default flow: 1 issue fetch + 1 plan read + N phase iterations (each: Read+Write+Bash). Mirrors source `impl`.
- Auto flow: 1 issue list + 1-2 issue fetches + 1 plan read + 1 phase execution (M sub-agent dispatches for M tasks) + 1 staged commit + 1 push. 15-minute budget per invocation.
- Address flow: 1 PR fetch + N comment classifications + M fix iterations + 1 staged commit + 1 push + N reply posts. Latency scales with comment count.
- PR flow: 1 issue fetch + (optional) `.ralph-repos.yml` read + 1 push + 1 `gh pr create` + 1-3 `save_issue` + 1 outcome record + 1 scout-trigger eval. Fast path.

## Migration Notes

- Source skills remain functional alongside the new verb until Plan 10 batches sunsets.
- Plan 6 (`/ralph:review`) absorbs `ralph-code-review`, `ralph-val`, `ralph-merge`, `finish` — the close-the-loop verbs. Plan 5's default-mode Step 6 picker currently dispatches `Skill("ralph-hero:finish", args="NNN")`; when Plan 6 ships, the picker updates to `Skill("ralph:review", args="NNN")`. This is a one-line edit, tracked as a Phase 7 follow-up.
- Plan 8 (`/ralph:hero`) is the orchestrator that dispatches `/ralph:impl --mode auto` automatically. Plan 5 preserves the `--plan-doc` flag so the orchestrator's existing dispatch pattern keeps working.
- Worktree directory convention (`worktrees/GH-NNN`) is preserved — `scripts/create-worktree.sh` lives at the repo root and is reused as-is by both old and new plugins.

## References

- Spec: `thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md` (plan-of-plans row 5 at line ~340).
- Plan 4: `thoughts/shared/plans/2026-05-23-GH-1364-ralph-plan-4-plan.md` (path-discrimination hook pattern + multi-RALPH_COMMAND lesson).
- Plan 3: `thoughts/shared/plans/2026-05-23-GH-1362-ralph-plan-3-research.md` (SKILL.md `hooks:` pattern + slim-plugin hook scope fixes).
- Source skills:
  - `plugin/ralph-hero/skills/impl/SKILL.md` (264)
  - `plugin/ralph-hero/skills/ralph-impl/SKILL.md` (499)
  - `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (447)
- Source hook scripts under `plugin/ralph-hero/hooks/scripts/`: `impl-plan-required.sh`, `impl-worktree-gate.sh`, `impl-state-gate.sh`, `impl-staging-gate.sh`, `impl-branch-gate.sh`, `drift-tracker.sh`, `impl-verify-commit.sh`, `impl-postcondition.sh`, `pr-state-gate.sh`.
- ralph plugin state at Plan 5 start: `ralph/skills/{catch-up,form,research,plan}/` (Plan 4 hooks declared in SKILL.md frontmatter; same pattern reused here).
