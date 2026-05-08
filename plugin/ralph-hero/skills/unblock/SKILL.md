---
description: Interactive unblock — answers the questions posted by ralph-unblock on a Human Needed issue, captures answers via AskUserQuestion, posts ## Unblock Resolution, routes the issue back into the pipeline. Use when you want to unblock a Human Needed issue.
user-invocable: true
argument-hint: "[optional-issue-number]"
context: inline
model: sonnet
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=unblock RALPH_VALID_OUTPUT_STATES='Backlog,Research Needed,Ready for Plan,In Progress'"
  PostToolUse:
    - matcher: "ralph_hero__save_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/unblock-state-gate.sh"
allowed-tools:
  - Read
  - Bash
  - AskUserQuestion
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

# Ralph GitHub Unblock - Interactive Loop Closer

You are the interactive half of the unblock skill pair. You walk a human through the questions posted by `/ralph-hero:ralph-unblock` on a Human Needed issue, capture each answer, infer a return state from the originating command, post a `## Unblock Resolution` comment, and transition the issue back into the pipeline.

This skill is **interactive** — it can be aborted by the user mid-flow. There is no Stop postcondition. The state-gate hook on `ralph_hero__save_issue` is the only enforcement boundary.

## Workflow

### Step 1: Select Issue

**If issue number provided as argument**: Fetch the full issue (with comments) via `get_issue`.

- If the issue is NOT in `workflowState: "Human Needed"`, STOP and respond:
  ```
  Issue #NNN is in [state] (expected: Human Needed). Aborting.
  ```
  Do NOT proceed to any subsequent step.

**If no issue number**: List candidate issues with `workflowState: "Human Needed"`, `orderBy: "CREATED_AT"` ascending, `limit: 50`. For each candidate, fetch the full issue (with comments) and check whether it has a `## Unblock Request` comment. Filter to candidates that have a `## Unblock Request`.

- **Zero candidates**: respond `No Human Needed issues with an Unblock Request found. Run /ralph-hero:ralph-unblock first to post questions.` Then STOP.
- **One candidate**: auto-select it (no picker friction). Print `Selected #NNN: [Title]` and proceed.
- **Multiple candidates**: present `AskUserQuestion` with one option per candidate. Each option label: `"#NNN · <title fragment>"` where the fragment is the issue title truncated to ≤30 chars (with `…` suffix when truncated). Description: a short clause naming the originating skill if extractable from `## Escalation` (e.g., "ralph_impl escalated 2 days ago"). After the user picks, fetch that issue's full details for the next step.

### Step 2: Load Context

For the selected issue:

1. Re-read the issue body in full.
2. Find the most recent `## Escalation` comment (header line begins with `## Escalation`). If present, extract:
   - The reason text after `Escalation:`
   - The originating skill/command name (e.g., "during ralph_impl", "ralph_plan needed clarification") — best effort. If not extractable, set `originating_command = null`.
3. Find the most recent `## Unblock Request` comment.
   - **If present**: parse out the numbered questions (lines matching `^\d+\.\s`). Capture each question verbatim. This is the question list to walk through.
   - **If absent**: regenerate questions inline. Print to the user:
     ```
     No `## Unblock Request` exists yet — I'll generate questions on the fly.
     To pre-generate, run `/ralph-hero:ralph-unblock` first next time.
     ```
     Then synthesize 1–5 pointed questions grounded in the `## Escalation` text + issue body, following the same rules as the autonomous skill (specific, answerable, grounded). Cap at 5.

### Step 3: Walk Through Questions

For each question, in order:

- **If multiple-choice phrasing is present** (the question explicitly enumerates options like "A vs B", "(a) X (b) Y", or "either X or Y"): present an `AskUserQuestion` with one option per enumerated choice plus a freeform `"Other (explain)"` fallback option.
- **Otherwise**: present an `AskUserQuestion` with a single open-ended option labeled `"Answer"` and use the `description` to surface the question text. Capture the user's response as the freeform answer.

Capture each `(question, answer)` pair in order. Do not skip questions; if the user provides an unhelpful answer, accept it as-is — surface the issue back to the human via the resolution comment.

### Step 4: Determine Return State

Apply the originating-command heuristic:

| Originating command (from `## Escalation`) | Default return state |
|---|---|
| `ralph_research` | `Research Needed` |
| `ralph_plan` / `ralph_plan_epic` | `Ready for Plan` |
| `ralph_review` | `Ready for Plan` (re-plan with new direction) |
| `ralph_impl` / `ralph_pr` / `ralph_merge` / `ralph_code_review` | `In Progress` |
| `ralph_triage` | `Backlog` |
| None / unknown | `In Progress` (most common case) |

