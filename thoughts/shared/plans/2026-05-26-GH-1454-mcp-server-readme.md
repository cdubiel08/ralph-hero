---
date: 2026-05-26
status: ready
type: plan
tags: [docs, mcp-server, npm, readme]
github_issue: 1454
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1454
primary_issue: 1454
estimate: S
---

# GH-1454 — Add mcp-server/README.md for the published npm package

## Prior Work

- Child of epic #1459 (Documentation hardening); siblings #1452 (roster fix) + #1453 (archive docs) already merged.
- Tool architecture is currently documented only in root `CLAUDE.md` § "MCP Server Internals" — this plan surfaces a package-scoped subset on npm.

## Overview

`mcp-server/` is published to npm as `ralph-hero-mcp-server` (v2.5.191) but has no `README.md`, so the npm package page renders blank for anyone discovering it. This plan adds a concise, npm-rendering `mcp-server/README.md` sourced from `package.json` + root `CLAUDE.md` § "MCP Server Internals". Pure additive — one new file; no code change.

## Current State Analysis

Verified on `main` (2026-05-26):
- `mcp-server/README.md` does not exist (`ls` → not found).
- `package.json`: `name: ralph-hero-mcp-server`, `version: 2.5.191`, `description: "MCP server for GitHub Projects V2 - Ralph workflow automation"`, `bin: { ralph-hero-mcp-server: dist/index.js }`, `main: dist/index.js`, `scripts: build/test/start/prepublishOnly`.
- `files: ["dist/**/*.js"]` — note: **npm always includes `README.md`, `LICENSE`, and `package.json` in the tarball regardless of the `files` field**, so a new `README.md` ships automatically; no `files` change is required (the plan verifies this rather than editing).
- `repository: { type: git, url: https://github.com/cdubiel08/ralph-hero.git, directory: mcp-server }` — correct; npm links back to the repo subdirectory. No `homepage` set (optional to add).

### Key Discoveries

- Content sources are all present: `package.json` (install/bin/scripts) + root `CLAUDE.md` § "MCP Server Internals" (the `registerXyzTools()` registration pattern, tool modules table, GitHub client dual-endpoint design, `resolveEnv()`/env-var handling).
- npm does NOT resolve repo-relative markdown links — the README must use **absolute** `https://github.com/cdubiel08/ralph-hero/...` URLs.
- Single new file; pure `git add mcp-server/README.md` (no `git mv` staging gotcha).

## Desired End State

1. `mcp-server/README.md` exists, covering: what the package is, install (`npx`/`.mcp.json`), required env vars (`RALPH_GH_OWNER`, `RALPH_GH_PROJECT_NUMBER`, token / `gh auth` fallback), the `registerXyzTools()` registration pattern, build/test commands, and a link back to the repo.
2. All links are absolute GitHub URLs (render correctly on npm, off-GitHub).
3. `package.json` `files`/`repository` confirmed correct so the README ships and the npm page links back (no edit expected — README ships by default; repository.directory already set).
4. No code change.

### Verification

- Automated: `test -f mcp-server/README.md`; `grep -c 'github.com/cdubiel08/ralph-hero' mcp-server/README.md` ≥ 1 (absolute repo link present); `! grep -nE '\]\(\.\.?/' mcp-server/README.md` (no repo-relative links); `grep -qE 'RALPH_GH_OWNER' mcp-server/README.md && grep -qE 'registerXyzTools|register.*Tools' mcp-server/README.md` (env vars + registration pattern covered).
- Manual: read the README and confirm it reads correctly as a standalone npm package page (no assumed repo-root context).

## What We're NOT Doing

- NOT changing MCP-server code, the `files` field (README ships by default), or `package.json` beyond an optional `homepage` add.
- NOT duplicating the full root `CLAUDE.md` § "MCP Server Internals" — a package-scoped subset with a link back for depth.
- NOT touching sibling epic-#1459 tasks (#1455-#1458).

## Implementation Approach

Single phase: write `mcp-server/README.md` with absolute URLs, then verify `package.json` ships it. ~60-100 lines of markdown.

## Phase 1: Write mcp-server/README.md
depends_on: null

### Overview
Create a concise, npm-rendering README for the `ralph-hero-mcp-server` package.

### Changes Required
#### 1. New README
**File**: `mcp-server/README.md` (create)
**Changes**: Write the README with these sections — Title + one-line description (from `package.json`); **What it is** (MCP server exposing GitHub Projects V2 tools to Claude Code via MCP; bundled by the `ralph` Claude Code plugin); **Install** (`npx ralph-hero-mcp-server`, and the `.mcp.json` consumption pattern — note tokens flow via env/`gh auth`, NOT `.mcp.json`); **Configuration / env vars** (`RALPH_GH_OWNER` required, `RALPH_GH_PROJECT_NUMBER` required, `RALPH_GH_REPO` optional, token via `RALPH_HERO_GITHUB_TOKEN` or `gh auth token` fallback); **Tool architecture** (brief: all tools use the `ralph_hero__` prefix, registered via `registerXyzTools()` modules; link to root CLAUDE.md § "MCP Server Internals" for the full module table); **Build & test** (`npm install && npm run build && npm test`); **Repo link** (absolute URL to https://github.com/cdubiel08/ralph-hero). Use ONLY absolute `https://github.com/cdubiel08/ralph-hero/...` links.

#### 2. Verify package.json ships it (no edit expected)
**File**: `mcp-server/package.json` (read/verify)
**Changes**: Confirm `repository.directory: mcp-server` (already set) and that README ships by default (npm always includes README regardless of `files: ["dist/**/*.js"]`). Optionally add `"homepage": "https://github.com/cdubiel08/ralph-hero/tree/main/mcp-server"`. No mandatory edit.

### Success Criteria
#### Automated Verification
- [ ] `test -f mcp-server/README.md` succeeds.
- [ ] `grep -c 'github.com/cdubiel08/ralph-hero' mcp-server/README.md` ≥ 1; `grep -cE '\]\(\.\.?/' mcp-server/README.md` returns 0 (no repo-relative links).
- [ ] `grep -qE 'RALPH_GH_OWNER' mcp-server/README.md && grep -qiE 'registerXyzTools|register[A-Za-z]+Tools|ralph_hero__' mcp-server/README.md` (env vars + tool pattern covered).
- [ ] `bash ralph/hooks/scripts/__tests__/*.test.sh` pass (no regression).

#### Manual Verification
- [ ] README reads correctly as a standalone npm package page (no assumed repo-root context; all links absolute).

## Testing Strategy

### Unit Tests
None — new markdown file.

### Integration Tests
`bash ralph/hooks/scripts/__tests__/*.test.sh` (no regression).

### Manual Testing Steps
1. Run the grep assertions.
2. Read `mcp-server/README.md` as if landing on the npm page.

## Migration Notes

No migration. README ships in the next npm publish (auto-release on `mcp-server/src/**` changes — note: a README-only change may not trigger a version bump/publish since release.yml keys on `mcp-server/src/**`; the README will ship with the next src-triggered release, which is acceptable).

## References

- Issue #1454 (parent epic #1459)
- `mcp-server/package.json`; root `CLAUDE.md` § "MCP Server Internals"
