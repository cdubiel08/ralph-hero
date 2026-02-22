---
date: 2026-02-22
status: draft
github_issues: [343, 344, 345, 346, 347, 348]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/343
  - https://github.com/cdubiel08/ralph-hero/issues/344
  - https://github.com/cdubiel08/ralph-hero/issues/345
  - https://github.com/cdubiel08/ralph-hero/issues/346
  - https://github.com/cdubiel08/ralph-hero/issues/347
  - https://github.com/cdubiel08/ralph-hero/issues/348
primary_issue: 343
---

# Port Interactive Skills to Ralph-Hero Plugin - Atomic Implementation Plan

## Overview

6 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-343 | Add `draft-idea` interactive skill | XS |
| 2 | GH-344 | Add `form-idea` interactive skill | S |
| 3 | GH-345 | Add `research-codebase` interactive skill | S |
| 4 | GH-346 | Add `create-plan` interactive skill | S |
| 5 | GH-347 | Add `iterate-plan` interactive skill | S |
| 6 | GH-348 | Add `implement-plan` interactive skill | S |

**Why grouped**: All 6 are ports of workspace-level interactive commands (`~/projects/.claude/commands/`) into the ralph-hero plugin as skills. They share identical frontmatter conventions, the same interactive (non-forked) execution model, and the same set of Linear-to-GitHub adaptations. Implementing them together ensures consistency.

## Current State Analysis

### Source Commands
Six mature workspace-level commands exist at `~/projects/.claude/commands/`:
- `draft_idea.md` — Quick idea capture, saves to `thoughts/shared/ideas/`
- `form_idea.md` — Crystallize ideas into tickets/plans/research topics
- `research_codebase.md` — Interactive codebase research with parallel sub-agents
- `create_plan.md` — Interactive implementation planning (491 lines, most substantial)
- `iterate_plan.md` — Update existing plans based on feedback
- `implement_plan.md` — Execute approved plans phase by phase with human verification

All use Linear MCP tools (`mcp__plugin_linear_linear__*`) and `LAN-NNN` ticket IDs.

### Target Location
`plugin/ralph-hero/skills/` — No interactive skills exist yet. All 12 existing skills are autonomous (`ralph-*`) and use `context: fork`, hooks, and `RALPH_COMMAND` env vars.

### Key Architectural Difference: Interactive vs Autonomous

| Aspect | Autonomous Skills | Interactive Skills (new) |
|--------|-------------------|--------------------------|
| `context` | `fork` | Omitted (inline conversation) |
| Hooks | PreToolUse, PostToolUse, Stop | None |
| `RALPH_COMMAND` env | Required (state gates) | Omitted |
| User interaction | None | Full collaborative workflow |
| State transitions | Automatic (`__LOCK__`/`__COMPLETE__`) | Optional, user-triggered |

## Desired End State

Six new skill directories, each containing a single `SKILL.md`:
```
plugin/ralph-hero/skills/
  draft-idea/SKILL.md
  form-idea/SKILL.md
  research-codebase/SKILL.md
  create-plan/SKILL.md
  iterate-plan/SKILL.md
  implement-plan/SKILL.md
```

### Verification
- [ ] All 6 skills appear in `/` autocomplete as `/ralph-hero:<skill-name>`
- [ ] Each skill runs inline (not forked) — user can interact conversationally
- [ ] No hooks fire for any interactive skill
- [ ] `draft-idea` saves files to `thoughts/shared/ideas/`
- [ ] `form-idea` creates GitHub issues via `ralph_hero__create_issue`
- [ ] `research-codebase` saves to `thoughts/shared/research/` with correct `GH-NNNN` naming
- [ ] `create-plan` saves to `thoughts/shared/plans/` with `github_issues`/`primary_issue` frontmatter
- [ ] `iterate-plan` discovers plans via Artifact Comment Protocol (`## Implementation Plan` header)
- [ ] `implement-plan` discovers plans, suggests worktree setup, pauses for human verification between phases

## What We're NOT Doing

- Not modifying any existing autonomous skills (`ralph-*`)
- Not adding hooks for interactive skills (they are human-guided, not automation-guarded)
- Not adding `context: fork` (interactive skills need inline conversation)
- Not modifying the MCP server (all required tools already exist)
- Not creating a `validate-plan` skill (not in scope for this group)
- Not updating `README.md` or `conventions.md` (Phase 2 of the port plan; separate PR)

