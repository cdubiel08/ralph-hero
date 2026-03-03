---
date: 2026-03-02
status: draft
github_issues: [390]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/390
primary_issue: 390
---

# Add Onboarding Demo Section to README — Implementation Plan

## Overview

1 issue for implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-390 | Add onboarding demo section to README/wiki | XS |

## Current State Analysis

`plugin/ralph-hero/README.md` currently has:
- Prerequisites, Installation, Setup sections
- Usage section (individual skills table + orchestrators table + CLI)
- Configuration section (env vars, token scopes)
- Architecture section (directory tree + MCP tools table + workflow states)
- Differences from Linear-based Ralph section

**Gap**: No "Demo" or "How It Works" section exists. New contributors reading the README get the *what* (skill list, config options) but not the *why* or *how it feels to use it*. The key concept — "one command drives an issue from Backlog to merged PR via autonomous agent teams" — is not communicated visually or narratively.

**Dependencies complete**: #387 (demo-seed.sh), #388 (demo-cleanup.sh), #389 (recording) are all Done.

## Desired End State

The README has a new "How It Works" section (between Usage and Configuration) containing:
1. A one-sentence elevator pitch for the full autonomous loop
2. An ASCII lifecycle diagram showing each stage with the responsible agent role
3. A "single command entry point" explanation
4. A link to the showcase demo recording from #389

### Verification
- [ ] README has a "How It Works" or "Demo" section
- [ ] Section includes the ASCII lifecycle diagram with all 7 stages and agent role labels
- [ ] Section references `/ralph-team NNN` as the single-command entry point
- [ ] Recording link is present (use placeholder `[Demo recording →]()` if URL not yet documented from #389)
- [ ] Both audiences addressed: contributors (how to contribute) AND users (how to adopt)
- [ ] Section renders correctly on GitHub (no broken markdown)

## What We're NOT Doing

- Not creating `docs/onboarding.md` (README section is sufficient for XS scope)
- Not creating an animated or interactive diagram
- Not modifying the existing Architecture section (it stays as-is)
- Not adding a wiki page (out of scope for this issue)
- Not adding a contributing guide

## Implementation Approach

Insert a "How It Works" section into `plugin/ralph-hero/README.md` immediately before the `## Configuration` section. This placement puts it after the Usage section so readers who want to try it can see what to expect, but technical config details stay grouped at the end.

---

## Phase 1: Add "How It Works" section to README

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/390 | **Depends on**: #387, #388, #389 (all Done)

### Changes Required

#### 1. Insert "How It Works" section in `plugin/ralph-hero/README.md`

**File**: [`plugin/ralph-hero/README.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/README.md)

**Insert location**: Between the `## CLI` subsection (line ~110) and `## Configuration` heading (line ~112).

**Content to insert**:

```markdown
## How It Works

Ralph drives GitHub issues through a fully automated development lifecycle with one command:

```bash
claude "/ralph-team 42"
```

A multi-agent team spins up automatically — analyst, builder, and integrator — each handling their phase of the pipeline in sequence:

```
Issue #42
  │
  ▼
[Analyst]  Triage → Research → Plan
  │         Backlog → Research Needed → Ready for Plan → Plan in Review
  │
  ▼
[Builder]  Implement → PR
  │         In Progress → In Review
  │
  ▼
[Integrator]  Validate → Merge
               In Review → Done
```

Each stage produces a durable artifact committed to git:
- **Research** → `thoughts/shared/research/YYYY-MM-DD-GH-NNN-description.md`
- **Plan** → `thoughts/shared/plans/YYYY-MM-DD-GH-NNN-description.md`
- **Implementation** → feature branch in a git worktree
- **PR** → GitHub pull request with `Closes #NNN`

GitHub Projects V2 is the source of truth for state — the board updates in real-time as agents advance issues through workflow states.

### Demo

> **[Watch the 10-minute showcase →](RECORDING_URL_FROM_GH_389)**
>
> A real `/ralph-team` session processing an umbrella issue with 3 XS sub-issues end-to-end:
> issue detection → triage → research → plan → implementation → PR merged → Done.

**Key moments:**
- `0:00` — Single command entry point: `/ralph-team NNN`
- `0:30` — TeamCreate: analyst/builder/integrator spawned with task list coordination
- `1:00` — Issues move on the GitHub Projects board as workflow states change
- `3:00` — Research document committed to git; issue advances to Ready for Plan
- `5:00` — Implementation plan committed; issue advances to Plan in Review
- `7:00` — PR opens, CI runs — standard GitHub flow, nothing proprietary
- `9:00` — PR merged, board shows Done; end-to-end traceability complete

```

**Implementation note for builder**: Replace `RECORDING_URL_FROM_GH_389` with the actual URL from the #389 deliverable. If the URL is not yet documented in issue comments, use a placeholder: `[Demo recording — coming soon]` and leave a TODO comment in the commit message.

### Success Criteria
- [ ] Manual: README section renders correctly on GitHub (view raw markdown via gh CLI or browser)
- [ ] Manual: ASCII diagram displays with correct alignment in a monospace font
- [ ] Manual: All 7 lifecycle stages are represented in the diagram
- [ ] Manual: Both contributor and user audiences addressed in the prose
- [ ] Manual: Recording link is present (placeholder acceptable if URL not yet published)

---

## Integration Testing

- [ ] `git diff plugin/ralph-hero/README.md` shows only the new section inserted (no accidental deletions)
- [ ] Markdown lint: no broken links, no unclosed fences
- [ ] Section appears between Usage/CLI section and Configuration heading in the rendered output

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/390
- Parent: https://github.com/cdubiel08/ralph-hero/issues/310
- Recording deliverable: https://github.com/cdubiel08/ralph-hero/issues/389
- Demo idea doc: [thoughts/ideas/2026-02-21-showcase-demo-onboarding.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/ideas/2026-02-21-showcase-demo-onboarding.md)
- Current README: [plugin/ralph-hero/README.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/README.md)
