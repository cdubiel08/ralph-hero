---
description: Session companion — catches you up on what changed since you
  last ran hello, then surfaces actionable directions with a recommended
  default. Composes the catch-up skill (narrative synthesis) and the
  next_actions tool (deterministic ranking). Use whenever someone asks
  "what should I work on", "what needs attention", "catch me up", or
  starts a session wanting orientation.
argument-hint: ""
context: inline
allowed-tools:
  - Read
  - Bash
  - Skill
  - Agent
  - AskUserQuestion
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__next_actions
---

# /hello — Session Companion (Wrapper)

You compose three primitives:

1. `catch-up` skill — narrates what's changed since last time
2. `ralph_hero__next_actions` MCP tool — ranks work, marks one `recommended: true`
3. `AskUserQuestion` picker — defaults to the recommended direction

## Step 1: Gather (parallel)

Run these in parallel in a single turn:

1. **Catch-up narrative**: Invoke `Skill("ralph-hero:catch-up")`. Capture the returned text.

2. **Open PRs**:
```bash
gh pr list --state open --json number,title,url,isDraft,reviewDecision,headRefName,createdAt --limit 10 2>/dev/null || echo '[]'
```

## Step 2: Compute directions

Call `ralph_hero__next_actions` with:
- `limit` = `3`
- `audience` = `"human"`
- `openPRs` = the parsed PR array from Step 1

Capture `directions[]`.

## Step 3: Render briefing

Output ≤ 40 lines total. Structure:

1. The catch-up narrative (one paragraph, 2-4 sentences) verbatim from the catch-up skill output. If catch-up was empty/errored, skip this paragraph.

2. One sentence introducing the recommendations, naming the recommended pick. Synthesize this sentence from `direction.signals` + `direction.issue.title` (or `direction.pr.title`) + the catch-up narrative — do NOT quote `direction.reason` verbatim. Example shape:
   > Right now the recommended direction is [recommended.kind] #[recommended.issue.number or recommended.pr.number] — [synthesized one-clause reason that mentions the title and at least one structured signal].

3. Then the picker (Step 4).

### Synthesizing per-direction prose

For each direction's description (used in Step 4) and for the introductory sentence above, **compose** the prose from `direction.signals + direction.issue.title (or direction.pr.title) + memory context (catch-up output and MEMORY.md)`. **Never render `direction.reason` verbatim** — it exists only as a back-compat field for non-skill callers and is `@deprecated`. Always reach for `signals` first, then bring in the title for human-meaningful context.

Per-kind synthesis guidance:

| `direction.kind` | Signal cues to incorporate | Example shape |
|---|---|---|
| `issue` (with `signals.staleDays`) | `staleDays`, `staleThresholdDays`, `issue.workflowState`, `issue.priority`, `issue.title` | "skill audit phase 2 has been sitting in Ready for Plan for 7 days — the largest stale block on the board" |
| `issue` (with `signals.estimateWeight` set, i.e. M/L/XL agent run) | `issue.estimate`, `issue.title` | "a large block of work — non-trivial scope, plan first" — **never** use phrases like "small unblock" for an XL item |
| `issue` (with `signals.tiedAtScore > 1`) | `tiedAtScore`, `issue.title`, rank | "tied with N others at the top score; rank-1 by issue number — pick this one if you don't have context for the others" |
| `lock-stale` | `signals.staleDays`, `issue.workflowState`, `issue.title` | "stuck in Plan in Progress for 2 days — title suggests it may need an unblock" |
| `tree-continue` | `signals.parentChainNote`, `issue.title` | "sibling #809 closed 2 days ago — keep this one moving" |
| `pr` | `pr.title`, `signals.prAgeDays`, `signals.linkedIssueNumber`, `signals.prReviewDecision` | "PR #999 (issue #42) — open 2 days awaiting review" |

If `signals.tiedAtScore > 1`, surface tiebreak transparency in the prose so the reader understands rank-1 was an implicit pick. If `signals.estimateWeight` is set (the item is M/L/XL in an agent run), reflect that size honestly — never describe XL work as "small". If `signals.parentChainNote` is set on a tree-continue, weave that note into the prose rather than emitting the bare phrase "active tree".

**Tone rules:**
- No severity tags (CRITICAL, STUCK, etc.)
- No dashboard formatting, no markdown tables, no JSON blocks
- Prose only