## Implementation Approach

Each phase creates one `SKILL.md` file by adapting the corresponding source command. The adaptations are mechanical and consistent across all 6:

### Common Adaptations (apply to all phases)

**Tool substitutions:**
| Linear | GitHub |
|--------|--------|
| `mcp__plugin_linear_linear__create_issue` | `ralph_hero__create_issue` |
| `mcp__plugin_linear_linear__get_issue` | `ralph_hero__get_issue` |
| `mcp__plugin_linear_linear__list_issues` | `ralph_hero__list_issues` |
| `mcp__plugin_linear_linear__update_issue` | `ralph_hero__update_workflow_state` |
| `mcp__plugin_linear_linear__create_comment` | `ralph_hero__create_comment` |

**Naming conventions:**
| Source | Target |
|--------|--------|
| `LAN-XXX` ticket IDs | `GH-NNNN` / `#NNN` issue refs |
| `linear_ticket: LAN-XXX` frontmatter | `github_issue: NNN` |
| `linear_url: ...` frontmatter | `github_url: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN` |
| `landcrawler-ai/thoughts/shared/` paths | `thoughts/shared/` paths |

**Agent substitutions:**
| Source | Target |
|--------|--------|
| `linear-locator` agent | `ralph_hero__list_issues(query=...)` inline call |
| `github-repo-manager` agent | `ralph_hero__get_issue` directly |
| `thoughts-analyzer` agent | `ralph-hero:thoughts-locator` (main context synthesizes) |
| `codebase-locator` agent | `ralph-hero:codebase-locator` |
| `codebase-analyzer` agent | `ralph-hero:codebase-analyzer` |
| `codebase-pattern-finder` agent | `ralph-hero:codebase-pattern-finder` |

**Next-step references:**
| Source | Target |
|--------|--------|
| `/form_idea` | `/ralph-hero:form-idea` |
| `/research_codebase` | `/ralph-hero:research-codebase` |
| `/create_plan` | `/ralph-hero:create-plan` |
| `/iterate_plan` | `/ralph-hero:iterate-plan` |
| `/implement_plan` | `/ralph-hero:implement-plan` |
| `/draft_idea` | `/ralph-hero:draft-idea` |

**Sub-agent team isolation:** All `Task()` calls within skills must NOT pass `team_name` (per ADR-001 in `shared/conventions.md`).

### Common Frontmatter Template

Skills needing GitHub tools (Phases 2-6) use:
```yaml
---
description: [user-facing description]
argument-hint: "[optional args]"
model: opus
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - WebSearch
  - WebFetch
env:
  RALPH_GH_OWNER: "${RALPH_GH_OWNER}"
  RALPH_GH_REPO: "${RALPH_GH_REPO}"
  RALPH_GH_PROJECT_NUMBER: "${RALPH_GH_PROJECT_NUMBER}"
---
```

Phase 1 (`draft-idea`) is simpler: `model: sonnet`, no `allowed_tools`, no `env` (no GitHub integration needed).

---

## Phase 1: Add `draft-idea` Interactive Skill (GH-343)
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/343 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0343-draft-idea-interactive-skill.md

### Changes Required

#### 1. Create `plugin/ralph-hero/skills/draft-idea/SKILL.md`
**File**: `plugin/ralph-hero/skills/draft-idea/SKILL.md` (new file)
**Changes**: Create the simplest interactive skill. Direct port of `~/projects/.claude/commands/draft_idea.md` with these specific adaptations:

**Frontmatter**:
```yaml
---
description: Quickly capture an idea or thought for later refinement. Runs inline, asks 2-3 clarifying questions, saves to thoughts/shared/ideas/. Suggest /ralph-hero:form-idea as next step.
argument-hint: "[optional: topic or idea to capture]"
model: sonnet
---
```

No `allowed_tools`, no `env`, no `context: fork`, no hooks. Model is `sonnet` (speed over depth).

