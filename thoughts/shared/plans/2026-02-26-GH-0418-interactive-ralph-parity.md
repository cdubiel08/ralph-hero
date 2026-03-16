---
date: 2026-02-26
status: draft
github_issues: [418]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/418
primary_issue: 418
---

# Interactive ↔ Ralph-* Command Parity Implementation Plan

## Overview

Ensure the interactive commands (`research-codebase`, `create-plan`, `implement-plan`) and their ralph-* equivalents (`ralph-research`, `ralph-plan`, `ralph-impl`) share identical state machine behavior, artifact protocols, and hook enforcement — so a user can switch between interactive and autonomous modes at any point in the pipeline with consistent outcomes.

## Current State Analysis

### Interactive commands have ZERO hooks
All three interactive skills (`research-codebase`, `create-plan`, `implement-plan`) have no `hooks:` block in their frontmatter. This means:
- No `SessionStart` → `RALPH_COMMAND` is never set → postcondition hooks can't identify the skill
- No `PreToolUse` → no branch gates, no artifact prerequisite checks, no state validation
- No `PostToolUse` → no state transition validation
- No `Stop` → no postcondition enforcement (artifact existence, content validation)

### Interactive commands use direct state names
- `implement-plan` calls `update_workflow_state(number=NNN, state="In Progress", command="implement_plan")` — a direct state name, not `__LOCK__`
- `create-plan` calls `update_workflow_state(number=NNN, state="Plan in Review", command="create_plan")` — direct, not `__COMPLETE__`
- `research-codebase` has **no state transitions at all**

### Artifact Comment Protocol is optional in interactive mode
- All three interactive skills offer linking ("Would you like me to...?") instead of requiring it
- This is actually **correct for interactive mode** — the human may choose not to link. But when they DO link, it should follow the same protocol.

### No artifact prerequisite enforcement
- `create-plan` doesn't check for a research document before creating a plan
- `implement-plan` doesn't verify a plan document exists before implementing
- In ralph-* mode, `plan-research-required.sh` and `impl-plan-required.sh` enforce these

## Desired End State

After this plan is implemented:

1. **Automatic git context**: A plugin-wide `SessionStart` hook injects the current git branch, uncommitted changes, worktree status, and ahead/behind counts into every skill session — no per-skill "Step 0" needed
2. **Identical state machine transitions**: Both interactive and ralph-* commands use semantic intents (`__LOCK__`, `__COMPLETE__`, `__ESCALATE__`) for all state transitions
3. **Same hook enforcement on state + artifacts**: State gates and artifact validators fire for interactive commands (hard block on invalid transitions, hard block on missing prerequisites)
4. **Soft enforcement on operational gates**: Branch gates, worktree gates, and staging gates fire as WARNINGS (not blocks) for interactive commands
5. **Postconditions as warnings**: Stop hooks warn if expected artifacts are missing but don't block (user may have deliberately chosen not to create them)
6. **Consistent Artifact Comment Protocol**: When the user opts to link an artifact, it follows the exact same comment format and section headers
7. **Guided next steps**: Each interactive skill ends by offering the next logical pipeline action (create issue, push to main, create plan, split, implement, merge)

### Verification:
- [ ] Running `/research-codebase #42` → `/ralph-plan 42` works seamlessly (plan discovers research via Artifact Comment Protocol)
- [ ] Running `/ralph-research 42` → `/create-plan #42` works seamlessly (create-plan discovers research via comment)
- [ ] Running `/create-plan #42` → `/ralph-impl 42` works seamlessly (impl discovers plan via comment)
- [ ] State transitions in interactive mode use semantic intents and are validated by the same state gates
- [ ] All existing tests pass: `cd plugin/ralph-hero/mcp-server && npm test`

