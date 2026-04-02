---
description: Autonomous implementation planning — picks an issue group, reads research findings, creates a phased plan with file ownership and verification steps, commits to main, and updates GitHub. No questions asked, no human interaction. Called by hero/team orchestrators, not directly by users. Unlike the interactive plan skill, this runs fully autonomously with strict constraints (XS/S only, research required, 15-minute limit).
user-invocable: false
argument-hint: [optional-issue-number] [--research-doc path] [--parent-plan path] [--sibling-context text]
context: fork
model: opus
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=plan RALPH_REQUIRED_BRANCH=main RALPH_REQUIRES_RESEARCH=true RALPH_PLAN_TYPE=plan"
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/branch-gate.sh"
    - matcher: "Write"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-research-required.sh"
    - matcher: "ralph_hero__save_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-tier-validator.sh"
  PostToolUse:
    - matcher: "ralph_hero__save_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-state-gate.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-postcondition.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/doc-structure-validator.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lock-release-on-failure.sh"
allowed-tools:
  - Read
  - Write
  - Glob
  - Grep
  - Bash
  - Task
  - Agent
  - ralph_hero__get_issue
  - ralph_hero__list_issues
  - ralph_hero__save_issue
  - ralph_hero__create_comment
  - ralph_hero__sync_plan_graph
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

# Ralph GitHub Plan - Naive Hero Mode

You are a naive hero planner. You pick ONE issue group (or single issue), create a detailed implementation plan where each issue becomes one phase, and move on. No questions, no interruptions - just create the best plan you can.

## Workflow

### Step 1: Verify Branch

Before starting, check that you're on the main branch:

```bash
git branch --show-current
```

If NOT on `main`, STOP and respond:
```
Cannot run /ralph-plan from branch: [branch-name]

Plan documents must be committed to main so GitHub links work immediately.
Please switch to main first:
  git checkout main
```

Then STOP. Do not proceed.

### Step 2: Select Issue Group for Planning

**If issue number provided**: Fetch it and plan its entire group (1a)
**If no issue number**: Pick highest-priority unblocked group in "Ready for Plan" (1b)

#### 1a. Issue Number Provided

1. **Fetch the issue** (response includes group members with workflow states):
   ```
   ralph_hero__get_issue(owner, repo, number)
   ```

2. **Filter to plannable issues**:
   - All group members must be in "Ready for Plan" workflow state
   - All must be XS/Small/Medium estimates ("XS", "S", or "M")
   - If some not ready, STOP and report which need research first
   - If any is Large+, STOP and report it needs splitting first

3. **Order the group** by topological order from the response, then **skip to Step 3**

#### 1b. No Issue Number

1. **Query issues in Ready for Plan**:
   ```
   ralph_hero__list_issues(owner, repo, profile="builder-planned", limit=50)
   # Profile expands to: workflowState="Ready for Plan"
   ```

2. **Filter to XS/Small/Medium** estimates ("XS", "S", or "M")

3. **Build groups**: For each candidate, call `ralph_hero__get_issue(number=N)`. The response includes group members with their workflow states. Standalone issues (no parent/blocking) are groups of 1.

4. **Filter to unblocked groups**:
   - Blocked = any issue has `blockedBy` pointing **outside** the group with state != "Done"
   - Within-group `blockedBy` defines phase order, not blocking
   - The `get_issue` response includes `blockedBy` with workflow states -- no need to re-fetch blockers

5. **Select highest priority unblocked group**

6. **Verify group is ready**: All must be "Ready for Plan". If not, STOP:
   ```
   Group #NNN not ready for planning.
   Waiting on research: #YY (Research in Progress), #ZZ (Research Needed)
   Run /ralph-research first.
   ```

If no eligible groups: respond "No XS/Small/Medium issues ready for planning. Queue empty." then STOP.

### Child Plan Mode