**Body adaptations**:
- Save path: `landcrawler-ai/thoughts/shared/ideas/YYYY-MM-DD-description.md` → `thoughts/shared/ideas/YYYY-MM-DD-description.md`
- Idea file frontmatter: replace `linear_ticket: null` with `github_issue: null`
- Next-step suggestions: `/form_idea` → `/ralph-hero:form-idea`, `/research_codebase` → `/ralph-hero:research-codebase`, `/create_plan` → `/ralph-hero:create-plan`
- Sub-agent reference: `codebase-locator` → `ralph-hero:codebase-locator`
- Remove "No Linear integration" guideline; replace with "No GitHub integration — ideas are pre-ticket"

**Workflow** (4 steps, preserved from source):
1. Quick clarification — 2-3 focused questions
2. Optional light research — one `ralph-hero:codebase-locator` search if idea touches existing code
3. Write draft — save to `thoughts/shared/ideas/YYYY-MM-DD-<description>.md` with template
4. Confirm and suggest next steps

### Success Criteria
- [x] Automated: `ls plugin/ralph-hero/skills/draft-idea/SKILL.md` exists
- [x] Automated: File contains no `context: fork`, no `RALPH_COMMAND`, no hooks
- [x] Automated: File contains no `LAN-` or `linear` references
- [ ] Manual: Skill appears as `/ralph-hero:draft-idea` in autocomplete
- [ ] Manual: Runs inline (user can interact), saves file to `thoughts/shared/ideas/`

**Creates for next phase**: Establishes the interactive skill directory pattern (no `context: fork`, no hooks). Subsequent phases follow the same structure with increasing complexity.

---

## Phase 2: Add `form-idea` Interactive Skill (GH-344)
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/344 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0344-form-idea-interactive-skill.md | **Depends on**: Phase 1 (pattern)

### Changes Required

#### 1. Create `plugin/ralph-hero/skills/form-idea/SKILL.md`
**File**: `plugin/ralph-hero/skills/form-idea/SKILL.md` (new file)
**Changes**: Port of `~/projects/.claude/commands/form_idea.md`. This is the first skill that uses GitHub MCP tools.

**Frontmatter**:
```yaml
---
description: Crystallize draft ideas into structured GitHub issues, implementation plans, or research topics. Reads idea files, researches codebase context, finds duplicates, and creates well-scoped tickets.
argument-hint: "<idea-path-or-description>"
model: opus
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - WebSearch
  - WebFetch
env:
  RALPH_GH_OWNER: "${RALPH_GH_OWNER}"
  RALPH_GH_REPO: "${RALPH_GH_REPO}"
  RALPH_GH_PROJECT_NUMBER: "${RALPH_GH_PROJECT_NUMBER}"
---
```

**Body adaptations**:
- Save/read paths: `landcrawler-ai/thoughts/shared/ideas/` → `thoughts/shared/ideas/`
- Step 2 research: Replace `linear-locator` agent with inline `ralph_hero__list_issues(query=...)` for duplicate search
- Step 5a (Create ticket): Replace `mcp__plugin_linear_linear__create_issue` with `ralph_hero__create_issue(title, body)`. After creation, use `ralph_hero__update_estimate(number, estimate="XS")` (string format, not integer)
- Step 5b (Ticket tree): Use `ralph_hero__create_issue` + `ralph_hero__add_sub_issue(parentNumber, childNumber)` + `ralph_hero__update_estimate(number, estimate)` + `ralph_hero__add_dependency(blockedNumber, blockingNumber)` for ordering
- Idea file frontmatter update: `linear_ticket: LAN-XXX` → `github_issue: NNN`, `status: formed`
- Estimate format: Change `[1-5]` to `XS/S/M/L/XL`
- Next-step suggestions: Update all `/ralph_research` → `/ralph-hero:ralph-research`, `/create_plan` → `/ralph-hero:create-plan`, etc.
- Team label: Remove `"Landcrawler-ai"` team references
- Sub-agents: `codebase-locator` → `ralph-hero:codebase-locator`, `codebase-analyzer` → `ralph-hero:codebase-analyzer`, `thoughts-locator` → `ralph-hero:thoughts-locator`

**Workflow** (5 steps, preserved from source):
1. Understand the idea — read file or inline, confirm understanding
2. Research & contextualize — parallel sub-agents + `ralph_hero__list_issues` for duplicates
3. Present larger context — related work, duplicates, complexity assessment
4. Choose output format — GitHub issue, ticket tree, plan handoff, research handoff, or refine draft
5. Execute choice — create issue(s), hand off to other skill, or update draft