### Key Discoveries:
- The existing hook scripts already support a `RALPH_INTERACTIVE=true` env var check in some places, but this isn't wired up
- Hook scripts use `exit 2` to block — for interactive soft enforcement, we can add a `RALPH_INTERACTIVE` check that converts `exit 2` to `exit 0` with a warning message
- The `set-skill-env.sh` script already accepts arbitrary `KEY=VALUE` args — we just need to add `RALPH_INTERACTIVE=true` for interactive skills
- Plugin-level hooks in `hooks.json` already fire for all sessions — we only need to add skill-level hooks
- The `command` parameter in `update_workflow_state` already distinguishes sources (e.g., `"create_plan"` vs `"ralph_plan"`) — the state resolution system handles both via `normalizeCommand()`

## What We're NOT Doing

- **Not changing ralph-* commands**: Ralph-* skill prompts are unchanged. Only hook scripts gain `RALPH_INTERACTIVE` awareness.
- **Not making artifact linking mandatory in interactive mode**: The human chooses whether to link. But IF they link, it follows the protocol.
- **Not adding the `context: fork` directive to interactive skills**: Interactive skills run in the user's session by design
- **Not adding team coordination hooks**: `team-stop-gate.sh`, `worker-stop-gate.sh`, etc. are team-only

## Implementation Approach

Two mechanisms work together:

1. **Plugin-wide `SessionStart` hook** — A new `git-status-context.sh` script registered in `hooks.json` that fires for ALL skill sessions. It runs `git status`, `git branch`, and outputs the current git state as LLM context. This gives every skill (interactive or autonomous) automatic awareness of the working directory state without any per-skill "Step 0".

2. **`RALPH_INTERACTIVE=true` env var** — Set by interactive skills' `SessionStart` hooks. Existing hook scripts check this flag. For hooks where we want **hard enforcement** (state gates, artifact validators), behavior is identical regardless of the flag. For hooks where we want **soft enforcement** (branch gates, worktree gates, staging gates, postconditions), the script emits a warning but exits 0 instead of 2 when `RALPH_INTERACTIVE=true`.

This approach:
- Reuses all existing hook scripts (no duplication)
- Makes the behavior difference explicit and auditable
- Allows future tightening by just removing the `RALPH_INTERACTIVE` check
- Gives every skill git context automatically — no prompt text needed

## Phase 1: Plugin-Wide Git Status Context Hook

### Overview
Create a new `git-status-context.sh` script and register it as a plugin-wide `SessionStart` hook in `hooks.json`. This fires for every skill session (interactive and ralph-*) and injects the current git state as LLM context, so the agent always knows what branch it's on, whether there are uncommitted changes, and whether it's in a worktree.

### Changes Required:

#### 1. Create git-status-context.sh
**File**: `plugin/ralph-hero/hooks/scripts/git-status-context.sh` (NEW)
**Purpose**: Runs on SessionStart, outputs git context to stdout for LLM injection.

```bash
#!/usr/bin/env bash
# Injects current git status as LLM context on session start.
# Registered as a plugin-wide SessionStart hook in hooks.json.
#
# Output goes to stdout → becomes additionalContext visible to the LLM.
# This gives every skill automatic awareness of the git working state.

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_DIR" 2>/dev/null || exit 0

# Gather git info
BRANCH=$(git branch --show-current 2>/dev/null || echo "detached/unknown")
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
STATUS=$(git status --porcelain 2>/dev/null || echo "")
WORKTREE_DIR=$(git rev-parse --git-common-dir 2>/dev/null || echo "")

# Detect if we're in a worktree
IN_WORKTREE="false"
if [[ "$WORKTREE_DIR" == *"/.git/worktrees/"* ]] || [[ "$WORKTREE_DIR" != "$(git rev-parse --git-dir 2>/dev/null)" ]]; then
  IN_WORKTREE="true"
fi

# Count changes
MODIFIED=$(echo "$STATUS" | grep -c '^ M\|^M ' 2>/dev/null || echo "0")
UNTRACKED=$(echo "$STATUS" | grep -c '^??' 2>/dev/null || echo "0")
STAGED=$(echo "$STATUS" | grep -c '^[MADRC]' 2>/dev/null || echo "0")

# Ahead/behind
UPSTREAM=$(git rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || echo "")
AHEAD_BEHIND=""
if [[ -n "$UPSTREAM" ]]; then
  AHEAD=$(git rev-list --count "$UPSTREAM..HEAD" 2>/dev/null || echo "0")
  BEHIND=$(git rev-list --count "HEAD..$UPSTREAM" 2>/dev/null || echo "0")
  AHEAD_BEHIND="Ahead: $AHEAD, Behind: $BEHIND (tracking: $UPSTREAM)"
fi

# Output context
cat <<EOF
Git Working State:
  Branch: $BRANCH
  Commit: $COMMIT
  In worktree: $IN_WORKTREE
  Modified files: $MODIFIED
  Staged files: $STAGED
  Untracked files: $UNTRACKED
EOF

if [[ -n "$AHEAD_BEHIND" ]]; then
  echo "  $AHEAD_BEHIND"
fi

if [[ -n "$STATUS" ]]; then
  echo ""
  echo "Uncommitted changes:"
  echo "$STATUS" | head -20
  if [[ $(echo "$STATUS" | wc -l) -gt 20 ]]; then
    echo "  ... and more ($(echo "$STATUS" | wc -l) total)"
  fi
fi
```