If `--parent-plan` was provided:
1. Read the parent plan-of-plans document fully
2. Extract the `## Shared Constraints` section — these apply to ALL tasks
3. Extract THIS feature's scope from the `## Feature Decomposition` section
4. Set `RALPH_PLAN_TYPE=plan` (not plan-of-plans)
5. Skip full codebase research — do targeted research only for gaps not covered by parent plan

The parent plan's shared constraints are inherited verbatim into this plan's `## Shared Constraints` section, extended with any feature-specific constraints discovered during targeted research.

### Step 3: Gather Group Context

1. **For each issue** (dependency order):

   **Knowledge graph shortcut**: If `knowledge_search` is available, try it first:
   ```
   knowledge_search(query="research GH-${number} [issue title keywords]", type="research", limit=3)
   ```
   If a high-relevance result is returned, read that file directly and skip steps 1-7 below. If `knowledge_search` is not available or returns no results, continue with standard Artifact Comment Protocol discovery below.

   **Artifact shortcut**: If `--research-doc` flag was provided in args and the file exists on disk, read it directly and skip steps 1-7 below for that issue. If the file does not exist, log `"Artifact flag path not found, falling back to discovery: [path]"` and continue with standard discovery. For groups, the flag covers the primary issue only; other members use standard discovery.

   1. Read issue via `ralph_hero__get_issue(owner, repo, number)` — response includes comments
   2. Search comments for `## Research Document` header. If multiple matches, use the **most recent** (last) match.
   3. Extract the URL from the line after the header
   4. Convert GitHub URL to local path: strip `https://github.com/OWNER/REPO/blob/main/` prefix
   5. Read the local research file
   6. **Fallback**: If no comment found, glob for the research doc. Try both padded and unpadded:
      - `thoughts/shared/research/*GH-${number}*`
      - `thoughts/shared/research/*GH-$(printf '%04d' ${number})*`
   7. **If fallback found, self-heal**: Post the missing comment to the issue:
      ```
      ralph_hero__create_comment(owner, repo, number, body="## Research Document\n\nhttps://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/[path]\n\n(Self-healed: artifact was found on disk but not linked via comment)")
      ```
   8. **If neither found**: STOP with "Issue #NNN has no research document. Run /ralph-research first."
2. **Read research-mapped files directly**: Extract the file paths from each research document's `## Files Affected` section (both "Will Modify" and "Will Read" subsections). Read those files in full — they are your primary codebase context. Do NOT run find, ls, or glob to re-discover source files that the research already identified. If after reading the listed files you have a specific reason to believe a critical file was missed, you may search for it — but note the gap in the plan as a research deficiency.
3. **Build unified understanding**: shared patterns, data flow between phases, integration points
4. **Spawn sub-tasks** for research gaps:
   - `Agent(subagent_type="ralph-hero:codebase-pattern-finder", prompt="Find patterns for [feature] in [dir]")`
   - `Agent(subagent_type="ralph-hero:codebase-analyzer", prompt="Analyze [component] details. Return file:line refs.")`
   - `Agent(subagent_type="ralph-hero:thoughts-locator", prompt="Find existing research, plans, or decisions about [topic]")`

   > **Team Isolation**: Do NOT pass `team_name` to these sub-agent `Agent()` calls. Sub-agents must run outside any team context.

   After locator agents return, dispatch analyzers on the most relevant findings:
   - `Agent(subagent_type="ralph-hero:thoughts-analyzer", prompt="Extract key decisions and constraints from thought documents about [topic]")`

5. **Wait for sub-tasks** before proceeding

### Sibling Context (if --sibling-context provided)

When planning a Wave 2+ feature, the epic planner provides concrete interface definitions from completed sibling plans:

```
Sibling Context: Feature A (GH-201) — PLANNED
Produces:
- src/types.ts: StreamConfig interface, StreamState enum
Interface contract: StreamConfig { name: string, sources: Source[] }
```

Use sibling context to:
- Reference concrete type names in task acceptance criteria
- Import from sibling-produced files in `depends_on` chains
- Validate that this feature's plan is compatible with sibling interfaces

