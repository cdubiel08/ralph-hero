---
date: 2026-05-26
status: ready
type: plan
tags: [docs, contributing, changelog, repo-root]
github_issue: 1456
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1456
primary_issue: 1456
estimate: S
---

# GH-1456 — Add CONTRIBUTING.md and CHANGELOG.md at repo root

## Prior Work

- Child of epic #1459 (Documentation hardening); siblings #1452/#1453/#1454/#1455 merged.
- Contribution + release conventions currently live only in root `CLAUDE.md` §§ Build & Test + CI/CD — no contributor-facing entry point.

## Overview

The repo root has no `CONTRIBUTING.md` or `CHANGELOG.md`. Add both: a contributor-facing `CONTRIBUTING.md` (dev setup, conventions, the auto-release tag mechanics, plugin layout) and a seeded `CHANGELOG.md` (Keep a Changelog). Pure additive — two new root files; no code change.

## Current State Analysis

Verified on `main` (2026-05-26):
- `CONTRIBUTING.md` and `CHANGELOG.md` both absent at repo root.
- Conventions exist in root `CLAUDE.md`: **Build & Test** (`mcp-server/`: `npm install`/`build`/`test`; ralph-knowledge from `plugin/ralph-knowledge/`), **CI/CD** — `ci.yml` (build+test Node 20/22 + hook tests + shellcheck + workflow lint), `release.yml` (merges touching `mcp-server/src/**` auto-bump + npm publish; `#minor`/`#major` in a commit message for larger bumps), `release-ralph.yml` (merges touching `ralph/**` bump the plugin version + tag). "Do NOT run `npm publish` / push `v*` tags manually."
- Two release streams visible in tags: ralph plugin (`ralph-v0.1.32` latest) + mcp-server (`v2.5.191`).

### Key Discoveries

- Both new files are pure additions; content is fully derivable from `CLAUDE.md` + the tag history. No research needed.
- The auto-release model means CHANGELOG is **not** auto-generated — CONTRIBUTING should state how the changelog relates to `release.yml`/`release-ralph.yml` (human-maintained "Unreleased" section; releases are tag-driven).
- Two new `git add` files — no `git mv` staging gotcha.

## Desired End State

1. `CONTRIBUTING.md` at root: dev setup (`mcp-server` build/test), branch/commit conventions, how the `#minor`/`#major` auto-release commit tags work (which workflow handles which package), pointer to the plugin layout, and how the changelog is maintained vs the auto-publish workflow.
2. `CHANGELOG.md` at root: Keep-a-Changelog format, seeded with the current released state (ralph plugin `v0.1.32`, mcp-server `v2.5.191`) + an `## [Unreleased]` section.
3. Any links are absolute GitHub URLs.
4. No code change.

### Verification

- Automated: `test -f CONTRIBUTING.md && test -f CHANGELOG.md`; `grep -qiE '#minor|#major' CONTRIBUTING.md` (release-tag mechanics covered); `grep -qE 'mcp-server' CONTRIBUTING.md` (dev setup); `grep -qiE 'Unreleased' CHANGELOG.md` + `grep -qE '2\.5\.191|0\.1\.32' CHANGELOG.md` (seeded current state); `grep -cE '\]\(\.\.?/' CONTRIBUTING.md CHANGELOG.md` → 0.
- Manual: read both; confirm CONTRIBUTING is a genuine contributor entry point and CHANGELOG reflects the two release streams.

## What We're NOT Doing

- NOT changing CI workflows or the release automation.
- NOT back-filling a full historical CHANGELOG — seed with current released state + Unreleased; future entries accrue normally.
- NOT touching sibling epic-#1459 tasks (#1457, #1458).

## Implementation Approach

Two phases, one per file (disjoint, both `depends_on: null`). Phase 1 writes `CONTRIBUTING.md`; Phase 2 writes `CHANGELOG.md`. Both doc-only.

## Phase 1: Write CONTRIBUTING.md
depends_on: null

