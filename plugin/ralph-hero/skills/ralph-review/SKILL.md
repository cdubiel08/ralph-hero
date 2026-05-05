---
description: Review and critique implementation plans before coding begins. INTERACTIVE mode for human review, AUTO mode for automated critique. Use when you want to review a plan, approve or reject a spec, or run quality gates on plans.
user-invocable: false
argument-hint: <issue-number> [--review-plan auto|interactive] [--interactive] [--plan-doc path]
context: fork
model: opus
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=review RALPH_REQUIRED_BRANCH=main RALPH_VALID_INPUT_STATES='Plan in Review' RALPH_VALID_OUTPUT_STATES='In Progress,Ready for Plan,Human Needed' RALPH_ARTIFACT_DIR=thoughts/shared/reviews RALPH_MAX_ESTIMATE=S RALPH_REQUIRES_PLAN=true"
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/branch-gate.sh"
    - matcher: "Write"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/review-no-dup.sh"
    - matcher: "ralph_hero__save_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/review-state-gate.sh"
    - matcher: "AskUserQuestion"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/review-plan-gate.sh"
  PostToolUse:
    - matcher: "Write"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/review-verify-doc.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/review-postcondition.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/doc-structure-validator.sh"
allowed-tools:
  - Read
  - Write
  - Glob
  - Grep
  - Bash
  - Agent
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - AskUserQuestion
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`
- Plan review mode: !`echo ${RALPH_REVIEW_PLAN:-auto}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

# Ralph GitHub Review - Plan Quality Gate

You are a plan reviewer. You assess ONE plan, determine if it's ready for implementation, and route accordingly. Two modes:

- **INTERACTIVE**: Human reviews via wizard, immediate approval/rejection
- **AUTO**: Opus critiques in isolated context, routes based on quality

## Workflow

### Step 1: Detect Execution Mode

If `--review-plan` is provided in args (e.g., `--review-plan auto`), export it to persist for hooks:
```bash
export RALPH_REVIEW_PLAN=<value>
```
This overrides the load-time default. If not provided, the backtick-resolved default applies.

Parse arguments for mode flag:
- If `--interactive` flag present OR plan review mode is "interactive" → INTERACTIVE mode
- Otherwise → AUTO mode

Report mode:
```
Starting ralph-review in [INTERACTIVE/AUTO] mode
```

### Step 2: Select Issue

**If issue number provided**: Fetch it directly
**If no issue number**: Find highest-priority XS/Small issue in "Plan in Review"

List issues using profile "review-queue" (expands to workflowState: "Plan in Review"), ordered by priority, limit 1.

If no eligible issues:
```
No XS/Small issues in Plan in Review. Queue empty.
```
Then STOP.

### Step 3: Validate Plan Exists

1. Fetch the full issue details with context.

2. **Find linked plan document**:

   **Knowledge graph shortcut**: If a knowledge search tool is available, try it first: search for "implementation plan GH-${number} [issue title keywords]", type "plan", limit 3.
   If a high-relevance result is returned, read that file directly and skip steps 1-8 below. If not available or no results, continue with standard Artifact Comment Protocol discovery below.

   **Artifact shortcut**: If `--plan-doc` flag was provided in args and the file exists on disk, read it directly and skip steps 1-8 below. If the file does not exist, log `"Artifact flag path not found, falling back to discovery: [path]"` and continue with standard discovery.

   Find the plan using the Artifact Comment Protocol:
   1. Search issue comments for `## Implementation Plan` or `## Group Implementation Plan` header. If multiple matches, use the **most recent** (last) match.
   2. Extract the GitHub URL from the line after the header
   3. Convert to local path: strip `https://github.com/OWNER/REPO/blob/main/` prefix
   4. Read the plan document fully
   5. **Fallback**: If no comment found, glob for the plan doc. Try both padded and unpadded:
      - `thoughts/shared/plans/*GH-${number}*`
      - `thoughts/shared/plans/*GH-$(printf '%04d' ${number})*`
      Use the most recent match if multiple found.
   6. **Group fallback**: If standard glob fails, try `thoughts/shared/plans/*group*GH-{primary}*` where `{primary}` is the primary issue number from the issue's group context.
   7. **If fallback found, self-heal**: Post the missing artifact comment on the issue:
      ```markdown
      ## Implementation Plan

      https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/[path]

      (Self-healed: artifact was found on disk but not linked via comment)
      ```
   8. **If neither found**:
      ```
      Issue #NNN has no implementation plan attached.
      Cannot review without a plan. Run /ralph-plan first.
      ```
      Then STOP.

4. Store issue number for postcondition hook:
   - Set `RALPH_TICKET_ID` environment context (format: `GH-NNN`)

### Step 4A: INTERACTIVE Mode - Wizard Review

**Read plan document** into context (needed for inline review).