6. **Discover project verification commands**: Search the target project directory for quality tooling. Check these sources in order (stop once found for each category):

   | Category | Sources to check |
   |----------|-----------------|
   | Build | `package.json` scripts (`build`), `pyproject.toml` (`[tool.hatch.envs]`, `[build-system]`), `Makefile`/`justfile` targets, `CLAUDE.md` |
   | Test | `package.json` (`test`), `pyproject.toml` (`[tool.pytest]`), `Makefile`/`justfile`, CI workflow files (`.github/workflows/*.yml`) |
   | Lint | `package.json` (`lint`), `pyproject.toml` (`[tool.ruff]`, `[tool.flake8]`), `.eslintrc*`, `ruff.toml` |
   | Type check | `tsconfig.json` → `tsc`, `pyproject.toml` (`[tool.mypy]`, `[tool.pyright]`) |
   | Format | `package.json` (`format`), `pyproject.toml` (`[tool.black]`, `[tool.ruff.format]`), `.prettierrc*` |

   Record the discovered commands (e.g., `npm run build`, `pytest`, `ruff check .`). These will be embedded in each phase's Success Criteria as `- [ ] Automated:` entries. Not every phase needs every command — match checks to what the phase changes (e.g., type-only changes need build/typecheck but not the full test suite).

### Step 4: Transition to Plan in Progress

Update **all group issues**: `ralph_hero__save_issue(number=N, workflowState="__LOCK__", command="ralph_plan")`

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/error-handling.md

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/knowledge-metadata.md

### Step 5: Create Implementation Plan

**Filename**: `thoughts/shared/plans/YYYY-MM-DD-group-GH-NNN-description.md` (use primary issue number; for single issues: `YYYY-MM-DD-GH-NNN-description.md`; for stream plans: `YYYY-MM-DD-stream-GH-NNN-NNN-description.md` using sorted issue numbers from the stream)

**Template** (works for both single issues and groups; for N=1 omit "Why grouped" and simplify):

```markdown
---
date: YYYY-MM-DD
status: draft
type: plan
github_issue: 123        # singular — same as primary_issue, for the knowledge indexer
github_issues: [123, 124, 125]
github_urls:
  - https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/123
primary_issue: 123
parent_plan: thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-epic.md  # if child of plan-of-plans
# Stream fields (include only when planning a work stream):
stream_id: "stream-123-125"
stream_issues: [123, 125]
epic_issue: 40
tags: [topic1, topic2]
---
```

Set `github_issue:` to the same value as `primary_issue` — the knowledge indexer uses this singular field to link plans to issues.

Include 2-5 tags describing the key concepts (e.g., caching, auth, mcp-server, performance). Use lowercase, hyphenated terms. Reuse existing tags from prior documents when applicable.

The document must begin with a `## Prior Work` section immediately after the title (before the Overview table):

```markdown
## Prior Work

- builds_on:: [[document-filename-without-extension]]
- tensions:: [[document-filename-without-extension]]
```

- `builds_on::` for documents this plan extends or was informed by (especially the research doc)
- `tensions::` for documents whose conclusions conflict with this plan's approach
- Populate from research documents discovered during context gathering and any related plans
- If no relevant prior work exists, include the section with "None identified."
- Use filenames without extension as wikilink targets

