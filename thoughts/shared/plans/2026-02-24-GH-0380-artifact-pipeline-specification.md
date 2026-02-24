---
date: 2026-02-24
status: draft
github_issues: [380]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/380
primary_issue: 380
---

# Add Artifact Pipeline Specification to Demo Recording Research Doc — Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-380 | Add artifact pipeline specification to demo recording research doc | XS |

## Current State Analysis

The target file `thoughts/shared/research/2026-02-22-demo-recording-tools.md` was created by #378 and extended by #379 (both now closed). It currently contains tool evaluations, automation matrix, recommendations, references, and skill architecture design — ending cleanly after the `### Skill File Inventory` subsection for sibling appending.

This issue appends an `## Artifact Pipeline Specification` section defining the file lifecycle, autonomous and interactive mode pipelines, `## Demo Recording` Artifact Comment Protocol extension with comment format templates, and storage/cleanup table. The content is pre-specified in `thoughts/shared/plans/2026-02-22-demo-recording-skills.md` Phase 3 (lines 332–420).

The `## Demo Recording` header is an additive 5th entry to the existing Artifact Comment Protocol (4 existing headers in `plugin/ralph-hero/skills/shared/conventions.md:249-256`). Formal registration in conventions.md is deferred to a follow-on issue.

## Desired End State

### Verification
- [ ] `## Artifact Pipeline Specification` section appended to `thoughts/shared/research/2026-02-22-demo-recording-tools.md`
- [ ] File lifecycle diagram present
- [ ] Autonomous and interactive mode pipelines documented
- [ ] `## Demo Recording` comment format templates for both modes
- [ ] Storage & cleanup table with gitignore entry

## What We're NOT Doing
- Modifying the Artifact Comment Protocol in `conventions.md` (deferred)
- Creating scripts (`ralph-record-wrap.sh`, `ralph-record-upload.sh`) — that's #381
- Adding `recordings/` to `.gitignore` (implementer note for #381)
- Implementing any upload functionality

## Implementation Approach

Append the `## Artifact Pipeline Specification` section to the existing research document, using the pre-specified content from the parent plan.

---

## Phase 1: Append Artifact Pipeline Specification Section
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/380 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-24-GH-0380-artifact-pipeline-specification.md

### Changes Required

#### 1. Append pipeline specification to research document
**File**: `thoughts/shared/research/2026-02-22-demo-recording-tools.md`
**Action**: Append after the `## Skill Architecture Design` section (after the Skill File Inventory note)

Append the `## Artifact Pipeline Specification` section containing:
- `### File Lifecycle` — ASCII flow diagram: `[Recording] -> [Local File] -> [Conversion] -> [Upload] -> [Comment Link]`
- `#### Autonomous Mode Pipeline` — 4-step pipeline: `asciinema rec` → `agg` → `gh api` → `create_comment`
- `#### Interactive Mode Pipeline` — 5-step pipeline: `obs-cli` → `ffmpeg trim` → `ffmpeg thumbnail` → `gh release upload` → `create_comment`
- `### Artifact Comment Protocol: ## Demo Recording` — new header table entry, comment format templates for autonomous (GIF embed + metadata) and interactive (MP4 link + metadata)
- `### Storage & Cleanup` — 5-row table with artifact types, locations, and lifecycle; gitignore entry for `recordings/`

**Source content**: `thoughts/shared/plans/2026-02-22-demo-recording-skills.md` lines 332–420 (inside the Phase 3 markdown code block)

**Important**: Append cleanly so #381 can continue appending.

### Success Criteria
- [ ] Automated: `grep -q "## Artifact Pipeline Specification" thoughts/shared/research/2026-02-22-demo-recording-tools.md`
- [ ] Automated: `grep -q "Autonomous Mode Pipeline" thoughts/shared/research/2026-02-22-demo-recording-tools.md`
- [ ] Automated: `grep -q "## Demo Recording" thoughts/shared/research/2026-02-22-demo-recording-tools.md`
- [ ] Manual: Pipeline flows are clear, comment templates are consistent with existing protocol

---

## Integration Testing
- [ ] Research doc still has valid YAML frontmatter after append
- [ ] Original tool evaluation and architecture sections unchanged
- [ ] File ends cleanly for #381 appending

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-24-GH-0380-artifact-pipeline-specification.md
- Parent plan: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-22-demo-recording-skills.md
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/364
- Predecessor: https://github.com/cdubiel08/ralph-hero/issues/379