**Display plan summary** before presenting the picker. Print a terminal-readable block extracted from the plan document so a reviewer who has not opened the file still has enough context to vote:

```
====================================================
Plan Review: GH-NNN - [Plan Title from frontmatter or H1]
====================================================
Phases:        [count of "## Phase" headings]
Estimate:      [from frontmatter or "unset"]
Plan path:     [local plan path]

Top-level Success Criteria:
  - [first 3-5 bullets from the plan's "Success Criteria" / "Verification" section, or first phase's automated verification if no top-level section]

What we're NOT doing:
  - [first 3 bullets from the "What we're NOT doing" / "Out of scope" section, or "(not specified)" if absent]
====================================================
```

Extraction rules:
- Title: prefer H1 ("# Plan: …") or plan frontmatter `title:`. Fall back to issue title.
- Phase count: `grep -c "^## Phase" <plan-path>` — show "(no explicit phases)" if 0.
- Success criteria: first list under a `## Success Criteria`, `## Desired End State`, or `### Verification` heading. Truncate to 5 bullets; show "(see plan)" suffix when truncated.
- Out of scope: first list under a `## What we're NOT doing` or `## Out of Scope` heading.

This summary is informational only — it does not gate the picker. The reviewer can still pick "Open in editor" to read the full plan.

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
      {"label": "Reject", "description": "Plan is fundamentally flawed, needs complete redo"},
      {"label": "Open in editor", "description": "Opens plan file in system default editor — picker re-appears after"}
    ],
    "multiSelect": false
  }]
)
```

**Route based on response**:

**If "Open in editor"**:
```bash
if [[ "$(uname -s)" == "Darwin" ]]; then
  open "<plan-local-path>"
else
  xdg-open "<plan-local-path>"
