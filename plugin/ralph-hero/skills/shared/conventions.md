# Shared Conventions

Common protocols referenced by all Ralph skills. Skills should link here rather than duplicating this content.

## Identifier Disambiguation

Task list IDs and GitHub issue numbers use different prefixes to avoid confusion:

| Entity | Prefix | Example | Scope |
|--------|--------|---------|-------|
| Task list item | `T-` | T-7 | Session-local, ephemeral |
| GitHub issue | `GH-` | GH-49 | Repository-scoped, permanent |

- **Task subjects and spawn templates** use `GH-NNN` when referencing GitHub issues (e.g., `"Research GH-42"`)
- **Task list IDs** (from TaskCreate/TaskList) are referenced as `T-N` in lead messages and instructions
- **Exception**: GitHub PR body `Closes #NNN` syntax uses bare `#NNN` because GitHub requires it

## Escalation Protocol

When encountering complexity, uncertainty, or states that don't align with protocol, **escalate via GitHub issue comment** by @mentioning the appropriate person.

**Escalation priority** (use first available):
1. **Assigned individual** - If the issue has an assignee
2. **Project owner** - If the issue belongs to a project with a lead
3. **Team lead** - Default escalation target

**When to escalate:**

| Situation | Action |
|-----------|--------|
| Issue scope larger than estimated | @mention: "This is [M/L/XL] complexity, not [XS/S]. Needs re-estimation or splitting." |
| Missing context/requirements | @mention: "Cannot proceed effectively. Need clarification on: [specific questions]." |
| Architectural decision needed | @mention: "Multiple valid approaches found: [A vs B]. Need architectural guidance." |
| External dependency discovered | @mention: "This requires [external API/service/team]. Need confirmation before proceeding." |
| Conflicting existing patterns | @mention: "Found conflicting patterns: [pattern A] vs [pattern B]. Which to follow?" |
| Plan doesn't match codebase | @mention: "Plan assumes [X] but found [Y]. Need updated plan." |
| Tests fail unexpectedly | @mention: "Tests fail: [error]. Not a simple fix - need guidance." |
| Breaking changes discovered | @mention: "Implementation would break [component]. Scope larger than planned." |
| Security concern identified | @mention: "Potential security issue: [description]. Need review before proceeding." |

**How to escalate:**

1. **Move issue to "Human Needed"**:
   ```
   ralph_hero__update_workflow_state
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - state: "__ESCALATE__"
   - command: "[current-command]"
   ```
   For group plans, move ALL group issues to "Human Needed".

2. **Add comment with @mention**:
   ```
   ralph_hero__create_comment
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - body: "@$RALPH_GH_OWNER Escalation: [issue description]"
   ```

3. **STOP and report**:
   ```
   Escalated to @[person]: [brief reason]

   Issue: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
   Status: Human Needed

   Waiting for guidance before proceeding.
   ```

## Link Formatting

When referencing code in documents, PRs, or GitHub comments, use GitHub links with environment variables:

| Reference type | Format |
|---------------|--------|
| File only | `[path/file.py](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py)` |
| With line | `[path/file.py:42](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42)` |
| Line range | `[path/file.py:42-50](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42-L50)` |

## Common Error Handling

**Tool call failures**: If `update_workflow_state` returns an error, read the error message -- it contains valid states/intents and a specific Recovery action. Retry with the corrected parameters.

**State gate blocks**: Hooks enforce valid state transitions at the tool level. If a hook blocks your action, the state machine requires a different transition. Check the current workflow state and re-evaluate.

**Postcondition failures**: Stop hooks verify expected outputs (research doc, plan doc, commits). If a postcondition fails, check the specific requirement and satisfy it before retrying.

## Pipeline Handoff Protocol

Cross-phase progression is lead-driven: the lead creates next-bough tasks when convergence is detected (see SKILL.md Section 4.4). Workers check TaskList for within-phase work and notify the lead when idle.

### Pipeline Order

| Current Worker (name) | Next Stage | Worker name to find |
|---|---|---|
| `analyst` | Builder | `builder` |
| `builder` (plan done) | Validator | `validator` (if `RALPH_REVIEW_MODE=interactive`) |
| `builder` (impl done) | Integrator (PR creation) | `integrator` |
| `validator` (approved) | Builder | `builder` |
| `validator` (rejected) | Builder (re-plan) | `builder` |

### Handoff Procedure (after completing a task)

1. Check `TaskList` for more tasks matching your role
2. If found: self-claim and continue
3. If none available: notify the team-lead that you have no more work. The Stop hook will block shutdown if matching tasks appear later.