#### 2. Register in hooks.json
**File**: `plugin/ralph-hero/hooks/hooks.json`
**Changes**: Add a `SessionStart` section:

```json
"SessionStart": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/git-status-context.sh"
      }
    ]
  }
]
```

### Success Criteria:

#### Automated Verification:
- [ ] `git-status-context.sh` exits 0 when run from the project root
- [ ] `git-status-context.sh` exits 0 when run from a worktree directory
- [ ] `git-status-context.sh` exits 0 when run outside a git repo (graceful no-op)
- [ ] `hooks.json` parses as valid JSON after the change
- [ ] All existing tests pass: `cd plugin/ralph-hero/mcp-server && npm test`

#### Manual Verification:
- [ ] Start any skill (e.g., `/research-codebase`) and verify git status context appears in the session
- [ ] Start a skill from a worktree and verify `In worktree: true` appears
- [ ] Start a skill with uncommitted changes and verify they're listed

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation.

---

## Phase 2: Add RALPH_INTERACTIVE Support to Hook Scripts

### Overview
Modify the existing hook scripts to support interactive mode. Scripts that should be "soft" in interactive mode will check `RALPH_INTERACTIVE=true` and downgrade blocks to warnings.

### Changes Required:

#### 1. Branch gate — soft in interactive mode
**File**: `plugin/ralph-hero/hooks/scripts/branch-gate.sh`
**Changes**: After the existing block logic (exit 2), add a check: if `RALPH_INTERACTIVE=true`, emit the same warning message but exit 0 instead of 2.

```bash
# At the top of the block section, before exit 2:
if [ "$RALPH_INTERACTIVE" = "true" ]; then
  echo "⚠️ WARNING: You are on branch '$CURRENT_BRANCH' instead of '$RALPH_REQUIRED_BRANCH'. This is allowed in interactive mode but artifacts should be committed to $RALPH_REQUIRED_BRANCH." >&2
  exit 0
fi
```

#### 2. impl-branch-gate.sh — soft in interactive mode
**File**: `plugin/ralph-hero/hooks/scripts/impl-branch-gate.sh`
**Changes**: Same pattern — downgrade block to warning when `RALPH_INTERACTIVE=true`.

#### 3. impl-worktree-gate.sh — soft in interactive mode
**File**: `plugin/ralph-hero/hooks/scripts/impl-worktree-gate.sh`
**Changes**: Same pattern.

#### 4. impl-staging-gate.sh — soft in interactive mode
**File**: `plugin/ralph-hero/hooks/scripts/impl-staging-gate.sh`
**Changes**: Same pattern.

#### 5. Postcondition scripts — soft in interactive mode
**Files**: `research-postcondition.sh`, `plan-postcondition.sh`, `impl-postcondition.sh`
**Changes**: Each script, when `RALPH_INTERACTIVE=true`, emits warning messages but exits 0 instead of 2. The warning should clearly state what's missing.

