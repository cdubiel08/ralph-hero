---
date: 2026-05-26
status: ready
type: plan
tags: [docs, ralph-demo, remotion, readme]
github_issue: 1455
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1455
primary_issue: 1455
estimate: XS
---

# GH-1455 — Add plugin/ralph-demo/README.md

## Prior Work

- Child of epic #1459 (Documentation hardening); siblings #1452/#1453/#1454 merged.
- Sibling sub-plugins `plugin/ralph-knowledge/README.md` and `plugin/ralph-playwright/README.md` already exist — this fills the gap for `ralph-demo` for consistency.

## Overview

`plugin/ralph-demo/` has no `README.md`, unlike its sibling sub-plugins. Add a concise one describing the sprint-demo video generation, its two skills, and the Remotion/pnpm setup. Pure additive — one new file; no code change.

## Current State Analysis

Verified on `main` (2026-05-26):
- `plugin/ralph-demo/README.md` does not exist.
- Structure: `plugin/ralph-demo/skills/` (two skills: `demo-video`, `record-demo`) + `plugin/ralph-demo/remotion/` (the video generator).
- `plugin/ralph-demo/remotion/package.json`: `name: demo-studio`, description "Sprint demo video generator using Remotion", scripts `dev`/`build`/`test`/`test:watch`, managed with **pnpm** (`pnpm-lock.yaml`), `remotion.config.ts` + `src/`.
- Sibling `plugin/ralph-knowledge/README.md` structure to mirror: title → one-line description → Quick start → Configuration. The issue asks for overview → architecture → usage.

### Key Discoveries

- Content sources all present: `remotion/package.json` (name/desc/scripts/pnpm) + `skills/{demo-video,record-demo}/` (the skill definitions). The implementer should read the two `SKILL.md` files for accurate skill descriptions.
- Single new file; pure `git add plugin/ralph-demo/README.md`.

## Desired End State

1. `plugin/ralph-demo/README.md` exists, describing: the sprint-demo video generation (Remotion-based `demo-studio`), the two skills (`record-demo`, `demo-video`), and the Remotion/pnpm setup under `remotion/`.
2. Structure mirrors the sibling sub-plugin READMEs (overview → architecture → usage).
3. Any cross-links use absolute repo URLs.
4. No code change.

### Verification

- Automated: `test -f plugin/ralph-demo/README.md`; `grep -qE 'record-demo' plugin/ralph-demo/README.md && grep -qE 'demo-video' plugin/ralph-demo/README.md && grep -qiE 'remotion' plugin/ralph-demo/README.md` (both skills + Remotion mentioned); `grep -cE '\]\(\.\.?/' plugin/ralph-demo/README.md` → 0 (no repo-relative links if any links present).
- Manual: read the README and confirm it parallels the sibling sub-plugin READMEs and accurately describes the skills + Remotion pipeline.

## What We're NOT Doing

- NOT changing the `remotion/` code, skills, or any package.json.
- NOT documenting Remotion internals beyond a usage-level overview (link to Remotion docs if helpful).
- NOT touching sibling epic-#1459 tasks (#1456-#1458).

## Implementation Approach

Single phase: read the two `skills/*/SKILL.md` + `remotion/package.json`, then write `plugin/ralph-demo/README.md` mirroring the sibling sub-plugin README structure. ~40-60 lines.

## Phase 1: Write plugin/ralph-demo/README.md
depends_on: null

### Overview
Create a concise README for the `ralph-demo` sub-plugin.

### Changes Required
#### 1. New README
**File**: `plugin/ralph-demo/README.md` (create)
**Changes**: Read `plugin/ralph-demo/skills/record-demo/SKILL.md` + `plugin/ralph-demo/skills/demo-video/SKILL.md` (for accurate skill descriptions) and `plugin/ralph-demo/remotion/package.json`. Write the README with: **Title + one-line description** (sprint-demo video generation for ralph); **Overview** (what it produces — sprint demo videos via Remotion); **Skills** (`record-demo` and `demo-video` — one line each from their SKILL.md); **Architecture / `remotion/`** (the `demo-studio` Remotion project: pnpm-managed, `pnpm dev`/`build`/`test`, `remotion.config.ts` + `src/`); **Usage** (how to invoke the skills + render). Mirror the structure of `plugin/ralph-knowledge/README.md` / `plugin/ralph-playwright/README.md`. Use absolute repo URLs for any cross-links.

### Success Criteria
#### Automated Verification
- [ ] `test -f plugin/ralph-demo/README.md` succeeds.
- [ ] `grep -qE 'record-demo' plugin/ralph-demo/README.md && grep -qE 'demo-video' plugin/ralph-demo/README.md && grep -qiE 'remotion' plugin/ralph-demo/README.md` (both skills + Remotion covered).
- [ ] `grep -cE '\]\(\.\.?/' plugin/ralph-demo/README.md` returns 0 (no repo-relative links).
- [ ] `bash ralph/hooks/scripts/__tests__/*.test.sh` pass (no regression).

#### Manual Verification
- [ ] README parallels the sibling sub-plugin READMEs and accurately describes the two skills + the Remotion pipeline.

## Testing Strategy

### Unit Tests
None — new markdown file.

### Integration Tests
`bash ralph/hooks/scripts/__tests__/*.test.sh` (no regression).

### Manual Testing Steps
1. Run the grep assertions.
2. Read the README against the sibling sub-plugin READMEs.

## Migration Notes

No migration. New doc file; ships with the repo (not an npm package). `ralph-demo` is not published to npm, so no package-page concern.

## References

- Issue #1455 (parent epic #1459)
- `plugin/ralph-demo/remotion/package.json`; `plugin/ralph-demo/skills/{record-demo,demo-video}/`; sibling `plugin/ralph-knowledge/README.md`