### Rules

- **Lead assigns at spawn and bough advancement**: The lead sets `owner` via `TaskUpdate` before spawning a worker and when creating new-bough tasks. Workers also self-claim unclaimed tasks via Stop hook.
- **SendMessage is fire-and-forget** -- no acknowledgment mechanism. The handoff wakes the peer; they self-claim from TaskList.
- **Lead gets visibility** via idle notification DM summaries -- no need to CC the lead on handoffs.
- **Multiple handoffs are fine** -- if 3 analysts complete and all message the builder, the builder wakes 3 times and claims one task each time.

## Task Description Protocol

Task descriptions are the primary channel for passing context from the lead to teammates. When creating tasks, include GitHub URLs, artifact paths, group membership, and workflow state in the description. Workers read these via `TaskGet` before invoking their skill.

For the full specification of metadata fields, structured format examples, and task ID conventions, see `skills/shared/task-list-guide.md`.

Key metadata fields: `issue_number`, `issue_url`, `command`, `phase`, `estimate`, `group_primary`, `group_members`, `artifact_path`, `worktree`.

## Communication Discipline

TaskUpdate is the primary channel for structured results. SendMessage is for exceptions -- escalations, blocking discoveries, or questions not answerable from the task description. Avoid acknowledging tasks, reporting routine progress, or responding to idle notifications via message.

For the full communication principles including lead behavior, timing patience, and context passing examples, see `skills/shared/team-communication.md`.

## Spawn Template Protocol

### Template Location

A single spawn template lives at: `${CLAUDE_PLUGIN_ROOT}/templates/spawn/worker.md`

To resolve the path at runtime, use Bash to expand the variable first:
```
TEMPLATE_PATH=$(echo $CLAUDE_PLUGIN_ROOT)/templates/spawn/worker.md
```
Then read via `Read(file_path="[resolved-path]")`.

All roles use this template. Role-specific behavior is driven by placeholder substitution from the spawn table in SKILL.md Section 6.

### Placeholder Substitution

| Placeholder | Source | Required |
|-------------|--------|----------|
| `{ISSUE_NUMBER}` | Issue number from GitHub | Always |
| `{TITLE}` | Issue title from `get_issue` | Always |
| `{TASK_VERB}` | Spawn table "Task Verb" column | Always |
| `{TASK_CONTEXT}` | Role-dependent (see SKILL.md Section 6) | Optional (empty -> line removed) |
| `{SKILL_INVOCATION}` | Spawn table "Skill" column (integrator uses special instruction) | Always |
| `{REPORT_FORMAT}` | Result Format Contracts below | Always |

### Group Context Resolution

If `IS_GROUP=true` for the issue:
```
{GROUP_CONTEXT} = "Group: GH-{PRIMARY} (GH-{A}, GH-{B}, GH-{C}). Plan covers all group issues."
```

If `IS_GROUP=false`:
```
{GROUP_CONTEXT} = ""
```

### Worktree Context Resolution

If worktree already exists:
```
{WORKTREE_CONTEXT} = "Worktree: worktrees/GH-{ISSUE_NUMBER}/ (exists, reuse it)"
```

If no worktree:
```
{WORKTREE_CONTEXT} = ""
```

### Empty Placeholder Line Removal

If a placeholder resolves to an empty string, remove the ENTIRE LINE containing that placeholder. Do not leave blank lines where optional context was omitted.

Example -- worker.md template before substitution (planner role):
```
Plan GH-42: Add caching.
{TASK_CONTEXT}

Invoke: Skill(skill="ralph-hero:ralph-plan", args="42")

Report via TaskUpdate: "PLAN COMPLETE: ..."
Then check TaskList for more tasks matching your role. If none, notify team-lead.
```

After substitution when IS_GROUP=false (TASK_CONTEXT is empty):
```
Plan GH-42: Add caching.

Invoke: Skill(skill="ralph-hero:ralph-plan", args="42")

Report via TaskUpdate: "PLAN COMPLETE: ..."
Then check TaskList for more tasks matching your role. If none, notify team-lead.
```
The `{TASK_CONTEXT}` line is removed entirely.

### Resolution Procedure (for orchestrator)

1. Read the template: `Bash("echo $CLAUDE_PLUGIN_ROOT")` then `Read(file_path="[resolved-root]/templates/spawn/worker.md")`
2. Look up the role in SKILL.md Section 6 spawn table using the task subject keyword
3. Substitute all `{PLACEHOLDER}` strings with values from `get_issue` response and spawn table
4. If a placeholder resolves to an empty string, remove the ENTIRE LINE containing it
5. Use the result as the `prompt` parameter in `Task()`