**Empty directions case**: If `directions` is empty, output:
> Things look calm — nothing stuck, nothing on fire.

Skip the picker. Stop.

## Step 4: Picker (interactive only)

Present `AskUserQuestion` with options derived 1:1 from `directions[]`. The option corresponding to `recommended: true` should be the FIRST option (so it's the default selection).

Per-option label rules — each label is `"<verb> #<NNN> · <title fragment>"` where the title fragment is `direction.issue.title` (or `direction.pr.title`) truncated to ≤30 characters with `…` suffix when truncation occurred:

- `kind: "issue"` + `workflowState: "Plan in Review"` → `"Review plan #NNN · <fragment>"`
- `kind: "issue"` + `workflowState: "Ready for Plan"` → `"Plan #NNN · <fragment>"`
- `kind: "issue"` + `workflowState: "Research Needed"` → `"Research #NNN · <fragment>"`
- `kind: "issue"` + `workflowState: "In Review"` → `"Review #NNN · <fragment>"`
- `kind: "pr"` → `"Merge PR #NNN · <fragment>"`
- `kind: "tree-continue"` → `"Continue tree #NNN · <fragment>"`
- `kind: "lock-stale"` → `"Unstick #NNN · <fragment>"`

**Title fragment truncation rule:**
1. If `title.length <= 30`, use the title as-is (no ellipsis).
2. Otherwise, slice to 30 chars. Drop trailing whitespace. If a clean word boundary (a space) exists within the last 5 chars of the slice, cut at that boundary instead — so the fragment never ends mid-word when a word boundary is nearby. Append `…`.
3. Example: title `"Skill audit phase 2 — deep individual audits for remaining skills"` (64 chars) → fragment `"Skill audit phase 2 — deep…"`.

Description: the synthesized prose from Step 3 for this direction (NOT `direction.reason`).

Add a final option: `{label: "Work through these in order", description: "Address each direction in order"}`.

If non-interactive mode (env var `CLAUDE_NONINTERACTIVE` set, or AskUserQuestion is unavailable): skip the picker entirely. End the briefing with: *"Recommended: [recommended action] — invoke explicitly to proceed."*

## Step 5: Dispatch

Based on the user's pick, dispatch via `Agent()`. Use the existing dispatch table:

| `direction.kind` | Workflow State | Agent Dispatch |
|---|---|---|
| `issue` | `Plan in Review` | `Agent(subagent_type="ralph-hero:review-agent", prompt="Review plan for issue #NNN", description="Review plan for GH-NNN")` |
| `issue` | `Ready for Plan` | `Agent(subagent_type="ralph-hero:plan-agent", prompt="Plan issue #NNN", description="Plan GH-NNN")` |
| `issue` | `Research Needed` | `Agent(subagent_type="ralph-hero:research-agent", prompt="Research issue #NNN", description="Research GH-NNN")` |
| `issue` | `In Review` | `Agent(subagent_type="ralph-hero:review-agent", prompt="Review issue #NNN", description="Review GH-NNN")` |
| `pr` | — | `Agent(subagent_type="ralph-hero:merge-agent", prompt="Merge PR #NNN", description="Merge PR #NNN")` |
| `tree-continue` | — | `Agent(subagent_type="ralph-hero:triage-agent", prompt="Continue tree work on issue #NNN", description="Triage GH-NNN")` |
| `lock-stale` | — | `Agent(subagent_type="ralph-hero:triage-agent", prompt="Triage stalled issue #NNN", description="Triage GH-NNN")` |

For "Work through these in order": dispatch sequentially in `directions[]` order. Note before each subsequent dispatch: *"Earlier actions may have changed board state."*

After all dispatch completes, output:

```
Session complete.
```

## Constraints

- Read-only at this layer (skills/tools handle their own writes)
- Catch-up, gh pr list, and next_actions all run in the initial gather; do not refetch
- ≤ 40 lines for the briefing
- Never echo tool JSON, gh pr list output, or skill return strings verbatim
- Never render `direction.reason` verbatim — it exists only for back-compat and is `@deprecated`. Always synthesize prose from `signals + title + memory`
- Skill invocation cost: catch-up runs in its own context (Skill() is fork-safe)