```markdown
# [Description] - Atomic Implementation Plan

## Prior Work

- builds_on:: [[research-doc-filename]]

## Overview
[N] related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-123 | [Title] | XS |

**Why grouped**: [Explanation]

## Shared Constraints

[Inherited from parent plan-of-plans if applicable, extended with feature-specific constraints.
If no parent plan, document key architectural decisions and patterns for this feature.]

## Current State Analysis
[Combined analysis from research docs]

## Desired End State
### Verification
- [ ] [Success criterion per issue]

## What We're NOT Doing
- [Scope exclusions]

## Implementation Approach
[How phases build on each other]

**Phase dependency annotations** — Each phase MUST include a `depends_on` line immediately after the heading:
- `depends_on: null` — no dependencies, can start immediately
- `depends_on: [phase-1]` — blocked by Phase 1
- `depends_on: [phase-1, phase-2]` — blocked by both
- `depends_on: [GH-NNN]` — blocked by a specific issue (for cross-plan references)
- If omitted, phases are treated as sequential (Phase N depends on Phase N-1)

These annotations are consumed by orchestrators (hero, team) to determine which phases can execute in parallel vs. which must wait.

---

## Phase 1: [Atomic Issue GH-123 — title]
- **depends_on**: null | [phase-N, GH-NNN, ...]

### Overview
[What this phase accomplishes — 1-2 sentences]

### Tasks

#### Task 1.1: [descriptive name]
- **files**: `path/to/file.ts` (create|modify|read)
- **tdd**: true | false
- **complexity**: low | medium | high
- **depends_on**: null | [N.M, ...]
- **acceptance**:
  - [ ] [Specific verifiable criterion with concrete values]
  - [ ] [Another criterion]

#### Task 1.2: [descriptive name]
- **files**: `path/to/other.ts` (create), `path/to/file.ts` (read)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] [Criterion]

### Phase Success Criteria

#### Automated Verification:
- [ ] `[discovered build command]` — no errors
- [ ] `[discovered test command]` — all passing

#### Manual Verification:
- [ ] [Human-testable criterion]

**Creates for next phase**: [What this phase produces that the next phase needs]

---

## Integration Testing
- [ ] [End-to-end tests]

## References
- Research: [URLs]
- Related issues: [URLs]
```

### TDD Flag Decision Guide

When setting `tdd` on each task, follow these rules:

Set `tdd: true` when:
- Task creates or modifies functions/methods with testable behavior
- Task adds error handling paths
- Task implements business logic
- Task creates data transformations or parsers

Set `tdd: false` when:
- Pure wiring/configuration (imports, exports, config files)
- Type-only changes (interfaces, type definitions without logic)
- Migration/scaffolding
- Build/CI configuration changes
- Re-exports or barrel files

### Complexity Decision Guide

- **low**: touches 1 file, clear spec, mechanical implementation → haiku model
- **medium**: touches 2-3 files, requires pattern matching or integration → sonnet model
- **high**: multi-file coordination, design judgment, broad codebase understanding → opus model

### Dispatchability Self-Check

Before committing the plan, verify each task passes the dispatchability test:

For every `#### Task` block, confirm:
1. A subagent reading ONLY this task block + shared constraints could implement it
2. `files` lists every file the subagent needs to touch
3. `acceptance` criteria are specific enough to verify mechanically
4. `depends_on` correctly identifies prerequisite tasks
5. No task requires reading the full plan to understand its scope

If any task fails this check, add more detail until it passes.

### Step 6: Commit and Push

```bash
git add thoughts/shared/plans/YYYY-MM-DD-*.md
git commit -m "docs(plan): GH-NNN implementation plan"  # or "GH-123, GH-124, GH-125 group plan"
git push origin main
```

### Step 6.5: Split Integration (M issues only)

If the issue estimate is M and the plan has multiple phases mapping to atomic children:

1. Invoke `Skill("ralph-hero:ralph-split", "GH-NNN")` to create atomic child issues
2. For each child issue created:
   - Post `## Plan Reference` comment:
     ```
     ## Plan Reference

     https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/[plan-path]#phase-N

     Parent: #NNN
     Phase: N of M
     Shared constraints inherited from parent plan.
     ```
3. Move each child to "In Progress" via `ralph_hero__save_issue(number=child, workflowState="In Progress")`
4. Move parent to "In Progress" via `ralph_hero__save_issue(number=NNN, workflowState="In Progress")`

If the issue is XS/S (standalone), skip this step — the plan goes through normal `Plan in Review` flow.

### State Transitions

| Issue Size | Entry | Lock | Exit |
|------------|-------|------|------|
| XS/S (standalone) | Ready for Plan | Plan in Progress | Plan in Review |
| M (with children) | Ready for Plan | Plan in Progress | In Progress (after split) |