### Template Naming Convention

All roles use the single `worker.md` template. Role selection is driven by the task subject keyword, mapped through the spawn table in SKILL.md Section 6. The template file itself is role-agnostic.

### Template Authoring Rules

- The single `worker.md` template should be under 10 lines (raw, before substitution)
- Resolved prompts should be under 10 lines for every role
- Avoid including: conversation history, document contents, or lengthy code snippets. Brief contextual notes (1-2 lines) are acceptable when they help the worker orient faster.
- Teammates message the lead using `recipient="team-lead"` exactly
- Result reporting follows conventions.md Result Format Contracts (via `{REPORT_FORMAT}`)

### Template Integrity

The resolved template content is the primary prompt for spawned teammates. Try to keep spawn prompts close to the template output. Additional context like artifact paths and group membership should go in task descriptions (via TaskCreate/TaskUpdate) rather than in the spawn prompt itself. This way teammates discover context through their task metadata rather than having it front-loaded.

**Line-count guideline**: A correctly resolved prompt is typically 6-8 lines. If the prompt exceeds 12-15 lines, consider whether the extra context would be better placed in the task description.

**Context that belongs in task descriptions, not spawn prompts**:
- Research hints, root cause analysis, or investigation guidance
- File paths or code snippets not present in the template
- Custom instructions replacing or augmenting template content
- "Key files:", "Context:", "Background:" sections

**Why this matters**: Agents invoke skills in isolated context windows. When the orchestrator front-loads context, agents may skip skill invocation and work directly, bypassing hook enforcement and postcondition validation.

## Skill Invocation Convention

### Default: Fork via Task()

Skills should be invoked via forked subprocesses to isolate context:

```
Task(subagent_type="general-purpose",
     prompt="Skill(skill='ralph-hero:ralph-research', args='42')",
     description="Research GH-42")
```

This ensures:
- Skill runs in a fresh context window (no context pollution)
- Skill failures don't corrupt the caller's state
- Token usage is isolated per skill invocation
- Results are returned as a summary, not full conversation

### Note: Team Agents

Team members are spawned as typed subagents (e.g., `ralph-analyst`, `ralph-builder`, `ralph-validator`, `ralph-integrator`) via `Task()`. Each team member invokes its skill inline:

```
Skill(skill="ralph-hero:ralph-research", args="42")
```

This works because the team system provides isolated context windows, identical to `Task()` subprocesses.

### Exception: Direct User Invocation

Users invoking skills directly (e.g., `/ralph-research 42`) run inline in their session. This is the expected behavior for interactive use.

## Sub-Agent Team Isolation

Skills that spawn internal sub-agents via `Task()` (e.g., `codebase-locator`, `codebase-analyzer`, `codebase-pattern-finder`) must ensure those sub-agents do NOT inherit team context.

**Rule**: Never pass `team_name` to internal `Task()` calls within skills. Sub-agents are utility workers that return results to the skill -- they are not team members.

**Why**: When a skill runs inside a team worker's session (via `ralph-team`), the `context: fork` setting isolates the context window but does NOT isolate the team session environment. If internal `Task()` calls inherit team context, sub-agents enroll as phantom teammates, generating idle notifications that flood the team lead.

**Correct**:
```
Task(subagent_type="codebase-locator", prompt="Find files related to ...")
Task(subagent_type="codebase-analyzer", prompt="Analyze component ...")
```

**Incorrect**:
```
Task(subagent_type="codebase-locator", team_name=TEAM_NAME, prompt="Find files related to ...")
```

This applies to all skills that spawn internal sub-agents: ralph-research, ralph-plan, ralph-split, ralph-triage, and ralph-review. See individual SKILL.md files for inline reminders.

## Architecture Decision: Agent/Skill Separation (ADR-001)

**Status**: Validated (2026-02-19, GH-132)
**Reference**: Bowser framework (github.com/disler/bowser/)

### Decision

Ralph-hero uses a 4-layer architecture matching Bowser's proven pattern:

| Layer | Name | Role | Location |
|-------|------|------|----------|
| 4 | Scripts | Terminal invocation | `scripts/ralph-loop.sh`, `scripts/ralph-team-loop.sh` |
| 3 | Skills | Capability + workflow logic | `skills/*/SKILL.md` |
| 2 | Agents | Scale + isolation (team workers) | `agents/*.md` |
| 1 | MCP Tools | Raw GitHub API operations | `mcp-server/src/tools/` |

