---
date: 2026-02-14
status: draft
linear_ticket: LAN-383
linear_url: https://linear.app/landcrawler-ai/issue/LAN-383/deterministic-workflow-management-for-ralph-hero
---

# Deterministic Workflow Management for Ralph-Hero

## Overview

Improve determinism and reduce reliance on prompt-based decision-making in ralph-hero's workflow orchestration. Currently, critical workflow decisions (phase selection, convergence checking, pipeline routing, child advancement) are embedded as prose instructions that the LLM must interpret. This plan moves decision logic into MCP tools and hooks where outcomes are computed programmatically, leaving prompts focused on behavioral guidance rather than control flow.

## Current State Analysis

### What's Already Deterministic (Code-Enforced)

| Mechanism | Files | What It Enforces |
|---|---|---|
| State transition validation | `*-state-gate.sh` + `ralph-state-machine.json` | Invalid state transitions blocked |
| Branch enforcement | `branch-gate.sh` | Must be on main branch |
| Artifact uniqueness | `pre-artifact-validator.sh` | One document per ticket |
| Prerequisites | `*-required.sh` hooks | Research before plan, plan before impl |
| Postconditions | `*-postcondition.sh` hooks | Work product exists after command |
| Task dependencies | Claude Code SDK `addBlockedBy` | Phase ordering in ralph-team |

### What's Still Prompt-Dependent (Non-Deterministic)

| Decision Point | Risk | Current Location |
|---|---|---|
| Phase selection (ralph-hero) | LLM misreads tree state table | `ralph-hero/SKILL.md:159-169` |
| Pipeline position (ralph-team) | Wrong teammate spawned | `ralph-team/SKILL.md:131-139` |
| Convergence checking | Planning starts before all research done | `ralph-plan/SKILL.md:121-133` |
| Child issue advancement | Children fall behind parent | `ralph-team/SKILL.md:273-282` |
| Issue selection (dispatch loop) | Picks wrong/blocked issue | `ralph-team/SKILL.md:284-304` |
| Group tracking | Lost if task descriptions malformed | `ralph-team/SKILL.md:150-158` |

### Key Discoveries

1. **`auto-state.sh` exists but is not wired** (`hooks.json` has no reference, no skill frontmatter references it)
2. **`updatedInput` was broken for Linear MCP** but has **never been tested** for the ralph-hero custom MCP server
3. **`semantic_states` section still exists** in `ralph-state-machine.json:264-288` ready for use
4. **The ralph-hero MCP server** (`mcp-server/src/`) is the right home for new decision tools — it already has `detect_group`, `get_issue`, `list_issues`

## Desired End State

A workflow where:

1. **Phase selection is computed**: New MCP tool returns `{ phase: "RESEARCHING", reason: "3 issues in Research Needed" }` instead of LLM interpreting a markdown table
2. **Convergence is verified programmatically**: New MCP tool returns `{ converged: false, blocking: [{ number: 44, state: "Research in Progress" }] }` instead of LLM checking each issue manually
3. **Children are advanced atomically**: New MCP tool advances all children in one call instead of relying on prompt to remember
4. **Issue selection is deterministic**: New MCP tool returns highest-priority actionable issue for a given role
5. **Semantic intents work via MCP server-side resolution**: Skills use `__LOCK__`/`__COMPLETE__` with a required `command` parameter, and the MCP server resolves them to actual state names with full per-command validation
6. **Prompts are thin behavioral wrappers**: Orchestrator prompts call tools for decisions and contain only behavioral guidance (momentum, error recovery, communication patterns)

### Verification

- [ ] `ralph_hero__detect_pipeline_position` returns correct phase for all 7 workflow states
- [ ] `ralph_hero__check_convergence` correctly identifies blocking issues
- [ ] `ralph_hero__advance_children` moves children to target state
- [ ] `ralph_hero__pick_actionable_issue` returns highest-priority issue for each role
- [ ] ralph-hero SKILL.md uses tool calls instead of prose tables for phase detection
- [ ] ralph-team SKILL.md uses tool calls instead of prose tables for pipeline routing
- [ ] Orchestrator prompts are 30-50% shorter after removing decision prose
- [ ] End-to-end test: run ralph-hero on a test issue tree, verify deterministic phase progression

## What We're NOT Doing

- **Not changing the state machine** — same states, same transitions
- **Not adding new workflow states** — GitHub Projects fields unchanged
- **Not replacing hooks** — existing enforcement hooks stay
- **Not changing individual skill behavior** — skills still do the same work; only their `update_workflow_state` calls gain a `command` parameter and use semantic intents (Phase 4)
- **Not building external control loops** — behavioral momentum stays prompt-based (no IPC)
- **Not creating a separate decision service** — logic lives in the existing MCP server

## Tool Reference Audit (2026-02-15)

Cross-referenced all SKILL.md files and agent frontmatter against the 20 registered MCP tools in `ralph-hero-mcp-server`. **Result: no ghost tool references found.** Every `ralph_hero__*` tool referenced in skills and agents exists in the MCP server.

Phase 1 introduces 4 new tools (`detect_pipeline_position`, `check_convergence`, `advance_children`, `pick_actionable_issue`). Phase 3 will reference these — implementation order ensures they exist before prompts use them. Agent frontmatter does NOT need updating for Phase 1 tools since orchestrators (ralph-hero, ralph-team) call them directly at the top level, not via agent teammates.

## Implementation Approach

**Strategy**: Bottom-up — build tools, test, then simplify prompts.

1. **Phase 0**: Validate `updatedInput` for ralph-hero MCP tools — **COMPLETE** (broken, confirmed 2026-02-15)
2. **Phase 1**: Build 4 new MCP decision tools in the existing MCP server
3. **Phase 2**: Add convergence enforcement hook
4. **Phase 3**: Simplify orchestrator prompts to use new tools
5. **Phase 4**: MCP server-side semantic state resolution with required `command` parameter (replaces hook approach)
6. **Phase 5**: Integration testing

---

## Phase 0: Validate `updatedInput` for Ralph-Hero MCP — COMPLETE

### Result: `updatedInput` does NOT work for MCP tools (confirmed 2026-02-15)

**Test environment**: Claude Code 2.1.42, ralph-hero MCP server (custom), test issue #16

**Procedure**:
1. Wired `auto-state.sh` into `hooks.json` as first PreToolUse hook for `ralph_hero__update_workflow_state`
2. Set `RALPH_COMMAND=research` in environment
3. Invoked `ralph_hero__update_workflow_state(owner=cdubiel08, repo=ralph-hero, number=16, state="__LOCK__")`
4. Hook produced correct output: `modifiedInput: { "state": "Research in Progress" }`

**Result**: MCP server received the raw `__LOCK__` string and returned error: `Option "__LOCK__" not found for field "Workflow State"`. The issue remained in "Research Needed" — unchanged.

**Conclusion**: `updatedInput` / `modifiedInput` in PreToolUse hooks is **not applied to MCP tool parameters** in Claude Code 2.1.42. This is consistent with the prior finding on Claude Code 2.1.37 for the Linear MCP plugin. The behavior is a platform limitation, not server-specific.

**Implications for this plan**:
- Phase 4 (wire auto-state via hooks) → **SKIPPED** — hook-based approach cannot work
- Phase 4 Alternative (MCP server-side resolution) → **ACTIVATED** — semantic intents resolved inside the MCP server itself
- `auto-state.sh` remains dormant — may become useful if Claude Code fixes `updatedInput` in the future
- `semantic_states` section in `ralph-state-machine.json` is still valuable as a data source for MCP server-side resolution

