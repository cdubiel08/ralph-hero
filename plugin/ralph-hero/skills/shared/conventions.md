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

## TaskUpdate Protocol

TaskUpdate is the primary channel for structured results between workers and the lead. SendMessage is for exceptions only -- escalations, blocking discoveries, or questions not answerable from the task description.

**Metadata for machines, description for humans**:
- `metadata`: Structured key-value pairs the lead reads programmatically (e.g., `artifact_path`, `result`, `sub_tickets`). Merges with existing metadata -- keys set at TaskCreate time persist alongside new result keys.
- `description`: Human-readable summary of what happened. The lead uses this for quick orientation and fallback.

**Standard input metadata** (set by lead at TaskCreate):
`issue_number`, `issue_url`, `command`, `phase`, `estimate`, `group_primary`, `group_members`, `artifact_path`, `worktree`, `stream_id`, `stream_primary`, `stream_members`, `epic_issue`

**When to avoid SendMessage**:
- Acknowledging receipt of a task (just start working)
- Reporting progress mid-task (update task description instead)
- Confirming you're still working (idle notifications handle this)
- Responding to idle notifications (they're informational)

**Lead communication**: Prefer tasks over messages. Don't nudge after assigning. Be patient with idle workers (>2 min before nudging). Update tasks, not messages, for redirection.

## Communication Discipline

### The Assignment Rule
After TaskUpdate(owner=...) for a worker's FIRST task (before spawn), do NOT SendMessage.
After TaskUpdate(owner=...) for a NEWLY ASSIGNED task to an IDLE worker, SendMessage to wake them.
After TaskUpdate(owner=...) in any other case, do NOT SendMessage.

### The Reporting Rule
Workers report via TaskUpdate(metadata={...}). SendMessage is for:
- Escalations (blocking discoveries, unanswerable questions)
- Responses to direct questions from teammates
Never for: acknowledgments, progress updates, task confirmations.

### The Nudge Rule
If a worker is idle with an assigned task, the problem is TaskList visibility, not communication.
Check the task exists in the team scope. Do NOT send a nudge message.
If the task is correctly scoped and the worker is still idle after 2 minutes, send ONE wake message.

## Escalation Protocol

When encountering complexity, uncertainty, or states that don't align with protocol, **escalate via GitHub issue comment** by @mentioning the appropriate person.

| Situation | Action |
|-----------|--------|
| Issue scope larger than estimated | @mention: "This is [M/L/XL] complexity. Needs re-estimation or splitting." |
| Missing context/requirements | @mention: "Cannot proceed. Need clarification on: [specific questions]." |
| Architectural decision needed | @mention: "Multiple valid approaches: [A vs B]. Need guidance." |
| Conflicting existing patterns | @mention: "Found conflicting patterns: [A] vs [B]. Which to follow?" |
| Security concern identified | @mention: "Potential security issue: [description]. Need review." |

**How to escalate:**

1. **Move issue to "Human Needed"**:
   ```
   ralph_hero__update_workflow_state(number, state="__ESCALATE__", command="[current-command]")
   ```
   For group plans, move ALL group issues to "Human Needed".

2. **Add comment with @mention**:
   ```
   ralph_hero__create_comment(number, body="@$RALPH_GH_OWNER Escalation: [issue description]")
   ```

3. **STOP and report**: Issue URL, status "Human Needed", brief reason.

## Link Formatting

| Reference type | Format |
|---------------|--------|
| File only | `[path/file.py](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py)` |
| With line | `[path/file.py:42](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42)` |
| Line range | `[path/file.py:42-50](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42-L50)` |

## Error Handling

- **Tool call failures**: If `update_workflow_state` returns an error, read the error message -- it contains valid states/intents and a Recovery action. Retry with corrected parameters.
- **State gate blocks**: Hooks enforce valid state transitions. Check the current workflow state and re-evaluate.
- **Postcondition failures**: Stop hooks verify expected outputs. Satisfy the requirement before retrying.

## Pipeline Handoff Protocol

Workers self-navigate the pipeline via the upfront task list:

1. Worker completes task → `TaskUpdate(status="completed", metadata={...})`
2. Stop hook fires → checks TaskList for unblocked, unclaimed tasks matching role
3. If found → blocks stop (exit 2), worker self-claims and executes
4. If not found → allows stop (exit 0), worker goes idle

**Key**: `blockedBy` chains enforce phase ordering. Workers only work on unblocked tasks.

## Spawn Template Protocol

### Template Location

A single spawn template lives at: `${CLAUDE_PLUGIN_ROOT}/templates/spawn/worker.md`

To resolve the path at runtime:
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
| `{SKILL_INVOCATION}` | Spawn table "Skill" column. Artifact path flags (see Artifact Passthrough Protocol) may be appended to `args` when available. | Always |
| `{REPORT_FORMAT}` | Role-specific result format from each SKILL.md "Team Result Reporting" section | Always |

### Group Context Resolution

If `IS_GROUP=true`: `{GROUP_CONTEXT} = "Group: GH-{PRIMARY} (GH-{A}, GH-{B}, GH-{C}). Plan covers all group issues."`
If `IS_GROUP=false`: `{GROUP_CONTEXT} = ""`

### Worktree Context Resolution

If worktree exists: `{WORKTREE_CONTEXT} = "Worktree: worktrees/GH-{ISSUE_NUMBER}/ (exists, reuse it)"`
If no worktree: `{WORKTREE_CONTEXT} = ""`

### Stream Context Resolution

If `IS_STREAM=true`: `{STREAM_CONTEXT} = "Stream stream-42-44: GH-42, GH-44 (shared: src/auth/). Plan covers stream issues only. Epic: GH-40."`
If `IS_STREAM=false`: `{STREAM_CONTEXT} = ""`

When `STREAM_CONTEXT` is non-empty, it replaces `GROUP_CONTEXT` (a stream IS a group subset).

### Empty Placeholder Line Removal

If a placeholder resolves to an empty string, remove the ENTIRE LINE containing that placeholder. Do not leave blank lines where optional context was omitted.

### Resolution Procedure

1. Read the template: `Bash("echo $CLAUDE_PLUGIN_ROOT")` then `Read(file_path="[resolved-root]/templates/spawn/worker.md")`
2. Look up the role in SKILL.md Section 6 spawn table
3. Substitute all `{PLACEHOLDER}` strings with values from `get_issue` response and spawn table
4. If a placeholder resolves to an empty string, remove the ENTIRE LINE containing it
5. Use the result as the `prompt` parameter in `Task()`
6. If artifact paths are available from prior phase results, append flags to `{SKILL_INVOCATION}` args:
   ```
   Skill(skill="ralph-hero:ralph-plan", args="42 --research-doc thoughts/shared/research/2026-02-21-GH-0042-auth-flow.md")
   ```

## Work Streams

Work streams partition a group of issues into independent subsets based on file overlap and `blockedBy` relationships. Each stream flows through plan -> implement -> PR independently.

### Stream ID Format
Deterministic, content-based: `stream-[sorted-issue-numbers]` (e.g., `stream-42-44`, `stream-43`).

### Naming Conventions

| Artifact | Single Issue | Group | Stream |
|----------|-------------|-------|--------|
| Plan filename | `YYYY-MM-DD-GH-NNNN-desc.md` | `YYYY-MM-DD-group-GH-NNNN-desc.md` | `YYYY-MM-DD-stream-GH-NNN-NNN-desc.md` |
| Worktree ID | `GH-[number]` | `GH-[primary]` | `GH-[EPIC]-stream-[SORTED-ISSUES]` |
| PR title | `[Title]` | `[Title]` | `[Title] [stream-X-Y of GH-EPIC]` |

### Lifecycle
- Streams are detected once (after all research completes) and are immutable for the session
- Research is per-issue (pre-stream); plans and PRs are per-stream
- Each stream tracks its own phase independently
- For epics with <=2 children, stream detection is skipped (single group, same as current behavior)

## Skill Invocation Convention

### Default: Fork via Task()

Skills should be invoked via forked subprocesses to isolate context:

```
Task(subagent_type="general-purpose",
     prompt="Skill(skill='ralph-hero:ralph-research', args='42')",
     description="Research GH-42")
```

### Note: Team Agents

Team members are spawned as typed subagents via `Task()`. Each team member invokes its skill inline:

```
Skill(skill="ralph-hero:ralph-research", args="42")
```

This works because the team system provides isolated context windows.

### Exception: Direct User Invocation

Users invoking skills directly (e.g., `/ralph-research 42`) run inline in their session.

## Sub-Agent Team Isolation

Skills that spawn internal sub-agents via `Task()` must ensure those sub-agents do NOT inherit team context.

**Rule**: Never pass `team_name` to internal `Task()` calls within skills.

**Correct**:
```
Task(subagent_type="codebase-locator", prompt="Find files related to ...")
```

**Incorrect**:
```
Task(subagent_type="codebase-locator", team_name=TEAM_NAME, prompt="Find files related to ...")
```

## Architecture Decision: Agent/Skill Separation (ADR-001)

**Status**: Validated (2026-02-19, GH-132)

| Layer | Name | Role | Location |
|-------|------|------|----------|
| 4 | Scripts | Terminal invocation | `scripts/ralph-loop.sh`, `scripts/ralph-team-loop.sh` |
| 3 | Skills | Capability + workflow logic | `skills/*/SKILL.md` |
| 2 | Agents | Scale + isolation (team workers) | `agents/*.md` |
| 1 | MCP Tools | Raw GitHub API operations | `mcp-server/src/tools/` |

**Key Principles**:
1. **Agents are thin wrappers**: 20-35 lines, define a task loop that dispatches to skills.
2. **Skills own workflow logic**: Complete procedure for one workflow phase.
3. **MCP tools are primitive operations**: No business logic.
4. **Orchestrators delegate, never implement**: Never research, plan, review, or implement directly.

## Artifact Comment Protocol

GitHub issue comments are the **primary source of truth** for all artifacts produced by the pipeline.

### Comment Section Headers

| Phase | Header | Content |
|-------|--------|---------|
| Research | `## Research Document` | GitHub URL to research `.md` file |
| Plan | `## Implementation Plan` | GitHub URL to plan `.md` file |
| Review | `## Plan Review` | VERDICT line + optional critique URL |
| Implementation | `## Implementation Complete` | PR URL, branch name, files changed |

### Comment Format

```
## [Section Header]

[GitHub URL to artifact file]

[Optional summary - 1-3 lines]
```

### Discovery Protocol

1. Fetch issue with comments: `ralph_hero__get_issue(owner, repo, number)`
2. Search comments for the section header (e.g., `## Research Document`)
3. If multiple comments match, use the **most recent** (last) match
4. Extract the URL from the first line after the header
5. Convert GitHub URL to local path: strip `https://github.com/OWNER/REPO/blob/main/` prefix
6. Read the local file

### Deterministic File Naming

| Type | Pattern | Example |
|------|---------|---------|
| Research | `thoughts/shared/research/YYYY-MM-DD-GH-NNNN-description.md` | `2026-02-17-GH-0042-auth-flow.md` |
| Plan | `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-description.md` | `2026-02-17-GH-0042-auth-refresh.md` |
| Group Plan | `thoughts/shared/plans/YYYY-MM-DD-group-GH-NNNN-description.md` | `2026-02-17-group-GH-0042-auth-suite.md` |
| Stream Plan | `thoughts/shared/plans/YYYY-MM-DD-stream-GH-NNN-NNN-description.md` | `2026-02-17-stream-GH-0042-0044-auth-refresh.md` |
| Review | `thoughts/shared/reviews/YYYY-MM-DD-GH-NNNN-critique.md` | `2026-02-17-GH-0042-critique.md` |

**Note on zero-padding**: Filenames use zero-padded 4-digit issue numbers (e.g., `GH-0042`). When constructing glob patterns, try BOTH padded and unpadded forms.

### Fallback Discovery

If a comment search fails:

1. **Glob fallback**: Search `thoughts/shared/{type}/*GH-{number}*`. Try both unpadded and zero-padded patterns.
2. **Group glob fallback**: Try `*group*GH-{primary}*` where `{primary}` is the primary issue number.
3. **Stream glob fallback**: Try `*stream*GH-{number}*` to find stream plans containing this issue.
4. **If found, self-heal**: Post the missing comment to the issue using the correct section header.
5. **If not found**: Block and report the missing artifact.

### Self-Healing

When an artifact is found via glob fallback but the expected comment is missing, post it with `(Self-healed: artifact was found on disk but not linked via comment)`.

### Known Limitations

- **10-comment limit**: `get_issue` returns only the last 10 comments. The glob fallback provides a reliable secondary discovery path.
- **Group glob for non-primary issues**: Group plans use the primary issue number in filenames. Non-primary group members won't match `*GH-43*`. Try `*group*GH-{primary}*` after `*GH-{number}*` fails.

## Artifact Passthrough Protocol

When the team lead or orchestrator already knows an artifact's local path (from a prior phase's result), it can pass the path directly to the next skill via argument flags, skipping the Artifact Comment Protocol's discovery steps.