### Key Principles

1. **Agents are thin wrappers**: Agent definitions are 20-35 lines. They define a task loop that dispatches to skills. Agents do NOT contain workflow logic.
2. **Skills own workflow logic**: Each skill defines the complete procedure for one workflow phase (research, plan, review, implement). Skills declare `allowed_tools` to restrict their tool surface.
3. **MCP tools are primitive operations**: Create issue, update state, add comment. No business logic.
4. **Orchestrators delegate, never implement**: `ralph-team` and `ralph-hero` skills spawn workers and manage tasks. They never research, plan, review, or implement directly.

### Enforcement Mechanisms

| Mechanism | Type | What it prevents |
|-----------|------|-----------------|
| `allowed_tools` in SKILL.md | Declarative constraint | Skills using tools outside their scope |
| Template integrity rules | Documentation-based | Orchestrator front-loading context into spawn prompts |
| Line-count guardrail (10-line max) | Behavioral check | Orchestrator adding prohibited context beyond placeholders |
| `context: fork` on worker skills | Process isolation | Context pollution between skill invocations |
| Hook-based state gates | Structural enforcement | Invalid workflow state transitions |

**No structural enforcement for skill invocation exists** in Claude Code's plugin system. Both Bowser and ralph-hero rely on LLM compliance with documented patterns. This is an accepted limitation.

### What NOT to Do