fi
```
where `<plan-local-path>` is the local file path discovered in Step 3.

Then re-present this same picker (loop until a verdict is selected).

**If "Approve"**:
-> Proceed to Step 5 (approve flow)

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
-> Proceed to Step 5 (approve flow with notes)

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

After the multi-select returns, capture **free-text specifics** so the rejection comment carries actionable feedback (not just category labels):

```
AskUserQuestion(
  questions=[{
    "question": "Provide specific feedback the planner needs to act on (free text). Press Enter to skip.",
    "header": "Details",
    "options": [
      {"label": "Type details", "description": "Open multi-line input for specific issue descriptions, file references, or alternative approaches"},
      {"label": "Skip", "description": "Use only the categories selected above"}
    ],
    "multiSelect": false
  }]
)
```

If "Type details" is chosen, prompt the reviewer for free-text and append it under a "**Reviewer notes**" subheading inside the issues list passed to Step 5. The free-text body becomes the primary feedback in the GitHub comment; the category labels are a secondary tag list.

-> Proceed to Step 5 (rejection flow with issues + free-text notes)

### Step 4B: AUTO Mode - Delegated Critique

**Spawn critique in separate context window**:

The critique prompt below inlines the canonical plan-quality criteria from
`plugin/ralph-hero/skills/shared/quality-standards.md` so the `general-purpose`
subagent does not need to re-derive them. When `quality-standards.md` changes,
update this prompt in the same PR.

> **Follow-up**: Consider creating a `ralph-hero:review-critique-agent` to
> replace `general-purpose` with a purpose-built critique agent that preloads
> ralph-review + quality-standards. See future ticket. The inline-criteria
> approach below is the interim fix.

```
Agent(subagent_type="general-purpose",
     prompt="You are executing an autonomous plan critique for #NNN.

INSTRUCTIONS:
1. Read the plan document attached to issue #NNN

2. Analyze the plan against the FIVE plan-quality dimensions
   (canonical source: plugin/ralph-hero/skills/shared/quality-standards.md):

   1. Completeness — All phases defined with specific file changes and clear descriptions.
   2. Feasibility — Referenced files exist; patterns are valid and follow existing codebase conventions.
   3. Clarity — Success criteria are specific and testable (\`- [ ] Automated:\` / \`- [ ] Manual:\` format).
   4. Scope — 'What we're NOT doing' section is explicit and well-bounded.
   5. Dispatchability — Every task is self-contained enough to dispatch to a subagent
      with zero additional context. No task should require reading the full plan
      to understand. Verify each task includes:

      | Field         | Required | Values                                  |
      |---------------|----------|-----------------------------------------|
      | files         | yes      | paths with (create/modify/read)         |
      | tdd           | yes      | true / false                            |
      | complexity    | yes      | low / medium / high                     |
      | depends_on    | yes      | null or [task IDs]                      |
      | acceptance    | yes      | checkbox list of verifiable criteria    |

   For multi-issue group plans, also verify:
     - Phase dependencies are explicit (each phase states what it creates for the next)
     - Integration testing section covers cross-phase interactions

3. Use codebase-analyzer to verify technical claims:
   Agent(subagent_type='ralph-hero:codebase-analyzer', prompt='Verify files mentioned in plan exist: [list files]')

4. Create critique document at: thoughts/shared/reviews/YYYY-MM-DD-GH-NNN-critique.md
   With frontmatter:
   ---
   date: YYYY-MM-DD
   github_issue: NNN
   github_url: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
   plan_document: [plan path]
   status: approved OR needs-iteration OR escalate
   type: review
   tags: [plan-review, relevant, component, tags]
   ---

   Body must include one section per dimension (Completeness, Feasibility,
   Clarity, Scope, Dispatchability) with PASS / FAIL / N/A and a one-line note.

5. Commit and push:
   git add thoughts/shared/reviews/*.md
   git commit -m 'docs(review): GH-NNN plan critique'
   git push origin main

6. Return ONLY this JSON (no other output):
{
  \"issue\": NNN,
  \"result\": \"APPROVED\" or \"NEEDS_ITERATION\" or \"ESCALATE\",
  \"critique_path\": \"thoughts/shared/reviews/YYYY-MM-DD-GH-NNN-critique.md\",
  \"issues\": [],     // list of issues if NEEDS_ITERATION; empty otherwise
  \"escalation_reason\": \"\"  // required when result == ESCALATE; describes why human input is needed
}

When to choose ESCALATE (not NEEDS_ITERATION):
- The plan has internal contradictions that you cannot resolve by listing issues
- Required research artifacts are missing or unreadable
- Scope is so ambiguous that the planner cannot reasonably iterate
- Any condition matching the 'Escalation Protocol' table in ralph-review SKILL.md",
     description="Critique #NNN plan")
```

> **Team Isolation**: Do NOT pass `team_name` to this critique `Agent()` call or any sub-agent `Agent()` calls within it. Sub-agents must run outside any team context.

**Wait for result**:
```
result = TaskOutput(task_id=[critique-task-id], block=true, timeout=300000)
```

**Parse JSON result** and route:
- If `result.result == "APPROVED"` -> Step 5 (approve flow)
- If `result.result == "NEEDS_ITERATION"` -> Step 5 (rejection flow with `result.issues`)
- If `result.result == "ESCALATE"` -> escalate per the Escalation Protocol below
  using the `escalation_reason` field as the message body. Move the issue to
  "Human Needed" via `save_issue` (workflowState "__ESCALATE__", command "ralph_review")
  and post a comment that includes the critique path and the escalation reason.

### Step 5: Execute Transition

#### Approval Flow (APPROVED)

1. **Move issue to "In Progress"**: advance the issue to the next state (workflowState "__COMPLETE__", command "ralph_review"). If an error is returned, read the message — it contains valid states/intents and a Recovery action. Retry with corrected parameters.

2. **Add approval comment** on the issue:
   ```markdown
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

1. **Add `needs-iteration` label**: Update the issue labels to include "needs-iteration" (preserve existing labels — read current labels first, then append "needs-iteration").

2. **Move issue to "Ready for Plan"**: update the issue workflow state to "Ready for Plan" (command: "ralph_review").

3. **Add feedback comment** on the issue:
   ```markdown
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

### Step 6: Team Result Reporting

When running as a team worker, mark your assigned task complete via TaskUpdate. Include key results in metadata (verdict, artifact path) and a human-readable summary in the description. Then check TaskList for more work matching your role.

### Step 7: Report Completion

**If APPROVED**:
```
Review complete for GH-NNN: [Title]

Mode: [INTERACTIVE/AUTO]
Result: APPROVED

Issue: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
Status: In Progress
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
```

## Escalation Protocol

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/escalation-steps.md

Use `command="ralph_review"` in state transitions.

**Review-specific triggers:**

| Situation | Action |
|-----------|--------|
| Plan document missing | STOP with message (not escalation) |
| Research document missing (plan references it) | Escalate: "Plan references missing research document. Cannot validate." |
| Conflicting requirements in plan | Escalate: "Plan has internal contradictions: [details]" |
| Cannot determine plan quality | Escalate: "Unable to assess plan - ambiguous scope/requirements." |
| INTERACTIVE: User abandons wizard | STOP: "Review canceled. Issue remains in Plan in Review." |

## Available Filter Profiles

| Profile | Expands To | Use Case |
|---------|-----------|----------|
| `review-queue` | `workflowState: "Plan in Review"` | Find plans awaiting review |

Profiles set default filters. Explicit params override profile defaults.

## Constraints

- Work on ONE issue only
- XS/Small estimates only (exit if none available)
- INTERACTIVE: Use AskUserQuestion wizard
- AUTO: Delegate critique to subagent, receive JSON result only
- No code changes - review only
- Complete within 10 minutes

## Quality Guidelines

See [shared/quality-standards.md](../shared/quality-standards.md) for canonical plan quality dimensions and review anti-patterns.

## Link Formatting

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/link-formatting.md
