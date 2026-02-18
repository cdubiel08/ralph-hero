---
date: 2026-02-17
status: draft
type: feature
parent_epic: 2026-02-17-ralph-hero-v3-architecture-epic.md
github_issues: []
---

# Plan 2: HOP Architecture - Higher-Order Prompts for Composable Agent Orchestration

## Overview

Replace ralph-team's inline spawn prompts with a Higher-Order Prompt (HOP) system inspired by Bowser. Spawn prompts become parameterized template files with `{PLACEHOLDER}` substitution. The orchestrator reads a template, fills in values from GitHub issue context, and spawns the agent. Adding a new workflow or modifying spawn behavior requires editing a template file, not the orchestrator skill.

## Current State Analysis

### Problem: Inline, Bloated Spawn Prompts

Ralph-team SKILL.md Section 6 defines spawn prompts inline:

```
Task(subagent_type="[agent-type]", team_name=TEAM_NAME, name="[role]",
     prompt="[Role] for #NNN: [title]. State: [state].
             [Artifacts: plan path, worktree, group context if applicable]
             [Codebase hints: 2-5 relevant directories/files]
             Invoke: Skill(skill='ralph-hero:[skill-name]', args='NNN')
             Embed results in task description via TaskUpdate.",
     description="[Role] #NNN")
```

And Section 6 "Spawn Prompt Requirements" says:
> **MUST include**: Issue number, title, description, workflow state, group context (if any), codebase starting points (2-5 relevant dirs/files), artifacts from prior phases (doc paths, worktree)

This is 8+ context fields per spawn. The guiding principle says agents should receive "just barely enough information that it has exactly what it needs to begin work." For a researcher that just needs to call `Skill(skill='ralph-hero:ralph-research', args='42')`, all they really need is the issue number.

### Problem: No Composability

To change spawn behavior, you must edit ralph-team SKILL.md - a 257-line file. This creates:
- Risk of breaking the orchestrator when editing spawn prompts
- No way to A/B test different prompt strategies
- No independent versioning of prompt templates
- The orchestrator is coupled to every agent's spawn format

### What Bowser Does

Bowser uses `{PROMPT}` placeholder templates in `.claude/commands/bowser/`:
```markdown
## Workflow
Navigate to Amazon and search for {PROMPT}.
Add the first result to cart.
Take a screenshot at checkout.
```

The HOP (`hop-automate.md`) resolves which template to use, substitutes `{PROMPT}`, and delegates. Adding a new workflow = drop a new `.md` file.

## Desired End State

After this plan:
- Spawn prompt templates live in `plugin/ralph-hero/templates/spawn/` as individual `.md` files
- Each template uses `{ISSUE_NUMBER}`, `{TITLE}`, `{STATE}`, `{ARTIFACTS}` placeholders
- The orchestrator (ralph-team) reads the template, substitutes values, and spawns
- Result reporting uses a standardized `{RESULT_FORMAT}` template per role
- Agent spawn prompts are <100 tokens of actual prompt text
- Adding a new agent role = creating a new template file (zero orchestrator changes)

### Verification
- [ ] Each spawn template is a standalone `.md` file in `templates/spawn/`
- [ ] No inline prompt construction remains in ralph-team SKILL.md
- [ ] A new template can be added without editing any orchestrator code
- [ ] Spawn prompts contain only issue number + skill invocation instruction

## What We're NOT Doing

