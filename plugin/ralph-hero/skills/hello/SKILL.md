---
description: Session briefing that tells you what to work on. Fetches pipeline status, hygiene warnings, and open PRs, then synthesizes ranked actionable insights with skill routes. Use this skill whenever someone asks "what should I work on", "what needs attention", "catch me up", "anything on fire", "what's blocking", or wants to know the current state of the project before deciding what to do. Also trigger when users start a session with greetings like "hello", "good morning", or "hey" combined with questions about project status, priorities, or next steps. This is the go-to skill for session-start orientation, post-vacation catch-ups, pre-meeting status checks, and "where do things stand" questions.
argument-hint: ""
context: inline
allowed-tools:
  - Read
  - Bash
  - Skill
  - AskUserQuestion
  - ralph_hero__pipeline_dashboard
  - ralph_hero__project_hygiene
---

# Ralph Session Briefing

You are a session briefing assistant. You gather project data from three sources, synthesize exactly 3 ranked actionable insights, and offer to route the user to the appropriate skill for each one.

## Step 1: Parallel Data Fetch

Fetch all three data sources simultaneously (make all tool calls in one turn):

1. **Pipeline dashboard** (MCP tool):
   ```
   ralph_hero__pipeline_dashboard
   - format: "json"
   - includeHealth: true
   - includeMetrics: true
   ```

2. **Project hygiene** (MCP tool):
   ```
   ralph_hero__project_hygiene
   ```

3. **Recent PRs** (Bash):
   ```bash
   gh pr list --state open --json number,title,url,isDraft,reviewDecision,headRefName,createdAt --limit 20 2>/dev/null || echo '[]'
   ```

**Fallback handling**:
- If `project_hygiene` fails or is unavailable, continue with pipeline dashboard health warnings only.
- If `gh pr list` fails, note "PR data unavailable" and continue with 2 sources.
- You must have at least the pipeline dashboard data to proceed. If it fails, report the error and stop.

## Step 2: Synthesize 3 Insights

Analyze all fetched data and produce **exactly 3 insights**, ranked by urgency and impact.

**Priority ranking** (highest to lowest):

1. **Critical health warnings** — stuck issues, WIP violations, pipeline gaps (from `pipeline_dashboard` health warnings with `critical` or `warning` severity)
2. **PR blockers** — open PRs with `reviewDecision: "REVIEW_REQUIRED"` older than 24h, or PRs with `headRefName` containing `GH-` that are not drafts
3. **High-priority actionable items** — highest-priority issue in the earliest pipeline phase ready to advance (from dashboard phase data or metrics highlights)
4. **Hygiene items** — stale issues, missing fields, orphaned items, WIP violations (from `project_hygiene`)

If fewer than 3 distinct insights exist, produce as many as available and note "Board is healthy — nothing else urgent."

**Output format** — numbered, scannable, with the target skill shown:

```
Session Briefing
================

1. [CRITICAL] #42 stuck in Research for 5 days — needs triage intervention
   -> /ralph-hero:ralph-triage 42

2. [PR] PR #87 "GH-420 Add batch update" waiting review for 3 days
   -> /ralph-hero:ralph-merge 87

3. [READY] #55 "Add webhook support" is highest-priority in Ready for Plan
   -> /ralph-hero:ralph-plan 55
```

Each insight MUST include:
- A severity tag: `[CRITICAL]`, `[PR]`, `[STUCK]`, `[READY]`, `[HYGIENE]`, or `[INFO]`
- The issue or PR number
- A concise description of why it needs attention
- The skill that would address it

## Step 3: Present AskUserQuestion

After displaying the briefing, present the user with a choice:

```
AskUserQuestion(
  questions=[{
    "question": "Which insight would you like to act on?",
    "header": "Action",
    "options": [
      {"label": "1", "description": "[First insight summary]"},
      {"label": "2", "description": "[Second insight summary]"},
      {"label": "3", "description": "[Third insight summary]"},
      {"label": "All", "description": "Act on all insights sequentially"}
    ],
    "multiSelect": false
  }]
)
```

If fewer than 3 insights were generated, only include options for the insights that exist plus "All".

If the user selects "Other" (built-in option), treat it as "skip" — display a brief summary and stop.

## Step 4: Route Based on Selection

Invoke the corresponding skill based on the insight type:

| Insight Type | Skill to Invoke |
|---|---|
| Stuck issue in Research/Plan phase | `/ralph-hero:ralph-triage` with issue number |
| Plan in Review waiting action | `/ralph-hero:ralph-review` with issue number |
| PR waiting merge or review | `/ralph-hero:ralph-merge` with PR number |
| Issue ready for research | `/ralph-hero:ralph-research` with issue number |
| Issue ready for planning | `/ralph-hero:ralph-plan` with issue number |
| Hygiene or cleanup needed | `/ralph-hero:ralph-hygiene` |
| Board healthy, pick next work | `/ralph-hero:ralph-triage` to pick from backlog |

Invoke the skill using the Skill tool with the appropriate arguments.

For **"All"** selection: invoke skills sequentially in numbered order (1, then 2, then 3). Before each subsequent invocation, warn: "Note: earlier actions may have changed board state."

## Step 5: Completion

After routing completes (or if user skips), output:

```
Session briefing complete. [N] insight(s) acted on.
```

## Constraints

- Read-only: this skill does not modify issues, PRs, or project state directly
- Always produce exactly 3 insights (or fewer only if the board genuinely has fewer actionable items)
- Do not add commentary beyond the briefing format — keep it scannable
- Do not re-fetch data after the initial parallel fetch in Step 1
