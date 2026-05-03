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

2. One sentence introducing the recommendations, naming the recommended pick:
   > Right now the recommended direction is [recommended.kind] #[recommended.issue.number or recommended.pr.number] — [short rephrase of recommended.reason].

3. Then the picker (Step 4).

**Tone rules:**
- No severity tags (CRITICAL, STUCK, etc.)
- No dashboard formatting, no markdown tables, no JSON blocks
- Prose only

**Empty directions case**: If `directions` is empty, output:
> Things look calm — nothing stuck, nothing on fire.

Skip the picker. Stop.

## Step 4: Picker (interactive only)

Present `AskUserQuestion` with options derived 1:1 from `directions[]`. The option corresponding to `recommended: true` should be the FIRST option (so it's the default selection).

Per-option label rules (same as before):
- `kind: "issue"` + `workflowState: "Plan in Review"` → `"Review plan #NNN"`
- `kind: "issue"` + `workflowState: "Ready for Plan"` → `"Plan #NNN"`
- `kind: "issue"` + `workflowState: "Research Needed"` → `"Research #NNN"`
- `kind: "issue"` + `workflowState: "In Review"` → `"Review #NNN"`
- `kind: "pr"` → `"Merge PR #NNN"`
- `kind: "tree-continue"` → `"Continue tree #NNN"`
- `kind: "lock-stale"` → `"Unstick #NNN"`

Description: `direction.reason` verbatim.

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
- Skill invocation cost: catch-up runs in its own context (Skill() is fork-safe)
