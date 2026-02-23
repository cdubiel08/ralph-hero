---
date: 2026-02-21
status: closed
reason: Covered by GH-310 and GH-364
context: session GH-290 processed 14 sub-issues end-to-end with ralph-team
---

# Showcase Demo: Ralph Hero Plugin Onboarding

Idea for a live or recorded demo that shows new team members how the plugin drives issues through the full lifecycle autonomously.

## Problem

Ralph Hero's value is hard to explain in words. The state machine, MCP tools, agent teams, and GitHub Projects integration form a system that's much clearer when you *watch it work*. New contributors need to understand both what it does and how the pieces connect.

## Demo Concept: "From Idea to Merged PR in One Command"

### Format

**Split-screen terminal recording** (asciinema or screen capture) showing:
- Left pane: Claude Code terminal running `/ralph-team NNN`
- Right pane: GitHub Projects board (browser) updating in real-time as issues flow across columns

### The Script

Use a pre-seeded umbrella issue with 3-4 XS sub-issues (small enough to complete in ~10 minutes). The audience watches the full lifecycle:

1. **Issue detection** -- Ralph reads the issue, detects group, determines pipeline position
2. **Team spin-up** -- TeamCreate, analyst spawned, tasks appear in task list
3. **Triage** -- Issues move from Backlog to Research Needed on the board
4. **Research** -- Documents appear in `thoughts/shared/research/`, issues advance to Ready for Plan
5. **Planning** -- Plan document created, issues move to Plan in Review
6. **Implementation** -- Builder spawns in worktree, code changes committed, PR opened
7. **Integration** -- PR merged, issues flow to Done, team shuts down

### Key Moments to Highlight

| Timestamp | What Happens | What to Explain |
|-----------|-------------|-----------------|
| 0:00 | `/ralph-team 42` | Single command entry point |
| 0:15 | `get_issue` + `detect_pipeline_position` | MCP server reads GitHub Projects as source of truth |
| 0:30 | TeamCreate + analyst spawned | Agent teams -- parallel workers with task list coordination |
| 1:00 | Issues move on board | Workflow states drive the state machine, not vice versa |
| 3:00 | Research doc appears | Artifacts are durable -- survive session loss |
| 5:00 | Plan document created | Plans are reviewable, diffable, stored in git |
| 7:00 | PR opens, CI runs | Standard GitHub flow, nothing proprietary |
| 9:00 | PR merged, board shows Done | End-to-end traceability: issue -> research -> plan -> PR -> done |

### Seed Issue Template

```markdown
## Demo: Add greeting message to CLI

Umbrella issue for demo purposes.

### Sub-issues (XS each)
- [ ] Add "Welcome to Ralph" banner on first run
- [ ] Add --version flag to ralph-cli.sh
- [ ] Add --help flag with usage summary
```

These are intentionally trivial so the demo completes quickly and the *process* is the star, not the code changes.

## Alternative Formats

### A. Annotated Replay (lowest effort)
Record a real `/ralph-team` session (like GH-290 today). Post-produce with chapter markers and callout annotations. Pros: authentic. Cons: long (GH-290 took ~25 min for 14 issues).

### B. Interactive Walkthrough (medium effort)
Jupyter-style notebook or web page where each step has:
- The command/tool call
- The GitHub Projects board state (screenshot)
- A short explanation paragraph

Could use the Playwright MCP to auto-capture board screenshots at each state transition.

### C. Architecture Diagram + Narrated Demo (highest quality)
Start with a 60-second animated diagram showing:
```
Issue -> [Triage] -> [Research] -> [Plan] -> [Review] -> [Implement] -> [PR] -> Done
           |             |            |           |            |           |
        analyst       analyst      builder    validator     builder   integrator
```
Then cut to the live demo. Best for async onboarding (README, wiki, or repo landing page).

## Scaffolding Needed

1. **Seed script** -- Creates the demo umbrella issue + sub-issues via `gh` CLI
2. **Cleanup script** -- Closes demo issues, deletes branches, archives from project
3. **Recording setup** -- asciinema config or OBS scene with terminal + browser
4. **Board template** -- Minimal GitHub Project with just the required workflow states

## Open Questions

- Should the demo repo be separate from ralph-hero (clean, no noise) or in-repo (shows real context)?
- Target audience: developers who will contribute to ralph-hero, or users who will use the plugin on their own repos?
- Should we include a "things that can go wrong" section showing error recovery (e.g., plan rejection, hook failures)?