### Success Criteria
- [x] Automated: `ls plugin/ralph-hero/skills/form-idea/SKILL.md` exists
- [x] Automated: File contains `ralph_hero__create_issue`, not `linear`
- [x] Automated: File contains no `context: fork`, no `RALPH_COMMAND`
- [ ] Manual: Can create a GitHub issue from an idea file
- [ ] Manual: Duplicate search via `ralph_hero__list_issues` works

**Creates for next phase**: Demonstrates the full interactive frontmatter pattern with GitHub MCP tools and env vars.

---

## Phase 3: Add `research-codebase` Interactive Skill (GH-345)
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/345 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0345-research-codebase-interactive-skill.md | **Depends on**: Phase 2 (frontmatter pattern)

### Changes Required

#### 1. Create `plugin/ralph-hero/skills/research-codebase/SKILL.md`
**File**: `plugin/ralph-hero/skills/research-codebase/SKILL.md` (new file)
**Changes**: Port of `~/projects/.claude/commands/research_codebase.md`. Interactive codebase research with parallel sub-agents.

**Frontmatter**:
```yaml
---
description: Interactive codebase research - asks for a research question, spawns parallel sub-agents, synthesizes findings into a research document. Documents what IS, not what SHOULD BE.
argument-hint: "[optional: research question or #NNN issue number]"
model: opus
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - WebSearch
  - WebFetch
env:
  RALPH_GH_OWNER: "${RALPH_GH_OWNER}"
  RALPH_GH_REPO: "${RALPH_GH_REPO}"
  RALPH_GH_PROJECT_NUMBER: "${RALPH_GH_PROJECT_NUMBER}"
---
```

**Body adaptations**:
- File naming: `landcrawler-ai/thoughts/shared/research/YYYY-MM-DD-LAN-XXX-description.md` → `thoughts/shared/research/YYYY-MM-DD-GH-NNNN-description.md` (zero-padded to 4 digits)
- Frontmatter fields: Replace `linear_ticket` with `github_issue`, `linear_url` with `github_url`
- Metadata script: Remove `landcrawler-ai/scripts/thoughts/spec_metadata.sh` reference; gather commit via `git rev-parse HEAD` and date via `date +%Y-%m-%d` directly
- GitHub permalink format: `https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/{commit}/{file}#L{line}`
- Sub-agents: Use `ralph-hero:codebase-locator`, `ralph-hero:codebase-analyzer`, `ralph-hero:codebase-pattern-finder`, `ralph-hero:thoughts-locator`. Drop `thoughts-analyzer` (not available; main context synthesizes). Drop `github-repo-manager` (use `ralph_hero__get_issue` directly)
- Optional issue linking: If user provides `#NNN` argument, offer to post `## Research Document` Artifact Comment via `ralph_hero__create_comment` per `shared/conventions.md`
- Remove `thoughts/searchable/` path handling (not applicable)
- Documentarian discipline: Preserve "describe what IS, not what SHOULD BE" framing exactly

**Workflow** (9 steps, preserved from source):
1. Prompt for research question (or accept argument)
2. Read any directly mentioned files
3. Decompose into research areas
4. Spawn parallel sub-agents
5. Wait for all sub-agents, synthesize findings
6. Gather metadata (git commit, date)
7. Write research document with YAML frontmatter
8. Add GitHub permalinks if applicable
9. Present findings, handle follow-up questions with document updates

### Success Criteria
- [x] Automated: `ls plugin/ralph-hero/skills/research-codebase/SKILL.md` exists
- [x] Automated: File contains no `LAN-`, `linear`, or `spec_metadata.sh` references
- [x] Automated: File contains `GH-NNNN` naming pattern
- [ ] Manual: Runs inline, spawns sub-agents, saves document to `thoughts/shared/research/`
- [ ] Manual: Optional issue linking posts `## Research Document` comment

**Creates for next phase**: Establishes Artifact Comment Protocol usage pattern for interactive skills.

---

## Phase 4: Add `create-plan` Interactive Skill (GH-346)
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/346 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0346-create-plan-interactive-skill.md | **Depends on**: Phase 3 (Artifact Comment Protocol pattern)

### Changes Required