- **Do NOT remove MCP tools from agent definitions** (PR #57 proved this breaks skill execution since `Skill()` inherits agent tool restrictions)
- **Do NOT add workflow logic to agent definitions** (agents dispatch to skills; skills contain the logic)
- **Do NOT create hook-based skill invocation verification** (hooks cannot inspect conversation history)

## Result Format Contracts

When teammates complete tasks, they report results via `TaskUpdate(description=...)`. The lead and hooks parse these descriptions. Formats MUST follow these contracts exactly.

### Analyst Results

**Triage**:
```
TRIAGE COMPLETE: #NNN
Action: [CLOSE|SPLIT|RESEARCH|KEEP]
[If SPLIT]: Sub-tickets: #AAA, #BBB
Estimates: #AAA (XS), #BBB (S)
```

**Split**:
```
SPLIT COMPLETE: #NNN
Sub-tickets: #AAA, #BBB, #CCC
Estimates: #AAA (XS), #BBB (S), #CCC (XS)
```

**Research**:
```
RESEARCH COMPLETE: #NNN - [Title]
Document: [path]
Key findings: [summary]
Ticket moved to: Ready for Plan
```

### Builder Results

**Plan**:
```
PLAN COMPLETE: [ticket/group]
Plan: [path]
Phases: [N]
File ownership: [groups]
Ready for review.
```

**Implement**:
```
IMPLEMENTATION COMPLETE
Ticket: #NNN
Phases: [N] of [M]
Files: [list]
Tests: [PASSING|FAILING]
Commit: [hash]
Worktree: [path]
```

### Validator Results

**Review**:
```
VALIDATION VERDICT
Ticket: #NNN
Plan: [path]
VERDICT: [APPROVED|NEEDS_ITERATION]
[blocking issues with file:line evidence]
[warnings]
[what's good]
```

### Integrator Results

**PR Creation**:
```
PR CREATED
Ticket: #NNN
PR: [URL]
Branch: [branch]
State: In Review
```

**Merge**:
```
MERGE COMPLETE
Ticket: #NNN
PR: [URL] merged
Branch: deleted
Worktree: removed
State: Done
```

### Contract Rules

1. **First line is the key**: The first line (e.g., `TRIAGE COMPLETE: #NNN`) is the parseable identifier. Always include it.
2. **Colon-separated fields**: Use `Key: Value` format for structured data.
3. **Sub-ticket IDs are critical**: Analyst triage/split results MUST include all sub-ticket IDs -- the lead creates follow-up tasks from them.
4. **VERDICT line is parseable**: Validator results MUST include `VERDICT: APPROVED` or `VERDICT: NEEDS_ITERATION` on its own line.
5. **File lists use short paths**: Relative to repo root, not absolute paths.

## Artifact Comment Protocol

### Overview

GitHub issue comments are the **primary source of truth** for all artifacts produced by the pipeline.
Each phase posts a comment with a standardized section header. The next phase searches for that header.

### Comment Section Headers

| Phase | Header | Content |
|-------|--------|---------|
| Research | `## Research Document` | GitHub URL to research `.md` file |
| Plan | `## Implementation Plan` | GitHub URL to plan `.md` file |
| Review | `## Plan Review` | VERDICT line (APPROVED or NEEDS_ITERATION) + optional critique URL |
| Implementation | `## Implementation Complete` | PR URL, branch name, files changed |

### Comment Format

Each artifact comment MUST follow this exact format:

```
## [Section Header]

[GitHub URL to artifact file]

[Optional summary - 1-3 lines]
```

**Example - Research:**
```
## Research Document

https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/research/2026-02-17-GH-0042-auth-flow.md

Key findings: Auth flow uses Firebase JWT tokens. Current middleware validates but doesn't refresh.
Recommended approach: Add token refresh middleware.
```

**Example - Plan:**
```
## Implementation Plan

https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/plans/2026-02-17-GH-0042-auth-refresh.md

Phases: 3 (middleware -> token refresh -> integration tests)
```

**Example - Review:**
```
## Plan Review

VERDICT: APPROVED
Full critique: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/reviews/2026-02-17-GH-0042-critique.md
```

### Discovery Protocol

To find a prior-phase artifact:

1. Fetch issue with comments: `ralph_hero__get_issue(owner, repo, number)`
2. Search comments for the section header (e.g., `## Research Document`)
3. If multiple comments match the same section header, use the **most recent** (last) match
4. Extract the URL from the first line after the header
5. Convert GitHub URL to local path: strip `https://github.com/OWNER/REPO/blob/main/` prefix
6. Read the local file

**URL to local path conversion:**
```
https://github.com/OWNER/REPO/blob/main/thoughts/shared/research/FILE.md
-> thoughts/shared/research/FILE.md
```

### Deterministic File Naming

Artifacts follow this naming convention:

| Type | Pattern | Example |
|------|---------|---------|
| Research | `thoughts/shared/research/YYYY-MM-DD-GH-NNNN-description.md` | `2026-02-17-GH-0042-auth-flow.md` |
| Plan | `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-description.md` | `2026-02-17-GH-0042-auth-refresh.md` |
| Group Plan | `thoughts/shared/plans/YYYY-MM-DD-group-GH-NNNN-description.md` | `2026-02-17-group-GH-0042-auth-suite.md` |
| Review | `thoughts/shared/reviews/YYYY-MM-DD-GH-NNNN-critique.md` | `2026-02-17-GH-0042-critique.md` |

The issue number (`GH-NNNN`) in the filename makes artifacts discoverable even without comments.

**Note on zero-padding**: Filenames use zero-padded 4-digit issue numbers (e.g., `GH-0042`). When constructing glob patterns from a plain issue number, try BOTH padded and unpadded forms: `*GH-${number}*` and `*GH-$(printf '%04d' $number)*`.

### Fallback Discovery

If a comment search fails (comment was never posted, was deleted, or scrolled past the comment limit):

1. **Glob fallback**: Search `thoughts/shared/{type}/*GH-{number}*` for the artifact. Try both unpadded (`*GH-42*`) and zero-padded (`*GH-0042*`) patterns.
2. **Group glob fallback**: If the standard glob fails for a group member, try `*group*GH-{primary}*` where `{primary}` is the primary issue number from the issue's group context (parent or first blocker).
3. **If found, self-heal**: Post the missing comment to the issue using the correct section header (see Self-Healing below).
4. **If not found**: Block and report the missing artifact.

### Self-Healing

When an artifact is found via glob fallback but the expected comment is missing, post it:

```
ralph_hero__create_comment
- owner: $RALPH_GH_OWNER
- repo: $RALPH_GH_REPO
- number: [issue-number]
- body: |
    ## [Section Header]

    https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/[local-path]

    (Self-healed: artifact was found on disk but not linked via comment)
```

This ensures subsequent phases find the artifact via the primary channel.

### Known Limitations

- **10-comment limit**: `get_issue` returns only the last 10 comments. For issues with many status updates, early comments (e.g., the research document comment) may scroll off. This is why the glob fallback is essential — it provides a reliable secondary discovery path when comments are no longer visible.
- **Group glob for non-primary issues**: Group plans use the primary issue number in filenames (e.g., `group-GH-0042-*.md`). Non-primary group members (e.g., GH-43, GH-44) won't match `*GH-43*`. The comment-based path handles groups correctly since the plan skill posts to ALL group issues. The glob fallback should try `*group*GH-{primary}*` after `*GH-{number}*` fails.
