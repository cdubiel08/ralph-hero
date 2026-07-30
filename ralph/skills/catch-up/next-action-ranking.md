# Next-action ranking

This reference is consulted by `/ralph:catch-up`'s default flow (and by any other verb that surfaces a recommended direction). It carries the synthesis rules, picker-label rules, and dispatch table for the `next_actions` MCP tool response.

## next_actions call shape

Call `ralph_hero__next_actions` with:

- `limit` = `3`
- `audience` = `"human"`

The tool fetches open PRs internally via the configured GitHub token's `repo` scope (one `is:pr is:open repo:owner/name` search per unique repo on the project board). **Do not pass `openPRs`.**

Capture `directions[]`. Each direction carries `kind`, `signals`, optional `issue`, optional `pr`, and a `recommended: boolean` flag (exactly one direction is `recommended: true` when results exist).

## Synthesizing per-direction prose

For each direction's description (used in the picker), and for the introductory sentence that names the recommended pick, **compose** the prose from:

- `direction.signals`
- `direction.issue.title` (or `direction.pr.title`)
- memory context (the catch-up narrative output + `MEMORY.md`)

**Never quote `direction.reason` verbatim.** Reach for `signals` first, then bring in the title for human-meaningful context.

> Internal: `direction.reason` exists only as a back-compat field for non-skill callers and is `@deprecated`.

## Signal cue table

| `direction.kind` | Signal cues to incorporate | Example shape |
|---|---|---|
| `issue` (with `signals.staleDays`) | `staleDays`, `staleThresholdDays`, `issue.workflowState`, `issue.priority`, `issue.title` | "skill audit phase 2 has been sitting in Ready for Plan for 7 days — the largest stale block on the board" |
| `issue` (with `signals.estimateWeight` set, i.e. M/L/XL agent run) | `issue.estimate`, `issue.title` | "a large block of work — non-trivial scope, plan first" — **never** use phrases like "small unblock" for an XL item |
| `issue` (with `signals.tiedAtScore > 1`) | `tiedAtScore`, `issue.title`, rank | "tied with N others at the top score; rank-1 by issue number — pick this one if you don't have context for the others" |
| `lock-stale` | `signals.staleDays`, `issue.workflowState`, `issue.title` | "stuck in Plan in Progress for 2 days — title suggests it may need an unblock" |
| `tree-continue` | `signals.parentChainNote`, `issue.title` | "sibling #809 closed 2 days ago — keep this one moving" |
| `pr` | `pr.title`, `signals.prAgeDays`, `signals.linkedIssueNumber`, `signals.prReviewDecision` | "PR #999 (issue #42) — open 2 days awaiting review" |
| `human-needed-unblock` | `signals.unblockRequestAgeDays`, `signals.questionCount`, `issue.title` | "issue #42 has 3 unblock questions waiting since 2 days ago" |
| `triage` (aggregate; `issue` and `pr` both null — no title to draw on) | `signals.statelessCount` | "12 items are sitting on the board with no workflow state — a caretake triage sweep will classify them" |

## Synthesis edge cases

- **Tiebreak transparency**: when `signals.tiedAtScore > 1`, surface this in the prose so the reader understands rank-1 was an implicit pick.
- **Estimate honesty**: when `signals.estimateWeight` is set (the item is M/L/XL in an agent run), reflect that size honestly — never describe XL work as "small".
- **Tree-continue note**: when `signals.parentChainNote` is set, weave it into the prose rather than emitting the bare phrase "active tree".

## Tone rules

- No severity tags (CRITICAL, STUCK, etc.)
- No dashboard formatting, no markdown tables, no JSON blocks
- Prose only
- ≤ 40 lines total briefing (narrative + intro sentence + picker)

## Picker label rules

Each `AskUserQuestion` option's `label` is `"<verb> #<NNN> · <title fragment>"`. The verb comes from the per-kind table below; the title fragment is `direction.issue.title` (or `direction.pr.title`) after truncation.

### Per-kind verb mapping

| Condition | Label prefix |
|---|---|
| `kind: "issue"` + `workflowState: "Plan in Review"` | `Review plan #NNN` |
| `kind: "issue"` + `workflowState: "Ready for Plan"` | `Plan #NNN` |
| `kind: "issue"` + `workflowState: "Research Needed"` | `Research #NNN` |
| `kind: "issue"` + `workflowState: "In Review"` | `Review #NNN` |
| `kind: "pr"` | `Merge PR #NNN` |
| `kind: "tree-continue"` | `Continue tree #NNN` |
| `kind: "lock-stale"` | `Unstick #NNN` |
| `kind: "human-needed-unblock"` | `Unblock #NNN` |
| `kind: "plan-decision"` | `Answer decision #NNN` (plan held on `signals.decisionCount` open decision(s) — the action is ANSWERING the `## Decision Request`, not re-reviewing) |
| `kind: "triage"` | `Triage N stateless items` (N from `signals.statelessCount`; no `#NNN`) |