#### 1. Create `plugin/ralph-hero/skills/create-plan/SKILL.md`
**File**: `plugin/ralph-hero/skills/create-plan/SKILL.md` (new file)
**Changes**: Port of `~/projects/.claude/commands/create_plan.md` (491 lines — the most substantial skill). Interactive implementation planning with full user collaboration.

**Frontmatter**:
```yaml
---
description: Create detailed implementation plans through interactive research and iteration. Collaboratively explores codebase, proposes phased structure, and writes a plan document. Optionally links to a GitHub issue and transitions to Plan in Review.
argument-hint: "[optional: #NNN issue number, file path, or description]"
model: opus
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - WebSearch
  - WebFetch
env:
  RALPH_GH_OWNER: "${RALPH_GH_OWNER}"
  RALPH_GH_REPO: "${RALPH_GH_REPO}"
  RALPH_GH_PROJECT_NUMBER: "${RALPH_GH_PROJECT_NUMBER}"
---
```

**Body adaptations**:
- Plan file naming: `landcrawler-ai/thoughts/shared/plans/YYYY-MM-DD-LAN-XXX-description.md` → `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-description.md` (single issue) or `thoughts/shared/plans/YYYY-MM-DD-group-GH-NNNN-description.md` (group plan)
- Plan frontmatter: Replace `linear_ticket: LAN-XXX` / `linear_url: ...` with `github_issues: [NNN]`, `github_urls: [...]`, `primary_issue: NNN`
- Ticket file paths: `landcrawler-ai/thoughts/shared/tickets/issue_XXX.md` → `thoughts/shared/research/YYYY-MM-DD-GH-NNNN-*.md` (research docs)
- Step 1 (Context): Replace `github-repo-manager` agent with direct `ralph_hero__get_issue(number)` call in main context
- Steps 2-3 (Research): Replace sub-agent references with `ralph-hero:codebase-locator`, `ralph-hero:codebase-analyzer`, `ralph-hero:codebase-pattern-finder`, `ralph-hero:thoughts-locator`
- Step 4 (Write): Use GitHub frontmatter and file naming conventions
- Step 6 (Integration): Replace Linear integration with GitHub integration:
  - Post `## Implementation Plan` Artifact Comment via `ralph_hero__create_comment` (per `shared/conventions.md`)
  - Offer state transition to "Plan in Review" via `ralph_hero__update_workflow_state(number, state="Plan in Review", command="create_plan")`
- Next-step suggestion: `/implement_plan` → `/ralph-hero:implement-plan`
- Argument parsing: Accept `#NNN` (GitHub issue) instead of `LAN-XXX` (Linear ticket)
- Remove `TodoWrite` references (not reliably available in skill context; use inline tracking instead)

**Workflow** (7 steps, preserved from source):
1. Context gathering — read provided files/issue, initial analysis
2. Research & discovery — parallel sub-agents, present design options
3. Plan structure development — propose outline, get user buy-in
4. Detailed plan writing — save to `thoughts/shared/plans/`
5. Review — present draft, iterate on feedback
6. GitHub integration (optional) — post `## Implementation Plan` comment, offer "Plan in Review" transition
7. Report completion with next steps

### Success Criteria
- [x] Automated: `ls plugin/ralph-hero/skills/create-plan/SKILL.md` exists
- [x] Automated: File contains `github_issues`, `primary_issue` frontmatter references
- [x] Automated: File contains `## Implementation Plan` Artifact Comment header
- [x] Automated: File contains no `LAN-`, `linear`, or `github-repo-manager` references
- [ ] Manual: Creates plan document with correct frontmatter and file naming
- [ ] Manual: Optional GitHub issue linking and state transition work

**Creates for next phase**: Establishes the `## Implementation Plan` Artifact Comment Protocol pattern that `iterate-plan` and `implement-plan` consume.

---

## Phase 5: Add `iterate-plan` Interactive Skill (GH-347)
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/347 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0347-iterate-plan-interactive-skill.md | **Depends on**: Phase 4 (produces plans that this skill consumes)

### Changes Required

#### 1. Create `plugin/ralph-hero/skills/iterate-plan/SKILL.md`
**File**: `plugin/ralph-hero/skills/iterate-plan/SKILL.md` (new file)
**Changes**: Port of `~/projects/.claude/commands/iterate_plan.md`. Interactive plan iteration with confirmation checkpoints.