- Rewriting skills themselves (that's Plan 3)
- Changing the memory layer (that's Plan 4)
- Modifying MCP tools or GitHub API integration
- Changing the state machine
- Building a template engine (we use simple string substitution)

## Implementation Approach

Create template files, then refactor ralph-team to use them. The substitution is trivial - the orchestrator reads the file, replaces placeholders with values from `get_issue`, and passes the result as the `prompt` parameter to `Task()`.

---

## Phase 1: Create Spawn Template Directory & Templates

### Overview
Create parameterized spawn prompt templates for each agent role. Each template contains the absolute minimum context an agent needs.

### Changes Required

#### 1. Create template directory

**Directory**: `plugin/ralph-hero/templates/spawn/` (new)

#### 2. Create researcher spawn template

**File**: `plugin/ralph-hero/templates/spawn/researcher.md`

```markdown
Research #{ISSUE_NUMBER}: {TITLE}.

Invoke: Skill(skill="ralph-hero:ralph-research", args="{ISSUE_NUMBER}")

On completion, update your task:
TaskUpdate(taskId="[your-task-id]", status="completed",
  description="RESEARCH COMPLETE: #{ISSUE_NUMBER} - {TITLE}\nDocument: [path]\nKey findings: [summary]\nTicket moved to: Ready for Plan")

Then check TaskList for more research tasks. If none, hand off per shared/conventions.md.
```

#### 3. Create planner spawn template

**File**: `plugin/ralph-hero/templates/spawn/planner.md`

```markdown
Plan #{ISSUE_NUMBER}: {TITLE}.
{GROUP_CONTEXT}

Invoke: Skill(skill="ralph-hero:ralph-plan", args="{ISSUE_NUMBER}")

On completion, update your task:
TaskUpdate(taskId="[your-task-id]", status="completed",
  description="PLAN COMPLETE: #{ISSUE_NUMBER}\nPlan: [path]\nPhases: [count]\nTicket moved to: Plan in Review")

Then check TaskList for more plan tasks. If none, hand off per shared/conventions.md.
```

#### 4. Create reviewer spawn template

**File**: `plugin/ralph-hero/templates/spawn/reviewer.md`

```markdown
Review plan for #{ISSUE_NUMBER}: {TITLE}.
{GROUP_CONTEXT}

Invoke: Skill(skill="ralph-hero:ralph-review", args="{ISSUE_NUMBER}")

On completion, update your task:
TaskUpdate(taskId="[your-task-id]", status="completed",
  description="REVIEW COMPLETE: #{ISSUE_NUMBER}\nVerdict: [APPROVED/NEEDS_ITERATION]\nCritique: [path if any]\nIssues: [list if any]")

Then check TaskList for more review tasks. If none, hand off per shared/conventions.md.
```

#### 5. Create implementer spawn template

**File**: `plugin/ralph-hero/templates/spawn/implementer.md`

```markdown
Implement #{ISSUE_NUMBER}: {TITLE}.
{WORKTREE_CONTEXT}

Invoke: Skill(skill="ralph-hero:ralph-impl", args="{ISSUE_NUMBER}")

On completion, update your task:
TaskUpdate(taskId="[your-task-id]", status="completed",
  description="IMPLEMENTATION COMPLETE\nTicket: #{ISSUE_NUMBER}\nPhases completed: [N] of [M]\nFiles modified: [list]\nTests: [PASSING/FAILING]\nCommit: [hash]\nWorktree: [path]")

DO NOT push to remote. The lead handles pushing and PR creation.
Then check TaskList for more implementation tasks. If none, notify team-lead.
```

#### 6. Create triager spawn template

**File**: `plugin/ralph-hero/templates/spawn/triager.md`

```markdown
Triage #{ISSUE_NUMBER}: {TITLE}.
Estimate: {ESTIMATE}.

Invoke: Skill(skill="ralph-hero:ralph-triage", args="{ISSUE_NUMBER}")

On completion, update your task:
TaskUpdate(taskId="[your-task-id]", status="completed",
  description="TRIAGE COMPLETE: #{ISSUE_NUMBER}\nAction: [CLOSE/SPLIT/RE-ESTIMATE/RESEARCH/KEEP]\nReason: [summary]")

Then check TaskList for more triage tasks.
```

#### 7. Create splitter spawn template

**File**: `plugin/ralph-hero/templates/spawn/splitter.md`

```markdown
Split #{ISSUE_NUMBER}: {TITLE}.
Too large for direct implementation (estimate: {ESTIMATE}).

Invoke: Skill(skill="ralph-hero:ralph-split", args="{ISSUE_NUMBER}")

On completion, update your task:
TaskUpdate(taskId="[your-task-id]", status="completed",
  description="SPLIT COMPLETE: #{ISSUE_NUMBER}\nSub-issues: [list of #NNN]\nTotal: [count] sub-issues")

Then check TaskList for more split tasks.
```

### Success Criteria

#### Automated Verification:
- [ ] All 6 template files exist in `plugin/ralph-hero/templates/spawn/`
- [ ] Each template contains `{ISSUE_NUMBER}` and `{TITLE}` placeholders
- [ ] No template exceeds 15 lines (enforces minimalism)
- [ ] Each template includes `Skill(skill="ralph-hero:ralph-*"` invocation instruction
- [ ] Each template includes the TaskUpdate result format

#### Manual Verification:
- [ ] Templates read naturally as complete spawn prompts when placeholders are filled

---

## Phase 2: Create Template Resolution Utility

### Overview
Create a shared conventions section or utility that defines how the orchestrator resolves templates. This is NOT a code engine - it's a protocol the orchestrator follows.

### Changes Required

#### 1. Add template resolution protocol to shared/conventions.md

**File**: `plugin/ralph-hero/skills/shared/conventions.md`

Append a new section:

```markdown
## Spawn Template Protocol

### Template Location
Spawn templates live at: `${CLAUDE_PLUGIN_ROOT}/templates/spawn/{role}.md`

Available templates: `researcher`, `planner`, `reviewer`, `implementer`, `triager`, `splitter`

### Placeholder Substitution

| Placeholder | Source | Required |
|-------------|--------|----------|
| `{ISSUE_NUMBER}` | Issue number from GitHub | Always |
| `{TITLE}` | Issue title from `get_issue` | Always |
| `{ESTIMATE}` | Issue estimate from `get_issue` | Triager, Splitter |
| `{GROUP_CONTEXT}` | See below | Planner, Reviewer (groups only) |
| `{WORKTREE_CONTEXT}` | See below | Implementer only |

### Group Context Resolution

If `IS_GROUP=true` for the issue:
```
{GROUP_CONTEXT} = "Group: #{PRIMARY} (#{A}, #{B}, #{C}). Plan covers all group issues."
```

If `IS_GROUP=false`:
```
{GROUP_CONTEXT} = ""  (empty string, placeholder line removed)
```

### Worktree Context Resolution

If worktree already exists:
```
{WORKTREE_CONTEXT} = "Worktree: worktrees/GH-{ISSUE_NUMBER}/ (exists, reuse it)"
```

If no worktree:
```
{WORKTREE_CONTEXT} = ""  (empty string, worktree will be created by skill)
```

### Resolution Procedure (for orchestrator)

1. Determine the role from the task subject (Research → `researcher.md`, Plan → `planner.md`, etc.)
2. Read the template file via `Read` tool
3. Replace all `{PLACEHOLDER}` strings with actual values from `get_issue` response
4. Remove any lines that are empty after substitution (optional context lines)
5. Use the result as the `prompt` parameter in `Task()`

### Template Naming Convention

Templates are named by role: `{role}.md` matching the agent type:
- `ralph-triager` agent → `triager.md` template
- `ralph-researcher` agent → `researcher.md` template
- `ralph-planner` agent → `planner.md` template
- `ralph-advocate` agent → `reviewer.md` template
- `ralph-implementer` agent → `implementer.md` template
```

### Success Criteria

#### Automated Verification:
- [ ] `shared/conventions.md` contains "## Spawn Template Protocol" section
- [ ] All placeholder names and their sources are documented
- [ ] Resolution procedure is step-by-step

#### Manual Verification:
- [ ] Protocol is clear enough that an LLM following it would produce correct spawn prompts

---

## Phase 3: Refactor ralph-team to Use Templates

### Overview
Replace inline spawn prompt construction in ralph-team SKILL.md with template-based resolution. The orchestrator reads templates, substitutes placeholders, and spawns agents.

### Changes Required

#### 1. Replace Section 6 (Teammate Spawning) in ralph-team SKILL.md

**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`

Replace the current Section 6 with:

```markdown
## Section 6 - Teammate Spawning

No prescribed roster -- spawn what's needed. Each teammate receives a minimal prompt from a template.

### Spawn Procedure

1. **Determine role** from the pending task subject:
   | Task subject contains | Role | Template | Agent type |
   |----------------------|------|----------|------------|
   | "Triage" | triager | `triager.md` | ralph-triager |
   | "Split" | splitter | `splitter.md` | ralph-triager |
   | "Research" | researcher | `researcher.md` | ralph-researcher |
   | "Plan" (not "Review") | planner | `planner.md` | ralph-planner |
   | "Review" | reviewer | `reviewer.md` | ralph-advocate |
   | "Implement" | implementer | `implementer.md` | ralph-implementer |

2. **Read template**: `Read(file_path="${CLAUDE_PLUGIN_ROOT}/templates/spawn/{template}")`

3. **Substitute placeholders** from the issue context gathered in Section 2-3:
   - `{ISSUE_NUMBER}` → issue number
   - `{TITLE}` → issue title
   - `{ESTIMATE}` → issue estimate
   - `{GROUP_CONTEXT}` → group line if IS_GROUP, empty if not
   - `{WORKTREE_CONTEXT}` → worktree path if exists, empty if not

4. **Spawn**:
   ```
   Task(subagent_type="[agent-type]", team_name=TEAM_NAME, name="[role]",
        prompt=[resolved template content],
        description="[Role] #NNN")
   ```

### Per-Role Instance Limits

- **Research**: Up to 3 parallel (`researcher`, `researcher-2`, `researcher-3`)
- **Implementation**: Up to 2 if plan has non-overlapping file ownership
- **All other roles**: Single worker

### Naming Convention

- Single instance: `"triager"`, `"researcher"`, `"planner"`, `"reviewer"`, `"implementer"`
- Multiple instances: `"researcher-2"`, `"researcher-3"`, `"implementer-2"`
```

#### 2. Remove old "Spawn Template" and "Per-Role Reference" subsections

The old subsections in Section 6 (spawn template code block, per-role table, spawn prompt requirements) are replaced by the new procedure above.

#### 3. Remove "Spawn Prompt Requirements" subsection

The old requirements list:
> **MUST include**: Issue number, title, description, workflow state, group context...
> **DO NOT include**: conversation history, document contents, code snippets...

is now implicit in the templates themselves. Templates define exactly what's included. Remove this subsection.

### Success Criteria

#### Automated Verification:
- [ ] ralph-team SKILL.md Section 6 references template files, not inline prompts
- [ ] No inline `prompt="..."` construction longer than 1 line remains in Section 6
- [ ] The word "codebase hints" does not appear in ralph-team SKILL.md (was removed)
- [ ] Template file paths use `${CLAUDE_PLUGIN_ROOT}` variable

#### Manual Verification:
- [ ] Ralph-team orchestrator can spawn agents using template-based prompts
- [ ] Agents receive correctly substituted prompts with issue context filled in

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation that team spawning works correctly with templates before proceeding.

---

## Phase 4: Refactor ralph-hero to Use Templates

### Overview
Apply the same template-based spawning to ralph-hero (the sequential orchestrator). Currently ralph-hero spawns with inline prompts like:
```
Task(subagent_type="general-purpose", run_in_background=true,
     prompt="Use Skill(skill='ralph-hero:ralph-research', args='NNN') to research issue #NNN: [title].",
     description="Research #NNN")
```

### Changes Required

#### 1. Update ralph-hero SKILL.md spawn prompts

**File**: `plugin/ralph-hero/skills/ralph-hero/SKILL.md`

For each phase (EXPANDING, RESEARCHING, PLANNING, REVIEWING, IMPLEMENTING), replace inline prompts with template reads:

**EXPANDING phase** - replace:
```
prompt="Use Skill(skill='ralph-hero:ralph-split', args='NNN') to split issue #NNN."
```
with:
```
1. Read template: Read("${CLAUDE_PLUGIN_ROOT}/templates/spawn/splitter.md")
2. Substitute {ISSUE_NUMBER} and {TITLE} from the issue
3. Use resolved template as prompt
```

**RESEARCHING phase** - replace:
```
prompt="Use Skill(skill='ralph-hero:ralph-research', args='NNN') to research issue #NNN: [title]."
```
with template resolution using `researcher.md`.

**PLANNING phase** - replace inline with template resolution using `planner.md`.

**REVIEWING phase** - replace inline with template resolution using `reviewer.md`.

**IMPLEMENTING phase** - replace inline with template resolution using `implementer.md`.

#### 2. Standardize Task subagent_type

Currently ralph-hero uses `subagent_type="general-purpose"` for all spawns. The correct approach is to use the role-specific agent types when in team mode, and `general-purpose` in hero mode (since hero doesn't use agent teams).

Keep `general-purpose` for ralph-hero (it works fine for sequential mode). Ralph-team already uses role-specific types.

### Success Criteria

#### Automated Verification:
- [ ] No inline `prompt="Use Skill..."` strings remain in ralph-hero SKILL.md
- [ ] Each phase references a template file for prompt construction
- [ ] All template reads use `${CLAUDE_PLUGIN_ROOT}/templates/spawn/` path

#### Manual Verification:
- [ ] Running `/ralph-hero [issue-number]` still works end-to-end with template-based spawning

---

## Phase 5: Create Result Reporting Templates

### Overview
Standardize how agents report results back via TaskUpdate. Currently each agent format is defined inline in their agent `.md` file. Create result templates that match the spawn templates.

### Changes Required

#### 1. Create result template directory

**Directory**: `plugin/ralph-hero/templates/results/` (new)

#### 2. Create result templates

**File**: `plugin/ralph-hero/templates/results/research-complete.md`
```
RESEARCH COMPLETE: #{ISSUE_NUMBER} - {TITLE}
Document: {DOCUMENT_PATH}
Key findings: {FINDINGS_SUMMARY}
Ticket moved to: Ready for Plan
```

**File**: `plugin/ralph-hero/templates/results/plan-complete.md`
```
PLAN COMPLETE: #{ISSUE_NUMBER} - {TITLE}
Plan: {PLAN_PATH}
Phases: {PHASE_COUNT}
Issues: {ISSUE_LIST}
Ticket moved to: Plan in Review
```

**File**: `plugin/ralph-hero/templates/results/review-complete.md`
```
REVIEW COMPLETE: #{ISSUE_NUMBER} - {TITLE}
Verdict: {VERDICT}
Critique: {CRITIQUE_PATH}
Issues: {ISSUE_LIST}
```

**File**: `plugin/ralph-hero/templates/results/impl-complete.md`
```
IMPLEMENTATION COMPLETE: #{ISSUE_NUMBER} - {TITLE}
Phases completed: {PHASES_DONE} of {PHASES_TOTAL}
Files modified: {FILE_LIST}
Tests: {TEST_STATUS}
Commit: {COMMIT_HASH}
Worktree: {WORKTREE_PATH}
```

**File**: `plugin/ralph-hero/templates/results/triage-complete.md`
```
TRIAGE COMPLETE: #{ISSUE_NUMBER} - {TITLE}
Action: {ACTION}
Reason: {REASON}
```

**File**: `plugin/ralph-hero/templates/results/split-complete.md`
```
SPLIT COMPLETE: #{ISSUE_NUMBER} - {TITLE}
Sub-issues: {SUB_ISSUE_LIST}
Total: {SUB_ISSUE_COUNT} sub-issues
```

### Success Criteria

#### Automated Verification:
- [ ] All 6 result templates exist in `plugin/ralph-hero/templates/results/`
- [ ] Each template matches the TaskUpdate description format expected by agents
- [ ] Template placeholders match what the skill would naturally produce

#### Manual Verification:
- [ ] Result templates are referenced by agent `.md` files or by spawn templates

---

## Testing Strategy

### Unit Tests:
- Verify each template file is valid markdown
- Verify all required placeholders are present
- Verify placeholder substitution produces valid prompts

### Integration Tests:
- Run ralph-team on a test issue and verify spawn prompts match templates
- Verify agents receive correct context after substitution

### Manual Testing Steps:
1. Create a test GitHub issue
2. Run `/ralph-team [test-issue]`
3. Inspect spawned agent prompts (via hook logging or direct observation)
4. Verify prompts are minimal and correctly substituted

## References

- Bowser HOP pattern: https://github.com/disler/bowser
- Current spawn templates: `plugin/ralph-hero/skills/ralph-team/SKILL.md` Section 6
- Agent definitions: `plugin/ralph-hero/agents/*.md`
- Shared conventions: `plugin/ralph-hero/skills/shared/conventions.md`