#### 6. State gates — HARD in both modes (no change needed)
**Files**: `research-state-gate.sh`, `plan-state-gate.sh`, `impl-state-gate.sh`
**Changes**: None. These already block invalid transitions and should do so regardless of mode.

#### 7. Artifact prerequisite gates — HARD in both modes (no change needed)
**Files**: `plan-research-required.sh`, `impl-plan-required.sh`
**Changes**: None. If a user tries to create a plan without research, that's an error in both modes.

### Success Criteria:

#### Automated Verification:
- [ ] All existing tests pass: `cd plugin/ralph-hero/mcp-server && npm test`
- [ ] `RALPH_INTERACTIVE=true branch-gate.sh` with wrong branch exits 0 (not 2)
- [ ] `RALPH_INTERACTIVE=false branch-gate.sh` with wrong branch exits 2 (unchanged)
- [ ] State gate scripts still exit 2 on invalid states regardless of `RALPH_INTERACTIVE`

#### Manual Verification:
- [ ] Run `/research-codebase` from a feature branch — see warning, not block
- [ ] Run `/ralph-research` from a feature branch — blocked as before

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation.

---

## Phase 3: Add Hook Frontmatter to Interactive Skills

### Overview
Wire up the existing (now interactive-aware) hook scripts to the three interactive skill definitions via frontmatter `hooks:` blocks.

### Changes Required:

#### 1. research-codebase — add hooks
**File**: `plugin/ralph-hero/skills/research-codebase/SKILL.md`
**Changes**: Add `hooks:` block to frontmatter:

```yaml
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=research RALPH_REQUIRED_BRANCH=main RALPH_INTERACTIVE=true"
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/branch-gate.sh"
  PostToolUse:
    - matcher: "ralph_hero__get_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/research-state-gate.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/research-postcondition.sh"
```

#### 2. create-plan — add hooks
**File**: `plugin/ralph-hero/skills/create-plan/SKILL.md`
**Changes**: Add `hooks:` block:

```yaml
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=plan RALPH_REQUIRED_BRANCH=main RALPH_REQUIRES_RESEARCH=true RALPH_INTERACTIVE=true"
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/branch-gate.sh"
    - matcher: "ralph_hero__update_workflow_state"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/convergence-gate.sh"
    - matcher: "Write"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-research-required.sh"
  PostToolUse:
    - matcher: "ralph_hero__update_workflow_state"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-state-gate.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-postcondition.sh"
```

#### 3. implement-plan — add hooks
**File**: `plugin/ralph-hero/skills/implement-plan/SKILL.md`
**Changes**: Add `hooks:` block:

```yaml
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=impl RALPH_VALID_OUTPUT_STATES='In Progress,In Review,Human Needed' RALPH_REQUIRES_PLAN=true RALPH_INTERACTIVE=true"
  PreToolUse:
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-plan-required.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-worktree-gate.sh"
    - matcher: "ralph_hero__update_workflow_state"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-state-gate.sh"
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-staging-gate.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-branch-gate.sh"
  PostToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-verify-commit.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-verify-pr.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-postcondition.sh"
```

### Success Criteria:

#### Automated Verification:
- [ ] All three SKILL.md files parse valid YAML frontmatter (no syntax errors)
- [ ] `set-skill-env.sh` correctly writes `RALPH_INTERACTIVE=true` to `$CLAUDE_ENV_FILE`
- [ ] All existing tests pass: `cd plugin/ralph-hero/mcp-server && npm test`

#### Manual Verification:
- [ ] `/research-codebase` SessionStart hook fires and sets RALPH_COMMAND=research
- [ ] `/create-plan` SessionStart hook fires and sets RALPH_COMMAND=plan
- [ ] `/implement-plan` SessionStart hook fires and sets RALPH_COMMAND=impl
- [ ] All three set RALPH_INTERACTIVE=true

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation.

---

## Phase 4: Update Interactive Skill Prompts for Semantic Intents and Guided Next Steps

