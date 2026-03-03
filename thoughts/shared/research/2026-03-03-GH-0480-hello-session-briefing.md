---
date: 2026-03-03
github_issue: 480
github_url: https://github.com/cdubiel08/ralph-hero/issues/480
status: complete
type: research
---

# Research: `/hello` Session Briefing Command (GH-480)

## Problem Statement

Starting a Ralph session requires manually checking the pipeline dashboard, recent PRs, and board health to decide what to work on. This friction leads to missed items (stale PRs, stuck issues, unreviewed plans) and decision fatigue. The `/hello` command automates this cold-start ramp-up by pulling data from three sources, synthesizing exactly 3 ranked actionable insights, and interactively routing the user to the appropriate skill.

## Current State Analysis

### Existing Skills That Cover Adjacent Ground

Two read-only skills already exist but are purely informational — neither synthesizes insights nor routes to action:

- **`ralph-status`** ([plugin/ralph-hero/skills/ralph-status/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-status/SKILL.md)): One MCP call (`pipeline_dashboard`), displays `formatted` field verbatim. 33 lines. Model: `haiku`. No routing.
- **`ralph-hygiene`** ([plugin/ralph-hero/skills/ralph-hygiene/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-hygiene/SKILL.md)): Multi-step flow — dashboard → eligibility report → optional `project_hygiene` → optional archive. 106 lines. Model: `sonnet`. No routing.

### Existing MCP Tools for Data Gathering

All three required data sources are already implemented:

1. **`ralph_hero__pipeline_dashboard`** — Phase counts, health warnings (stuck/WIP/pipeline gaps), archive eligibility, velocity metrics. Used by both ralph-status and ralph-hygiene.
2. **`ralph_hero__project_hygiene`** — Detailed hygiene report: orphaned issues, missing fields, stale items, WIP violations, duplicates. Available in deployed MCP server.
3. **`ralph_hero__list_issues`** — Can query recent activity: newly created issues, recently closed, high-priority items.

For recent PR activity, `gh` CLI is the correct tool (`gh pr list --state open --json ...`) — the MCP server does not have a dedicated PR listing tool.

### Skill Architecture Patterns

Every skill is a single `SKILL.md` file. Structure is: YAML frontmatter + markdown LLM prompt. Key frontmatter fields:

```yaml
description: ...
argument-hint: ...
context: fork          # isolates from parent session
model: sonnet          # appropriate for synthesis + routing
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=hello RALPH_REQUIRED_BRANCH=main"
allowed-tools:
  - Read
  - Bash
```

### `AskUserQuestion` Routing Pattern

