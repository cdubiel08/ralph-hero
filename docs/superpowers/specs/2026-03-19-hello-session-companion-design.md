# Hello Skill Redesign: Session Companion

**Date**: 2026-03-19
**Status**: Approved
**Scope**: Rewrite of `plugin/ralph-hero/skills/hello/SKILL.md`

## Problem

The current hello skill feels like a project management dashboard — it fetches three data sources (pipeline dashboard, project hygiene, PR list), forces exactly 3 insights with alarmist severity tags (`[CRITICAL]`, `[STUCK]`), and routes to high-volume operational actions (archive items, flag hygiene issues). The result is slow, noisy, and unnatural. WIP limits generate false positives, backlog items get flagged without nuance, and the interaction feels like reading a report rather than talking to an assistant.

## Design

Redesign hello around two phases: **orient** then **offer**.

### Data Sources

**Drop**: `project_hygiene` — slowest source, produces the most noise (stale items, missing fields, orphaned issues). If something is truly broken, `pipeline_dashboard` health warnings already flag it.

**Keep**:

1. **Memory read** (new) — read the `MEMORY.md` index file from the project memory directory (the path is available as the skill runs inline in the main conversation, which has access to the memory directory at `~/.claude/projects/<project-key>/memory/`). Read `MEMORY.md` to get an overview of available memories, then read any files with `type: project` or `type: feedback` frontmatter that seem relevant to session orientation. If `MEMORY.md` doesn't exist or is empty, skip memory context silently. Near-instant local file reads.
2. **`pipeline_dashboard`** — single MCP call with `format: "json"`, `includeHealth: true`, `includeMetrics: true`. Only API call.
3. **`gh pr list`** — open PRs, limited to 10 (down from 20). Fast CLI call.

All three fetch in parallel.

### Phase 1: Orient

A conversational greeting that weaves memory context with current board state. No headers, no severity tags, no dashboard formatting.

**Structure**:
- One sentence acknowledging prior context (from memory): *"Last session you were digging into the playwright plugin — that shipped in PR #627."*
- One sentence on what changed (best-effort — infer from comparing memory of prior state against current dashboard and PR data; omit if memory lacks enough prior detail to make a meaningful comparison): *"Since then, 2 new issues landed in backlog and PR #636 merged."*
- One sentence on current state: *"Right now there are 3 things in progress and 1 PR open for review."*

**Tone rules**:
- No `[CRITICAL]`, `[STUCK]`, `[WARNING]` tags. If something is genuinely stuck, say it plainly: *"Issue #42 has been sitting in Research for 5 days — might be blocked on something."*
- No WIP violation language unless it's actually causing a problem. "3 items in progress" is fine — don't flag it as a violation just because a limit says 2.
- Backlog items that have been sitting a while get context, not alarm: *"#55 has been in backlog since February — you mentioned wanting to tackle it before the API launch but it hasn't been urgent yet."*
- If the board is healthy and quiet, say so: *"Things look calm — nothing stuck, nothing on fire."*

**When memory is empty** (directory doesn't exist, `MEMORY.md` is absent, or no project/feedback memories are found): Skip the "last time" and "what changed" sentences. Open with board state directly. Don't mention that memory is empty or unavailable.

### Phase 2: Offer

Surface **up to 3 directions** — but only if they genuinely matter. Zero is fine.

**What counts as a direction**:
- An issue ready to advance with context on *why* the user would care — *"#55 'Add webhook support' is ready for planning — this is the one you flagged as important for the API launch"*
- A PR that needs attention with context — *"PR #640 has been open for 2 days, it's the batch update feature you were working on last week"*
- A strategic nudge based on memory — *"You mentioned wanting to clean up the auth middleware before the compliance deadline — nothing's started on that yet"*

**What does NOT count as a direction**:
- "Archive 66 done items" — housekeeping, not a direction
- "7 issues missing estimate field" — hygiene noise
- WIP limit violations unless they're actually causing bottlenecks
- Anything that reads like a project management report

**Format**: Each direction is a short paragraph (2-3 sentences max) explaining what it is and why it matters. Conversational, not formatted as a numbered dashboard.

**When there's nothing to surface**: End with *"Nothing urgent jumping out — what are you thinking about today?"* and skip the picker entirely.

### The Picker

AskUserQuestion appears **only when directions were surfaced**.

- Labels are action-oriented: *"Plan #55"*, *"Review PR #640"*, *"Start auth cleanup"*
- Descriptions include the *why*: *"Webhook support — you flagged this for the API launch"*
- "All" reworded to: *"Work through these in order"*
- No explicit "skip" — built-in "Other" handles it
- "Other" response: *"Got it — holler if you need anything"* and stop. No summary.

**Routing table** (same as current, minus hygiene row):

| Direction Type | Skill |
|---|---|
| Issue in Research/Plan phase needing attention | `/ralph-hero:ralph-triage` |
| Plan waiting review | `/ralph-hero:ralph-review` |
| PR waiting merge/review | `/ralph-hero:ralph-merge` |
| Issue ready for research | `/ralph-hero:ralph-research` |
| Issue ready for planning | `/ralph-hero:ralph-plan` |
| Board healthy, user wants to pick work | `/ralph-hero:ralph-triage` |

### Frontmatter

```yaml
---
description: Session companion that orients you on where things stand and
  offers directions worth pursuing. Reads memory for prior context, fetches
  pipeline status and open PRs, then surfaces what matters conversationally.
  Use this skill whenever someone asks "what should I work on", "what needs
  attention", "catch me up", "anything on fire", "what's blocking", or wants
  to know the current state of the project before deciding what to do. Also
  trigger when users start a session with greetings like "hello", "good
  morning", or "hey" combined with questions about project status, priorities,
  or next steps. This is the go-to skill for session-start orientation,
  post-vacation catch-ups, pre-meeting status checks, and "where do things
  stand" questions.
argument-hint: ""
context: inline
allowed-tools:
  - Read
  - Bash
  - Skill
  - AskUserQuestion
  - ralph_hero__pipeline_dashboard
---
```

Change from current: updated description, removed `ralph_hero__project_hygiene`.

### Constraints

- Read-only: skill does not modify issues, PRs, or project state
- Do not re-fetch data after the initial parallel fetch
- Do not use severity tags, dashboard formatting, or project management jargon
- Do not flag WIP limits or hygiene issues unless they're causing a concrete problem
- If no memories exist, skip the "last time" context gracefully
- If no directions are worth surfacing, skip the picker entirely

## What's NOT Changing

- The skill location (`plugin/ralph-hero/skills/hello/SKILL.md`)
- The routing table (same skill mappings, minus the hygiene row — intentionally removed since hygiene is no longer surfaced as a direction)
- The read-only constraint
- The `context: inline` mode (post-fix from #603)

## Trade-offs

- **Memory dependency**: The orient phase leans on auto-memory for session continuity. If no relevant memories exist, it degrades gracefully to board-state-only, but loses the "where you left off" feel. This improves naturally over time as memories accumulate.
- **No hygiene source**: Dropping `project_hygiene` means genuinely stale items won't be surfaced unless they also appear in pipeline dashboard health warnings. This is intentional — hygiene is available via `/ralph-hero:ralph-hygiene` when the user wants it, rather than pushed every session.
- **Subjective synthesis**: The skill relies on LLM judgment to decide which directions matter and why. This is a feature (natural, contextual) but means output quality varies by run.