### Overview
Create a contributor-facing `CONTRIBUTING.md` at repo root.

### Changes Required
#### 1. New CONTRIBUTING.md
**File**: `CONTRIBUTING.md` (create)
**Changes**: Sections — **Dev setup** (`mcp-server`: `npm install`/`npm run build`/`npm test`; ralph-knowledge build from `plugin/ralph-knowledge/`); **Project layout** (brief: `mcp-server/` published npm pkg, `ralph/` the Claude Code plugin, `plugin/{ralph-knowledge,ralph-playwright,ralph-demo}/`; link to README + CLAUDE.md); **Branch & commit conventions** (feature branches `feature/GH-NNN`, conventional-commit style); **Releases** (auto-release via `release.yml` for `mcp-server/src/**` changes → npm publish; `release-ralph.yml` for `ralph/**` → plugin tag; include `#minor`/`#major` in a commit message for larger bumps; do NOT `npm publish` or push `v*` tags manually); **Changelog** (note: releases are tag-driven and automated; `CHANGELOG.md`'s `## [Unreleased]` section is human-maintained — add entries there as you land changes). Absolute GitHub URLs.

### Success Criteria
#### Automated Verification
- [x] `test -f CONTRIBUTING.md` succeeds.
- [x] `grep -qiE '#minor|#major' CONTRIBUTING.md && grep -qE 'mcp-server' CONTRIBUTING.md && grep -qiE 'release' CONTRIBUTING.md` (release mechanics + dev setup covered).
- [x] `grep -cE '\]\(\.\.?/' CONTRIBUTING.md` returns 0 (no repo-relative links).
- [x] `bash ralph/hooks/scripts/__tests__/*.test.sh` pass.

#### Manual Verification
- [x] Reads as a genuine contributor entry point; release/changelog relationship is clear.

## Phase 2: Write CHANGELOG.md
depends_on: null

### Overview
Create a seeded `CHANGELOG.md` at repo root in Keep-a-Changelog format.

### Changes Required
#### 1. New CHANGELOG.md
**File**: `CHANGELOG.md` (create)
**Changes**: [Keep a Changelog](https://keepachangelog.com/) format. Include a header note that two artifacts version independently — the `ralph` Claude Code plugin (tags `ralph-vX.Y.Z`) and the `ralph-hero-mcp-server` npm package (tags `vX.Y.Z`) — both released automatically (`release-ralph.yml` / `release.yml`). Seed with `## [Unreleased]` (empty subsections) and a current-state entry referencing `ralph` plugin **v0.1.32** and mcp-server **v2.5.191** as the latest released versions. Absolute GitHub URLs (e.g. to the releases/tags page).

### Success Criteria
#### Automated Verification
- [x] `test -f CHANGELOG.md` succeeds.
- [x] `grep -qiE 'Unreleased' CHANGELOG.md && grep -qE '2\.5\.191|0\.1\.32' CHANGELOG.md` (Keep-a-Changelog skeleton + seeded current versions).
- [x] `grep -cE '\]\(\.\.?/' CHANGELOG.md` returns 0.
- [x] `bash ralph/hooks/scripts/__tests__/*.test.sh` pass.

#### Manual Verification
- [x] CHANGELOG reflects the two independent release streams and is ready to accrue future entries.

## Testing Strategy

### Unit Tests
None — new markdown files.

### Integration Tests
`bash ralph/hooks/scripts/__tests__/*.test.sh` (no regression).

### Manual Testing Steps
1. Run the grep assertions for both files.
2. Read CONTRIBUTING + CHANGELOG for accuracy against CLAUDE.md + the tag streams.

## Migration Notes

No migration. Two new root docs. CHANGELOG seeds current state; future entries are human-maintained under `## [Unreleased]` (the auto-release workflows handle version bumps + tags, not changelog prose).

## References

- Issue #1456 (parent epic #1459)
- Root `CLAUDE.md` §§ Build & Test + CI/CD; tags `ralph-v0.1.32` + `v2.5.191`