### Overview
Three changes per skill:
1. Switch state transitions from direct state names to semantic intents (`__LOCK__`, `__COMPLETE__`, `__ESCALATE__`)
2. Add a **Guided Next Steps** section at the end of each skill that offers the user the next logical action in the pipeline
3. Add issue lifecycle actions: create issues if none exist, commit/push artifacts to main, attach artifacts to issues, offer splitting

### Changes Required:

#### 1. research-codebase — add state transitions + guided next steps
**File**: `plugin/ralph-hero/skills/research-codebase/SKILL.md`

**State transitions** (currently has NONE — add these):

- After Step 1 (issue identified), add lock acquisition:
  ```
  If a `LINKED_ISSUE` is set, acquire the research lock:
  ralph_hero__update_workflow_state(number=NNN, state="__LOCK__", command="research")
  ```
- After Step 6 (document created), add completion:
  ```
  If a `LINKED_ISSUE` is set, mark research complete:
  ralph_hero__update_workflow_state(number=NNN, state="__COMPLETE__", command="research")
  ```

**Replace Step 8 ("Optional issue linking") and Step 9 ("Present findings")** with a new combined **Step 8: Commit, Link, and Next Steps** section:

```markdown
### Step 8: Commit, Link, and Next Steps

After the research document is written, guide the user through the pipeline handoff:

#### 8.1 Commit and push to main
```bash
git add thoughts/shared/research/[filename].md
git commit -m "docs(research): GH-NNN [brief topic description]"
git push origin main
```

#### 8.2 Create or link a GitHub issue

If `LINKED_ISSUE` is NOT set (no issue provided):
```
I've completed the research. Would you like me to:
1. Create a new GitHub issue from these findings
2. Link this to an existing issue (provide #NNN)
3. Skip — just keep the research document
```

If the user chooses to create an issue:
- `ralph_hero__create_issue(title="[derived from research question]", body="[summary of findings with link to research doc]")`
- `ralph_hero__update_estimate(number=NEW_NNN, estimate="XS|S|M|L|XL")` — suggest an estimate based on scope discovered
- Set `LINKED_ISSUE = NEW_NNN`
- `ralph_hero__update_workflow_state(number=NEW_NNN, state="Ready for Plan", command="research")`

#### 8.3 Post Artifact Comment (strongly recommended for pipeline continuity)

If `LINKED_ISSUE` is set:
```
ralph_hero__create_comment(number=NNN, body="## Research Document\n\nhttps://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/research/[filename].md\n\nKey findings: [1-3 line summary]")
```

#### 8.4 Offer next logical step

```
Research complete for #NNN: [Title]

Document: thoughts/shared/research/[filename].md
Issue: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
Status: Ready for Plan

What would you like to do next?
1. Create an implementation plan → `/create-plan #NNN`
2. Split this into smaller issues (if scope is large) → `/ralph-hero:ralph-split NNN`
3. I'm done for now
```

If the estimate is M, L, or XL, emphasize the split option:
```
Note: This looks like a [M/L/XL] effort. Consider splitting before planning.
```
```

#### 2. create-plan — switch to semantic intents + guided next steps
**File**: `plugin/ralph-hero/skills/create-plan/SKILL.md`

**State transitions:**

- Add lock acquisition when starting to write the plan (new, before Step 4):
  ```
  ralph_hero__update_workflow_state(number=NNN, state="__LOCK__", command="plan")
  ```
- Change the completion transition (Step 6) from:
  ```
  ralph_hero__update_workflow_state(number=NNN, state="Plan in Review", command="create_plan")
  ```
  To:
  ```
  ralph_hero__update_workflow_state(number=NNN, state="__COMPLETE__", command="plan")
  ```

**Replace Step 6 ("GitHub Integration (Optional)")** with a new **Step 6: Commit, Link, and Next Steps**:

```markdown
### Step 6: Commit, Link, and Next Steps

After the plan is finalized and the user is satisfied:

#### 6.1 Commit and push to main
```bash
git add thoughts/shared/plans/[filename].md
git commit -m "docs(plan): GH-NNN [brief plan description]"
git push origin main
```

#### 6.2 Create or link a GitHub issue

If no issue is linked yet (plan was created from scratch):
```
The plan is ready. Would you like me to:
1. Create a new GitHub issue from this plan
2. Link to an existing issue (provide #NNN)
3. Skip GitHub integration
```

**If creating a new issue:**
- `ralph_hero__create_issue(title="[plan title]", body="[plan overview summary]")`
- `ralph_hero__update_estimate(number=NEW_NNN, estimate="XS|S|M|L|XL")` — suggest based on phase count and scope
- Update plan frontmatter with new issue reference:
  ```yaml
  github_issues: [NNN]
  github_urls:
    - https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
  primary_issue: NNN
  ```

**If linking to existing issue:**
- Verify issue exists: `ralph_hero__get_issue(number=NNN)`
- Update plan frontmatter with issue reference

#### 6.3 Post Artifact Comment (strongly recommended)

```
ralph_hero__create_comment(number=NNN, body="## Implementation Plan\n\nhttps://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/plans/[filename].md\n\nSummary: [1-3 line summary of the plan]")
```

#### 6.4 Transition to Plan in Review

```
ralph_hero__update_workflow_state(number=NNN, state="__COMPLETE__", command="plan")
```

#### 6.5 Assess scope and offer next step

First, evaluate the plan's scope:
- Count the number of phases
- Estimate total effort from the plan content
- Check the issue's current estimate (if any)

If the plan has many phases (>3) or looks like M/L/XL effort:
```
Plan linked to #NNN: [Title]
Status: Plan in Review

This plan has [N] phases and looks like [M/L/XL] effort.
Would you like to:
1. Split this into smaller issues first → `/ralph-hero:ralph-split NNN`
2. Proceed to implementation → `/implement-plan #NNN`
3. I'm done for now — I'll review the plan first
```

Otherwise:
```
Plan linked to #NNN: [Title]
Status: Plan in Review

What would you like to do next?
1. Implement this plan → `/implement-plan #NNN`
2. I'm done for now — I'll review the plan first
```
```

#### 3. implement-plan — switch to semantic intents + guided next steps
**File**: `plugin/ralph-hero/skills/implement-plan/SKILL.md`

**State transitions:**

- Change Step 3.2 from:
  ```
  ralph_hero__update_workflow_state(number=NNN, state="In Progress", command="implement_plan")
  ```
  To:
  ```
  ralph_hero__update_workflow_state(number=NNN, state="__LOCK__", command="impl")
  ```
- Change Step 5.2 from:
  ```
  ralph_hero__update_workflow_state(number=NNN, state="In Review", command="implement_plan")
  ```
  To:
  ```
  ralph_hero__update_workflow_state(number=NNN, state="__COMPLETE__", command="impl")
  ```
- Add escalation instruction for Step 4.5 (mismatches):
  ```
  If the mismatch is unresolvable:
  ralph_hero__update_workflow_state(number=NNN, state="__ESCALATE__", command="impl")
  ```

**Replace Step 5.4 ("Report to User")** with an expanded **Step 5.4: Report and Next Steps**:

```markdown
### 5.4 Report and Next Steps

```
Implementation complete for #NNN: [Title]

PR: [PR URL]
Issue: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
Status: In Review

What would you like to do next?
1. Review the PR yourself → [PR URL]
2. Request changes or iterate → `/ralph-hero:iterate-plan #NNN`
3. Merge the PR → I'll merge it for you
```

If the user chooses to merge:
```bash
gh pr merge [PR_NUMBER] --squash --delete-branch
```
Then:
```
ralph_hero__update_workflow_state(number=NNN, state="__CLOSE__", command="impl")
```
```

#### 4. Verify command names resolve correctly
**File**: `plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts`
**Verification only**: Confirm that `normalizeCommand()` handles:
- `"research"` → maps to `"ralph_research"`
- `"plan"` → maps to `"ralph_plan"`
- `"impl"` → maps to `"ralph_impl"`
- `"implement_plan"` → needs to map to `"ralph_impl"` (may need to add this alias)
- `"create_plan"` → needs to map to `"ralph_plan"` (may need to add this alias)

If aliases are missing, add them to `normalizeCommand()`.

### Success Criteria:

#### Automated Verification:
- [ ] All existing tests pass: `cd plugin/ralph-hero/mcp-server && npm test`
- [ ] `normalizeCommand("research")` → `"ralph_research"` (verify in tests)
- [ ] `normalizeCommand("plan")` → `"ralph_plan"` (verify in tests)
- [ ] `normalizeCommand("impl")` → `"ralph_impl"` (verify in tests)
- [ ] `normalizeCommand("implement_plan")` → `"ralph_impl"` (add if needed)
- [ ] `normalizeCommand("create_plan")` → `"ralph_plan"` (add if needed)

#### Manual Verification:
- [ ] `/research-codebase #42` transitions: Research Needed → Research in Progress → Ready for Plan
- [ ] `/create-plan #42` transitions: Ready for Plan → Plan in Progress → Plan in Review
- [ ] `/implement-plan #42` transitions: Plan in Review → In Progress → In Review
- [ ] Each skill offers the correct next step at completion
- [ ] Issue creation flow works when no issue exists
- [ ] Split suggestion appears for M/L/XL estimates
- [ ] Artifact Comment is posted after commit/push

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation.

---

## Phase 5: Cross-Mode Handoff Testing

### Overview
Verify that artifacts created in one mode are correctly discovered and consumed by the other mode. This is the key integration test for the parity work.

### Changes Required:

No code changes. This phase is verification-only.

### Test Scenarios:

1. **Interactive → Ralph handoff**:
   - `/research-codebase #TEST` → creates research doc, posts Artifact Comment
   - `/ralph-plan TEST` → discovers research doc via Artifact Comment Protocol
   - Verify: plan skill finds the research doc and proceeds

2. **Ralph → Interactive handoff**:
   - `/ralph-research TEST` → creates research doc, posts Artifact Comment
   - `/create-plan #TEST` → should discover research doc via Artifact Comment Protocol
   - Verify: create-plan reads the research doc for context

3. **Mixed handoff through full pipeline**:
   - `/research-codebase #TEST` → `/create-plan #TEST` → `/ralph-impl TEST`
   - Verify: each stage finds the prior stage's artifacts

### Success Criteria:

#### Automated Verification:
- [ ] All unit tests pass: `cd plugin/ralph-hero/mcp-server && npm test`

#### Manual Verification:
- [ ] Scenario 1 works end-to-end
- [ ] Scenario 2 works end-to-end
- [ ] Scenario 3 works end-to-end
- [ ] GitHub issue comments show consistent format across modes

---

## Testing Strategy

### Unit Tests:
- Existing state-resolution tests verify command normalization
- Existing workflow-states tests verify state ordering and categories
- Add tests for new command aliases if added in Phase 3

### Integration Tests:
- Hook script behavior with `RALPH_INTERACTIVE=true` vs `false`
- Frontmatter YAML parsing for updated skill files

### Manual Testing:
- Full pipeline runs in both interactive and autonomous modes
- Cross-mode handoffs (interactive → ralph and ralph → interactive)
- Edge cases: no linked issue, group plans, stream plans

## Performance Considerations

No performance impact. Hook scripts are lightweight bash checks that add <100ms per tool call.

## References

- Research doc: `thoughts/shared/research/2026-02-26-ralph-team-state-machine-management.md`
- State machine: `plugin/ralph-hero/hooks/scripts/ralph-state-machine.json`
- State resolution: `plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts`
- Workflow states: `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts`
- Shared conventions: `plugin/ralph-hero/skills/shared/conventions.md`
- Ralph-research skill: `plugin/ralph-hero/skills/ralph-research/SKILL.md`
- Ralph-plan skill: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`
- Ralph-impl skill: `plugin/ralph-hero/skills/ralph-impl/SKILL.md`
- Research-codebase skill: `plugin/ralph-hero/skills/research-codebase/SKILL.md`
- Create-plan skill: `plugin/ralph-hero/skills/create-plan/SKILL.md`
- Implement-plan skill: `plugin/ralph-hero/skills/implement-plan/SKILL.md`