### Flags

| Flag | Value | Consumed By |
|------|-------|-------------|
| `--research-doc` | Local path to research `.md` file | `ralph-plan` |
| `--plan-doc` | Local path to plan `.md` file | `ralph-impl`, `ralph-review` |

### Argument Format

```
{issue-number} --{flag} {local-path}
```

Examples:
```
42 --research-doc thoughts/shared/research/2026-02-21-GH-0042-auth-flow.md
42 --plan-doc thoughts/shared/plans/2026-02-21-GH-0042-auth-refresh.md
313 --plan-doc thoughts/shared/plans/2026-02-21-group-GH-0312-artifact-path-passthrough.md
```

Without flags (backward compatible):
```
42
```

### Parsing Rules

1. **First token** is always the issue number (required)
2. **Flags are optional** — presence of `--research-doc` or `--plan-doc` followed by a path
3. **Validate file exists**: If the path does not exist on disk, log a warning and fall back to standard Artifact Comment Protocol discovery
4. **Multiple flags**: Both flags may appear in the same invocation if a skill needs both artifacts (currently no skill does)

### Lead Extraction Rules

Orchestrators (ralph-team, ralph-hero) extract artifact paths from completed task descriptions or metadata:

| Result Line | Extracted Flag |
|-------------|---------------|
| `Document: [path]` (from RESEARCH COMPLETE) | `--research-doc [path]` |
| `Plan: [path]` (from PLAN COMPLETE) | `--plan-doc [path]` |
| `Plan: [path]` (from VALIDATION VERDICT) | `--plan-doc [path]` |
| `artifact_path` metadata key | Use value with appropriate flag based on phase |

### Consumer Skill Behavior

When a flag is provided with a valid path:
1. **Skip** the Artifact Comment Protocol discovery (comment search, URL conversion, glob fallback, self-healing)
2. **Read the file directly** from the provided path
3. **Continue** with the rest of the skill workflow

When a flag is missing, has an invalid path, or the file does not exist:
1. **Fall back** to standard Artifact Comment Protocol discovery
2. **Log**: `"Artifact flag path not found, falling back to discovery: [path]"` (if flag was provided but invalid)

### Relationship to Artifact Comment Protocol

Artifact Passthrough is an **optimization layer** on top of the Artifact Comment Protocol. It does not replace it:
- Comments remain the source of truth for artifact linking
- Passthrough skips the discovery steps when the path is already known
- Skills still post artifact comments when producing new artifacts