**Cleanup**: Test issue #16 closed. `hooks.json` reverted to original (auto-state.sh removed).

---

## Phase 1: MCP Decision Tools

### Overview

Add 4 new tools to the ralph-hero MCP server that encapsulate workflow decision logic currently embedded in prompt prose. These tools return structured JSON that the LLM acts on without interpretation.

### Changes Required

#### 1. New tool: `ralph_hero__detect_pipeline_position`

**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: Add new tool registration

**Tool spec**:
- **Name**: `ralph_hero__detect_pipeline_position`
- **Description**: "Determine the current pipeline position for an issue or group. Returns the phase to execute and remaining phases."
- **Parameters**: `owner`, `repo`, `number` (issue number)
- **Returns**:
  ```typescript
  {
    phase: "SPLIT" | "TRIAGE" | "RESEARCH" | "PLAN" | "REVIEW" | "IMPLEMENT" | "COMPLETE" | "HUMAN_GATE" | "TERMINAL",
    reason: string,  // Human-readable explanation
    remainingPhases: string[],  // e.g., ["research", "plan", "review", "implement", "pr"]
    issues: Array<{
      number: number,
      title: string,
      workflowState: string,
      estimate: string | null,
    }>,
    convergence: {
      required: boolean,
      met: boolean,
      blocking: Array<{ number: number, state: string }>,
    },
    isGroup: boolean,
    groupPrimary: number | null,
  }
  ```

**Logic** (replaces the markdown tables in both orchestrators):

```typescript
function detectPhase(issues: Issue[]): PipelinePosition {
  // Check for M/L/XL issues needing split
  const oversized = issues.filter(i => ["M", "L", "XL"].includes(i.estimate));
  if (oversized.length > 0) {
    return { phase: "SPLIT", reason: `${oversized.length} issues need splitting`, ... };
  }

  // Check if any need research
  const needsResearch = issues.filter(i => i.workflowState === "Research Needed");
  const inResearch = issues.filter(i => i.workflowState === "Research in Progress");
  if (needsResearch.length > 0 || inResearch.length > 0) {
    return { phase: "RESEARCH", reason: `${needsResearch.length} need research, ${inResearch.length} in progress`, ... };
  }

  // Check convergence for planning
  const readyForPlan = issues.filter(i => i.workflowState === "Ready for Plan");
  if (readyForPlan.length === issues.length) {
    return { phase: "PLAN", reason: "All issues ready for planning", convergence: { met: true }, ... };
  }

  // Check for plans in review
  const planInReview = issues.filter(i => i.workflowState === "Plan in Review");
  const planInProgress = issues.filter(i => i.workflowState === "Plan in Progress");
  if (planInReview.length > 0 || planInProgress.length > 0) {
    return { phase: "REVIEW", reason: `${planInReview.length} plans to review`, ... };
  }

  // Only "Plan in Review" with no auto-approve -> HUMAN_GATE
  if (planInReview.length === issues.length) {
    return { phase: "HUMAN_GATE", reason: "Plans awaiting human approval", ... };
  }

  // Check for implementation
  const inProgress = issues.filter(i => i.workflowState === "In Progress");
  if (inProgress.length > 0) {
    return { phase: "IMPLEMENT", reason: `${inProgress.length} issues in progress`, ... };
  }

  // Check for completion
  const inReview = issues.filter(i => ["In Review", "Done"].includes(i.workflowState));
  if (inReview.length === issues.length) {
    return { phase: "TERMINAL", reason: "All issues in review or done", ... };
  }

  // Check for human needed
  const humanNeeded = issues.filter(i => i.workflowState === "Human Needed");
  if (humanNeeded.length > 0) {
    return { phase: "TERMINAL", reason: `${humanNeeded.length} issues need human intervention`, ... };
  }

  // Mixed state — return most actionable
  return { phase: "RESEARCH", reason: "Mixed states, defaulting to earliest incomplete phase", ... };
}
```

**Error handling**: If the issue doesn't exist or isn't in the project, return:
```json
{ "error": "Issue #NNN not found in project. Recovery: verify the issue number is correct and the issue has been added to the project via ralph_hero__create_issue or ralph_hero__get_issue." }
```
If the issue has no workflow state set, include it in the response with `workflowState: "unknown"` and set `phase: "TRIAGE"` with `reason: "Issue #NNN has no workflow state; triage first."`.

#### 2. New tool: `ralph_hero__check_convergence`

**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: Add new tool registration

**Tool spec**:
- **Name**: `ralph_hero__check_convergence`
- **Description**: "Check if all issues in a group have reached the required state for the next phase. Returns convergence status with details on blocking issues."
- **Parameters**: `owner`, `repo`, `number` (any issue in the group), `targetState` (the state all issues must be in)
- **Returns**:
  ```typescript
  {
    converged: boolean,
    targetState: string,
    total: number,
    ready: number,
    blocking: Array<{
      number: number,
      title: string,
      currentState: string,
      distanceToTarget: number,  // How many transitions away
    }>,
    recommendation: "proceed" | "wait" | "escalate",
  }
  ```

**Logic**:
- Uses existing `detect_group` to find all group members
- Checks each member's `workflowState` against `targetState`
- Returns structured result with blocking details

**Error handling**:
- Invalid `targetState` → `{ "error": "Unknown target state 'Foo'. Valid states: Backlog, Research Needed, Research in Progress, Ready for Plan, Plan in Progress, Plan in Review, In Progress, In Review, Done. Recovery: retry with a valid state name." }`
- Issue not part of a group → return `{ converged: true, total: 1, ready: 1, blocking: [], recommendation: "proceed" }` (single issue trivially converges)

#### 3. New tool: `ralph_hero__advance_children`

