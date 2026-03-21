---
date: 2026-03-20
github_issue: 642
github_url: https://github.com/cdubiel08/ralph-hero/issues/642
topic: "Plan review human gate — how plans are presented (or not) to users before the picker"
tags: [research, human-gate, plan-review, AskUserQuestion, hello, hero, ralph-review, ux]
status: complete
type: research
---

# Research: Plan Review Human Gate — Editor Opening Gap

## Prior Work

- builds_on:: [[2026-03-15-open-in-obsidian-mcp-tool]]
- builds_on:: [[2026-03-03-GH-0480-hello-session-briefing]]

## Research Question

When the hero workflow (or hello → ralph-review routing) reaches the plan review human gate, the user is presented with a picker (Approve / Minor Changes / Major Changes / Reject) but cannot easily view the plan document. The plan was `Read` into Claude's context but not displayed to the user. The user needs a way to open the plan in an editor before making a decision.

## Summary

The plan review UX has a visibility gap: Claude reads the plan document into its own context, then immediately presents the `AskUserQuestion` picker asking the user to evaluate the plan — but the user never sees the plan content. The `AskUserQuestion` tool has no capability to display file contents or open files. No skill in the codebase currently opens files in external editors. A prior idea (`2026-03-15-open-in-obsidian-mcp-tool.md`) explored opening documents in Obsidian but hasn't been implemented.

## Detailed Findings

### The User's Experience at the Human Gate

When the plan review picker appears, the user sees:

```
⏺ Found the plan linked in the artifact comment. Let me read it.

  Read 1 file (ctrl+o to expand)

────────────────────────────────────────────────────────────
 ☐ Plan Review

How does the implementation plan for #597 look?

❯ 1. Approve
     Plan is complete and ready for implementation
  2. Minor Changes
     Small adjustments needed, can fix and proceed
  3. Major Changes
     Significant rework needed, return to planning
  4. Reject
     Plan is fundamentally flawed, needs complete redo
  5. Type something.
────────────────────────────────────────────────────────────
  6. Chat about this
```

The `Read 1 file (ctrl+o to expand)` line is Claude Code's collapsed tool output — the user can manually expand it with ctrl+o but must scroll through raw markdown in the terminal. There is no prompt to open the file in an editor.

### How the Flow Reaches This Point

Three paths lead to the plan review picker:

