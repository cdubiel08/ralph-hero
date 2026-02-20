---
description: Review and critique implementation plans before coding begins. INTERACTIVE mode for human review, AUTO mode for automated critique. Use when you want to review a plan, approve or reject a spec, or run quality gates on plans.
argument-hint: <issue-number> [--interactive]
context: fork
model: opus
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/branch-gate.sh"
    - matcher: "Write"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/review-no-dup.sh"
    - matcher: "ralph_hero__update_workflow_state"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/review-state-gate.sh"
  PostToolUse:
    - matcher: "Write"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/review-verify-doc.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/review-postcondition.sh"
env:
  RALPH_COMMAND: "review"
  RALPH_REQUIRED_BRANCH: "main"
  RALPH_VALID_INPUT_STATES: "Plan in Review"
  RALPH_VALID_OUTPUT_STATES: "In Progress,Ready for Plan,Human Needed"
  RALPH_ARTIFACT_DIR: "thoughts/shared/reviews"
  RALPH_MAX_ESTIMATE: "S"
  RALPH_REQUIRES_PLAN: "true"
---

# Ralph GitHub Review - Plan Quality Gate

You are a plan reviewer. You assess ONE plan, determine if it's ready for implementation, and route accordingly. Two modes:

- **INTERACTIVE**: Human reviews via wizard, immediate approval/rejection
- **AUTO**: Opus critiques in isolated context, routes based on quality

## Workflow

### Step 0: Detect Execution Mode

Parse arguments for mode flag:
- If `--interactive` flag present OR `RALPH_INTERACTIVE=true` -> INTERACTIVE mode
- Otherwise -> AUTO mode

Report mode:
```
Starting ralph-review in [INTERACTIVE/AUTO] mode
```

### Step 1: Select Issue

**If issue number provided**: Fetch it directly
**If no issue number**: Find highest-priority XS/Small issue in "Plan in Review"

```
ralph_hero__list_issues
- profile: "validator-review"
# Profile expands to: workflowState: "Plan in Review"
- orderBy: "priority"
- limit: 1
```

If no eligible issues:
```
No XS/Small issues in Plan in Review. Queue empty.
```
Then STOP.

### Step 2: Validate Plan Exists

1. Fetch the issue with full context:
   ```
   ralph_hero__get_issue
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   ```

2. **Find linked plan document** (per Artifact Comment Protocol in shared/conventions.md):
   1. Search issue comments for `## Implementation Plan` or `## Group Implementation Plan` header. If multiple matches, use the **most recent** (last) match.
   2. Extract the GitHub URL from the line after the header
   3. Convert to local path: strip `https://github.com/OWNER/REPO/blob/main/` prefix
   4. Read the plan document fully
   5. **Fallback**: If no comment found, glob for the plan doc. Try both padded and unpadded:
      - `thoughts/shared/plans/*GH-${number}*`
      - `thoughts/shared/plans/*GH-$(printf '%04d' ${number})*`
      Use the most recent match if multiple found.
   6. **Group fallback**: If standard glob fails, try `thoughts/shared/plans/*group*GH-{primary}*` where `{primary}` is the primary issue number from the issue's group context.
   7. **If fallback found, self-heal**: Post the missing comment to the issue:
      ```
      ralph_hero__create_comment(owner, repo, number, body="## Implementation Plan\n\nhttps://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/[path]\n\n(Self-healed: artifact was found on disk but not linked via comment)")
      ```
   8. **If neither found**:
      ```
      Issue #NNN has no implementation plan attached.
      Cannot review without a plan. Run /ralph-plan first.
      ```
      Then STOP.

4. Store issue number for postcondition hook:
   - Set `RALPH_TICKET_ID` environment context (format: `GH-NNN`)

### Step 3A: INTERACTIVE Mode - Wizard Review

**Read plan document** into context (needed for inline review).

**Present overall assessment question**:

