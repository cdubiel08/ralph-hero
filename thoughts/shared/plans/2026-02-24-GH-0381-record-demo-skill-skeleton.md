---
date: 2026-02-24
status: draft
github_issues: [381]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/381
primary_issue: 381
---

# Create record-demo Skill Skeleton and Document Autonomous Hook Integration — Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-381 | Create record-demo skill skeleton and document autonomous hook integration | XS |

## Current State Analysis

This is the final issue (#381) in the 4-phase group (#378 → #379 → #380 → #381) under parent #364. All predecessors are closed. The target research file `thoughts/shared/research/2026-02-22-demo-recording-tools.md` now contains tool evaluations, automation matrix, recommendations, skill architecture design, and artifact pipeline specification.

This issue creates the `record-demo` interactive skill skeleton and appends the autonomous recording hook integration design to the research doc. The `draft-idea` skill (`plugin/ralph-hero/skills/draft-idea/SKILL.md`) is the direct pattern: inline context, sonnet model, explicit `allowed_tools`, `AskUserQuestion` for user interaction. The skill skeleton and hook design content are pre-specified in `thoughts/shared/plans/2026-02-22-demo-recording-skills.md` Phase 4 (lines 444–630).

Additionally, `plugin/ralph-hero/.gitignore` needs a `recordings/` entry to prevent ephemeral `.cast` and `.gif` files from being committed.

## Desired End State

### Verification
- [ ] `plugin/ralph-hero/skills/record-demo/SKILL.md` exists with valid frontmatter
- [ ] `## Autonomous Recording: Hook Integration Design` section appended to research doc
- [ ] `recordings/` entry in `plugin/ralph-hero/.gitignore`
- [ ] Skill frontmatter matches inline/sonnet pattern (like `draft-idea`)

## What We're NOT Doing
- Implementing the actual recording functionality (this is a skeleton)
- Creating `ralph-record-wrap.sh` or `ralph-record-upload.sh` scripts (documented only)
- Modifying `hooks.json` (autonomous recording is a wrapper script, not a hook)
- Modifying `conventions.md` to register the `## Demo Recording` header

## Implementation Approach

Three changes in a single phase: create skill skeleton directory and file, append hook design to research doc, and add gitignore entry.

---

## Phase 1: Create Skill Skeleton and Document Hook Integration
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/381 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-24-GH-0381-record-demo-skill-skeleton.md

### Changes Required

#### 1. Create record-demo skill skeleton
**File**: `plugin/ralph-hero/skills/record-demo/SKILL.md`
**Action**: Create new directory and file

Create the skill definition following the `draft-idea` inline pattern with:
- Frontmatter: `description`, `context: inline`, `model: sonnet`, `allowed_tools` list (Bash, Read, Write, Glob, Grep, AskUserQuestion, ralph_hero__get_issue, ralph_hero__create_comment)
- `# Record Demo` title
- `## Prerequisites` section (OBS, obs-cli, WebSocket, scene config)
- `## Workflow` with 7 steps: Setup Verification, Issue Context, Pre-Recording, Recording, Stop & Process, Upload & Link, Summary
- Each step uses appropriate tools (Bash for obs-cli, AskUserQuestion for pacing)

**Source content**: `thoughts/shared/plans/2026-02-22-demo-recording-skills.md` lines 444–534

#### 2. Append autonomous hook integration design to research document
**File**: `thoughts/shared/research/2026-02-22-demo-recording-tools.md`
**Action**: Append after the `## Artifact Pipeline Specification` section

Append `## Autonomous Recording: Hook Integration Design` section containing:
- `### Concept` — recording wraps skill execution via asciinema, activated by env var
- `### Environment Variable` — `RALPH_RECORD`, `RALPH_RECORD_IDLE`, `RALPH_RECORD_THEME`
- `### Integration Point: Shell Script Wrapper` — `ralph-record-wrap.sh` script body with asciinema rec + agg conversion
- `### Future: Hook-Based Auto-Recording` — deferred note about PreToolUse/PostToolUse approach
- `### Upload Script` — `ralph-record-upload.sh` script body with gh release upload

**Source content**: `thoughts/shared/plans/2026-02-22-demo-recording-skills.md` lines 540–630

#### 3. Add recordings/ to gitignore
**File**: `plugin/ralph-hero/.gitignore`
**Action**: Append `recordings/` entry

Add `recordings/` line to prevent ephemeral `.cast` and `.gif` files from being committed.

### Success Criteria
- [ ] Automated: `test -f plugin/ralph-hero/skills/record-demo/SKILL.md && head -3 plugin/ralph-hero/skills/record-demo/SKILL.md | grep -q "^---"`
- [ ] Automated: `grep -q "## Autonomous Recording: Hook Integration Design" thoughts/shared/research/2026-02-22-demo-recording-tools.md`
- [ ] Automated: `grep -q "recordings/" plugin/ralph-hero/.gitignore`
- [ ] Manual: Skill frontmatter matches inline/sonnet pattern, workflow steps are clear

---

## Integration Testing
- [ ] Research doc still has valid YAML frontmatter after append
- [ ] Skill SKILL.md frontmatter parses correctly (valid `---` delimiters)
- [ ] All previous sections of research doc unchanged
- [ ] gitignore entry does not conflict with existing entries

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-24-GH-0381-record-demo-skill-skeleton.md
- Parent plan: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-22-demo-recording-skills.md
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/364
- Predecessor: https://github.com/cdubiel08/ralph-hero/issues/380
- Pattern reference: `plugin/ralph-hero/skills/draft-idea/SKILL.md`
