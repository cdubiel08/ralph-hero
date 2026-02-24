---
date: 2026-02-24
github_issue: 380
github_url: https://github.com/cdubiel08/ralph-hero/issues/380
status: complete
type: research
---

# GH-380: Add Artifact Pipeline Specification to Demo Recording Research Doc

## Problem Statement

GH-380 tasks us with appending an `## Artifact Pipeline Specification` section to `thoughts/shared/research/2026-02-22-demo-recording-tools.md`. This section defines the file lifecycle (recording → conversion → upload → comment link), upload paths for both recording modes, and extends the Artifact Comment Protocol with a new `## Demo Recording` header. This is Phase 3 of a 4-phase decomposition of parent issue #364.

## Current State Analysis

### Target File Status

`thoughts/shared/research/2026-02-22-demo-recording-tools.md` does not exist yet — created by #378 (Ready for Plan). This issue's implementation depends on #378 and #379 being merged first.

### Artifact Comment Protocol — Current State

`plugin/ralph-hero/skills/shared/conventions.md:249-256` defines 4 existing section headers:

| Phase | Header | Content |
|-------|--------|---------|
| Research | `## Research Document` | GitHub URL to research `.md` |
| Plan | `## Implementation Plan` | GitHub URL to plan `.md` |
| Review | `## Plan Review` | VERDICT + optional critique URL |
| Implementation | `## Implementation Complete` | PR URL, branch, files changed |

The `## Demo Recording` header would be the **5th entry** in this table — an additive extension, not a modification of existing headers. The protocol section spans lines 245-371 and includes Discovery Protocol, Deterministic File Naming, Fallback Discovery, and Artifact Passthrough sub-sections.

**Key compatibility concern**: The research doc will document the `## Demo Recording` header as part of the pipeline spec, but the conventions.md file itself would need a separate update to formally register this header (out of scope for this issue — deferred to implementation of #381 or a follow-on issue).

### Existing Script Infrastructure

`plugin/ralph-hero/scripts/` contains 5 files: `ralph-cli.sh`, `ralph-loop.sh`, `ralph-team-loop.sh`, and shell completion scripts. **No existing scripts** use `gh release`, `gh api`, `asciinema`, `agg`, or `obs-cli`. The pipeline scripts (`ralph-record-wrap.sh`, `ralph-record-upload.sh`) proposed in Phase 4 will be the first of their kind.

### Upload Path Viability

The plan recommends two upload paths:

**Autonomous mode**: `gh api` to upload GIF as issue comment attachment. GitHub's REST API supports uploading assets directly via `POST /repos/{owner}/{repo}/releases/assets` or via the undocumented issue comment attachment endpoint. The plan uses `gh release upload` to a `demos` release tag as the practical workaround for CLI-based upload.

**Interactive mode**: `gh release upload v0.0.0-demos trimmed.mp4` — well-supported by the `gh` CLI, creates a versioned asset with a stable URL.

### Phase 3 Content Assessment

Full pipeline specification content is pre-specified in `thoughts/shared/plans/2026-02-22-demo-recording-skills.md:320-445`:
- File lifecycle diagram
- Autonomous pipeline: `asciinema rec` → `agg` → `gh api`/release → `create_comment`
- Interactive pipeline: `obs-cli` → `ffmpeg` trim → `ffmpeg` thumbnail → `gh release upload` → `create_comment`
- Comment format templates for both modes
- Storage & cleanup table with gitignore entry (`recordings/`)

## Key Discoveries

### File:Line References

- `plugin/ralph-hero/skills/shared/conventions.md:249-256` — Existing Artifact Comment Protocol headers table
- `plugin/ralph-hero/skills/shared/conventions.md:245-371` — Full Artifact Comment Protocol section
- `thoughts/shared/plans/2026-02-22-demo-recording-skills.md:320-445` — Phase 3 full content spec
- `plugin/ralph-hero/scripts/ralph-loop.sh` — Closest pattern to future `ralph-record-wrap.sh`

### Upload Path Assessment

| Method | CLI Support | Stable URL | GitHub-hosted | Recommended |
|--------|------------|-----------|--------------|-------------|
| `gh release upload` (demos tag) | ✓ Full | ✓ Yes | ✓ Yes | **Yes** (both modes) |
| Issue comment attachment API | Partial (gh api) | ✓ Yes | ✓ Yes | Autonomous fallback |
| Git LFS | Via git | ✓ Yes | ✓ Yes | No (repo weight) |
| External (S3, asciinema.org) | Varies | ✓ Yes | ✗ No | No (external dep) |

**Recommendation**: Use `gh release upload` to a `demos` release tag for both modes. Creates stable, permanent URLs at `github.com/{owner}/{repo}/releases/download/demos/{filename}`. The `gh` CLI handles authentication transparently using `RALPH_HERO_GITHUB_TOKEN`.

### gitignore Impact

The `recordings/` directory needs to be added to `.gitignore` in the plugin root. Currently absent — no `recordings/` entry exists in `plugin/ralph-hero/.gitignore` (or repo root `.gitignore`). This is a minor implementation detail for the implementer of #378 or #381.

## Potential Approaches

### Option A: Append verbatim from plan (Recommended)
Append Phase 3 content from `thoughts/shared/plans/2026-02-22-demo-recording-skills.md:320-445` verbatim.

**Pros**: Pre-validated, fast, consistent with sibling issues
**Cons**: None

### Option B: Revise upload strategy based on research
Switch from `gh release upload` to native issue comment attachment API.

**Pros**: Uploads are tied to specific issues (better discoverability)
**Cons**: The `gh api` workaround is complex and fragile; `gh release upload` is simpler and already in the plan

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `## Demo Recording` header conflicts with future protocol additions | Low | Header is additive; discovery protocol uses exact string match |
| `gh release upload` requires release to exist | Low | Script creates `demos` release if absent (`gh release create`) |
| `recordings/` dir committed accidentally | Low | gitignore entry required (note for implementer) |
| #378 and #379 not merged before #380 implemented | Medium | Dependency chain enforces ordering |

## Recommended Next Steps

1. Wait for #378 and #379 to be implemented
2. Append `## Artifact Pipeline Specification` section per plan lines 320-445
3. Note to implementer: also add `recordings/` to `plugin/ralph-hero/.gitignore`
4. Commit and unblock #381

## Files Affected

### Will Modify
- `thoughts/shared/research/2026-02-22-demo-recording-tools.md` — Append `## Artifact Pipeline Specification` section (file lifecycle, autonomous pipeline, interactive pipeline, comment format templates, storage & cleanup table)

### Will Read (Dependencies)
- `thoughts/shared/plans/2026-02-22-demo-recording-skills.md` — Source content for Phase 3 (lines 320-445)
- `plugin/ralph-hero/skills/shared/conventions.md` — Artifact Comment Protocol reference (lines 245-371)
- `plugin/ralph-hero/scripts/ralph-loop.sh` — Existing script pattern reference