```
AskUserQuestion(
  questions=[{
    "question": "How does the implementation plan for #NNN look?",
    "header": "Plan Review",
    "options": [
      {"label": "Approve", "description": "Plan is complete and ready for implementation"},
      {"label": "Minor Changes", "description": "Small adjustments needed, can fix and proceed"},
      {"label": "Major Changes", "description": "Significant rework needed, return to planning"},
      {"label": "Reject", "description": "Plan is fundamentally flawed, needs complete redo"}
    ],
    "multiSelect": false
  }]
)
```

**Route based on response**:

**If "Approve"**:
-> Proceed to Step 4 (approve flow)

**If "Minor Changes"**:
```
AskUserQuestion(
  questions=[{
    "question": "What minor changes are needed?",
    "header": "Adjustments",
    "options": [
      {"label": "Clarify success criteria", "description": "Make verification steps more specific"},
      {"label": "Add missing details", "description": "Plan needs more specifics in some areas"},
      {"label": "Fix technical approach", "description": "Small implementation adjustments"},
      {"label": "Update scope boundaries", "description": "Clarify what we're doing/not doing"}
    ],
    "multiSelect": true
  }]
)
```
-> Note the requested changes in GitHub comment
-> Proceed to Step 4 (approve flow with notes)

**If "Major Changes" or "Reject"**:
```
AskUserQuestion(
  questions=[{
    "question": "What are the primary issues?",
    "header": "Issues",
    "options": [
      {"label": "Insufficient research", "description": "Need more codebase investigation"},
      {"label": "Wrong approach", "description": "Fundamental strategy is incorrect"},
      {"label": "Missing requirements", "description": "Plan doesn't address issue needs"},
      {"label": "Scope issues", "description": "Plan does too much or too little"}
    ],
    "multiSelect": true
  }]
)
```
-> Proceed to Step 4 (rejection flow with issues)

### Step 3B: AUTO Mode - Delegated Critique

**Spawn critique in separate context window**:

```
Task(subagent_type="general-purpose",
     prompt="You are executing an autonomous plan critique for #NNN.

INSTRUCTIONS:
1. Read the plan document attached to issue #NNN
2. Analyze the plan for:
   - Completeness: Are all phases defined with clear changes?
   - Feasibility: Do referenced files exist? Are patterns valid?
   - Clarity: Are success criteria specific and testable?
   - Scope: Is 'What we're NOT doing' well-defined?

3. Use codebase-analyzer to verify technical claims:
   Task(subagent_type='codebase-analyzer', prompt='Verify files mentioned in plan exist: [list files]')

4. Create critique document at: thoughts/shared/reviews/YYYY-MM-DD-GH-NNN-critique.md
   With frontmatter:
   ---
   date: YYYY-MM-DD
   github_issue: NNN
   github_url: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
   plan_document: [plan path]
   status: approved OR needs-iteration
   type: critique
   ---

5. Commit and push:
   git add thoughts/shared/reviews/*.md
   git commit -m 'docs(review): GH-NNN plan critique

   git push origin main

6. Return ONLY this JSON (no other output):
{
  \"issue\": NNN,
  \"result\": \"APPROVED\" or \"NEEDS_ITERATION\",
  \"critique_path\": \"thoughts/shared/reviews/YYYY-MM-DD-GH-NNN-critique.md\",
  \"issues\": []  // list of issues if NEEDS_ITERATION, empty if APPROVED
}",
     description="Critique #NNN plan")
```

**Wait for result**:
```
result = TaskOutput(task_id=[critique-task-id], block=true, timeout=300000)
```

**Parse JSON result** and route:
- If `result.result == "APPROVED"` -> Step 4 (approve flow)
- If `result.result == "NEEDS_ITERATION"` -> Step 4 (rejection flow with `result.issues`)

### Step 4: Execute Transition

#### Approval Flow (APPROVED)

1. **Move issue to "In Progress"**:
   ```
   ralph_hero__update_workflow_state
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - state: "__COMPLETE__"
   - command: "ralph_review"
   ```

   **Error handling**: If `update_workflow_state` returns an error, read the error message — it contains valid states/intents and a specific Recovery action. Retry with the corrected parameters.