**Frontmatter**:
```yaml
---
description: Iterate on an existing implementation plan - reads the linked plan, understands your feedback, confirms approach, and makes surgical updates. Use when you want to refine, extend, or correct an approved plan.
argument-hint: "[#NNN or plan-path] [optional: feedback]"
model: opus
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - WebSearch
  - WebFetch
env:
  RALPH_GH_OWNER: "${RALPH_GH_OWNER}"
  RALPH_GH_REPO: "${RALPH_GH_REPO}"
  RALPH_GH_PROJECT_NUMBER: "${RALPH_GH_PROJECT_NUMBER}"
---
```

**Body adaptations**:
- Plan discovery: Replace Linear ticket attachment lookup with Artifact Comment Protocol:
  1. Parse argument — `#NNN` issue number or local file path
  2. If `#NNN`: call `ralph_hero__get_issue(number)`, search comments for `## Implementation Plan` header (use **most recent** match), extract URL, convert to local path
  3. If file path: read frontmatter for `github_issue`/`github_issues`
  4. Fallback globs: `thoughts/shared/plans/*GH-${number}*` and `thoughts/shared/plans/*GH-$(printf '%04d' ${number})*`
  5. Self-heal: if found via glob only, post `## Implementation Plan` comment via `ralph_hero__create_comment`
- Remove "Ensure Linear ticket exists" step (GitHub issue always exists; user provides `#NNN`)
- State transitions: Use explicit state names (not `__LOCK__`):
  - Start: If issue in "Plan in Review" or "Ready for Plan", offer `ralph_hero__update_workflow_state(number, state="Plan in Progress", command="iterate_plan")`
  - After major changes: If was "Plan in Review", offer to revert to "Plan in Progress"
- Iteration comments: `ralph_hero__create_comment` with `## Plan Updated` header and summary of changes
- Sub-agents: `codebase-locator` → `ralph-hero:codebase-locator`, `codebase-analyzer` → `ralph-hero:codebase-analyzer`, `codebase-pattern-finder` → `ralph-hero:codebase-pattern-finder`, `thoughts-locator` → `ralph-hero:thoughts-locator`. Drop `thoughts-analyzer`
- Plan file frontmatter: `linear_ticket` → `github_issue`/`github_issues`, `linear_url` → `github_url`/`github_urls`

**Workflow** (7 steps, preserved from source):
1. Resolve plan — parse argument, discover plan via Artifact Comment Protocol or file path
2. State transition (conditional) — offer "Plan in Progress" if appropriate
3. Read & understand — read plan fully, parse requested changes
4. Research if needed — spawn parallel sub-agents only when feedback requires new technical understanding
5. Confirm before changing — present understanding + planned edits, get approval
6. Edit plan — surgical edits via Edit tool, maintain structure and quality
7. Update issue — post `## Plan Updated` comment, offer state transition if major changes

### Success Criteria
- [ ] Automated: `ls plugin/ralph-hero/skills/iterate-plan/SKILL.md` exists
- [ ] Automated: File contains `## Implementation Plan` header search logic
- [ ] Automated: File contains no `LAN-`, `linear`, or `thoughts-analyzer` references
- [ ] Manual: `#NNN` argument resolves plan via Artifact Comment Protocol
- [ ] Manual: Surgical edits preserve plan structure; confirmation checkpoint works

**Creates for next phase**: Validates the Artifact Comment Protocol discovery pattern that `implement-plan` also uses.

---

## Phase 6: Add `implement-plan` Interactive Skill (GH-348)
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/348 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0348-implement-plan-interactive-skill.md | **Depends on**: Phase 4 (plan creation), Phase 5 (plan discovery pattern)

### Changes Required

#### 1. Create `plugin/ralph-hero/skills/implement-plan/SKILL.md`
**File**: `plugin/ralph-hero/skills/implement-plan/SKILL.md` (new file)
**Changes**: Port of `~/projects/.claude/commands/implement_plan.md`. The most complex interactive skill — plan discovery, worktree setup, phased implementation with human verification pauses.

**Frontmatter**:
```yaml
---
description: Implement an approved plan for a GitHub issue, phase by phase with manual verification pauses. Finds plan via Artifact Comment Protocol, sets up worktree, tracks progress. Use when you want to implement a planned issue interactively.
argument-hint: "<#NNN issue number or plan-path>"
model: opus
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - WebSearch
  - WebFetch
env:
  RALPH_GH_OWNER: "${RALPH_GH_OWNER}"
  RALPH_GH_REPO: "${RALPH_GH_REPO}"
  RALPH_GH_PROJECT_NUMBER: "${RALPH_GH_PROJECT_NUMBER}"
---
```

