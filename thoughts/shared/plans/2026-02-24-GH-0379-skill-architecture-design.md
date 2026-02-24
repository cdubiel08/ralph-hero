---
date: 2026-02-24
status: draft
github_issues: [379]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/379
primary_issue: 379
---

# Add Skill Architecture Design to Demo Recording Research Doc — Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-379 | Add skill architecture design to demo recording research doc | XS |

## Current State Analysis

The target file `thoughts/shared/research/2026-02-22-demo-recording-tools.md` was created by #378 (now closed/merged via PR #382). It contains tool evaluations, automation matrix, and recommendations — ending cleanly after `## References` for sibling appending.

This issue appends a `## Skill Architecture Design` section defining two recording mode architectures: autonomous (asciinema + hooks) and interactive (OBS + obs-cli), plus a shared video artifact pipeline and skill inventory table. The content is pre-specified in `thoughts/shared/plans/2026-02-22-demo-recording-skills.md` Phase 2 (lines 208–307).

Existing skill patterns confirm the design fits: `record-demo` maps to the `inline` context pattern (like `draft-idea`), and the autonomous wrapper script approach is compatible with the existing hook infrastructure (46 scripts in `plugin/ralph-hero/hooks/scripts/`).

## Desired End State

### Verification
- [ ] `## Skill Architecture Design` section appended to `thoughts/shared/research/2026-02-22-demo-recording-tools.md`
- [ ] Both autonomous (asciinema) and interactive (OBS) modes documented with flows
- [ ] Artifact Comment Protocol extension (`## Demo Recording` header) defined
- [ ] Skill inventory table present
- [ ] Shared video artifact pipeline section with GitHub attachment options

## What We're NOT Doing
- Creating the base research file (done by #378)
- Adding pipeline specification details (that's #380)
- Creating skill skeleton files (that's #381)
- Implementing any code or scripts
- Modifying existing skills or hooks

## Implementation Approach

Append the `## Skill Architecture Design` section to the existing research document, using the pre-specified content from the parent plan. The section includes Mode 1 (autonomous), Mode 2 (interactive), shared pipeline, and skill inventory table.

---

## Phase 1: Append Skill Architecture Design Section
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/379 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-24-GH-0379-skill-architecture-design.md

### Changes Required

#### 1. Append architecture section to research document
**File**: `thoughts/shared/research/2026-02-22-demo-recording-tools.md`
**Action**: Append after the `## References` section

Append the `## Skill Architecture Design` section containing:
- `### Mode 1: Autonomous Recording (asciinema)` — trigger, 7-step flow, Artifact Comment Protocol extension format, key design decisions (opt-in via `RALPH_RECORD=true`, `.cast` files ephemeral, GIF as durable artifact, idle compression), dependencies (asciinema, agg, gh)
- `### Mode 2: Interactive Recording (OBS + obs-cli)` — trigger (`/ralph-hero:record-demo`), 9-step flow with `AskUserQuestion` pacing, key design decisions (OBS pre-configured, skill only controls start/stop, MP4 output), dependencies (OBS, obs-cli, WebSocket)
- `### Shared: Video Artifact Pipeline` — upload path (4 steps), GitHub attachment options table (4 methods with pros/cons), recommendation (gh api for autonomous, gh release upload for interactive)
- `### Skill File Inventory` — table with record-demo (interactive, inline, sonnet) and hook integration (autonomous, fork, haiku), note on autonomous mode being a wrapper not a standalone skill

**Source content**: `thoughts/shared/plans/2026-02-22-demo-recording-skills.md` lines 208–307 (inside the Phase 2 markdown code block)

**Important**: Append cleanly after existing content with a blank line separator, so #380 and #381 can continue appending.

### Success Criteria
- [x] Automated: `grep -q "## Skill Architecture Design" thoughts/shared/research/2026-02-22-demo-recording-tools.md`
- [x] Automated: `grep -q "Mode 1: Autonomous Recording" thoughts/shared/research/2026-02-22-demo-recording-tools.md`
- [x] Automated: `grep -q "Mode 2: Interactive Recording" thoughts/shared/research/2026-02-22-demo-recording-tools.md`
- [x] Manual: Both modes have clear flows, dependencies are explicit, Artifact Comment Protocol extension is consistent

---

## Integration Testing
- [ ] Research doc still has valid YAML frontmatter after append
- [ ] Original tool evaluation content unchanged
- [ ] File ends cleanly for #380 and #381 appending

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-24-GH-0379-skill-architecture-design.md
- Parent plan: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-22-demo-recording-skills.md
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/364
- Predecessor: https://github.com/cdubiel08/ralph-hero/issues/378