**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`
**Changes**: Add new tool registration

**Tool spec**:
- **Name**: `ralph_hero__advance_children`
- **Description**: "Advance all child/sub-issues of a parent to match the parent's new state. Only advances children that are in earlier workflow states."
- **Parameters**: `owner`, `repo`, `number` (parent issue), `targetState` (state to advance children to)
- **Returns**:
  ```typescript
  {
    advanced: Array<{ number: number, fromState: string, toState: string }>,
    skipped: Array<{ number: number, currentState: string, reason: string }>,
    errors: Array<{ number: number, error: string }>,
  }
  ```

**Logic**:
- Lists sub-issues of the parent
- For each child: compares current state to target state using state machine ordering
- Advances only children in earlier states
- Returns structured result (no silent failures)

**State ordering** (hardcoded in MCP server, matching state machine):
```typescript
const STATE_ORDER = [
  "Backlog", "Research Needed", "Research in Progress",
  "Ready for Plan", "Plan in Progress", "Plan in Review",
  "In Progress", "In Review", "Done"
];
```

**Error handling**:
- Invalid `targetState` → same pattern as check_convergence (list valid states, suggest recovery)
- No sub-issues found → return `{ advanced: [], skipped: [], errors: [] }` with no error (idempotent)
- Individual child state update fails → include in `errors` array with `{ number: N, error: "Failed to update: [reason]. Recovery: retry advance_children or update this child manually via update_workflow_state." }`. Other children still proceed (partial success is ok).

#### 4. New tool: `ralph_hero__pick_actionable_issue`

**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: Add new tool registration

**Tool spec**:
- **Name**: `ralph_hero__pick_actionable_issue`
- **Description**: "Find the highest-priority issue that matches the given workflow state and is not blocked or locked. Used by dispatch loop to find work for idle teammates."
- **Parameters**: `owner`, `repo`, `workflowState` (e.g., "Research Needed"), `maxEstimate` (optional, default "S")
- **Returns**:
  ```typescript
  {
    found: boolean,
    issue: {
      number: number,
      title: string,
      description: string,
      workflowState: string,
      estimate: string | null,
      priority: string | null,
      isLocked: boolean,
      blockedBy: Array<{ number: number, title: string }>,
    } | null,
    alternatives: number,  // How many other issues match but are lower priority
  }
  ```

**Logic**:
- Queries issues by `workflowState`
- Filters out locked issues (in a `*_in_Progress` state)
- Filters out issues with unresolved blockers
- Filters by estimate (XS/S by default)
- Sorts by priority (P0 > P1 > P2 > P3 > none)
- Returns the top candidate

**Error handling**:
- Invalid `workflowState` → `{ "error": "Unknown workflow state 'Foo'. Valid states: Backlog, Research Needed, Ready for Plan, Plan in Review, In Progress. Recovery: retry with a valid state name. Common states for dispatch: 'Research Needed' (for researchers), 'Ready for Plan' (for planners), 'Plan in Review' (for reviewers)." }`
- No matching issues → `{ found: false, issue: null, alternatives: 0 }` (not an error — agent should check other states or shut down idle teammate)
- Invalid `maxEstimate` → `{ "error": "Unknown estimate 'Foo'. Valid estimates: XS, S, M, L, XL. Recovery: retry with a valid estimate or omit for default (S)." }`

### Success Criteria

#### Automated Verification
- [x] MCP server builds cleanly: `cd mcp-server && npm run build`
- [x] All 4 new tools appear in tool listing: `ralph_hero__detect_pipeline_position`, `ralph_hero__check_convergence`, `ralph_hero__advance_children`, `ralph_hero__pick_actionable_issue`
- [x] Unit tests pass for phase detection logic with all 7 workflow states
- [x] Unit tests pass for convergence checking (converged/not-converged/mixed)
- [x] Unit tests pass for state ordering comparison

#### Manual Verification
- [ ] `detect_pipeline_position` returns correct phase for a test issue
- [ ] `check_convergence` correctly identifies a non-converged group
- [ ] `advance_children` moves children to target state
- [ ] `pick_actionable_issue` returns highest-priority unblocked issue

**Implementation Note**: Build and test all 4 tools before modifying any prompts. The tools should work standalone.

---

## Phase 2: Convergence Enforcement Hook

### Overview

Add a PreToolUse hook that blocks planning transitions unless group convergence is verified. This is the highest-value enforcement currently missing — the only thing preventing premature planning is a prompt instruction.

### Changes Required

#### 1. New hook: `convergence-gate.sh`

**File**: `plugin/ralph-hero/hooks/scripts/convergence-gate.sh`
**Changes**: Create new file

```bash
#!/bin/bash
# convergence-gate.sh
# PreToolUse: Block planning transitions unless all group members are ready
#
# Fires on: ralph_hero__update_workflow_state
# Blocks: Transitions to "Plan in Progress" if group isn't converged
#
# Uses ralph_hero__check_convergence internally (via direct GitHub API)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"

read_input > /dev/null

# Only check transitions TO planning lock state
requested_state=$(get_field '.tool_input.state')
if [[ "$requested_state" != "Plan in Progress" ]]; then
  allow
fi

# Get the issue number being transitioned
issue_number=$(get_field '.tool_input.number')
if [[ -z "$issue_number" ]]; then
  allow  # Can't check without issue number
fi

# Query group membership and check convergence
# Uses the MCP server's detect_group endpoint via curl to the running server
# OR reads from cached group detection in environment
# (Implementation detail: may need to shell out to GitHub API directly
#  since hooks can't call MCP tools)

# Alternative: Check environment variable set by orchestrator
if [[ -n "${RALPH_CONVERGENCE_VERIFIED:-}" ]]; then
  allow  # Orchestrator already verified convergence via MCP tool
fi

# If no verification flag, warn but don't block
# (Blocking would require GitHub API access from the hook, which adds complexity)
cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": "WARNING: Planning transition to 'Plan in Progress' for #$issue_number. Ensure convergence was verified via ralph_hero__check_convergence before proceeding. If not, check that ALL group members are in 'Ready for Plan' state."
  }
}
EOF
exit 0
```

**Design note**: Hooks can't call MCP tools, so full convergence verification must happen in the orchestrator via the MCP tool. The hook provides a safety reminder. The `RALPH_CONVERGENCE_VERIFIED` env var pattern allows the orchestrator to signal that convergence was checked.

#### 2. Wire convergence-gate.sh into skill frontmatter

**File**: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`
**Changes**: Add convergence-gate hook to PreToolUse matchers for `ralph_hero__update_workflow_state`

### Success Criteria

#### Automated Verification
- [ ] Hook script is syntactically valid: `bash -n convergence-gate.sh`
- [ ] Hook is wired in ralph-plan SKILL.md frontmatter
- [ ] Non-planning transitions pass through without warning

#### Manual Verification
- [ ] Planning transition shows convergence warning if `RALPH_CONVERGENCE_VERIFIED` not set
- [ ] Planning transition passes cleanly if convergence was verified

---

## Phase 3: Simplify Orchestrator Prompts

### Overview

Replace prose decision tables in both orchestrator SKILL.md files with calls to the new MCP decision tools. This is where the actual determinism improvement happens — prompts stop interpreting tables and start acting on computed results.

### Changes Required

#### 1. Rewrite ralph-hero SKILL.md Step 2 (Phase Detection)

**File**: `plugin/ralph-hero/skills/ralph-hero/SKILL.md`
**Changes**: Replace lines 158-169 (prose decision table)

**Before** (prompt interprets markdown table):
```markdown
### Step 2: Determine Current State

Based on the tree analysis, determine which phase to execute:

| Tree State | Action |
|------------|--------|
| Has M/L/XL issues (estimate in {"M", "L", "XL"}) | -> EXPANDING phase |
| All XS/S, some in "Research Needed" | -> RESEARCHING phase |
| All XS/S, all in "Ready for Plan" | -> PLANNING phase |
| All in "Plan in Review" | -> HUMAN GATE (stop) |
| All in "In Progress" | -> IMPLEMENTING phase |
| All in "In Review" or "Done" | -> COMPLETE (stop) |
```

**After** (tool computes the answer):
```markdown
### Step 2: Determine Current State

Query the pipeline position tool:

```
ralph_hero__detect_pipeline_position(owner=$RALPH_GH_OWNER, repo=$RALPH_GH_REPO, number=[ROOT-NUMBER])
```

The tool returns:
- `phase`: The exact phase to execute (SPLIT, RESEARCH, PLAN, REVIEW, IMPLEMENT, etc.)
- `reason`: Why this phase was selected
- `convergence`: Whether all issues are ready for the next gate
- `issues`: Current state of all issues in the group

Execute the phase indicated by the `phase` field. Do NOT interpret workflow states yourself — trust the tool's decision.
```

#### 2. Rewrite ralph-hero SKILL.md Convergence Check

**File**: `plugin/ralph-hero/skills/ralph-hero/SKILL.md`
**Changes**: Replace lines 263-298 (prose convergence checking)