Then **always confirm** the inferred state via `AskUserQuestion`. Present exactly four options, with the heuristic-suggested option listed FIRST so it is the default:

- `In Progress` — resume implementation
- `Ready for Plan` — re-plan with new direction
- `Research Needed` — gather more information first
- `Backlog` — defer / not actionable now

Reorder the four options so the inferred default is first; the relative order of the other three is fixed (In Progress, Ready for Plan, Research Needed, Backlog with the inferred one bubbled to position 1).

Capture the user's choice as `chosen_state`.

### Step 5: Post `## Unblock Resolution` Comment

Compose the comment body following this template exactly:

```markdown
## Unblock Resolution

### Q&A
1. **Q**: [Question 1]
   **A**: [Answer 1]
2. **Q**: [Question 2]
   **A**: [Answer 2]
...

Routing to: `[chosen_state]`
```

Notes:
- Numbering matches the original `## Unblock Request` numbering when the request was present; otherwise renumber from 1.
- Quote each question verbatim. Quote each answer verbatim (preserve user phrasing — do not paraphrase).
- The `Routing to:` line names the chosen state literally (one of the 4 valid re-entry states).

Post the comment via `ralph_hero__create_comment`.

### Step 6: Transition State

Call `save_issue` with:
- `number` = the issue number
- `workflowState` = `chosen_state` (one of: `Backlog`, `Research Needed`, `Ready for Plan`, `In Progress`)
- `command` = `"ralph_unblock"`

The `unblock-state-gate.sh` PostToolUse hook validates `tool_input.workflowState` is one of the 5 allowed values (`Backlog`, `Research Needed`, `Ready for Plan`, `In Progress`, `Human Needed`). If a buggy attempt sets state `Done` or `Plan in Review`, the hook blocks with a clear message and the skill must abort — do NOT retry blindly.

If `save_issue` errors for any other reason (e.g., GitHub API failure), surface the error and STOP. The `## Unblock Resolution` comment was already posted, so re-running the skill on the same issue would post a duplicate comment — instead, ask the human to manually transition the issue from the GitHub Projects board.

### Step 7: Record Outcome Event

Call `knowledge_record_outcome` with the canonical payload:

```
knowledge_record_outcome(
  event_type="unblock_resolved",
  issue_number=NNN,
  agent_type="ralph_unblock",
  payload={
    "question_count": <number of questions answered>,
    "return_state": "<chosen_state>",
    "originating_command": <"ralph_impl" | ... | null>
  }
)
```

If the `knowledge_record_outcome` tool is unavailable (graceful degradation), skip the call silently — do NOT fail the skill. The `## Unblock Resolution` comment plus the state transition are the source of truth; the outcome event is auxiliary.

### Step 8: Report

Print a final report:

```
Unblocked #NNN: [Title]
Routed to: [chosen_state]
Questions answered: [N]
Originating skill: [ralph_impl | ... | (unknown)]
```

Then STOP.

## Constraints

- Work on ONE issue only per invocation.
- Always confirm the inferred return state via `AskUserQuestion` — never silently transition based on the heuristic alone.
- The chosen state MUST be one of `Backlog`, `Research Needed`, `Ready for Plan`, `In Progress`. The `unblock-state-gate.sh` hook will block anything else (including `Plan in Review`, `Done`, `Canceled`).
- Post the `## Unblock Resolution` comment BEFORE calling `save_issue`. If the state transition fails, the comment remains as the audit trail of what was decided.
- Quote questions and answers verbatim in the resolution comment — do not paraphrase user input.
- If `knowledge_record_outcome` is unavailable, skip silently. The comment + state transition are the source of truth.
- The `unblock-state-gate.sh` allows `Human Needed` for no-op saves (e.g., label-only updates), but the chosen-state value coming out of Step 4 must always be one of the 4 forward-routing states.

## Escalation Protocol

This skill closes the escalation loop. It does NOT escalate further on its own — if the user provides answers that the skill cannot route (e.g., the user types "I don't know"), capture the answer verbatim, route to `Backlog` if no clear forward state applies, and let the next pipeline run re-evaluate.

If a true tool failure arises (API errors, comment post fails, etc.) AFTER the user has invested time answering questions, surface the error and ask the human to manually transition the issue. Do NOT silently swallow the error.

## Link Formatting

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/link-formatting.md
