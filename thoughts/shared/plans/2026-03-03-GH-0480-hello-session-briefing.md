---
date: 2026-03-03
status: draft
github_issues: [480]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/480
primary_issue: 480
---

# `/hello` Session Briefing Command - Implementation Plan

## Overview

Single issue implementation: create a new `/ralph-hero:ralph-hello` skill that automates session cold-start by fetching pipeline data, hygiene status, and PR activity, synthesizing 3 ranked actionable insights, and routing the user to the appropriate skill.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-480 | Add `/hello` session briefing command with actionable insights | S |

## Current State Analysis

Three data sources already exist in the deployed MCP server and CLI:
- **`ralph_hero__pipeline_dashboard`** — phase counts, health warnings, stuck issues, velocity metrics
- **`ralph_hero__project_hygiene`** — stale items, WIP violations, missing fields, orphaned issues
- **`gh pr list`** — open PRs with review status, age, branch info

Two adjacent skills provide patterns but neither synthesizes insights nor routes to action:
- [`ralph-status`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-status/SKILL.md) — single MCP call, displays dashboard verbatim, model: haiku
- [`ralph-hygiene`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-hygiene/SKILL.md) — multi-step data fetch with conditional logic, model: sonnet

The [`ralph-review`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-review/SKILL.md) skill demonstrates the `AskUserQuestion` routing pattern with cascading options and skill invocation.

## Desired End State

A new skill at `plugin/ralph-hero/skills/ralph-hello/SKILL.md` that:
1. Fetches data from 3 sources in parallel
2. Synthesizes exactly 3 ranked insights (urgency/impact order)
3. Presents a scannable briefing with numbered insights
4. Offers `AskUserQuestion` routing (1/2/3/all/skip)
5. Routes to the appropriate skill based on insight type

### Verification
- [ ] Skill file exists at `plugin/ralph-hero/skills/ralph-hello/SKILL.md`
- [ ] Skill is discoverable via `/ralph-hero:ralph-hello`
- [ ] Invocation fetches pipeline dashboard, hygiene report, and PR list
- [ ] Produces exactly 3 ranked insights
- [ ] `AskUserQuestion` presents 5 options (insight 1/2/3/all/skip)
- [ ] Selection routes to correct skill (triage, research, plan, review, merge)
- [ ] Gracefully handles missing/unavailable data sources (fallback messaging)

## What We're NOT Doing
- No new MCP server tools (all data sources exist)
- No Stop/postcondition hook (read-only skill, no artifact produced)
- No PreToolUse or PostToolUse hooks (no mutations to gate)
- No deterministic ranking algorithm (LLM synthesis for v1; can promote to MCP tool later)
- No `RALPH_REQUIRED_BRANCH` (read-only, safe to run from any branch)

## Implementation Approach

Single-phase creation of one `SKILL.md` file (~120-150 lines). The skill follows the `ralph-hygiene` multi-step pattern for data fetching and the `ralph-review` pattern for `AskUserQuestion` routing. Model is `sonnet` for synthesis reasoning.

---

## Phase 1: Create `ralph-hello` Skill (GH-480)
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/480 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-03-GH-0480-hello-session-briefing.md

### Changes Required

#### 1. Create skill directory and SKILL.md
**File**: `plugin/ralph-hero/skills/ralph-hello/SKILL.md` (new)

**Frontmatter**:
```yaml
---
description: Session briefing with actionable insights. Fetches pipeline status, hygiene warnings, and recent PRs, synthesizes 3 ranked insights, and routes to the appropriate skill. Use when starting a session, checking what needs attention, or deciding what to work on next.
argument-hint: ""
context: fork
model: sonnet
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=hello"
allowed-tools:
  - Read
  - Bash
---
```

Key decisions:
- `model: sonnet` — multi-step reasoning for synthesis + routing (not haiku, which is too simple; not opus, which is overkill for read-only)
- `context: fork` — standard isolation from parent session
- `allowed-tools: [Read, Bash]` — matches `ralph-status` pattern; Bash needed for `gh pr list` CLI call
- No `RALPH_REQUIRED_BRANCH` — read-only skill, safe from any branch (consistent with `ralph-status` and `ralph-report`)
- No Stop/PreToolUse/PostToolUse hooks — nothing to validate or gate

**Prompt body** (~100-120 lines) structured as a 5-step workflow:

**Step 1: Parallel Data Fetch**

Fetch all three data sources simultaneously (multiple tool calls in one turn):
1. `ralph_hero__pipeline_dashboard(format="json", includeHealth=true, includeMetrics=true)` — phase counts, health warnings, stuck issues, recently completed
2. `ralph_hero__project_hygiene` — stale items, WIP violations, missing fields
3. `gh pr list --state open --json number,title,url,isDraft,reviewDecision,headRefName,createdAt --limit 20` via Bash — open PRs with review status