**Before** (LLM queries each issue and compares):
```markdown
## PHASE: CONVERGENCE CHECK

1. **Query tree state**:
   For each issue in the group, check workflow state:
   ralph_hero__get_issue(...)

2. **Check convergence**:
   If ALL leaves are in "Ready for Plan":
     -> Proceed to PLANNING phase
```

**After** (tool computes convergence):
```markdown
## PHASE: CONVERGENCE CHECK

```
ralph_hero__check_convergence(
  owner=$RALPH_GH_OWNER,
  repo=$RALPH_GH_REPO,
  number=[ROOT-NUMBER],
  targetState="Ready for Plan"
)
```

If `converged` is `true`: Proceed to PLANNING phase.
If `converged` is `false`: Report the `blocking` issues and STOP.
```

#### 3. Rewrite ralph-team SKILL.md Section 3 (Pipeline Position)

**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Changes**: Replace lines 127-148 (prose pipeline mapping table)

**Before** (LLM interprets table):
```markdown
## Section 3 - State Detection & Pipeline Position

| Workflow State | Estimate | Pipeline Position | Remaining Phases |
|---|---|---|---|
| Backlog | M/L/XL | SPLIT | split -> research -> plan -> ... |
...
```

**After** (tool computes position):
```markdown
## Section 3 - State Detection & Pipeline Position

Query the pipeline position tool:

```
ralph_hero__detect_pipeline_position(owner=$RALPH_GH_OWNER, repo=$RALPH_GH_REPO, number=[issue-number])
```

The result tells you:
- `phase`: Which phase to start at (SPLIT, TRIAGE, RESEARCH, PLAN, REVIEW, IMPLEMENT, TERMINAL)
- `remainingPhases`: Full list of phases still needed
- `convergence`: Whether the group is ready for the next gate
- `isGroup` and `groupPrimary`: Group detection (replaces separate detect_group call for pipeline purposes)

Use the `phase` field to determine which tasks to create (Section 4.2) and which teammate to spawn first (Section 4.3).
```

#### 4. Replace ralph-team dispatch loop issue selection

**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Changes**: Simplify lines 284-304 (finding work for idle teammates)

**Before** (LLM runs multiple list_issues queries and filters):
```markdown
3. FIND NEW WORK FOR IDLE TEAMMATES
   a. Check current task list for unassigned work matching their role
   b. If nothing in task list, query GitHub for new issues:
      - Researcher idle? -> Find workflowState="Research Needed" issues
      - Planner idle? -> Find workflowState="Ready for Plan" issues
      ...
```