**Body adaptations**:
- Plan discovery: Same Artifact Comment Protocol as Phase 5 (`## Implementation Plan` header search, fallback globs, self-heal)
- Remove "Ensure Linear ticket exists" step (issue always exists)
- Worktree setup (new — source lacks this): Suggest `scripts/create-worktree.sh GH-NNN` which creates `worktrees/GH-NNN/` on branch `feature/GH-NNN`. Suggest but don't enforce — user may prefer main directory for small changes
- State transitions:
  - Start: `ralph_hero__update_workflow_state(number, state="In Progress", command="implement_plan")`
  - Complete: `ralph_hero__update_workflow_state(number, state="In Review", command="implement_plan")`
- Start comment: `ralph_hero__create_comment` with `## Implementation Started` header
- Completion comment: `ralph_hero__create_comment` with `## Implementation Complete` header, include PR URL and branch name
- PR creation: Use `gh pr create` directly (not `/commit-push-pr`). PR body must use `Closes #NNN` syntax (bare `#NNN` per GitHub convention)
- Verification commands: Read from plan's success criteria (don't hardcode `pnpm lint` etc.)
- Human verification pause pattern (preserve exactly from source):
  ```
  Phase [N] Complete - Ready for Manual Verification

  Automated verification passed:
  - [List automated checks that passed]

  Please perform the manual verification steps listed in the plan:
  - [List manual verification items from the plan]

  Let me know when manual testing is complete so I can proceed to Phase [N+1].
  ```
- If instructed to execute multiple phases consecutively, skip pauses until last phase
- Resuming: Trust existing checkmarks in plan, pick up from first unchecked item

**Workflow** (5 steps):
1. Parse argument — `#NNN` or file path
2. Discover plan — Artifact Comment Protocol (comment search → glob fallback → self-heal)
3. Setup — suggest worktree via `scripts/create-worktree.sh GH-NNN`, transition to "In Progress", post `## Implementation Started` comment
4. Implement — read plan phases, implement each, run automated checks, pause for human verification between phases, check off completed items
5. Complete — transition to "In Review", create PR via `gh pr create`, post `## Implementation Complete` comment with PR URL

### Success Criteria
- [ ] Automated: `ls plugin/ralph-hero/skills/implement-plan/SKILL.md` exists
- [ ] Automated: File contains `## Implementation Plan`, `## Implementation Started`, `## Implementation Complete` headers
- [ ] Automated: File contains `scripts/create-worktree.sh` reference
- [ ] Automated: File contains no `LAN-`, `linear`, or `commit-push-pr` references
- [ ] Manual: Plan discovery via Artifact Comment Protocol works end-to-end
- [ ] Manual: Human verification pause between phases works correctly

---

## Integration Testing

- [ ] All 6 skills appear in `/` autocomplete with `ralph-hero:` prefix
- [ ] No skill uses `context: fork` — all run inline
- [ ] No hooks fire for any interactive skill invocation
- [ ] Skills that reference each other (e.g., `draft-idea` → `form-idea`, `create-plan` → `implement-plan`) use correct `/ralph-hero:` prefixed names
- [ ] Artifact Comment Protocol is consistent: `## Research Document` for research-codebase, `## Implementation Plan` for create-plan/iterate-plan/implement-plan
- [ ] State transitions use explicit state names (not `__LOCK__`/`__COMPLETE__`) for interactive skills

## References

- Research documents:
  - https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0343-draft-idea-interactive-skill.md
  - https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0344-form-idea-interactive-skill.md
  - https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0345-research-codebase-interactive-skill.md
  - https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0346-create-plan-interactive-skill.md
  - https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0347-iterate-plan-interactive-skill.md
  - https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0348-implement-plan-interactive-skill.md
- Existing port plan: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-21-interactive-skills-port.md
- Conventions: `plugin/ralph-hero/skills/shared/conventions.md`
- Source commands: `~/projects/.claude/commands/{draft_idea,form_idea,research_codebase,create_plan,iterate_plan,implement_plan}.md`
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/342