Include fallback instructions: if `project_hygiene` fails or is unavailable, fall back to health warnings from `pipeline_dashboard` only. If `gh pr list` fails, note "PR data unavailable" and continue with 2 sources.

**Step 2: Synthesize 3 Insights**

Instruct the model to analyze all fetched data and produce exactly 3 insights ranked by urgency/impact:

Priority ranking guidance:
1. **Critical health warnings** — stuck issues, WIP violations (from `pipeline_dashboard` health warnings with `critical` severity)
2. **PR blockers** — open PRs with `reviewDecision: "REVIEW_REQUIRED"` older than 24h, or PRs with `headRefName` containing `GH-` (project PRs)
3. **High-priority actionable items** — highest-priority issue in earliest pipeline phase ready to advance
4. **Hygiene items** — stale issues, missing fields, orphaned items (from `project_hygiene`)

Output format (numbered, scannable):
```
Session Briefing
================

1. [CRITICAL] #42 stuck in Research for 5 days — needs triage intervention
   → /ralph-hero:ralph-triage

2. [PR] PR #87 "GH-420 Add batch update" waiting review for 3 days
   → /ralph-hero:ralph-merge

3. [READY] #55 "Add webhook support" is highest-priority in Ready for Plan
   → /ralph-hero:ralph-plan
```

If fewer than 3 distinct insights exist, produce as many as available and note "Board is healthy — nothing urgent."

**Step 3: Present AskUserQuestion**

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

Note: If the user selects "Other" (built-in option), treat as "skip" — display the briefing summary and stop.

**Step 4: Route Based on Selection**

Routing map (instruct model to invoke the corresponding skill):

| Insight Type | Skill to Invoke |
|---|---|
| Stuck issue in Research/Plan phase | `/ralph-hero:ralph-triage` with issue number |
| Plan in Review waiting action | `/ralph-hero:ralph-review` with issue number |
| PR waiting merge/review | `/ralph-hero:ralph-merge` with PR number |
| Issue ready for research | `/ralph-hero:ralph-research` with issue number |
| Issue ready for planning | `/ralph-hero:ralph-plan` with issue number |
| Hygiene/cleanup needed | `/ralph-hero:ralph-hygiene` |
| Board healthy, pick next work | `/ralph-hero:ralph-hero` for autonomous processing |

For "All" selection: invoke skills sequentially in numbered order (1 → 2 → 3). Warn that earlier actions may change state affecting later insights.

**Step 5: Completion**

After routing completes (or if user skips), output:
```
Session briefing complete. [N] insight(s) acted on.
```

### Success Criteria
- [ ] Automated: `test -f plugin/ralph-hero/skills/ralph-hello/SKILL.md` — file exists
- [ ] Automated: `grep -q 'RALPH_COMMAND=hello' plugin/ralph-hero/skills/ralph-hello/SKILL.md` — hook configured
- [ ] Automated: `grep -q 'pipeline_dashboard' plugin/ralph-hero/skills/ralph-hello/SKILL.md` — uses dashboard tool
- [ ] Automated: `grep -q 'project_hygiene' plugin/ralph-hero/skills/ralph-hello/SKILL.md` — uses hygiene tool
- [ ] Automated: `grep -q 'gh pr list' plugin/ralph-hero/skills/ralph-hello/SKILL.md` — uses PR CLI
- [ ] Automated: `grep -q 'AskUserQuestion' plugin/ralph-hero/skills/ralph-hello/SKILL.md` — has routing
- [ ] Manual: Invoke `/ralph-hero:ralph-hello` — produces 3 insights and offers routing

---

## Integration Testing
- [ ] Invoke `/ralph-hero:ralph-hello` from main branch — full flow completes
- [ ] Invoke from a feature branch — still works (no branch gate)
- [ ] Test with empty board (no issues) — graceful "nothing urgent" message
- [ ] Test insight selection routing — each option invokes correct skill
- [ ] Test "Other"/skip path — displays briefing and stops cleanly

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-03-GH-0480-hello-session-briefing.md
- Idea: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/ideas/2026-03-01-hello-session-briefing.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/480
- Pattern reference — ralph-status: [plugin/ralph-hero/skills/ralph-status/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-status/SKILL.md)
- Pattern reference — ralph-hygiene: [plugin/ralph-hero/skills/ralph-hygiene/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-hygiene/SKILL.md)
- Pattern reference — ralph-review AskUserQuestion: [plugin/ralph-hero/skills/ralph-review/SKILL.md:130-185](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-review/SKILL.md#L130-L185)