**After** (single tool call):
```markdown
3. FIND NEW WORK FOR IDLE TEAMMATES
   a. Check current task list for unassigned work matching their role
   b. If nothing in task list, use the pick tool:
      ```
      ralph_hero__pick_actionable_issue(
        owner=$RALPH_GH_OWNER,
        repo=$RALPH_GH_REPO,
        workflowState=[state matching teammate's role]
      )
      ```
      The tool returns the highest-priority unblocked issue, or `found: false` if none.
      If `found: true`, create tasks and assign to the idle teammate.
      If `found: false`, check if teammate can do a different role. If not, shut down.
```

#### 5. Replace ralph-team child advancement

**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Changes**: Simplify lines 273-282 (child issue advancement)

**Before** (LLM must remember to query and loop):
```markdown
   - **ADVANCE CHILD ISSUES**: When advancing a parent issue's state, query for children
     and advance them too:
     children = ralph_hero__list_sub_issues(...)
     for each child where child.workflowState is EARLIER than parent's new state:
       ralph_hero__update_workflow_state(...)
```

**After** (single tool call):
```markdown
   - **ADVANCE CHILD ISSUES**: After advancing a parent issue's state:
     ```
     ralph_hero__advance_children(
       owner=$RALPH_GH_OWNER,
       repo=$RALPH_GH_REPO,
       number=[parent-issue],
       targetState="[parent's new state]"
     )
     ```
     The tool advances all children in earlier states and returns what changed.
```

### Success Criteria

#### Automated Verification
- [ ] ralph-hero SKILL.md no longer contains the phase decision table (no `Has M/L/XL issues` text)
- [ ] ralph-team SKILL.md no longer contains the pipeline position table (no `| Backlog | M/L/XL | SPLIT |` text)
- [ ] Both SKILL.md files reference `ralph_hero__detect_pipeline_position`
- [ ] ralph-team SKILL.md references `ralph_hero__pick_actionable_issue`
- [ ] ralph-team SKILL.md references `ralph_hero__advance_children`
- [ ] ralph-hero SKILL.md references `ralph_hero__check_convergence`

#### Manual Verification
- [ ] Orchestrator prompts read clearly with tool-based flow
- [ ] Behavioral guidance (momentum, error recovery) is preserved
- [ ] No decision logic remains in prose tables — only tool call instructions

**Implementation Note**: Make the prompt changes incrementally. Test each orchestrator separately.

---

## Phase 4: MCP Server-Side Semantic State Resolution

### Overview

Since Phase 0 confirmed `updatedInput` does not work for MCP tools, semantic state resolution must happen inside the MCP server itself. The `ralph_hero__update_workflow_state` tool gains a **required** `command` parameter that enables full validation of every state transition — both semantic intents (`__LOCK__`, `__COMPLETE__`, etc.) and direct state names are validated against the calling command's allowed outputs.

This is the **activated alternative** from the original plan. It bypasses the hook system entirely and resolves intents at the MCP tool level, which is guaranteed to work.

### Design Principles

1. **`command` is required** — every call must declare which skill is making the transition. Without it, the server cannot validate or resolve anything.
2. **Semantic intents are validated per-command** — `__LOCK__` is only valid for commands that have a lock state. `__COMPLETE__` is only valid for commands with a single completion target.
3. **Direct state names are validated per-command** — a direct state like `"Ready for Plan"` is only accepted if it's in the command's `valid_output_states` or is the command's `lock_state`.
4. **Errors are actionable** — every error message tells the caller exactly what's valid for their command.
5. **Data is hardcoded** — the MCP server runs via npx and can't read the plugin's state machine JSON. A unit test verifies the hardcoded data matches the JSON to catch drift.

### Edge Case Matrix

#### Semantic Intent × Command Resolution Table

| Intent | ralph_triage | ralph_split | ralph_research | ralph_plan | ralph_impl | ralph_review | ralph_hero |
|--------|-------------|-------------|---------------|-----------|-----------|-------------|-----------|
| `__LOCK__` | ❌ no lock | ❌ no lock | ✅ Research in Progress | ✅ Plan in Progress | ✅ In Progress | ❌ no lock | ❌ no lock |
| `__COMPLETE__` | ❌ null (multi-path) | ✅ Backlog | ✅ Ready for Plan | ✅ Plan in Review | ✅ In Review | ✅ In Progress | ❌ not mapped |
| `__ESCALATE__` | ✅ Human Needed | ✅ Human Needed | ✅ Human Needed | ✅ Human Needed | ✅ Human Needed | ✅ Human Needed | ✅ Human Needed |
| `__CLOSE__` | ✅ Done | ✅ Done | ✅ Done | ✅ Done | ✅ Done | ✅ Done | ✅ Done |
| `__CANCEL__` | ✅ Canceled | ✅ Canceled | ✅ Canceled | ✅ Canceled | ✅ Canceled | ✅ Canceled | ✅ Canceled |

#### Direct State × Command Validation Table

Each command's allowed direct states = `valid_output_states` ∪ `{lock_state}`:

| Command | Allowed Direct States |
|---------|----------------------|
| ralph_triage | Research Needed, Ready for Plan, Done, Canceled, Human Needed |
| ralph_split | Backlog |
| ralph_research | Research in Progress, Ready for Plan, Human Needed |
| ralph_plan | Plan in Progress, Plan in Review, Human Needed |
| ralph_impl | In Progress, In Review, Human Needed |
| ralph_review | In Progress, Ready for Plan, Human Needed |
| ralph_hero | In Review, Human Needed |

#### Error Scenarios with Recovery Guidance

Every error message follows a three-part structure so agents can self-correct without human intervention:
1. **What happened** — diagnostic (what the agent tried)
2. **Why it failed** — context (what's valid for this command)
3. **What to do instead** — recovery action (exact retry parameters)

| # | Scenario | Error Message | Agent Recovery Action |
|---|----------|---------------|-----------------------|
| 1 | `command` not provided | N/A — zod schema enforces required field at parameter level. The LLM will see a schema validation error from the MCP framework. | Agent re-reads the tool schema and adds the `command` parameter. |
| 2 | Unknown command `"foo"` | `Unknown command "foo". Valid commands: ralph_triage, ralph_split, ralph_research, ralph_plan, ralph_impl, ralph_review, ralph_hero. Recovery: retry with the correct ralph_* command name. If you passed a bare name like "research", use "ralph_research".` | Agent retries with the correctly prefixed command name. |
| 3 | `__LOCK__` + `ralph_triage` | `Intent __LOCK__ is not valid for ralph_triage — triage has no lock state. Only these commands support __LOCK__: ralph_research → "Research in Progress", ralph_plan → "Plan in Progress", ralph_impl → "In Progress". Recovery: ralph_triage uses direct state names. To route this issue, retry with state="Research Needed" or state="Ready for Plan".` | Agent retries with a direct state name from the list. |
| 4 | `__LOCK__` + `ralph_review` | Same pattern — `ralph_review has no lock state. Recovery: use state="__COMPLETE__" to approve (→ In Progress), or state="Ready for Plan" to request iteration.` | Agent retries with `__COMPLETE__` or `"Ready for Plan"`. |
| 5 | `__COMPLETE__` + `ralph_triage` | `Intent __COMPLETE__ is ambiguous for ralph_triage (multiple output paths: Research Needed, Ready for Plan, Done, Canceled). Recovery: use a direct state name instead. For research routing: state="Research Needed". For simple issues: state="Ready for Plan". To close as duplicate/invalid: state="Done" or state="Canceled".` | Agent selects the specific triage outcome and retries with that direct state. |
| 6 | `__COMPLETE__` + `ralph_hero` | `Intent __COMPLETE__ has no mapping for ralph_hero. ralph_hero is an orchestrator that delegates state transitions to child commands. Commands supporting __COMPLETE__: ralph_split → Backlog, ralph_research → Ready for Plan, ralph_plan → Plan in Review, ralph_impl → In Review, ralph_review → In Progress. Recovery: if escalating, use state="__ESCALATE__". Otherwise, delegate the transition to the appropriate child skill.` | Agent uses `__ESCALATE__` or delegates to the correct child command. |
| 7 | `__FOOBAR__` (unknown intent) | `Unknown semantic intent "__FOOBAR__". Valid intents: __LOCK__ (claim work), __COMPLETE__ (finish work), __ESCALATE__ (needs human), __CLOSE__ (mark done), __CANCEL__ (abandon). Recovery: retry with one of the valid intents listed above, or use a direct state name.` | Agent retries with a valid intent or switches to a direct state name. |
| 8 | Direct `"Ready for Plan"` + `ralph_impl` | `State "Ready for Plan" is not a valid output for ralph_impl. Valid states for ralph_impl: In Progress, In Review, Human Needed. Recovery: to mark implementation started, use state="__LOCK__" (→ In Progress). To mark implementation complete, use state="__COMPLETE__" (→ In Review). To escalate, use state="__ESCALATE__".` | Agent retries with the correct semantic intent for their actual goal. |
| 9 | Direct `"Research in Progress"` + `ralph_research` | ✅ Allowed — it's the lock state for ralph_research. Equivalent to `__LOCK__`. | N/A |
| 10 | Direct `"Done"` + `ralph_research` | `State "Done" is not a valid output for ralph_research. Valid states for ralph_research: Research in Progress, Ready for Plan, Human Needed. Recovery: to close this issue entirely, use state="__CLOSE__" (→ Done) — but note this bypasses the normal workflow. To complete research normally, use state="__COMPLETE__" (→ Ready for Plan).` | Agent retries with `__CLOSE__` (if truly closing) or `__COMPLETE__` (if finishing research). |

#### Agent Self-Correction Pattern

SKILL.md files should include this error handling instruction near their `update_workflow_state` calls:

```markdown
**Error handling**: If `update_workflow_state` returns an error, the error message contains:
- The list of valid states/intents for your command
- A specific recovery action telling you exactly what to retry with
Read the error message and retry with the corrected parameters. Do NOT guess — use the exact values from the error message.
```

This pattern works because:
- The MCP server knows the full state machine and can always suggest valid alternatives
- Error messages are structured for LLM consumption (explicit "Recovery:" section)
- Agents don't need the state machine internalized — the tool teaches them on failure

### Changes Required

#### 1. Add state resolution module to MCP server

**File**: `plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts` (new file)
**Changes**: New module with all resolution and validation logic

```typescript
/**
 * Semantic state resolution and command-level validation.
 *
 * Hardcoded from ralph-state-machine.json. A unit test verifies these
 * match the JSON to prevent drift.
 */

// --- Semantic intent mappings ---
// null means the intent is recognized but invalid for that command
// undefined (missing key) means the intent isn't mapped for that command at all

const SEMANTIC_INTENTS: Record<string, Record<string, string | null>> = {
  "__LOCK__": {
    ralph_research: "Research in Progress",
    ralph_plan: "Plan in Progress",
    ralph_impl: "In Progress",
  },
  "__COMPLETE__": {
    ralph_triage: null,  // multi-path: caller must use direct state
    ralph_split: "Backlog",
    ralph_research: "Ready for Plan",
    ralph_plan: "Plan in Review",
    ralph_impl: "In Review",
    ralph_review: "In Progress",
  },
  "__ESCALATE__": { "*": "Human Needed" },
  "__CLOSE__": { "*": "Done" },
  "__CANCEL__": { "*": "Canceled" },
};

// --- Per-command allowed output states (valid_output_states ∪ {lock_state}) ---

const COMMAND_ALLOWED_STATES: Record<string, string[]> = {
  ralph_triage: ["Research Needed", "Ready for Plan", "Done", "Canceled", "Human Needed"],
  ralph_split: ["Backlog"],
  ralph_research: ["Research in Progress", "Ready for Plan", "Human Needed"],
  ralph_plan: ["Plan in Progress", "Plan in Review", "Human Needed"],
  ralph_impl: ["In Progress", "In Review", "Human Needed"],
  ralph_review: ["In Progress", "Ready for Plan", "Human Needed"],
  ralph_hero: ["In Review", "Human Needed"],
};

// --- Helpers ---

function isSemanticIntent(state: string): boolean {
  return state.startsWith("__") && state.endsWith("__");
}

function normalizeCommand(raw: string): string {
  // Accept both "research" and "ralph_research"
  if (raw.startsWith("ralph_")) return raw;
  return `ralph_${raw}`;
}

const VALID_COMMANDS = Object.keys(COMMAND_ALLOWED_STATES);
const VALID_INTENTS = Object.keys(SEMANTIC_INTENTS);

// --- Public API ---

export interface ResolutionResult {
  resolvedState: string;
  wasIntent: boolean;
  originalState: string;
  command: string;
}

export function resolveState(state: string, rawCommand: string): ResolutionResult {
  const command = normalizeCommand(rawCommand);

  // Validate command
  if (!COMMAND_ALLOWED_STATES[command]) {
    throw new Error(
      `Unknown command "${rawCommand}". Valid commands: ${VALID_COMMANDS.join(", ")}. ` +
      `Recovery: retry with the correct ralph_* command name. ` +
      `If you passed a bare name like "${rawCommand}", use "ralph_${rawCommand}".`
    );
  }

  if (isSemanticIntent(state)) {
    return resolveSemanticIntent(state, command);
  } else {
    return validateDirectState(state, command);
  }
}

function resolveSemanticIntent(intent: string, command: string): ResolutionResult {
  const intentMapping = SEMANTIC_INTENTS[intent];

  // Unknown intent
  if (!intentMapping) {
    throw new Error(
      `Unknown semantic intent "${intent}". ` +
      `Valid intents: __LOCK__ (claim work), __COMPLETE__ (finish work), ` +
      `__ESCALATE__ (needs human), __CLOSE__ (mark done), __CANCEL__ (abandon). ` +
      `Recovery: retry with one of these intents, or use a direct state name.`
    );
  }

  // Check wildcard first, then command-specific
  const wildcardResult = intentMapping["*"];
  const commandResult = intentMapping[command];

  // Wildcard match (e.g., __ESCALATE__, __CLOSE__, __CANCEL__)
  if (wildcardResult !== undefined) {
    return {
      resolvedState: wildcardResult,
      wasIntent: true,
      originalState: intent,
      command,
    };
  }

  // Command not in mapping at all
  if (commandResult === undefined) {
    const supported = Object.entries(intentMapping)
      .filter(([k, v]) => k !== "*" && v !== null)
      .map(([k, v]) => `${k} → ${v}`)
      .join(", ");
    const allowedStates = COMMAND_ALLOWED_STATES[command].join(", ");
    throw new Error(
      `Intent ${intent} is not valid for ${command}. ` +
      `Commands supporting ${intent}: ${supported || "none"}. ` +
      `Recovery: for ${command}, use a direct state name instead: ${allowedStates}. ` +
      `Or use __ESCALATE__ to escalate to human.`
    );
  }

  // Mapping is null (e.g., ralph_triage + __COMPLETE__)
  if (commandResult === null) {
    const allowedStates = COMMAND_ALLOWED_STATES[command].join(", ");
    throw new Error(
      `Intent ${intent} is ambiguous for ${command} (multiple output paths). ` +
      `Recovery: use a direct state name instead: ${allowedStates}.`
    );
  }

  return {
    resolvedState: commandResult,
    wasIntent: true,
    originalState: intent,
    command,
  };
}

function validateDirectState(state: string, command: string): ResolutionResult {
  const allowed = COMMAND_ALLOWED_STATES[command];

  if (!allowed.includes(state)) {
    // Build recovery suggestions using semantic intents available for this command
    const recoveryIntents: string[] = [];
    for (const [intent, mapping] of Object.entries(SEMANTIC_INTENTS)) {
      const resolved = mapping[command] || mapping["*"];
      if (resolved && allowed.includes(resolved)) {
        recoveryIntents.push(`${intent} → ${resolved}`);
      }
    }
    const recoveryStr = recoveryIntents.length > 0
      ? ` Available semantic intents for ${command}: ${recoveryIntents.join(", ")}.`
      : "";

    throw new Error(
      `State "${state}" is not a valid output for ${command}. ` +
      `Valid direct states for ${command}: ${allowed.join(", ")}. ` +
      `Recovery: retry with one of the valid states listed above.${recoveryStr}`
    );
  }

  return {
    resolvedState: state,
    wasIntent: false,
    originalState: state,
    command,
  };
}

// Exported for unit tests
export { SEMANTIC_INTENTS, COMMAND_ALLOWED_STATES, VALID_COMMANDS, VALID_INTENTS, normalizeCommand };
```

#### 2. Modify `update_workflow_state` tool schema and handler

**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: Add required `command` parameter, wire resolution into handler

```typescript
// Updated tool registration:
server.tool(
  "ralph_hero__update_workflow_state",
  "Change an issue's Workflow State. Accepts semantic intents (__LOCK__, __COMPLETE__, __ESCALATE__, __CLOSE__, __CANCEL__) or direct state names. The command parameter enables validation.",
  {
    owner: z.string().optional().describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
    repo: z.string().optional().describe("Repository name. Defaults to GITHUB_REPO env var"),
    number: z.number().describe("Issue number"),
    state: z.string().describe(
      "Target state: semantic intent (__LOCK__, __COMPLETE__, __ESCALATE__, __CLOSE__, __CANCEL__) " +
      "or direct state name (e.g., 'Research Needed', 'In Progress')"
    ),
    command: z.string().describe(
      "Ralph command making this transition (e.g., 'ralph_research', 'ralph_plan'). " +
      "Required for validation and semantic intent resolution."
    ),
  },
  async (args) => {
    try {
      const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(client, args);

      // Resolve semantic intent or validate direct state
      const { resolvedState, wasIntent, originalState } = resolveState(args.state, args.command);

      // Ensure field cache is populated
      await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

      // Get current state for the response
      const previousState = await getCurrentFieldValue(
        client, fieldCache, owner, repo, args.number, "Workflow State",
      );

      // Resolve project item ID
      const projectItemId = await resolveProjectItemId(client, fieldCache, owner, repo, args.number);

      // Update the field with the resolved state
      await updateProjectItemField(client, fieldCache, projectItemId, "Workflow State", resolvedState);

      const result: Record<string, unknown> = {
        number: args.number,
        previousState: previousState || "(unknown)",
        newState: resolvedState,
        command: args.command,
      };

      if (wasIntent) {
        result.resolvedFrom = originalState;
      }

      return toolSuccess(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError(`Failed to update workflow state: ${message}`);
    }
  },
);
```

#### 3. Update skill SKILL.md files to pass `command` parameter

For each skill, update all `update_workflow_state` calls to include `command`:

**ralph-research/SKILL.md**:
```
ralph_hero__update_workflow_state(number=N, state="__LOCK__", command="ralph_research")
ralph_hero__update_workflow_state(number=N, state="__COMPLETE__", command="ralph_research")
ralph_hero__update_workflow_state(number=N, state="__ESCALATE__", command="ralph_research")
```

**ralph-plan/SKILL.md**:
```
ralph_hero__update_workflow_state(number=N, state="__LOCK__", command="ralph_plan")
ralph_hero__update_workflow_state(number=N, state="__COMPLETE__", command="ralph_plan")
ralph_hero__update_workflow_state(number=N, state="__ESCALATE__", command="ralph_plan")
```

**ralph-impl/SKILL.md**:
```
ralph_hero__update_workflow_state(number=N, state="__LOCK__", command="ralph_impl")
ralph_hero__update_workflow_state(number=N, state="__COMPLETE__", command="ralph_impl")
ralph_hero__update_workflow_state(number=N, state="__ESCALATE__", command="ralph_impl")
```

**ralph-review/SKILL.md**:
```
ralph_hero__update_workflow_state(number=N, state="__COMPLETE__", command="ralph_review")  # → In Progress (approved)
ralph_hero__update_workflow_state(number=N, state="Ready for Plan", command="ralph_review")  # → needs iteration (direct state)
ralph_hero__update_workflow_state(number=N, state="__ESCALATE__", command="ralph_review")
```

**ralph-triage/SKILL.md** (uses direct state names — no `__COMPLETE__` due to multi-path):
```
ralph_hero__update_workflow_state(number=N, state="Research Needed", command="ralph_triage")
ralph_hero__update_workflow_state(number=N, state="Ready for Plan", command="ralph_triage")
ralph_hero__update_workflow_state(number=N, state="Done", command="ralph_triage")
ralph_hero__update_workflow_state(number=N, state="Canceled", command="ralph_triage")
ralph_hero__update_workflow_state(number=N, state="__ESCALATE__", command="ralph_triage")
```

**ralph-split/SKILL.md**:
```
ralph_hero__update_workflow_state(number=N, state="__COMPLETE__", command="ralph_split")  # → Backlog
ralph_hero__update_workflow_state(number=N, state="__ESCALATE__", command="ralph_split")
```

**ralph-hero/SKILL.md** (orchestrator — only escalation):
```
ralph_hero__update_workflow_state(number=N, state="__ESCALATE__", command="ralph_hero")
```

#### 4. Add unit tests for state resolution

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/state-resolution.test.ts` (new file)

```typescript
import { describe, it, expect } from "vitest";
import {
  resolveState,
  SEMANTIC_INTENTS,
  COMMAND_ALLOWED_STATES,
  normalizeCommand,
} from "../lib/state-resolution";

describe("normalizeCommand", () => {
  it("passes through ralph_ prefixed commands", () => {
    expect(normalizeCommand("ralph_research")).toBe("ralph_research");
  });
  it("adds ralph_ prefix to bare command names", () => {
    expect(normalizeCommand("research")).toBe("ralph_research");
    expect(normalizeCommand("plan")).toBe("ralph_plan");
  });
});

describe("resolveState - semantic intents", () => {
  it("resolves __LOCK__ for commands with lock states", () => {
    expect(resolveState("__LOCK__", "ralph_research").resolvedState).toBe("Research in Progress");
    expect(resolveState("__LOCK__", "ralph_plan").resolvedState).toBe("Plan in Progress");
    expect(resolveState("__LOCK__", "ralph_impl").resolvedState).toBe("In Progress");
  });

  it("rejects __LOCK__ for commands without lock states with recovery guidance", () => {
    expect(() => resolveState("__LOCK__", "ralph_triage")).toThrow(/not valid for ralph_triage/i);
    expect(() => resolveState("__LOCK__", "ralph_triage")).toThrow(/recovery/i);
    expect(() => resolveState("__LOCK__", "ralph_review")).toThrow(/not valid for ralph_review/i);
    expect(() => resolveState("__LOCK__", "ralph_hero")).toThrow(/not valid for ralph_hero/i);
  });

  it("resolves __COMPLETE__ for commands with single completion target", () => {
    expect(resolveState("__COMPLETE__", "ralph_research").resolvedState).toBe("Ready for Plan");
    expect(resolveState("__COMPLETE__", "ralph_plan").resolvedState).toBe("Plan in Review");
    expect(resolveState("__COMPLETE__", "ralph_impl").resolvedState).toBe("In Review");
    expect(resolveState("__COMPLETE__", "ralph_review").resolvedState).toBe("In Progress");
    expect(resolveState("__COMPLETE__", "ralph_split").resolvedState).toBe("Backlog");
  });

  it("rejects __COMPLETE__ for ralph_triage (null / multi-path) with recovery", () => {
    expect(() => resolveState("__COMPLETE__", "ralph_triage")).toThrow(/ambiguous.*multiple output paths/i);
    expect(() => resolveState("__COMPLETE__", "ralph_triage")).toThrow(/recovery.*direct state name/i);
  });

  it("rejects __COMPLETE__ for ralph_hero (not mapped) with recovery", () => {
    expect(() => resolveState("__COMPLETE__", "ralph_hero")).toThrow(/not valid for ralph_hero/i);
    expect(() => resolveState("__COMPLETE__", "ralph_hero")).toThrow(/recovery/i);
  });

  it("resolves wildcard intents for all commands", () => {
    for (const cmd of Object.keys(COMMAND_ALLOWED_STATES)) {
      expect(resolveState("__ESCALATE__", cmd).resolvedState).toBe("Human Needed");
      expect(resolveState("__CLOSE__", cmd).resolvedState).toBe("Done");
      expect(resolveState("__CANCEL__", cmd).resolvedState).toBe("Canceled");
    }
  });

  it("rejects unknown semantic intents with valid intent list", () => {
    expect(() => resolveState("__FOOBAR__", "ralph_research")).toThrow(/unknown semantic intent/i);
    expect(() => resolveState("__FOOBAR__", "ralph_research")).toThrow(/recovery.*retry/i);
  });

  it("marks resolved intents with wasIntent=true", () => {
    const result = resolveState("__LOCK__", "ralph_research");
    expect(result.wasIntent).toBe(true);
    expect(result.originalState).toBe("__LOCK__");
  });
});

describe("resolveState - direct state names", () => {
  it("accepts valid output states for each command", () => {
    expect(resolveState("Research Needed", "ralph_triage").resolvedState).toBe("Research Needed");
    expect(resolveState("Ready for Plan", "ralph_triage").resolvedState).toBe("Ready for Plan");
    expect(resolveState("Research in Progress", "ralph_research").resolvedState).toBe("Research in Progress");
    expect(resolveState("In Review", "ralph_impl").resolvedState).toBe("In Review");
  });

  it("rejects states not in command's allowed outputs with recovery", () => {
    expect(() => resolveState("Ready for Plan", "ralph_impl")).toThrow(/not a valid output for ralph_impl/i);
    expect(() => resolveState("Ready for Plan", "ralph_impl")).toThrow(/recovery.*retry/i);
    expect(() => resolveState("Done", "ralph_research")).toThrow(/not a valid output for ralph_research/i);
    expect(() => resolveState("In Progress", "ralph_triage")).toThrow(/not a valid output for ralph_triage/i);
  });

  it("includes semantic intent suggestions in recovery guidance", () => {
    // ralph_research can use __COMPLETE__ → "Ready for Plan", so recovery should list it
    const error = expect(() => resolveState("Done", "ralph_research"));
    error.toThrow(/available semantic intents/i);
    error.toThrow(/__COMPLETE__/);
  });

  it("marks direct states with wasIntent=false", () => {
    const result = resolveState("Research Needed", "ralph_triage");
    expect(result.wasIntent).toBe(false);
  });
});

describe("resolveState - command validation", () => {
  it("rejects unknown commands with recovery guidance", () => {
    expect(() => resolveState("__LOCK__", "foo")).toThrow(/unknown command/i);
    expect(() => resolveState("__LOCK__", "foo")).toThrow(/recovery.*retry/i);
  });

  it("accepts bare command names via normalization", () => {
    expect(resolveState("__LOCK__", "research").resolvedState).toBe("Research in Progress");
    expect(resolveState("__LOCK__", "plan").resolvedState).toBe("Plan in Progress");
  });
});

describe("data consistency with state machine JSON", () => {
  // This test loads ralph-state-machine.json and verifies the hardcoded
  // data matches. Prevents drift between the two sources of truth.
  // Implementation: read JSON, compare SEMANTIC_INTENTS and COMMAND_ALLOWED_STATES
  it.todo("verify SEMANTIC_INTENTS matches ralph-state-machine.json semantic_states");
  it.todo("verify COMMAND_ALLOWED_STATES matches ralph-state-machine.json commands");
});
```

### Success Criteria

#### Automated Verification
- [ ] MCP server builds: `cd mcp-server && npm run build`
- [ ] New module `lib/state-resolution.ts` compiles without errors
- [ ] Unit test: `__LOCK__` resolves correctly for ralph_research, ralph_plan, ralph_impl
- [ ] Unit test: `__LOCK__` errors for ralph_triage, ralph_split, ralph_review, ralph_hero
- [ ] Unit test: `__COMPLETE__` resolves correctly for all commands except ralph_triage and ralph_hero
- [ ] Unit test: `__COMPLETE__` + ralph_triage → "ambiguous" error with list of valid direct states
- [ ] Unit test: `__COMPLETE__` + ralph_hero → "no mapping" error with list of commands that support it
- [ ] Unit test: `__ESCALATE__`/`__CLOSE__`/`__CANCEL__` resolve for all 7 commands
- [ ] Unit test: Unknown intent `__FOOBAR__` → error listing valid intents
- [ ] Unit test: Direct state validated against command's allowed outputs
- [ ] Unit test: Invalid direct state → error with valid states + semantic intent hints
- [ ] Unit test: Unknown command → error listing valid commands
- [ ] Unit test: Bare command names ("research") normalized to "ralph_research"
- [ ] Unit test: ALL error messages contain "Recovery:" section with actionable retry instructions
- [ ] All existing MCP server tests still pass
- [ ] Grep confirms no `update_workflow_state` calls in SKILL.md files lack `command` parameter
- [ ] Grep confirms all SKILL.md files with `update_workflow_state` include error handling instruction

#### Manual Verification
- [ ] End-to-end: `update_workflow_state(state="__LOCK__", command="ralph_research")` changes issue to "Research in Progress"
- [ ] End-to-end: `update_workflow_state(state="__COMPLETE__", command="ralph_plan")` changes issue to "Plan in Review"
- [ ] Error from `update_workflow_state(state="__LOCK__", command="ralph_triage")` includes recovery guidance that an agent can follow to self-correct
- [ ] Run ralph_research on a test issue — verify it uses semantic intents and transitions work
- [ ] Simulate an agent error: call with wrong intent, verify the error message alone is sufficient to retry correctly

**Implementation Note**: Build and test the `state-resolution.ts` module in isolation first, then wire it into the handler, then update SKILL.md files. Publish a new npm version after all tests pass.

---

## Phase 5: Integration Testing

### Overview

End-to-end validation of the complete deterministic workflow.

### Test Plan

#### Test 1: Phase Detection (ralph-hero)

1. Create or find a test issue in each state:
   - Backlog (M estimate) → expects SPLIT phase
   - Research Needed → expects RESEARCH phase
   - Ready for Plan → expects PLAN phase
   - Plan in Review → expects REVIEW or HUMAN_GATE
   - In Progress → expects IMPLEMENT phase
   - In Review → expects TERMINAL

2. For each, call `ralph_hero__detect_pipeline_position` and verify the phase

3. Run `/ralph-hero [test-issue]` and verify it enters the correct phase

#### Test 2: Convergence (ralph-hero)

1. Create a group of 3 test issues
2. Move 2 to "Ready for Plan", keep 1 in "Research Needed"
3. Call `ralph_hero__check_convergence(targetState="Ready for Plan")`
4. Verify: `converged: false`, `blocking` contains issue 3
5. Move issue 3 to "Ready for Plan"
6. Verify: `converged: true`

#### Test 3: Child Advancement (ralph-team)

1. Find a parent issue with children
2. Call `ralph_hero__advance_children(number=parent, targetState="In Review")`
3. Verify: children in earlier states are advanced, children in later/equal states are skipped

#### Test 4: Dispatch Loop (ralph-team)

1. Run `/ralph-team [test-issue]`
2. Verify: pipeline position detected via tool (not prose table)
3. When teammate goes idle, verify: dispatch loop uses `pick_actionable_issue`
4. Verify: correct issue assigned to idle teammate

#### Test 5: Full Pipeline (ralph-hero)

1. Create a test issue (XS, Backlog)
2. Run `/ralph-hero [test-issue]`
3. Verify deterministic progression: TRIAGE → RESEARCH → PLAN → HUMAN_GATE
4. Each phase should use tool-based decisions, not prompt interpretation

### Success Criteria

#### Automated Verification
- [x] MCP server builds: `cd mcp-server && npm run build`
- [x] MCP server tests pass: `cd mcp-server && npm test` (95 tests, 6 files)
- [x] Hook scripts pass syntax check: `bash -n hooks/scripts/*.sh`
- [x] No prose decision tables remain in orchestrator SKILL.md files
- [x] All `update_workflow_state` calls have required `command` parameter (20 calls across 7 skills)

#### Manual Verification
- [ ] Phase detection is consistent across multiple runs (same input → same output)
- [ ] Convergence checking prevents premature planning
- [ ] Child advancement works atomically
- [ ] Dispatch loop finds work efficiently
- [ ] Full pipeline runs without LLM misinterpreting workflow state

---

## Testing Strategy

### Unit Tests
- Phase detection logic for all workflow state combinations
- Convergence checking with fully/partially/non-converged groups
- State ordering comparison (earlier/equal/later)
- Semantic intent resolution (if Phase 4 activated)
- Pick actionable issue with various priority/estimate/blocker combinations

### Integration Tests
- MCP tool → GitHub API → correct state change
- Hook → MCP tool interaction (convergence gate)
- Orchestrator SKILL.md → MCP tool → correct phase routing

### Manual Testing Steps
1. Run `/ralph-hero` on a test issue tree — verify deterministic phase progression
2. Run `/ralph-team` on a test issue — verify dispatch loop uses tools
3. Test convergence blocking — verify planning waits for research
4. Test child advancement — verify atomic state propagation

## Performance Considerations

- New MCP tools add ~1-2 GitHub API calls per invocation (already uses detect_group)
- `detect_pipeline_position` can reuse data from `detect_group` (single API call)
- `pick_actionable_issue` replaces 3-5 prompt-driven `list_issues` calls with one
- Net impact: should be faster due to fewer round-trips

## Migration Notes

- Phase 1 (MCP tools) is purely additive — no breaking changes
- Phase 2 (convergence hook) is additive — existing hooks unaffected
- Phase 3 (prompt simplification) is the only breaking change — old prompts replaced
- Phase 4 (semantic state resolution) is a **breaking change** — `command` becomes required for `update_workflow_state`. All SKILL.md files must be updated before publishing. Publish MCP server and update SKILL.md files atomically.
- Rollback: revert SKILL.md files to restore prose-based decisions

## References

- State machine: `plugin/ralph-hero/hooks/scripts/ralph-state-machine.json`
- MCP server: `plugin/ralph-hero/mcp-server/src/`
- Prior art: `landcrawler-ai/thoughts/shared/plans/2026-01-31-ralph-auto-state-refactor.md`
- Prior art: `landcrawler-ai/thoughts/shared/plans/2026-02-08-ralph-team-adaptive-refactor.md`
- Prior art: `landcrawler-ai/thoughts/shared/plans/2026-02-02-ralph-hero-v2-task-first-architecture.md`
- Auto-state hook: `plugin/ralph-hero/hooks/scripts/auto-state.sh` (dormant)