#### Path 1: Hero Skill HUMAN_GATE Phase
- [hero/SKILL.md:330-333](https://github.com/dubinets/ralph-hero/blob/f0b5a43af7b71f89bd56eb10db4e6581e857fd15/plugin/ralph-hero/skills/hero/SKILL.md#L330-L333)
- Hero reaches `HUMAN_GATE` when `RALPH_REVIEW_MODE != "auto"` (default: `skip`)
- Hero prints plan URLs and tells user: "(1) Review plans in GitHub, (2) Move to In Progress, (3) Re-run `/ralph-hero`"
- Then **STOP** — the session ends. This is a clean break but forces the user to GitHub web UI and requires a new session.

#### Path 2: Hello → Ralph-Review Routing
- [hello/SKILL.md:119-129](https://github.com/dubinets/ralph-hero/blob/f0b5a43af7b71f89bd56eb10db4e6581e857fd15/plugin/ralph-hero/skills/hello/SKILL.md#L119-L129)
- Hello surfaces "Plan waiting review" as a direction in its picker
- User selects it → hello invokes `Skill("ralph-review", args="NNN")`
- No `--interactive` flag is passed; mode depends on `RALPH_INTERACTIVE` env var

#### Path 3: Direct `/ralph-hero:ralph-review NNN --interactive`
- User manually invokes the review skill

### Ralph-Review INTERACTIVE Mode — The Gap

In [ralph-review/SKILL.md:135-155](https://github.com/dubinets/ralph-hero/blob/f0b5a43af7b71f89bd56eb10db4e6581e857fd15/plugin/ralph-hero/skills/ralph-review/SKILL.md#L135-L155):

1. **Line 137**: "**Read plan document** into context (needed for inline review)." — Claude calls `Read` on the plan file. This loads it into the agent's context window.
2. **Lines 142-155**: Immediately presents `AskUserQuestion` with the four options.

There is **no step between Read and AskUserQuestion** that:
- Outputs plan content to the user
- Opens the plan in an editor
- Provides a file path the user can click
- Offers a "let me review first" option

The instruction "Read plan document into context (needed for inline review)" serves Claude's ability to answer follow-up questions — it does not serve the user's need to review the plan.

### AskUserQuestion Capabilities

`AskUserQuestion` is a Claude Code built-in tool with this call signature:

```
AskUserQuestion(
  questions=[{
    "question": string,
    "header": string,
    "options": [{"label": string, "description": string}, ...],
    "multiSelect": boolean
  }]
)
```

The tool has **no parameters** for:
- Displaying file contents alongside the picker
- Opening files in external editors
- Embedding markdown or rich content
- Providing clickable file paths

It is purely a text-based labeled-option picker.

### Existing File Opening Patterns (None)

The codebase has **no patterns** for opening files in external editors:
- No `open` command (macOS) invocations
- No `code` command (VSCode) invocations
- No `obsidian://` URI scheme usage
- No editor integration of any kind

All current patterns present file paths as text and expect users to navigate manually:
- Backtick-wrapped local paths: `` `thoughts/shared/plans/...` ``
- GitHub HTTPS URLs: `https://github.com/.../blob/main/thoughts/shared/plans/...`
- Command suggestions: `/ralph-hero:form thoughts/shared/research/...`

### Prior Idea: Open in Obsidian MCP Tool

[thoughts/shared/ideas/2026-03-15-open-in-obsidian-mcp-tool.md](https://github.com/dubinets/ralph-hero/blob/f0b5a43af7b71f89bd56eb10db4e6581e857fd15/thoughts/shared/ideas/2026-03-15-open-in-obsidian-mcp-tool.md) proposes an `open_in_obsidian` MCP tool using the `obsidian://open?vault=...&file=...` URI scheme. This hasn't been implemented but addresses a related need: bridging programmatic discovery to visual browsing.

### Pipeline Detection: HUMAN_GATE Phase

[pipeline-detection.ts](https://github.com/dubinets/ralph-hero/blob/f0b5a43af7b71f89bd56eb10db4e6581e857fd15/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts) defines `HUMAN_GATE` as a pipeline phase triggered when all issues in a group are in "Plan in Review" state. The phase description is "All plans awaiting human approval."

The `RALPH_AUTO_APPROVE` env var (default `false` in hero, `true` in team) controls whether this gate is enforced.

### Interactive Plan Skill Pattern (Contrast)

The interactive `/plan` skill ([plan/SKILL.md:323-333](https://github.com/dubinets/ralph-hero/blob/f0b5a43af7b71f89bd56eb10db4e6581e857fd15/plugin/ralph-hero/skills/plan/SKILL.md#L323-L333)) has a better pattern — after writing a plan, it presents the file path and asks specific review questions:

```
I've created the initial implementation plan at:
`thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-description.md`

Please review it and let me know:
- Are the phases properly scoped?
- Are the success criteria specific enough?
...
```

This gives the user a clear path to open the file. The review skill lacks this pattern.

## Code References

- `plugin/ralph-hero/skills/hero/SKILL.md:330-333` — HUMAN_GATE handling (report and stop)
- `plugin/ralph-hero/skills/ralph-review/SKILL.md:135-155` — INTERACTIVE mode Step 4A (read plan, present picker)
- `plugin/ralph-hero/skills/ralph-review/SKILL.md:92-130` — Plan discovery (Step 3)
- `plugin/ralph-hero/skills/hello/SKILL.md:119-129` — Routing table (plan review → ralph-review)
- `plugin/ralph-hero/skills/plan/SKILL.md:323-333` — Interactive plan's "present draft location" pattern
- `plugin/ralph-hero/skills/shared/fragments/ask-user-question.md` — Picker conventions
- `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts` — HUMAN_GATE phase detection
- `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts` — "Plan in Review" in HUMAN_STATES

## Architecture Documentation

### AskUserQuestion Usage Across Skills

| Skill | # Calls | Purpose |
|---|---|---|
| hello | 1 | Direction picker (single-select) |
| ralph-review | 3 | Plan verdict + follow-up refinement (cascading) |
| hero | 0 | Uses plain text confirmation, not picker |
| setup | ~6 | Configuration wizard (prose-described) |
| setup-repos | ~4 | Registry bootstrap (prose-described) |
| record-demo | 2 | Screen arrangement + pacing (prose-described) |

### Human Gate State Machine

```
Plan in Progress → Plan in Review (HUMAN_GATE)
                     ├─ Approve  → In Progress (IMPLEMENT)
                     ├─ Minor    → In Progress (with notes)
                     ├─ Major    → Ready for Plan (re-plan)
                     └─ Reject   → Ready for Plan (re-plan)
```

Enforcement hooks:
- `human-needed-outbound-block.sh` — blocks automated skills from transitioning OUT of human states
- `review-state-gate.sh` — validates transitions from "Plan in Review"

## Historical Context (from thoughts/)

- The hello skill was originally a briefing dashboard (GH-0480), evolved into a conversational companion that routes to skills
- Interactive skills architecture (GH-0343–0348, GH-0358–0359) was designed during V4 phase 6a/6b — the focus was on porting autonomous skills to interactive variants, but the plan-review UX gap persisted
- The "open in Obsidian" idea (2026-03-15) shows awareness of the general "Claude finds it, user can't see it" problem

## Related Research

- `thoughts/shared/research/2026-03-04-GH-0521-parent-gate-states-plan-in-review.md` — parent gate states
- `thoughts/shared/research/2026-02-23-GH-0358-v4-phase-6a-interactive-skills.md` — interactive skills architecture
- `thoughts/shared/ideas/2026-03-15-open-in-obsidian-mcp-tool.md` — Obsidian editor opening concept

## Open Questions

1. What editor should be opened? Options: VSCode (`code`), Obsidian (`obsidian://`), macOS `open` (system default), or configurable?
2. Should the picker include an explicit "Open plan in editor" option, or should the file be opened automatically before the picker appears?
3. Should this be a Bash `open` call before the picker, an additional picker option, or a new tool?
4. Should the plan content be printed to the terminal (markdown rendered) as an alternative/complement to editor opening?
5. Does this also apply to other human gates (e.g., when hero stops at HUMAN_GATE and tells user to review in GitHub)?

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/ralph-review/SKILL.md` - Add "Open in editor" option to Step 4A AskUserQuestion picker; add Bash call to open plan file before re-presenting picker

### Will Read (Dependencies)
- `plugin/ralph-hero/skills/shared/fragments/ask-user-question.md` - Picker label/description conventions to follow
- `plugin/ralph-hero/skills/hello/SKILL.md` - How ralph-review is invoked from hello routing
- `plugin/ralph-hero/skills/hero/SKILL.md` - HUMAN_GATE path (separate stop-and-report approach, likely out of scope)