### Title fragment truncation

1. If `title.length <= 30`, use the title as-is. No ellipsis.
2. Otherwise, slice to 30 chars. Drop trailing whitespace. If a clean word boundary (a space) exists within the last 5 chars of the slice, cut at that boundary instead — so the fragment never ends mid-word when a word boundary is nearby. Append `…`.
3. Example: title `"Skill audit phase 2 — deep individual audits for remaining skills"` (64 chars) → fragment `"Skill audit phase 2 — deep…"`.
4. Carve-out: `kind: "triage"` directions have no `issue.title`/`pr.title` (both `issue` and `pr` are null) — the label from the per-kind table stands alone with no title fragment appended.

### Picker structure

- The option corresponding to `recommended: true` is the FIRST option (default selection).
- Each option's `description` is the synthesized prose for that direction (NOT `direction.reason`).
- Add a final option at the end: `{label: "Work through these in order", description: "Address each direction in order"}`.

### Non-interactive fallback

If `CLAUDE_NONINTERACTIVE` is set, or `AskUserQuestion` is unavailable, skip the picker entirely. End the briefing with: *"Recommended: [recommended action] — invoke explicitly to proceed."*

## Dispatch table

Based on the user's pick, dispatch via `Agent()` or `Skill()`. The `ralph:` worker agents are **thin shells** — they preload no skill, so each prompt must point the agent at the relevant `${CLAUDE_PLUGIN_ROOT}/skills/<verb>/` procedure prose (the same prose the corresponding verb runs inline):

| `direction.kind` | Workflow State | Dispatch |
|---|---|---|
| `issue` | `Plan in Review` | `Agent(subagent_type="ralph:review-agent", prompt="Review the plan for issue #NNN. Follow the plan-review procedure in ${CLAUDE_PLUGIN_ROOT}/skills/plan/plan-review.md exactly; emit APPROVED / NEEDS_ITERATION / PLAN AWAITING DECISION.", description="Review plan for GH-NNN")` |
| `plan-decision` | `Plan in Review` | Interactive surface, not a dispatch: open the issue's `## Decision Request` comment (issue URL from `direction.issue`), present each `### <decision>` to the user via the decisions pickers in `${CLAUDE_PLUGIN_ROOT}/skills/plan/plan-review.md` § Interactive vs auto (via `Skill("ralph:plan", args="NNN --mode review")` under `RALPH_REVIEW_PLAN=interactive`), or tell the user to reply on the issue. Do NOT dispatch review-agent — the hold re-emits `PLAN AWAITING DECISION` until a human answers. |
| `issue` | `Ready for Plan` | `Agent(subagent_type="ralph:plan-agent", prompt="Plan issue #NNN. Follow the planning procedure in ${CLAUDE_PLUGIN_ROOT}/skills/plan/plan-shapes.md (and decomposition.md / intake-routing.md as referenced) exactly.", description="Plan GH-NNN")` |
| `issue` | `Research Needed` | `Agent(subagent_type="ralph:research-agent", prompt="Research issue #NNN. Follow the research procedure in ${CLAUDE_PLUGIN_ROOT}/skills/research/research-shapes.md (and findings-format.md / intake-routing.md as referenced) exactly.", description="Research GH-NNN")` |
| `issue` | `In Review` | `Agent(subagent_type="ralph:review-agent", prompt="Review issue #NNN. Follow the plan-review procedure in ${CLAUDE_PLUGIN_ROOT}/skills/plan/plan-review.md exactly.", description="Review GH-NNN")` |
| `pr` | — | `Agent(subagent_type="ralph:merge-agent", prompt="Merge PR #NNN. Follow the merge procedure in ${CLAUDE_PLUGIN_ROOT}/skills/review/merge-gate.md exactly; emit MERGED / MERGE BLOCKED / NOT READY.", description="Merge PR #NNN")` |
| `tree-continue` | — | `Skill("ralph:caretake", args="--mode triage #NNN")` — inline triage; same procedure a dispatched agent would have followed (`${CLAUDE_PLUGIN_ROOT}/skills/caretake/modes/triage.md` + `${CLAUDE_PLUGIN_ROOT}/skills/shared/event-taxonomy.md`) |
| `lock-stale` | — | `Skill("ralph:caretake", args="--mode triage #NNN")` — inline triage of the stalled issue; same procedure reference as above |
| `human-needed-unblock` | `Human Needed` | `Skill("ralph:caretake", args="--mode unblock #<NNN>")` |
| `triage` | — | `Skill("ralph:caretake", args="--mode triage")` (board-wide — no issue argument; `direction.issue` and `direction.pr` are both null for this kind) |

For the **Work through these in order** option: dispatch sequentially in `directions[]` order. Note before each subsequent dispatch: *"Earlier actions may have changed board state."*

After all dispatch completes, output `Session complete.`