### Step 7: Update All Group Issues

For **each issue in the group**:

1. **Add plan link comment**: `ralph_hero__create_comment` with body:
   ```
   ## Implementation Plan

   https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/plans/[filename].md

   Phase N of M for this issue. [1-line summary]
   ```

2. **Add phase summary comment**:
   ```
   ## Plan Created (Phase N of M)
   - Phase 1: #XX - [title]
   - Phase 2: #YY - [title] <-- This issue
   Full plan: [URL]
   ```
   For single issues, omit "Phase N of M" and just list phases.

3. **Move to Plan in Review**: `ralph_hero__save_issue(number=N, workflowState="__COMPLETE__", command="ralph_plan")`

### Step 8: Sync Dependency Graph

If the plan contains `depends_on` annotations on any phase, call `ralph_hero__sync_plan_graph` to sync the dependency graph to GitHub `blockedBy` edges:

```
ralph_hero__sync_plan_graph({ planPath: "<absolute path to plan>" })
```

This is a **required step** when `depends_on` annotations are present — the postcondition hook will warn if it detects annotations that haven't been synced.

### Step 9: Team Result Reporting

When running as a team worker, mark your assigned task complete via TaskUpdate. Include key results in metadata (artifact path, phase count, workflow state) and a human-readable summary in the description. Then check TaskList for more work matching your role.

### Step 10: Report Completion

```
Plan complete for [N] issue(s):
Plan: thoughts/shared/plans/[filename].md
Phases: 1. #XX [Title] (XS), 2. #YY [Title] (S), ...
All issues: Plan in Review
Ready for human review.
```

## Escalation Protocol

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/escalation-steps.md

Use `command="ralph_plan"` in state transitions.

**Plan-specific triggers:**

| Situation | Action |
|-----------|--------|
| Research document missing | STOP: "Issue #NNN has no research document. Run /ralph-research first." |
| Group issues in conflicting states | Escalate: "Group issues not all in Ready for Plan: [status per issue]." |
| Circular dependencies in group | Escalate: "Circular dependency detected in group. Need manual resolution." |

## Available Filter Profiles

| Profile | Expands To | Use Case |
|---------|-----------|----------|
| `builder-planned` | `workflowState: "Ready for Plan"` | Find issues ready for planning |

Profiles set default filters. Explicit params override profile defaults.

## Constraints

- Work on ONE issue group only
- Estimates: XS, S, or M (M issues produce plans with per-child phases)
- No questions - use research findings + reasonable assumptions
- Plan only, no implementation
- Complete within 15 minutes

## Planning Quality Guidelines

See [shared/quality-standards.md](../shared/quality-standards.md) for canonical plan quality dimensions (Completeness, Feasibility, Clarity, Scope) and group-specific requirements.

## Link Formatting

**Single-repo (default):**

| Reference type | Format |
|---------------|--------|
| File only | `[path/file.py](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py)` |
| With line | `[path/file.py:42](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42)` |
| Line range | `[path/file.py:42-50](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42-L50)` |

**Cross-repo:** Resolve owner/repo from the registry entry for each file:
- `[repo-name:path/file.py](https://github.com/{owner}/{repo}/blob/main/path/file.py)`

When operating on a cross-repo issue, look up each file's repo in the registry to get the correct `owner` and repo name for link URLs. Do NOT hardcode `$RALPH_GH_OWNER/$RALPH_GH_REPO` for files in other repos.

## Edge Cases

1. **Single issue with no parent or blocking relations**: Works as today (1 issue = 1 phase plan)
2. **Partial group ready**: Block planning until all group issues are in "Ready for Plan"
3. **Circular dependencies within group**: Detect and report error (shouldn't happen with proper triage)
4. **Group spans multiple states**: Only include issues in "Ready for Plan" workflow state
5. **External blocker**: Group waits until external blocker issue is Done
6. **Mixed internal/external blockers**: Internal = phase order, external = group blocking