From `ralph-review` ([plugin/ralph-hero/skills/ralph-review/SKILL.md:130-185](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-review/SKILL.md#L130-L185)):

```
AskUserQuestion(
  questions=[{
    "question": "Which insight would you like to act on?",
    "header": "Session Actions",
    "options": [
      {"label": "1", "description": "..."},
      {"label": "2", "description": "..."},
      ...
    ]
  }]
)
```

The skill prompt then maps the selection to a skill invocation or `gh` command.

### `Stop` Hook / Postcondition Pattern

Skills with no artifact output (read-only, informational) — like `ralph-status` and `ralph-hygiene` — have **no `Stop` hook**. Skills that produce artifacts or mutate state (triage, plan, research, review) use `*-postcondition.sh` scripts.

`ralph-hello` is read-only and produces no artifact, so **no Stop hook is needed**. The acceptance criteria mention a Stop postcondition hook, but examining the pattern, this would be an empty gate (nothing to validate). Recommend omitting it in v1; can add later if insight routing needs validation.

## Key Discoveries

### Data Source Strategy

Fetch all three data sources in parallel at the start using the Bash tool and MCP calls simultaneously:

1. **Pipeline snapshot** — `ralph_hero__pipeline_dashboard(format="json", includeHealth=true, includeMetrics=true)` → phase counts, health warnings, stuck issues
2. **Hygiene items** — `ralph_hero__project_hygiene` → stale items, WIP violations, missing fields
3. **Recent PR activity** — `gh pr list --state open --json number,title,url,isDraft,reviewDecision,headRefName,createdAt --limit 20` → open PRs, aged PRs waiting review

Recent issues (last 48h) can be extracted from `pipeline_dashboard` response: the `metrics.highlights.newlyAdded` field lists recently added issues.

### Insight Synthesis Algorithm

Three candidate pools → ranked by urgency → pick top 3:

| Pool | Source | Signal |
|------|--------|--------|
| Blocked/stuck issues | `health.warnings` with `stuck_issue` type | Critical health warnings |
| Stale open PRs | `gh pr list` filtered to `reviewDecision: "REVIEW_REQUIRED"` + age > 24h | PR blockers |
| High-priority actionable | `pick_actionable_issue` or highest-priority issue in earliest pipeline phase | Forward momentum |

Urgency ranking: `critical` health warnings > PRs blocking issues > high-priority items ready to move.

### Routing Map

| Insight Type | Skill to Invoke |
|---|---|
| Stuck issue in Research/Plan phase | `/ralph-hero:ralph-triage` |
| Plan in Review waiting action | `/ralph-hero:ralph-review --interactive` |
| PR waiting merge | `/ralph-hero:ralph-merge` |
| Issue ready for research | `/ralph-hero:ralph-research` |
| Issue ready for planning | `/ralph-hero:ralph-plan` |

For "all" selection: invoke skills sequentially in numbered order.

### Command Name Resolution

The open question from the idea file — `/hello` vs `/ralph-hero:hello` vs `/ralph-hero:ralph-hello`:
- Skill directory: `plugin/ralph-hero/skills/ralph-hello/` → skill name: `ralph-hero:ralph-hello`
- Acceptable shorthand via the Claude Code skill trigger: `/ralph-hero:ralph-hello`
- The idea file uses `/hello`; the GitHub issue uses `/ralph-hero:ralph-hello` — **use `ralph-hello` for consistency with all other skill names**

### Time Window

48h is the right default for "recent" — long enough to catch items from the previous session even after a weekend, short enough to stay relevant. The `pipeline_dashboard` `doneWindowDays=2` parameter surfaces recently completed items in that window.

## Potential Approaches

### Option A: SKILL.md Only (Recommended)

A single `SKILL.md` file (~120-150 lines) handles the full flow:
1. Parallel data fetch (pipeline_dashboard + project_hygiene + gh pr list)
2. LLM synthesizes 3 insights from the data
3. `AskUserQuestion` presents insights with act/skip options
4. Routes to appropriate skill based on selection

**Pros**: Simple to implement, no MCP changes, follows established skill pattern exactly, easy to iterate on insight quality by editing the prompt.

**Cons**: Insight synthesis quality depends on LLM reasoning from raw data; no deterministic ranking.

### Option B: New MCP Tool + SKILL.md

Add a `session_briefing` MCP tool that encapsulates data gathering and insight ranking logic in TypeScript.

**Pros**: Deterministic ranking algorithm, testable logic, faster (one call instead of three).

**Cons**: Requires MCP server change → build + publish cycle; over-engineering for v1.

**Recommendation**: Option A for v1. If insight quality is inconsistent after iteration, promote to Option B.

## Risks

- **Over-routing on "all"**: Sequentially invoking 3 skills could cause unexpected behavior if earlier skills change state that invalidates later insights. Mitigation: surface "all" as a warning, suggest picking one at a time.
- **`project_hygiene` availability**: The tool is deployed but should be checked gracefully — fall back to dashboard health warnings if unavailable.
- **PR data staleness**: `gh pr list` is real-time but doesn't filter to PRs related to Ralph issues. Filter by `headRefName` containing `feature/GH-` to scope to project PRs.

## Recommended Next Steps

1. Create `plugin/ralph-hero/skills/ralph-hello/SKILL.md` as a single-phase S implementation
2. Frontmatter: `model: sonnet`, `context: fork`, SessionStart sets `RALPH_COMMAND=hello`
3. Prompt structure: parallel data fetch → synthesize 3 insights in numbered scannable format → `AskUserQuestion` with 5 options (1/2/3/all/skip) → route based on selection
4. No Stop hook in v1 (nothing to validate)

The issue is estimated M; implementation as a single SKILL.md is realistically S effort. The M estimate may account for iteration on prompt quality after initial implementation.

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/ralph-hello/SKILL.md` — Create new skill file (does not exist yet)

### Will Read (Dependencies)
- `plugin/ralph-hero/skills/ralph-status/SKILL.md` — Frontmatter pattern (model, context, SessionStart hook)
- `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md` — Multi-step data fetch pattern
- `plugin/ralph-hero/skills/ralph-review/SKILL.md` — AskUserQuestion routing pattern
- `plugin/ralph-hero/hooks/scripts/set-skill-env.sh` — SessionStart hook implementation
- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` — pipeline_dashboard tool signature
- `plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts` — project_hygiene tool signature
- `plugin/ralph-hero/.claude-plugin/plugin.json` — Verify skill auto-discovery (no changes needed)