2. **Add approval comment** (per Artifact Comment Protocol in shared/conventions.md):
   ```
   ralph_hero__create_comment
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - body: |
       ## Plan Review

       VERDICT: APPROVED

       [INTERACTIVE]: Approved by human review.
       [AUTO]: Approved by automated critique - no major issues found.

       [If AUTO mode]: Full critique: [GitHub URL to critique_path]

       [If minor changes noted]: Minor adjustments requested: [list]

       Ready for implementation. Run `/ralph-impl NNN` to begin.
   ```

   **Note**: Do NOT use any link attachment mechanism. Reference critique in comment only.

#### Rejection Flow (NEEDS_ITERATION)

1. **Add `needs-iteration` label**:
   ```
   ralph_hero__update_issue
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - labels: [existing_labels..., "needs-iteration"]
   ```

   Note: Read current labels first, then append "needs-iteration".

2. **Move issue to "Ready for Plan"**:
   ```
   ralph_hero__update_workflow_state
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - state: "Ready for Plan"
   - command: "ralph_review"
   ```

3. **Add feedback comment** (per Artifact Comment Protocol in shared/conventions.md):
   ```
   ralph_hero__create_comment
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - body: |
       ## Plan Review

       VERDICT: NEEDS_ITERATION

       Issues identified:
       - [Issue 1]
       - [Issue 2]

       [INTERACTIVE]: Based on human feedback.
       [AUTO]: Based on automated critique. Full critique: [GitHub URL to critique_path]

       Label `needs-iteration` added.

       Run `/ralph-plan NNN` to address these issues and update the plan.
   ```

   **Note**: Do NOT use any link attachment mechanism. Reference critique in comment only.

### Step 5: Report Completion

**If APPROVED**:
```
Review complete for GH-NNN: [Title]

Mode: [INTERACTIVE/AUTO]
Result: APPROVED

Issue: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
Status: In Progress

Ready for implementation. Run /ralph-impl NNN
```

**If NEEDS_ITERATION**:
```
Review complete for GH-NNN: [Title]

Mode: [INTERACTIVE/AUTO]
Result: NEEDS ITERATION

Issues:
- [Issue 1]
- [Issue 2]

Issue: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
Status: Ready for Plan
Label: needs-iteration

Run /ralph-plan NNN to address critique and update plan.
```

## Escalation Protocol

**When to escalate:**

| Situation | Action |
|-----------|--------|
| Plan document missing | STOP with message - not escalation |
| Research document missing (plan references it) | @mention: "Plan references missing research document. Cannot validate." |
| Conflicting requirements in plan | @mention: "Plan has internal contradictions: [details]" |
| Cannot determine plan quality | @mention: "Unable to assess plan - ambiguous scope/requirements." |
| INTERACTIVE: User abandons wizard | STOP: "Review canceled. Issue remains in Plan in Review." |

**How to escalate:**

1. Move issue to "Human Needed":
   ```
   ralph_hero__update_workflow_state
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - state: "__ESCALATE__"
   - command: "ralph_review"
   ```

2. Add comment with @mention:
   ```
   ralph_hero__create_comment
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - body: "@$RALPH_GH_OWNER Escalation: [issue description]"
   ```

3. STOP and report.

## Available Filter Profiles

| Profile | Expands To | Use Case |
|---------|-----------|----------|
| `validator-review` | `workflowState: "Plan in Review"` | Find plans awaiting review |

Profiles set default filters. Explicit params override profile defaults.

## Constraints

- Work on ONE issue only
- XS/Small estimates only (exit if none available)
- INTERACTIVE: Use AskUserQuestion wizard
- AUTO: Delegate critique to subagent, receive JSON result only
- No code changes - review only
- Complete within 10 minutes

## Quality Guidelines

**Focus on**:
- Plan completeness (all phases defined)
- Success criteria specificity (testable)
- Scope boundaries (what we're NOT doing)
- Technical feasibility (files exist, patterns valid)

**Avoid**:
- Rubber-stamping without analysis
- Over-critiquing minor style issues
- Blocking on subjective preferences
- Creating critique without actionable feedback

## Link Formatting

When referencing code, use GitHub links:
`[path/file.py:42](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42)`
